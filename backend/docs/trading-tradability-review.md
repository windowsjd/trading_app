# 거래 가능 판정 책임 분리 — 작업 3 검토

## 기준과 범위

- 시작 main: `4faf726c007a11d3cd633bf50c09b51174ea4dbd` (`Pin season market and FX fees to durable quotes`).
- 현재 main 작업 디렉터리에서 작업했다. branch/worktree를 생성하지 않았고 원격 push는 하지 않는다.
- 작업 1 transaction-time 및 작업 2 fee pinning이 반영된 현재 코드를 기준으로 추적했다.
- DB schema, migration, dependency, 금융 실행 코드, fee 값은 변경하지 않았다.

## 최종 책임

| 계층 | 판정 |
| --- | --- |
| Assets | 자산 active, 시장 session, 기존 가격/FX 데이터 선택 및 유효성 정책 |
| General capability | 계좌 active. 시즌 존재/참가/상태와 무관 |
| Season capability | 계좌 active + 시즌 active + `startAt <= now < endAt` + participant active |
| Quote/create/execute | 기존 backend authoritative validation, ownership, foundation, lock 이후 transaction-time 재검증 |

AssetsService의 current-season 및 participant 조회를 제거했다. 신규 응답에서는
시즌/계좌 blocked reason을 생성하지 않는다. 기존 reason 타입 이름과 인증은 유지한다.
`withPrice=false`는 기존 metadata-only 계약대로 가격 조회/검증을 생략한다.
Market/Order가 사용하는 priced 응답은 기존 inactive/closed/unknown/unavailable/stale
제한을 유지한다. 표시 가능한 과거 시세가 있다는 사실은 신규 실행 허가가 아니다.

일반계좌 foundation의 무결성 정보는 현재 account DTO에 없다. 프런트가 이를
추정하지 않으며 기존 backend foundation 검사를 유지한다. 시즌 participant는
`active`만 신규 거래 가능하고 `excluded`는 별도 계좌 안내를 표시한다.
registered/finished/rewarded도 신규 거래 불가다. upcoming/ended/settled,
시작 전/종료 시각 이후, suspended/closed는 신규 market/limit/FX를 차단한다.
선택된 시즌의 시작/종료 경계에는 timer로 capability를 재계산한다.
계좌 조회가 갱신되면 participant 변경도 반영한다. 서버의 최종 검사는 계속 필요하다.

`canRead`와 `canCancelOrder`는 유지한다. 실제 PostgreSQL에서 excluded,
upcoming/ended/settled, suspended/closed 상태의 내역 조회와 기존 지정가 취소,
예약금 해제를 확인했다. cancel 가능 여부의 최종 판단은 기존 backend가 담당한다.

## 화면과 호환성

- Market 목록/검색은 account mode를 받지 않는다. 자산/시장 경고만 표시한다.
- Asset detail/Order는 asset warning과 account capability 안내를 분리한다.
  BUY/SELL, market/limit 신규 CTA는 기존 capability 연결을 통해 차단된다.
- FX는 기존 `canExchange` 연결을 그대로 사용한다. 제외된 참가자는 신규 FX가
  차단되며 원장/지갑 조회 경로는 유지된다. FX 화면 production 변경은 필요 없었다.
- 일반계좌 전용 asset reason 우회 helper를 제거했다. 새 asset helper에는 과거
  캐시/구버전 응답의 account reason을 **모든 mode에서** 무시하는 명시적 호환 처리만
  있다. 이 처리는 계좌 권한을 부여하지 않는다.
- 기존 일반계좌용 season 오류 문구 방어는 표시 호환 처리로 주석을 명확히 했다.
  신규 Assets/capability 판정은 여기에 의존하지 않는다.

## 검증 결과

