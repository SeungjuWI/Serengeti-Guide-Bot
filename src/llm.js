import OpenAI from "openai";
import { TEAMS, describeTeam } from "./teams.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";

/**
 * 텍스트 배열을 임베딩 벡터로 변환 (의미 기반 검색용).
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
export async function embedTexts(texts) {
  const input = texts.map((t) => (t || " ").slice(0, 3000)); // 임베딩 모델 토큰 한도 보호
  const res = await openai.embeddings.create({ model: EMBEDDING_MODEL, input });
  return res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

/**
 * 질문이 사내 가이드 관련인지 분류하고, 관련이면 노션 검색용 키워드를 추출.
 * 노션 Search API는 문장 검색에 약해서, 짧은 키워드 2~3개로 나눠 검색한다.
 * @param {string} question
 * @param {string} history 이전 대화 내용 (없으면 빈 문자열)
 * @returns {Promise<{relevant: boolean, keywords: string[], personalInfo: boolean}>}
 */
export async function analyzeQuestion(question, history = "") {
  const res = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0,
    max_tokens: 120,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "너는 사내 가이드봇의 질문 분류기다. 사용자의 질문이 회사 생활·사내 제도" +
          "(인사규정, 휴가, 복지, 급여일, 근무환경, 사무기기, 비품, 구매·계약, 회의실/장비 예약, 조직, 구성원, 사내 행사, 그룹웨어 사용법 등)와 " +
          "관련이 있는지 판단하고, 관련 있으면 노션 검색용 키워드를 추출해라.\n" +
          'JSON으로만 답해라: {"relevant": true 또는 false, "keywords": ["키워드1", "키워드2"], "personal_info": true 또는 false}\n' +
          "- 기본값은 relevant=true다. 회사 문서에 있을 가능성이 조금이라도 있으면 relevant=true로 판단해라.\n" +
          "- relevant=false는 회사와 무관함이 명백할 때만 쓴다 (요리 레시피, 시사/일반 상식, 번역, 숙제, 외부 코딩 질문 등)\n" +
          '- 단어 하나짜리 질문("구매", "복합기", "평가", "연봉")은 사내 문서를 찾는 질문이다. 잡담으로 보지 말고 relevant=true로 판단해라.\n' +
          '- 모르는 단어는 사내 제도/용어/시스템/장비 이름일 수 있으니 relevant=true로 판단해라 (예: "프라이드 시즌"(평가), "프라이드 미팅", "아마란스"(그룹웨어), "레몬베이스", "식권대장", "버디 제도", "세렝게티"(생활 가이드))\n' +
          '- 구성원 개인에 대한 질문(소속, 취미, MBTI 등)도 사내 구성원 소개 문서에 있을 수 있으니 relevant=true로 판단해라. 답변 여부는 다음 단계에서 정한다.\n' +
          '- personal_info=true는 특정 개인의 민감한 개인정보(급여·연봉, 인사평가·등급, 연락처, 주소, 주민등록번호, 계좌, 건강·징계 이력)를 알려달라는 질문일 때만 쓴다.\n' +
          '  제도 자체를 묻는 질문("연봉 계약 언제 해요?", "평가 어떻게 진행돼요?")이나 소속·취미·MBTI 같은 소개 정보는 personal_info=false다.\n' +
          "- keywords는 1~3개의 짧은 명사형 (예: \"연차\", \"휴가 신청\")\n" +
          '- 질문에 오타가 있어 보이면 의도한 단어로 고쳐서 키워드를 뽑아라 (예: "휴갸" → "휴가", "밥갑" → "밥값", "식데" → "식대")\n' +
          "- 이전 대화가 주어지면 현재 질문을 그 맥락에서 해석해라 (예: 연차 얘기 중 \"그럼 반차는?\" → 키워드 \"반차\")",
      },
      {
        role: "user",
        content: history ? `[이전 대화]\n${history}\n\n[현재 질문]\n${question}` : question,
      },
    ],
  });

  const raw = res.choices[0]?.message?.content?.trim() ?? "{}";
  try {
    const parsed = JSON.parse(raw);
    const keywords = Array.isArray(parsed.keywords)
      ? parsed.keywords.map(String).filter(Boolean).slice(0, 3)
      : [];
    const personalInfo = parsed.personal_info === true;
    if (parsed.relevant === false) return { relevant: false, keywords: [], personalInfo };
    return { relevant: true, keywords: keywords.length > 0 ? keywords : [question.slice(0, 30)], personalInfo };
  } catch {
    // 파싱 실패 시 질문을 막지 않도록 통과시킴 (fail-open)
    return { relevant: true, keywords: [question.slice(0, 30)], personalInfo: false };
  }
}

