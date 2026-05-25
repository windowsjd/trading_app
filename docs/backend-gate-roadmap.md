# Backend Gate Roadmap

## Status

- Documentation-only audit based on the current workspace state on 2026-05-11.
- Gate B provider readiness and asset price freshness policy were re-checked on 2026-05-12 as docs-only updates.
- Gate C/D live provider fixture capture was re-checked on 2026-05-13 as a docs/fixture-only blocked pass because credentials were unavailable.
- Crypto MVP policy changed on 2026-05-14 to Binance-based USD-settled crypto using the USD Wallet. Upbit/Bithumb are excluded from MVP, and Binance BTCUSDT public ticker/orderbook fixtures have been captured.
- Gate C provider fixture capture prep on 2026-05-14 captured Binance public `BTCUSDT` ticker/orderbook fixtures and fixed residual crypto freshness wording; OANDA/Twelve Data fixtures remain credential-blocked.
- Auth refresh-token/logout/revocation MVP is now implemented by the current codebase. This document does not authorize provider, scheduler, settlement extensions, actual reward fulfillment, package, seed, or unrelated schema changes.
- Provider-key-free `MVP_FLOW_DB_SMOKE=1` real PostgreSQL smoke is available as a service-composed opt-in check for the implemented Auth -> season join -> wallets/assets -> FX -> orders -> positions/records/home/ranking flow using isolated test-only `admin_manual` fixtures. It is not provider ingestion, scheduler, settlement, reward, seed, or sample business data.
- Batch job execution foundation is implemented with `BatchJobRun`/`BatchJobStatus`, `BatchService`, an operator-only noop/health-check script, operator-run `daily-portfolio-snapshot` and `season-ranking` jobs, an operator-run `daily-season-cycle` orchestration job, an operator-run `season-settlement` MVP job, an operator-run `final-tier-assignment` MVP job, and an operator-run `reward-grant` internal reward foundation MVP job. It is not a cron scheduler, provider ingestion, or actual external fulfillment implementation.
- Home settled final-result read model is implemented from existing `rankType=final` `season_rankings`; final tier assignment and reward grant internal foundation now have operator-run MVP jobs. Actual payment/point/delivery/external fulfillment remains a separate gate.
- `docs/current-status.md` remains the short status summary. This document is the detailed backend gate roadmap.

## Audit Basis

Current source-of-truth and active reference documents:

- `docs/codex-rulepack.md`
- `docs/current-status.md`
- `docs/backend-test-coverage-matrix.md`
- `docs/auth-api-contract.md`
- `docs/fx-api-contract.md`
- `docs/orders-api-contract.md`
- `docs/assets-api-contract.md`
- `docs/home-api-contract.md`
- `docs/ranking-api-contract.md`
- `docs/wallets-api-contract.md`
- `docs/positions-api-contract.md`
- `docs/records-api-contract.md`
- `docs/rewards-api-contract.md`
- `docs/batch-job-foundation.md`
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
- `src/positions/*`
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
- Known limitations: no settlement/reward schema beyond existing participant reward fields, no order fill/execute request table, no provider ingestion metadata table beyond snapshot raw payload fields.
- Remaining work: schema gates only when settlement, reward, exact order execute replay, provider-specific needs, or future access-token blacklist/cookie-session needs are approved.
- Risk level: MEDIUM.
- Recommended next action: no schema changes in planning gates; validate schema before any later implementation gate.

### Batch Job Foundation

- Current status: common batch job execution envelope implemented for operator/scheduler work, plus operator-run daily portfolio snapshot and season ranking jobs, an operator-run daily season cycle orchestration job, an operator-run season settlement MVP job, an operator-run final tier assignment MVP job, and an operator-run reward grant internal reward foundation MVP job. `BatchJobRun` records jobName, idempotencyKey, status, dryRun, start/finish timestamps, request/result JSON, and failure code/message.
- Implemented files: `src/batch/batch.module.ts`, `src/batch/batch.service.ts`, `src/batch/batch.types.ts`, `src/batch/batch-admin-runner.ts`, `src/batch/daily-portfolio-snapshot-job.service.ts`, `src/batch/daily-portfolio-snapshot-job.types.ts`, `src/batch/season-ranking-job.service.ts`, `src/batch/season-ranking-job.types.ts`, `src/batch/daily-season-cycle-job.service.ts`, `src/batch/daily-season-cycle-job.types.ts`, `src/batch/season-settlement-job.service.ts`, `src/batch/season-settlement-job.types.ts`, `src/batch/final-tier-assignment-job.service.ts`, `src/batch/final-tier-assignment-job.types.ts`, `src/batch/reward-grant-job.service.ts`, `src/batch/reward-grant-job.types.ts`, `scripts/admin-run-batch-job.ts`, `prisma/schema.prisma`, migration `20260519095458_add_batch_job_runs`, migration `20260523090000_add_reward_badge_trophy_foundation`.
- Source of truth: `docs/batch-job-foundation.md`, `docs/current-status.md`, `docs/backend-gate-roadmap.md`.
- Existing tests: `src/batch/batch.service.spec.ts`, `src/batch/daily-portfolio-snapshot-job.service.spec.ts`, `src/batch/season-ranking-job.service.spec.ts`, `src/batch/daily-season-cycle-job.service.spec.ts`, `src/batch/season-settlement-job.service.spec.ts`, `src/batch/final-tier-assignment-job.service.spec.ts`, `src/batch/reward-grant-job.service.spec.ts`, `src/batch/batch-admin-runner.spec.ts`.
- Known limitations: no cron scheduler, no provider ingestion job, no actual reward/payment/point/delivery/external fulfillment job, no ranking overwrite/regeneration policy, and no batch execution HTTP API because admin roles are not implemented. The daily snapshot job uses existing DB `admin_manual` evidence only and does not create rankings. The season ranking job reads existing `daily_portfolio_snapshots` only and does not create snapshots. The daily season cycle job only orchestrates those two child services in order. The season settlement MVP job reads existing `daily_portfolio_snapshots`, creates `rankType=final` rankings, and transitions `ended` seasons to `settled`; it does not recalculate portfolios, call providers, run cron, or grant rewards. The final tier assignment MVP job reads existing final rankings and updates only participant `finalRank`/`finalTier`; it does not grant rewards or change ranking policy. The reward grant MVP job preserves `SeasonParticipant.rewardGrantedAt` marker semantics and idempotently ensures internal tier badge/TOP10 trophy rows in `badges`, `user_badges`, and `season_rewards`.
- Remaining work: define deployment scheduler ownership separately; ranking automation/overwrite, provider ingestion, settlement extensions beyond final tier assignment, true competition tie rank, reward amount policy, and actual reward/payment/point/delivery/external fulfillment remain separate gates.
- Risk level: MEDIUM.
- Recommended next action: keep executable jobs limited to `noop`, `health-check`, `daily-portfolio-snapshot`, `season-ranking`, `daily-season-cycle`, `season-settlement`, `final-tier-assignment`, and `reward-grant`; open separate gates for scheduler automation, provider ingestion, settlement extensions, true tie rank, and actual reward fulfillment.

