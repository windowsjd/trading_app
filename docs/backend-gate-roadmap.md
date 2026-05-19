# Backend Gate Roadmap

## Status

- Documentation-only audit based on the current workspace state on 2026-05-11.
- Gate B provider readiness and asset price freshness policy were re-checked on 2026-05-12 as docs-only updates.
- Gate C/D live provider fixture capture was re-checked on 2026-05-13 as a docs/fixture-only blocked pass because credentials were unavailable.
- Crypto MVP policy changed on 2026-05-14 to Binance-based USD-settled crypto using the USD Wallet. Upbit/Bithumb are excluded from MVP, and Binance BTCUSDT public ticker/orderbook fixtures have been captured.
- Gate C provider fixture capture prep on 2026-05-14 captured Binance public `BTCUSDT` ticker/orderbook fixtures and fixed residual crypto freshness wording; OANDA/Twelve Data fixtures remain credential-blocked.
- No source, test, package, Prisma schema, migration, seed, provider, scheduler, settlement, reward, or refresh-token implementation is authorized by this document.
- `docs/current-status.md` remains the short status summary. This document is the detailed backend gate roadmap.

## Audit Basis

Current source-of-truth and active reference documents:

- `docs/codex-rulepack.md`
- `docs/current-status.md`
- `docs/backend-test-coverage-matrix.md`
- `docs/fx-api-contract.md`
- `docs/orders-api-contract.md`
- `docs/home-api-contract.md`
- `docs/ranking-api-contract.md`
- `docs/wallets-api-contract.md`
- `docs/records-api-contract.md`
- `docs/crypto-usd-settlement-policy-update.md`
- `docs/provider-final-selection-readiness-recheck.md`
- `docs/asset-price-freshness-policy.md`
- `docs/provider-evidence-capture.md`
- `docs/docs-inventory.md`
- `README.md`

Historical planning and STOP/review/preimplementation documents are archived in `docs/archive/` and are not current source of truth.

Reviewed code/test surface:

- `package.json`, `prisma/schema.prisma`
- `src/app.module.ts`, `src/app.controller.ts`
- `src/auth/*`
- `src/seasons/*`
- `src/fx/*`
- `src/orders/*`
- `src/home/*`
- `src/ranking/*`
- `src/wallets/*`
- `src/records/*`
- `src/portfolio/*`
- `scripts/admin-*`
- `test/app.e2e-spec.ts`
- domain specs under `src/**/**/*.spec.ts`

Consistency note:

- Some older design documents still say a feature was not implemented at the time they were written. Current code, current contracts, and `docs/current-status.md` show `/fx execute` and `/orders/:orderId/execute` full-fill MVP are now implemented. This roadmap treats those older statements as historical gate context, not current truth.

## Current Backend Implementation Status

### Environment / Project Setup

- Current status: NestJS backend with Prisma 7 adapter style, PostgreSQL datasource, Docker-oriented local DB assumptions, and Jest test scripts are in place.
- Implemented files: `package.json`, `src/app.module.ts`, `src/prisma/prisma.service.ts`, `README.md`.
- Source of truth: `docs/current-status.md`, `docs/codex-rulepack.md`, `README.md`.
- Existing tests: `src/app.controller.spec.ts`, `test/app.e2e-spec.ts`, build/test scripts in `package.json`.
- Known limitations: README is now project-specific onboarding, but deployment/ops runbook is not defined.
- Remaining work: deployment env/secret/healthcheck/runbook gate.
- Risk level: MEDIUM.
- Recommended next action: keep setup stable; do not touch package/lockfile unless a gate explicitly approves it.

### Database Foundation

- Current status: Core user, season, wallet, ledger, FX, asset, price, position, order, daily snapshot, and ranking tables are represented in Prisma schema and migrations.
- Implemented files: `prisma/schema.prisma`, migrations under `prisma/migrations/*`.
- Source of truth: `docs/current-status.md`, `docs/backend-gate-roadmap.md`.
- Existing tests: `pnpm exec prisma validate` history in `docs/current-status.md`; integration specs use real Prisma/PostgreSQL when env flags are enabled.
- Known limitations: no refresh-token/session schema, no settlement/reward schema beyond existing participant reward fields, no order fill/execute request table, no provider ingestion metadata table beyond snapshot raw payload fields.
- Remaining work: schema gates only when refresh-token, settlement, reward, exact order execute replay, or provider-specific needs are approved.
- Risk level: MEDIUM.
- Recommended next action: no schema changes in planning gates; validate schema before any later implementation gate.

### Auth

- Current status: access-token-only Auth MVP implemented with signup, login, `GET /api/v1/me`, global access token guard, public and optional-auth route metadata, active-user DB lookup, inactive user block, and no `x-user-id` fallback.
- Implemented files: `src/auth/auth.module.ts`, `src/auth/auth.controller.ts`, `src/auth/auth.service.ts`, `src/auth/access-token.guard.ts`, `src/auth/auth.decorators.ts`, `src/auth/auth.types.ts`, `src/app.module.ts`.
- Source of truth: `docs/current-status.md`, `docs/backend-gate-roadmap.md`, `README.md`.
- Existing tests: `src/auth/auth.service.spec.ts`, `src/auth/access-token.guard.spec.ts`, `src/auth/auth.integration.spec.ts`, `test/app.e2e-spec.ts`.
- Known limitations: refresh token, logout, revocation, sessions, cookie auth, issuer/audience policy, and token rotation are not implemented.
- Remaining work: keep access-token MVP as current auth boundary; run schema gate before refresh/logout/revocation.
- Risk level: MEDIUM.
- Recommended next action: keep protected API HTTP e2e baseline green; defer refresh-token schema to Gate K.

### Seasons

- Current status: current season read with optional auth and season join write path implemented.
- Implemented files: `src/seasons/seasons.controller.ts`, `src/seasons/seasons.service.ts`.
- Source of truth: `docs/codex-rulepack.md`, `docs/current-status.md`.
- Existing tests: `src/seasons/seasons.controller.spec.ts`, `src/seasons/seasons.join.integration.spec.ts`, `test/app.e2e-spec.ts` auth/write-path baseline.
- Known limitations: no service unit spec dedicated to `joinSeason` transaction behavior; real HTTP join backed by PostgreSQL is not covered.
- Remaining work: keep opt-in join integration green; add real HTTP DB join coverage only if needed before launch.
- Risk level: MEDIUM.
- Recommended next action: do not change join logic now; keep provider/scheduler/settlement unrelated gates closed.

