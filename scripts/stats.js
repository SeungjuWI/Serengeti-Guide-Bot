import { readFile } from "node:fs/promises";
import { LOG_FILE } from "../src/store.js";

const file = process.argv[2] ?? LOG_FILE;

let raw;
try {
  raw = await readFile(file, "utf-8");
} catch {
  console.log("아직 로그가 없어요. 봇이 질문을 받으면 data/logs.jsonl에 쌓입니다.");
  process.exit(0);
}

const events = raw
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const questions = events.filter((e) => e.type === "question");
const feedbacks = events.filter((e) => e.type === "feedback");
const answered = questions.filter((q) => q.outcome === "answered");
const noDocs = questions.filter((q) => q.outcome === "no_docs");
const blocked = questions.filter((q) => q.outcome === "blocked");
const up = feedbacks.filter((f) => f.vote === "up");
const down = feedbacks.filter((f) => f.vote === "down");

const first = events[0]?.at?.slice(0, 10) ?? "-";
const last = events[events.length - 1]?.at?.slice(0, 10) ?? "-";

console.log(`\n🦁 세렝게티 가이드봇 사용 통계 (${first} ~ ${last})`);
console.log("─".repeat(50));
console.log(`총 질문:        ${questions.length}건`);
console.log(`  ├ 답변 완료:   ${answered.length}건`);
console.log(`  ├ 문서 못 찾음: ${noDocs.length}건`);
console.log(`  └ 무관해서 차단: ${blocked.length}건`);
console.log(`피드백:         👍 ${up.length}  /  👎 ${down.length}`);

const keywordCount = {};
for (const q of answered.concat(noDocs)) {
  for (const k of q.keywords ?? []) keywordCount[k] = (keywordCount[k] ?? 0) + 1;
}
const topKeywords = Object.entries(keywordCount).sort((a, b) => b[1] - a[1]).slice(0, 10);
if (topKeywords.length > 0) {
  console.log(`\n🔍 많이 찾은 주제 TOP ${topKeywords.length}`);
  for (const [k, n] of topKeywords) console.log(`  ${String(n).padStart(3)}회  ${k}`);
}

if (down.length > 0) {
  console.log(`\n👎 아쉬웠던 질문 (최근 ${Math.min(down.length, 5)}건) — 문서 보강 후보`);
  for (const f of down.slice(-5)) console.log(`  - ${f.question}`);
}

if (noDocs.length > 0) {
  console.log(`\n❓ 문서를 못 찾은 질문 (최근 ${Math.min(noDocs.length, 10)}건) — 노션에 없는 내용`);
  for (const q of noDocs.slice(-10)) console.log(`  - ${q.question}`);
}
console.log();
