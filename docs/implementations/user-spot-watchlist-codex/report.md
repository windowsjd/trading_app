# 사용자별 현물 관심종목 구현 보고

작성일: 2026-10-13 (Asia/Seoul).

## 구현

- 시작 SHA: `ffb9a515317e3b0c21736fd0cf520d0cf915f91c`.
- 로컬 구현·검증 종료 SHA: `af8e4365a49aa16f8a9c25ab038950ae88ececf2`.
- 원격 구현 종료 SHA: `d2dbaf8b633b02f8e4918b848eee2b42d0808b72`.
- 브랜치: `codex/user-spot-watchlist-20261013`.
- Worktree: `/tmp/trading-app-user-spot-watchlist-20261013`.
- 이 보고서와 UI 증거는 구현 커밋 뒤의 별도 보고 커밋에 포함한다.
  보고 커밋까지 포함한 최종 HEAD SHA는 완료 메시지에 기록한다.
- 로컬 `git push --set-upstream origin codex/user-spot-watchlist-20261013`은
  HTTPS 인증 정보 부재로 FAIL했다. 연결된 GitHub 도구의 쓰기 권한을 확인한 뒤
  Git Objects/Ref API를 사용해 같은 작업 브랜치에 게시한다.
  API가 author/committer 메타데이터를 생성하므로 커밋 SHA는 달라진다.
  구현의 38개 blob SHA와 전체 tree SHA
  `1f21145357979125d6dcaf3c98d2055743f5d33d`가 로컬 검증본과 동일함을 확인했다.
  최종 파일 트리와 원격 ref도 완료 시 다시 확인한다.
- 지정 SHA에서 브랜치와 Worktree를 생성했다. 처음 프로젝트 내부에 만든
  Worktree는 원래 디렉터리를 깨끗하게 유지하기 위해 위 위치로 옮겼다.
  원래 작업 디렉터리의 tracked/untracked 변경은 없다.
- 다른 브랜치의 구현을 조회·복사·cherry-pick하지 않았다.

### DB와 API

`WatchlistEntry`에는 `userId`, `assetId`, `createdAt`만 저장한다.
User/Asset FK, 사용자·자산 복합 PK, 사용자·등록 시각·자산 정렬 인덱스를
추가했다. 자산명·심볼·시장·종류·활성 상태는 Asset을 JOIN해 읽는다.
가격은 반환하지 않는다.

Additive Migration:
`backend/prisma/migrations/20261013040000_add_user_watchlist/migration.sql`.
기존 테이블의 금융 데이터를 변경하지 않는다. 실제 적용 대상은 이번 작업에서
새로 만든 loopback PostgreSQL 테스트 DB뿐이다.

| 연산 | API | HTTP/응답 |
| --- | --- | --- |
| 조회 | GET /api/v1/watchlist | 200, success/data/items, 전체 최대 50개 |
| 등록 | PUT /api/v1/watchlist/:assetId | 200, success/data/item |
| 해제 | DELETE /api/v1/watchlist/:assetId | 200, success/data/assetId/registered=false |

인증 토큰으로 얻은 `request.user.userId`만 사용한다. Body/query의 userId와
accountId는 소유권을 바꾸지 않는다. 서버 toggle API는 없다.
기존 전역 인증 Guard와 오류 Filter를 사용한다.

등록·해제 모두 Prisma READ COMMITTED transaction 안에서 User 행을
`FOR NO KEY UPDATE`로 잠근 뒤 읽고 쓴다. 잠금 뒤의 count는 앞 요청의
커밋을 반영하므로 여러 서버·기기에서도 49+2는 최대 50이다.
같은 종목 재등록은 활성/개수 검사보다 먼저 기존 행을 반환한다.
등록 시각과 정렬 순서를 바꾸지 않으며, 없는 항목 해제도 성공한다.
새 등록은 Asset SHARE 잠금 후 존재·활성·기존 Binance Spot/Futures 정책을
검사한다. 비활성 기록도 개수에 포함하며 조회·해제는 가능하다.
정렬은 createdAt DESC, assetId ASC다.

오류 계약 및 입력 제한은
[API 계약](../../../backend/docs/watchlist-api-contract.md)에 기록했다.

### Frontend

- `features/watchlist/api.ts`: 기존 API client로 명시적 PUT/DELETE와 전체 조회.
- `useWatchlist.ts`: User 키의 React Query 서버 상태, 세션 generation,
  공유 mutation 상태, 종목별 동기 요청 잠금.
