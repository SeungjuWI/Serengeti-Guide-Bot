// 검색 인덱스를 수동으로 (재)구축: npm run index
import "dotenv/config";
import { buildIndex } from "../src/search.js";

const stats = await buildIndex({ log: console.log });
console.log(
  `인덱스 구축 완료 — 전체 ${stats.total} / 갱신 ${stats.updated} / 재사용 ${stats.reused} / 삭제 ${stats.removed}`
);
