# 친구 및 현재 시즌 포트폴리오 공유 구현·검증 보고서

기준: 실제 로컬 HEAD `f98d6b5efdf39e7f56af96b39ee5ce7584aa95e0`.
작업 시작 시 worktree는 clean이었다. 로컬 구현 및 검증을 완료했으며 운영 DB 적용,
배포, commit은 수행하지 않았다.

## 1. 구현 요약

사용자 요구 1–12를 구현했다. 일반/시즌 계정의 다섯 번째 탭은 `전체`와 3줄 SVG
메뉴 아이콘이다. 전체에서 MY·친구·공지사항·설정으로 진입한다. MY의 기존 정보,
보상, 로그아웃은 유지하고 설정 메뉴만 이동했다. 친구 요청/수락/거절/목록/삭제,
친구 랭킹, 현재 시즌 포트폴리오 공유, 사용자별 공개 설정을 연결했다.

## 2. 실제 기존 구조 조사 결과

Root/backend AGENTS, backend rulepack, API 계약, Prisma migration, navigation,
query key, ranking writer/read model, Records/Portfolio/Position 및 공개 사용자
조회 경로를 실제 로컬 저장소에서 조사했다.

대부분의 초기 가설은 맞았다. 추가로 확인된 사항은 다음과 같다.

- `near_me`는 RankingScreen뿐 아니라 MY와 SeasonAccountHome의 `myRanking` 조회에
  쓰였다. 두 호출자를 `all&limit=1`로 먼저 이전했다.
- 공개 `/users/:userId/season-summary`뿐 아니라
  `/users/:userId/records/:seasonId`에도 allocation/holdings 공개 경로가 있었다.
- 기존 summary의 비중 계산은 저장된 `Position.marketValueKrw`와 실시간 valuation
  총액을 혼합했다. canonical valuation이 이미 계산한 종목별 금액을 반환하도록
  projection만 추가해 같은 평가 기준으로 비중을 표시했다.
- 기존 공지 API/DB는 없었다. 독립 공지 화면과 정상 empty state만 구현했다.

별도의 SNS 계층, portfolio 계산 엔진, settings framework 없이 Friendship 모델,
User Boolean, 기존 Ranking/Records 계층을 사용했다. MyTab/MyStack 내부 이름도
유지하여 기존 navigation과 계정별 탭 순서에 대한 변경을 줄였다.

## 3. DB 변경

`20260929120000_friends_portfolio_privacy`는 additive migration이다.

- `users.portfolio_public BOOLEAN NOT NULL DEFAULT true`.
- `friendships`: 정렬한 사용자 쌍, requester, pending/accepted, createdAt.
- 정렬 쌍 UNIQUE, `low < high` CHECK, requester가 쌍의 구성원이라는 CHECK.
- 두 사용자 FK 및 양쪽 조회용 `(user, status, created_at, id)` index.
- 기존 사용자와 신규 사용자 모두 true가 되는 것을 실제 migration SQL로 검증했다.
- 금융 테이블 변경, 금융 데이터 backfill/recalculate, 기존 자산 변경은 없다.

Prisma 생성물은 재생성했으며 두 번째 generate의 파일 hash가 동일했다.
`Asset.ts`의 Boolean update helper 이동은 generator가 User에 같은 공통 타입을
배치한 결과다. DB와 schema의 migrate diff는 차이가 없었다.

## 4. Backend 변경

인증 및 active-user guard 아래 `/api/v1/friends`를 추가했다.
검색은 대소문자를 구분하지 않는 닉네임 prefix 검색이며 입력은 literal로 처리한다.
검색/목록/받은 요청은 offset pagination과 batch 관계 조회를 사용한다.
GET/PATCH `/me`는 `portfolioPublic`을 포함하고 실제 Boolean만 받는다.
기존 nickname/profileImageUrl 계약은 유지한다.

