import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listAllPages, readPageContent } from "./notion.js";
import { embedTexts } from "./llm.js";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const INDEX_FILE = path.join(DATA_DIR, "index.json");

const INDEX_VERSION = 2; // 인덱스 형식이 바뀌면 올림 → 이전 인덱스는 버리고 전체 재구축
const MAX_RESULTS = 4; // 답변 컨텍스트에 넣을 최대 페이지 수
const MAX_CHUNKS_PER_PAGE = 2; // 페이지당 답변에 넣을 최대 청크 수
const MIN_SCORE = 0.2; // 이보다 관련도가 낮은 청크는 버림
const EMBED_BATCH = 30; // 임베딩 API 한 번에 보낼 청크 수
const READ_CONCURRENCY = 3; // 노션 본문 읽기 동시 실행 수 (API 요청 제한 고려)
const MAX_INDEX_CHARS = 20000; // 인덱싱 시 페이지당 읽을 최대 글자 수
const CHUNK_CHARS = 1400; // 청크 하나의 목표 길이
const MIN_CHUNK_CHARS = 300; // 이보다 짧을 땐 제목이 나와도 청크를 끊지 않음

/** OpenAI 임베딩은 길이가 1로 정규화되어 있어 내적이 곧 코사인 유사도 */
function similarity(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/**
 * 긴 본문을 섹션(제목) 경계 기준으로 청크로 나눔.
 * 페이지 전체를 벡터 하나로 만들면 뒷부분 내용이 검색에서 묻히기 때문.
 */
function splitIntoChunks(content) {
  const chunks = [];
  let current = "";
  for (const line of content.split("\n")) {
    const isSectionStart = /^#{1,3} |^\[하위문서: |^\[하위 데이터베이스: /.test(line);
    const shouldCut =
      current.length > 0 &&
      (current.length + line.length > CHUNK_CHARS || (isSectionStart && current.length >= MIN_CHUNK_CHARS));
    if (shouldCut) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks.length > 0 ? chunks : [""];
}

let cache = null; // { mtimeMs, version, docs } — 파일이 갱신되면 자동으로 다시 로드

async function loadIndex() {
  const s = await stat(INDEX_FILE);
  if (cache && cache.mtimeMs === s.mtimeMs) return cache;
  const parsed = JSON.parse(await readFile(INDEX_FILE, "utf8"));
  cache = { mtimeMs: s.mtimeMs, version: parsed.version ?? 1, docs: parsed.docs ?? [] };
  return cache;
}

/**
 * 전체 노션 페이지를 읽어 임베딩 인덱스를 만듦.
 * 이미 인덱스가 있으면 last_edited_time이 바뀐 페이지만 다시 읽는 증분 방식.
 * 인덱스 항목은 페이지가 아니라 청크 단위 (긴 페이지는 여러 항목으로 나뉨).
 * @returns {Promise<{pages: number, chunks: number, updated: number, reused: number, removed: number}>}
 */
export async function buildIndex({ log = () => {} } = {}) {
  const prev = await loadIndex().catch(() => null);
  const usablePrev = prev && prev.version === INDEX_VERSION ? prev.docs : [];
  if (prev && prev.version !== INDEX_VERSION) log("인덱스 형식이 바뀌어 전체를 다시 만들어요");

  const prevByPage = new Map();
  for (const doc of usablePrev) {
    if (!prevByPage.has(doc.id)) prevByPage.set(doc.id, []);
    prevByPage.get(doc.id).push(doc);
  }

  log("노션에서 전체 페이지 목록을 가져오는 중...");
  const pages = await listAllPages();
  log(`페이지 ${pages.length}개 발견`);

  const docs = [];
  const toRead = [];
  let reusedPages = 0;
  for (const page of pages) {
    const cachedChunks = prevByPage.get(page.id);
    if (cachedChunks && cachedChunks[0].lastEdited === page.lastEdited) {
      docs.push(...cachedChunks);
      reusedPages += 1;
    } else {
      toRead.push(page);
    }
  }
  const currentIds = new Set(pages.map((p) => p.id));
  const removed = [...prevByPage.keys()].filter((id) => !currentIds.has(id)).length;
  log(`신규/변경 ${toRead.length}개 읽기 시작 (기존 재사용 ${reusedPages}개, 삭제됨 ${removed}개)`);

  // 본문 읽기 — 동시 3개씩, 청크로 분할
  const newDocs = [];
  const queue = [...toRead];
  let done = 0;
  await Promise.all(
    Array.from({ length: READ_CONCURRENCY }, async () => {
      while (queue.length > 0) {
        const page = queue.shift();
        let content = "";
        try {
          content = await readPageContent(page.id, { followChildPages: false, maxChars: MAX_INDEX_CHARS });
        } catch (err) {
          log(`본문 읽기 실패, 제목만 인덱싱: ${page.title} — ${err.message}`);
        }
        const full = [page.propsText, content].filter(Boolean).join("\n");
        splitIntoChunks(full).forEach((chunkText, i) => {
          newDocs.push({
            id: page.id,
            chunk: i,
            title: page.title,
            url: page.url,
            lastEdited: page.lastEdited,
            content: chunkText,
          });
        });
        done += 1;
        if (done % 100 === 0) log(`본문 읽기 ${done}/${toRead.length}`);
      }
    })
  );

  // 임베딩 — 배치로 나눠 호출
  for (let i = 0; i < newDocs.length; i += EMBED_BATCH) {
    const batch = newDocs.slice(i, i + EMBED_BATCH);
    const vectors = await embedTexts(batch.map((d) => `${d.title}\n${d.content}`));
    batch.forEach((d, j) => {
      d.embedding = vectors[j].map((x) => Math.round(x * 1e6) / 1e6); // 파일 크기 절약
    });
    log(`임베딩 ${Math.min(i + EMBED_BATCH, newDocs.length)}/${newDocs.length} 청크`);
  }

  docs.push(...newDocs);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(INDEX_FILE, JSON.stringify({ version: INDEX_VERSION, builtAt: new Date().toISOString(), docs }));
  cache = null;

  return { pages: pages.length, chunks: docs.length, updated: toRead.length, reused: reusedPages, removed };
}

/**
 * 질문과 의미가 가까운 청크를 찾아 페이지 단위로 묶어 반환.
 * 본문은 인덱스에 저장된 것을 사용 — 노션 변경사항은 다음 인덱스 갱신 때 반영됨.
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
  const scored = index.docs
    .map((doc) => ({ doc, score: similarity(queryVec, doc.embedding) }))
    .sort((a, b) => b.score - a.score);

  // 상위 청크부터 페이지 단위로 묶음: 최대 4개 페이지, 페이지당 최대 2개 청크
  const byPage = new Map();
  for (const { doc, score } of scored) {
    if (score < MIN_SCORE) break;
    let entry = byPage.get(doc.id);
    if (!entry) {
      if (byPage.size >= MAX_RESULTS) continue;
      entry = { title: doc.title, url: doc.url, chunks: [] };
      byPage.set(doc.id, entry);
    }
    if (entry.chunks.length < MAX_CHUNKS_PER_PAGE) entry.chunks.push(doc);
  }

  return [...byPage.values()].map((entry) => ({
    title: entry.title,
    url: entry.url,
    content: entry.chunks
      .sort((a, b) => (a.chunk ?? 0) - (b.chunk ?? 0))
      .map((c) => c.content)
      .join("\n(…중략…)\n"),
  }));
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
      log(
        `[인덱스] ${label} 완료 — 페이지 ${stats.pages} (청크 ${stats.chunks}) / 갱신 ${stats.updated} / 재사용 ${stats.reused}`
      );
    } catch (err) {
      log(`[인덱스] ${label} 실패: ${err.message}`);
    }
  };

  (async () => {
    const existing = await loadIndex().catch(() => null);
    if (!existing || existing.version !== INDEX_VERSION) {
      log("[인덱스] 검색 인덱스를 새로 만들어요 (수십 분 소요, 완성 전까지는 기존 인덱스/키워드 검색으로 답변)");
      await run("최초 구축");
    }
    if (hours > 0) {
      setInterval(() => run("정기 갱신"), hours * 3600 * 1000);
    }
  })();
}
