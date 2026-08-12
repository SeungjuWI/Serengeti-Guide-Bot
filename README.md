# 🦁 세렝게티 가이드봇

사내 노션 문서를 검색해서 질문에 답변해주는 슬랙 봇 (MVP).

```
슬랙 질문 → 키워드 추출(OpenAI) → 노션 검색 + 본문 읽기 → 답변 생성(OpenAI) → 스레드 답변 + 출처 링크
```

## 1. 슬랙 앱 설정 (https://api.slack.com/apps)

이미 만들어둔 앱에서 아래 항목을 확인/설정하세요.

1. **Socket Mode** 메뉴 → `Enable Socket Mode` 켜기
2. **Basic Information → App-Level Tokens** → 토큰 생성 (스코프: `connections:write`) → `xapp-...` 토큰 복사
3. **OAuth & Permissions → Bot Token Scopes**에 추가:
   - `app_mentions:read` (멘션 수신)
   - `chat:write` (메시지 전송)
   - `im:history` (DM 수신)
   - `reactions:write` (처리 중 👀 표시)
4. **Event Subscriptions** → 켜고 **Subscribe to bot events**에 추가:
   - `app_mention`
   - `message.im`
5. **Install App** → 워크스페이스에 (재)설치 → `xoxb-...` Bot Token 복사

## 2. 노션 연동 (https://www.notion.so/my-integrations)

1. Integration 생성 → **Internal Integration Secret**(`ntn-...`) 복사
2. 봇이 검색할 노션 **최상위 페이지**에서 `⋯ → 연결(Connections) → 만든 Integration 추가`
   - 하위 페이지까지 자동으로 검색 대상에 포함됩니다.
   - ⚠️ 연결한 페이지만 검색됩니다. 개인정보가 있는 페이지는 연결하지 마세요.

## 3. 실행

```bash
cp .env.example .env   # 토큰 4개 채우기
npm install
npm start
```

슬랙에서 봇을 채널에 초대(`/invite @봇이름`) 후 멘션하거나, 봇에게 DM으로 질문하면 됩니다.

## 비용

- 노션 API: 무료
- OpenAI: 기본 모델 `gpt-4o-mini` 기준 질문당 약 1~3원 수준. `.env`의 `OPENAI_MODEL`로 변경 가능.

## 구조

| 파일 | 역할 |
|---|---|
| `src/app.js` | 슬랙 이벤트 수신/응답 (멘션, DM) |
| `src/notion.js` | 노션 검색 + 페이지 본문 텍스트 추출 |
| `src/llm.js` | 검색 키워드 추출, 답변 생성 (톤앤매너·개인정보 제약 프롬프트) |

## 추후 기능 (백로그)

- [ ] 문의 예시 텍스트 생성
- [ ] 담당자 슬랙 태그
- [ ] 문서 오류 수정 요청 → HR팀 전달 → 원클릭 수정