### Auth

- Current status: access token + opaque refresh token Auth MVP implemented with signup, login, refresh, logout, logout-all, `GET /api/v1/me`, global access token guard, public and optional-auth route metadata, active-user DB lookup, inactive user block, refresh-token hash storage, rotation, refresh-session revocation, and no `x-user-id` fallback.
- Implemented files: `src/auth/auth.module.ts`, `src/auth/auth.controller.ts`, `src/auth/auth.service.ts`, `src/auth/access-token.guard.ts`, `src/auth/auth.decorators.ts`, `src/auth/auth.types.ts`, `src/app.module.ts`.
- Source of truth: `docs/current-status.md`, `docs/auth-api-contract.md`, `docs/backend-gate-roadmap.md`, `README.md`.
- Existing tests: `src/auth/auth.service.spec.ts`, `src/auth/access-token.guard.spec.ts`, `src/auth/auth.integration.spec.ts`, `test/app.e2e-spec.ts`.
- Known limitations: access-token blacklist/revocation, cookie auth, server-side session auth beyond refresh sessions, issuer/audience policy, and refresh-token reuse theft-response hardening are not implemented.
- Remaining work: keep Bearer access-token guard behavior stable; defer access-token blacklist/cookie-session/auth-hardening beyond the refresh-session MVP to separate gates.
- Risk level: MEDIUM.
- Recommended next action: keep protected API HTTP e2e baseline and refresh rotation/logout tests green.

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

### Positions

- Current status: `GET /api/v1/positions` read-only MVP implemented for full holdings/positions screen. It reads existing positions/assets, latest eligible `admin_manual` asset prices, and fresh approved `admin_manual` USD/KRW when USD valuation is needed.
- Implemented files: `src/positions/positions.controller.ts`, `src/positions/positions.service.ts`, `src/positions/positions.module.ts`.
- Source of truth: `docs/positions-api-contract.md`, `docs/current-status.md`.
- Existing tests: `src/positions/positions.service.spec.ts`, `test/app.e2e-spec.ts`.
- Known limitations: no provider price source, no implemented asset price stale threshold, no real DB positions read integration, no settlement/final-result integration.
- Remaining work: real PostgreSQL read-only scenario if launch-critical; asset price freshness/provider work only after provider gates.
- Risk level: MEDIUM.
- Recommended next action: keep read-only and admin_manual-only; do not expand provider/scheduler/settlement/reward from this endpoint.

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

- Current status: `GET /api/v1/assets` and `GET /api/v1/assets/:assetId` read-only MVP are implemented for order-screen asset discovery/selection. Asset upsert CLI and admin_manual asset price snapshot CLI remain implemented; validation rejects inactive assets, currency mismatch, non-admin_manual source, invalid decimals, and forbidden wording.
- Implemented files: `src/assets/assets.controller.ts`, `src/assets/assets.service.ts`, `src/assets/assets.module.ts`, `scripts/admin-upsert-asset.ts`, `scripts/admin-insert-asset-price.ts`, `src/assets/asset-admin-input.validation.ts`.
- Source of truth: `docs/assets-api-contract.md`, `docs/current-status.md`, `docs/orders-api-contract.md`, `docs/home-api-contract.md`.
- Existing tests: `src/assets/assets.service.spec.ts`, `src/assets/asset-admin-input.validation.spec.ts`, `test/app.e2e-spec.ts`.
- Known limitations: no provider price ingestion; no implemented asset price stale threshold; no scheduler; no admin HTTP API; no real DB assets list/detail integration.
- Remaining work: provider evidence capture, source eligibility implementation, and tests before any provider_api asset price ingestion.
- Risk level: MEDIUM.
- Recommended next action: keep Assets API read-only and admin_manual-only; use `docs/asset-price-freshness-policy.md` as the implementation policy for later Gate D.

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

- Current status: manual CLI foundation and operator-run batch job implemented. The batch job creates `daily_portfolio_snapshots` for active participants of one season/date through `BatchService.runJob`, supports dry-run, generated or explicit idempotency keys, existing snapshot skip, and participant-level valuation failure. The `daily-season-cycle` orchestration job can run this job before season ranking.
- Implemented files: `scripts/admin-generate-daily-portfolio-snapshot.ts`, `src/portfolio/daily-portfolio-snapshot-generation.ts`, `src/batch/daily-portfolio-snapshot-job.service.ts`, `src/batch/daily-portfolio-snapshot-job.types.ts`, `src/batch/batch-admin-runner.ts`.
- Source of truth: `docs/current-status.md`, `docs/home-api-contract.md`, `docs/batch-job-foundation.md`.
- Existing tests: `src/portfolio/snapshot-ranking-generation.spec.ts`, `src/batch/daily-portfolio-snapshot-job.service.spec.ts`, `src/batch/batch-admin-runner.spec.ts`.
- Known limitations: no cron scheduler; no provider ingestion; no actual reward/payment/badge/trophy fulfillment; settlement is handled only by the separate operator-run `season-settlement` MVP job; no real DB batch script smoke yet.
- Remaining work: separate scheduler/deployment ownership gate if automation is required.
- Risk level: MEDIUM.
- Recommended next action: keep daily snapshot generation operator-run; use `season-ranking` as the separate operator-run ranking path; defer cron automation to a scheduler/deployment gate.

### Ranking

- Current status: `GET /api/v1/ranking` read-only MVP implemented; manual ranking generation helper/CLI and operator-run season ranking batch job implemented; API reads `season_rankings` only. The `daily-season-cycle` orchestration job can run ranking after daily snapshots.
- Implemented files: `src/ranking/ranking.controller.ts`, `src/ranking/ranking.service.ts`, `scripts/admin-generate-season-ranking.ts`, `src/portfolio/portfolio-ranking.policy.ts`, `src/portfolio/season-ranking-generation.ts`, `src/batch/season-ranking-job.service.ts`.
- Source of truth: `docs/ranking-api-contract.md`, `docs/current-status.md`.
- Existing tests: `src/ranking/ranking.service.spec.ts`, `src/portfolio/portfolio-ranking.policy.spec.ts`, `src/portfolio/snapshot-ranking-generation.spec.ts`, `src/batch/season-ranking-job.service.spec.ts`, `test/app.e2e-spec.ts`.
- Known limitations: no cron-driven automatic season ranking generation, no final settlement extension or actual reward fulfillment integration, no real DB ranking generator test. Current schema enforces unique persisted rank per season/date/type, so true same-rank competition ties require a separate schema gate.
- Remaining work: scheduler-driven ranking automation only after scheduler/deployment ownership is defined.
- Risk level: MEDIUM.
- Recommended next action: Gate G only after Gate E and F.

### Home

