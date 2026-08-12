import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

/**
 * 질문에서 노션 검색용 키워드를 추출.
 * 노션 Search API는 문장 검색에 약해서, 짧은 키워드 2~3개로 나눠 검색한다.
 * @returns {Promise<string[]>}
 */
export async function extractSearchKeywords(question) {
  const res = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0,
    max_tokens: 100,
    messages: [
      {
        role: "system",
        content:
          "사용자의 질문에서 사내 노션 문서를 검색하기 위한 핵심 키워드를 추출해라. " +
          '1~3개의 짧은 명사형 키워드를 JSON 배열로만 답해라. 예: ["연차", "휴가 신청"]',
      },
      { role: "user", content: question },
    ],
  });

  const raw = res.choices[0]?.message?.content?.trim() ?? "[]";
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    const keywords = JSON.parse(match ? match[0] : raw);
    if (Array.isArray(keywords) && keywords.length > 0) {
      return keywords.map(String).slice(0, 3);
    }
  } catch {
    // 파싱 실패 시 아래 폴백 사용
  }
  return [question.slice(0, 30)];
}

const SYSTEM_PROMPT = `너는 '세렝게티 가이드봇'이다. 사내 노션 문서를 근거로 구성원의 질문에 답하는 슬랙 봇이다.

[답변 원칙]
- 반드시 아래에 제공되는 노션 문서 내용만을 근거로 답한다. 문서에 없는 내용은 절대 지어내지 않는다.
- 근거가 부족하면 솔직하게 "관련 내용을 노션에서 찾지 못했어요"라고 말하고, 담당 부서(예: HR팀)에 문의하도록 안내한다.
- 답변에 사용한 문서의 노션 링크를 답변 끝에 "📎 참고 문서" 항목으로 붙인다.

[톤앤매너]
- 친절한 존댓말을 쓰되, 간결하게 핵심부터 말한다.
- 슬랙 메시지 형식(mrkdwn)에 맞게 작성한다: 굵게는 *별표 하나*, 목록은 "- " 사용. 마크다운 헤딩(#)은 쓰지 않는다.
- 답변은 대체로 10줄 이내로 유지한다.

[제약사항]
- 특정 개인의 개인정보(연락처, 주소, 주민등록번호, 급여, 평가 등)는 문서에 있더라도 답하지 않고, 해당 정보는 담당 부서에 직접 문의하도록 안내한다.
- 회사 정책에 대한 확정적 해석이 필요한 사안(징계, 법률, 계약 등)은 문서 내용을 전달하되 최종 확인은 담당 부서에 하도록 덧붙인다.`;

/**
 * 노션 문서들을 근거로 답변 생성.
 * @param {string} question
 * @param {Array<{title: string, url: string, content: string}>} docs
 */
export async function generateAnswer(question, docs) {
  const context =
    docs.length > 0
      ? docs
          .map(
            (d, i) =>
              `[문서 ${i + 1}] ${d.title}\nURL: ${d.url}\n내용:\n${d.content || "(본문 없음)"}`
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
        content: `[노션 검색 결과]\n${context}\n\n[질문]\n${question}`,
      },
    ],
  });

  return res.choices[0]?.message?.content?.trim() ?? "답변 생성에 실패했어요. 잠시 후 다시 시도해주세요.";
}