### Wallets

- Current status: `GET /api/v1/wallets` read-only MVP implemented; reads `cash_wallets` for authenticated participant.
- Implemented files: `src/wallets/wallets.controller.ts`, `src/wallets/wallets.service.ts`.
- Source of truth: `docs/wallets-api-contract.md`, `docs/current-status.md`.
- Existing tests: `src/wallets/wallets.service.spec.ts`, `test/app.e2e-spec.ts`.
- Known limitations: no wallet admin adjustment API, no valuation conversion in wallets endpoint, no real DB integration for read-only no-mutation.
- Remaining work: keep read-only; wallet mutation remains owned by join, FX execute, order execute, or future settlement/admin gates.
- Risk level: LOW.
- Recommended next action: no implementation until settlement/admin adjustment is explicitly gated.

### FX Quote

- Current status: `POST /api/v1/fx/quote` read-only MVP implemented; KRW/USD only; uses latest eligible USD/KRW snapshot and 60-second freshness.
- Implemented files: `src/fx/fx.controller.ts`, `src/fx/fx.service.ts`, `src/fx/fx-decimal-policy.ts`, `scripts/admin-insert-fx-rate.ts`.
- Source of truth: `docs/fx-api-contract.md`, `docs/current-status.md`.
- Existing tests: `src/fx/fx.service.spec.ts`, `src/fx/fx-decimal-policy.spec.ts`, `src/fx/fx-rate-input.validation.spec.ts`, `test/app.e2e-spec.ts`.
- Known limitations: quote is not durable; `quoteId` and `expiresAt` are `null`; sourceType priority is not finalized for mixed provider/manual rows; provider ingestion is absent.
- Remaining work: provider final selection and sourceType priority before provider rows are introduced.
- Risk level: MEDIUM.
- Recommended next action: Gate C/D provider evidence capture, not quote code changes.

### FX Execute

- Current status: `POST /api/v1/fx/execute` first write path implemented with direct execute, durable idempotency via `fx_execute_requests`, guarded source debit, target credit, exchange row, two wallet ledger rows, succeeded response replay, and no equity snapshot.
- Implemented files: `src/fx/fx.service.ts`, `src/fx/fx-execute-*.ts`.
- Source of truth: `docs/fx-api-contract.md`, `docs/current-status.md`.
- Existing tests: `src/fx/fx.service.spec.ts`, `src/fx/fx.execute.integration.spec.ts`, FX execute policy specs under `src/fx/*spec.ts`, `test/app.e2e-spec.ts` auth baseline.
- Known limitations: no durable quote; no provider_api/official_batch source; stale pending recovery tool/job absent; some DB-level failure injection remains hardening-only; responsePayloadJson-only storage failure remains hard to force with current schema.
- Remaining work: recovery/hardening gate after provider/scheduler decisions, not before provider selection.
- Risk level: HIGH.
- Recommended next action: keep existing execute source as approved fresh `admin_manual`; do not expand allowed sourceType until provider gate completes.

### Assets / Price Input

- Current status: asset upsert CLI and admin_manual asset price snapshot CLI implemented; validation rejects inactive assets, currency mismatch, non-admin_manual source, invalid decimals, and forbidden wording.
- Implemented files: `scripts/admin-upsert-asset.ts`, `scripts/admin-insert-asset-price.ts`, `src/assets/asset-admin-input.validation.ts`.
- Source of truth: `docs/current-status.md`, `docs/orders-api-contract.md`, `docs/home-api-contract.md`.
- Existing tests: `src/assets/asset-admin-input.validation.spec.ts`.
- Known limitations: no provider price ingestion; no implemented asset price stale threshold; no scheduler; no admin HTTP API.
- Remaining work: provider evidence capture, source eligibility implementation, and tests before any provider_api asset price ingestion.
- Risk level: MEDIUM.
- Recommended next action: use `docs/asset-price-freshness-policy.md` as the implementation policy for later Gate D; do not change price input code in Gate B.

### Orders Read

- Current status: `GET /api/v1/orders` read-only MVP implemented against real `orders` rows for authenticated participant.
- Implemented files: `src/orders/orders.controller.ts`, `src/orders/orders.service.ts`.
- Source of truth: `docs/orders-api-contract.md`, `docs/current-status.md`.
- Existing tests: `src/orders/orders.service.spec.ts`, `test/app.e2e-spec.ts`.
- Known limitations: no public order book, no advanced filters beyond MVP, no real DB read-only no-mutation test.
- Remaining work: preserve read-only contract; enrich only after product/API agreement.
- Risk level: LOW.
- Recommended next action: no change.

### Orders Quote

- Current status: `POST /api/v1/orders/quote` read-only MVP implemented; active season + joined participant; market uses admin_manual asset price; limit uses limitPrice; USD assets require fresh approved admin_manual USD/KRW; buy/sell resource checks are read-only.
- Implemented files: `src/orders/orders.controller.ts`, `src/orders/orders.service.ts`.
- Source of truth: `docs/orders-api-contract.md`, `docs/current-status.md`.
- Existing tests: `src/orders/orders.service.spec.ts`, `test/app.e2e-spec.ts`.
- Known limitations: no durable quote, no quote expiry, no asset price stale threshold, no provider price source.
- Remaining work: asset price freshness policy implementation and durable quote gate if required.
- Risk level: MEDIUM.
- Recommended next action: do not add durable quote in provider/scheduler gates.

### Orders Create

- Current status: submitted order create MVP implemented; creates one `orders` row, stores create idempotency key/hash/response payload, and performs no wallet/position/settlement mutation.
- Implemented files: `src/orders/orders.service.ts`, `src/orders/orders.controller.ts`, `prisma/schema.prisma` order idempotency fields.
- Source of truth: `docs/orders-api-contract.md`, `docs/current-status.md`.
- Existing tests: `src/orders/orders.service.spec.ts`, `test/app.e2e-spec.ts` auth baseline.
- Known limitations: no DB integration for create idempotency races beyond mocked P2002; duplicate replay after cancellation returns original create response by design.
- Remaining work: add real DB idempotency race coverage if create path becomes a launch blocker.
- Risk level: MEDIUM.
- Recommended next action: no code change; keep command semantics documented.

### Orders Cancel

