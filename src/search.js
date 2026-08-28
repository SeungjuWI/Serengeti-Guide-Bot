import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listAllPages, readPageContent, isExcludedPage } from "./notion.js";
import { isPinnedPage } from "./pinned.js";
import { embedTexts } from "./llm.js";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const INDEX_FILE = path.join(DATA_DIR, "index.json");

const INDEX_VERSION = 6; // 인덱스 형식이 바뀌면 올림 → 이전 인덱스는 버리고 전체 재구축
const MAX_RESULTS = 4; // 답변 컨텍스트에 넣을 최대 페이지 수
const MAX_CHUNKS_PER_PAGE = 2; // 페이지당 답변에 넣을 최대 청크 수
const MIN_SCORE = 0.2; // 이보다 관련도가 낮은 청크는 버림
const PINNED_MIN_SCORE = 0.05; // 주제가 특정 문서에 고정된 경우의 하한 (후보가 그 문서뿐이라 낮게)
const PINNED_MAX_CHUNKS_PER_PAGE = 4; // 고정 문서는 규정 전체를 봐야 하므로 청크를 더 넣음
// 1등 문서 점수 대비 이 비율에 못 미치는 문서는 버린다.
// 절대 하한(MIN_SCORE)만 두면 1등이 압도적이어도 MAX_RESULTS 자리를 억지로 채우게 되어,
// 무관한 문서가 답변 근거로 딸려 들어가고 모델이 그것까지 참고 문서로 인용한다.
const RELATIVE_CUTOFF = 0.75;
const EMBED_BATCH = 30; // 임베딩 API 한 번에 보낼 청크 수
const READ_CONCURRENCY = 3; // 노션 본문 읽기 동시 실행 수 (API 요청 제한 고려)
const MAX_INDEX_CHARS = 20000; // 인덱싱 시 페이지당 읽을 최대 글자 수
const CHUNK_CHARS = 1400; // 청크 하나의 최대 길이
const STANDALONE_SECTION_CHARS = 400; // 이 이상인 섹션은 독립 청크로 (다른 섹션과 안 섞음)
const TERM_BOOST = 0.15; // 검색어가 본문에 실제 등장할 때 최대 가점
const THIN_CONTENT_PENALTY = 0.05; // 내용이 거의 없는 페이지 감점 (제목만으로 상위 독식 방지)