- Current status: `GET /api/v1/home` aggregate read-only MVP implemented. Supports active_joined, active_not_joined, upcoming, ended, settled_joined, settled_not_joined, no_current_season. Active joined uses latest daily snapshot first, then live valuation if possible. Settled joined uses existing `rankType=final` `season_rankings` as the authoritative final result source and existing `daily_portfolio_snapshots` as supporting equity chart data.
- Implemented files: `src/home/home.controller.ts`, `src/home/home.service.ts`.
- Source of truth: `docs/home-api-contract.md`, `docs/current-status.md`.
- Existing tests: `src/home/home.service.spec.ts`, `test/app.e2e-spec.ts`.
- Known limitations: provider-backed price freshness evidence, automatic snapshot/ranking generation, actual reward/payment/point/delivery/external fulfillment, and settlement extensions remain unavailable/blocked. Equity chart reads existing snapshots only and does not generate them. Missing final rankings remain unavailable with no live valuation fallback. Missing `finalTier` remains `FINAL_TIER_UNAVAILABLE` until the operator-run final tier assignment job is executed. Missing `rewardGrantedAt` remains `REWARD_NOT_GRANTED` until the operator-run reward grant internal foundation job is executed.
- Remaining work: provider ingestion gate, scheduler daily snapshots, ranking automation, actual reward fulfillment handoff, and settlement extensions beyond existing final rankings/final tier assignment/reward grant internal foundation.
- Risk level: MEDIUM.
- Recommended next action: keep provider/scheduler/actual fulfillment gates closed; add real DB Home settled scenarios if this read-only surface becomes launch-critical.

### Records

- Current status: `GET /api/v1/records` unified read-only MVP implemented for exchanges, wallet transactions, and orders. Season history read-only APIs are also implemented: `GET /api/v1/records/me/seasons`, `GET /api/v1/records/me/seasons/:seasonId`, `GET /api/v1/records/me/seasons/:seasonId/orders`, `GET /api/v1/records/me/seasons/:seasonId/exchanges`, and protected public summary `GET /api/v1/users/:userId/records/:seasonId`.
- Implemented files: `src/records/records.controller.ts`, `src/records/records.service.ts`.
- Source of truth: `docs/records-api-contract.md`, `docs/current-status.md`.
- Existing tests: `src/records/records.service.spec.ts`, `src/orders/orders.execute.integration.spec.ts` read visibility, `test/app.e2e-spec.ts`.
- Known limitations: no export view; no real DB read-only no-mutation test for all filters. Public user season summary intentionally excludes private ledgers, wallet balances, individual orders, and individual exchanges.
- Remaining work: product/API gate for records export or provider event records.
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

- Current status: batch job execution envelope and operator-run daily portfolio snapshot/season ranking/daily season cycle/season settlement/final tier assignment MVP jobs are implemented; cron scheduler is not implemented.
- Implemented files: `src/batch/**`, `scripts/admin-run-batch-job.ts`, `prisma/migrations/20260519095458_add_batch_job_runs/migration.sql`.
- Source of truth: `docs/batch-job-foundation.md`, `docs/current-status.md`, provider STOP docs.
- Existing tests: `src/batch/batch.service.spec.ts`, `src/batch/daily-portfolio-snapshot-job.service.spec.ts`, `src/batch/season-ranking-job.service.spec.ts`, `src/batch/daily-season-cycle-job.service.spec.ts`, `src/batch/season-settlement-job.service.spec.ts`, `src/batch/final-tier-assignment-job.service.spec.ts`, `src/batch/batch-admin-runner.spec.ts`; manual helper dry-run tests remain separate.
- Known limitations: manual CLI, operator-run batch jobs, cron scheduler, and automatic business jobs must not be conflated. Daily snapshots are operator-run and use DB `admin_manual` evidence only. Season rankings are operator-run and read existing daily snapshots only. Daily season cycle is operator-run orchestration only. Season settlement is operator-run and finalizes from existing daily snapshots/final rankings only. Final tier assignment is operator-run and assigns participant final rank/tier from existing final rankings only.
- Remaining work: cron/deployment ownership and separate provider/settlement-extension/reward policies before automatic provider or settlement jobs.
- Risk level: HIGH.
- Recommended next action: keep executable jobs limited to `noop`, `health-check`, `daily-portfolio-snapshot`, `season-ranking`, `daily-season-cycle`, `season-settlement`, and `final-tier-assignment` until separate scheduler/provider/reward gates open.

### Settlement

- Current status: operator-run season settlement MVP job implemented. It finalizes from existing settlement-date `daily_portfolio_snapshots` or existing final rankings, writes `rankType=final` `season_rankings`, and transitions `ended` seasons to `settled` through `BatchService.runJob`. Home can read those final rankings for settled joined participants.
- Implemented files: `src/batch/season-settlement-job.service.ts`, `src/batch/season-settlement-job.types.ts`, `src/batch/batch-admin-runner.ts`, `scripts/admin-run-batch-job.ts`.
- Source of truth: `docs/codex-rulepack.md`, `docs/current-status.md`, `docs/home-api-contract.md`, `docs/batch-job-foundation.md`.
- Existing tests: `src/batch/season-settlement-job.service.spec.ts`, `src/batch/batch-admin-runner.spec.ts`.
- Known limitations: no provider ingestion, no cron scheduler, no portfolio recalculation, no actual reward/payment/point/delivery/external fulfillment, no HTTP batch execution API, and no true competition tie rank because current `season_rankings` enforces unique rank per season/date/type. Final tier assignment and reward grant internal foundation exist only as separate operator-run MVP jobs.
- Remaining work: actual reward fulfillment handoff, true tie-rank schema policy if required, and any settlement extension beyond existing daily snapshots/final tier assignment remain separate gates.
- Risk level: HIGH.
- Recommended next action: keep settlement as operator-run finalization only; do not add provider, cron, reward, true tie-rank schema work, or settlement extensions without separate gates.

### Final Tier Assignment

- Current status: operator-run final tier assignment MVP job implemented. It reads existing `rankType=final` `season_rankings` for a settled season and selected `rankingDate`, then assigns `SeasonParticipant.finalRank` and `finalTier` only for participants that do not already have either field.
- Implemented files: `src/batch/final-tier-assignment-job.service.ts`, `src/batch/final-tier-assignment-job.types.ts`, `src/batch/batch-admin-runner.ts`, `scripts/admin-run-batch-job.ts`.
- Source of truth: `docs/current-status.md`, `docs/home-api-contract.md`, `docs/batch-job-foundation.md`.
- Existing tests: `src/batch/final-tier-assignment-job.service.spec.ts`, `src/batch/batch-admin-runner.spec.ts`, `src/home/home.service.spec.ts`.
- Known limitations: no actual reward/payment/badge/trophy fulfillment, no provider ingestion, no cron scheduler, no HTTP batch execution API, no ranking regeneration, and no true competition tie rank because the current final ranking source persists deterministic unique sequential rank.
- Remaining work: actual reward fulfillment handoff and true tie-rank schema policy remain separate gates. Complex custom reward/tier policy parsing beyond clear tier rules is also a separate gate.
- Risk level: MEDIUM.
- Recommended next action: run this after `season-settlement` for settled seasons that have final rankings, then run the separate `reward-grant` marker job when final assignments are ready.

