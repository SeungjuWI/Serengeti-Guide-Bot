// 특정 주제는 "이 문서에서만" 답해야 하는 경우가 있다.
// 경조사처럼 여러 문서에 조각조각 언급되지만 공식 규정은 한 페이지에만 있는 주제가 그렇다.
// 여기에 걸린 주제는 검색 결과를 지정된 페이지로만 좁혀서 답변 근거로 쓴다.

/** 노션 ID는 하이픈 유무가 섞여 쓰이므로 비교 전에 형태를 통일 */
function normalizeId(id) {
  return String(id ?? "").trim().toLowerCase().replace(/-/g, "");
}

/**
 * 앞에 다른 한글이 붙은 합성어까지 걸리지 않도록 앞쪽 경계를 붙인다.
 * 짧은 표현은 엉뚱한 단어 안에 들어 있는 경우가 많다
 * (예: "환경조성"의 "경조", "부상을 당했을 때"의 "상을 당", "협조의"의 "조의").
 * 합성어로 자주 쓰이는 표현("자녀결혼" 등)까지 막지 않도록 필요한 표현에만 쓴다.
 */
function standalone(source) {
  return new RegExp(`(^|[^가-힣])${source}`);
}

/**
 * 주제 고정 규칙.
 * - patterns: 질문(또는 추출된 키워드)에 하나라도 걸리면 이 주제로 본다
 * - pageIds: 답변 근거로 허용할 페이지 (이 페이지 밖의 문서는 무시)
 * - notes: (선택) 문서만으로는 모델이 자꾸 틀리는 지점을 못박는 해석 기준. 답변 생성 시 함께 전달된다
 */
const BUILTIN_PINS = [
  {
    topic: "경조사",
    // 경조사 지원 제도 문서가 다루는 범위: 결혼·칠순(경사), 사망(조사), 경조금·휴가·화환·상조물품
    // (출산은 모성보호제도 문서에서도 다루므로 여기에 넣지 않는다)
    patterns: [
      standalone("경조"), // "환경조성", "환경조사"에 걸리지 않도록
      standalone("조의"), // "협조의"에 걸리지 않도록
      standalone("상조"), // "손상조치" 같은 합성어 방지
      standalone("상\\s*을?\\s*당"), // "부상을 당했을 때"(산재)는 경조사가 아니다
      /축의/,
      /부의금/,
      /화환/,
      /부고/,
      /장례/,
      /조문/,
      /빈소/,
      /상갓집/,
      /돌아가/,
      /사망/,
      /별세/,
      /결혼/,
      /혼인/,
      /칠순/,
      /조부모/, // 시조부모·처조부모·외조부모까지 함께 잡히도록 경계를 두지 않음
    ],
    pageIds: ["946b4edc8c344aef8193eb5e01a09ec6"], // 경조사 지원 제도
    // 문서 표의 "(본인)" 표기를 모델이 흘려보내고 배우자 쪽까지 지원되는 것처럼 답하는 일이 있어
    // 답변 생성 시 함께 넣어주는 해석 기준. 규정이 바뀌면 노션 문서와 함께 여기도 고칠 것.
    notes: [
      "조부모의 사망, 외조부모의 사망은 '본인'의 조부모·외조부모만 지원 대상이다. " +
        "배우자의 조부모·외조부모(시조부모, 처조부모, 처외조부모, 시외조부모 등)는 지원 대상이 아니며 " +
        "경조금·휴가·조화·상조물품 중 어느 것도 지원되지 않는다.",
    ],
  },
];

// PINNED_TOPICS 환경변수로 고정 문서를 덮어쓸 수 있다 (형식: "경조사:페이지ID,다른주제:페이지ID")
const PINS = BUILTIN_PINS.map((pin) => ({ ...pin, pageIds: pin.pageIds.map(normalizeId) }));
for (const entry of (process.env.PINNED_TOPICS ?? "").split(",")) {
  const [topic, id] = entry.split(":").map((s) => s?.trim());
  if (!topic || !id) continue;
  const existing = PINS.find((p) => p.topic === topic);
  if (existing) existing.pageIds = [normalizeId(id)];
  // 오타로 조용히 무시되는 일이 없도록 알린다 (주제 이름은 여기 정의된 것만 쓸 수 있음)
  else console.warn(`PINNED_TOPICS에 없는 주제라 무시했어요: "${topic}" (사용 가능: ${PINS.map((p) => p.topic).join(", ")})`);
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