현재 시즌 summary는 공개 competition 정보와 nullable `portfolio`를 구분한다.
portfolio에는 합산 현금/자산군 금액, 종목 이름·symbol·asset type·비중,
최근 30일의 실제 DailyPortfolioSnapshot만 포함한다. 없는 날짜는 생성하지 않는다.
가격/환율 unavailable이면 allocation/weight는 null이고 명확한 상태를 반환한다.
구조적 계정 오류는 empty portfolio로 감추지 않는다.

## 5. Frontend 변경

- 전체/MY/친구/공지사항/설정 navigation과 기존 SVG menu icon을 연결했다.
- 친구 목록·받은 요청·검색 탭, 요청 상태와 action, 삭제 확인, pagination을 추가했다.
- 친구 선택과 랭킹 선택은 동일한 현재 시즌 summary 화면을 사용한다.
- 공개 시 profile/성과/배분/종목/일별 추이를, 비공개·비친구·미참가 등은 구분된
  상태 문구를 표시한다. 재조회 중에는 이전 sensitive section을 표시하지 않는다.
- 설정은 서버 응답 Boolean을 표시하며 PATCH 성공 값으로 `/me` cache를 갱신한다.
- 관계 변경 시 친구 관련 key만 invalidate하고, accept/remove에서는 해당 사용자
  summary 및 friends ranking을 reset한다. all ranking/타 계정 cache는 유지한다.
- ScrollView/FlatList, wrap/flexShrink와 기존 ActionPressable을 사용했다.
  새 UI/icon library나 dependency를 추가하지 않았다.

## 6. 친구 관계 정책

자기 요청은 400, 같은/반대 방향 중복은 409다. 동시에 요청해도 UNIQUE가 하나만
허용한다. pending은 권한이 없다. accept/reject는 pending 요청의 수신자만 가능하며,
조건부 updateMany/deleteMany로 추측한 ID나 race를 통한 타 관계 변경을 막는다.
accepted 삭제는 양쪽 구성원 모두 가능하다. inactive 사용자는 검색·신규 요청·수락·
친구 랭킹에서 제외한다. 기존 inactive 친구는 목록에서 상태를 표시하고 삭제할 수 있다.
친구 API에 email, 내부 계정 정보는 포함하지 않는다.

## 7. 포트폴리오 privacy 정책

기본 공개=true는 사용자 단위 PostgreSQL 설정이다. 공개의 의미는 친구에게 공개이며
인증, accepted 관계, target active/public, 현재 active 시즌 참가 및 유효 시즌 계정이
필요하다. hidden/excluded 정책도 적용한다.

각 요청에서 DB의 최신 설정/관계를 조회하고 financial read 이후 응답 직전에도
재검증한다. 비공개 전환/친구 삭제 후 다음 조회는 payload=null이다.
`available / private / not_friend / unavailable`와 미참가/시즌 없음 등의 reason을
분리했다. 현재 사용자 본인의 포트폴리오는 기존 owner API를 그대로 사용한다.

종목 수량·평균 매수가·개별 수익률, 정확한 주문/체결/환전/원장/통화별 Wallet 잔액,
주문 ID/idempotency/internal TradingAccountId는 친구 payload에 포함하지 않는다.

## 8. 랭킹 변경