### Reward

- Current status: operator-run reward grant internal foundation MVP job implemented. It requires a `settled` season and final-assigned participants, preserves `SeasonParticipant.rewardGrantedAt` marker semantics, and idempotently records tier badge and TOP10 trophy rows for in-app history.
- Implemented files: `src/batch/reward-grant-job.service.ts`, `src/batch/reward-grant-job.types.ts`, `src/batch/batch-admin-runner.ts`, `scripts/admin-run-batch-job.ts`, `src/rewards/rewards.module.ts`, `src/rewards/rewards.controller.ts`, `src/rewards/rewards.service.ts`, `prisma/schema.prisma`, migration `20260523090000_add_reward_badge_trophy_foundation`.
- Source of truth: `docs/current-status.md`, `docs/batch-job-foundation.md`, `docs/home-api-contract.md`, `docs/rewards-api-contract.md`, `prisma/schema.prisma`.
- Existing tests: `src/batch/reward-grant-job.service.spec.ts`, `src/batch/batch-admin-runner.spec.ts`, `src/home/home.service.spec.ts`, `src/rewards/rewards.service.spec.ts`, `test/app.e2e-spec.ts`.
- Known limitations: no reward amount calculation, point wallet, payment, delivery, external transfer, provider ingestion, cron scheduler, HTTP batch execution API, or custom fulfillment policy. `rewardPolicyJson` is not used for actual amount/item fulfillment in this MVP.
- Remaining work: define reward amount/payment/point/delivery/external fulfillment policy if product requires it.
- Risk level: HIGH.
- Recommended next action: run `reward-grant` only after `season-settlement` and `final-tier-assignment`; keep actual fulfillment as a separate gate.

### Refresh Token / Logout / Revocation

- Current status: implemented as an Auth-only refresh-session MVP.
- Implemented files: `prisma/schema.prisma`, `prisma/migrations/20260519090000_add_refresh_token_sessions/migration.sql`, `src/auth/auth.controller.ts`, `src/auth/auth.service.ts`, `src/auth/auth.types.ts`.
- Source of truth: `docs/current-status.md`, `docs/auth-api-contract.md`, `README.md`.
- Existing tests: `src/auth/auth.service.spec.ts`, `src/auth/auth.integration.spec.ts`, `test/app.e2e-spec.ts`.
- Implemented behavior: opaque refresh tokens, SHA-256 hash-only DB storage, active/revoked refresh sessions, refresh rotation in one Prisma transaction, idempotent logout, protected logout-all by `request.user.userId`.
- Known limitations: access-token blacklist/revocation, cookie/session auth, and automatic all-session revoke on detected revoked-token reuse are not implemented.
- Remaining work: optional hardening gate for reuse-theft response, access-token blacklist, issuer/audience, or cookie policy.
- Risk level: MEDIUM.
- Recommended next action: keep Auth scope isolated from provider/scheduler/settlement work.

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

| API                                           | Controller          | Auth policy | Identity source                                                 | Expected missing token result | Expected invalid token result | `x-user-id` behavior    | Current e2e coverage                                                                    | Remaining coverage gap                                                     |
| --------------------------------------------- | ------------------- | ----------- | --------------------------------------------------------------- | ----------------------------- | ----------------------------- | ----------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `GET /health`                                 | `AppController`     | public      | none                                                            | 200                           | allowed; token ignored        | ignored                 | Public success in `test/app.e2e-spec.ts`                                                | invalid-token-on-public not explicitly asserted                            |
| `GET /health/db`                              | `AppController`     | public      | none                                                            | 200                           | allowed; token ignored        | ignored                 | Public DB health success without user lookup                                            | invalid-token-on-public not explicitly asserted                            |
| `POST /api/v1/auth/signup`                    | `AuthController`    | public      | request body email/password/nickname                            | 201 when valid body           | allowed; token ignored        | ignored                 | signup success and no passwordHash e2e                                                  | invalid token ignored not explicitly asserted                              |
| `POST /api/v1/auth/login`                     | `AuthController`    | public      | request body email/password                                     | 200 when valid body           | allowed; token ignored        | ignored                 | login success and no passwordHash e2e                                                   | invalid token ignored not explicitly asserted                              |
| `POST /api/v1/auth/refresh`                   | `AuthController`    | public      | request body refreshToken                                       | 401 `INVALID_REFRESH_TOKEN`   | allowed; access token ignored | ignored                 | missing/malformed reject, valid rotation, old refresh token reuse failure               | real HTTP PostgreSQL path remains opt-in service smoke                     |
| `POST /api/v1/auth/logout`                    | `AuthController`    | public      | request body refreshToken                                       | 200 idempotent success        | allowed; access token ignored | ignored                 | idempotent success and refresh session revoke mock e2e                                  | real HTTP PostgreSQL path remains opt-in service smoke                     |
| `POST /api/v1/auth/logout-all`                | `AuthController`    | protected   | `request.user.userId` from bearer JWT                           | 401 `UNAUTHORIZED`            | 401 `UNAUTHORIZED`            | cannot authenticate     | missing + `x-user-id` only blocked, valid token success                                 | access-token blacklist not in scope                                        |
| `GET /api/v1/me`                              | `AuthController`    | protected   | `request.user.userId` from bearer JWT                           | 401 `UNAUTHORIZED`            | 401 `UNAUTHORIZED`            | cannot authenticate     | missing + `x-user-id` only, valid token smoke                                           | per-route invalid token e2e; guard unit covers invalid token               |
| `GET /api/v1/seasons/current`                 | `SeasonsController` | optional    | none if anonymous; `request.user.userId` if valid token         | 200 anonymous                 | 401 `UNAUTHORIZED`            | anonymous, not identity | anonymous, `x-user-id` anonymous, invalid/malformed token, valid token                  | unknown/inactive optional token path covered by guard unit, not this route |
| `POST /api/v1/seasons/:seasonId/join`         | `SeasonsController` | protected   | `request.user.userId`                                           | 401 `UNAUTHORIZED`            | 401 `UNAUTHORIZED`            | cannot authenticate     | missing + `x-user-id` only + invalid/malformed blocked, valid-token service-entry smoke | real HTTP join backed by PostgreSQL not covered                            |
| `GET /api/v1/home`                            | `HomeController`    | protected   | `request.user.userId`                                           | 401 `UNAUTHORIZED`            | 401 `UNAUTHORIZED`            | cannot authenticate     | missing + `x-user-id` only, valid token smoke                                           | per-route invalid token e2e; deeper HTTP state matrix                      |
| `GET /api/v1/ranking`                         | `RankingController` | protected   | `request.user.userId`                                           | 401 `UNAUTHORIZED`            | 401 `UNAUTHORIZED`            | cannot authenticate     | missing + `x-user-id` only, valid token smoke                                           | per-route invalid token e2e                                                |
| `GET /api/v1/wallets`                         | `WalletsController` | protected   | `request.user.userId`                                           | 401 `UNAUTHORIZED`            | 401 `UNAUTHORIZED`            | cannot authenticate     | missing + `x-user-id` only, valid token smoke                                           | per-route invalid token e2e                                                |
| `GET /api/v1/records`                         | `RecordsController` | protected   | `request.user.userId`                                           | 401 `UNAUTHORIZED`            | 401 `UNAUTHORIZED`            | cannot authenticate     | missing + `x-user-id` only, valid token smoke                                           | per-route invalid token e2e                                                |
| `GET /api/v1/records/me/seasons*`             | `RecordsController` | protected   | `request.user.userId`                                           | 401 `UNAUTHORIZED`            | 401 `UNAUTHORIZED`            | cannot authenticate     | missing + `x-user-id` only, valid token smoke                                           | per-route invalid token e2e                                                |
| `GET /api/v1/users/:userId/records/:seasonId` | `RecordsController` | protected   | `request.user.userId`; target user path param is summary target | 401 `UNAUTHORIZED`            | 401 `UNAUTHORIZED`            | cannot authenticate     | missing + `x-user-id` only, valid token smoke                                           | per-route invalid token e2e; public summary only                           |
| `GET /api/v1/orders`                          | `OrdersController`  | protected   | `request.user.userId`                                           | 401 `UNAUTHORIZED`            | 401 `UNAUTHORIZED`            | cannot authenticate     | missing + `x-user-id` only, valid token smoke                                           | per-route invalid token e2e                                                |
| `POST /api/v1/orders/quote`                   | `OrdersController`  | protected   | `request.user.userId`                                           | 401 `UNAUTHORIZED`            | 401 `UNAUTHORIZED`            | cannot authenticate     | missing + `x-user-id` only + invalid/malformed blocked, valid-token service-entry smoke | more HTTP quote business failures                                          |
| `POST /api/v1/orders`                         | `OrdersController`  | protected   | `request.user.userId`                                           | 401 `UNAUTHORIZED`            | 401 `UNAUTHORIZED`            | cannot authenticate     | missing + `x-user-id` only + invalid/malformed blocked, valid-token service-entry smoke | real DB create idempotency race not covered                                |
| `POST /api/v1/orders/:orderId/cancel`         | `OrdersController`  | protected   | `request.user.userId`                                           | 401 `UNAUTHORIZED`            | 401 `UNAUTHORIZED`            | cannot authenticate     | missing + `x-user-id` only + invalid/malformed blocked, valid-token service-entry smoke | real DB cancel visibility not separately covered                           |
| `POST /api/v1/orders/:orderId/execute`        | `OrdersController`  | protected   | `request.user.userId`                                           | 401 `UNAUTHORIZED`            | 401 `UNAUTHORIZED`            | cannot authenticate     | missing + `x-user-id` only + invalid/malformed blocked, valid-token service-entry smoke | exact execute response replay not implemented                              |
| `POST /api/v1/fx/quote`                       | `FxController`      | protected   | `request.user.userId`                                           | 401 `UNAUTHORIZED`            | 401 `UNAUTHORIZED`            | cannot authenticate     | missing + `x-user-id` only + invalid/malformed blocked, valid-token service-entry smoke | more HTTP quote business failures                                          |
| `POST /api/v1/fx/execute`                     | `FxController`      | protected   | `request.user.userId`                                           | 401 `UNAUTHORIZED`            | 401 `UNAUTHORIZED`            | cannot authenticate     | missing + `x-user-id` only + invalid/malformed blocked, valid-token service-entry smoke | stale pending recovery remains unresolved                                  |

