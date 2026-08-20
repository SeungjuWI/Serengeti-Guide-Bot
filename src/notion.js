import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_API_KEY });

const MAX_PAGES = 4; // 답변 컨텍스트에 넣을 최대 페이지 수
const MAX_CHARS_PER_PAGE = 4000; // 페이지당 최대 글자 수 (토큰 비용 제어)
const MAX_BLOCK_DEPTH = 5; // 중첩 블록(토글 등) 탐색 깊이
// 컬럼 같은 레이아웃 블록은 내용 중첩이 아니므로 깊이 계산에서 제외
const LAYOUT_BLOCK_TYPES = new Set(["column_list", "column", "synced_block"]);
const MAX_CHILD_PAGE_DEPTH = 2; // 하위 페이지 탐색 깊이 (페이지 안의 페이지)

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

/** 노션 API 호출 재시도 (요청 제한 429는 노션이 알려주는 시간만큼 대기, 일시적 서버 오류는 지수 백오프) */
async function withRetry(fn, tries = 6) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      await throttle();
      return await fn();
    } catch (err) {
      lastErr = err;
      const rateLimited = err?.code === "rate_limited" || err?.status === 429;
      const retryable = rateLimited || err?.status >= 500;
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
      });
    } catch (err) {
      console.error(`페이지 본문 읽기 실패 (${page.id}):`, err.message);
    }
  }

  return results;
}

/** DB 행 페이지의 속성값들을 텍스트로 변환 (제목 속성 제외) */
function getPagePropsText(page) {
  if (page.parent?.type !== "database_id") return "";

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
      default:
        break;
    }
    if (value) lines.push(`${name}: ${value}`);
  }
  return lines.join("\n");
}

/**
 * 페이지 하나가 직접 품고 있는 하위 페이지·하위 DB를 찾음.
 * 토글·컬럼 등 중첩 블록 안까지 살피되, 하위 페이지 안으로는 들어가지 않는다 (순회는 호출부가 담당).
 */
async function listChildRefs(pageId) {
  const refs = [];
  const stack = [pageId];
  while (stack.length > 0) {
    const blockId = stack.pop();
    let cursor;
    do {
      const res = await withRetry(() =>
        notion.blocks.children.list({ block_id: blockId, page_size: 100, start_cursor: cursor })
      );
      for (const block of res.results) {
        if (block.type === "child_page") {
          refs.push({ type: "page", id: block.id });
        } else if (block.type === "child_database") {
          refs.push({ type: "database", id: block.id });
        } else if (block.has_children) {
          stack.push(block.id);
        }
      }
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);
  }
  return refs;
}

/** 데이터베이스의 모든 행(= 페이지)을 가져옴 */
async function listDatabaseRows(databaseId) {
  const rows = [];
  let cursor;
  do {
    const res = await withRetry(() =>
      notion.databases.query({ database_id: databaseId, page_size: 100, start_cursor: cursor })
    );
    rows.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return rows;
}

/**
 * 루트 페이지에서 시작해 하위 페이지를 모두 따라 들어가며 메타데이터를 모음 (검색 인덱스 구축용).
 * 하위 DB는 각 행이 하나의 페이지로 포함된다.
 * 제외 페이지는 목록에 넣지 않되, 그 아래 하위 페이지는 계속 따라간다.
 * @returns {Promise<Array<{id: string, title: string, url: string, lastEdited: string, propsText: string}>>}
 */
export async function listAllPages({ log = () => {} } = {}) {
  const pages = [];
  const visited = new Set();
  const queue = [{ id: ROOT_PAGE_ID, page: null }];

  while (queue.length > 0 && pages.length < MAX_TREE_PAGES) {
    const { id, page: known } = queue.shift();
    const key = normalizePageId(id);
    if (visited.has(key)) continue;
    visited.add(key);

    let page = known;
    if (!page) {
      try {
        page = await withRetry(() => notion.pages.retrieve({ page_id: id }));
      } catch (err) {
        log(`페이지 정보 읽기 실패 (${id}): ${err.message}`);
        continue;
      }
    }

    if (!isExcludedPage(page.id)) {
      pages.push({
        id: page.id,
        title: getPageTitle(page),
        url: page.url,
        lastEdited: page.last_edited_time,
        propsText: getPagePropsText(page),
      });
    }

    let refs = [];
    try {
      refs = await listChildRefs(page.id);
    } catch (err) {
      log(`하위 항목 읽기 실패 (${page.id}): ${err.message}`);
    }
    for (const ref of refs) {
      if (ref.type === "page") {
        queue.push({ id: ref.id, page: null });
        continue;
      }
      try {
        for (const row of await listDatabaseRows(ref.id)) queue.push({ id: row.id, page: row });
      } catch (err) {
        log(`데이터베이스 읽기 실패 (${ref.id}): ${err.message}`);
      }
    }
  }

  // 루트 하위 판별을 굳이 다시 계산하지 않도록 순회 결과를 재사용
  for (const key of visited) ancestryCache.set(key, true);
  return pages;
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
    const parentId = parent.page_id ?? parent.database_id ?? parent.block_id;
    if (!parentId) break;
    if (normalizePageId(parentId) === ROOT_PAGE_ID) return remember(true);

    try {
      if (parent.type === "database_id") {
        node = await withRetry(() => notion.databases.retrieve({ database_id: parentId }));
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
