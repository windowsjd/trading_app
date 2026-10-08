# 주문 입력 정책 (A)

Current additive exception: [Conditional v1](conditional-orders-contract.md)
Position-bound SELL children may reserve the exact fractional stock remainder.
The capability is internal, validated against a live group, and never parsed from
HTTP. Ordinary stock Limit inputs remain integer-only. This preserves protection
after a fractional Market reduction without changing the normal order form.

적용 범위는 General/Season 공통 주문 코어다. API base는 `/api/v1`이다.

- 주식 소수 수량은 시장가에서만 허용한다. 지정가는 Decimal 정수 판정으로 검증하여 `1.000000`은 허용한다.
- 확정 CLOSED에서도 정수 주식 지정가를 등록한다. 이는 다음 정규장 evidence를 기다리는 GTC-style 예약이며 실제 After Market/NXT 체결이 아니다. 시장가 CLOSED 및 모든 주문의 calendar unavailable은 차단한다.
- Crypto BUY 요청은 수수료 제외 원금 `amount`를 사용한다. 서버가 `amount / price`를 수량 scale 6으로 내림한다. 시장가는 실행 가격에서 다시 계산하고 지정가는 등록 수량을 유지한다.
- `Quote.sourceAmount`는 `quoteType=order`의 crypto BUY에서 입력 원금이다. FX의 source currency amount 의미는 그대로다. `currencyCode`가 주문 amount 통화이며 FX의 from/toCurrency와 targetAmount는 채우지 않는다. quotedGrossAmount/quotedFeeAmount/quotedReservedAmount는 계속 계산된 지정가 예약 기준이다. 별도 schema migration이 필요 없다.
- amount를 Quote hash와 Create idempotency hash에 포함한다. 다른 주문의 quantity 기반 v1 hash는 유지한다. Create는 durable amount, 수량 계산 결과, Quote TTL 및 소유권을 검증한다.
- Matcher Path A는 제출 이후 snapshot의 effectiveAt만 사용한다. Path B는 제출 이후 첫 전체 5분봉 규칙을 유지한다. 두 경로 모두 미래 evidence 및 calendar unavailable을 거절한다.
- Frontend preview는 정보 표시 및 비율 계산용이다. 수동 입력의 서버 Quote 요청 권한은 preview 가격이나 수수료 조회 성공에 의존하지 않는다.

이 설계는 사용자 매수 예산을 서버 실행 가격과 일치시키면서 기존 원자적 wallet/position/ledger 처리, 예약 해제, fee pinning, replay 및 계좌 경계를 유지하기 위한 것이다.

## 조사 결과와 최종 데이터 흐름

기준: 2026-09-29 `git fetch origin main` 후 clean main `afcf701f`.

| 기존 구현 | 확인 결과 / 변경 이유 |
| --- | --- |
| Stock quantity | Frontend/Backend 공통 scale 6, 지정가 정수 제한 없음. Decimal.isInteger 검증을 Quote/Create에 추가했다. |
| Stock session | 시장가와 지정가가 동일 open gate를 사용했다. 등록 권한과 체결 evidence 권한을 구분했다. |
| Crypto BUY | quantity 기반 요청이었다. 원금 예산을 실행 시점까지 보존하려고 amount intent를 도입했다. |
| Preview | `preview=null`이 canExecute를 막았다. 표시 시세의 실패와 서버 Quote 권한을 분리했다. |
| Matcher A | 현재 세션/source/freshness 검증은 있었으나 submittedAt 하한이 없었다. scan과 fill transaction 양쪽에 추가했다. |
| Matcher B | 제출 이후 첫 전체 5분봉 정책이 이미 있었다. 이를 유지하고 미래 close/sourceUpdatedAt/finalizedAt 및 현재 calendar unavailable을 거절한다. |