## Financial Write Path Safety

| Write path    | Transaction boundary                                                                                                                       | Idempotency status                                                                                                                            | Ownership check                                                                                             | Balance / position guard                                                                                                  | Ledger write status                                                                                   | Rollback proof status                                                                         | Concurrency proof status                                                                        | Known unresolved risks                                                                                                               | Next hardening candidate                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| season join   | Implemented in one Prisma `$transaction` for participant, KRW wallet, USD wallet, initial grant ledger                                     | No idempotency key; DB unique `(seasonId,userId)` and P2002 handling prevent duplicate participant                                            | token-derived `userId`; no `x-user-id`; active season only                                                  | initial KRW from season; USD zero; no debit guard needed                                                                  | one `initial_grant` wallet transaction for KRW only                                                   | Env-gated PostgreSQL failure injection covers participant/wallet/ledger rollback              | Env-gated PostgreSQL covers duplicate join race without double wallet/ledger rows               | no idempotency key; real HTTP DB join not covered                                                                                    | Keep opt-in DB integration; add HTTP DB join only if needed                       |
| FX execute    | Implemented in one Prisma `$transaction` covering command create, source debit, target credit, exchange, two ledgers, command finalization | Implemented via `fx_execute_requests` unique `(userId,idempotencyKey)`, requestHash, pending/succeeded/failed handling, stored success replay | token-derived `userId`; active joined participant; wallet ids scoped to participant                         | guarded source wallet `updateMany` with `balanceAmount >= sourceAmount`; target wallet guarded by id/participant/currency | two ledger rows: `exchange_source`, `exchange_target`; no fee row; no equity snapshot                 | Unit/mock rollback and env-gated PostgreSQL DB failure injection cover several failure points | Env-gated PostgreSQL covers overspend and same-key duplicate replay race                        | stale pending recovery tool/job absent; responsePayloadJson-only storage failure not DB-forced; no provider source; no durable quote | Recovery/hardening gate after provider/scheduler decisions                        |
| order create  | No explicit transaction; single `order.create` after read-only quote validation                                                            | Implemented for create only via `(seasonParticipantId,idempotencyKey)` unique, requestHash, responsePayloadJson replay, P2002 reread          | token-derived participant; active season + joined participant                                               | read-only buy wallet balance or sell position check before create; no reservation                                         | no wallet ledger; creates only submitted order row                                                    | Mock tests assert no wallet/position/settlement writes                                        | Mock P2002 race handling; no real DB concurrent create integration                              | race between quote-time resource check and later execute is accepted because create does not reserve funds                           | Real DB create idempotency race if needed before launch                           |
| order cancel  | No explicit transaction; guarded single order `updateMany` then readback                                                                   | No cancel idempotency key; repeated cancel returns not cancelable                                                                             | order lookup requires authenticated user's participant; update also scopes `seasonParticipantId`            | no balance/position mutation                                                                                              | no ledger                                                                                             | Unit tests cover guarded update conflict and no financial writes                              | Env-gated order execute integration covers cancel-vs-execute race                               | standalone real DB cancel duplicate/race not separately proven; no cancel reason                                                     | keep as is unless cancel UX requires stronger idempotency                         |
| order execute | Implemented in one Prisma `$transaction` covering price resolution, wallet/position mutation, ledger, finalization                         | No execute-specific idempotency key; `orderId` is command identity; already executed returns current-state response without mutation          | owned order lookup by token-derived user; finalization scopes `id + seasonParticipantId + status=submitted` | buy guarded wallet debit; sell guarded position decrement; sell wallet credit guarded by wallet identity                  | one ledger row per execute: `order_buy` or `order_sell`; no fee row; no snapshots/rankings/settlement | Unit tests and env-gated PostgreSQL rollback injection cover several failure points           | Env-gated PostgreSQL covers buy overspend, sell oversell, same-order execute, cancel-vs-execute | exact execute response replay absent; no partial fill; no matching engine; no provider price; asset price staleness missing          | exact replay or partial fill only after schema/gate; otherwise keep full-fill MVP |