Node 24.14.1, PostgreSQL 16.15, Redis 7.0.15의 로컬 격리 테스트 DB에서 실행했다.
실제 provider 요청/운영 DB는 사용하지 않았다. opt-in PostgreSQL suite는 아래
스위치를 활성화하여 실행했으며 기본 unit 실행에서의 skip을 PASS로 계산하지 않았다.

| 검증 | PASS | FAIL | SKIP |
| --- | ---: | ---: | ---: |
| Backend 전체 unit | 2705 | 0 | 43 |
| 그중 Assets unit | 54 | 0 | 0 |
| Release-critical E2E | 126 | 0 | 0 |
| Core account PostgreSQL (wrapper tests) | 16 | 0 | 0 |
| Order/FX PostgreSQL (wrapper tests) | 11 | 0 | 0 |
| Frontend 전체 test | 711 | 0 | 0 |
| 시작 main clean 상태 candle fixture assertions | 24 | 0 | 0 |

Backend unit은 189 suite PASS / 39 opt-in suite SKIP이다. 43개 skip 중 이번 작업 및
CI가 요구하는 PostgreSQL 대상은 별도 27 suite에서 실제 실행했다. 표의 subset과
wrapper/scenario 수는 서로 더하지 않는다. 새 Assets PostgreSQL wrapper는 8개
시나리오를 검증한다. 기존 trading transaction-time 46개, fee pinning 16개 시나리오와
지정가 create-time, Path A/B, cancel/fill race, replay 회귀도 PostgreSQL 실행에 포함한다.

다음 명령은 모두 통과했다.

```sh
# backend/
pnpm run lint:accounts:check
pnpm run lint:candles:check
pnpm run format:candles:check
pnpm run typecheck
pnpm run build
pnpm test --runInBand
pnpm run test:e2e --runInBand
pnpm exec prisma migrate deploy
pnpm exec prisma migrate status
pnpm exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
pnpm run trading-accounts:repair-links
pnpm run trading-accounts:repair-ranking-scope
pnpm run trading-accounts:audit-general

# frontend/
npm run lint:accounts:check
npm run typecheck
npm test
npm run export:web
```

repair/audit는 테스트 DB의 dry-run이며 보정/위반 대상이 없었다. 변경된 작은
TS 파일은 Prettier check를 실행했고 기존 대형 화면은 변경 구간만 포맷했다.
새 integration script/wrapper lint도 통과했다. `git diff --check`도 통과했다.

PostgreSQL 실행은 `.github/workflows/ci.yml`의 core-account 16개 및
limit-order 11개 test 목록에 `pnpm exec jest --runInBand`를 적용했다.

```sh
# core-account suite 환경 (DATABASE_URL/REDIS_URL은 로컬 테스트 서버)
TRADING_ACCOUNT_DB_INTEGRATION=1 GENERAL_TRADING_DB_INTEGRATION=1
GENERAL_FX_DB_INTEGRATION=1 SEASON_JOIN_DB_INTEGRATION=1
AUTH_DB_SMOKE=1 OPS_JOB_LOCK_DB_SMOKE=1
LIMIT_ORDER_ENABLED=true AD_REWARD_ENABLED=true
# JWT_ACCESS_SECRET도 테스트 전용 값으로 설정

# order/FX suite 환경
LIMIT_ORDER_RESERVATION_DB_INTEGRATION=1
LIMIT_ORDER_IDEMPOTENT_REPLAY_INTEGRATION=1
LIMIT_ORDER_MATCHING_DB_INTEGRATION=1 ORDER_EXECUTE_DB_INTEGRATION=1
FX_EXECUTE_DB_INTEGRATION=1 MVP_FLOW_DB_SMOKE=1
```

CI core-account 목록에 새 Assets integration을 추가했다. 새 외부 서비스는 없다.
환경 제한 안에서의 Node test 출력이 내부 assertion 수를 보여주지 않아 실제
테스트 프로세스가 실행 가능한 환경에서 재실행했고, 711개 결과만 최종 집계했다.

## 기존 실패와 후속 사항