const SYSTEM_PROMPT = `너는 '세렝게티 가이드봇'이다. 사내 노션 문서를 근거로 구성원의 질문에 답하는 슬랙 봇이다.

[답변 원칙]
- 반드시 아래에 제공되는 노션 문서 내용만을 근거로 답한다. 문서에 없는 내용은 절대 지어내지 않는다.
- 이전 대화가 주어지면 현재 질문을 그 맥락에서 해석해 이어지는 답변을 한다.
- 답변에 사용한 문서의 노션 링크를 답변 끝에 "📎 참고 문서" 항목으로 붙인다. 실제로 답변 근거로 삼은 문서만 적는다.
- 참고 문서는 문서 제목과 URL을 함께 적는다(예: "📎 참고 문서: 점심 식대 지원 - https://..."). "문서 1", "문서 2" 같은 컨텍스트 번호는 제목 대신 쓰지 않으며, URL을 빠뜨리지 않는다.
- "찾지 못했어요"라고 답하는 경우에는 "📎 참고 문서"를 붙이지 않는다. 근거가 없는데 링크만 붙이면 관련 없는 문서로 안내하는 셈이 된다.

[담당팀 안내 — 문의처를 알려줄 때]
- 문서를 찾았든 못 찾았든, 문의처를 안내할 때는 아래 순서로 담당팀을 정한다.
  1) 근거 문서에 "담당팀:" 줄이 있으면 그 팀을 그대로 쓴다. 이게 가장 우선이다.
  2) 담당팀 표시가 없으면 질문 주제로 판단한다:
     - 인사규정/복리후생 → ${describeTeam("hr")}
     - 근무환경/계약/자산관리 → ${describeTeam("ga")}
     - 재무/회계(${TEAMS.fa.scope}) → ${describeTeam("fa")}
     - 아이디어 제안/건의/불편사항 → ${describeTeam("bamboo")}
- 문서 본문에 일부 팀 태그(@hr_team, @ga_team 등)만 적혀 있더라도, 위 기준으로 정한 담당팀을 우선해 안내한다. 재무·회계 문의를 HR팀이나 GA팀으로 보내지 않는다.
- 담당팀을 지칭할 때는 반드시 위 명칭(HR팀, GA팀, FA팀, 대나무숲)을 그대로 쓴다. "인사팀", "총무팀", "재무팀" 등 다른 이름으로 바꿔 부르지 않으며, 문의 문안의 인사말에도 같은 명칭을 쓴다.

[문서를 찾지 못했거나 문서로 답할 수 없는 경우]
- 솔직하게 "관련 내용을 노션에서 찾지 못했어요"라고 말한 뒤, 위 기준의 담당팀 문의 방법을 안내한다.
- 이어서 바로 복사해 쓸 수 있는 문의 문안을 "✍️ 문의 예시" 항목으로 만들어준다. 문안은 정중하고 간결하게, 질문 내용이 구체적으로 담기게 작성한다.
- 단 하나의 예외: 특정 개인의 개인정보(급여·연봉, 평가, 연락처, 주소, 주민등록번호 등)를 묻는 질문에는 "✍️ 문의 예시"를 절대 만들지 않는다.
  그 사람의 정보를 알려달라는 문안을 대신 써주는 것이기 때문이다. 이 경우 담당 부서에 직접 문의하라는 안내 문장으로만 끝낸다.

[톤앤매너]
- 친절한 존댓말을 쓰되, 간결하게 핵심부터 말한다.
- 슬랙 메시지 형식(mrkdwn)에 맞게 작성한다: 굵게는 *별표 하나*, 목록은 "- " 사용. 마크다운 헤딩(#)은 쓰지 않는다.
- 답변은 대체로 10줄 이내로 유지한다.

[제약사항]
- 회사 생활·사내 제도와 무관한 질문(요리 레시피, 일반 상식, 번역, 코딩 등)에는 답하지 않고, 사내 가이드 관련 질문만 도울 수 있다고 안내한다.
- 특정 개인의 개인정보(연락처, 주소, 주민등록번호, 급여, 평가 등)는 문서에 있더라도 답하지 않고, 해당 정보는 담당 부서에 직접 문의하도록 안내한다.
  이때 "✍️ 문의 예시"는 만들지 않는다. 남의 개인정보를 물어보는 문안을 대신 써주지 않는다. 본인 정보라면 본인이 담당 부서에 직접 문의하도록 안내만 한다.
- 회사 정책에 대한 확정적 해석이 필요한 사안(징계, 법률, 계약 등)은 문서 내용을 전달하되 최종 확인은 담당 부서에 하도록 덧붙인다.`;