Safety classification:

- Already implemented safety: token-derived ownership, no `x-user-id`, guarded wallet/position updates for FX/order execute, FX execute durable idempotency, order create idempotency, transaction boundaries for join/FX/order execute.
- Tested safety: auth guard regression, protected write-path valid-token HTTP service-entry smoke, read-only no-mutation service tests, season join/FX/order execute env-gated PostgreSQL integration tests, `MVP_FLOW_DB_SMOKE=1` service-composed real PostgreSQL flow smoke, batch run idempotency/dryRun/failure unit tests, season settlement unit/parser tests, order cancel guarded update unit tests, provider/static/fake input rejection for admin FX/asset paths.
- Intended but under-tested: order create real DB idempotency race; route-by-route invalid token e2e for read paths beyond guard unit.
- Not implemented: provider ingestion, cron scheduler, automatic snapshot/ranking jobs, reward, durable quote, exact order execute replay, partial fill, matching engine.

## Backend Gates

| Gate                                                  | Purpose                                                                    | Prerequisites                                                                                                                                                             | Allowed file changes                                                                     | Forbidden changes                                                                                  | Required tests                                                                             | STOP conditions                                                                                                         | GO conditions                                                                            | Recommended Codex prompt title                                | Estimated risk | Dependency gates   |
| ----------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------- | ------------------ |
| Gate A: Protected API HTTP e2e baseline               | Keep public/optional/protected auth behavior stable across current APIs    | Access-token MVP implemented                                                                                                                                              | `test/app.e2e-spec.ts`, docs only if extending coverage                                  | source logic, schema, package, seed, migration                                                     | `pnpm run test:e2e`, `pnpm test -- auth`                                                   | any `x-user-id` fallback, missing-token protected route reaches service, optional invalid token downgrades to anonymous | current baseline passes and protected APIs reject missing/`x-user-id` only               | `Gate A - Protected API HTTP e2e baseline audit`              | LOW            | none               |
| Gate B: Provider final selection readiness            | Re-check provider selection before ingestion                               | current provider STOP docs, current quote/execute source policy                                                                                                           | docs only; possibly a separate trial-result doc if approved                              | provider code, scheduler, schema, package, env changes                                             | docs consistency check; no build required unless docs tooling exists                       | no OANDA/Twelve Data live/trial evidence, no contract/cost/polling/timestamp decision, sourceType priority undecided    | final selection criteria and remaining STOP list accepted                                | `Gate B - Provider final selection readiness re-check`        | MEDIUM         | Gate A             |
| Gate C: FX provider ingestion implementation          | Insert real provider USD/KRW snapshots                                     | Gate B GO                                                                                                                                                                 | provider module/service/tests, config/env docs if approved                               | settlement, order execution changes, scheduler if not in scope, fake/static/manual fallback        | unit, mock provider tests, no-fake policy, Prisma validate/build, e2e smoke if HTTP exists | API key policy missing, source timestamp mapping uncertain, retry/backoff absent                                        | provider snapshot insertion is idempotent/observable and quote can consume it by policy  | `Gate C - FX provider ingestion implementation`               | HIGH           | Gate B             |
| Gate D: Asset price provider ingestion implementation | Insert real asset price snapshots for supported markets                    | asset universe decision, asset price freshness policy, provider/source decision                                                                                           | asset provider files/tests/docs                                                          | FX provider code unless shared abstraction approved, scheduler if not in scope, fake/sample prices | unit/provider mapping tests, no-fake policy, Prisma validate/build                         | freshness/source/license/market coverage undecided                                                                      | approved source mapping and freshness policy exist                                       | `Gate D - Asset price provider ingestion implementation`      | HIGH           | Gate B             |
| Gate E: Scheduler/batch foundation                    | Define safe automatic job runner foundation                                | provider/freshness decisions enough to know job needs                                                                                                                     | scheduler module/foundation/tests/docs if approved                                       | provider polling or cron-driven business jobs unless included                                      | unit tests for locking/idempotency/retry; build                                            | no lock/idempotency/retry/observability policy; deployment model unknown                                                | batch foundation can run one safe no-op or bounded job with tests; cron remains separate | `Gate E - Scheduler batch foundation preimplementation audit` | HIGH           | Gate B             |
| Gate F: Automatic daily portfolio snapshot generation | Automate daily snapshot generation                                         | Gate E, valuation inputs reliable, asset/FX freshness policy                                                                                                              | scheduler job + tests/docs                                                               | ranking, settlement, rewards unless explicit                                                       | unit + integration/smoke for job idempotency and partial participant failures              | provider data unavailable, freshness implementation absent, job retry undefined                                         | automatic snapshots are idempotent and observable                                        | `Gate F - Automatic daily portfolio snapshot generation`      | HIGH           | Gate E             |
| Gate G: Automatic season ranking generation           | Automate rankings from daily snapshots                                     | Gate F                                                                                                                                                                    | ranking job/tests/docs                                                                   | settlement/reward unless explicit                                                                  | unit/integration for rank ordering, uniqueness, rerun idempotency                          | daily snapshots absent or inconsistent, rank date policy unclear                                                        | repeatable ranking generation from snapshot source                                       | `Gate G - Automatic season ranking generation`                | MEDIUM         | Gate F             |
| Gate H: Settlement extension/final-result audit       | Decide extensions beyond existing snapshot-based settlement MVP            | Season settlement MVP, final tier assignment MVP, reward grant internal foundation MVP, and Home final-result read model implemented; Gate F/G recommended for automation | docs only                                                                                | provider/actual reward fulfillment/schema code unless explicitly approved                          | no build required; maybe `prisma validate`                                                 | final price/FX evidence, recovery, actual fulfillment handoff, advanced tier policy, or tie-rank policy undecided       | extension scope and test matrix accepted                                                 | `Gate H - Settlement extension readiness audit`               | MEDIUM         | Gate F, Gate G     |
| Gate I: Settlement extension implementation           | Extend final KRW result, Home integration, recovery, or schema as approved | Gate H GO                                                                                                                                                                 | settlement/home/tests/docs/schema only if approved                                       | actual reward fulfillment unless in Gate J, provider/scheduler unrelated changes                   | unit, integration, rollback/concurrency/idempotency, build                                 | no final audit acceptance; schema needs unclear                                                                         | approved extension writes are durable, idempotent, and tested                            | `Gate I - Settlement extension implementation`                | HIGH           | Gate H             |
| Gate J: Reward fulfillment implementation             | Fulfill rewards from settled final result beyond the internal foundation   | Reward grant internal foundation MVP accepted; Gate I if final-result extension is required                                                                               | reward/payment/point/delivery/external fulfillment service/schema/tests/docs if approved | settlement recalculation unless explicit                                                           | unit/integration/idempotency                                                               | no reward amount/payment/point/delivery/external policy                                                                 | fulfillment is idempotent and tied to settled evidence                                   | `Gate J - Reward fulfillment implementation`                  | HIGH           | Settlement MVP     |
| Gate K: Refresh token/logout/revocation MVP           | Add opaque refresh-token sessions, rotation, logout, logout-all            | Auth MVP stable; frontend login persistence needed                                                                                                                        | Auth schema/migration/service/controller/tests/docs                                      | provider/scheduler/settlement/reward changes                                                       | auth unit/e2e, Prisma validate, build                                                      | access-token blacklist/cookie-session/reuse theft-response remain out of scope                                          | refresh session lifecycle works without touching trading/provider domains                | `Gate K - Refresh token logout revocation MVP`                | MEDIUM         | Gate A             |
| Gate L: Deployment/ops readiness                      | Prepare production runtime and operations                                  | provider/scheduler shape known                                                                                                                                            | docs/config/ops scripts if approved                                                      | business logic expansions                                                                          | build, health checks, migration status, smoke checklist                                    | secret/runbook/monitoring/migration/scheduler ownership missing                                                         | deployment checklist and rollback plan accepted                                          | `Gate L - Deployment ops readiness`                           | HIGH           | Gate E recommended |