- Current status: submitted order cancel MVP implemented with ownership check and guarded `id + seasonParticipantId + status=submitted` update; no wallet/position/ledger mutation.
- Implemented files: `src/orders/orders.service.ts`, `src/orders/orders.controller.ts`.
- Source of truth: `docs/orders-api-contract.md`, `docs/current-status.md`.
- Existing tests: `src/orders/orders.service.spec.ts`, `src/orders/orders.execute.integration.spec.ts` cancel-vs-execute race, `test/app.e2e-spec.ts` auth baseline.
- Known limitations: no cancel reason schema, no cancel idempotency key, no standalone real DB cancel integration beyond order execute race spec.
- Remaining work: keep scope as submitted-only cancel unless product/API change is approved.
- Risk level: MEDIUM.
- Recommended next action: no change.

### Orders Execute

- Current status: full-fill execute MVP implemented. Buy debits cash wallet, creates/updates position, creates one `order_buy` ledger row, and finalizes order. Sell decrements position, credits cash wallet, creates one `order_sell` ledger row, and finalizes order. All financial writes run in one Prisma transaction.
- Implemented files: `src/orders/orders.service.ts`, `src/orders/orders.controller.ts`.
- Source of truth: `docs/orders-api-contract.md`, `docs/current-status.md`.
- Existing tests: `src/orders/orders.service.spec.ts`, `src/orders/orders.execute.integration.spec.ts`, `test/app.e2e-spec.ts` auth baseline.
- Known limitations: no exact execute response replay, no execute-specific command table, no partial fill, no matching engine, no provider price ingestion, no settlement side effect, no automatic snapshots/rankings.
- Remaining work: exact replay/partial fill/matching/settlement each require separate gate.
- Risk level: HIGH.
- Recommended next action: keep full-fill MVP stable; do not expand matching/settlement before provider/scheduler/settlement audits.

### Portfolio Valuation

- Current status: valuation service/policy implemented for KRW cash, USD cash conversion, positions, admin_manual asset prices, fresh approved admin_manual USD/KRW, KRW total assets, and return rate.
- Implemented files: `src/portfolio/portfolio-valuation.service.ts`, `src/portfolio/portfolio-valuation.policy.ts`.
- Source of truth: `docs/current-status.md`, `docs/home-api-contract.md`.
- Existing tests: `src/portfolio/portfolio-valuation.policy.spec.ts`, `src/home/home.service.spec.ts`.
- Known limitations: no asset price stale threshold; no provider price source; no automatic snapshot schedule; live valuation can be unavailable when price/FX evidence is missing.
- Remaining work: asset price freshness implementation and scheduler/batch foundation.
- Risk level: MEDIUM.
- Recommended next action: treat as calculation foundation, not final settlement evidence.

### Daily Portfolio Snapshot

- Current status: manual CLI foundation implemented. It can calculate valuation and upsert daily snapshots by participant or active participants of a season, with dry-run support.
- Implemented files: `scripts/admin-generate-daily-portfolio-snapshot.ts`, `src/portfolio/daily-portfolio-snapshot-generation.ts`.
- Source of truth: `docs/current-status.md`, `docs/home-api-contract.md`.
- Existing tests: `src/portfolio/snapshot-ranking-generation.spec.ts` dry-run only.
- Known limitations: no automatic scheduler/batch; no real DB CLI integration; season-wide mode skips failed participants but no operational retry/alert policy.
- Remaining work: scheduler/batch foundation and automatic daily generation gate.
- Risk level: MEDIUM.
- Recommended next action: Gate E before any automatic generation.

### Ranking

- Current status: `GET /api/v1/ranking` read-only MVP implemented; manual ranking generation helper/CLI implemented; API reads `season_rankings` only.
- Implemented files: `src/ranking/ranking.controller.ts`, `src/ranking/ranking.service.ts`, `scripts/admin-generate-season-ranking.ts`, `src/portfolio/portfolio-ranking.policy.ts`, `src/portfolio/season-ranking-generation.ts`.
- Source of truth: `docs/ranking-api-contract.md`, `docs/current-status.md`.
- Existing tests: `src/ranking/ranking.service.spec.ts`, `src/portfolio/portfolio-ranking.policy.spec.ts`, `src/portfolio/snapshot-ranking-generation.spec.ts`, `test/app.e2e-spec.ts`.
- Known limitations: no automatic season ranking generation, no final settlement/reward integration, no real DB ranking generator test.
- Remaining work: automatic ranking generation after scheduler foundation.
- Risk level: MEDIUM.
- Recommended next action: Gate G only after Gate E and F.

### Home

- Current status: `GET /api/v1/home` aggregate read-only MVP implemented. Supports active_joined, active_not_joined, upcoming, ended, settled, no_current_season. Uses latest daily snapshot first, then live valuation if possible. Uses season_rankings for ranking section only. Active joined allocation/top positions/equity chart are read-only and available when required DB/admin_manual data exists.
- Implemented files: `src/home/home.controller.ts`, `src/home/home.service.ts`.
- Source of truth: `docs/home-api-contract.md`, `docs/current-status.md`.
- Existing tests: `src/home/home.service.spec.ts`, `test/app.e2e-spec.ts`.
- Known limitations: provider-backed price freshness evidence, automatic snapshot/ranking generation, authoritative final result, settlement summary, and reward integration remain unavailable/blocked. Equity chart reads existing snapshots only and does not generate them.
- Remaining work: provider ingestion gate, scheduler daily snapshots, ranking automation, settlement, reward.
- Risk level: MEDIUM.
- Recommended next action: keep provider/scheduler/settlement/reward gates closed; add real DB Home scenarios if this read-only surface becomes launch-critical.

### Records

- Current status: `GET /api/v1/records` read-only MVP implemented for exchanges, wallet transactions, and orders.
- Implemented files: `src/records/records.controller.ts`, `src/records/records.service.ts`.
- Source of truth: `docs/records-api-contract.md`, `docs/current-status.md`.
- Existing tests: `src/records/records.service.spec.ts`, `src/orders/orders.execute.integration.spec.ts` read visibility, `test/app.e2e-spec.ts`.
- Known limitations: no export/detail views; no real DB read-only no-mutation test for all filters.
- Remaining work: product/API gate for richer records.
- Risk level: LOW.
- Recommended next action: no change.

### Admin CLI

