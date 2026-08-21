// 검색 인덱스를 수동으로 (재)구축: npm run index
import "dotenv/config";
import { buildIndex } from "../src/search.js";

const stats = await buildIndex({ log: console.log });
console.log(
  `인덱스 구축 완료 — 페이지 ${stats.pages} (청크 ${stats.chunks}) / 갱신 ${stats.updated} / 재사용 ${stats.reused} / 삭제 ${stats.removed} / 읽기실패 ${stats.readFailed}`
);
if (stats.treeErrors > 0) {
  console.log(`⚠️ 하위 페이지 순회 실패 ${stats.treeErrors}건 — 위 로그의 '읽기 실패' 줄을 확인하세요`);
}
