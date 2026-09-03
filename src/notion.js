import { Client } from "@notionhq/client";
import { teamForContainer } from "./teams.js";

const notion = new Client({ auth: process.env.NOTION_API_KEY });

// 노션 2025-09-03 API부터 데이터베이스 하나가 여러 데이터소스를 가질 수 있는데,
// SDK가 기본으로 쓰는 2022-06-28 버전으로는 그런 DB를 조회하면 400으로 거절당한다.
// 그러면 그 DB의 행 전체가 인덱스에서 통째로 빠지므로, 그 경우에만 새 버전으로 다시 조회한다.
const DATA_SOURCE_API_VERSION = "2025-09-03";
const notionDS = new Client({
  auth: process.env.NOTION_API_KEY,
  notionVersion: DATA_SOURCE_API_VERSION,
});

/** 여러 데이터소스를 가진 DB라서 구버전 API가 거절한 경우인지 */
function isMultiDataSourceError(err) {
  const body = typeof err?.body === "string" ? err.body : "";
  return (
    body.includes("multiple_data_sources_for_database") ||
    /multiple data sources/i.test(err?.message ?? "")
  );
}

const MAX_PAGES = 4; // 답변 컨텍스트에 넣을 최대 페이지 수
const MAX_CHARS_PER_PAGE = 4000; // 페이지당 최대 글자 수 (토큰 비용 제어)
const MAX_BLOCK_DEPTH = 5; // 중첩 블록(토글 등) 탐색 깊이
// 컬럼 같은 레이아웃 블록은 내용 중첩이 아니므로 깊이 계산에서 제외
const LAYOUT_BLOCK_TYPES = new Set(["column_list", "column", "synced_block"]);
const MAX_CHILD_PAGE_DEPTH = 2; // 하위 페이지 탐색 깊이 (페이지 안의 페이지)

// 본문에 걸린 링크(페이지 링크 블록·멘션·텍스트 링크)를 몇 단계까지 따라가 인덱싱할지.
// 하위 페이지(child_page)는 깊이 제한 없이 모두 따라가고, 이 값은 "링크로 건너뛴" 횟수만 센다.
// 0이면 링크는 따라가지 않고 예전처럼 하위 트리만 인덱싱한다.
const MAX_LINK_DEPTH = Math.max(0, Number(process.env.NOTION_LINK_FOLLOW_DEPTH ?? 2));

// 검색·인덱싱에서 제외할 페이지. 해당 페이지 본문만 제외되고, 하위 페이지는 각각 별도로 인덱싱된다.
// NOTION_EXCLUDED_PAGE_IDS 환경변수(쉼표 구분)로 추가 가능.
const EXCLUDED_PAGE_IDS = new Set(
  [
    "dc9a0c8908194a48900ec223c039dc0f", // LIKELION_Culture
    "ef5c89580b4542deb7b6dfdc04f50b97", // 경조사 지원 제도
    ...(process.env.NOTION_EXCLUDED_PAGE_IDS ?? "").split(","),
  ]
    .map(normalizePageId)
    .filter(Boolean)
);

// 인덱싱에서 통째로 제외할 데이터베이스. 예약·대여 기록처럼 행마다 날짜만 남는 로그성 DB는
// 검색 근거가 되지 못하면서 인덱스를 가득 채워 실제 가이드 문서를 밀어낸다.
// NOTION_EXCLUDED_DATABASE_IDS 환경변수(쉼표 구분)로 추가 가능.
const EXCLUDED_DATABASE_IDS = new Set(
  [
    "5a0e0fc452ed4833ac31bb2a9b76da65", // 동대문 강의장(사바나) 이용현황 — 예약 기록 612행
    "2ddbe2a69ead4c6981535c3260aaf841", // 16F 스튜디오 장비 예약 — 대여 기록 341행
    // 활동 후기 DB — 제도가 아니라 조별 활동 기록이라 답변 근거가 못 되면서,
    // 인덱스 청크의 40% 이상을 차지해 사내에 없는 용어("크런치 타임")에도 상위로 잡혀 지어낸 답을 만든다.
    "21444860a4f480ce979efbd6c46c66aa", // A!L INSIGHT TIME 활동 공유 — 조별 활동 내용 26행
    "25b415630ad24d8397178566f152dd1c", // 라온's 활동 리뷰 — 동호회 활동 후기 47행
    ...(process.env.NOTION_EXCLUDED_DATABASE_IDS ?? "").split(","),
  ]
    .map(normalizePageId)
    .filter(Boolean)
);

