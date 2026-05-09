# current-status.md

## 1. 현재 상태

- 개발환경 세팅 완료.
- Nest + Prisma + PostgreSQL 연결 완료.
- 기존 migration/seed 적용 완료.
- health API 완료.
- Prisma 7 + `prisma.config.ts` + adapter 방식 유지 중.
- 기존 migration/seed 임의 변경 금지.
- fake 데이터 기반 계산 금지.
- fake/static/temporary/sample/test business FX rate 금지.

## 2. 구현 완료 API

- `POST /api/v1/auth/signup` access-token-only Auth MVP
- `POST /api/v1/auth/login` access-token-only Auth MVP
- `GET /api/v1/me` access-token-only Auth MVP
- `GET /api/v1/home` read-only MVP
- `GET /api/v1/ranking` read-only MVP
- `GET /api/v1/wallets` read-only MVP
- `GET /api/v1/records` read-only MVP
- `GET /api/v1/orders` read-only MVP
- `POST /api/v1/orders/quote` read-only MVP
- `POST /api/v1/orders` submitted order create MVP
- `POST /api/v1/orders` create idempotency MVP
- `POST /api/v1/orders/:orderId/cancel` submitted order cancel MVP
- `POST /api/v1/orders/:orderId/execute` full-fill MVP
- `GET /api/v1/seasons/current`
- `POST /api/v1/seasons/{seasonId}/join`
- `POST /api/v1/fx/quote`
- `POST /api/v1/fx/execute` 1차 구현 완료
  - write path는 구현됨.
  - 실제 PostgreSQL/Prisma DB integration spec 통과.
  - 실제 PostgreSQL transaction 내부 DB-level failure injection 기반 rollback proof 일부 보강 완료.
  - `responsePayloadJson` storage 단독 DB-level failure injection 등 일부 hardening은 남아 있음.

## 3. 현재 구조

- Nest
- Prisma 7 adapter 방식
- PostgreSQL (Docker)
- Redis (Docker)

## 4. 현재 인증 상태

- access-token-only Auth MVP 구현 완료.
- `POST /api/v1/auth/signup`, `POST /api/v1/auth/login`, `GET /api/v1/me` 구현 완료.
- `POST /api/v1/auth/signup`은 명시적으로 `201 Created`.
- `POST /api/v1/auth/login`은 명시적으로 `200 OK`.
- 전역 access token guard가 JWT를 검증하고 DB의 active user를 확인한 뒤 `request.user = { userId }`를 주입.
- 보호 API에서 사용자 식별자는 계속 `request.user.userId` 기준.
- `JWT_ACCESS_SECRET`이 없으면 앱은 fail closed.
- `JWT_ACCESS_TTL`은 공백 없는 숫자+단위 문자열만 허용.
  - 허용 단위: `s`, `m`, `h`, `d`, `w`.
  - 허용 예: `30s`, `15m`, `1h`, `7d`, `2w`.
  - 금지 예: `900`, `15 m`, `500ms`, `1y`, 빈 문자열.
- `GET /api/v1/seasons/current`는 optional auth:
  - Authorization header가 없으면 anonymous 허용.
  - Authorization header가 있으면 반드시 검증하며 invalid/expired/malformed token은 anonymous downgrade 없이 `UNAUTHORIZED`.
- public route:
  - AppController health route.
  - `POST /api/v1/auth/signup`.
  - `POST /api/v1/auth/login`.
- inactive user:
  - missing/invalid/expired/forged token 또는 unknown user는 `UNAUTHORIZED`.
  - `User.status`가 `suspended` 또는 `deleted`이면 `FORBIDDEN` + `USER_NOT_ACTIVE`.
- refresh token, session/cookie auth, token revocation/logout은 아직 미구현.
- `x-user-id` fallback 없음 유지.

## 5. 현재 DB 상태

실제 존재 확인 기준:

- `users`
- `seasons`
- `season_participants`
- `cash_wallets`
- `wallet_transactions`
- `exchange_transactions`
- `equity_snapshots`
- `fx_rate_snapshots`
- `fx_execute_requests`
- `assets`
- `asset_price_snapshots`
- `positions`
- `orders`
- `daily_portfolio_snapshots`
- `season_rankings`

near-term ledger/FX foundation:

- `wallet_transactions`: Prisma schema 반영, migration 생성/DB 적용 완료, season join initial_grant write path 구현 완료.
- `exchange_transactions`: Prisma schema 반영, migration 생성/DB 적용 완료, `/fx execute` 1차 write path에서 생성.
- `equity_snapshots`: Prisma schema 반영, migration 생성/DB 적용 완료, API/write path 미구현.
- `/fx` DB foundation 반영 완료: `fx_rate_snapshots`, `fx_execute_requests`, `exchange_transactions.fxRateSnapshotId`.
- `/fx` migration 생성 및 로컬 DB 적용 완료: `20260501212120_add_fx_rate_and_execute_safety_tables`.
- asset/price/position foundation 반영 완료: `assets`, `asset_price_snapshots`, `positions`.
- asset/price/position migration 생성 및 로컬 DB 적용 완료: `20260507120158_add_asset_price_position_foundation`.
- valuation/ranking foundation 반영 완료: `daily_portfolio_snapshots`, `season_rankings`.
- valuation/ranking foundation migration 생성 및 로컬 DB 적용 완료: `20260507121528_add_daily_portfolio_snapshot_and_ranking_foundation`.
- order storage foundation 반영 완료: `orders`, `OrderSide`, `OrderType`, `OrderStatus`.
- order foundation migration 생성 완료: `20260508093000_add_order_foundation`.
- order foundation migration 로컬 DB 적용 완료: `20260508093000_add_order_foundation`.
- order create idempotency migration 생성 및 로컬 DB 적용 완료: `20260508110000_add_order_create_idempotency`.
- DB catalog 확인 완료:
  - `orders` table 존재.
  - `OrderSide`, `OrderType`, `OrderStatus` enum 존재.
  - orders index/FK 생성 확인.
  - Prisma Client `prisma.order.count()` 접근 확인.