- Current status: manual admin CLIs exist for FX rate input, asset upsert, asset price input, daily snapshot generation, and season ranking generation.
- Implemented files: `scripts/admin-insert-fx-rate.ts`, `scripts/admin-upsert-asset.ts`, `scripts/admin-insert-asset-price.ts`, `scripts/admin-generate-daily-portfolio-snapshot.ts`, `scripts/admin-generate-season-ranking.ts`.
- Source of truth: `docs/current-status.md`, `docs/fx-api-contract.md`.
- Existing tests: validation specs for FX/asset input; dry-run helper specs for snapshot/ranking.
- Known limitations: no CLI e2e against PostgreSQL, no operator approval runbook, no admin HTTP API.
- Remaining work: ops runbook and smoke tests if manual operations remain part of MVP.
- Risk level: MEDIUM.
- Recommended next action: keep CLI as manual/bootstrap path; do not replace with provider/scheduler without gates.

### Provider Ingestion

- Current status: not implemented. Gate B re-check is complete as `CONDITIONAL GO`, not implementation GO.
- Implemented files: none for ingestion.
- Source of truth: `docs/provider-final-selection-readiness-recheck.md`, `docs/asset-price-freshness-policy.md`, `docs/provider-evidence-capture.md`, `docs/crypto-usd-settlement-policy-update.md`.
- Existing tests: none.
- Known limitations: no API key management, polling, retry/backoff, sourceType priority implementation, retention, alerting, contract validation, or USD/KRW/asset live fixture response mapping.
- Remaining work: Gate C/D evidence capture before implementation. OANDA is the conditional primary FX candidate; Twelve Data is the conditional US stock candidate and secondary FX candidate; Binance is the MVP crypto provider target with USD settlement; KRX quote/execute remains blocked/unverified.
- Risk level: HIGH.
- Recommended next action: capture official/trial response evidence and terms decisions before code.

### Scheduler / Batch

- Current status: not implemented. Manual CLIs exist, but no scheduler/batch runner, lock, retry, idempotency, metrics, or operation policy exists.
- Implemented files: none for automatic scheduler.
- Source of truth: `docs/current-status.md`, `docs/home-api-contract.md`, provider STOP docs.
- Existing tests: none for scheduler; only manual helper dry-run tests.
- Known limitations: manual CLI and automatic scheduler must not be conflated.
- Remaining work: Gate E scheduler/batch foundation audit/implementation.
- Risk level: HIGH.
- Recommended next action: audit after provider/freshness decisions, before automatic snapshots/rankings.

### Settlement

- Current status: not implemented.
- Implemented files: none.
- Source of truth: `docs/codex-rulepack.md`, `docs/current-status.md`, `docs/home-api-contract.md`.
- Existing tests: none.
- Known limitations: final KRW evaluation policy exists, but settlement timing, final snapshot source, season state transition, rollback/retry, and reward handoff are not designed.
- Remaining work: Gate H preimplementation audit before Gate I implementation.
- Risk level: HIGH.
- Recommended next action: do not implement before provider/scheduler evidence path is reliable.

### Reward

- Current status: not implemented. Schema has participant fields such as `finalRank`, `finalTier`, and `rewardGrantedAt`, but no reward/badge/trophy workflow.
- Implemented files: none for reward.
- Source of truth: `docs/current-status.md`, `prisma/schema.prisma`.
- Existing tests: none.
- Known limitations: no reward policy, badge/trophy schema, grant idempotency, or settlement linkage.
- Remaining work: Gate J after settlement.
- Risk level: HIGH.
- Recommended next action: STOP until settlement implementation is accepted.

### Refresh Token / Logout / Revocation

- Current status: not implemented; access-token-only MVP is current auth.
- Implemented files: none for refresh/logout/revocation.
- Source of truth: `docs/current-status.md`, `docs/backend-gate-roadmap.md`, `README.md`.
- Existing tests: auth service/guard tests cover access tokens only.
- Known limitations: no refresh token table/hash, no logout, no token revocation, no session/cookie auth.
- Remaining work: Gate K schema gate.
- Risk level: HIGH.
- Recommended next action: DO LATER; do not mix with provider/scheduler/settlement work.

### Deployment / Operations

- Current status: basic health and DB health endpoints exist. Operational readiness is not complete.
- Implemented files: `src/app.controller.ts`, `src/app.service.ts`, `README.md`.
- Source of truth: `README.md`, `docs/current-status.md`.
- Existing tests: `src/app.controller.spec.ts`, `test/app.e2e-spec.ts`.
- Known limitations: no deployment target, secret policy, migration deployment runbook, scheduler ops, provider key rotation, observability, alerting, or incident recovery plan.
- Remaining work: Gate L.
- Risk level: HIGH.
- Recommended next action: start after provider/scheduler architecture is known.

## API Auth Policy Matrix