- `WatchlistButton`/`WatchlistNotice`: 별도 터치 영역, 선택/처리 중/오류 표시.
- `WatchlistScreen`: 선택한 현물 시장으로 서버 목록을 필터하는 FlatList.
  일반 마켓 첫 20개 결과에 없는 종목도 표시한다.
- 기존 마켓·검색의 REST 페이지/정렬과 ticker merge는 유지한다.
  기존 memo 비교에 관심종목의 작은 상태 값만 추가했다.
- Futures 분기에 관심종목 버튼이나 진입점을 렌더링하지 않는다.
  마켓 API 실패 화면에서도 관심종목 화면에 진입할 수 있다.

낙관적 별표를 저장하지 않고, 성공 및 응답 유실 가능성이 있는 실패 뒤에
서버 목록을 다시 조회한다. 진행 중 같은 종목의 중복·반대 요청은 차단한다.
진행 전 조회를 cancel하고 AbortSignal을 전달하며, 오래된 mutation 완료는
사용자/generation 검사를 통과해야 캐시에 영향을 줄 수 있다.
기존 로그인/로그아웃의 전체 캐시 정리를 재사용했다. Trading Account는
관심종목 키에 들어가지 않는다.

화면 focus, foreground, React Query reconnect 및 기존 마켓 socket의 connected
전환에서 재조회한다. 새 socket이나 가격 polling은 만들지 않았다.
명시적 오류 재조회는 /me 실패도 복구하며, 확인된 조회 뒤에 해당 세션의
실패 mutation 표시를 지운다.

## 검증

아래 명령은 실제 실행했다. Backend/Frontend 명령은 각각 해당 디렉터리에서
실행했으며, DB URL은 새로 만든 `watchlist_test` 클러스터만 가리켰다.

| 검사 | 실제 명령/범위 | 결과 |
| --- | --- | --- |
| Backend 타입 | npm run typecheck | PASS |
| Backend 빌드 | npm run build | PASS |
| 신규/변경 Backend lint | npm run lint:watchlist:check | PASS, 경고 0 |
| 기존 금융 gate lint | npm run lint:accounts:check | PASS |
| Backend 관련 unit/회귀 | 아래 Jest 명령 | PASS, 8 suites / 418 tests, 실패·skip 0 |
| Prisma client 생성 | 아래 generate 명령 | PASS |
| 격리 PG Migration | 아래 migrate deploy 명령 | PASS, 74개 Migration 체인 |
| PG + 실제 HTTP 인증 | 아래 integration:watchlist 명령 | PASS, 130 assertions |
| Frontend 타입 | npm run typecheck | PASS |
| Frontend lint | npm run lint:accounts:check | PASS, 신규 관심종목/마켓 범위도 gate에 추가 |
| 관심종목 hook/UI/API | node src/features/watchlist/watchlist.test.ts | PASS, 12 tests, 실패·skip 0 |
| 기존 마켓 회귀 | 아래 market 명령 | PASS, 6 test files |
| 전체 Frontend 단일 실행 | 아래 180초 제한 npm test | PARTIAL, 156 files PASS / 28 cancelled / 실패 0 |
| 시간 제한으로 취소된 범위 | 아래 별도 240초 제한 명령 | PASS, 30 files (앞 실행과 2개 중복), 실패·skip 0 |
| RN Web UI | 아래 browser 명령 | PASS, 96 layouts + 4 interactions |
| Git 공백/충돌 표식 | git diff --check, git diff --cached --check | PASS |
| 최종 diff 자체 감사 | 변경 경로, 수기 production 코드, 테스트 단언, 생성물 검토 | PASS |
| Android/iOS 실제 기기 | 실행하지 않음 | NOT_RUN |
| 실제 provider 연결 시세 E2E/FPS 벤치마크 | 실행하지 않음 | NOT_RUN |
| 운영 DB/환경변수/Render 배포 | 실행하지 않음 | NOT_RUN, 과제 금지 범위 |

Backend:

```sh
npm test -- --runInBand --runTestsByPath \
  src/watchlist/watchlist.service.spec.ts src/auth/access-token.guard.spec.ts \
  src/auth/auth.service.spec.ts src/assets/assets.service.spec.ts \
  src/providers/binance/binance-product-catalog.spec.ts \
  src/orders/orders.service.spec.ts src/fx/fx.service.spec.ts \
  src/wallets/trading-account-wallet-transfer.service.spec.ts

PRISMA_SCHEMA_ENGINE_BINARY=/tmp/watchlist-schema-engine \
  DATABASE_URL=postgresql://watchlist_test@127.0.0.1:56587/watchlist_test \
  ./node_modules/.bin/prisma generate

PRISMA_SCHEMA_ENGINE_BINARY=/tmp/watchlist-schema-engine \
  DATABASE_URL=postgresql://watchlist_test@127.0.0.1:56587/watchlist_test \
  ./node_modules/.bin/prisma migrate deploy

NODE_ENV=test WATCHLIST_DB_INTEGRATION=1 \
  DATABASE_URL=postgresql://watchlist_test@127.0.0.1:56587/watchlist_test \
  timeout 120s npm run integration:watchlist
```

PG 검증은 두 Nest HTTP 인스턴스와 서로 다른 Prisma pool을 사용했다.
49개에서 서로 다른 두 종목 등록을 10회 반복해 매번 200/409 각 1건과
최종 50개를 확인했다. 8건 동시 동일 종목 등록도 한 행과 한 등록 시각이었다.
인증 없는 요청/잘못된 토큰/정지 사용자, 다른 사용자 격리, body/query 소유권
위조, 비활성·Futures 전용·없는 자산, FK/중복 제약, 정렬, Nest 서버와 pool
재시작 후 유지, DB 오류 원문 비노출을 확인했다.
Trading Account/지갑/원장/주문/포지션/랭킹의 행 개수는 전후 동일했다.
fixture는 생성한 사용자와 자산만 정리했다.

Frontend:

```sh
node --test --test-concurrency=1 src/features/market/*.test.ts src/screens/market/*.test.ts

NODE_OPTIONS=--max-old-space-size=768 timeout --kill-after=10s 180s npm test

NODE_OPTIONS=--max-old-space-size=768 timeout --kill-after=10s 240s \
  node --test --test-concurrency=1 \
  src/screens/order/*.test.ts src/screens/quest/*.test.ts \
  src/screens/record/recordPresentation.test.ts src/screens/wallet/*.test.ts \
  src/services/api/*.test.ts src/services/ws/*.test.ts src/theme/*.test.ts src/utils/*.test.ts

FONTCONFIG_FILE=/tmp/watchlist-fontconfig.conf \
LD_LIBRARY_PATH=/tmp/watchlist-browser-tools/libs/usr/lib/x86_64-linux-gnu \
NODE_PATH=/tmp/watchlist-browser-tools/node_modules \
PLAYWRIGHT_BROWSERS_PATH=/tmp/watchlist-playwright-browsers \
NODE_OPTIONS=--max-old-space-size=768 timeout --kill-after=10s 120s \
  node test/browser/watchlistBrowser.cjs
```

전체 실행의 종료 코드 124를 PASS로 처리하지 않았다. 프로세스 종료와
마지막 진행 파일을 확인했고, 총 실행 시간 제한이 원인임을 확인한 뒤
미완료 범위를 시간·Node heap 제한으로 분리했다. 기존 검증을 삭제하거나
skip/완화하지 않았다. 변경된 UI 단언은 존재 여부/개수/선택 상태 같은
원시값을 사용하므로 ReactTestInstance 전체를 오류 출력하지 않는다.

관련 테스트는 같은 frame의 중복/반대 터치, 두 화면 상태 공유, 실패 및
커밋 뒤 응답 유실, 취소된 GET의 늦은 결과, 사용자 전환과 오래된 callback,
화면 이탈 중 응답, 계정 전환 시 캐시 유지, reconnect/foreground 재조회,
/me 오류 복구, 로딩/빈/오류 구분, 시장 필터와 비활성 해제를 검증한다.

UI는 320/360/390/430px, Light/Dark, Font Scale 1/2, 긴 한국어·영어 이름을
검사했다. 실제 한글 system font를 임시 Fontconfig로 제공했고, 기존 테마
선택 API로 모드를 지정했다. 보이지 않는 줄 끝 공백 대신 실제 문자 경계를
검사한다. 글자와 현재가/등락률의 가로·세로 경계, 가로 overflow, 관심종목
48px 터치 영역 검증에서 실패가 없었다. Web의 font scale fixture 결과이며
Android/iOS 검증으로 보고하지 않는다.

