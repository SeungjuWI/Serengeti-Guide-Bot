import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listAllPages, readPageContent } from "./notion.js";
import { embedTexts } from "./llm.js";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const INDEX_FILE = path.join(DATA_DIR, "index.json");

const MAX_RESULTS = 4; // 답변 컨텍스트에 넣을 최대 문서 수
const MIN_SCORE = 0.2; // 이보다 관련도가 낮은 문서는 버림
const EMBED_BATCH = 30; // 임베딩 API 한 번에 보낼 문서 수
const READ_CONCURRENCY = 3; // 노션 본문 읽기 동시 실행 수 (API 요청 제한 고려)

/** OpenAI 임베딩은 길이가 1로 정규화되어 있어 내적이 곧 코사인 유사도 */
function similarity(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

let cache = null; // { mtimeMs, docs } — 파일이 갱신되면 자동으로 다시 로드

async function loadIndex() {
  const s = await stat(INDEX_FILE);
  if (cache && cache.mtimeMs === s.mtimeMs) return cache;
  const parsed = JSON.parse(await readFile(INDEX_FILE, "utf8"));
  cache = { mtimeMs: s.mtimeMs, docs: parsed.docs ?? [] };
  return cache;
}

/**
 * 전체 노션 페이지를 읽어 임베딩 인덱스를 만듦.
 * 이미 인덱스가 있으면 last_edited_time이 바뀐 페이지만 다시 읽는 증분 방식.
 * @returns {Promise<{total: number, updated: number, reused: number, removed: number}>}
 */
export async function buildIndex({ log = () => {} } = {}) {
  const prev = await loadIndex().catch(() => null);
  const prevById = new Map((prev?.docs ?? []).map((d) => [d.id, d]));

  log("노션에서 전체 페이지 목록을 가져오는 중...");
  const pages = await listAllPages();
  log(`페이지 ${pages.length}개 발견`);

  const docs = [];
  const toRead = [];
  for (const page of pages) {
    const cached = prevById.get(page.id);
    if (cached && cached.lastEdited === page.lastEdited && cached.embedding) {
      docs.push(cached);
    } else {
      toRead.push(page);
    }
  }
  const currentIds = new Set(pages.map((p) => p.id));
  const removed = [...prevById.keys()].filter((id) => !currentIds.has(id)).length;
  log(`신규/변경 ${toRead.length}개 읽기 시작 (기존 재사용 ${docs.length}개, 삭제됨 ${removed}개)`);

  // 본문 읽기 — 동시 3개씩
  const readDocs = [];
  const queue = [...toRead];
  let done = 0;
  await Promise.all(
    Array.from({ length: READ_CONCURRENCY }, async () => {
      while (queue.length > 0) {
        const page = queue.shift();
        let content = "";
        try {
          content = await readPageContent(page.id, { followChildPages: false });
        } catch (err) {
          log(`본문 읽기 실패, 제목만 인덱싱: ${page.title} — ${err.message}`);
        }
        readDocs.push({
          id: page.id,
          title: page.title,
          url: page.url,
          lastEdited: page.lastEdited,
          content: [page.propsText, content].filter(Boolean).join("\n"),
        });
        done += 1;
        if (done % 100 === 0) log(`본문 읽기 ${done}/${toRead.length}`);
      }
    })
  );

  // 임베딩 — 배치로 나눠 호출
  for (let i = 0; i < readDocs.length; i += EMBED_BATCH) {
    const batch = readDocs.slice(i, i + EMBED_BATCH);
    const vectors = await embedTexts(batch.map((d) => `${d.title}\n${d.content}`));
    batch.forEach((d, j) => {
      d.embedding = vectors[j].map((x) => Math.round(x * 1e6) / 1e6); // 파일 크기 절약
    });
    log(`임베딩 ${Math.min(i + EMBED_BATCH, readDocs.length)}/${readDocs.length}`);
  }

  docs.push(...readDocs);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(INDEX_FILE, JSON.stringify({ builtAt: new Date().toISOString(), docs }));
  cache = null;

  return { total: docs.length, updated: readDocs.length, reused: docs.length - readDocs.length, removed };
}

/**
 * 질문과 의미가 가까운 문서를 인덱스에서 찾음.
 * 매칭된 문서의 본문은 노션에서 최신으로 다시 읽고, 실패하면 인덱스에 저장된 본문을 사용.
 * 인덱스가 아직 없으면 null 반환 (호출부에서 키워드 검색으로 폴백).
 * @returns {Promise<Array<{title: string, url: string, content: string}> | null>}
 */
export async function searchIndex(query) {
  let index;
  try {
    index = await loadIndex();
  } catch {
    return null;
  }
  if (index.docs.length === 0) return null;

  const [queryVec] = await embedTexts([query]);
  const top = index.docs
    .map((doc) => ({ doc, score: similarity(queryVec, doc.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS)
    .filter((s) => s.score >= MIN_SCORE);

  const results = [];
  for (const { doc } of top) {
    let content = doc.content;
    try {
      const live = await readPageContent(doc.id);
      if (live) content = live;
    } catch {
      // 노션 읽기 실패 시 인덱스에 저장된 본문으로 답변
    }
    results.push({ title: doc.title, url: doc.url, content });
  }
  return results;
}

/**
 * 인덱스가 없으면 백그라운드로 만들고, 이후 주기적으로 갱신.
 * 주기는 INDEX_REFRESH_HOURS 환경변수 (기본 24시간, 0이면 자동 갱신 끔).
 */
export function startIndexScheduler({ log = console.log } = {}) {
  const hours = Number(process.env.INDEX_REFRESH_HOURS ?? 24);

  const run = async (label) => {
    try {
      const stats = await buildIndex({ log: (m) => log(`[인덱스] ${m}`) });
      log(`[인덱스] ${label} 완료 — 전체 ${stats.total} / 갱신 ${stats.updated} / 재사용 ${stats.reused}`);
    } catch (err) {
      log(`[인덱스] ${label} 실패: ${err.message}`);
    }
  };

  (async () => {
    const exists = await stat(INDEX_FILE).then(() => true).catch(() => false);
    if (!exists) {
      log("[인덱스] 검색 인덱스가 없어 처음으로 만들어요 (10~20분 소요, 완성 전까지는 키워드 검색으로 답변)");
      await run("최초 구축");
    }
    if (hours > 0) {
      setInterval(() => run("정기 갱신"), hours * 3600 * 1000);
    }
  })();
}
