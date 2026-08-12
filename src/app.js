import "dotenv/config";
import bolt from "@slack/bolt";
import { searchNotionPages } from "./notion.js";
import { analyzeQuestion, generateAnswer } from "./llm.js";
import { logEvent } from "./store.js";

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

const OFF_TOPIC_REPLY =
  "저는 노션 *세렝게티 생활 가이드*를 기반으로 회사 생활 관련 질문에 답하는 봇이에요. 🦁\n" +
  "인사규정, 휴가, 복리후생, 회의실 예약, 근무환경 같은 질문을 해주세요!";

/** 질문 → 분류·키워드 추출 → 노션 검색 → 답변 생성 */
async function answerQuestion(question, history = "") {
  const { relevant, keywords } = await analyzeQuestion(question, history);

  if (!relevant) {
    console.log(`질문: "${question}" / 사내 가이드와 무관 → 차단`);
    await logEvent({ type: "question", question, outcome: "blocked" });
    return { text: OFF_TOPIC_REPLY, withFeedback: false, docTitles: [] };
  }
  console.log(`질문: "${question}" / 검색 키워드: ${keywords.join(", ")}`);

  const docs = await searchNotionPages(keywords);
  console.log(`검색된 문서 ${docs.length}건: ${docs.map((d) => d.title).join(", ") || "없음"}`);

  const answer = await generateAnswer(question, docs, history);
  await logEvent({
    type: "question",
    question,
    outcome: docs.length > 0 ? "answered" : "no_docs",
    keywords,
    docs: docs.map((d) => d.title),
  });
  return { text: answer, withFeedback: true, docTitles: docs.map((d) => d.title) };
}

/**
 * 이어지는 대화의 문맥을 읽어온다.
 * 스레드 안 질문이면 스레드 이전 메시지, DM이면 최근 대화 몇 개.
 * 실패해도 문맥 없이 진행 (채널 스레드는 channels:history 스코프가 없으면 실패할 수 있음).
 */
async function getConversationContext({ client, channel, ts, threadTs, isDm }) {
  try {
    let messages = [];
    if (threadTs && threadTs !== ts) {
      const res = await client.conversations.replies({ channel, ts: threadTs, limit: 12 });
      messages = res.messages ?? [];
    } else if (isDm) {
      const res = await client.conversations.history({ channel, limit: 7 });
      messages = (res.messages ?? []).reverse(); // history는 최신순이라 뒤집음
    } else {
      return "";
    }

    return messages
      .filter((m) => m.ts !== ts && m.text && !m.subtype)
      .slice(-6)
      .map((m) => {
        const who = m.bot_id ? "봇" : "질문자";
        const text = m.text.replace(/<@[^>]+>/g, "").trim().slice(0, 300);
        return `${who}: ${text}`;
      })
      .join("\n");
  } catch (err) {
    console.log("대화 문맥 읽기 생략:", err.message);
    return "";
  }
}

/** 답변 메시지에 붙는 피드백/오류 신고 버튼 */
function feedbackBlocks(answerText, question, docTitles = []) {
  const value = JSON.stringify({ q: question.slice(0, 300), docs: docTitles.slice(0, 3) });
  const button = (label, actionId) => ({
    type: "button",
    text: { type: "plain_text", text: label },
    action_id: actionId,
    value,
  });
  return [
    { type: "section", text: { type: "mrkdwn", text: answerText.slice(0, 2900) } },
    {
      type: "actions",
      block_id: "feedback",
      elements: [
        button("👍 도움됐어요", "feedback_up"),
        button("👎 아쉬워요", "feedback_down"),
        button("🚨 문서 오류 신고", "report_error"),
      ],
    },
  ];
}

/** 멘션/DM 공통 처리 */
async function handleQuestion({ text, channel, ts, threadTs, isDm, client }) {
  const question = text.replace(/<@[^>]+>/g, "").trim();
  const replyTs = threadTs ?? ts; // 스레드 안 질문이면 그 스레드에 이어서 답변

  if (!question) {
    await client.chat.postMessage({
      channel,
      thread_ts: replyTs,
      text: "안녕하세요, 세렝게티 가이드봇이에요! 궁금한 내용을 질문해주시면 노션 문서를 찾아 답변드릴게요. 🦁",
    });
    return;
  }

  // "찾아보는 중" 메시지를 먼저 띄우고, 답변이 완성되면 그 메시지를 교체
  const placeholder = await client.chat.postMessage({
    channel,
    thread_ts: replyTs,
    text: "🔍 노션 문서를 찾아보는 중이에요...",
  });

  try {
    const history = await getConversationContext({ client, channel, ts, threadTs, isDm });
    const answer = await answerQuestion(question, history);
    await client.chat.update({
      channel,
      ts: placeholder.ts,
      text: answer.text,
      ...(answer.withFeedback ? { blocks: feedbackBlocks(answer.text, question, answer.docTitles) } : {}),
    });
  } catch (err) {
    console.error("답변 처리 중 오류:", err);
    await client.chat.update({
      channel,
      ts: placeholder.ts,
      text: "죄송해요, 답변을 만드는 중에 오류가 발생했어요. 잠시 후 다시 시도해주세요. 🙏",
    });
  }
}