시작 main의 [CI run 34850067471](https://github.com/windowsjd/trading_app/actions/runs/34850067471)은
candle fixture job만 실패하고 다른 필수 job은 성공했다. 변경 전 main에서
`prisma generate` → candle fixture 명령으로 동일한 exit 2를 재현했다.
생성된 `src/generated/prisma/internal/class.ts`의 inline schema 주석이 현재
`schema.prisma`의 작업 2 fee 주석과 달라 generate가 tracked 파일을 수정한다.
그 결과 candle assertion 전에 clean-checkout guard가 거절한다.

이번 실행에서 생긴 생성 파일의 주석 차이만 되돌린 clean baseline에서는
`CANDLE_PIPELINE_RELEASE_FIXTURE_SMOKE=1 pnpm run smoke:candle-fixture`의 24개
assertion이 통과했다. 생성 파일 동기화는 기존 CI 후속 사항으로 남겼고 candle
subsystem이나 guard를 변경/우회하지 않았다. 원격 push 없이 새 원격 CI는 실행하지 않았다.

필수 lint 밖의 추가 검사에서는 AssetsService의 기존 `require-await` 1개,
MarketSearchScreen의 기존 promise 처리 오류 2개를 발견했다. 시작 HEAD 내용을
동일 eslint에 stdin으로 넣어 동일 오류를 확인했다. 해당 구문은 이번 diff에서
변경하지 않았으며 범위 밖 lint 정리로 남긴다. 이번 변경의 신규 assertion 실패는 없다.

## 검색 및 자체 검토

- AssetsService에 season/participant/account 조회 또는 그 값으로 tradable을
  결정하는 경로가 없다. season reason은 호환 type 선언에만 남았다.
- General capability는 season 객체를 사용하지 않는다. 시즌만 lifecycle과
  participant gate를 가진다. 자산 제한은 계좌를 바꿔도 같은 의미다.
- 신규 quote/order/FX CTA가 참가자 제외와 시즌 경계를 반영한다. read/cancel은 유지한다.
- `orders`, `fx`, `seasons`, `portfolio`, Prisma/schema/generated production diff는 없다.
  transactionNow, lock ordering, TWR account fence, fee pinning, reservation,
  Path A/B, authoritative authorization, replay/atomicity를 변경하지 않았다.
- 계좌 mode 차이는 시즌 lifecycle/participant, 기존 general foundation/TWR 등
  고유 기능에 남는다. 신규 capability framework, accountId 필수 Assets API,
  migration, fee engine은 추가하지 않았다.

## 변경 파일

Production:

- `backend/src/assets/assets.service.ts`
- `frontend/src/features/asset/tradingUx.ts`
- `frontend/src/features/tradingAccount/capabilities.ts`
- `frontend/src/features/tradingAccount/TradingAccountContext.tsx`
- `frontend/src/features/market/MarketAssetRow.tsx`
- `frontend/src/screens/market/MarketScreen.tsx`
- `frontend/src/screens/market/MarketSearchScreen.tsx`
- `frontend/src/screens/asset/AssetDetailScreen.tsx`
- `frontend/src/screens/order/OrderScreen.tsx`

Tests/CI:

- `backend/src/assets/assets.service.spec.ts`
- `backend/src/assets/assets-tradability.integration.spec.ts`
- `backend/scripts/trading-tradability-integration.ts`
- `frontend/src/features/asset/tradingUx.test.ts`
- `frontend/src/features/tradingAccount/capabilities.test.ts`
- `frontend/src/features/tradingAccount/accountBinding.test.ts`
- `frontend/src/features/tradingAccount/TradingAccountContext.test.ts`
- `frontend/src/utils/displayPolicyContract.test.ts`
- `.github/workflows/ci.yml`

Docs:

- `backend/docs/assets-api-contract.md`
- `frontend/docs/trading-account-switching.md`
- `backend/docs/trading-tradability-review.md`