## Gate B Re-check Result (2026-05-12)

Gate B was completed as a docs-only readiness re-check in `docs/provider-final-selection-readiness-recheck.md` and `docs/asset-price-freshness-policy.md`.

| Area                                      | Decision                                                                                 | Roadmap effect                                                                                                                                                  | Required before implementation                                                                                                                                                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gate B Provider final selection readiness | CONDITIONAL GO                                                                           | Provider roles and source/freshness policy are clear enough for evidence capture and narrow Gate C/D prompts                                                    | No code yet; keep official docs and trial/API evidence together                                                                                                                                                                                    |
| Gate C FX provider ingestion              | CONDITIONAL GO for evidence capture; implementation still gated                          | OANDA is conditional primary FX provider; Twelve Data is conditional secondary FX provider                                                                      | OANDA USD/KRW trial/API response, exact endpoint/field mapping, provider timestamp -> `effectiveAt`, `capturedAt`, bid/ask/mid or rate basis, contract/cost/polling approval                                                                       |
| Gate D Asset price provider ingestion     | CONDITIONAL GO for US stock and Binance crypto evidence; BLOCKED for KRX quote/execute   | Twelve Data is conditional candidate for US stock; Binance is MVP crypto provider target with USD settlement; KRX real-time quote/execute remains blocked       | Twelve Data `/quote` fixture for US stock, Binance `BTCUSDT` ticker/orderbook fixtures, USDT-to-USD owner decision or Binance USD-pair evidence, symbol mapping, timestamp proof, plan/terms approval, separate domestic/US/crypto freshness tests |
| Gate E Scheduler/batch foundation         | FOUNDATION IMPLEMENTED for job envelope; cron scheduler remains STOP                     | Batch run/idempotency recording exists, but no cron scheduler or business job is authorized                                                                     | job-specific partial failure, provider outage handling, manual CLI coexistence, deployment scheduler ownership                                                                                                                                     |
| Gate H Settlement extension audit         | MVP IMPLEMENTED for existing snapshot-based operator settlement; extensions remain gated | Further settlement work should focus on true tie rank, provider-backed final evidence, recovery, advanced tier policy, and actual fulfillment handoff decisions | final valuation extension source, rerun/idempotency, rollback, actual fulfillment handoff, official/reference snapshot decision                                                                                                                    |

Still blocked:

- KRX provider_api quote/execute until real-time official provider evidence exists.
- Provider ingestion implementation until Gate C/D evidence is captured and accepted.
- Cron scheduler implementation until Gate E defines lock/idempotency/retry/ops behavior.
- Settlement extensions until Gate H/I fixes final price evidence, true tie rank, recovery behavior, advanced tier policy, or actual fulfillment handoff.
- Actual reward/payment/badge/trophy fulfillment until reward policy/schema are approved.

Recommended next Codex prompt title:

- `Gate C/D Provider Mapping Decision - Binance USDT-to-USD Policy and SourceType Eligibility`

## Gate C/D Live Fixture Capture Result (2026-05-13)

Gate C/D evidence capture is documented in `docs/provider-evidence-capture.md`.

| Area                                  | Decision                                                                         | Roadmap effect                                                                                                                                                                                | Required before implementation                                                                                                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OANDA USD/KRW live fixture            | BLOCKED                                                                          | OANDA remains conditional FX candidate, but live evidence was not captured because credentials were unavailable                                                                               | Provide OANDA credentials, capture USD/KRW response, verify endpoint/fields/timestamp/content type/rate basis and terms                                                              |
| Twelve Data USD/KRW live fixture      | BLOCKED                                                                          | Twelve Data remains conditional secondary FX candidate, but live evidence was not captured because `TWELVE_DATA_API_KEY` was unavailable                                                      | Provide `TWELVE_DATA_API_KEY`, capture `/exchange_rate?symbol=USD/KRW`, verify `rate`, `timestamp`, freshness, errors, terms                                                         |
| Twelve Data US stock live fixture     | BLOCKED                                                                          | Twelve Data remains conditional US stock candidate, but live evidence was not captured because `TWELVE_DATA_API_KEY` was unavailable                                                          | Capture `/quote?symbol=AAPL`, verify currency, `close`, `timestamp`/`last_quote_at`, `is_market_open`, delayed/real-time status, plan/terms                                          |
| Binance crypto fixture                | CONDITIONAL GO for fixture capture, STOP for ingestion                           | Crypto provider target changed to Binance USD-settled crypto; no live Binance fixture was captured in the previous pass                                                                       | Capture public `BTCUSDT` ticker and orderbook fixtures, verify timestamp/effectiveAt mapping, decide USDT-to-USD-equivalent normalization or require Binance USD quote pair evidence |
| Gate C FX provider ingestion          | BLOCKED for implementation                                                       | No provider client/ingestion work should start yet                                                                                                                                            | Live fixture, sourceType eligibility, timestamp mapping, rate basis, and owner terms decisions                                                                                       |
| Gate D Asset price provider ingestion | BLOCKED for implementation                                                       | No asset provider ingestion work should start yet                                                                                                                                             | Live US fixtures, Binance crypto fixtures, symbol/currency mapping, market-open policy, delayed/EOD rejection, USDT-to-USD decision, owner terms decisions                           |
| Gate E Scheduler/batch foundation     | FOUNDATION IMPLEMENTED for job envelope; cron/business jobs STOP                 | Generic batch run envelope exists, but provider polling jobs and cron scheduler cannot be implemented                                                                                         | Job-specific partial failure policy, accepted provider evidence, deployment scheduler ownership                                                                                      |
| Gate H Settlement extension audit     | MVP IMPLEMENTED for existing snapshot-based operator settlement; extensions STOP | Settlement extensions can audit final evidence needs, tie rank, advanced tier policy, actual fulfillment handoff, and recovery, not add provider/actual fulfillment behavior without approval | Final valuation source, official/reference snapshot policy, recovery/idempotency, final tier/reward fulfillment policy                                                               |

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
- Gate E batch foundation exists for operator-run jobs only; provider polling jobs and cron scheduler remain `STOP`.
- Settlement extensions may proceed only as separate gated work; the current MVP stays existing-snapshot based.