/** 행을 통째로 인덱싱하지 않을 데이터베이스인지 */
function isExcludedDatabase(id) {
  return EXCLUDED_DATABASE_IDS.has(normalizePageId(id));
}

// 봇이 참고하는 루트 페이지 — 이 페이지와 그 아래 모든 하위 페이지(하위 DB의 각 행 포함)만 대상으로 삼는다.
// NOTION_ROOT_PAGE_ID 환경변수로 교체 가능.
const ROOT_PAGE_ID = normalizePageId(
  process.env.NOTION_ROOT_PAGE_ID || "aed88b212dfb4833a1ed2067370f4c41"
);
const MAX_TREE_PAGES = 5000; // 순회 안전장치 (순환/과대 트리 대비)
const MAX_ANCESTOR_HOPS = 10; // 조상 추적 시 최대 거슬러 올라갈 단계

/** 노션 페이지 ID는 하이픈 유무가 섞여 쓰이므로 비교 전에 형태를 통일 */
function normalizePageId(id) {
  return String(id ?? "").trim().toLowerCase().replace(/-/g, "");
}

/** 답변 근거로 쓰지 않기로 한 페이지인지 */
export function isExcludedPage(id) {
  return EXCLUDED_PAGE_IDS.has(normalizePageId(id));
}

// 노션 API는 평균 초당 3회로 제한됨 — 전역으로 요청 간격을 띄워 429를 예방
const REQUEST_GAP_MS = 350;
let nextRequestAt = 0;
async function throttle() {
  const now = Date.now();
  const wait = nextRequestAt - now;
  nextRequestAt = Math.max(now, nextRequestAt) + REQUEST_GAP_MS;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

// 응답을 받기도 전에 끊긴 연결 — 노션이 준 상태 코드가 없어서 status로는 걸러지지 않는다
const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "notionhq_client_request_timeout",
  "notionhq_client_response_error",
]);

/** 오류 객체 어딘가에 네트워크 순단 흔적이 있는지 (fetch는 원인을 cause에 감춰둔다) */
function isNetworkError(err) {
  for (let e = err, depth = 0; e && depth < 3; e = e.cause, depth += 1) {
    if (NETWORK_ERROR_CODES.has(e.code)) return true;
    if (typeof e.message === "string" && /ECONNRESET|ENOTFOUND|ETIMEDOUT|socket hang up|fetch failed/i.test(e.message)) {
      return true;
    }
  }
  return false;
}

/**
 * 노션 API 호출 재시도.
 * 요청 제한 429는 노션이 알려주는 시간만큼 대기하고, 일시적 서버 오류와 네트워크 순단은 지수 백오프로 다시 시도한다.
 * 네트워크 순단을 재시도하지 않으면 그 페이지가 본문 없이 인덱싱된다.
 */
async function withRetry(fn, tries = 6) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      await throttle();
      return await fn();
    } catch (err) {
      lastErr = err;
      const rateLimited = err?.code === "rate_limited" || err?.status === 429;
      const retryable = rateLimited || err?.status >= 500 || isNetworkError(err);
      if (!retryable || i === tries - 1) throw err;

      const retryAfterSec = Number(err?.headers?.get?.("retry-after") ?? 0);
      const waitMs = rateLimited && retryAfterSec > 0
        ? Math.min(retryAfterSec, 300) * 1000
        : 1000 * 2 ** i;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastErr;
}

