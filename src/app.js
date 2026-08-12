import "dotenv/config";
import bolt from "@slack/bolt";
import { searchNotionPages } from "./notion.js";
import { extractSearchKeywords, generateAnswer } from "./llm.js";

const { App } = bolt;

for (const key of ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "NOTION_API_KEY", "OPENAI_API_KEY"]) {
  if (!process.env[key]) {
    console.error(`환경변수 ${key}가 설정되지 않았습니다. .env 파일을 확인해주세요.`);
    process.exit(1);
  }
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

/** 질문 → 키워드 추출 → 노션 검색 → 답변 생성 */
async function answerQuestion(question) {
  const keywords = await extractSearchKeywords(question);
  console.log(`질문: "${question}" / 검색 키워드: ${keywords.join(", ")}`);

  const docs = await searchNotionPages(keywords);
  console.log(`검색된 문서 ${docs.length}건: ${docs.map((d) => d.title).join(", ") || "없음"}`);

  return generateAnswer(question, docs);
}

/** 멘션/DM 공통 처리 */
async function handleQuestion({ text, channel, ts, client }) {
  const question = text.replace(/<@[^>]+>/g, "").trim();

  if (!question) {
    await client.chat.postMessage({
      channel,
      thread_ts: ts,
      text: "안녕하세요, 세렝게티 가이드봇이에요! 궁금한 내용을 질문해주시면 노션 문서를 찾아 답변드릴게요. 🦁",
    });
    return;
  }

  // 처리 중임을 표시
  await client.reactions.add({ channel, timestamp: ts, name: "eyes" }).catch(() => {});

  try {
    const answer = await answerQuestion(question);
    await client.chat.postMessage({ channel, thread_ts: ts, text: answer });
  } catch (err) {
    console.error("답변 처리 중 오류:", err);
    await client.chat.postMessage({
      channel,
      thread_ts: ts,
      text: "죄송해요, 답변을 만드는 중에 오류가 발생했어요. 잠시 후 다시 시도해주세요. 🙏",
    });
  } finally {
    await client.reactions.remove({ channel, timestamp: ts, name: "eyes" }).catch(() => {});
  }
}

// 채널에서 @세렝게티가이드봇 멘션
app.event("app_mention", async ({ event, client }) => {
  await handleQuestion({ text: event.text, channel: event.channel, ts: event.ts, client });
});

// 봇과의 1:1 DM
app.message(async ({ message, client }) => {
  if (message.channel_type !== "im") return;
  if (message.subtype || message.bot_id) return; // 봇/시스템 메시지 무시
  await handleQuestion({ text: message.text ?? "", channel: message.channel, ts: message.ts, client });
});

await app.start();
console.log("⚡ 세렝게티 가이드봇이 실행됐어요 (Socket Mode)");