Next recommended Codex prompt title:

- `Gate C Binance Crypto Fixture Capture + OANDA/Twelve Data Fixture Capture`

## Gate C Provider Fixture Capture Prep Result (2026-05-14)

Gate C fixture prep is documented in `docs/provider-evidence-capture.md`.

| Area                              | Decision                                                  | Roadmap effect                                                                                                                                  | Required before implementation                                                                                         |
| --------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Crypto freshness docs consistency | FIXED                                                     | `docs/asset-price-freshness-policy.md` now states Binance, not Twelve Data, as the crypto MVP provider target                                   | Keep Twelve Data scoped to FX fallback and US stock candidate only                                                     |
| Binance BTCUSDT ticker fixture    | GO for fixture capture; CONDITIONAL GO for mapping        | Public `/api/v3/ticker/24hr?symbol=BTCUSDT` returned HTTP 200 and was saved to `docs/provider-fixtures/binance-btcusdt-ticker-sample.json`      | Decide price field, accept or reject `closeTime` as `effectiveAt`, approve USDT-to-USD policy, sourceType tests, terms |
| Binance BTCUSDT orderbook fixture | CONDITIONAL GO                                            | Public `/api/v3/depth?symbol=BTCUSDT&limit=5` returned HTTP 200 and was saved to `docs/provider-fixtures/binance-btcusdt-orderbook-sample.json` | Pair with accepted timestamp source or choose a timestamped endpoint; decide bid/ask/mid policy                        |
| OANDA USD/KRW fixture             | BLOCKED                                                   | Credentials remain unavailable; no live OANDA call was made                                                                                     | Provide credentials and capture USD/KRW response with endpoint/fields/timestamp/rate basis                             |
| Twelve Data USD/KRW fixture       | BLOCKED                                                   | `TWELVE_DATA_API_KEY` remains unavailable; no live call was made                                                                                | Provide key and capture `/exchange_rate?symbol=USD/KRW`                                                                |
| Twelve Data AAPL quote fixture    | BLOCKED                                                   | `TWELVE_DATA_API_KEY` remains unavailable; no live call was made                                                                                | Provide key and capture `/quote?symbol=AAPL`                                                                           |
| Gate D mapping blockers           | STOP for implementation                                   | Binance fixture response shape exists but policy decisions are missing                                                                          | USDT-to-USD policy, effectiveAt mapping, sourceType eligibility, price-field decision, terms approval                  |
| Gate E scheduler audit            | FOUNDATION IMPLEMENTED for batch envelope                 | Scheduler design can still be audited; provider polling jobs and cron scheduler remain STOP                                                     | Accepted provider/source policy, job-specific failure policy, and ops design                                           |
| Gate F/G/H/I extension work       | STOP for provider-backed automation/settlement extensions | Provider/source policy and scheduler/final-evidence decisions are not accepted                                                                  | Complete provider mapping and later scheduler/settlement extension gates                                               |

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

| Candidate                                             | MVP impact | Financial stability impact | Implementation risk        | External dependency | Test difficulty                      | Current prerequisites met?    | Start now?                      | Recommendation       | Reason                                                                                                                                                                                                             | Required prior decisions                                                              | Suggested next prompt scope                                                                     |
| ----------------------------------------------------- | ---------- | -------------------------- | -------------------------- | ------------------- | ------------------------------------ | ----------------------------- | ------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1. Provider final selection readiness re-check        | HIGH       | HIGH                       | MEDIUM as docs/trial audit | HIGH                | LOW for docs, MEDIUM for trial smoke | Partially                     | Completed as docs-only re-check | DONE, CONDITIONAL GO | Provider roles are now clear enough for evidence capture, but ingestion code is still gated.                                                                                                                       | OANDA trial response, cost/contract owner, polling/timestamp/rate-basis checklist     | Gate C/D live fixture capture with credentials, do not code ingestion yet                       |
| 2. Asset price freshness policy finalization          | HIGH       | HIGH                       | MEDIUM                     | MEDIUM              | MEDIUM                               | Partially                     | Completed as docs-only policy   | DONE, CONDITIONAL GO | SourceType roles, timestamp semantics, market freshness, and stale behavior are now documented for future Gate D/F/H work.                                                                                         | supported asset universe, live fixtures, market-hours acceptance, settlement evidence | Use policy in provider evidence capture and later implementation gates                          |
| 3. Season settlement MVP                              | HIGH       | VERY HIGH                  | MEDIUM                     | LOW                 | MEDIUM                               | Enough for existing snapshots | Completed for MVP               | DONE FOR MVP         | Operator-run settlement can now finalize from existing daily snapshots without provider keys or cron; final tier assignment and reward grant internal foundation MVP can consume final rankings/final assignments. | True tie rank, advanced tier policy, and actual reward fulfillment remain separate    | Keep settlement/final-tier/reward foundation bounded; open separate extension/fulfillment gates |
| 4. Scheduler/batch foundation preimplementation audit | HIGH       | HIGH                       | MEDIUM                     | MEDIUM              | HIGH                                 | Mostly for envelope           | Completed for envelope          | DONE FOR ENVELOPE    | BatchJobRun and BatchService now provide idempotent run recording; cron and business jobs still depend on provider/freshness and ops model.                                                                        | job-specific partial failure, provider outage, cron/deployment ownership              | Add concrete snapshot/ranking job only under its own gate                                       |
| 5. Refresh token/logout/revocation MVP                | MEDIUM     | MEDIUM                     | MEDIUM                     | LOW                 | MEDIUM                               | Auth MVP complete             | Yes                             | DONE                 | Opaque refresh sessions, rotation, logout, and logout-all are implemented without provider/trading changes.                                                                                                        | access-token blacklist/cookie-session/reuse theft-response are separate future gates  | Keep Auth-only boundaries and tests green                                                       |

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
- Cron scheduler implementation until Gate E.
- Settlement extensions until Gate H then Gate I.
- Actual reward/payment/badge/trophy fulfillment until Gate J after reward policy/schema approval.
- Access-token blacklist, cookie/session auth, and refresh-token reuse theft-response hardening until a separate Auth hardening gate.
- Durable quote, order exact execute replay, partial fill, matching engine, and fake/static/sample business data remain out of scope.
