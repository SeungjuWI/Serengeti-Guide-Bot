import "dotenv/config";
import fs from "node:fs";
import { Client } from "@notionhq/client";
const notion = new Client({ auth: process.env.NOTION_API_KEY });
const ROOT = "aed88b212dfb4833a1ed2067370f4c41";
const norm = s => String(s).toLowerCase().replace(/-/g, "");
const gap = () => new Promise(r => setTimeout(r, 340));
const LOG_DBS = new Set(["5a0e0fc452ed4833ac31bb2a9b76da65","2ddbe2a69ead4c6981535c3260aaf841"]);
const EXCLUDED = new Set(["dc9a0c8908194a48900ec223c039dc0f","ef5c89580b4542deb7b6dfdc04f50b97"]);

const idx = JSON.parse(fs.readFileSync("data/index.json","utf8"));
const indexed = new Set(idx.docs.map(d => norm(d.id)));

const title = p => { const t=Object.values(p.properties??{}).find(x=>x.type==="title");
  return (t?.title??[]).map(x=>x.plain_text).join("") || "(제목 없음)"; };

const all = new Map(); // norm id -> {title, via}
const seenBlocks = new Set();
const queue = [{ id: ROOT, title: "(루트)" }];
all.set(ROOT, { title: "세렝게티 생활 가이드", via: "루트" });
let dbCount = 0, logRows = 0;

while (queue.length) {
  const node = queue.shift();
  let blocks = [], c;
  try { do { await gap();
      const r = await notion.blocks.children.list({ block_id: node.id, page_size: 100, start_cursor: c });
      blocks.push(...r.results); c = r.has_more ? r.next_cursor : undefined; } while (c);
  } catch (e) { console.log(`!! 자식 읽기 실패 ${node.title} (${node.id}): ${e.message}`); continue; }

  for (const b of blocks) {
    if (b.type === "child_page") {
      if (all.has(norm(b.id))) continue;
      all.set(norm(b.id), { title: b.child_page.title, via: "하위페이지" });
      queue.push({ id: b.id, title: b.child_page.title });
    } else if (b.type === "child_database") {
      dbCount++;
      const isLog = LOG_DBS.has(norm(b.id));
      let cur;
      try { do { await gap();
          const r = await notion.databases.query({ database_id: b.id, page_size: 100, start_cursor: cur });
          for (const row of r.results) {
            if (isLog) { logRows++; all.set(norm(row.id), { title: title(row), via: "로그DB행" }); continue; }
            if (all.has(norm(row.id))) continue;
            all.set(norm(row.id), { title: title(row), via: "DB행" });
            queue.push({ id: row.id, title: title(row) });
          }
          cur = r.has_more ? r.next_cursor : undefined; } while (cur);
      } catch (e) { console.log(`!! DB 읽기 실패 ${b.child_database?.title}: ${e.message}`); }
    } else if (b.has_children && !seenBlocks.has(norm(b.id))) {
      seenBlocks.add(norm(b.id));
      queue.push({ id: b.id, title: node.title });
    }
  }
}

const buckets = { 검색가능: [], 로그DB제외: [], 제외설정: [], 내용없음: [] };
for (const [id, info] of all) {
  if (indexed.has(id)) buckets.검색가능.push(info);
  else if (info.via === "로그DB행") buckets.로그DB제외.push(info);
  else if (EXCLUDED.has(id)) buckets.제외설정.push(info);
  else buckets.내용없음.push({ ...info, id });
}
console.log(`\n루트 아래 전체 페이지 ${all.size}개 (데이터베이스 ${dbCount}개)`);
for (const [k, v] of Object.entries(buckets)) console.log(`  ${k}: ${v.length}개`);
console.log(`\n[검색 안 되는 페이지 — 내용 없음으로 판정된 것 ${buckets.내용없음.length}개]`);
buckets.내용없음.forEach(x => console.log(`   - ${x.title}  (${x.via})`));
