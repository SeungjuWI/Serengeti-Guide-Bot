// 특정 주제는 "이 문서에서만" 답해야 하는 경우가 있다.
// 경조사처럼 여러 문서에 조각조각 언급되지만 공식 규정은 한 페이지에만 있는 주제가 그렇다.
// 여기에 걸린 주제는 검색 결과를 지정된 페이지로만 좁혀서 답변 근거로 쓴다.

/** 노션 ID는 하이픈 유무가 섞여 쓰이므로 비교 전에 형태를 통일 */
function normalizeId(id) {
  return String(id ?? "").trim().toLowerCase().replace(/-/g, "");
}

/**
 * 주제 고정 규칙.
 * - patterns: 질문(또는 추출된 키워드)에 하나라도 걸리면 이 주제로 본다
 * - pageIds: 답변 근거로 허용할 페이지 (이 페이지 밖의 문서는 무시)
 */
const BUILTIN_PINS = [
  {
    topic: "경조사",
    patterns: [/경조/, /축의/, /조의/, /부의/, /화환/, /상조/, /부고/, /장례/, /조문/],
    pageIds: ["946b4edc8c344aef8193eb5e01a09ec6"], // 경조사 지원 제도
  },
];

// PINNED_TOPICS 환경변수로 페이지를 덮어쓸 수 있다 (형식: "경조사:페이지ID,다른주제:페이지ID")
const PINS = BUILTIN_PINS.map((pin) => ({ ...pin, pageIds: pin.pageIds.map(normalizeId) }));
for (const entry of (process.env.PINNED_TOPICS ?? "").split(",")) {
  const [topic, id] = entry.split(":").map((s) => s?.trim());
  if (!topic || !id) continue;
  const existing = PINS.find((p) => p.topic === topic);
  if (existing) existing.pageIds = [normalizeId(id)];
}

/**
 * 질문이 고정 주제에 해당하면 그 규칙을 반환. 아니면 null.
 * @param {string} question
 * @param {string[]} keywords 질문 분류기가 뽑은 검색 키워드
 * @returns {{topic: string, pageIds: string[]} | null}
 */
export function findPinnedTopic(question, keywords = []) {
  const text = [question, ...keywords].join(" ");
  return PINS.find((pin) => pin.patterns.some((re) => re.test(text))) ?? null;
}

/** 이 페이지가 고정 주제의 허용 목록에 있는지 */
export function isPinnedPage(pageIds, id) {
  return pageIds.includes(normalizeId(id));
}