| API | Controller | Auth policy | Identity source | Expected missing token result | Expected invalid token result | `x-user-id` behavior | Current e2e coverage | Remaining coverage gap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `GET /health` | `AppController` | public | none | 200 | allowed; token ignored | ignored | Public success in `test/app.e2e-spec.ts` | invalid-token-on-public not explicitly asserted |
| `GET /health/db` | `AppController` | public | none | 200 | allowed; token ignored | ignored | Public DB health success without user lookup | invalid-token-on-public not explicitly asserted |
| `POST /api/v1/auth/signup` | `AuthController` | public | request body email/password/nickname | 201 when valid body | allowed; token ignored | ignored | signup success and no passwordHash e2e | invalid token ignored not explicitly asserted |
| `POST /api/v1/auth/login` | `AuthController` | public | request body email/password | 200 when valid body | allowed; token ignored | ignored | login success and no passwordHash e2e | invalid token ignored not explicitly asserted |
| `GET /api/v1/me` | `AuthController` | protected | `request.user.userId` from bearer JWT | 401 `UNAUTHORIZED` | 401 `UNAUTHORIZED` | cannot authenticate | missing + `x-user-id` only, valid token smoke | per-route invalid token e2e; guard unit covers invalid token |
| `GET /api/v1/seasons/current` | `SeasonsController` | optional | none if anonymous; `request.user.userId` if valid token | 200 anonymous | 401 `UNAUTHORIZED` | anonymous, not identity | anonymous, `x-user-id` anonymous, invalid/malformed token, valid token | unknown/inactive optional token path covered by guard unit, not this route |
| `POST /api/v1/seasons/:seasonId/join` | `SeasonsController` | protected | `request.user.userId` | 401 `UNAUTHORIZED` | 401 `UNAUTHORIZED` | cannot authenticate | missing + `x-user-id` only + invalid/malformed blocked, valid-token service-entry smoke | real HTTP join backed by PostgreSQL not covered |
| `GET /api/v1/home` | `HomeController` | protected | `request.user.userId` | 401 `UNAUTHORIZED` | 401 `UNAUTHORIZED` | cannot authenticate | missing + `x-user-id` only, valid token smoke | per-route invalid token e2e; deeper HTTP state matrix |
| `GET /api/v1/ranking` | `RankingController` | protected | `request.user.userId` | 401 `UNAUTHORIZED` | 401 `UNAUTHORIZED` | cannot authenticate | missing + `x-user-id` only, valid token smoke | per-route invalid token e2e |
| `GET /api/v1/wallets` | `WalletsController` | protected | `request.user.userId` | 401 `UNAUTHORIZED` | 401 `UNAUTHORIZED` | cannot authenticate | missing + `x-user-id` only, valid token smoke | per-route invalid token e2e |
| `GET /api/v1/records` | `RecordsController` | protected | `request.user.userId` | 401 `UNAUTHORIZED` | 401 `UNAUTHORIZED` | cannot authenticate | missing + `x-user-id` only, valid token smoke | per-route invalid token e2e |
| `GET /api/v1/orders` | `OrdersController` | protected | `request.user.userId` | 401 `UNAUTHORIZED` | 401 `UNAUTHORIZED` | cannot authenticate | missing + `x-user-id` only, valid token smoke | per-route invalid token e2e |
| `POST /api/v1/orders/quote` | `OrdersController` | protected | `request.user.userId` | 401 `UNAUTHORIZED` | 401 `UNAUTHORIZED` | cannot authenticate | missing + `x-user-id` only + invalid/malformed blocked, valid-token service-entry smoke | more HTTP quote business failures |
| `POST /api/v1/orders` | `OrdersController` | protected | `request.user.userId` | 401 `UNAUTHORIZED` | 401 `UNAUTHORIZED` | cannot authenticate | missing + `x-user-id` only + invalid/malformed blocked, valid-token service-entry smoke | real DB create idempotency race not covered |
| `POST /api/v1/orders/:orderId/cancel` | `OrdersController` | protected | `request.user.userId` | 401 `UNAUTHORIZED` | 401 `UNAUTHORIZED` | cannot authenticate | missing + `x-user-id` only + invalid/malformed blocked, valid-token service-entry smoke | real DB cancel visibility not separately covered |
| `POST /api/v1/orders/:orderId/execute` | `OrdersController` | protected | `request.user.userId` | 401 `UNAUTHORIZED` | 401 `UNAUTHORIZED` | cannot authenticate | missing + `x-user-id` only + invalid/malformed blocked, valid-token service-entry smoke | exact execute response replay not implemented |
| `POST /api/v1/fx/quote` | `FxController` | protected | `request.user.userId` | 401 `UNAUTHORIZED` | 401 `UNAUTHORIZED` | cannot authenticate | missing + `x-user-id` only + invalid/malformed blocked, valid-token service-entry smoke | more HTTP quote business failures |
| `POST /api/v1/fx/execute` | `FxController` | protected | `request.user.userId` | 401 `UNAUTHORIZED` | 401 `UNAUTHORIZED` | cannot authenticate | missing + `x-user-id` only + invalid/malformed blocked, valid-token service-entry smoke | stale pending recovery remains unresolved |

## Financial Write Path Safety

| Write path | Transaction boundary | Idempotency status | Ownership check | Balance / position guard | Ledger write status | Rollback proof status | Concurrency proof status | Known unresolved risks | Next hardening candidate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| season join | Implemented in one Prisma `$transaction` for participant, KRW wallet, USD wallet, initial grant ledger | No idempotency key; DB unique `(seasonId,userId)` and P2002 handling prevent duplicate participant | token-derived `userId`; no `x-user-id`; active season only | initial KRW from season; USD zero; no debit guard needed | one `initial_grant` wallet transaction for KRW only | Env-gated PostgreSQL failure injection covers participant/wallet/ledger rollback | Env-gated PostgreSQL covers duplicate join race without double wallet/ledger rows | no idempotency key; real HTTP DB join not covered | Keep opt-in DB integration; add HTTP DB join only if needed |
| FX execute | Implemented in one Prisma `$transaction` covering command create, source debit, target credit, exchange, two ledgers, command finalization | Implemented via `fx_execute_requests` unique `(userId,idempotencyKey)`, requestHash, pending/succeeded/failed handling, stored success replay | token-derived `userId`; active joined participant; wallet ids scoped to participant | guarded source wallet `updateMany` with `balanceAmount >= sourceAmount`; target wallet guarded by id/participant/currency | two ledger rows: `exchange_source`, `exchange_target`; no fee row; no equity snapshot | Unit/mock rollback and env-gated PostgreSQL DB failure injection cover several failure points | Env-gated PostgreSQL covers overspend and same-key duplicate replay race | stale pending recovery tool/job absent; responsePayloadJson-only storage failure not DB-forced; no provider source; no durable quote | Recovery/hardening gate after provider/scheduler decisions |
| order create | No explicit transaction; single `order.create` after read-only quote validation | Implemented for create only via `(seasonParticipantId,idempotencyKey)` unique, requestHash, responsePayloadJson replay, P2002 reread | token-derived participant; active season + joined participant | read-only buy wallet balance or sell position check before create; no reservation | no wallet ledger; creates only submitted order row | Mock tests assert no wallet/position/settlement writes | Mock P2002 race handling; no real DB concurrent create integration | race between quote-time resource check and later execute is accepted because create does not reserve funds | Real DB create idempotency race if needed before launch |
| order cancel | No explicit transaction; guarded single order `updateMany` then readback | No cancel idempotency key; repeated cancel returns not cancelable | order lookup requires authenticated user's participant; update also scopes `seasonParticipantId` | no balance/position mutation | no ledger | Unit tests cover guarded update conflict and no financial writes | Env-gated order execute integration covers cancel-vs-execute race | standalone real DB cancel duplicate/race not separately proven; no cancel reason | keep as is unless cancel UX requires stronger idempotency |
| order execute | Implemented in one Prisma `$transaction` covering price resolution, wallet/position mutation, ledger, finalization | No execute-specific idempotency key; `orderId` is command identity; already executed returns current-state response without mutation | owned order lookup by token-derived user; finalization scopes `id + seasonParticipantId + status=submitted` | buy guarded wallet debit; sell guarded position decrement; sell wallet credit guarded by wallet identity | one ledger row per execute: `order_buy` or `order_sell`; no fee row; no snapshots/rankings/settlement | Unit tests and env-gated PostgreSQL rollback injection cover several failure points | Env-gated PostgreSQL covers buy overspend, sell oversell, same-order execute, cancel-vs-execute | exact execute response replay absent; no partial fill; no matching engine; no provider price; asset price staleness missing | exact replay or partial fill only after schema/gate; otherwise keep full-fill MVP |