/** OpenAI 임베딩은 길이가 1로 정규화되어 있어 내적이 곧 코사인 유사도 */
function similarity(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/** 줄 단위로 CHUNK_CHARS 이하가 되게 나눔 */
function packLines(text) {
  const out = [];
  let acc = "";
  for (const line of text.split("\n")) {
    if (acc && acc.length + line.length > CHUNK_CHARS) {
      out.push(acc);
      acc = line;
    } else {
      acc = acc ? `${acc}\n${line}` : line;
    }
  }
  if (acc.trim()) out.push(acc);
  return out;
}

/**
 * 긴 본문을 섹션(제목) 경계 기준으로 청크로 나눔.
 * 페이지 전체를 벡터 하나로 만들면 뒷부분 내용이 검색에서 묻히기 때문.
 * 내용이 충분한 섹션은 독립 청크가 되고, 짧은 섹션들만 이웃끼리 합침.
 */
export function splitIntoChunks(content) {
  // 1) 제목/하위문서 표시가 나올 때마다 섹션으로 나눔
  const sections = [];
  let cur = [];
  for (const line of content.split("\n")) {
    if (/^#{1,3} |^\[하위문서: |^\[하위 데이터베이스: /.test(line) && cur.length > 0) {
      sections.push(cur.join("\n"));
      cur = [];
    }
    cur.push(line);
  }
  if (cur.length > 0) sections.push(cur.join("\n"));

  // 2) 큰 섹션은 그대로 청크로, 작은 섹션들은 이웃끼리 합쳐서 청크로
  const chunks = [];
  let acc = "";
  const flush = () => {
    if (acc.trim()) chunks.push(acc);
    acc = "";
  };
  for (const section of sections) {
    if (section.length >= STANDALONE_SECTION_CHARS) {
      flush();
      chunks.push(...packLines(section));
    } else if (acc.length + section.length > CHUNK_CHARS) {
      flush();
      acc = section;
    } else {
      acc = acc ? `${acc}\n${section}` : section;
    }
  }
  flush();
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
 * 캐시된 청크를 그대로 재사용하면 안 되는 경우인지 판단.
 * 본문 읽기에 실패했던 페이지는 last_edited_time이 그대로여도 다시 읽어야 한다
 * (실패한 빈 본문이 영구히 재사용되어 검색에서 사라지는 것을 막기 위함).
 * readOk 표시가 없는 옛 인덱스는 본문이 비어 있을 때(= 속성값밖에 없을 때)만 다시 읽는다.
 */
function needsReread(cachedChunks, page) {
  const first = cachedChunks[0];
  if (first.readOk === false) return true;
  if (first.readOk === undefined) {
    const cachedChars = cachedChunks.reduce((sum, c) => sum + c.content.length, 0);
    return cachedChars <= (page.propsText?.length ?? 0);
  }
  return false;
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

  log("노션 루트 페이지에서 하위 페이지를 따라가며 목록을 만드는 중...");
  const treeErrors = [];
  const pages = await listAllPages({ log, onError: (kind, id, err) => treeErrors.push({ kind, id, message: err.message }) });
  log(`페이지 ${pages.length}개 발견`);
  if (treeErrors.length > 0) {
    log(`⚠️ 순회 중 ${treeErrors.length}건 실패 — 그 아래 문서가 인덱스에서 빠졌을 수 있어요`);
  }

  const docs = [];
  const toRead = [];
  let reusedPages = 0;
  let readFailed = 0;
  let skippedEmpty = 0;
  for (const page of pages) {
    const cachedChunks = prevByPage.get(page.id);
    if (cachedChunks && cachedChunks[0].lastEdited === page.lastEdited && !needsReread(cachedChunks, page)) {
      // 이전 인덱스에 남아 있던 빈 페이지도 여기서 걸러낸다 (읽기 경로와 같은 기준)
      if (cachedChunks.every((c) => !c.content.trim())) {
        skippedEmpty += 1;
        continue;
      }
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
        let readOk = true;
        try {
          content = await readPageContent(page.id, { followChildPages: false, maxChars: MAX_INDEX_CHARS });
        } catch (err) {
          readOk = false;
          readFailed += 1;
          log(`본문 읽기 실패, 제목만 인덱싱: ${page.title} — ${err.message}`);
        }
        const full = [page.propsText, content].filter(Boolean).join("\n");
        // 제목뿐인 페이지(첨부 사진 등)는 답변 근거가 못 되면서 검색 상위 자리만 차지하므로 인덱싱하지 않음
        if (readOk && !full.trim()) {
          skippedEmpty += 1;
          done += 1;
          continue;
        }
        splitIntoChunks(full).forEach((chunkText, i) => {
          newDocs.push({
            id: page.id,
            chunk: i,
            title: page.title,
            url: page.url,
            lastEdited: page.lastEdited,
            // 문의 안내를 이 문서의 소관 팀으로 하기 위해 함께 저장 (HR/GA/FA)
            team: page.team ?? null,
            // 읽기에 실패한 페이지는 다음 구축 때 본문을 다시 읽도록 표시 (실패한 빈 본문이 굳는 것 방지)
            readOk,
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

  if (skippedEmpty > 0) log(`내용이 없어 인덱싱하지 않은 페이지 ${skippedEmpty}개`);
  if (readFailed > 0) log(`본문 읽기 실패 ${readFailed}개 — 다음 구축 때 자동으로 다시 시도해요`);

  return {
    pages: pages.length,
    chunks: docs.length,
    updated: toRead.length,
    reused: reusedPages,
    removed,
    readFailed,
    treeErrors: treeErrors.length,
  };
}

/**
 * 질문과 의미가 가까운 청크를 찾아 페이지 단위로 묶어 반환.
 * keywords(LLM이 추출한 검색어)가 본문에 실제 등장하면 가점을 줘서 정확한 용어 질문을 보강.
 * 본문은 인덱스에 저장된 것을 사용 — 노션 변경사항은 다음 인덱스 갱신 때 반영됨.
 * 인덱스가 아직 없으면 null 반환 (호출부에서 키워드 검색으로 폴백).
 * pinnedPageIds를 주면 그 페이지 안에서만 찾는다 (경조사처럼 지정 문서로만 답해야 하는 주제).
 * @returns {Promise<Array<{title: string, url: string, content: string}> | null>}
 */
export async function searchIndex(query, keywords = [], { pinnedPageIds = null } = {}) {
  let index;
  try {
    index = await loadIndex();
  } catch {
    return null;
  }
  if (index.docs.length === 0) return null;

  const [queryVec] = await embedTexts([query]);
  const termSource = keywords.length > 0 ? keywords : query.split(/\s+/);
  const terms = [...new Set(termSource.map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 2))];
  const scored = index.docs
    // 주제가 특정 문서에 고정돼 있으면 그 문서 밖은 아예 후보에서 뺀다.
    // 고정은 명시적 지정이므로 제외 목록보다 우선한다 (인덱스 밖 폴백 경로와 동작을 맞춤).
    // 고정이 없을 때만 제외 페이지를 거른다 — 인덱스에 남아 있어도 답변 근거로 쓰지 않음 (다음 갱신 때 사라짐)
    .filter((doc) => (pinnedPageIds ? isPinnedPage(pinnedPageIds, doc.id) : !isExcludedPage(doc.id)))
    .map((doc) => {
      let score = similarity(queryVec, doc.embedding);
      // 검색어가 제목/본문에 실제로 등장하면 가점 (의미는 비슷한데 엉뚱한 문서가 이기는 것 방지)
      if (terms.length > 0) {
        const haystack = `${doc.title}\n${doc.content}`.toLowerCase();
        const hits = terms.filter((t) => haystack.includes(t)).length;
        score += TERM_BOOST * (hits / terms.length);
      }
      // 내용이 거의 없는 페이지는 감점 (제목만 비슷한 빈 페이지가 상위 독식하는 것 방지)
      if (doc.content.length < 80) score -= THIN_CONTENT_PENALTY;
      return { doc, score };
    })
    .sort((a, b) => b.score - a.score);

  // 상위 청크부터 페이지 단위로 묶음: 최대 4개 페이지, 페이지당 최대 2개 청크
  // 고정 문서는 후보가 그 문서뿐이라 관련도 하한을 낮추고 청크를 더 넣는다 (규정 전체를 보게)
  const minScore = pinnedPageIds ? PINNED_MIN_SCORE : MIN_SCORE;
  const maxChunks = pinnedPageIds ? PINNED_MAX_CHUNKS_PER_PAGE : MAX_CHUNKS_PER_PAGE;
  // 1등이 뚜렷하면 그 아래로 크게 처지는 문서는 버린다 (1등은 자기 자신 대비 1.0이라 항상 남는다).
  // 고정 주제에는 적용하지 않는다 — 후보가 지정 문서뿐이라 청크를 넓게 봐야 하기 때문.
  const topScore = scored[0]?.score ?? 0;
  const floor = pinnedPageIds ? minScore : Math.max(minScore, topScore * RELATIVE_CUTOFF);
  const byPage = new Map();
  for (const { doc, score } of scored) {
    if (score < minScore) break;
    let entry = byPage.get(doc.id);
    if (!entry) {
      // 상대 컷오프는 "새 페이지를 근거에 들일지"에만 적용한다.
      // 이미 채택한 페이지의 나머지 청크까지 자르면 본문이 반토막 나서,
      // 정작 답이 그 안에 있는데도 모델이 "찾지 못했어요"로 빠진다.
      if (score < floor) continue;
      if (byPage.size >= MAX_RESULTS) continue;
      entry = { title: doc.title, url: doc.url, team: doc.team ?? null, score, chunks: [] }; // score = 그 페이지 최고 청크 점수
      byPage.set(doc.id, entry);
    }
    if (entry.chunks.length < maxChunks) entry.chunks.push(doc);
  }

  return [...byPage.values()].map((entry) => ({
    title: entry.title,
    url: entry.url,
    team: entry.team,
    score: Math.round(entry.score * 1000) / 1000,
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