/** rich_text 배열을 일반 텍스트로 변환 */
function richTextToPlain(richText = []) {
  return richText.map((t) => t.plain_text).join("");
}

/** 페이지 객체에서 제목 추출 */
function getPageTitle(page) {
  const props = page.properties ?? {};
  for (const prop of Object.values(props)) {
    if (prop.type === "title") {
      const title = richTextToPlain(prop.title);
      if (title) return title;
    }
  }
  return "(제목 없음)";
}

/** 블록 하나를 텍스트 한 줄로 변환 (지원하지 않는 타입은 null) */
function blockToText(block) {
  const type = block.type;
  const data = block[type];
  if (!data) return null;

  switch (type) {
    case "paragraph":
    case "quote":
    case "callout":
    case "toggle":
      return richTextToPlain(data.rich_text);
    case "heading_1":
      return `# ${richTextToPlain(data.rich_text)}`;
    case "heading_2":
      return `## ${richTextToPlain(data.rich_text)}`;
    case "heading_3":
      return `### ${richTextToPlain(data.rich_text)}`;
    case "bulleted_list_item":
    case "numbered_list_item":
      return `- ${richTextToPlain(data.rich_text)}`;
    case "to_do":
      return `- [${data.checked ? "x" : " "}] ${richTextToPlain(data.rich_text)}`;
    case "code":
      return richTextToPlain(data.rich_text);
    case "table_row":
      return (data.cells ?? []).map((cell) => richTextToPlain(cell)).join(" | ");
    case "file":
    case "pdf": {
      const name = data.name || richTextToPlain(data.caption) || fileNameFromUrl(data);
      return name ? `[파일: ${name}]` : null;
    }
    case "bookmark":
    case "embed": {
      const caption = richTextToPlain(data.caption);
      return caption || data.url || null;
    }
    default:
      return null;
  }
}

/** 파일/PDF 블록의 URL에서 파일명 추출 */
function fileNameFromUrl(data) {
  const url = data.file?.url ?? data.external?.url ?? "";
  try {
    return decodeURIComponent(url.split("?")[0].split("/").pop() ?? "");
  } catch {
    return "";
  }
}

