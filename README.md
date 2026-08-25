# 🦁 세렝게티 가이드봇

사내 노션 문서를 검색해서 질문에 답변해주는 슬랙 봇 (MVP).

```
슬랙 질문 → 질문 분류(OpenAI) → 의미 기반 검색(임베딩 인덱스) → 본문 읽기 → 답변 생성(OpenAI) → 스레드 답변 + 출처 링크
```

**루트 페이지**([세렝게티 생활 가이드](https://app.notion.com/p/aed88b212dfb4833a1ed2067370f4c41))와 그 하위 페이지 전체를 미리 읽어 만든
**검색 인덱스**(`data/index.json`)에서 질문과 의미가 가까운 문서를 찾습니다.
단어가 달라도(예: "밥값" → "점심 식대 지원") 문서를 찾을 수 있습니다. 인덱스가 없으면 노션 키워드 검색으로 동작합니다.

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
2. 봇이 검색할 노션 **루트 페이지**에서 `⋯ → 연결(Connections) → 만든 Integration 추가`
   - 루트 페이지 아래의 하위 페이지·하위 DB의 각 행까지 따라 들어가며 검색 대상이 됩니다.
   - 본문에 걸린 링크(페이지 링크 블록, @멘션, 텍스트 링크)도 따라가서 인덱싱합니다.
     따라가는 단계 수는 `.env`의 `NOTION_LINK_FOLLOW_DEPTH`로 조절합니다 (기본 2, `0`이면 링크는 안 따라가고 하위 트리만).
   - 링크로 이어진 문서도 Integration에 연결돼 있어야 읽을 수 있습니다. 연결 안 된 링크는 조용히 건너뜁니다.
   - 루트를 바꾸려면 `.env`의 `NOTION_ROOT_PAGE_ID`를 설정하세요 (기본값은 `src/notion.js`에 지정).
   - 특정 페이지만 빼려면 `NOTION_EXCLUDED_PAGE_IDS`에 쉼표로 나열하세요.
   - ⚠️ 연결한 페이지만 읽을 수 있습니다. 개인정보가 있는 페이지는 연결하지 마세요.

## 3. 실행

```bash
cp .env.example .env   # 토큰 4개 채우기
npm install
npm run index          # 검색 인덱스 최초 구축 (10~20분, 최초 1회)
npm start
```

슬랙에서 봇을 채널에 초대(`/invite @봇이름`) 후 멘션하거나, 봇에게 DM으로 질문하면 됩니다.

- 코드를 수정한 뒤에는 실행 중인 봇을 `Ctrl+C`로 끄고 다시 `npm start` 해야 반영됩니다.
- 인덱스는 봇 실행 중 24시간마다 자동 갱신됩니다(변경된 페이지만 다시 읽어 수 분 내 완료).
  주기는 `.env`의 `INDEX_REFRESH_HOURS`로 조절, `0`이면 끔. `npm run index`로 수동 갱신도 가능합니다.
- 노션에 문서를 새로 만들었는데 봇이 못 찾으면 `npm run index`를 한 번 돌려주세요.

## 비용

- 노션 API: 무료
- OpenAI: 기본 모델 `gpt-4o-mini` 기준 질문당 약 1~3원 수준. `.env`의 `OPENAI_MODEL`로 변경 가능.
- 인덱스 구축(임베딩): 전체 문서 기준 수십 원 수준, 갱신 시엔 변경분만이라 사실상 무료.

## 구조

| 파일 | 역할 |
|---|---|
| `src/app.js` | 슬랙 이벤트 수신/응답 (멘션, DM) |
| `src/notion.js` | 노션 검색 + 페이지 본문 텍스트 추출 |
| `src/search.js` | 임베딩 검색 인덱스 구축/검색/자동 갱신 |
| `src/llm.js` | 검색 키워드 추출, 임베딩, 답변 생성 (톤앤매너·개인정보 제약 프롬프트) |
| `src/teams.js` | 문서 → 담당팀(HR/GA/FA/대나무숲) 매핑 |

## 담당팀 안내

문의처 안내는 **문서가 어느 영역에서 나왔는지**로 정해집니다. 인덱스를 만들 때 각 문서에 소관 팀이 함께 저장되고,
답변할 때 그 팀으로 안내합니다. 문서를 못 찾았을 때만 질문 주제로 판단합니다.

| 영역 (노션 상위 DB) | 담당팀 | 태그 |
|---|---|---|
| 인사규정 / 복리후생 | HR팀 | `#co_operations` 에서 `@hr_team` |
| 근무환경 / 계약, 자산관리 | GA팀 | `#co_operations` 에서 `@ga_team` |
| 재무회계 가이드 | FA팀 | `#co_operations` 에서 `@fa_team` |
| 아이디어 제안 / 건의 / 불편사항 | 대나무숲 | `#co_operations` 에서 `@likelion_bamboo` |

매핑은 `src/teams.js`에 있습니다. 노션에서 영역 DB를 새로 만들거나 옮기면 그 DB의 ID를 여기에 추가하세요
(`.env`의 `NOTION_TEAM_CONTAINERS=fa:DB아이디,hr:페이지아이디` 로도 추가 가능).

## 추후 기능 (백로그)

- [ ] 문의 예시 텍스트 생성
- [ ] 담당자 슬랙 태그
- [ ] 문서 오류 수정 요청 → HR팀 전달 → 원클릭 수정