- `/orders` read-only MVP 구현 완료: 기존 `orders` row만 조회하며 주문 생성/체결/wallet/position/settlement mutation 없음.
- `/orders/quote` read-only MVP 구현 완료:
  - active season + joined participant만 허용.
  - market order는 latest eligible `admin_manual` asset price snapshot 사용.
  - limit order는 `limitPrice` 사용.
  - USD 자산은 approved fresh `admin_manual` USD/KRW FX snapshot 필요.
  - buy는 cash wallet balance, sell은 position quantity를 read-only로 검증.
  - DB mutation 없음.
- `POST /api/v1/orders` submitted order create MVP 구현 완료:
  - quote와 동일 계산/검증 후 `orders` row 1건만 `submitted`로 생성.
  - body `idempotencyKey` required.
  - 동일 participant + 동일 `idempotencyKey` + 동일 canonical requestHash는 stored `responsePayloadJson` replay.
  - 동일 participant + 동일 `idempotencyKey` + 다른 requestHash는 `ORDER_IDEMPOTENCY_CONFLICT`.
  - `(seasonParticipantId, idempotencyKey)` unique constraint와 P2002 reread로 duplicate order create 방지.
  - wallet debit/credit, wallet_transactions, position mutation, equity snapshot, settlement 없음.
  - 저장된 gross/fee/net amount는 체결 확정 금액이 아니라 제출 시점 quote estimate.
- `POST /api/v1/orders/:orderId/cancel` submitted order cancel MVP 구현 완료:
  - 로그인 사용자의 season participant 소유 order만 cancel 가능.
  - `submitted` 상태만 `canceled`로 변경 가능.
  - guarded update 조건: `id + seasonParticipantId + status = submitted`.
  - order row의 `status`, `canceledAt`, `updatedAt`만 변경.
  - wallet debit/credit, wallet_transactions, position mutation, equity snapshot, settlement 없음.
- `POST /api/v1/orders/:orderId/execute` full-fill MVP 구현 완료:
  - 로그인 사용자의 season participant 소유 active-season order만 execute 가능.
  - `submitted` order만 buy/sell full-fill execute.
  - `executed` order는 새 mutation 없이 current-state duplicate response 반환.
  - `canceled`/`rejected` order는 `ORDER_NOT_EXECUTABLE`.
  - market/limit 모두 execution 시점 latest eligible `admin_manual` asset price snapshot 사용.
  - limit buy는 selected price `<= limitPrice`, limit sell은 selected price `>= limitPrice`일 때만 execute.
  - actual `executedPrice`는 selected snapshot price이며 submitted estimate/limitPrice를 그대로 쓰지 않음.
  - USD order는 USD wallet debit/credit을 사용하고, audit consistency용 approved fresh `admin_manual` USD/KRW snapshot id를 저장.
  - KRW order는 `fxRateSnapshotId = null`.
  - buy는 guarded cash wallet debit, position create/update, `order_buy` wallet transaction, guarded executed finalization 수행.
  - sell은 guarded position decrement, realizedPnl update, cash wallet credit, `order_sell` wallet transaction, guarded executed finalization 수행.
  - wallet mutation, position mutation, wallet transaction create, order finalization은 단일 Prisma transaction 안에서 처리.
  - create idempotency용 `responsePayloadJson`은 execute replay에 사용하지 않음.
  - exact execute response replay, partial fill, matching engine, settlement, provider/scheduler, separate fee wallet transaction row 없음.
  - equity_snapshots, daily_portfolio_snapshots, season_rankings 자동 생성 없음.
- `/records` orders section은 `orders` table 기반 read-only 조회로 연결 완료.
- `admin_manual` asset/price bootstrap CLI 구현 완료:
  - `scripts/admin-upsert-asset.ts`
  - `scripts/admin-insert-asset-price.ts`
  - dry-run, validation, asset existence/isActive/currency match check 지원.
- valuation/ranking 수동 foundation 구현 완료:
  - portfolio valuation 계산 service/helper: `src/portfolio/portfolio-valuation.service.ts`, `src/portfolio/portfolio-valuation.policy.ts`.
  - daily portfolio snapshot 수동 생성 CLI: `scripts/admin-generate-daily-portfolio-snapshot.ts`.
  - season ranking 수동 생성 CLI: `scripts/admin-generate-season-ranking.ts`.
  - CLI는 dry-run/non-dry-run을 지원하며 seed/fake/static/sample business data를 생성하지 않음.

## 6. 현재 미도입 DB 상태

- Prisma schema/migration 기준 현재 문서화된 핵심 DB foundation 추가 미도입 테이블 없음.
- order execution full-fill MVP와 position mutation 1차 write path는 구현 완료. 단, exact replay, durable quote, partial fill, matching engine, provider price ingestion, settlement API, scheduler/batch 기반 자동 daily valuation/ranking 생성 경로는 아직 미구현.

## 7. 완료된 문서/설계 상태