`all / friends / top10`이며 friends는 Backend의 기존 read transaction에서 accepted
active friend 조건을 추가한다. pagination 전에 필터링하고 count한다. 기존 global
rank가 그대로 남는다(실제 DB 검증에서 #8/#37). percentile/tier의 분모, myRanking,
all/TOP10, daily/final, capturedAt, hidden/excluded, snapshot consistency를 유지한다.
writer/settlement/rank ordering 계산은 변경하지 않았다.

production의 `near_me` 참조는 없다. 남은 문자열은 폐기 scope를 거절하는 테스트와
과거 조사 기록이다. friends empty state에 친구 찾기 CTA가 있다.

## 9. 기존 공개 경로와 우회 처리

`/users/:userId/season-summary`는 Backend permission gate를 거친 portfolio만
반환한다. `/users/:userId/records/:seasonId`는 기존 공개 경쟁 summary를 유지하되
portfolio는 항상 null로 제한하고 현재 시즌 summary 경로를 안내한다.
과거 시즌/일반 계정 친구 portfolio 선택 기능을 만들지 않았다.

Ranking 및 다른 사용자 Records 응답도 검토했다. 기존 owner 전용 Portfolio,
Position, trading-account 경로는 인증 user/account ownership 검증을 유지한다.
권한 없는 호출에서 portfolio 데이터를 내려준 후 화면만 숨기는 경로는 남기지 않았다.

## 10. 테스트 및 실행 결과

| 검사 | 결과 |
| --- | --- |
| Prisma format / validate / generate | PASS; unrelated schema formatting은 보존 |
| 격리 PostgreSQL migration deploy / schema diff | PASS; No difference |
| Backend 전체 기본 test | 206 suites, 3,066 tests PASS; opt-in 45 suites/49 tests skip |
| Backend e2e | 341 tests PASS |
| Friends PostgreSQL + 실제 Nest HTTP/guard | 86 assertions 및 HTTP status checks PASS |
| Ranking consistency / ranking account scope DB | 2 suites PASS |
| Friends / Auth DB opt-in | 2 suites PASS |
| Frontend `npm run check` | lint accounts/guides + typecheck + 1,211 tests PASS |
| 추가 변경 product 파일 ESLint / Prettier | PASS |
| Backend typecheck / build | PASS |
| Frontend Expo web export | PASS |
| 실제 RN Web 화면 브라우저 검사 | 30 layout 조합 PASS; toggle/private/not_friend PASS |
| `git diff --check` | PASS |

DB는 작업용 PostgreSQL 16을 `/tmp`에 격리해 실행했다. 기존 사용자의 개발/운영 DB에
migration을 적용하거나 데이터를 변경하지 않았다. DB 테스트는 fixture ID만 정리한다.
브라우저 테스트는 외부 요청을 차단하고 test-only transport를 사용한다.

재현 명령(각 주석에 표시한 디렉터리 기준, `DATABASE_URL`은 반드시 격리 test DB로 지정):

```bash
# backend cwd에서 실행
pnpm exec prisma format
pnpm exec prisma validate
pnpm exec prisma generate
pnpm run test:db:prepare
pnpm exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
pnpm test --runInBand
pnpm test:e2e --runInBand
FRIENDS_DB_INTEGRATION=1 AUTH_DB_SMOKE=1 NODE_ENV=test pnpm test --runInBand --runTestsByPath src/friends/friends.integration.spec.ts src/auth/auth.integration.spec.ts
TRADING_ACCOUNT_DB_INTEGRATION=1 NODE_ENV=test pnpm test --runInBand --runTestsByPath src/ranking/ranking-consistency.integration.spec.ts src/ranking/season-ranking-scope.integration.spec.ts
FRIENDS_DB_INTEGRATION=1 NODE_ENV=test pnpm exec tsx scripts/friends-integration.ts
pnpm run typecheck
pnpm run build
pnpm exec eslint --no-fix --max-warnings=0 src/friends src/auth/auth.service.ts src/auth/auth.types.ts src/ranking/ranking.service.ts src/records/records.service.ts src/portfolio/portfolio-valuation.policy.ts
pnpm exec prettier --check src/friends src/auth/auth.service.ts src/auth/auth.types.ts src/ranking/ranking.service.ts src/records/records.service.ts src/portfolio/portfolio-valuation.policy.ts scripts/friends-integration.ts scripts/ranking-consistency-integration.ts

# frontend cwd에서 실행
npm run check
npm run export:web
NODE_PATH=/path/to/browser-tools/node_modules node test/browser/friendsBrowser.cjs

# root
git diff --check
```

브라우저 도구 설치 및 실행 방법은 `frontend/test/browser/README.md`에 있다.
이 환경에서는 `/tmp/friends-browser-tools`의 esbuild/playwright와 로컬 Chromium을
사용했다. WSL에 없는 시스템 라이브러리/한글 font는 `/tmp/friends-browser-libs`에
격리했고 `LD_LIBRARY_PATH`/`FONTCONFIG_FILE`을 지정했다.

실행 로그는 `/tmp/friends-{backend-all,backend-e2e,frontend-check,integration,
ranking-db,auth-db,browser,frontend-export}.log`에 있다. 브라우저 evidence는 이
보고서 옆 `browser-validation.json`과 `/tmp/trading-friends-browser/*-320-scale2.png`다.

## 11. 실행하지 못한 검증과 이유

친구·Auth·랭킹 검증을 위해 선택한 DB integration 4 suites는 환경을 준비하여 모두 실행했다.
Android/iOS 실기기·에뮬레이터, 실제 계정 두 개의 운영 서버 왕복은 이 환경에서 실행하지
않았다. RN Web fontScale 검증을 네이티브 text measurement 검증으로 간주하지 않는다.
기본 test에서 opt-in으로 skip된 전체 45 suites를 모두 활성화한 것은 아니며, 위의
친구·Auth·Ranking 관련 suite만 별도로 실행했다. 이번 변경과 무관한 provider/Redis 등
모든 통합 환경을 준비한 전체 CI 실행은 수행하지 않았다.

저장소 전체의 ungated lint/format baseline 정리는 하지 않았다. 필수 Frontend gate와
변경 product 파일 검사 결과를 보고하며 기존 debt를 신규 실패로 집계하지 않는다.

## 12. 회귀 위험 검토

금융 write path, financial schema, ranking writer, logout teardown은 변경하지 않았다.
valuation은 기존 계산 결과 projection만 추가했다. 친구 처리 전후 금융 행/랭킹/
snapshot의 동일성을 DB 테스트로 확인했다. 기존 Auth DB smoke 및 전체 unit/e2e와
Frontend tests가 통과했다. 내 순위는 선택된 season/rankType을 유지한 all limit=1
호출을 검증했다. 일반 Guide/시즌 Ranking 및 탭 safe-area 구성은 유지했다.

출시 시 migration → Backend/Frontend의 일치하는 계약 배포가 필요하다.
구버전 클라이언트의 near_me/기존 flat portfolio 응답 계약을 위한 shim은 만들지 않았다.
권한 차단을 위해 기존 공개 portfolio payload를 제거했으므로 오래된 앱 버전은
업데이트가 필요하다. 과거 portfolio가 이미 다른 기기에 수신된 경우 이를 소급 삭제하는
기능은 없으며, 다음 조회에서 차단하는 정책을 구현했다.

## 13. git diff 자체 검토 결과

전체 tracked diff와 새 파일을 검토했다. generated 파일은 schema 기반 재생성 결과와
동일하다. 금융 계산식/금융 write/금융 schema 변경, 무관한 refactor, 대량 formatting,
production mock data, debug log, TODO, 임시 우회, secret, `/api/v2`는 추가하지 않았다.
테스트용 데이터/키/로그는 test 및 integration script에만 있다. 의도적으로 제거된
코드는 공개 portfolio 우회 builder와 retired near_me window다.

## 14. 변경 파일 목록

아래는 생성된 Prisma 파일, 테스트, 문서를 포함한 실제 worktree 변경 파일 전체다.

- `.github/workflows/ci.yml`
- `backend/docs/README.md`
- `backend/docs/auth-api-contract.md`
- `backend/docs/friends-api-contract.md`
- `backend/docs/ranking-api-contract.md`
- `backend/docs/ranking-consistency-fix.md`
- `backend/docs/records-api-contract.md`
- `backend/docs/trading-modes-and-accounts.md`
- `backend/prisma/migrations/20260929120000_friends_portfolio_privacy/migration.sql`
- `backend/prisma/schema.prisma`
- `backend/scripts/friends-integration.ts`
- `backend/scripts/ranking-consistency-integration.ts`
- `backend/src/app.module.ts`
- `backend/src/auth/auth.service.spec.ts`
- `backend/src/auth/auth.service.ts`
- `backend/src/auth/auth.types.ts`
- `backend/src/friends/friend-portfolio.types.ts`
- `backend/src/friends/friends.controller.ts`
- `backend/src/friends/friends.integration.spec.ts`
- `backend/src/friends/friends.module.ts`
- `backend/src/friends/friends.service.ts`
- `backend/src/friends/friendship.policy.ts`
- `backend/src/generated/prisma/browser.ts`
- `backend/src/generated/prisma/client.ts`
- `backend/src/generated/prisma/commonInputTypes.ts`
- `backend/src/generated/prisma/enums.ts`
- `backend/src/generated/prisma/internal/class.ts`
- `backend/src/generated/prisma/internal/prismaNamespace.ts`
- `backend/src/generated/prisma/internal/prismaNamespaceBrowser.ts`
- `backend/src/generated/prisma/models.ts`
- `backend/src/generated/prisma/models/Asset.ts`
- `backend/src/generated/prisma/models/Friendship.ts`
- `backend/src/generated/prisma/models/User.ts`
- `backend/src/portfolio/portfolio-valuation.policy.ts`
- `backend/src/ranking/ranking.service.spec.ts`
- `backend/src/ranking/ranking.service.ts`
- `backend/src/records/records.service.spec.ts`
- `backend/src/records/records.service.ts`
- `docs/investigations/2026-09-29-friends/browser-validation.json`
- `docs/investigations/2026-09-29-friends/report.md`
- `frontend/src/app/navigation/MainTabs.test.ts`
- `frontend/src/app/navigation/MainTabs.tsx`
- `frontend/src/app/navigation/MyStack.tsx`
- `frontend/src/app/navigation/types.ts`
- `frontend/src/components/navigation/TabBarIcon.tsx`
- `frontend/src/constants/queryKeys.test.ts`
- `frontend/src/constants/queryKeys.ts`
- `frontend/src/constants/queryUsage.test.ts`
- `frontend/src/constants/testIds.ts`
- `frontend/src/features/friends/api.ts`
- `frontend/src/features/friends/cache.ts`
- `frontend/src/features/friends/friends.test.ts`
- `frontend/src/features/me/api.ts`
- `frontend/src/features/ranking/api.ts`
- `frontend/src/features/ranking/ranking.test.ts`
- `frontend/src/screens/friends/FriendsScreen.tsx`
- `frontend/src/screens/home/SeasonAccountHome.tsx`
- `frontend/src/screens/my/MyScreen.tsx`
- `frontend/src/screens/my/NoticesScreen.tsx`
- `frontend/src/screens/my/OverallScreen.tsx`
- `frontend/src/screens/my/SettingsScreen.tsx`
- `frontend/src/screens/ranking/RankingScreen.tsx`
- `frontend/src/screens/ranking/UserSeasonSummaryScreen.tsx`
- `frontend/test/browser/README.md`
- `frontend/test/browser/friendsBrowser.cjs`
- `frontend/test/browser/friendsFixture.jsx`
- `frontend/test/browser/friendsMocks.js`

## 15. 남은 수동 실기기 검증

- Android/iOS에서 일반↔시즌 전환 후 5번째 전체 탭과 safe-area/뒤로가기 확인.
- 두 계정으로 검색→요청→수락/거절→친구 portfolio→삭제를 연속 실행.
- 상대 계정 공개→비공개 변경 후 이미 열려 있는 화면을 새로고침/재진입하여 잠금 확인.
- OS 최대 글자 크기, 320px 수준 화면, 긴 닉네임/종목명, 키보드 및 TalkBack/VoiceOver 확인.
- 네트워크 끊김/재연결, 중복 탭, pull-to-refresh, 친구/ranking 추가 페이지 동작 확인.
- MY 정보/Reward/로그아웃, 일반 Guide/시즌 Ranking, 주문·Wallet·FX 기존 기본 동선 smoke.
