// 인덱스 상태 점검: npm run audit
// 1) 본문이 비어 있거나 읽기에 실패한 페이지  2) 통합은 볼 수 있는데 인덱스에 없는 페이지
import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@notionhq/client";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const notion = new Client({ auth: process.env.NOTION_API_KEY });

const index = JSON.parse(await readFile(path.join(DATA_DIR, "index.json"), "utf8"));
console.log(`인덱스 생성 ${index.builtAt} / 청크 ${index.docs.length}`);

const byPage = new Map();
for (const doc of index.docs) {
  if (!byPage.has(doc.id)) byPage.set(doc.id, []);
  byPage.get(doc.id).push(doc);
}
console.log(`페이지 ${byPage.size}개\n`);

// 1) 본문 품질
const empty = [];
const failed = [];
for (const chunks of byPage.values()) {
  const chars = chunks.reduce((sum, c) => sum + c.content.length, 0);
  if (chunks[0].readOk === false) failed.push(chunks[0]);
  else if (chars === 0) empty.push(chunks[0]);
}
console.log(`[본문] 읽기 실패 ${failed.length}개 / 본문 0자 ${empty.length}개`);
for (const doc of [...failed, ...empty].slice(0, 30)) console.log(`   - ${doc.title} ${doc.url}`);

// 2) 커버리지 — 통합이 접근 가능한 페이지 중 인덱스에 없는 것
const normalize = (id) => String(id).toLowerCase().replace(/-/g, "");
const indexed = new Set([...byPage.keys()].map(normalize));
const missing = [];
let seen = 0;
let cursor;
do {
  const res = await notion.search({
    page_size: 100,
    start_cursor: cursor,
    filter: { property: "object", value: "page" },
  });
  for (const page of res.results) {
    seen += 1;
    if (!indexed.has(normalize(page.id))) missing.push(page);
  }
  cursor = res.has_more ? res.next_cursor : undefined;
  await new Promise((resolve) => setTimeout(resolve, 400)); // 요청 제한 회피
} while (cursor);

console.log(`\n[커버리지] 통합이 볼 수 있는 페이지 ${seen}개 / 인덱스에 없는 것 ${missing.length}개`);
for (const page of missing.slice(0, 40)) {
  const title = Object.values(page.properties ?? {}).find((p) => p.type === "title");
  const name = (title?.title ?? []).map((t) => t.plain_text).join("") || "(제목 없음)";
  console.log(`   - ${name} [부모 ${page.parent?.type}] ${page.url}`);
}