- `/home` 상태별 응답 계약 초안: `docs/home-api-contract.md`.
- `/ranking` read-only MVP 계약: `docs/ranking-api-contract.md`.
- `/wallets` read-only MVP 계약: `docs/wallets-api-contract.md`.
- `/orders` read-only MVP 계약: `docs/orders-api-contract.md`.
- `/orders` quote/create MVP 계약: `docs/orders-api-contract.md`.
- `/orders` cancel MVP 계약: `docs/orders-api-contract.md`.
- `/orders` execution safety plan: `docs/order-execution-safety-plan.md`.
- `/orders` execution preimplementation readiness audit: `docs/order-execution-preimplementation-readiness-audit.md`.
- records API 계약: `docs/records-api-contract.md`에 submitted/executed/canceled order 및 order wallet transaction 조회 가능 상태 반영.
- `/fx quote` STOP review: `docs/fx-quote-stop-review.md`.
- `/fx` API 계약 초안: `docs/fx-api-contract.md`.
- FX rate input path plan: `docs/fx-rate-input-path-plan.md`.
- FX rate ingestion plan: `docs/fx-rate-ingestion-plan.md`.
- FX ingestion STOP review: `docs/fx-ingestion-stop-review.md`.
- FX provider 후보 공식 문서 기반 조사: `docs/fx-provider-research.md`.
- FX provider final selection STOP review: `docs/fx-provider-final-selection-stop-review.md`.
- `/fx execute` safety plan: `docs/fx-execute-safety-plan.md`.
- wallet/FX write path plan: `docs/wallet-fx-write-path-plan.md`.
- `/fx execute` preimplementation readiness audit: `docs/fx-execute-preimplementation-readiness-audit.md`.
- `/fx execute` STOP decision tracker: `docs/fx-execute-stop-decision-tracker.md`.
- FX Decimal rounding/scale policy: `docs/fx-decimal-rounding-scale-policy.md`.
- FX execute error policy: `docs/fx-execute-error-policy.md`.
- FX idempotency lifecycle policy: `docs/fx-idempotency-lifecycle-policy.md`.
- `/fx execute` final implementation gate: `docs/fx-execute-final-implementation-gate.md`.

## 8. 주요 STOP 상태

### `/fx quote`

- `POST /api/v1/fx/quote` read-only 구현 완료.
- `/fx quote`는 USD/KRW `fx_rate_snapshots`를 읽음.
- `/fx quote`는 wallet mutation 없음.
- `/fx quote`는 `exchange_transactions`, `wallet_transactions`, `fx_execute_requests`, `equity_snapshots` 생성을 하지 않음.
- snapshot 없음이면 `FX_RATE_UNAVAILABLE`.
- selected snapshot `effectiveAt`이 quote 시점 기준 60초 초과 stale이면 `FX_RATE_STALE`.
- quote response는 `quoteId = null`, `expiresAt = null`, `rateCapturedAt`, `rateEffectiveAt` 포함.
- 승인된 `admin_manual` USD/KRW snapshot 기준 `/fx quote` 통합 smoke 검증 통과.
  - CLI dry-run 후 non-dry-run snapshot 입력 성공.
  - 입력 snapshot: rate `1450.00000000`, sourceType/sourceName `admin_manual`, approvedByUserId `usr_dev_001`, effectiveAt/capturedAt `2026-05-07T10:01:53.000Z`.
  - smoke 당시 fresh 조건 통과: `ageMsAtCheck = 41822`로 60초 이내.
  - access-token-only Auth MVP 이전 smoke였으므로 HTTP 대신 실제 Prisma/PostgreSQL을 사용하는 `FxService.quote(userId, body)` 직접 호출 검증.
  - KRW -> USD, USD -> KRW 양방향 quote 성공.
  - quote 응답의 `quoteId = null`, `expiresAt = null`, `rateCapturedAt`, `rateEffectiveAt` 확인.
  - quote 전후 mutation 없음 확인: `exchange_transactions 0 -> 0`, `wallet_transactions 1 -> 1`, `fx_execute_requests 0 -> 0`, `equity_snapshots 0 -> 0`.

### FX rate input/provider

- `admin_manual` FX rate input CLI 구현 완료: `scripts/admin-insert-fx-rate.ts`.
- `admin_manual`은 bootstrap/fallback/manual correction 경로.
- `/fx quote` smoke용 승인된 `admin_manual` snapshot 1건 입력 및 소비 검증 완료.
- 입력한 manual snapshot은 smoke 당시 fresh였지만 60초 이후에는 정책상 stale이 되므로, 지속적인 quote 성공에는 별도 승인 snapshot 입력 또는 향후 ingestion 경로가 필요함.
- provider_api/official_batch/scheduler 구현 없음.
- provider final selection은 아직 확정 아님.
- OANDA는 primary candidate, Twelve Data는 secondary candidate.
- OANDA trial/API 계약 검증 전 provider implementation STOP.
- 30초 polling은 후보이며 provider rate limit/terms 확인 후 확정.

### Asset/price input

