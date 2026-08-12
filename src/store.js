import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
export const LOG_FILE = path.join(DATA_DIR, "logs.jsonl");

/**
 * 이벤트를 로컬 로그 파일(data/logs.jsonl)에 한 줄씩 기록.
 * 질문자 정보는 저장하지 않는다 (익명 로그).
 * 로그 실패가 봇 응답을 막지 않도록 오류는 삼킨다.
 */
export async function logEvent(event) {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await appendFile(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
  } catch (err) {
    console.error("로그 기록 실패:", err.message);
  }
}