Safety classification:

- Already implemented safety: token-derived ownership, no `x-user-id`, guarded wallet/position updates for FX/order execute, FX execute durable idempotency, order create idempotency, transaction boundaries for join/FX/order execute.
- Tested safety: auth guard regression, protected write-path valid-token HTTP service-entry smoke, read-only no-mutation service tests, season join/FX/order execute env-gated PostgreSQL integration tests, order cancel guarded update unit tests, provider/static/fake input rejection for admin FX/asset paths.
- Intended but under-tested: order create real DB idempotency race; route-by-route invalid token e2e for read paths beyond guard unit.
- Not implemented: provider ingestion, scheduler/batch, settlement, reward, refresh/logout/revocation, durable quote, exact order execute replay, partial fill, matching engine.

## Backend Gates

| Gate | Purpose | Prerequisites | Allowed file changes | Forbidden changes | Required tests | STOP conditions | GO conditions | Recommended Codex prompt title | Estimated risk | Dependency gates |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Gate A: Protected API HTTP e2e baseline | Keep public/optional/protected auth behavior stable across current APIs | Access-token MVP implemented | `test/app.e2e-spec.ts`, docs only if extending coverage | source logic, schema, package, seed, migration | `pnpm run test:e2e`, `pnpm test -- auth` | any `x-user-id` fallback, missing-token protected route reaches service, optional invalid token downgrades to anonymous | current baseline passes and protected APIs reject missing/`x-user-id` only | `Gate A - Protected API HTTP e2e baseline audit` | LOW | none |
| Gate B: Provider final selection readiness | Re-check provider selection before ingestion | current provider STOP docs, current quote/execute source policy | docs only; possibly a separate trial-result doc if approved | provider code, scheduler, schema, package, env changes | docs consistency check; no build required unless docs tooling exists | no OANDA/Twelve Data live/trial evidence, no contract/cost/polling/timestamp decision, sourceType priority undecided | final selection criteria and remaining STOP list accepted | `Gate B - Provider final selection readiness re-check` | MEDIUM | Gate A |
| Gate C: FX provider ingestion implementation | Insert real provider USD/KRW snapshots | Gate B GO | provider module/service/tests, config/env docs if approved | settlement, order execution changes, scheduler if not in scope, fake/static/manual fallback | unit, mock provider tests, no-fake policy, Prisma validate/build, e2e smoke if HTTP exists | API key policy missing, source timestamp mapping uncertain, retry/backoff absent | provider snapshot insertion is idempotent/observable and quote can consume it by policy | `Gate C - FX provider ingestion implementation` | HIGH | Gate B |
| Gate D: Asset price provider ingestion implementation | Insert real asset price snapshots for supported markets | asset universe decision, asset price freshness policy, provider/source decision | asset provider files/tests/docs | FX provider code unless shared abstraction approved, scheduler if not in scope, fake/sample prices | unit/provider mapping tests, no-fake policy, Prisma validate/build | freshness/source/license/market coverage undecided | approved source mapping and freshness policy exist | `Gate D - Asset price provider ingestion implementation` | HIGH | Gate B |
| Gate E: Scheduler/batch foundation | Define safe automatic job runner foundation | provider/freshness decisions enough to know job needs | scheduler module/foundation/tests/docs if approved | daily snapshot/ranking/settlement business jobs unless included | unit tests for locking/idempotency/retry; build | no lock/idempotency/retry/observability policy; deployment model unknown | scheduler foundation can run one safe no-op or bounded job with tests | `Gate E - Scheduler batch foundation preimplementation audit` | HIGH | Gate B |
| Gate F: Automatic daily portfolio snapshot generation | Automate daily snapshot generation | Gate E, valuation inputs reliable, asset/FX freshness policy | scheduler job + tests/docs | ranking, settlement, rewards unless explicit | unit + integration/smoke for job idempotency and partial participant failures | provider data unavailable, freshness implementation absent, job retry undefined | automatic snapshots are idempotent and observable | `Gate F - Automatic daily portfolio snapshot generation` | HIGH | Gate E |
| Gate G: Automatic season ranking generation | Automate rankings from daily snapshots | Gate F | ranking job/tests/docs | settlement/reward unless explicit | unit/integration for rank ordering, uniqueness, rerun idempotency | daily snapshots absent or inconsistent, rank date policy unclear | repeatable ranking generation from snapshot source | `Gate G - Automatic season ranking generation` | MEDIUM | Gate F |
| Gate H: Settlement preimplementation audit | Decide final evaluation, season close, transaction boundaries, and recovery | Gate F/G recommended | docs only | settlement code/schema unless gate explicitly changes to implementation | no build required; maybe `prisma validate` | final price/FX evidence, season state transition, retry/idempotency, reward handoff undecided | implementation scope and test matrix accepted | `Gate H - Settlement preimplementation readiness audit` | MEDIUM | Gate F, Gate G |
| Gate I: Settlement implementation | Implement final KRW evaluation and season settlement | Gate H GO | settlement service/job/tests/docs/schema only if approved | rewards unless in Gate J, provider/scheduler unrelated changes | unit, integration, rollback/concurrency/idempotency, build | no final audit acceptance; schema needs unclear | final settlement writes are durable, idempotent, and tested | `Gate I - Settlement implementation` | HIGH | Gate H |
| Gate J: Reward/badge/trophy implementation | Grant rewards from settled final result | Gate I | reward service/schema/tests/docs if approved | settlement recalculation unless explicit | unit/integration/idempotency | no reward policy/schema/user-facing contract | reward grant is idempotent and tied to settled evidence | `Gate J - Reward badge trophy implementation` | HIGH | Gate I |
| Gate K: Refresh token/logout/revocation schema gate | Decide session model beyond access-token MVP | Auth MVP stable; product session requirements | docs/schema/migration only if approved | provider/scheduler/settlement/reward changes | auth unit/e2e; Prisma validate if schema changes | refresh token storage/rotation/logout policy undecided | schema and lifecycle accepted before implementation | `Gate K - Refresh token logout revocation schema gate` | HIGH | Gate A |
| Gate L: Deployment/ops readiness | Prepare production runtime and operations | provider/scheduler shape known | docs/config/ops scripts if approved | business logic expansions | build, health checks, migration status, smoke checklist | secret/runbook/monitoring/migration/scheduler ownership missing | deployment checklist and rollback plan accepted | `Gate L - Deployment ops readiness` | HIGH | Gate E recommended |