/**
 * 노션 문서들을 근거로 답변 생성.
 * @param {string} question
 * @param {Array<{title: string, url: string, content: string, team?: string}>} docs
 * @param {string} history 이전 대화 내용 (없으면 빈 문자열)
 * @param {{personalInfo?: boolean}} options personalInfo=true면 문의 문안을 만들지 않는다
 */
export async function generateAnswer(question, docs, history = "", { personalInfo = false } = {}) {
  const context =
    docs.length > 0
      ? docs
          .map(
            (d, i) =>
              [
                `[문서 ${i + 1}] ${d.title}`,
                `URL: ${d.url}`,
                d.team ? `담당팀: ${describeTeam(d.team)}` : null,
                `내용:\n${d.content || "(본문 없음)"}`,
              ]
                .filter(Boolean)
                .join("\n")
          )
          .join("\n\n---\n\n")
      : "(검색된 문서 없음)";

  const res = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0.3,
    max_tokens: 800,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          (history ? `[이전 대화]\n${history}\n\n` : "") +
          `[노션 검색 결과]\n${context}\n\n[질문]\n${question}` +
          (personalInfo ? `\n\n${PERSONAL_INFO_NOTICE}` : ""),
      },
    ],
  });

  const answer = res.choices[0]?.message?.content?.trim() ?? "답변 생성에 실패했어요. 잠시 후 다시 시도해주세요.";
  // 모델이 지시를 어기고 문안을 만드는 경우가 있어 코드에서 한 번 더 잘라낸다
  return personalInfo ? stripInquiryTemplate(answer) : answer;
}

const PERSONAL_INFO_NOTICE =
  "[주의] 이 질문은 특정 개인의 민감한 개인정보를 알려달라는 질문이다." + "\n" +
  "정보를 알려주지 말고, 담당 부서에 직접 문의하라고만 안내해라." + "\n" +
  '"✍️ 문의 예시"는 절대 만들지 마라. 그 사람의 정보를 알려달라는 문안을 대신 써주는 것이기 때문이다.';

/** 답변에서 "✍️ 문의 예시" 항목을 통째로 제거 (개인정보 질문에 한해 사용) */
export function stripInquiryTemplate(answer) {
  const marker = answer.indexOf("✍️");
  if (marker < 0) return answer;
  // 문의 예시 뒤에 참고 문서 항목이 이어지면 그건 남긴다
  const rest = answer.slice(marker);
  const refs = rest.indexOf("📎");
  return [answer.slice(0, marker).trimEnd(), refs >= 0 ? rest.slice(refs) : ""]
    .filter(Boolean)
    .join("\n\n")
    .trim();
}
