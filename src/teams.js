// 문서 → 담당팀 매핑.
// 세렝게티 생활 가이드는 영역별로 운영 주체가 다르다. 어떤 문서를 근거로 답했는지에 따라
// 문의 안내가 달라져야 하므로, 문서가 어느 상위 DB/페이지에서 나왔는지로 담당팀을 정한다.

/** 팀 정보 — 프롬프트에 그대로 들어가는 명칭이므로 임의로 바꾸지 말 것 */
export const TEAMS = {
  hr: { name: "HR팀", tag: "@hr_team", channel: "#co_operations", scope: "인사규정 / 복리후생" },
  ga: { name: "GA팀", tag: "@ga_team", channel: "#co_operations", scope: "근무환경 / 계약, 자산관리" },
  fa: {
    name: "FA팀",
    tag: "@fa_team",
    channel: "#co_operations",
    scope: "재무회계 — 전자결재, 자금 집행, 지출결의서, 각종 증빙(법인카드·세금계산서·개인비용·외주인건비), 경품 지급",
  },
  bamboo: { name: "대나무숲", tag: "@likelion_bamboo", channel: "#co_operations", scope: "Idea 제안, 건의사항, 불편사항 접수" },
};

/**
 * 상위 컨테이너(DB 또는 페이지) ID → 담당팀.
 * 여기에 걸린 컨테이너 아래로 내려가는 모든 문서가 해당 팀 소관이 된다.
 * NOTION_TEAM_CONTAINERS 환경변수로 추가 가능 (형식: "hr:페이지ID,fa:DB ID").
 */
const BUILTIN_CONTAINERS = {
  "497e05b8248a4edbb539022c218f91e5": "hr", // 인사규정 / 복리후생 DB
  "3f1552b6f567420fabbd7368e0ada7d1": "ga", // 근무환경 / 계약, 자산관리 DB
  "3c344860a4f480e2946bce14949f1c13": "fa", // 재무회계 가이드 DB
  "3c344860a4f48022a02dd50f10290089": "fa", // 재무회계 가이드 DB를 담고 있는 상위 페이지
};

/** 노션 ID는 하이픈 유무가 섞여 쓰이므로 비교 전에 형태를 통일 */
function normalizeId(id) {
  return String(id ?? "").trim().toLowerCase().replace(/-/g, "");
}

const CONTAINER_TEAMS = new Map(Object.entries(BUILTIN_CONTAINERS));
for (const entry of (process.env.NOTION_TEAM_CONTAINERS ?? "").split(",")) {
  const [team, id] = entry.split(":").map((s) => s?.trim());
  if (team && id && TEAMS[team]) CONTAINER_TEAMS.set(normalizeId(id), team);
}

/** 이 컨테이너(DB/페이지)가 특정 팀 소관이면 팀 키를 반환 */
export function teamForContainer(id) {
  return CONTAINER_TEAMS.get(normalizeId(id)) ?? null;
}

/** 팀 키 → "FA팀 (Slack #co_operations 에서 @fa_team 태그)" 형태의 한 줄 */
export function describeTeam(teamKey) {
  const team = TEAMS[teamKey];
  if (!team) return "";
  return `${team.name} (Slack ${team.channel} 채널에서 ${team.tag} 태그)`;
}
