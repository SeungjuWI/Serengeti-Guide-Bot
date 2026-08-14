import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_API_KEY });

const MAX_PAGES = 4; // 답변 컨텍스트에 넣을 최대 페이지 수
const MAX_CHARS_PER_PAGE = 4000; // 페이지당 최대 글자 수 (토큰 비용 제어)
const MAX_BLOCK_DEPTH = 2; // 중첩 블록(토글 등) 탐색 깊이
const MAX_CHILD_PAGE_DEPTH = 2; // 하위 페이지 탐색 깊이 (페이지 안의 페이지)

/** 노션 API 호출 재시도 (요청 제한 429, 일시적 서버 오류 대비) */
async function withRetry(fn, tries = 5) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = err?.code === "rate_limited" || err?.status === 429 || err?.status >= 500;
      if (!retryable || i === tries - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
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
    default:
      return null;
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

      // 하위 페이지는 제목을 표시하고 본문까지 따라 들어가서 읽음
      if (block.type === "child_page") {
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
        const childText = await getBlocksText(block.id, depth + 1, budget, pageDepth);
        if (childText) lines.push(childText);
      }
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor && budget.chars > 0);

  return lines.join("\n");
}

/**
 * 키워드들로 노션을 검색하고, 상위 페이지들의 본문까지 읽어서 반환.
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
        page_size: 3,
        filter: { property: "object", value: "page" },
      })
    );

    for (const page of res.results) {
      if (pages.length >= MAX_PAGES) break;
      if (seen.has(page.id)) continue;
      seen.add(page.id);
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
 * Integration이 접근 가능한 모든 페이지의 메타데이터를 가져옴 (검색 인덱스 구축용).
 * @returns {Promise<Array<{id: string, title: string, url: string, lastEdited: string, propsText: string}>>}
 */
export async function listAllPages() {
  const pages = [];
  let cursor;
  do {
    const res = await withRetry(() =>
      notion.search({
        page_size: 100,
        start_cursor: cursor,
        filter: { property: "object", value: "page" },
      })
    );
    for (const page of res.results) {
      pages.push({
        id: page.id,
        title: getPageTitle(page),
        url: page.url,
        lastEdited: page.last_edited_time,
        propsText: getPagePropsText(page),
      });
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return pages;
}

/**
 * 페이지 하나의 본문을 읽음.
 * followChildPages=false면 하위 페이지는 제목만 남김 (인덱스에선 하위 페이지가 각자 항목이 되므로 중복 방지).
 */
export async function readPageContent(pageId, { followChildPages = true } = {}) {
  const startPageDepth = followChildPages ? 0 : MAX_CHILD_PAGE_DEPTH;
  return getBlocksText(pageId, 0, { chars: MAX_CHARS_PER_PAGE }, startPageDepth);
}