정책 표는 [canonical API 계약](orders-api-contract.md#order-input-and-session-policy-2026-09-29-current)을 따른다.

Crypto BUY 시장가:

1. 사용자 `amount`는 수수료 제외 원금이다. Frontend는 그 문자열을 그대로 Quote 요청에 보낸다.
2. Backend가 적격 가격과 계좌 fee로 `floor6(amount / quotePrice)` 및 예상 gross/fee/total을 계산한다. 화면은 서버 quantity를 우선한다.
3. PostgreSQL Quote에 원금(sourceAmount), 예상 quantity, 가격, fee pin과 intent hash를 저장한다. FX sourceAmount와는 quoteType/asset/side로 구분한다.
4. Create는 같은 amount + quoteId + idempotencyKey를 받는다. 소유권, TTL, hash, canonical quoted quantity를 검증한다. 다른 amount는 QUOTE_MISMATCH 또는 이미 commit된 key의 ORDER_IDEMPOTENCY_CONFLICT다.
5. 잠금 후 DB clock에서 실제 적격 execution price와 maxChangeBps를 검증한다. 원금/실행가격에서 최종 quantity를 다시 내림한다.
6. 같은 최종 quantity/price로 Order, Position, wallet gross+fee debit, ledger를 한 transaction에 저장한다. PostgreSQL이 금융 source of truth다. Quote 가격은 실행 가격을 고정하지 않는다.

Crypto BUY 지정가는 2단계에서 limitPrice로 수량을 확정하고 등록 뒤 수량을 유지한다. 실제 더 좋은 체결 가격이면 원금보다 덜 소비할 수 있고 기존 fill transaction이 나머지 예약까지 해제한다. 예: amount=100, limit=700 → quantity=0.142857; 600 체결 → gross=85.71420000.

Stock CLOSED 지정가:

`유효한 정수 입력 → 서버 calendar CLOSED 확인 → Quote → post-lock Create 재검증 → reservation + submitted → 대기 → 제출 이후 적격 정규장 evidence → 전량 fill 또는 기존 cancel/cleanup`

등록은 BUY wallet.balanceAmount 및 SELL position.quantity를 줄이지 않는다. Path A는 현재 정규장 fresh provider snapshot과 effectiveAt >= submittedAt을 요구한다. Path B는 submittedAt을 올림한 첫 전체 봉 이후이며 봉 전체가 regular session 안에 있어야 한다. 이전 종가/봉으로 새 주문을 체결하지 않는다. 유효한 과거 정규장 봉은 그 뒤 폐장 상태에서 처리할 수 있지만 현재 캘린더 미확인은 두 경로 모두 fail-closed다. 기존 season endAt/participant-exclusion cleanup과 full-fill-only는 유지한다.

## 금융 불변조건 검토

- PostgreSQL/TradingAccount 소유권, DB role/auth 경계, General participant-null 및 Season 연결 무결성: 공통 코어와 lock 순서를 유지, 계좌 scope 통합 회귀 통과.
- Quote TTL, requestHash, 동일 key의 replay-first, quote consumption, duplicate create/race rollback: 기존 serializer를 quantity 경로에 보존하고 amount branch만 추가. Quote POST 자체의 idempotency key는 새로 도입하지 않는다.
- 시장가 source/freshness/current session/실제 가격/maxChangeBps와 fee pinning: 완화하지 않았다. 최종 quantity도 실행 가격에서 결정하므로 Position과 현금 쓰기가 일치한다.
- 지정가 BUY: 등록은 reservedAmount만 증가, fill은 실제 debit + 예약 전체 해제, cancel은 debit 없이 해제.
- 지정가 SELL: 등록은 reservedQuantity만 증가, fill은 실제 보유량 감소/현금 증가 + 예약 해제, cancel은 보유량 감소 없이 해제.
- valuation/TWR/ranking: 예약을 총자산에서 차감하지 않는다. 기존 금융 atomic helper, 평가, account mode 및 invalidation 경로를 재사용했다.
- 기존 submitted 주문 재작성/취소, partial fill, After Market/NXT, 거래소 주문 전송, Redis 금융 권한, B 대기목록/색상 변경은 추가하지 않았다.
- DB: Quote.sourceAmount 주석만 변경. Order.quantity에는 등록/최종 실행 수량, Position에는 실제 보유수량을 저장한다. 새 column/index/migration은 없다. 기존 55 migrations 적용 및 schema diff=0 확인.

## 추가·갱신한 검증

- 정책 unit 36개: 국내/미국 주식 BUY/SELL × market/limit × 정수/표현상 소수 정수/소수, OPEN/CLOSED/weekend/holiday/calendar unavailable, crypto 입력, 내림·최소값·overflow, amount hash 정규화.
- 신규 PostgreSQL runner: General/Season 각각 crypto amount 시장가 재가격/원장/포지션/재시도/변동 한도, 지정가 내림/예약/가격 개선/해제, crypto SELL 회귀; 국내/미국 각각 소수 시장가와 정수 지정가 Quote/Create, 양방향 session 전환, calendar 미확인 Quote/Create 거절, pre-submission/future snapshot 및 candle 검증, matcher Path A/B fill.
- 기존 실제 row-lock 대기 테스트는 TTL/season end/stale evidence 실패를 계속 검증하며, 지정가의 확정 stock close만 등록 성공으로 변경했다. 과거 fixture 시각은 제출 이후 evidence 및 non-future finalization에 맞게 바로잡았다.
- Frontend 새 행동 테스트 25개: 계좌/주문유형별 amount payload, 서버 quantity 우선 표시, 국내/미국 BUY/SELL 소수 validation, 유형 자동 전환 금지, preview 가격/fee 미확인 시 manual Quote, 서버 domain error, 실제 fee의 100% amount, 다른 amount/부적합 quantity Quote 거절. inlineTrading/tradingControls/limitOrder/asset/order/account mode는 전체 테스트로 회귀 검증했다.

## 검증 명령과 최종 결과 (2026-09-29)

Node/npm/pnpm은 저장소에 설치된 환경을 사용했다. DB 검증은 PostgreSQL 16 전용 `/tmp/order-policy-pg-20260929`, localhost:55439, `order_policy_clean`, server timezone UTC에서 기존 migration만 적용했다. 개발/운영 DB에는 접근하지 않았다.

| 작업 디렉터리 / 명령 | 최종 결과 |
| --- | --- |
| backend: `pnpm test --runInBand` | PASS: 207 suites, 3,102 tests. 기본 실행에서 opt-in 46 suites/50 tests는 skip. 관련 DB는 아래에서 별도 실행. |
| backend: `pnpm run test:e2e` | PASS: 1 suite, 341 tests |
| backend: `pnpm run typecheck` / `pnpm run build` | 각각 PASS |
| backend: `pnpm run lint:accounts:check` | PASS |
| backend: 변경한 주문 production 파일 및 새 runner/spec의 `pnpm exec eslint --no-fix ...` | PASS, 경고 없음 |
| backend: 아래 주문/FX DB 명령 | PASS: 12/12 suites/tests, skip 없음 |
| backend: 아래 계좌/평가/랭킹 DB 명령 | PASS: 18/18 suites/tests, skip 없음; MVP 중복 제외 총 29 DB suites |
| frontend: `npm run check` | PASS: gated account/guide lint + typecheck + 전체 171 suites, 1,245 tests, skip 없음 |
| frontend: `npm run export:web` | PASS: Expo production web export |
| backend: `pnpm exec prisma migrate deploy` / `migrate status` | PASS: 기존 55 migrations, up to date |
| backend: `pnpm exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` | PASS: No difference detected |
| root: `git diff --check` | PASS |

아래 DB 명령은 모두 격리 DB의 DATABASE_URL을 지정한 상태에서 backend에서 실행했다. 각 Jest suite는 내부 runner의 여러 금융 시나리오를 묶는다.

```bash
LIMIT_ORDER_RESERVATION_DB_INTEGRATION=1 \
LIMIT_ORDER_IDEMPOTENT_REPLAY_INTEGRATION=1 \
LIMIT_ORDER_MATCHING_DB_INTEGRATION=1 \
ORDER_EXECUTE_DB_INTEGRATION=1 \
FX_EXECUTE_DB_INTEGRATION=1 \
MVP_FLOW_DB_SMOKE=1 \
pnpm test --runInBand --testPathPatterns='order-input-policy.integration|limit-order-reservation.integration|limit-order-create-race.integration|limit-order-transaction-time.integration|trading-transaction-time.integration|trading-fee-pinning.integration|limit-order-create-no-redis.integration|limit-order-idempotent-replay.integration|limit-order-matching.integration|orders.execute.integration|fx.execute.integration|mvp-flow.integration'

TRADING_ACCOUNT_DB_INTEGRATION=1 \
GENERAL_TRADING_DB_INTEGRATION=1 \
GENERAL_FX_DB_INTEGRATION=1 \
SEASON_JOIN_DB_INTEGRATION=1 \
LIMIT_ORDER_ENABLED=true \
AD_REWARD_ENABLED=true \
MVP_FLOW_DB_SMOKE=1 \
pnpm exec jest --runInBand \
  src/assets/assets-tradability.integration.spec.ts \
  src/seasons/trading-account.integration.spec.ts \
  src/seasons/trading-account-link.integration.spec.ts \
  src/seasons/trading-account-financial-scope.integration.spec.ts \
  src/seasons/trading-account-trading-scope.integration.spec.ts \
  src/trading-accounts/general-account.integration.spec.ts \
  src/orders/general-account-trading.integration.spec.ts \
  src/fx/general-account-fx.integration.spec.ts \
  src/orders/order-replay-and-cancel-scope.integration.spec.ts \
  src/portfolio/general-performance-hardening.integration.spec.ts \
  src/portfolio/krx-closed-price.integration.spec.ts \
  src/portfolio/krx-session-close-recovery.integration.spec.ts \
  src/portfolio/snapshot-scope-audit.integration.spec.ts \
  src/trading-accounts/general-trading-audit.integration.spec.ts \
  src/ranking/season-ranking-scope.integration.spec.ts \
  src/ranking/ranking-consistency.integration.spec.ts \
  src/seasons/seasons.join.integration.spec.ts \
  src/mvp-flow.integration.spec.ts
```

중간 실패는 숨기지 않는다: 초기 로컬 PostgreSQL timezone에 의한 fixture 시각 오염은 UTC의 새 격리 DB로 해결했다. 새 runner 타입 오류/미사용 import, 기존 crypto BUY quantity fixture 및 제출 전/미래 fixture 기대값을 수정한 뒤 위 최종 명령은 모두 통과했다. 요구한 확정 CLOSED 등록 허용 외의 금융 안전 검증을 완화해 테스트를 통과시키지 않았다.

## 전체 diff 자기검토와 남은 범위

전체 tracked diff와 새 파일을 읽고, 입력 → Quote → hash/sourceAmount → post-lock Create → 실제 수량 → wallet/position/ledger 및 limit reservation → matcher A/B 흐름을 대조했다. DTO/오류/비율/단일 실행 잠금/재시도/계좌 invalidation을 확인했고 B UI, 새 API base, migration 및 unrelated feature 변경이 없음을 확인했다.

배포 호환성: 새 crypto BUY Quote/Create는 amount를 요구하므로 구형 quantity-only 클라이언트는 새 주문 시 INVALID_ORDER_INPUT을 받는다. 프런트/서버 계약을 함께 배포해야 한다. 이미 commit된 구형 요청의 replay-first와 기존 submitted 주문의 lifecycle은 유지한다. 작은 amount가 scale 6에서 양수 수량/원금을 만들 수 없으면 INVALID_AMOUNT다. 수량 precision 때문에 남는 최소 잔액은 정상이다. 장외 USD 지정가는 기존 USD/KRW Quote/실행 freshness 조건도 계속 요구한다.

NOT_RUN: Android/iOS 실기기 수동 UX, 실제 Binance/KIS 네트워크·장시간 live smoke, 배포 환경 scheduler soak, 관련 범위 외 opt-in DB/candle fixture 전체. 자동 검증은 fixture provider 및 실제 PostgreSQL 기반이며 실제 거래소 체결을 증명한다고 주장하지 않는다.

HANDOVER와 canonical 정책에 남긴 의도는 소수 지정가의 정수 계약, 다음 정규장을 기다리는 장외 등록, 원금 intent의 서버 확정, preview와 금융 권한의 분리다.

## 변경 파일과 역할

| 파일 | 역할 |
| --- | --- |
| `.github/workflows/ci.yml` | 새 주문 정책 PostgreSQL suite를 기존 주문 CI에 추가 |
| `HANDOVER.md` | 제품 의도·호환성·검증 기록 연결 |
| `backend/docs/order-input-policy.md` | 설계·조사·회귀 검증 및 파일 역할 기록 |
| `backend/docs/orders-api-contract.md` | amount/quantity, 세션, hash, matcher 및 오류의 canonical 계약 |
| `backend/docs/policy-decisions.md` | 정책 결정과 구현 이유 |
| `backend/docs/trading-account-orders-api-contract.md` | General/Season 동일 계약 명시 |
| `backend/docs/trading-transaction-time-review.md` | 현재 CLOSED 등록과 post-lock/evidence 정책 추가 |
| `backend/prisma/schema.prisma` | Quote.sourceAmount의 order/FX 구분 주석만 추가 |
| `backend/scripts/limit-order-idempotent-replay-integration.ts` | amount 기반 지정가 replay/hash conflict fixture |
| `backend/scripts/limit-order-matching-integration.ts` | historical candle finalization 시각 정합화 |
| `backend/scripts/order-input-policy-integration.ts` | 양 계좌·국내/미국/crypto 정책 및 실제 금융 DB runner |
| `backend/scripts/trading-tradability-integration.ts` | crypto BUY amount로 금융 권한 회귀 유지 |
| `backend/scripts/trading-transaction-time-integration.ts` | amount intent/정수 limit 및 제출 이후 snapshot fixture, 기존 lock 경계 보존 |
| `backend/src/mvp-flow.integration.spec.ts` | MVP crypto BUY amount 계약 fixture |
| `backend/src/orders/general-account-trading.integration.spec.ts` | General amount 거래/재시도 및 제출 이후 가격 fixture |
| `backend/src/orders/limit-order-candle-evidence.service.ts` | 봉 시각/전체 5분/현재 캘린더 검증 |
| `backend/src/orders/limit-order-create-no-redis.integration.spec.ts` | Redis 없이 amount 지정가 등록 검증 |
| `backend/src/orders/limit-order-create-race.integration.spec.ts` | amount durable Quote/동시성 fixture |
| `backend/src/orders/limit-order-create.service.spec.ts` | 확정 CLOSED 등록 성공 및 amount quote 기대값 |
| `backend/src/orders/limit-order-execution.service.ts` | fill transaction에서 제출·미래·calendar evidence 재검증 |
| `backend/src/orders/limit-order-matching.liveness.spec.ts` | backlog 주문과 snapshot 시각을 현실적인 제출 경계로 수정 |
| `backend/src/orders/limit-order-matching.service.ts` | Path A scan의 submittedAt 하한 |
| `backend/src/orders/limit-order-transaction-time.integration.spec.ts` | lock 대기 후 CLOSED 등록 성공, TTL/end 실패 유지 |
| `backend/src/orders/market-hours.policy.ts` | 등록용 orderType별 OPEN/CLOSED/calendar unavailable 구분 |
| `backend/src/orders/order-input-policy.integration.spec.ts` | 새 DB runner의 opt-in Jest 연결 |
| `backend/src/orders/order-input-policy.spec.ts` | 정책/내림/hash matrix 36 unit tests |
| `backend/src/orders/order-input-policy.ts` | 자산/side별 intent 검증, 주식 정수 제한, 금액 기반 수량 내림 |
| `backend/src/orders/order-replay-and-cancel-scope.integration.spec.ts` | amount replay/conflict 및 기존 cancel scope 회귀 |
| `backend/src/orders/orders.service.spec.ts` | amount Quote/Create 및 최종 quantity 저장 assertion |
| `backend/src/orders/orders.service.ts` | amount parsing, durable intent/validation/hash, 실행 수량 확정 및 저장, 세션 재검증 |
| `backend/src/providers/durable-quote.policy.ts` | order quote amount hash, quantity v1 호환 보존 |
| `backend/src/seasons/trading-account-trading-scope.integration.spec.ts` | 제출 이후 provider snapshot으로 scope/체결 회귀 유지 |
| `frontend/docs/indicative-preview-review.md` | 현재 주문 preview 권한 분리 설명, FX 이력 보존 |
| `frontend/src/features/order/api.ts` | amount 또는 quantity DTO와 quote amount 응답 |
| `frontend/src/features/order/orderDisplayContract.test.ts` | 기존 raw input 구조 assertion의 state명 갱신 |
| `frontend/src/features/order/validateOrderQuote.ts` | amount 동일성 및 서버 quantity 양수 검증 |
| `frontend/src/features/tradingAccount/indicativePreview.ts` | 원금/수수료/참고 수량 및 실제 fee 기반 amount 비율 계산 |
| `frontend/src/models/enums/errorCode.ts` | 신규 입력/소수 지정가/가격 오류 코드 |
| `frontend/src/screens/asset/assetPriceDiagnostics.test.ts` | crypto stale 예상 수량 안내/금액 비율 동작 회귀 |
| `frontend/src/screens/asset/inlineTrading.test.ts` | 양 모드·BUY/SELL·market/limit 실제 payload/성공 검증 |
| `frontend/src/screens/asset/tradingControls.test.ts` | amount 비율과 stock price 의존성 회귀 |
| `frontend/src/screens/order/OrderPanel.tsx` | amount UX/서버 수량/preview gate 제거/정수 검증/세션 안내 |
| `frontend/src/screens/order/QuantityRatioSlider.tsx` | native amount 비율 접근성 label |
| `frontend/src/screens/order/QuantityRatioSlider.web.tsx` | web amount 비율 접근성 label |
| `frontend/src/screens/order/orderInputPolicy.test.ts` | 실제 React 주문 정책 행동 25 tests |
| `frontend/src/screens/order/quantityRatio.test.ts` | amount/stock integer 비율 및 pending/scope 회귀 |
| `frontend/src/services/api/errorMapper.ts` | 정책 오류 한국어 안내 |
| `frontend/test/inlineTradingHarness.cjs` | 서버 amount quote 응답/quantity fixture와 계좌 fee override |