- [브라우저 실행 결과](evidence/browser-report.json)
- [320px / Font Scale 2 / Light](evidence/watchlist-light-320-scale2.png)
- [320px / Font Scale 2 / Dark](evidence/watchlist-dark-320-scale2.png)

## 자체 평가

가장 중요한 결정은 User 행 잠금과 READ COMMITTED를 함께 사용한 것이다.
User에 count 컬럼이나 별도 lock 테이블을 추가하지 않고 기존 PostgreSQL
transaction으로 여러 기기의 등록 개수와 멱등성을 함께 보장한다.
프론트엔드는 server read 하나를 권위 상태로 두고 낙관적 상태 복사본을
만들지 않았다. 요청 동안의 별표 반응은 서버 확인을 기다리는 비용이 있지만,
실패/세션 전환/경합의 복구가 단순하다.

50개 전체 조회여서 관심종목 pagination을 생략했고, 시세 없는 metadata
목록을 사용해 가격 신선도·추가 subscription·REST 조합 문제를 피했다.
SERIALIZABLE + retry, advisory lock, User count 컬럼, optimistic rollback,
관심종목 시세 batch 조회를 대안으로 고려했으나 이번 범위에는 책임이 더 늘어난다.

유지보수 시 모든 관심종목 writer는 같은 User 잠금 경계를 거쳐야 한다.
새 bulk API나 운영 직접 INSERT가 이 규칙을 우회하면 개수 제한은 보장되지
않는다. 세션 generation을 request 시작 시 고정하는 API client 계약과 전체
session cache clear도 계속 유지해야 한다. 실제 기기 접근성·글꼴/터치 렌더링,
실제 provider E2E와 FPS는 추가 검증 대상이다. 관심종목 동기화는 focus/
foreground/reconnect/명시적 재조회 시 이뤄지며 다른 기기의 변경을 실시간
push하는 새 인프라는 만들지 않았다.

금융 기능과 기존 Binance 상품 분리·시세 정책의 구현 파일은 변경하지 않았다.
기존 테스트 수정은 market refresh 테스트의 신규 관심종목 의존성 mock
추가뿐이며 원래 페이지/정렬/화면 전환 단언을 유지했다.

## 변경 파일

구현 커밋의 38개 파일:

```text
backend/docs/README.md
backend/docs/watchlist-api-contract.md
backend/package.json
backend/prisma/migrations/20261013040000_add_user_watchlist/migration.sql
backend/prisma/schema.prisma
backend/scripts/watchlist-integration.ts
backend/src/app.module.ts
backend/src/generated/prisma/browser.ts
backend/src/generated/prisma/client.ts
backend/src/generated/prisma/internal/class.ts
backend/src/generated/prisma/internal/prismaNamespace.ts
backend/src/generated/prisma/internal/prismaNamespaceBrowser.ts
backend/src/generated/prisma/models.ts
backend/src/generated/prisma/models/Asset.ts
backend/src/generated/prisma/models/User.ts
backend/src/generated/prisma/models/WatchlistEntry.ts
backend/src/watchlist/watchlist.controller.ts
backend/src/watchlist/watchlist.module.ts
backend/src/watchlist/watchlist.service.spec.ts
backend/src/watchlist/watchlist.service.ts
frontend/package.json
frontend/src/app/navigation/MarketStack.tsx
frontend/src/app/navigation/types.ts
frontend/src/constants/queryKeys.ts
frontend/src/features/market/MarketAssetRow.tsx
frontend/src/features/market/marketRefresh.test.ts
frontend/src/features/watchlist/WatchlistButton.tsx
frontend/src/features/watchlist/WatchlistNotice.tsx
frontend/src/features/watchlist/api.ts
frontend/src/features/watchlist/useWatchlist.ts
frontend/src/features/watchlist/watchlist.test.ts
frontend/src/screens/market/MarketScreen.tsx
frontend/src/screens/market/MarketSearchScreen.tsx
frontend/src/screens/market/WatchlistScreen.tsx
frontend/test/browser/README.md
frontend/test/browser/watchlistBrowser.cjs
frontend/test/browser/watchlistFixture.jsx
frontend/test/browser/watchlistMocks.js
```

Prisma 생성물은 기존 저장소가 추적하는 파일이므로 모델/관계 변경에 맞춰
재생성해 포함했다. 보고 커밋은 이 report.md와 evidence의 JSON/PNG 세 파일만
추가한다. 새 앱 의존성·외부 API·Redis/메시지 큐는 추가하지 않았다.