- `admin_manual` asset upsert CLI 구현 완료: `scripts/admin-upsert-asset.ts`.
- `admin_manual` asset price snapshot input CLI 구현 완료: `scripts/admin-insert-asset-price.ts`.
- asset upsert는 `(market, symbol)` unique 기준으로 create/update.
- asset price input은 `asset_price_snapshots.sourceType = admin_manual`만 허용.
- asset price input은 asset 존재, active 상태, asset currency와 price currency 일치를 검증.
- 두 CLI 모두 dry-run을 지원하며, seed/fake/static/sample data를 추가하지 않음.
- 이 작업으로 운영자 승인 수동 asset/price bootstrap 경로는 생겼고, 별도 수동 valuation/ranking 생성 경로도 추가됨.
- 자동 가격 공급/provider ingestion/scheduler/API 응답 생성은 아직 없음.
- provider_api/official_batch/scheduler 기반 price ingestion 구현 없음.
- asset price freshness threshold는 아직 최종 정책 미확정.
  - near-term valuation은 `admin_manual` sourceType이고 `effectiveAt <= valuationAt`인 최신 price snapshot만 선택함.
  - stale/freshness 기준은 TODO로 남아 있으며 provider/official_batch 사용은 아직 허용하지 않음.

### Valuation/ranking manual foundation

- Portfolio valuation 계산 foundation 구현 완료.
- 계산 대상:
  - KRW cash wallet.
  - USD cash wallet.
  - positions.
  - latest eligible `admin_manual` asset price snapshot.
  - USD 환산이 필요한 경우 approved fresh `admin_manual` USD/KRW FX snapshot.
- 계산 정책:
  - 금융 값은 문자열로 반환.
  - JS number 금액 계산 금지, `Prisma.Decimal` 기반 계산.
  - monetary scale 8, returnRate scale 8 기준 formatting.
  - `totalAssetKrw = krwCash + usdCashKrw + assetValueKrw`.
  - `returnRate = (totalAssetKrw - initialCapitalKrw) / initialCapitalKrw`.
  - `realizedPnlKrw`는 positions.realizedPnl 합산 후 USD 자산은 USD/KRW 환산.
  - `unrealizedPnlKrw`는 `(currentPrice - averageCost) * quantity` 후 USD 자산은 USD/KRW 환산.
  - initialCapitalKrw가 0 이하이면 error.
  - price snapshot이 없으면 fake price 없이 error.
  - USD 환산이 필요한데 approved fresh FX snapshot이 없거나 stale이면 error.
- Daily portfolio snapshot 수동 생성 CLI 구현 완료: `scripts/admin-generate-daily-portfolio-snapshot.ts`.
  - 옵션: `--season-participant-id` 또는 `--season-id`, `--snapshot-date`, `--captured-at`, `--dry-run`.
  - `(seasonParticipantId, snapshotDate)` unique 기준 upsert.
  - 단일 participant 모드는 missing data 발생 시 fail.
  - season 전체 모드는 active participants별 실패를 보고하고 성공 가능한 participant만 처리.
- Season ranking 수동 생성 CLI 구현 완료: `scripts/admin-generate-season-ranking.ts`.
  - 옵션: `--season-id`, `--ranking-date`, `--rank-type`, `--dry-run`.
  - rankingDate의 `daily_portfolio_snapshots`만 읽음.
  - 정렬 기준: `totalAssetKrw desc`, `returnRate desc`, `capturedAt asc`, `seasonParticipantId asc`.
  - rank는 1부터 순차 부여.
  - 기존 ranking row는 transaction 안에서 임시 음수 rank로 이동한 뒤 `(seasonId, rankType, rankingDate, seasonParticipantId)` unique 기준 upsert하여 rank unique 충돌을 피함.
- 이 작업은 `/home`과 `/ranking` 구현 준비를 진전시켰지만, 자동 데이터 생성/외부 시세 공급/API 응답은 아직 없음.
- scheduler/batch/provider ingestion/settlement 구현 없음.
- order quote/create/cancel/execute full-fill MVP 구현 완료.
- order execution safety plan/preimplementation readiness audit 기준 full-fill MVP 범위는 코드에 반영됨.
- order execution exact replay/partial fill/matching engine/settlement/provider ingestion은 별도 gate로 남음.

### `/fx execute`

- `/fx execute`는 write path 1차 구현 완료 상태.
- 실제 PostgreSQL/Prisma DB integration spec 통과 상태.
- 구현된 범위:
  - request validation/preflight.
  - active season/participant read.
  - idempotency existing command short-circuit.
  - approved fresh `admin_manual` FX snapshot selection.
  - source/target wallet candidate read.
  - pending `fxExecuteRequest` 생성.
  - guarded conditional source debit.
  - target wallet credit.
  - `exchangeTransaction` 생성.
  - source/target `walletTransaction` 생성.
  - `fxExecuteRequest` succeeded finalization.
  - exact `responsePayloadJson` 저장.
  - succeeded duplicate replay.
- 실제 DB integration 통과 범위:
  - KRW -> USD success write path.
  - succeeded duplicate stored `responsePayloadJson` replay.
  - same idempotencyKey + different payload conflict.
  - insufficient balance no-mutation behavior.
  - no eligible snapshot `FX_RATE_UNAVAILABLE`.
  - stale snapshot `FX_RATE_STALE`.
  - concurrent overspend prevention: one success only, source balance non-negative.
  - concurrent same user + same idempotencyKey + same requestHash race: duplicate request replays stored `responsePayloadJson`; wallet/exchange/ledger mutation은 1회만 발생.
  - exchange row, source/target ledger rows, ledger `balanceAfter`, no fee row, no `equitySnapshot` checks.