## Gate B Re-check Result (2026-05-12)

Gate B was completed as a docs-only readiness re-check in `docs/provider-final-selection-readiness-recheck.md` and `docs/asset-price-freshness-policy.md`.

| Area | Decision | Roadmap effect | Required before implementation |
|---|---|---|---|
| Gate B Provider final selection readiness | CONDITIONAL GO | Provider roles and source/freshness policy are clear enough for evidence capture and narrow Gate C/D prompts | No code yet; keep official docs and trial/API evidence together |
| Gate C FX provider ingestion | CONDITIONAL GO for evidence capture; implementation still gated | OANDA is conditional primary FX provider; Twelve Data is conditional secondary FX provider | OANDA USD/KRW trial/API response, exact endpoint/field mapping, provider timestamp -> `effectiveAt`, `capturedAt`, bid/ask/mid or rate basis, contract/cost/polling approval |
| Gate D Asset price provider ingestion | CONDITIONAL GO for US stock and Binance crypto evidence; BLOCKED for KRX quote/execute | Twelve Data is conditional candidate for US stock; Binance is MVP crypto provider target with USD settlement; KRX real-time quote/execute remains blocked | Twelve Data `/quote` fixture for US stock, Binance `BTCUSDT` ticker/orderbook fixtures, USDT-to-USD owner decision or Binance USD-pair evidence, symbol mapping, timestamp proof, plan/terms approval, separate domestic/US/crypto freshness tests |
| Gate E Scheduler/batch foundation | CONDITIONAL GO for preimplementation audit only | Freshness and polling requirements are clearer, but no scheduler/batch implementation is authorized | job lock, idempotency, retry/backoff, partial failure, provider outage, manual CLI coexistence policy |
| Gate H Settlement preimplementation audit | CONDITIONAL GO for docs-only audit; implementation STOP | Settlement can be audited next only after acknowledging final evidence source is still undecided | final valuation source, season cutoff, rerun/idempotency, rollback, reward handoff, official/reference snapshot decision |

Still blocked:

- KRX provider_api quote/execute until real-time official provider evidence exists.
- Provider ingestion implementation until Gate C/D evidence is captured and accepted.
- Scheduler/batch implementation until Gate E defines lock/idempotency/retry/ops behavior.
- Settlement implementation until Gate H/I fixes final price evidence and transaction/recovery behavior.
- Reward/badge/trophy until settlement is implemented and accepted.

Recommended next Codex prompt title:

- `Gate C/D Provider Mapping Decision - Binance USDT-to-USD Policy and SourceType Eligibility`

## Gate C/D Live Fixture Capture Result (2026-05-13)

Gate C/D evidence capture is documented in `docs/provider-evidence-capture.md`.

| Area | Decision | Roadmap effect | Required before implementation |
|---|---|---|---|
| OANDA USD/KRW live fixture | BLOCKED | OANDA remains conditional FX candidate, but live evidence was not captured because credentials were unavailable | Provide OANDA credentials, capture USD/KRW response, verify endpoint/fields/timestamp/content type/rate basis and terms |
| Twelve Data USD/KRW live fixture | BLOCKED | Twelve Data remains conditional secondary FX candidate, but live evidence was not captured because `TWELVE_DATA_API_KEY` was unavailable | Provide `TWELVE_DATA_API_KEY`, capture `/exchange_rate?symbol=USD/KRW`, verify `rate`, `timestamp`, freshness, errors, terms |
| Twelve Data US stock live fixture | BLOCKED | Twelve Data remains conditional US stock candidate, but live evidence was not captured because `TWELVE_DATA_API_KEY` was unavailable | Capture `/quote?symbol=AAPL`, verify currency, `close`, `timestamp`/`last_quote_at`, `is_market_open`, delayed/real-time status, plan/terms |
| Binance crypto fixture | CONDITIONAL GO for fixture capture, STOP for ingestion | Crypto provider target changed to Binance USD-settled crypto; no live Binance fixture was captured in the previous pass | Capture public `BTCUSDT` ticker and orderbook fixtures, verify timestamp/effectiveAt mapping, decide USDT-to-USD-equivalent normalization or require Binance USD quote pair evidence |
| Gate C FX provider ingestion | BLOCKED for implementation | No provider client/ingestion work should start yet | Live fixture, sourceType eligibility, timestamp mapping, rate basis, and owner terms decisions |
| Gate D Asset price provider ingestion | BLOCKED for implementation | No asset provider ingestion work should start yet | Live US fixtures, Binance crypto fixtures, symbol/currency mapping, market-open policy, delayed/EOD rejection, USDT-to-USD decision, owner terms decisions |
| Gate E Scheduler/batch foundation | CONDITIONAL GO for docs-only audit; STOP for implementation | Generic scheduler audit may proceed, but provider polling jobs cannot be implemented | Lock/idempotency/retry/ops policy plus accepted provider evidence |
| Gate H Settlement preimplementation audit | CONDITIONAL GO for docs-only audit; STOP for implementation | Settlement can audit final evidence needs, not implement settlement | Final valuation source, official/reference snapshot policy, recovery/idempotency |

Blocked reasons:

- Local environment has no OANDA or Twelve Data credentials.
- No live provider response fixtures exist.
- Official-document error/rate-limit evidence was added in `docs/provider-fixtures/provider-error-samples.md`; no live error or quota calls were made.
- OANDA exact endpoint, response fields, timestamp field, and bid/ask/mid mapping are still unverified.
- Twelve Data live timestamp freshness is unmeasured for USD/KRW and US stock.
- Binance crypto timestamp freshness and USDT-to-USD-equivalent policy are unverified.
- Production terms/account approval is still missing.
- KRX provider_api quote/execute remains blocked due missing real-time evidence.

Gate transition effect:

- Gate C FX provider ingestion implementation cannot start from this result; it remains `BLOCKED`.
- Gate D asset price provider ingestion implementation cannot start from this result; it remains `BLOCKED`.
- Crypto ingestion implementation must not start until Binance fixture evidence plus USDT-to-USD owner decision/sourceType eligibility tests are accepted.
- Gate E scheduler/batch foundation may proceed only as a docs-only preimplementation audit; implementation remains `STOP`.
- Settlement preimplementation audit may proceed only as a docs-only audit; implementation remains `STOP`.