/** 페이지의 블록들을 재귀적으로 읽어 텍스트로 합침 */
async function getBlocksText(blockId, depth = 0, budget = { chars: MAX_CHARS_PER_PAGE }, pageDepth = 0) {
  if (depth > MAX_BLOCK_DEPTH || budget.chars <= 0) return "";

  const lines = [];
  let cursor;
  do {
    const res = await withRetry(() =>
      notion.blocks.children.list({
        block_id: blockId,
        page_size: 100,
        start_cursor: cursor,
      })
    );

    for (const block of res.results) {
      if (budget.chars <= 0) break;

      // 하위 페이지는 제목을 표시하고 본문까지 따라 들어가서 읽음 (제외 페이지는 통째로 건너뜀)
      if (block.type === "child_page") {
        if (isExcludedPage(block.id)) continue;
        const title = block.child_page?.title;
        if (title) {
          const line = `\n[하위문서: ${title}]`.slice(0, budget.chars);
          lines.push(line);
          budget.chars -= line.length;
        }
        if (pageDepth < MAX_CHILD_PAGE_DEPTH) {
          const childText = await getBlocksText(block.id, 0, budget, pageDepth + 1);
          if (childText) lines.push(childText);
        }
        continue;
      }
      // 하위 데이터베이스는 제목만 표시 (각 행은 별도 페이지로 인덱싱되어 검색됨)
      if (block.type === "child_database") {
        const title = block.child_database?.title;
        if (title) {
          const line = `\n[하위 데이터베이스: ${title}]`.slice(0, budget.chars);
          lines.push(line);
          budget.chars -= line.length;
        }
        continue;
      }

      const text = blockToText(block);
      if (text && text.trim()) {
        const line = text.slice(0, budget.chars);
        lines.push(line);
        budget.chars -= line.length;
      }
      if (block.has_children) {
        const nextDepth = LAYOUT_BLOCK_TYPES.has(block.type) ? depth : depth + 1;
        const childText = await getBlocksText(block.id, nextDepth, budget, pageDepth);
        if (childText) lines.push(childText);
      }
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor && budget.chars > 0);

  return lines.join("\n");
}

/**
 * 키워드들로 노션을 검색하고, 상위 페이지들의 본문까지 읽어서 반환.
 * 루트 페이지 아래에 있는 문서만 결과로 삼는다.
 * @param {string[]} keywords
 * @returns {Promise<Array<{title: string, url: string, content: string}>>}
 */
export async function searchNotionPages(keywords) {
  const seen = new Set();
  const pages = [];

  for (const keyword of keywords) {
    if (pages.length >= MAX_PAGES) break;

    const res = await withRetry(() =>
      notion.search({
        query: keyword,
        page_size: 5,
        filter: { property: "object", value: "page" },
      })
    );

    for (const page of res.results) {
      if (pages.length >= MAX_PAGES) break;
      if (seen.has(page.id)) continue;
      seen.add(page.id);
      if (isExcludedPage(page.id)) continue;
      if (!(await isUnderRoot(page))) continue;
      pages.push(page);
    }
  }

  const results = [];
  for (const page of pages) {
    try {
      const content = await getBlocksText(page.id);
      results.push({
        title: getPageTitle(page),
        url: page.url,
        content,
        team: await resolveTeamForPage(page),
      });
    } catch (err) {
      console.error(`페이지 본문 읽기 실패 (${page.id}):`, err.message);
    }
  }

  return results;
}

/** DB 행 페이지인지 (새 API 버전에서는 부모가 data_source_id로 온다) */
function isDatabaseRow(page) {
  const type = page.parent?.type;
  return type === "database_id" || type === "data_source_id";
}

/** DB 행 페이지의 속성값들을 텍스트로 변환 (제목 속성 제외) */
function getPagePropsText(page) {
  if (!isDatabaseRow(page)) return "";

  const lines = [];
  for (const [name, prop] of Object.entries(page.properties ?? {})) {
    let value = "";
    switch (prop.type) {
      case "rich_text":
        value = richTextToPlain(prop.rich_text);
        break;
      case "select":
        value = prop.select?.name ?? "";
        break;
      case "status":
        value = prop.status?.name ?? "";
        break;
      case "multi_select":
        value = (prop.multi_select ?? []).map((s) => s.name).join(", ");
        break;
      case "date":
        value = prop.date ? [prop.date.start, prop.date.end].filter(Boolean).join(" ~ ") : "";
        break;
      case "number":
        value = prop.number == null ? "" : String(prop.number);
        break;
      case "url":
      case "email":
      case "phone_number":
        value = prop[prop.type] ?? "";
        break;
      case "checkbox":
        value = prop.checkbox ? "예" : "";
        break;
      // 담당자·구성원처럼 사람으로만 채워진 속성도 검색 대상이 되어야 한다
      case "people":
        value = (prop.people ?? []).map((p) => p.name).filter(Boolean).join(", ");
        break;
      case "files":
        value = (prop.files ?? []).map((f) => f.name).filter(Boolean).join(", ");
        break;
      case "formula":
        value = String(prop.formula?.string ?? prop.formula?.number ?? "");
        break;
      default:
        break;
    }
    if (value) lines.push(`${name}: ${value}`);
  }
  return lines.join("\n");
}

// 노션 URL/경로에서 페이지·DB ID(32자리 16진수)를 뽑아냄
const NOTION_ID_RE = /([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})/i;
const NOTION_HOST_RE = new RegExp("^https?://[^/]*(notion[.]so|notion[.]site|notion[.]com)/", "i");

/** 링크 주소가 같은 워크스페이스의 노션 문서를 가리키면 그 ID를 반환 (외부 링크는 null) */
function notionIdFromHref(href) {
  if (!href) return null;
  if (!href.startsWith("/") && !NOTION_HOST_RE.test(href)) return null;
  // 쿼리스트링과 앵커(#...)를 떼고 경로에서만 찾는다 — 앵커는 페이지가 아니라 블록 ID다
  const path = href.split("?")[0].split("#")[0];
  const match = NOTION_ID_RE.exec(path);
  return match ? normalizePageId(match[1]) : null;
}

/** rich_text 안의 멘션·링크가 가리키는 노션 문서 ID들을 모음 */
function refsFromRichText(richText) {
  const refs = [];
  for (const token of richText ?? []) {
    const mention = token.type === "mention" ? token.mention : null;
    if (mention?.type === "page" && mention.page?.id) refs.push({ type: "page", id: mention.page.id });
    else if (mention?.type === "database" && mention.database?.id) refs.push({ type: "database", id: mention.database.id });
    const linked = notionIdFromHref(token.href ?? token.text?.link?.url);
    if (linked) refs.push({ type: "unknown", id: linked });
  }
  return refs;
}

/** 블록 하나가 가리키는 다른 노션 문서들 (페이지 링크 블록, 멘션, 본문 링크, 북마크/임베드) */
function linkRefsFromBlock(block) {
  const refs = [];
  const data = block[block.type] ?? {};

  if (block.type === "link_to_page") {
    if (data.page_id) refs.push({ type: "page", id: data.page_id });
    else if (data.database_id) refs.push({ type: "database", id: data.database_id });
  }
  if (block.type === "bookmark" || block.type === "embed" || block.type === "link_preview") {
    const linked = notionIdFromHref(data.url);
    if (linked) refs.push({ type: "unknown", id: linked });
  }
  refs.push(...refsFromRichText(data.rich_text));
  refs.push(...refsFromRichText(data.caption));
  if (block.type === "table_row") {
    for (const cell of data.cells ?? []) refs.push(...refsFromRichText(cell));
  }
  return refs;
}

/**
 * 페이지 하나가 직접 품고 있는 하위 페이지·하위 DB와, 본문에서 링크로 가리키는 다른 문서를 찾음.
 * 토글·컬럼 등 중첩 블록 안까지 살피되, 하위 페이지 안으로는 들어가지 않는다 (순회는 호출부가 담당).
 * ref.via는 "child"(품고 있음) 또는 "link"(링크로 가리킴) — 호출부가 링크 깊이를 셀 때 쓴다.
 */
async function listChildRefs(pageId) {
  const refs = [];
  const stack = [pageId];
  const seenBlocks = new Set(); // 동기화 블록 등으로 같은 블록을 두 번 훑지 않도록
  while (stack.length > 0) {
    const blockId = stack.pop();
    if (seenBlocks.has(blockId)) continue;
    seenBlocks.add(blockId);
    let cursor;
    do {
      const res = await withRetry(() =>
        notion.blocks.children.list({ block_id: blockId, page_size: 100, start_cursor: cursor })
      );
      for (const block of res.results) {
        if (block.type === "child_page") {
          refs.push({ type: "page", id: block.id, via: "child" });
        } else if (block.type === "child_database") {
          refs.push({ type: "database", id: block.id, via: "child" });
        } else {
          if (MAX_LINK_DEPTH > 0) {
            for (const link of linkRefsFromBlock(block)) refs.push({ ...link, via: "link" });
          }
          if (block.has_children) stack.push(block.id);
        }
      }
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);
  }
  return refs;
}

/** 데이터베이스의 모든 행(= 페이지)을 가져옴 (다중 데이터소스 DB는 새 API 버전으로 폴백) */
async function listDatabaseRows(databaseId) {
  const rows = [];
  let cursor;
  try {
    do {
      const res = await withRetry(() =>
        notion.databases.query({ database_id: databaseId, page_size: 100, start_cursor: cursor })
      );
      rows.push(...res.results);
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);
  } catch (err) {
    if (!isMultiDataSourceError(err)) throw err;
    return listDataSourceRows(databaseId);
  }
  return rows;
}

/** 다중 데이터소스 DB: 데이터소스 목록을 받아 각각의 행을 모두 가져옴 */
async function listDataSourceRows(databaseId) {
  const db = await withRetry(() =>
    notionDS.request({ path: `databases/${databaseId}`, method: "get" })
  );
  const rows = [];
  for (const dataSource of db.data_sources ?? []) {
    let cursor;
    do {
      const res = await withRetry(() =>
        notionDS.request({
          path: `data_sources/${dataSource.id}/query`,
          method: "post",
          body: { page_size: 100, start_cursor: cursor },
        })
      );
      rows.push(...res.results);
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);
  }
  return rows;
}

/** 데이터베이스 메타 조회 (다중 데이터소스 DB는 새 API 버전으로 폴백) */
async function retrieveDatabase(databaseId) {
  try {
    return await withRetry(() => notion.databases.retrieve({ database_id: databaseId }));
  } catch (err) {
    if (!isMultiDataSourceError(err)) throw err;
    return withRetry(() => notionDS.request({ path: `databases/${databaseId}`, method: "get" }));
  }
}

/** 링크가 가리키는 대상이 페이지인지 DB인지 확인 (본문 링크는 종류가 적혀 있지 않다) */
async function classifyRef(id) {
  try {
    return { kind: "page", page: await withRetry(() => notion.pages.retrieve({ page_id: id })) };
  } catch (err) {
    // 권한이 없거나 삭제된 문서는 여기서 조용히 걸러진다
    if (err?.status && err.status !== 400 && err.status !== 404) throw err;
  }
  try {
    await retrieveDatabase(id);
    return { kind: "database", page: null };
  } catch {
    return { kind: null, page: null };
  }
}

/**
 * 루트 페이지에서 시작해 하위 페이지를 모두 따라 들어가며 메타데이터를 모음 (검색 인덱스 구축용).
 * 하위 DB는 각 행이 하나의 페이지로 포함된다.
 * 본문에 걸린 링크(페이지 링크 블록·멘션·텍스트 링크)도 MAX_LINK_DEPTH 단계까지 따라가므로,
 * 루트 트리 밖에 있지만 가이드에서 링크로 안내하는 문서도 검색 대상이 된다.
 * 제외 페이지는 목록에 넣지 않되, 그 아래 하위 페이지는 계속 따라간다.
 * 각 페이지에는 소관 팀(team)이 함께 붙는다 — 상위 DB/페이지의 담당팀을 물려받는다.
 * @returns {Promise<Array<{id: string, title: string, url: string, lastEdited: string, propsText: string, team: string|null}>>}
 */
export async function listAllPages({ log = () => {}, onError = () => {} } = {}) {
  const pages = [];
  const visited = new Set();
  const enqueued = new Set([ROOT_PAGE_ID]);
  const queue = [{ id: ROOT_PAGE_ID, page: null, team: null, linkDepth: 0 }];
  let linkedPages = 0;

  while (queue.length > 0 && pages.length < MAX_TREE_PAGES) {
    const { id, page: known, team: inheritedTeam, linkDepth } = queue.shift();
    const key = normalizePageId(id);
    if (visited.has(key)) continue;
    visited.add(key);

    let page = known;
    if (!page) {
      try {
        page = await withRetry(() => notion.pages.retrieve({ page_id: id }));
      } catch (err) {
        // 링크로 발견한 문서는 통합에 연결돼 있지 않을 수 있다 — 원래 트리에서 빠진 게 아니므로 경고로 세지 않는다
        if (linkDepth > 0) {
          log(`링크 대상 건너뜀 (통합 미연결 등): ${id}`);
          continue;
        }
        log(`페이지 정보 읽기 실패 (${id}): ${err.message}`);
        onError("page", id, err);
        continue;
      }
    }

    // 이 페이지 자체가 팀 소관 컨테이너면 그 팀, 아니면 상위에서 물려받은 팀
    const team = teamForContainer(page.id) ?? inheritedTeam;

    if (!isExcludedPage(page.id)) {
      pages.push({
        id: page.id,
        title: getPageTitle(page),
        url: page.url,
        lastEdited: page.last_edited_time,
        propsText: getPagePropsText(page),
        team,
      });
      if (linkDepth > 0) linkedPages += 1;
    }

    let refs = [];
    try {
      refs = await listChildRefs(page.id);
    } catch (err) {
      // 여기서 실패하면 그 아래 하위 문서가 통째로 인덱스에서 빠진다 — 반드시 눈에 띄게 남긴다
      log(`하위 항목 읽기 실패 (${page.id}): ${err.message}`);
      onError("children", page.id, err);
    }

    for (const ref of refs) {
      const nextDepth = ref.via === "link" ? linkDepth + 1 : linkDepth;
      if (nextDepth > MAX_LINK_DEPTH) continue;
      const refKey = normalizePageId(ref.id);
      if (!refKey || visited.has(refKey) || enqueued.has(refKey)) continue;
      const refTeam = teamForContainer(ref.id) ?? team;

      let kind = ref.type;
      let refPage = null;
      if (kind === "unknown") {
        try {
          ({ kind, page: refPage } = await classifyRef(ref.id));
        } catch (err) {
          log(`링크 대상 확인 실패 (${ref.id}): ${err.message}`);
          continue;
        }
        if (!kind) continue; // 권한 없음·삭제됨·외부 문서
      }

      if (kind === "page") {
        enqueued.add(refKey);
        queue.push({ id: ref.id, page: refPage, team: refTeam, linkDepth: nextDepth });
        continue;
      }
      if (isExcludedDatabase(ref.id)) {
        log(`로그성 데이터베이스 건너뜀: ${ref.id}`);
        continue;
      }
      enqueued.add(refKey);
      try {
        for (const row of await listDatabaseRows(ref.id)) {
          // 다중 데이터소스 DB는 데이터소스마다 소관 팀이 다를 수 있다
          // (재무회계 가이드 DB 안에 GA 데이터소스가 들어와 있는 경우 등). 행의 부모 데이터소스를 먼저 본다.
          const rowTeam = teamForContainer(row.parent?.data_source_id) ?? refTeam;
          queue.push({ id: row.id, page: row, team: rowTeam, linkDepth: nextDepth });
        }
      } catch (err) {
        log(`데이터베이스 읽기 실패 (${ref.id}): ${err.message}`);
        onError("database", ref.id, err);
      }
    }
  }

  if (linkedPages > 0) log(`링크를 통해 먼저 도달한 문서 ${linkedPages}개 (링크 깊이 최대 ${MAX_LINK_DEPTH}) — 하위 트리로도 닿는 문서가 섞여 있을 수 있어요`);
  if (pages.length >= MAX_TREE_PAGES) log(`⚠️ 순회 상한 ${MAX_TREE_PAGES}개에 도달해 멈췄어요`);

  // 루트 하위 판별을 굳이 다시 계산하지 않도록 순회 결과를 재사용
  for (const key of visited) ancestryCache.set(key, true);
  return pages;
}

const teamCache = new Map(); // 정규화된 페이지 ID → 담당팀 키 (null 포함)

/**
 * 이 페이지가 어느 팀 소관인지 부모를 거슬러 올라가며 찾음.
 * 인덱스에는 순회할 때 팀이 함께 저장되므로, 이 경로는 인덱스 없이 키워드 검색할 때만 쓰인다.
 */
export async function resolveTeamForPage(page) {
  const chain = [];
  const remember = (result) => {
    for (const key of chain) teamCache.set(key, result);
    return result;
  };

  let node = page;
  for (let hop = 0; hop < MAX_ANCESTOR_HOPS && node; hop++) {
    const key = normalizePageId(node.id);
    const direct = teamForContainer(key);
    if (direct) return remember(direct);
    if (teamCache.has(key)) return remember(teamCache.get(key));
    chain.push(key);

    const parent = node.parent;
    if (!parent || parent.type === "workspace") break;
    const isDbParent = parent.type === "database_id" || parent.type === "data_source_id";
    const parentId = parent.page_id ?? parent.database_id ?? parent.block_id;
    if (!parentId) break;
    // DB 자체보다 데이터소스의 소관이 우선한다 (한 DB에 팀이 다른 데이터소스가 섞여 있을 수 있음)
    const parentTeam = teamForContainer(parent.data_source_id) ?? teamForContainer(parentId);
    if (parentTeam) return remember(parentTeam);

    try {
      if (isDbParent) node = await retrieveDatabase(parentId);
      else if (parent.type === "block_id") node = await withRetry(() => notion.blocks.retrieve({ block_id: parentId }));
      else node = await withRetry(() => notion.pages.retrieve({ page_id: parentId }));
    } catch {
      break;
    }
  }
  return remember(null);
}

const ancestryCache = new Map(); // 정규화된 페이지 ID → 루트 하위 여부

/** 이 페이지가 루트 페이지이거나 그 아래에 있는지 (부모를 거슬러 올라가며 확인) */
async function isUnderRoot(page) {
  const chain = [];
  const remember = (result) => {
    for (const key of chain) ancestryCache.set(key, result);
    return result;
  };

  let node = page;
  for (let hop = 0; hop < MAX_ANCESTOR_HOPS && node; hop++) {
    const key = normalizePageId(node.id);
    if (key === ROOT_PAGE_ID) return remember(true);
    const cached = ancestryCache.get(key);
    if (cached !== undefined) return remember(cached);
    chain.push(key);

    const parent = node.parent;
    if (!parent || parent.type === "workspace") break;
    // 다중 데이터소스 DB의 행은 부모가 data_source_id지만 같은 객체에 database_id도 들어 있다
    const isDbParent = parent.type === "database_id" || parent.type === "data_source_id";
    const parentId = parent.page_id ?? parent.database_id ?? parent.block_id;
    if (!parentId) break;
    if (normalizePageId(parentId) === ROOT_PAGE_ID) return remember(true);

    try {
      if (isDbParent) {
        node = await retrieveDatabase(parentId);
      } else if (parent.type === "block_id") {
        node = await withRetry(() => notion.blocks.retrieve({ block_id: parentId }));
      } else {
        node = await withRetry(() => notion.pages.retrieve({ page_id: parentId }));
      }
    } catch {
      break;
    }
  }
  return remember(false);
}

/**
 * 페이지 하나의 본문을 읽음.
 * followChildPages=false면 하위 페이지는 제목만 남김 (인덱스에선 하위 페이지가 각자 항목이 되므로 중복 방지).
 * maxChars로 읽을 분량 조절 가능 (인덱싱은 긴 페이지도 끝까지 읽도록 크게 잡음).
 */
export async function readPageContent(pageId, { followChildPages = true, maxChars = MAX_CHARS_PER_PAGE } = {}) {
  const startPageDepth = followChildPages ? 0 : MAX_CHILD_PAGE_DEPTH;
  return getBlocksText(pageId, 0, { chars: maxChars }, startPageDepth);
}

/**
 * 페이지 하나를 답변 근거 형태로 읽어옴 (제목·URL·본문·담당팀).
 * 주제가 특정 문서에 고정돼 있는데 그 문서가 인덱스에 없을 때 쓰는 경로.
 * @returns {Promise<{title: string, url: string, content: string, team: string|null} | null>}
 */
export async function fetchPageAsDoc(pageId) {
  try {
    const page = await withRetry(() => notion.pages.retrieve({ page_id: pageId }));
    return {
      title: getPageTitle(page),
      url: page.url,
      content: await getBlocksText(page.id),
      team: await resolveTeamForPage(page),
    };
  } catch (err) {
    console.error(`고정 문서 읽기 실패 (${pageId}):`, err.message);
    return null;
  }
}