- rollback/partial-write proof 상태:
  - unit/mock 기반 transaction rollback proof는 보강됨:
    - source debit failure.
    - target credit failure.
    - exchange row create failure.
    - source ledger create failure.
    - target ledger create failure.
    - `fxExecuteRequest` succeeded finalization / `responsePayloadJson` storage failure.
    - 각 실패에서 staged transaction writes가 commit되지 않음을 검증.
  - 실제 PostgreSQL DB-level transaction rollback proof는 일부 보강됨:
    - pending command 생성 후 source wallet이 transaction 내부에서 사라지는 source debit failure.
    - target wallet credit numeric overflow failure.
    - selected `fx_rate_snapshots` row가 transaction 내부에서 사라지는 `exchange_transactions` FK failure.
    - source wallet이 transaction 내부에서 사라지는 source `wallet_transactions` FK failure.
    - target wallet이 transaction 내부에서 사라지는 target `wallet_transactions` FK failure.
    - `exchange_transactions` row가 transaction 내부에서 사라지는 `fx_execute_requests` finalization FK failure.
    - 각 실패 후 source/target wallet balance, `exchange_transactions`, `wallet_transactions`, succeeded finalization, `responsePayloadJson`, `equity_snapshots`, injected snapshot deletion의 partial commit 없음 검증.
  - 남은 DB-level hardening/리스크:
    - `responsePayloadJson` storage 단독 실패는 현 schema/service 변경 없이 실제 DB 제약으로 안정적으로 유도하기 어려워 보류.
    - ledger insert 실패는 현재 schema상 `referenceId` FK가 없어서 wallet FK deletion 기반으로만 검증됨.
    - 더 많은 운영형 interleaving/장애 시나리오는 별도 recovery 설계 전까지 보류.
- Decimal rounding mode와 scale/formatting 정책은 half-up 기준으로 구현 반영됨.
- requestHash canonical rule은 SHA-256/canonical JSON 기준으로 구현 반영됨.
- error code/status/retryability mapping은 구현 반영됨.
- `idempotencyKey` required 정책은 구현 반영됨.
- pending/succeeded/failed MVP lifecycle은 구현 반영됨.
- stale pending automatic re-execution 금지는 구현 반영됨.
- wallet safety strategy는 guarded conditional source debit MVP 기본 전략으로 구현 반영됨.
- affected row count 0 classification은 구현 반영됨.
- source/target wallet update order는 구현 반영됨.
- `wallet_transactions.balanceAfter` source of truth는 actual post-update wallet balance로 구현 반영됨.
- rollback/partial-write test gate는 unit scaffold와 DB integration 검증 대상으로 남아 있음.
- provider/sourceType coexistence policy는 구현 반영됨.
- near-term allowed execute sourceType은 approved fresh `admin_manual` only.
- `provider_api`는 provider final selection + ingestion implementation approval 전까지 execute source로 허용하지 않음.
- `official_batch`는 settlement/reference/reconciliation 후보이며 real-time execute source가 아님.
- execute-time snapshot selection은 구현 반영됨: allowed sourceType only, USD/KRW, `effectiveAt <= executeNow`, positive rate, order by `effectiveAt desc`, `capturedAt desc`, `createdAt desc`.
- execute-time freshness rule은 구현 반영됨: `> 60_000ms` stale, exactly 60s accepted.
- final implementation test matrix는 `docs/fx-execute-final-implementation-gate.md`에 문서화됨.
- succeeded duplicate replay는 stored `responsePayloadJson`를 사용.
- failed duplicate는 자동 재실행하지 않음.
- stale pending은 recovery-required behavior를 반환.
- idempotency는 `fx_execute_requests`가 소유.
- `exchange_transactions.idempotencyKey`는 없음.
- near-term execute는 `equity_snapshots`를 생성하지 않음.
- MVP execute는 별도 fee wallet transaction row를 만들지 않음.
- target wallet credit은 `netTargetAmount`.
- provider_api ingestion, official_batch ingestion, scheduler, provider final selection, stale pending recovery tool/job, durable quote, settlement는 여전히 미구현.
- DB integration 검증은 Docker compose의 기존 Postgres/Redis 컨테이너로 수행됨.
- DB 연결 확인과 migration status 확인 성공.
- `pnpm test`, `pnpm build`, `FX_EXECUTE_DB_INTEGRATION=1 pnpm test -- fx.execute.integration.spec.ts` 통과.
- schema/migration/seed/package/env/controller/service/test 변경 없이 검증됨.
- integration spec 삭제/skip/완화 또는 assertion 완화 없음.
- 최초 sandbox 내부 실행은 `/tmp/tsx-1000/*.pipe` IPC `EPERM`으로 실패했으나, sandbox 제한 문제로 판단했고 sandbox 밖 동일 명령 재실행으로 실제 PostgreSQL integration 통과.

### `/home`

- `GET /api/v1/home` read-only MVP 구현 완료.
- access-token-only Auth MVP 이후 API는 전역 guard가 주입한 `request.user.userId`만 사용하며 `x-user-id` fallback 없음.
- 구현된 mode:
  - `active_joined`
  - `active_not_joined`
  - `upcoming`
  - `ended`
  - `settled`
  - `no_current_season`
- active joined summary source:
  - 최신 `daily_portfolio_snapshots` 우선.
  - daily snapshot이 없으면 `PortfolioValuationService.calculateSeasonParticipantValuation()` 기반 live valuation 시도.
  - valuation에 필요한 asset price 또는 FX snapshot이 없으면 fake 값 없이 `summary.state = unavailable`.
- ranking source:
  - 최신 `season_rankings`를 read-only로 조회.
  - ranking row가 없으면 fake rank 없이 `ranking.state = unavailable`.
  - `/home` 호출 중 ranking 생성 없음.