Next recommended Codex prompt title:

- `Gate C Binance Crypto Fixture Capture + OANDA/Twelve Data Fixture Capture`

## Gate C Provider Fixture Capture Prep Result (2026-05-14)

Gate C fixture prep is documented in `docs/provider-evidence-capture.md`.

| Area | Decision | Roadmap effect | Required before implementation |
|---|---|---|---|
| Crypto freshness docs consistency | FIXED | `docs/asset-price-freshness-policy.md` now states Binance, not Twelve Data, as the crypto MVP provider target | Keep Twelve Data scoped to FX fallback and US stock candidate only |
| Binance BTCUSDT ticker fixture | GO for fixture capture; CONDITIONAL GO for mapping | Public `/api/v3/ticker/24hr?symbol=BTCUSDT` returned HTTP 200 and was saved to `docs/provider-fixtures/binance-btcusdt-ticker-sample.json` | Decide price field, accept or reject `closeTime` as `effectiveAt`, approve USDT-to-USD policy, sourceType tests, terms |
| Binance BTCUSDT orderbook fixture | CONDITIONAL GO | Public `/api/v3/depth?symbol=BTCUSDT&limit=5` returned HTTP 200 and was saved to `docs/provider-fixtures/binance-btcusdt-orderbook-sample.json` | Pair with accepted timestamp source or choose a timestamped endpoint; decide bid/ask/mid policy |
| OANDA USD/KRW fixture | BLOCKED | Credentials remain unavailable; no live OANDA call was made | Provide credentials and capture USD/KRW response with endpoint/fields/timestamp/rate basis |
| Twelve Data USD/KRW fixture | BLOCKED | `TWELVE_DATA_API_KEY` remains unavailable; no live call was made | Provide key and capture `/exchange_rate?symbol=USD/KRW` |
| Twelve Data AAPL quote fixture | BLOCKED | `TWELVE_DATA_API_KEY` remains unavailable; no live call was made | Provide key and capture `/quote?symbol=AAPL` |
| Gate D mapping blockers | STOP for implementation | Binance fixture response shape exists but policy decisions are missing | USDT-to-USD policy, effectiveAt mapping, sourceType eligibility, price-field decision, terms approval |
| Gate E scheduler audit | CONDITIONAL GO for docs-only audit | Scheduler design can be audited, but provider polling jobs remain STOP | Accepted provider/source policy and ops design |
| Gate F/G/H/I implementation | STOP | Provider/source policy and scheduler/final-evidence decisions are not accepted | Complete provider mapping and later scheduler/settlement gates |

Blocked reasons:

- Binance `BTCUSDT` uses provider quote currency `USDT`; internal `CurrencyCode` remains `USD`, so owner decision is required.
- Binance ticker has timestamp candidates, but `closeTime` semantics must be accepted before `effectiveAt` mapping.
- Binance orderbook provides bid/ask levels but no source timestamp.
- OANDA/Twelve Data credentials are not present, so credentialed fixtures remain blocked.
- Production terms/account/raw-payload storage approval is still missing.
- KRX provider_api quote/execute remains blocked due missing real-time evidence.

Next recommended Codex prompt title:

- `Gate C/D Provider Mapping Decision - Binance USDT-to-USD Policy and SourceType Eligibility`

## Next 5 Implementation Candidate Priority

| Candidate | MVP impact | Financial stability impact | Implementation risk | External dependency | Test difficulty | Current prerequisites met? | Start now? | Recommendation | Reason | Required prior decisions | Suggested next prompt scope |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1. Provider final selection readiness re-check | HIGH | HIGH | MEDIUM as docs/trial audit | HIGH | LOW for docs, MEDIUM for trial smoke | Partially | Completed as docs-only re-check | DONE, CONDITIONAL GO | Provider roles are now clear enough for evidence capture, but ingestion code is still gated. | OANDA trial response, cost/contract owner, polling/timestamp/rate-basis checklist | Gate C/D live fixture capture with credentials, do not code ingestion yet |
| 2. Asset price freshness policy finalization | HIGH | HIGH | MEDIUM | MEDIUM | MEDIUM | Partially | Completed as docs-only policy | DONE, CONDITIONAL GO | SourceType roles, timestamp semantics, market freshness, and stale behavior are now documented for future Gate D/F/H work. | supported asset universe, live fixtures, market-hours acceptance, settlement evidence | Use policy in provider evidence capture and later implementation gates |
| 3. Settlement preimplementation readiness audit | HIGH | VERY HIGH | MEDIUM as docs, HIGH later | MEDIUM | HIGH | Not fully | Not yet | DO LATER | Settlement needs reliable final daily snapshots/rankings and price/FX evidence first. | final evidence source, season state transition, idempotency, reward handoff | Docs-only audit after provider/scheduler/freshness |
| 4. Scheduler/batch foundation preimplementation audit | HIGH | HIGH | MEDIUM | MEDIUM | HIGH | Partially | After provider/freshness decisions | DO LATER | Scheduler foundation is necessary, but job requirements depend on provider/freshness and ops model. | runner model, lock/idempotency/retry/observability/deployment | Docs-only scheduler foundation audit |
| 5. Refresh token/logout/revocation schema gate | MEDIUM | MEDIUM | HIGH | LOW | HIGH | Auth MVP only | No | DO LATER | Important for sessions, but not a blocker for provider/scheduler/settlement correctness and requires schema/lifecycle decisions. | token rotation, revocation model, cookie/session requirements, schema | Separate auth schema gate; no trading code |

Recommended next task:

- Gate C/D Provider Mapping Decision - Binance USDT-to-USD Policy and SourceType Eligibility.

## STOP / GO Summary

GO or completed:

- Gate A protected API HTTP e2e baseline is complete enough for current access-token MVP.
- Existing read-only APIs may continue using service/unit plus guard e2e coverage.
- Manual admin CLIs may remain bootstrap/manual paths.

STOP:

- Provider ingestion implementation until live Gate C/D fixtures and implementation scope are accepted.
- KRX provider_api quote/execute until real-time KRX source evidence exists.
- Scheduler/batch implementation until Gate E.
- Settlement implementation until Gate H then Gate I.
- Reward/badge/trophy until Gate J after settlement.
- Refresh token/logout/revocation until Gate K schema/lifecycle approval.
- Durable quote, order exact execute replay, partial fill, matching engine, and fake/static/sample business data remain out of scope.
