import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_API_KEY });

const MAX_PAGES = 4; // 답변 컨텍스트에 넣을 최대 페이지 수
const MAX_CHARS_PER_PAGE = 4000; // 페이지당 최대 글자 수 (토큰 비용 제어)
const MAX_BLOCK_DEPTH = 2; // 중첩 블록(토글 등) 탐색 깊이

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
async function getBlocksText(blockId, depth = 0, budget = { chars: MAX_CHARS_PER_PAGE }) {
  if (depth > MAX_BLOCK_DEPTH || budget.chars <= 0) return "";

  const lines = [];
  let cursor;
  do {
    const res = await notion.blocks.children.list({
      block_id: blockId,
      page_size: 100,
      start_cursor: cursor,
    });

    for (const block of res.results) {
      if (budget.chars <= 0) break;

      const text = blockToText(block);
      if (text && text.trim()) {
        const line = text.slice(0, budget.chars);
        lines.push(line);
        budget.chars -= line.length;
      }
      if (block.has_children && block.type !== "child_page" && block.type !== "child_database") {
        const childText = await getBlocksText(block.id, depth + 1, budget);
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

    const res = await notion.search({
      query: keyword,
      page_size: 3,
      filter: { property: "object", value: "page" },
    });

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