- wallet/position summary:
  - cash wallets와 positions/openPositions count만 read-only로 반환.
  - 상세 positions, allocation, topPositions, equityChart 계산은 MVP에서 unavailable.
- `/home` 호출은 wallet/position/snapshot/ranking row를 생성/수정/삭제하지 않음.
- full home implementation blocker:
  - provider price ingestion
  - asset price freshness policy
  - order execution 이후 자동 daily portfolio snapshot/ranking 생성 정책
  - scheduler/batch daily portfolio snapshot 자동 생성
  - scheduler/batch season ranking 자동 생성
  - scheduler/batch
- `/home` read-only MVP는 fake 데이터 기반 계산 금지를 유지.

### `/ranking`

- `GET /api/v1/ranking` read-only MVP 구현 완료.
- access-token-only Auth MVP 이후 API는 전역 guard가 주입한 `request.user.userId`만 사용하며 `x-user-id` fallback 없음.
- query parameter:
  - `seasonId` optional.
  - `rankingDate` optional, `YYYY-MM-DD`.
  - `rankType` optional, default `daily`, allowed `daily`/`final`.
  - `limit` optional, default 50, max 100 clamp.
  - `offset` optional, default 0.
- source of truth:
  - `season_rankings`만 read-only로 조회.
  - `daily_portfolio_snapshots` 기반 즉석 ranking 계산 없음.
  - `season_participants.currentRank`를 source of truth로 사용하지 않음.
- ranking row가 없으면 fake rank 없이 `data.state = unavailable`.
- `myRanking`은 로그인 사용자의 `season_participants` 기준:
  - 미참가면 `state = not_joined`.
  - 참가했지만 ranking row가 없으면 `state = unavailable`.
  - row가 있으면 `state = available`.
- `/ranking` 호출은 ranking row를 생성/수정/삭제하지 않음.
- 아직 미구현:
  - scheduler/batch 기반 season ranking 자동 생성.
  - 고급 필터/기간별 ranking/시즌 히스토리.
  - reward/settlement 연동.

### `/wallets`

- `GET /api/v1/wallets` read-only MVP 구현 완료.
- access-token-only Auth MVP 이후 API는 전역 guard가 주입한 `request.user.userId`만 사용하며 `x-user-id` fallback 없음.
- current season 선택 우선순위는 `/home`, `/ranking`과 동일: active, upcoming, ended, settled.
- joined participant가 있으면 season status와 무관하게 기존 `cash_wallets`를 read-only로 조회.
- 미참가면 fake wallet 없이 `state = not_joined`, no current season이면 `state = unavailable`.
- wallet balance 재계산, FX 환산 valuation, wallet 생성/수정 없음.
- `/wallets` 호출은 wallet row를 생성/수정/삭제하지 않음.

### `/records`

- `GET /api/v1/records` read-only MVP 구현 완료.
- access-token-only Auth MVP 이후 API는 전역 guard가 주입한 `request.user.userId`만 사용하며 `x-user-id` fallback 없음.
- query parameter:
  - `seasonId` optional.
  - `type` optional, default `all`, allowed `all`/`exchanges`/`wallets`/`orders`.
  - `limit` optional, default 50, max 100 clamp.
  - `offset` optional, default 0.
  - `currencyCode` optional, allowed `KRW`/`USD`.
- records source:
  - `exchange_transactions`
  - `wallet_transactions`
  - `orders`
- access control:
  - 로그인 사용자의 `season_participants` 기준으로만 조회.
  - 미참가면 records 배열을 비우고 `state = not_joined`.
- order records:
  - `orders` table 기반 read-only 조회로 연결 완료.
  - order row가 없으면 fake 없이 `orders.state = available`, empty records.
  - `POST /api/v1/orders`로 생성된 submitted order 조회 가능.
  - `POST /api/v1/orders/:orderId/cancel`로 canceled 처리된 order 조회 가능.
  - `POST /api/v1/orders/:orderId/execute`로 executed 처리된 order 조회 가능.
- wallet transaction records:
  - order execute가 생성한 `order_buy`/`order_sell` wallet transaction 조회 가능.
- `/records` 호출은 exchange/wallet/order row를 생성/수정/삭제하지 않음.
- 아직 미구현:
  - full records filters/export/detail views.

### `/orders`

- `GET /api/v1/orders` read-only MVP 구현 완료.
- `POST /api/v1/orders/quote` read-only MVP 구현 완료.
- `POST /api/v1/orders` submitted order create MVP 구현 완료.
- `POST /api/v1/orders` create idempotency MVP 구현 완료.
- `POST /api/v1/orders/:orderId/cancel` submitted order cancel MVP 구현 완료.
- `POST /api/v1/orders/:orderId/execute` full-fill MVP 구현 완료.
- access-token-only Auth MVP 이후 API는 전역 guard가 주입한 `request.user.userId`만 사용하며 `x-user-id` fallback 없음.
- query parameter:
  - `seasonId` optional.
  - `status` optional, allowed `submitted`/`executed`/`canceled`/`rejected`.
  - `side` optional, allowed `buy`/`sell`.
  - `assetId` optional.
  - `limit` optional, default 50, max 100 clamp.
  - `offset` optional, default 0.