// 채널에서 @세렝게티가이드봇 멘션
app.event("app_mention", async ({ event, client }) => {
  await handleQuestion({
    text: event.text,
    channel: event.channel,
    ts: event.ts,
    threadTs: event.thread_ts,
    isDm: false,
    client,
  });
});

// 봇과의 1:1 DM
app.message(async ({ message, client }) => {
  if (message.channel_type !== "im") return;
  if (message.subtype || message.bot_id) return; // 봇/시스템 메시지 무시
  await handleQuestion({
    text: message.text ?? "",
    channel: message.channel,
    ts: message.ts,
    threadTs: message.thread_ts,
    isDm: true,
    client,
  });
});

/** 버튼 value(JSON)에서 질문/문서 정보 복원 */
function parseButtonValue(value) {
  try {
    const parsed = JSON.parse(value);
    return { question: parsed.q ?? "", docs: parsed.docs ?? [] };
  } catch {
    return { question: value ?? "", docs: [] };
  }
}

/** 버튼 영역을 안내 문구로 교체 */
async function replaceButtons({ body, client, notice }) {
  const original = body.message?.blocks?.filter((b) => b.type !== "actions") ?? [];
  await client.chat
    .update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: body.message.text,
      blocks: [...original, { type: "context", elements: [{ type: "mrkdwn", text: notice }] }],
    })
    .catch((err) => console.error("버튼 메시지 갱신 실패:", err.message));
}

app.action("feedback_up", async ({ ack, body, action, client }) => {
  await ack();
  const { question } = parseButtonValue(action.value);
  await logEvent({ type: "feedback", vote: "up", question });
  await replaceButtons({ body, client, notice: "🙏 피드백 감사해요! (👍 도움됐어요)" });
});

app.action("feedback_down", async ({ ack, body, action, client }) => {
  await ack();
  const { question } = parseButtonValue(action.value);
  await logEvent({ type: "feedback", vote: "down", question });
  await replaceButtons({ body, client, notice: "🙏 피드백 감사해요! (👎 아쉬워요) — 답변 개선에 참고할게요." });
});

// 문서 오류 신고: 로그에 기록하고, 설정된 채널이 있으면 HR/GA에 알림
app.action("report_error", async ({ ack, body, action, client }) => {
  await ack();
  const { question, docs } = parseButtonValue(action.value);
  await logEvent({ type: "error_report", question, docs });

  const reportChannel = process.env.ERROR_REPORT_CHANNEL;
  if (reportChannel) {
    const permalink = await client.chat
      .getPermalink({ channel: body.channel.id, message_ts: body.message.ts })
      .then((r) => r.permalink)
      .catch(() => null);

    await client.chat
      .postMessage({
        channel: reportChannel,
        text:
          "🚨 *가이드봇 문서 오류 신고가 접수됐어요.*\n" +
          `- 질문: ${question || "(알 수 없음)"}\n` +
          `- 참고했던 문서: ${docs.join(", ") || "없음"}\n` +
          (permalink ? `- 해당 답변: ${permalink}` : ""),
      })
      .catch((err) => console.error("오류 신고 채널 전송 실패:", err.message));
  }

  await replaceButtons({
    body,
    client,
    notice: reportChannel
      ? "🚨 신고 접수! 담당팀에 전달됐어요. 감사합니다."
      : "🚨 신고가 기록됐어요. 감사합니다.",
  });
});

// App Home 탭: 봇 소개 및 사용법
app.event("app_home_opened", async ({ event, client }) => {
  if (event.tab !== "home") return;
  await client.views
    .publish({
      user_id: event.user,
      view: {
        type: "home",
        blocks: [
          {
            type: "header",
            text: { type: "plain_text", text: "🦁 세렝게티 가이드봇" },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text:
                "노션 *세렝게티 생활 가이드*를 검색해서 회사 생활 관련 질문에 답해드려요.\n" +
                "인사규정, 휴가, 복리후생, 회의실/장비 예약, 근무환경 등을 물어보세요!",
            },
          },
          { type: "divider" },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text:
                "*사용 방법*\n" +
                "• *DM*: 왼쪽 메시지 탭에서 바로 질문을 보내주세요\n" +
                "• *채널*: `@Serengeti Guide Bot 질문내용` 으로 멘션해주세요\n" +
                "• 답변 스레드에서 이어서 질문하면 맥락을 이해하고 답해드려요",
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text:
                "*이런 질문을 할 수 있어요*\n" +
                "• 연차 휴가 신청 어떻게 해?\n" +
                "• 회의실 예약은 어디서 해?\n" +
                "• 경조사 지원 제도 알려줘",
            },
          },
          { type: "divider" },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text:
                  "답변이 도움됐다면 👍, 아쉬웠다면 👎를 눌러주세요 — 봇 개선에 큰 도움이 돼요.\n" +
                  "문서 내용이 잘못됐다면 🚨 버튼으로 신고해주세요. 답을 못 찾은 질문은 담당팀 문의 방법을 안내해드려요.",
              },
            ],
          },
        ],
      },
    })
    .catch((err) => console.error("App Home 게시 실패:", err.message));
});

await app.start();
console.log("⚡ 세렝게티 가이드봇이 실행됐어요 (Socket Mode)");