- 로그인 사용자의 `season_participants` 기준으로만 `orders` row를 read-only 조회.
- 미참가면 order row를 조회하지 않고 `state = not_joined`.
- quote:
  - active season + joined participant만 허용.
  - asset 존재/isActive 확인.
  - quantity > 0, limit order는 limitPrice > 0 필요.
  - market order는 latest eligible `admin_manual` asset price snapshot 사용.
  - limit order는 `limitPrice`를 quote price로 사용.
  - asset price stale threshold는 아직 적용하지 않음.
  - USD 자산은 approved fresh `admin_manual` USD/KRW FX snapshot 사용, freshness 60초.
  - buy cash balance, sell position quantity를 read-only 검증.
  - DB mutation 없음.
- create:
  - quote와 동일 validation/calculation 후 `orders` row만 `submitted`로 생성.
  - `idempotencyKey` required.
  - requestHash는 `assetId`, `side`, `orderType`, `quantity`, `limitPrice`, `currencyCode` canonical JSON + SHA-256.
  - `idempotencyKey` 자체는 requestHash 대상에서 제외.
  - 동일 participant + 동일 key + 동일 hash는 stored `responsePayloadJson` replay.
  - 동일 participant + 동일 key + 다른 hash는 `ORDER_IDEMPOTENCY_CONFLICT`.
  - P2002 unique race 발생 시 기존 order를 reread 후 replay 또는 conflict.
  - cancel 이후 같은 idempotencyKey 재호출도 create command replay 정책상 stored create response를 우선 반환할 수 있음.
  - wallet 차감/증가, wallet transaction, position mutation, equity snapshot, settlement 없음.
- cancel:
  - path `orderId` required.
  - 소유자가 아니거나 없는 order는 `ORDER_NOT_FOUND`.
  - `submitted` order만 cancel 가능.
  - `executed`/`canceled`/`rejected` order는 `ORDER_NOT_CANCELABLE`.
  - race로 guarded update가 실패하면 `ORDER_CANCEL_CONFLICT`.
  - order row 상태만 `canceled`로 변경하고 `canceledAt` 기록.
  - wallet 차감/증가, wallet transaction, position mutation, equity snapshot, settlement 없음.
- execute:
  - path `orderId` required, body optional.
  - execute idempotencyKey는 받지 않음.
  - 소유자가 아니거나 없는 order는 `ORDER_NOT_FOUND`.
  - active season의 `submitted` order만 full-fill execute 가능.
  - `executed` order는 새 mutation 없이 current-state duplicate response 반환.
  - exact execute response replay는 현재 schema 제한으로 제공하지 않음.
  - market/limit execution price는 execution 시점 latest eligible `admin_manual` asset price snapshot 기준.
  - limit order는 selected market price crossing 조건을 만족해야 하며, selected price를 `executedPrice`로 저장.
  - buy는 cash wallet debit, position create/update, `order_buy` wallet transaction 생성.
  - sell은 position decrement/realizedPnl update, cash wallet credit, `order_sell` wallet transaction 생성.
  - order finalization은 `id + seasonParticipantId + status = submitted` guarded update.
  - 모든 financial write는 단일 Prisma transaction 안에서 처리.
  - equity snapshot, daily snapshot, ranking, settlement, provider/scheduler, partial fill 없음.
- settlement는 없음.

## 9. 다음 gate

- OANDA trial/API 계약 검증 전 provider_api/official_batch/scheduler 구현 STOP 유지.
- `/fx execute` 남은 DB-level rollback/partial-write hardening 및 stale pending/unknown outcome recovery 설계.
- `/orders/:orderId/execute` MVP 후속 gate:
  - exact execute response replay가 필요하면 schema/command table 별도 검토.
  - partial fill/matching engine/settlement/provider ingestion은 별도 설계 필요.
  - DB integration은 실제 PostgreSQL 환경에서 통과했으며, 향후 schema/transaction 변경 시 재검증 필요.
- `/home` full implementation 가능 판정은 자동 valuation/ranking 생성, provider ingestion, settlement 정책 이후 재검토.

## 10. 아직 안 한 것

- settlement
- refresh token/session management
- token revocation/logout
- 더 넓은 HTTP e2e coverage
- 운영 secret 관리
- order exact execute replay
- order partial fill/matching engine
- valuation/ranking 자동 생성 scheduler
- provider price ingestion
- automatic asset price ingestion
- daily portfolio snapshot 자동 생성 경로
- season ranking 자동 생성 경로
- provider_api ingestion
- official_batch ingestion
- scheduler
- admin API
- fx execute remaining DB-level rollback/recovery hardening
- stale pending recovery tool/job
- durable quote/quoteId/expiresAt

## 11. 마지막 검증 상태

- season current / season join / fx quote / fx execute unit 기준 test/build 통과.
- 승인된 `admin_manual` USD/KRW snapshot 기준 `/fx quote` 통합 smoke 통과.
  - snapshot 입력: `1450.00000000`, sourceType/sourceName `admin_manual`, approvedByUserId `usr_dev_001`, effectiveAt/capturedAt `2026-05-07T10:01:53.000Z`.
  - `FxService.quote(userId, body)` 직접 호출로 실제 PostgreSQL snapshot 소비 확인.
  - KRW -> USD, USD -> KRW 양방향 성공.
  - quote 전후 `exchange_transactions`, `wallet_transactions`, `fx_execute_requests`, `equity_snapshots` row count 증가 없음.
- join API는 `request.user.userId` 기준.
- join 시 KRW/USD wallet 2개 생성.
- 이번 asset/price/position 및 daily/ranking foundation 작업은 schema/migration/Prisma generated client 변경 포함.
- `/home` read-only MVP controller/service 구현 완료.
- Prisma adapter 방식 유지 중.
- near-term 1단계 migration DB 적용 완료.
- Prisma Client generate 완료.
- DB 연결 확인 성공.
- migration status 확인 성공.
- `assets`, `asset_price_snapshots`, `positions` foundation migration 생성 및 로컬 DB 적용 완료.
- `daily_portfolio_snapshots`, `season_rankings` foundation migration 생성 및 로컬 DB 적용 완료.
- `admin_manual` asset/price input CLI 구현 및 validation unit test 통과.
- `pnpm test` 통과.
- `pnpm build` 통과.
- access-token-only Auth MVP 검증:
  - `pnpm test -- auth` 통과.
  - `pnpm run test:e2e` 통과.
  - `AUTH_DB_SMOKE=1 pnpm test -- auth.integration.spec.ts`용 실제 PostgreSQL smoke spec 추가.
  - `AUTH_DB_SMOKE=1 pnpm test -- auth.integration.spec.ts` 통과.
  - DB smoke 검증 범위: 실제 Prisma user create, argon2 hash 저장/검증, login 성공, access token 발급, guard active user 확인, `me` 확인, suspended user `USER_NOT_ACTIVE`, cleanup.
  - `AUTH_DB_SMOKE=1`이 없으면 DB smoke는 명시적으로 disabled 상태로 통과하며 DB row를 생성하지 않음.
  - `GET /api/v1/home` missing token 차단, `GET /api/v1/seasons/current` optional auth, `GET /api/v1/me` token 인증 smoke 확인.
- `pnpm test -- seasons` 통과.
- `pnpm test -- home` 통과.
- `pnpm test -- ranking` 통과.
- `pnpm test -- wallets` 통과.
- `pnpm test -- records` 통과.
- `pnpm test -- fx.service.spec.ts` 통과.
- `FX_EXECUTE_DB_INTEGRATION=1 pnpm test -- fx.execute.integration.spec.ts` 통과.
- `/fx execute` DB integration spec은 실제 PostgreSQL 환경에서 통과.
- `/fx execute` DB integration spec에 concurrent same idempotencyKey race 검증 추가 통과.
- `/fx execute` DB integration spec에 실제 PostgreSQL transaction 내부 DB-level failure injection rollback proof 일부 보강 통과.
- `npm test -- orders.service.spec.ts records.service.spec.ts` 통과.
- `npm run build` 통과.
- `npx prisma validate` 통과.
- `npx prisma generate` 완료.
- `pnpm exec prisma validate` 통과.
- `pnpm exec prisma migrate status`에서 order foundation pending 확인 후 `pnpm exec prisma migrate dev`로 적용 완료.
- `pnpm exec prisma migrate status` 재확인: Database schema is up to date.
- Prisma raw query로 `orders` table, order enum, index, FK, `prisma.order.count()` 확인 완료.
- `pnpm test -- orders` 통과.
- `pnpm test -- records` 통과.
- `pnpm test -- orders --runInBand` 통과: order execute unit 포함, DB integration spec은 flag off로 skip.
- `pnpm test -- records --runInBand` 통과: order wallet transaction records unit 포함.
- `ORDER_EXECUTE_DB_INTEGRATION=1 pnpm test -- orders.execute.integration.spec.ts` 통과.
- `/orders execute` DB integration spec은 실제 PostgreSQL 환경에서 통과.
- `/orders execute` DB integration spec 검증 범위:
  - buy execution one transaction success.
  - sell execution one transaction success.
  - concurrent buy overspend prevention.
  - concurrent sell oversell prevention.
  - same order concurrent execute one success only.
  - cancel vs execute race one terminal state only.
  - rollback failure injection.
  - executed order and wallet transaction read visibility.
- sandbox 내부 `ORDER_EXECUTE_DB_INTEGRATION=1 pnpm test -- orders.execute.integration.spec.ts`는 `/tmp/tsx-1000/*.pipe` IPC `EPERM`으로 실패했으나, sandbox 밖 동일 명령 재실행으로 통과.
- `POST /api/v1/orders/:orderId/cancel` unit tests 통과.
- `POST /api/v1/orders` create idempotency unit tests 통과.
- `pnpm exec prisma migrate dev --name add_order_create_idempotency`로 order create idempotency migration 적용 완료.
- DB integration의 no eligible snapshot helper는 기존 eligible `admin_manual` snapshot 변경을 커밋하지 않도록 transaction rollback isolation 방식으로 개선됨.
- 코드/schema/migration/package/seed/test 변경 없이 `/fx quote` smoke 검증됨.
- integration/test assertion 완화 없음.
- sandbox 내부 `pnpm tsx`는 `/tmp/tsx-1000/*.pipe` IPC `EPERM`으로 실패했으나, sandbox 밖 재실행으로 dry-run, snapshot 입력, smoke 검증 통과.

## 12. TODO

- provider final selection STOP review 수락 및 OANDA trial/API 계약 검증.
- `/fx execute` 실제 DB transaction 내부 강제 실패 기반 rollback 검증 보강.
- ledger insert/exchange row/finalization 실패 유도 integration hardening 검토.
- 지속적인 `/fx quote` 성공을 위한 승인 snapshot 공급 운영 절차 또는 provider/batch ingestion 경로 검토.
- asset price ingestion/source/freshness 정책 설계.
- asset/price admin CLI 운영 승인 절차 정리.
- order execute exact replay/partial fill/matching engine은 별도 설계 필요.
- valuation/ranking 자동 생성 scheduler/API 연동 설계/구현.
- settlement 보상/확정 로직 설계/구현.
