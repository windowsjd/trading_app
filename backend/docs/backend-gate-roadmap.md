# Backend Gate Roadmap

## Status

- Documentation-only audit based on the current workspace state on 2026-05-11.
- Gate B provider readiness and asset price freshness policy were re-checked on 2026-05-12 as docs-only updates.
- Gate C/D live provider fixture capture was re-checked on 2026-05-13 as a docs/fixture-only blocked pass because credentials were unavailable.
- Crypto MVP policy changed on 2026-05-14 to Binance-based USD-settled crypto using the USD Wallet. Upbit/Bithumb are excluded from MVP, and Binance BTCUSDT public ticker/orderbook fixtures have been captured.
- Gate C provider fixture capture prep on 2026-05-14 captured Binance public `BTCUSDT` ticker/orderbook fixtures and fixed residual crypto freshness wording; OANDA/Twelve Data fixtures remain credential-blocked.
- Auth refresh-token/logout/revocation MVP is now implemented by the current codebase. This document does not authorize provider, scheduler, settlement extensions, external reward fulfillment, package, seed, or unrelated schema changes.
- Admin/operator authorization, account management, status/restore, and audit MVP is implemented with `UserRole`, DB-current-role request context, `GET /api/v1/operator/me`, admin-only user list/get, admin-only audited role change, admin-only audited user status/restore, refresh-session revocation on suspend/delete, and `operator_audit_logs`. It does not add provider ingestion triggers, batch execution HTTP APIs, scheduler HTTP APIs, or external reward provider triggers.
- Provider-key-free `MVP_FLOW_DB_SMOKE=1` real PostgreSQL smoke is available as a service-composed opt-in check for the implemented Auth -> season join -> wallets/assets -> FX -> orders -> positions/records/home/ranking flow using isolated test-only `admin_manual` fixtures. It is not provider ingestion, scheduler, settlement, reward, seed, or sample business data.
- Batch job execution foundation is implemented with `BatchJobRun`/`BatchJobStatus`, `BatchService`, an operator-only noop/health-check script, operator-run `daily-portfolio-snapshot` and `season-ranking` jobs, an operator-run `daily-season-cycle` orchestration job, an operator-run `season-settlement` MVP job, an operator-run `final-tier-assignment` MVP job, and an operator-run `reward-grant` gate-closed job. It is not provider ingestion, batch HTTP API, reward policy/catalog execution, or actual external fulfillment implementation.
- Provider ingestion foundation is implemented for explicit operator-run ExchangeRate-API USD/KRW, Binance public crypto market data snapshot insertion, and KIS WebSocket trade price snapshot insertion. It is not production cron automation, admin HTTP API, KIS REST current-price ingestion, KIS orderbook/hoga ingestion, provider_api eligibility beyond the explicitly allowed read-only/quote workflows and operator-run daily snapshot valuation workflow, or any real trading/account/balance integration.
- Provider live smoke evidence gate on 2026-05-28 KST was PARTIAL GO: ExchangeRate-API and Binance public REST live smoke inserted local `provider_api` rows successfully; KIS WebSocket live smoke was BLOCKED at that time by missing required KIS REST/WS base URL and watchlist/policy env values. Financial read/write source eligibility remained `admin_manual` only at that historical gate.
- Asset Universe / KIS watchlist gate on 2026-05-30 KST is PARTIAL GO / KIS BLOCKED: the fixed 40-stock KIS watchlist is documented, all 40 stock assets were upserted after DB startup, DB mapping counts passed at domestic 15/15 and US 25/25, and ExchangeRate/Binance dry-run rechecks succeeded.
- KIS env completion pre-gate on 2026-05-30 KST remains KIS BLOCKED because `KIS_REST_BASE_URL` and `KIS_WS_BASE_URL` are missing in the loaded env. KIS policy env values have explicit code defaults, but approval_key/connect/subscribe/tick/DB insertion were not attempted without required endpoints.
- Provider API Source Eligibility Pre-Gate on 2026-05-30 KST is docs-only GO: `docs/provider-source-eligibility-pre-gate.md` records eligible source candidates, workflow policy, freshness drafts, source priority options, delayed/free data policy, and financial write-path safety rules. No source eligibility implementation was opened.
- KIS WebSocket Endpoint Env Completion Gate on 2026-05-30 KST remains KIS BLOCKED because `KIS_REST_BASE_URL` and `KIS_WS_BASE_URL` are still missing in the loaded env. KIS dry-run/non-dry-run were not executed.
- KIS WebSocket Endpoint Env Completion Gate retry on 2026-06-01 KST is PARTIAL GO: `.env.local` stayed ignored/untracked and was updated only with non-secret KIS endpoint/policy env keys, required KIS env became present, KIS dry-run and non-dry-run connected successfully, all 40 subscriptions were sent and acknowledged, domestic `H0STCNT0` ticks were parsed, and 12 domestic `kis_krx_realtime_trade` provider_api asset price rows were inserted. US `HDFSCNT0` subscriptions were acknowledged but no US tick or `kis_us_delayed_trade` DB row was observed in the 30-second smoke window.
- KIS US `HDFSCNT0` Tick and DB Insertion Retry Gate on 2026-06-01 KST is PARTIAL: the retry ran around 2026-06-01 11:14-11:21 KST / 2026-05-31 22:14-22:21 EDT, outside the US regular market window. Required KIS env and DB mapping stayed valid, US-only dry-run sent 25 US subscriptions and received aggregate acknowledgement count 30, but no US tick or `kis_us_delayed_trade` DB row was observed. Non-dry-run was skipped because dry-run produced no US tick evidence.
- KIS US `HDFSCNT0` Market-Data Window Validation on 2026-06-03 KST / 2026-06-02 EDT is PARTIAL / DB BLOCKED: required KIS env was present and the US-only dry-run reached the US tick parsing/asset mapping path during the US regular market window, but local PostgreSQL was unreachable at `127.0.0.1:5432`. No dry-run summary JSON, DB mapping counts, or `kis_us_delayed_trade` DB insertion evidence could be completed. Non-dry-run was skipped because DB insertion would fail while local DB is unavailable.
- KIS US `HDFSCNT0` DB-started rerun on 2026-06-03 KST / 2026-06-02 EDT is GO for row insertion evidence: DB migrations were applied, schema/mapping checks passed, US-only dry-run sent 25 subscriptions with 25 acknowledgements and `wouldCreate=35`, and non-dry-run created 25 `kis_us_delayed_trade` provider_api USD rows for active US stock assets with NAS 20 / NYS 5 mapping. ExchangeRate-API and Binance regression dry-runs also succeeded.
- Provider API Source Eligibility Implementation Gate read-only/quote phase on 2026-06-03 KST is GO: fresh provider_api rows can power `/fx quote`, assets `withPrice`, orders quote, live portfolio valuation, home live valuation, and positions live valuation with existing safe `admin_manual` fallback.
- Provider Source Metadata and Outage UX Gate on 2026-06-04 KST is GO in code/docs/tests: allowed read-only/quote responses now expose backward-compatible optional public-safe source metadata (`rateSource`, `priceSource`, `assetPriceSource`, `fxRateSource`, and live valuation source summaries) with fallback/rejection reasons. This did not open execute/write/final/provider-trigger workflows.
- Provider-backed Daily Snapshot Eligibility Gate on 2026-06-05 KST is GO for operator-run daily snapshot valuation only: `daily_portfolio_snapshot` can consume fresh eligible provider_api rows first with explicit admin_manual fallback, and batch job results expose aggregate `sourceSummary` without changing `daily_portfolio_snapshots` schema.
- Daily Snapshot Gate Verification and Realtime Execution Policy Foundation on 2026-06-05 KST is GO for policy/code foundation only: daily snapshot gate completion was verified, `docs/realtime-execution-policy.md` now defines quote-reference/execute-reprice/freshness/bps/error/audit policy, and `src/providers/realtime-execution-policy.ts` adds pure tested helpers without wiring them into current execute/write services.
- Durable Quote Provider Execute Gate on 2026-06-08 KST is GO for `/fx execute` and orders execute: quotes are durable, quote responses return `quoteId`/`expiresAt`/`maxChangeBps`, orders create binds `Order.quoteId`, execute paths reprice from fresh provider_api rows, movement guards fail closed, default `admin_manual` execute fallback is forbidden, and quote consume is in the write transaction.
- Durable Quote hardening and Scheduler/Ops Foundation Gate on 2026-06-08 KST is GO for requestHash hardening and disabled-by-default ops foundation: FX execute and orders create idempotency hashes include `quoteId`; `OpsJobRun`/`OpsJobLock` plus internal scheduler/runner services and `/readiness` exist. Provider ingestion HTTP triggers, batch HTTP APIs, real trading/account APIs, reward fulfillment, and admin role management remain closed.
- Scheduler/Ops hardening and Admin/operator Account Management Gate on 2026-06-09 KST is GO in code/docs/tests: `SCHEDULER_TICK_INTERVAL_MS=60000` is documented/tested, scheduler remains disabled-by-default and dry-run-by-default, placeholder jobs remain skipped/`NOT_IMPLEMENTED`, opt-in real DB lock smoke exists, and admin-only user list/get/role-change APIs with success/failure audit are implemented. Admin user restore/status management, production scheduler automatic writes, provider ingestion HTTP triggers, batch HTTP APIs, reward fulfillment, and real trading/account APIs remain closed.
- Admin User Status / Restore and Internal Reward Fulfillment Backend Gate on 2026-06-09 KST is GO in code/docs/tests: admin-only status patch and deleted user restore are implemented with self/last-active-admin protection, restore-to-user, refresh-session revocation on suspend/delete, and success/failure audit. Operator/admin internal reward fulfillment queue/status APIs are implemented with idempotency replay/conflict, duplicate reward prevention, fulfill-to-`SeasonReward`, cancel, failure marking, and fulfilled-only user reward visibility. External reward/payment/point/coupon/gifticon APIs, scheduler automatic reward, provider ingestion HTTP triggers, batch HTTP APIs, and real trading/account APIs remain closed.
- Provider API Source Eligibility remains closed for orders create source selection, ranking, settlement/final result, provider ingestion trigger APIs, batch HTTP APIs, external reward provider workflows, and real trading/account/order/deposit/withdrawal APIs. Scheduler/Ops foundation exists but does not open those workflows.
- Home settled final-result read model is implemented from existing `rankType=final` `season_rankings`; final tier assignment and operator/admin internal reward fulfillment have MVP paths. `reward-grant` fails closed with `REWARD_POLICY_GATE_CLOSED` until Reward Policy / Catalog is defined. Actual payment/point/delivery/external fulfillment remains a separate gate.
- `docs/current-status.md` remains the short status summary. This document is the detailed backend gate roadmap.

## Audit Basis

Current source-of-truth and active reference documents:

- `docs/codex-rulepack.md`
- `docs/current-status.md`
- `docs/backend-test-coverage-matrix.md`
- `docs/auth-api-contract.md`
- `docs/operator-api-contract.md`
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
- `docs/scheduler-ops-foundation.md`
- `docs/provider-ingestion-foundation.md`
- `docs/crypto-usd-settlement-policy-update.md`
- `docs/provider-final-selection-readiness-recheck.md`
- `docs/asset-price-freshness-policy.md`
- `docs/realtime-execution-policy.md`
- `docs/provider-evidence-capture.md`
- `docs/provider-source-eligibility-pre-gate.md`
- `docs/docs-inventory.md`
- `README.md`

Historical planning and STOP/review/preimplementation documents are archived in `docs/archive/` and are not current source of truth.

Reviewed code/test surface:

- `package.json`, `prisma/schema.prisma`
- `src/app.module.ts`, `src/app.controller.ts`
- `src/auth/*`
- `src/operator/*`
- `src/seasons/*`
- `src/fx/*`
- `src/orders/*`
- `src/home/*`
- `src/ranking/*`
- `src/wallets/*`
- `src/positions/*`
- `src/records/*`
- `src/portfolio/*`
- `src/ops/*`
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

- Current status: Core user, role, operator audit, season, wallet, ledger, FX, asset, price, position, order, daily snapshot, and ranking tables are represented in Prisma schema and migrations.
- Implemented files: `prisma/schema.prisma`, migrations under `prisma/migrations/*`.
- Source of truth: `docs/current-status.md`, `docs/backend-gate-roadmap.md`.
- Existing tests: `pnpm exec prisma validate` history in `docs/current-status.md`; integration specs use real Prisma/PostgreSQL when env flags are enabled.
- Known limitations: no settlement/reward policy catalog beyond existing reward fields and internal fulfillment queue, no order fill/execute request table, no provider ingestion metadata table beyond snapshot raw payload fields, and no external reward/payment/point/delivery fulfillment schema.
- Remaining work: schema gates only when settlement, reward, exact order execute replay, provider-specific needs, or future access-token blacklist/cookie-session needs are approved.
- Risk level: MEDIUM.
- Recommended next action: no schema changes in planning gates; validate schema before any later implementation gate.

### Batch Job Foundation

- Current status: common batch job execution envelope implemented for operator/internal work, plus operator-run daily portfolio snapshot and season ranking jobs, an operator-run daily season cycle orchestration job, an operator-run season settlement MVP job, an operator-run final tier assignment MVP job, and an operator-run reward-grant gate-closed job. `BatchJobRun` records jobName, idempotencyKey, status, dryRun, start/finish timestamps, request/result JSON, and failure code/message.
- Implemented files: `src/batch/batch.module.ts`, `src/batch/batch.service.ts`, `src/batch/batch.types.ts`, `src/batch/batch-admin-runner.ts`, `src/batch/daily-portfolio-snapshot-job.service.ts`, `src/batch/daily-portfolio-snapshot-job.types.ts`, `src/batch/season-ranking-job.service.ts`, `src/batch/season-ranking-job.types.ts`, `src/batch/daily-season-cycle-job.service.ts`, `src/batch/daily-season-cycle-job.types.ts`, `src/batch/season-settlement-job.service.ts`, `src/batch/season-settlement-job.types.ts`, `src/batch/final-tier-assignment-job.service.ts`, `src/batch/final-tier-assignment-job.types.ts`, `src/batch/reward-grant-job.service.ts`, `src/batch/reward-grant-job.types.ts`, `scripts/admin-run-batch-job.ts`, `prisma/schema.prisma`, migration `20260519095458_add_batch_job_runs`, migration `20260523090000_add_reward_badge_trophy_foundation`.
- Source of truth: `docs/batch-job-foundation.md`, `docs/current-status.md`, `docs/backend-gate-roadmap.md`.
- Existing tests: `src/batch/batch.service.spec.ts`, `src/batch/daily-portfolio-snapshot-job.service.spec.ts`, `src/batch/season-ranking-job.service.spec.ts`, `src/batch/daily-season-cycle-job.service.spec.ts`, `src/batch/season-settlement-job.service.spec.ts`, `src/batch/final-tier-assignment-job.service.spec.ts`, `src/batch/reward-grant-job.service.spec.ts`, `src/batch/batch-admin-runner.spec.ts`.
- Known limitations: no provider ingestion job, no reward policy/catalog write path, no actual reward/payment/point/delivery/external fulfillment job, no ranking overwrite/regeneration policy, and no batch execution HTTP API. Admin/operator roles now exist, but HTTP batch execution remains a separate gate. The daily snapshot job can use existing fresh eligible provider_api evidence first with explicit admin_manual fallback and does not create provider/price/FX rows or rankings. The season ranking job reads existing `daily_portfolio_snapshots` only and does not create snapshots. The daily season cycle job only orchestrates those two child services in order. The season settlement MVP job reads existing `daily_portfolio_snapshots`, creates `rankType=final` rankings, and transitions `ended` seasons to `settled`; it does not recalculate portfolios, call providers, run cron, or grant rewards. The final tier assignment MVP job reads existing final rankings and updates only participant `finalRank`/`finalTier`; it does not grant rewards or change ranking policy. The reward-grant job intentionally fails closed with `REWARD_POLICY_GATE_CLOSED`, does not read participant eligibility, and does not write `rewardGrantedAt`, `badges`, `user_badges`, or `season_rewards`.
- Remaining work: define deployment scheduler ownership separately; ranking automation/overwrite, provider ingestion, settlement extensions beyond final tier assignment, true competition tie rank, Reward Policy / Catalog, reward-grant write path, and actual reward/payment/point/delivery/external fulfillment remain separate gates.
- Risk level: MEDIUM.
- Recommended next action: keep executable jobs limited to `noop`, `health-check`, `daily-portfolio-snapshot`, `season-ranking`, `daily-season-cycle`, `season-settlement`, `final-tier-assignment`, and `reward-grant`; open separate gates for scheduler automation, provider ingestion, settlement extensions, true tie rank, reward policy/catalog, and external reward fulfillment.

### Scheduler / Ops Foundation

- Current status: disabled-by-default and dry-run-by-default scheduler/ops foundation is implemented with `OpsJobRun`, `OpsJobLock`, internal run/lock/runner/scheduler services, non-secret scheduler env defaults including `SCHEDULER_TICK_INTERVAL_MS=60000`, opt-in real DB lock smoke coverage, and public `/readiness`.
- Implemented files: `src/ops/*`, `src/app.service.ts`, `src/app.controller.ts`, `src/app.module.ts`, `prisma/schema.prisma`, migration `20260608120000_add_ops_scheduler_foundation`.
- Source of truth: `docs/scheduler-ops-foundation.md`, `docs/current-status.md`, `docs/backend-gate-roadmap.md`.
- Existing tests: `src/ops/*.spec.ts`, `test/app.e2e-spec.ts`.
- Known limitations: provider FX/Binance ingestion, season ranking generation, season settlement, and reward-grant scheduler runners are explicit skipped/not-implemented placeholders. The daily snapshot ops runner can call existing `DailyPortfolioSnapshotJobService` with lock/audit/dryRun support, but production scheduler ownership and non-dry-run automation remain separate gates.
- Remaining work: deployment ownership, cron timing, job-specific retry/backoff hardening, production scheduler enablement, provider ingestion service runner implementation, scheduler reward automation, and external reward fulfillment remain separate gates.
- Risk level: MEDIUM.
- Recommended next action: keep `SCHEDULER_ENABLED=false` and scheduler `dryRun=true` by default; use ops service tests and dry-run internal runner calls until a Production Scheduler Ownership Gate opens real automatic writes.

### Auth

- Current status: access token + opaque refresh token Auth MVP implemented with signup, login, refresh, logout, logout-all, `GET /api/v1/me`, global access token guard, public and optional-auth route metadata, active-user DB lookup, current DB role injection, inactive user block, refresh-token hash storage, rotation, refresh-session revocation, and no `x-user-id` fallback. New signup defaults to `UserRole.user`.
- Implemented files: `src/auth/auth.module.ts`, `src/auth/auth.controller.ts`, `src/auth/auth.service.ts`, `src/auth/access-token.guard.ts`, `src/auth/auth.decorators.ts`, `src/auth/auth.types.ts`, `src/operator/*`, `src/app.module.ts`.
- Source of truth: `docs/current-status.md`, `docs/auth-api-contract.md`, `docs/backend-gate-roadmap.md`, `README.md`.
- Existing tests: `src/auth/auth.service.spec.ts`, `src/auth/access-token.guard.spec.ts`, `src/auth/auth.integration.spec.ts`, `test/app.e2e-spec.ts`.
- Known limitations: access-token blacklist/revocation, cookie auth, server-side session auth beyond refresh sessions, issuer/audience policy, and refresh-token reuse theft-response hardening are not implemented.
- Remaining work: keep Bearer access-token guard behavior stable; defer access-token blacklist/cookie-session/auth-hardening to separate gates.
- Risk level: MEDIUM.
- Recommended next action: keep protected API HTTP e2e baseline and refresh rotation/logout tests green.

### Operator/Admin Authorization And Account Management

- Current status: `UserRole` enum and `users.role` are implemented with `user`, `operator`, and `admin`. `GET /api/v1/operator/me` is implemented as the minimal operator-only smoke endpoint. Admin-only user list/get, explicit role-change, status patch, and deleted-user restore APIs are implemented. Role/status/restore changes are audited on success/failure.
- Implemented files: `src/operator/*`, `src/auth/access-token.guard.ts`, `src/auth/auth.types.ts`, `src/auth/auth.service.ts`, `src/app.module.ts`, `prisma/schema.prisma`, migration `20260601090000_add_user_role_operator_audit_logs`, migration `20260609120000_add_user_status_restore_internal_reward_fulfillment`.
- Source of truth: `docs/operator-api-contract.md`, `docs/auth-api-contract.md`, `docs/current-status.md`.
- Existing tests: `src/operator/operator.guard.spec.ts`, `src/operator/operator-audit.service.spec.ts`, `src/operator/operator-account-management.service.spec.ts`, `src/operator/operator-user-status.service.spec.ts`, `src/auth/access-token.guard.spec.ts`, `src/auth/auth.service.spec.ts`, `test/app.e2e-spec.ts`.
- Known limitations: no provider ingestion trigger API, no batch run HTTP API, no scheduler HTTP API, no external reward provider API, and no real trading/account API. `GET /api/v1/operator/me` remains read-only and does not write audit rows.
- Remaining work: Reward Policy / Reward Catalog Gate, Scheduler Production Ownership Gate, or Backend Release / Operations Runbook Gate. This remains separate from provider_api source eligibility.
- Risk level: MEDIUM.
- Recommended next action: keep operator boundary tests green and avoid adding executable ops mutations until a dedicated gate defines authorization and audit semantics.

### Seasons

- Current status: current season read with optional auth and season join write path implemented. `GET /api/v1/seasons/current` preserves DB `status` and also returns `effectiveStatus`/`effectiveMode` based on `startAt`/`endAt` via `season-lifecycle.policy.ts`.
- Implemented files: `src/seasons/seasons.controller.ts`, `src/seasons/seasons.service.ts`.
- Source of truth: `docs/codex-rulepack.md`, `docs/current-status.md`.
- Existing tests: `src/seasons/seasons.controller.spec.ts`, `src/seasons/seasons.service.spec.ts`, `src/seasons/seasons.join.integration.spec.ts`, `test/app.e2e-spec.ts` auth/write-path baseline.
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

- Current status: `GET /api/v1/positions` read-only MVP implemented for full holdings/positions screen. It reads existing positions/assets, fresh eligible `provider_api` asset/FX rows first where allowed, and existing safe `admin_manual` fallback rows when valuation data is needed.
- Implemented files: `src/positions/positions.controller.ts`, `src/positions/positions.service.ts`, `src/positions/positions.module.ts`.
- Source of truth: `docs/positions-api-contract.md`, `docs/current-status.md`.
- Existing tests: `src/positions/positions.service.spec.ts`, `test/app.e2e-spec.ts`.
- Known limitations: no provider price source, no implemented asset price stale threshold, no real DB positions read integration, no settlement/final-result integration.
- Remaining work: real PostgreSQL read-only scenario if launch-critical; asset price freshness/provider work only after provider gates.
- Risk level: MEDIUM.
- Recommended next action: keep read-only provider eligibility limited to the approved workflow; do not expand execute/scheduler/settlement/reward from this endpoint.

### FX Quote

- Current status: `POST /api/v1/fx/quote` durable quote MVP implemented; KRW/USD only; uses fresh provider_api first with admin_manual fallback and stores active `Quote` rows with 15-second TTL.
- Implemented files: `src/fx/fx.controller.ts`, `src/fx/fx.service.ts`, `src/fx/fx-decimal-policy.ts`, `scripts/admin-insert-fx-rate.ts`.
- Source of truth: `docs/fx-api-contract.md`, `docs/current-status.md`.
- Existing tests: `src/fx/fx.service.spec.ts`, `src/fx/fx-decimal-policy.spec.ts`, `src/fx/fx-rate-input.validation.spec.ts`, `test/app.e2e-spec.ts`.
- Known limitations: current quote is a reference quote, not a guaranteed execution price.
- Remaining work: broader quote recovery/cleanup policy if quote table retention becomes operationally important.
- Risk level: MEDIUM.
- Recommended next action: keep quote persistence/hash/source metadata tests green; do not add provider trigger APIs.

### FX Execute

- Current status: `POST /api/v1/fx/execute` Durable Quote provider-backed write path implemented with durable idempotency via `fx_execute_requests`, quote validation, execute-time provider USD/KRW repricing, guarded source debit, target credit, exchange row, two wallet ledger rows, succeeded response replay, quote consume, and no equity snapshot.
- Implemented files: `src/fx/fx.service.ts`, `src/fx/fx-execute-*.ts`.
- Source of truth: `docs/fx-api-contract.md`, `docs/current-status.md`.
- Existing tests: `src/fx/fx.service.spec.ts`, `src/fx/fx.execute.integration.spec.ts`, FX execute policy specs under `src/fx/*spec.ts`, `test/app.e2e-spec.ts` auth baseline.
- Known limitations: stale pending recovery tool/job absent; some DB-level failure injection remains hardening-only; responsePayloadJson-only storage failure remains hard to force with current schema.
- Remaining work: recovery/hardening remains separate; broader DB smoke for provider-backed quote/execute can be added if launch critical.
- Risk level: HIGH.
- Recommended next action: keep provider-only execute source and quote consume atomicity tests green; do not add emergency manual override without a separate operator gate.

### Assets / Price Input

- Current status: `GET /api/v1/assets` and `GET /api/v1/assets/:assetId` read-only MVP are implemented for order-screen asset discovery/selection. `withPrice=true` can use fresh eligible `provider_api` rows first with existing `admin_manual` fallback. Asset upsert CLI and admin_manual asset price snapshot CLI remain implemented; validation rejects inactive assets, currency mismatch, non-admin_manual source, invalid decimals, and forbidden wording.
- Implemented files: `src/assets/assets.controller.ts`, `src/assets/assets.service.ts`, `src/assets/assets.module.ts`, `scripts/admin-upsert-asset.ts`, `scripts/admin-insert-asset-price.ts`, `src/assets/asset-admin-input.validation.ts`.
- Source of truth: `docs/assets-api-contract.md`, `docs/current-status.md`, `docs/orders-api-contract.md`, `docs/home-api-contract.md`.
- Existing tests: `src/assets/assets.service.spec.ts`, `src/assets/asset-admin-input.validation.spec.ts`, `test/app.e2e-spec.ts`.
- Known limitations: no provider price ingestion; no implemented asset price stale threshold; no scheduler; no admin HTTP API; no real DB assets list/detail integration.
- Remaining work: real DB read smoke if launch-critical; execute/write/final provider eligibility remains separate.
- Risk level: MEDIUM.
- Recommended next action: keep Assets API read-only and provider/admin fallback only; use separate gates for write/final/scheduler expansion.

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

- Current status: `POST /api/v1/orders/quote` durable quote MVP implemented; active season + joined participant; market can use fresh eligible `provider_api` asset price first with `admin_manual` fallback; limit uses limitPrice; USD assets can use provider USD/KRW first with fresh approved admin_manual fallback; buy/sell resource checks are read-only; active `Quote` rows are stored with 15-second TTL.
- Implemented files: `src/orders/orders.controller.ts`, `src/orders/orders.service.ts`.
- Source of truth: `docs/orders-api-contract.md`, `docs/current-status.md`.
- Existing tests: `src/orders/orders.service.spec.ts`, `test/app.e2e-spec.ts`.
- Known limitations: submitted quote values are reference estimates, not guaranteed fills.
- Remaining work: retention/cleanup policy for old quotes if operationally needed.
- Risk level: MEDIUM.
- Recommended next action: keep durable quote hash/source metadata tests green.

### Orders Create

- Current status: durable quote-bound submitted order create MVP implemented; validates and stores `orders.quoteId`, creates one `orders` row, stores create idempotency key/hash/response payload, and performs no wallet/position/settlement mutation.
- Implemented files: `src/orders/orders.service.ts`, `src/orders/orders.controller.ts`, `prisma/schema.prisma` order idempotency fields.
- Source of truth: `docs/orders-api-contract.md`, `docs/current-status.md`.
- Existing tests: `src/orders/orders.service.spec.ts`, `test/app.e2e-spec.ts` auth baseline.
- Known limitations: no DB integration for create idempotency races beyond mocked P2002; duplicate replay after cancellation returns original create response by design. Orders create does not directly read provider rows.
- Remaining work: add real DB idempotency race coverage if create path becomes a launch blocker.
- Risk level: MEDIUM.
- Recommended next action: keep quote binding and idempotency replay ordering documented and tested.

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

- Current status: Durable Quote provider-backed full-fill execute MVP implemented. Buy debits cash wallet, creates/updates position, creates one `order_buy` ledger row, and finalizes order. Sell decrements position, credits cash wallet, creates one `order_sell` ledger row, and finalizes order. Execute validates/consumes `order.quote`, reprices with fresh provider_api asset/FX evidence, and all financial writes run in one Prisma transaction.
- Implemented files: `src/orders/orders.service.ts`, `src/orders/orders.controller.ts`.
- Source of truth: `docs/orders-api-contract.md`, `docs/current-status.md`.
- Existing tests: `src/orders/orders.service.spec.ts`, `src/orders/orders.execute.integration.spec.ts`, `test/app.e2e-spec.ts` auth baseline.
- Known limitations: no exact execute response replay, no execute-specific command table, no partial fill, no matching engine, no settlement side effect, no automatic snapshots/rankings.
- Remaining work: exact replay/partial fill/matching/settlement each require separate gate.
- Risk level: HIGH.
- Recommended next action: keep full-fill MVP stable; do not expand matching/settlement before provider/scheduler/settlement audits.

### Portfolio Valuation

- Current status: valuation service/policy implemented for KRW cash, USD cash conversion, positions, fresh eligible provider asset/FX rows for explicitly allowed live workflows and daily snapshot valuation, existing admin_manual fallback, KRW total assets, and return rate.
- Implemented files: `src/portfolio/portfolio-valuation.service.ts`, `src/portfolio/portfolio-valuation.policy.ts`.
- Source of truth: `docs/current-status.md`, `docs/home-api-contract.md`.
- Existing tests: `src/portfolio/portfolio-valuation.policy.spec.ts`, `src/home/home.service.spec.ts`.
- Known limitations: provider eligibility is limited to read-only/quote and operator-run daily snapshot valuation; final settlement still uses existing snapshot/ranking evidence; no automatic snapshot schedule; valuation can be unavailable when price/FX evidence is missing.
- Remaining work: asset price freshness implementation and scheduler/batch foundation.
- Risk level: MEDIUM.
- Recommended next action: treat as calculation foundation, not final settlement evidence.

### Daily Portfolio Snapshot

- Current status: manual CLI foundation and operator-run batch job implemented. The batch job creates `daily_portfolio_snapshots` for active participants of one season/date through `BatchService.runJob`, supports dry-run, generated or explicit idempotency keys, existing snapshot skip, participant-level valuation failure, provider_api fresh-first valuation with admin_manual fallback, and aggregate sourceSummary result reporting. The `daily-season-cycle` orchestration job can run this job before season ranking.
- Implemented files: `scripts/admin-generate-daily-portfolio-snapshot.ts`, `src/portfolio/daily-portfolio-snapshot-generation.ts`, `src/batch/daily-portfolio-snapshot-job.service.ts`, `src/batch/daily-portfolio-snapshot-job.types.ts`, `src/batch/batch-admin-runner.ts`.
- Source of truth: `docs/current-status.md`, `docs/home-api-contract.md`, `docs/batch-job-foundation.md`.
- Existing tests: `src/portfolio/snapshot-ranking-generation.spec.ts`, `src/batch/daily-portfolio-snapshot-job.service.spec.ts`, `src/batch/batch-admin-runner.spec.ts`.
- Known limitations: no cron scheduler; no provider ingestion trigger; no actual reward/payment/badge/trophy fulfillment; settlement is handled only by the separate operator-run `season-settlement` MVP job; no real DB batch script smoke yet. Snapshot row schema does not store source metadata; source evidence is in batch result summaries and tests.
- Remaining work: separate scheduler/deployment ownership gate if automation is required.
- Risk level: MEDIUM.
- Recommended next action: keep daily snapshot generation operator-run; use `season-ranking` as the separate operator-run ranking path; defer cron automation to a scheduler/deployment gate.

### Ranking

- Current status: `GET /api/v1/ranking` read-only MVP implemented; manual ranking generation helper/CLI, operator-run season ranking batch job, and season settlement final ranking now share the revised persisted ranking policy. API reads `season_rankings` only and exposes stored `maxDrawdown`, `totalFillCount`, and `reachedReturnAt` tie-breaker evidence. The `daily-season-cycle` orchestration job can run ranking after daily snapshots.
- Implemented files: `src/ranking/ranking.controller.ts`, `src/ranking/ranking.service.ts`, `src/ranking/ranking-calculation.policy.ts`, `scripts/admin-generate-season-ranking.ts`, `src/portfolio/season-ranking-generation.ts`, `src/batch/season-ranking-job.service.ts`, `src/batch/season-settlement-job.service.ts`.
- Source of truth: `docs/ranking-api-contract.md`, `docs/current-status.md`.
- Existing tests: `src/ranking/ranking.service.spec.ts`, `src/ranking/ranking-calculation.policy.spec.ts`, `src/portfolio/snapshot-ranking-generation.spec.ts`, `src/batch/season-ranking-job.service.spec.ts`, `src/batch/season-settlement-job.service.spec.ts`, `test/app.e2e-spec.ts`.
- Known limitations: no cron-driven automatic season ranking generation, no external reward fulfillment integration, and no real DB ranking generator test. Current schema enforces unique persisted rank per season/date/type, so true same-rank competition ties require a separate schema gate. Rows created before migration `20260618090000_add_season_ranking_tiebreakers` can have `reachedReturnAt = null`; `maxDrawdown` and `totalFillCount` are default-backfilled to zero. Migration deployment and old-row backfill decisions are documented in `docs/ranking-backfill-runbook.md`.
- Remaining work: scheduler-driven ranking automation only after scheduler/deployment ownership is defined.
- Risk level: MEDIUM.
- Recommended next action: Gate G only after Gate E and F.

### Home

- Current status: `GET /api/v1/home` aggregate read-only MVP implemented. Supports active_joined, active_not_joined, upcoming, ended, settled_joined, settled_not_joined, no_current_season using effective season mode from `season-lifecycle.policy.ts`. Active joined uses latest daily snapshot first, then live valuation if possible. Settled joined uses existing `rankType=final` `season_rankings` as the authoritative final result source and existing `daily_portfolio_snapshots` as supporting equity chart data. `topPositions.returnRate` is percent-scale.
- Implemented files: `src/home/home.controller.ts`, `src/home/home.service.ts`.
- Source of truth: `docs/home-api-contract.md`, `docs/current-status.md`.
- Existing tests: `src/home/home.service.spec.ts`, `test/app.e2e-spec.ts`.
- Known limitations: provider-backed price/FX evidence is limited to approved live/read valuation workflows; Home daily snapshot sections read existing snapshots only and do not generate them. Automatic snapshot/ranking generation, reward policy/catalog execution, actual reward/payment/point/delivery/external fulfillment, and settlement extensions remain unavailable/blocked. Missing final rankings remain unavailable with no live valuation fallback. Missing `finalTier` remains `FINAL_TIER_UNAVAILABLE` until the operator-run final tier assignment job is executed. Missing `rewardGrantedAt` remains `REWARD_NOT_GRANTED` unless it already exists from internal fulfillment or legacy/manual data; the reward-grant batch job currently fails closed.
- Remaining work: scheduler daily snapshots, ranking automation, reward policy/catalog, reward-grant write path, external reward fulfillment, and settlement extensions beyond existing final rankings/final tier assignment/internal fulfillment foundations.
- Risk level: MEDIUM.
- Recommended next action: keep provider/scheduler/external fulfillment gates closed; add real DB Home settled scenarios if this read-only surface becomes launch-critical.

### Records

- Current status: `GET /api/v1/records` unified read-only MVP implemented for exchanges, wallet transactions, and orders. Season history read-only APIs are also implemented: `GET /api/v1/records/me/seasons`, `GET /api/v1/records/me/seasons/:seasonId`, `GET /api/v1/records/me/seasons/:seasonId/orders`, `GET /api/v1/records/me/seasons/:seasonId/exchanges`, and protected public summary `GET /api/v1/users/:userId/records/:seasonId`. Season detail includes `profitAnalysis` with realized/unrealized/total PnL KRW across open and quantity `0` fully sold positions; public user summary includes top-5 public holdings without private position/wallet/order/exchange details.
- Implemented files: `src/records/records.controller.ts`, `src/records/records.service.ts`.
- Source of truth: `docs/records-api-contract.md`, `docs/current-status.md`.
- Existing tests: `src/records/records.service.spec.ts`, `src/orders/orders.execute.integration.spec.ts` read visibility, `test/app.e2e-spec.ts`.
- Known limitations: no export view; no real DB read-only no-mutation test for all filters. Public user season summary intentionally excludes private ledgers, wallet balances, position quantity, average cost, individual orders, and individual exchanges.
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

- Current status: foundation implemented for explicit operator-run provider_api snapshot insertion. ExchangeRate-API can create USD/KRW `fx_rate_snapshots`; Binance public REST ticker can create USD-equivalent crypto `asset_price_snapshots` for existing unambiguous `BINANCE` crypto assets; KIS WebSocket can create domestic KRX `H0STCNT0` and US delayed/free `HDFSCNT0` trade-price `asset_price_snapshots` for existing unambiguous active stock assets.
- Implemented files: `src/providers/**`, `scripts/provider-ingest-fx-rate.ts`, `scripts/provider-ingest-binance-prices.ts`, `scripts/provider-ingest-kis-websocket-prices.ts`, `src/app.module.ts`.
- Source of truth: `docs/provider-ingestion-foundation.md`, `docs/provider-final-selection-readiness-recheck.md`, `docs/asset-price-freshness-policy.md`, `docs/provider-evidence-capture.md`, `docs/crypto-usd-settlement-policy-update.md`.
- Existing tests: provider config, secret redaction, raw payload truncation, ExchangeRate parsing/ingestion, Binance parsing/ingestion, KIS watchlist, KIS token/approval parsing, KIS WebSocket subscription/parser/ingestion coverage, and KIS no-real-trading-surface guard under `src/providers/**/*.spec.ts`.
- Known limitations: no provider cron scheduler, no admin HTTP provider ingestion API, no Binance WebSocket ingestion, no KIS REST current-price ingestion, no KIS orderbook/hoga ingestion, no provider_api source eligibility outside the read-only/quote allowlist, no new provider metadata schema, and no provider-backed final settlement policy.
- Remaining work: provider_api execute/write/final eligibility gates, KIS REST quote endpoint mapping only if a future gate needs it, scheduler/deployment ownership, and provider outage monitoring.
- Risk level: MEDIUM.
- Recommended next action: keep provider_api use limited to the implemented read-only/quote allowlist until a later gate explicitly changes write/final paths.

### Scheduler / Batch

- Current status: batch job execution envelope and operator-run daily portfolio snapshot/season ranking/daily season cycle/season settlement/final tier assignment MVP jobs are implemented. `reward-grant` is callable through the batch envelope but fails closed with `REWARD_POLICY_GATE_CLOSED`; cron scheduler is not implemented.
- Implemented files: `src/batch/**`, `scripts/admin-run-batch-job.ts`, `prisma/migrations/20260519095458_add_batch_job_runs/migration.sql`.
- Source of truth: `docs/batch-job-foundation.md`, `docs/current-status.md`, provider STOP docs.
- Existing tests: `src/batch/batch.service.spec.ts`, `src/batch/daily-portfolio-snapshot-job.service.spec.ts`, `src/batch/season-ranking-job.service.spec.ts`, `src/batch/daily-season-cycle-job.service.spec.ts`, `src/batch/season-settlement-job.service.spec.ts`, `src/batch/final-tier-assignment-job.service.spec.ts`, `src/batch/reward-grant-job.service.spec.ts`, `src/batch/batch-admin-runner.spec.ts`; manual helper dry-run tests remain separate.
- Known limitations: manual CLI, operator-run batch jobs, cron scheduler, and automatic business jobs must not be conflated. Daily snapshots are operator-run and use fresh eligible provider DB evidence first with `admin_manual` fallback only. Season rankings are operator-run and read existing daily snapshots only. Daily season cycle is operator-run orchestration only. Season settlement is operator-run and finalizes from existing daily snapshots/final rankings only. Final tier assignment is operator-run and assigns participant final rank/tier from existing final rankings only. Reward-grant remains a gate-closed batch job and writes no reward business rows.
- Remaining work: cron/deployment ownership and separate provider/settlement-extension/reward policies before automatic provider or settlement jobs.
- Risk level: HIGH.
- Recommended next action: keep executable jobs limited to `noop`, `health-check`, `daily-portfolio-snapshot`, `season-ranking`, `daily-season-cycle`, `season-settlement`, `final-tier-assignment`, and `reward-grant` until separate scheduler/provider/reward policy gates open.

### Settlement

- Current status: operator-run season settlement MVP job implemented. It finalizes from existing settlement-date `daily_portfolio_snapshots` or existing final rankings, writes `rankType=final` `season_rankings`, and transitions `ended` seasons to `settled` through `BatchService.runJob`. Home can read those final rankings for settled joined participants.
- Implemented files: `src/batch/season-settlement-job.service.ts`, `src/batch/season-settlement-job.types.ts`, `src/batch/batch-admin-runner.ts`, `scripts/admin-run-batch-job.ts`.
- Source of truth: `docs/codex-rulepack.md`, `docs/current-status.md`, `docs/home-api-contract.md`, `docs/batch-job-foundation.md`.
- Existing tests: `src/batch/season-settlement-job.service.spec.ts`, `src/batch/batch-admin-runner.spec.ts`.
- Known limitations: no provider ingestion, no cron scheduler, no portfolio recalculation, no reward policy/catalog write path, no actual reward/payment/point/delivery/external fulfillment, no HTTP batch execution API, and no true competition tie rank because current `season_rankings` enforces unique rank per season/date/type. Final tier assignment exists as a separate operator-run MVP job; reward-grant is present only as a gate-closed job.
- Remaining work: Reward Policy / Catalog, reward-grant write path, external reward fulfillment handoff, true tie-rank schema policy if required, and any settlement extension beyond existing daily snapshots/final tier assignment remain separate gates.
- Risk level: HIGH.
- Recommended next action: keep settlement as operator-run finalization only; do not add provider, cron, reward, true tie-rank schema work, or settlement extensions without separate gates.

### Final Tier Assignment

- Current status: operator-run final tier assignment MVP job implemented. It reads existing `rankType=final` `season_rankings` for a settled season and selected `rankingDate`, then assigns `SeasonParticipant.finalRank` and `finalTier` only for participants that do not already have either field.
- Implemented files: `src/batch/final-tier-assignment-job.service.ts`, `src/batch/final-tier-assignment-job.types.ts`, `src/batch/batch-admin-runner.ts`, `scripts/admin-run-batch-job.ts`.
- Source of truth: `docs/current-status.md`, `docs/home-api-contract.md`, `docs/batch-job-foundation.md`.
- Existing tests: `src/batch/final-tier-assignment-job.service.spec.ts`, `src/batch/batch-admin-runner.spec.ts`, `src/home/home.service.spec.ts`.
- Implemented behavior: final tier policy is fixed at cumulative cutoffs `master` 4%, `diamond` 11%, `platinum` 23%, `gold` 40%, `silver` 70%, `bronze` 100%, with cutoff `ceil(totalParticipants * cumulativeRatio)` from final ranking rank. `Season.rewardPolicyJson` and reward policy/catalog do not override final tier cutoffs.
- Known limitations: no reward policy/catalog, external reward/payment/point/delivery fulfillment, provider ingestion, cron scheduler, HTTP batch execution API, ranking regeneration, reward-policy-driven tier override, or true competition tie rank because the current final ranking source persists deterministic unique sequential rank.
- Remaining work: reward policy/catalog, external fulfillment handoff, and true tie-rank schema policy remain separate gates.
- Risk level: MEDIUM.
- Recommended next action: run this after `season-settlement` for settled seasons that have final rankings. Do not expect reward-grant writes until Reward Policy / Catalog is defined.

### Reward

- Current status: operator-run reward-grant exists only as a gate-closed batch job, while operator/admin internal reward fulfillment queue/status MVP remains implemented. The batch job always fails closed with `REWARD_POLICY_GATE_CLOSED` for dry-run and non-dry-run, records a zero-count failure payload, and does not write `SeasonParticipant.rewardGrantedAt`, `badges`, `user_badges`, or `season_rewards`. The fulfillment API creates pending internal requests, supports idempotency replay/conflict, fulfills by creating `SeasonReward`, and exposes only fulfilled `SeasonReward` rows to user rewards APIs.
- Implemented files: `src/batch/reward-grant-job.service.ts`, `src/batch/reward-grant-job.types.ts`, `src/batch/batch-admin-runner.ts`, `scripts/admin-run-batch-job.ts`, `src/rewards/rewards.module.ts`, `src/rewards/rewards.controller.ts`, `src/rewards/rewards.service.ts`, `src/rewards/operator-reward-fulfillment.controller.ts`, `src/rewards/reward-fulfillment.service.ts`, `prisma/schema.prisma`, migration `20260523090000_add_reward_badge_trophy_foundation`, migration `20260609120000_add_user_status_restore_internal_reward_fulfillment`.
- Source of truth: `docs/current-status.md`, `docs/batch-job-foundation.md`, `docs/home-api-contract.md`, `docs/rewards-api-contract.md`, `prisma/schema.prisma`.
- Existing tests: `src/batch/reward-grant-job.service.spec.ts`, `src/batch/batch-admin-runner.spec.ts`, `src/home/home.service.spec.ts`, `src/rewards/rewards.service.spec.ts`, `src/rewards/reward-fulfillment.service.spec.ts`, `test/app.e2e-spec.ts`.
- Known limitations: no reward-grant write path, reward amount calculation, reward catalog, point wallet, payment, delivery, external transfer, provider ingestion, cron scheduler, HTTP batch execution API, scheduler automatic reward fulfillment, or custom fulfillment policy. `rewardPolicyJson` is not used for actual amount/item fulfillment in this MVP.
- Remaining work: define Reward Policy / Catalog before enabling reward-grant writes, and define external payment/point/delivery fulfillment policy if product requires it.
- Risk level: HIGH.
- Recommended next action: use operator/admin internal fulfillment only for explicitly requested internal DB rewards until Reward Policy / Catalog is defined; keep reward-grant writes and external fulfillment as separate gates.

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

| API                                           | Controller           | Auth policy | Identity source                                                 | Expected missing token result | Expected invalid token result | `x-user-id` behavior    | Current e2e coverage                                                                    | Remaining coverage gap                                                     |
| --------------------------------------------- | -------------------- | ----------- | --------------------------------------------------------------- | ----------------------------- | ----------------------------- | ----------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `GET /health`                                 | `AppController`      | public      | none                                                            | 200                           | allowed; token ignored        | ignored                 | Public success in `test/app.e2e-spec.ts`                                                | invalid-token-on-public not explicitly asserted                            |
| `GET /health/db`                              | `AppController`      | public      | none                                                            | 200                           | allowed; token ignored        | ignored                 | Public DB health success without user lookup                                            | invalid-token-on-public not explicitly asserted                            |
| `POST /api/v1/auth/signup`                    | `AuthController`     | public      | request body email/password/nickname                            | 201 when valid body           | allowed; token ignored        | ignored                 | signup success and no passwordHash e2e                                                  | invalid token ignored not explicitly asserted                              |
| `POST /api/v1/auth/login`                     | `AuthController`     | public      | request body email/password                                     | 200 when valid body           | allowed; token ignored        | ignored                 | login success and no passwordHash e2e                                                   | invalid token ignored not explicitly asserted                              |
| `POST /api/v1/auth/refresh`                   | `AuthController`     | public      | request body refreshToken                                       | 401 `INVALID_REFRESH_TOKEN`   | allowed; access token ignored | ignored                 | missing/malformed reject, valid rotation, old refresh token reuse failure               | real HTTP PostgreSQL path remains opt-in service smoke                     |
| `POST /api/v1/auth/logout`                    | `AuthController`     | public      | request body refreshToken                                       | 200 idempotent success        | allowed; access token ignored | ignored                 | idempotent success and refresh session revoke mock e2e                                  | real HTTP PostgreSQL path remains opt-in service smoke                     |
| `POST /api/v1/auth/logout-all`                | `AuthController`     | protected   | `request.user.userId` from bearer JWT                           | 401 `UNAUTHORIZED`            | 401 `UNAUTHORIZED`            | cannot authenticate     | missing + `x-user-id` only blocked, valid token success                                 | access-token blacklist not in scope                                        |
| `GET /api/v1/me`                              | `AuthController`     | protected   | `request.user.userId` from bearer JWT                           | 401 `UNAUTHORIZED`            | 401 `UNAUTHORIZED`            | cannot authenticate     | missing + `x-user-id` only, valid token smoke                                           | per-route invalid token e2e; guard unit covers invalid token               |
| `GET /api/v1/operator/me`                     | `OperatorController` | operator    | `request.user.userId` and DB current `request.user.role`        | 401 `UNAUTHORIZED`            | 401 `UNAUTHORIZED`            | cannot authenticate     | missing, invalid, `x-user-id`, user forbidden, operator/admin success, inactive blocked | real DB HTTP smoke not covered                                             |
| `GET /api/v1/seasons/current`                 | `SeasonsController`  | optional    | none if anonymous; `request.user.userId` if valid token         | 200 anonymous                 | 401 `UNAUTHORIZED`            | anonymous, not identity | anonymous, `x-user-id` anonymous, invalid/malformed token, valid token                  | unknown/inactive optional token path covered by guard unit, not this route |
| `POST /api/v1/seasons/:seasonId/join`         | `SeasonsController`  | protected   | `request.user.userId`                                           | 401 `UNAUTHORIZED`            | 401 `UNAUTHORIZED`            | cannot authenticate     | missing + `x-user-id` only + invalid/malformed blocked, valid-token service-entry smoke | real HTTP join backed by PostgreSQL not covered                            |
| `GET /api/v1/home`                            | `HomeController`     | protected   | `request.user.userId`                                           | 401 `UNAUTHORIZED`            | 401 `UNAUTHORIZED`            | cannot authenticate     | missing + `x-user-id` only, valid token smoke                                           | per-route invalid token e2e; deeper HTTP state matrix                      |
| `GET /api/v1/ranking`                         | `RankingController`  | protected   | `request.user.userId`                                           | 401 `UNAUTHORIZED`            | 401 `UNAUTHORIZED`            | cannot authenticate     | missing + `x-user-id` only, valid token smoke                                           | per-route invalid token e2e                                                |
| `GET /api/v1/wallets`                         | `WalletsController`  | protected   | `request.user.userId`                                           | 401 `UNAUTHORIZED`            | 401 `UNAUTHORIZED`            | cannot authenticate     | missing + `x-user-id` only, valid token smoke                                           | per-route invalid token e2e                                                |
| `GET /api/v1/records`                         | `RecordsController`  | protected   | `request.user.userId`                                           | 401 `UNAUTHORIZED`            | 401 `UNAUTHORIZED`            | cannot authenticate     | missing + `x-user-id` only, valid token smoke                                           | per-route invalid token e2e                                                |
| `GET /api/v1/records/me/seasons*`             | `RecordsController`  | protected   | `request.user.userId`                                           | 401 `UNAUTHORIZED`            | 401 `UNAUTHORIZED`            | cannot authenticate     | missing + `x-user-id` only, valid token smoke                                           | per-route invalid token e2e                                                |
| `GET /api/v1/users/:userId/records/:seasonId` | `RecordsController`  | protected   | `request.user.userId`; target user path param is summary target | 401 `UNAUTHORIZED`            | 401 `UNAUTHORIZED`            | cannot authenticate     | missing + `x-user-id` only, valid token smoke                                           | per-route invalid token e2e; public summary only                           |
| `GET /api/v1/orders`                          | `OrdersController`   | protected   | `request.user.userId`                                           | 401 `UNAUTHORIZED`            | 401 `UNAUTHORIZED`            | cannot authenticate     | missing + `x-user-id` only, valid token smoke                                           | per-route invalid token e2e                                                |
| `POST /api/v1/orders/quote`                   | `OrdersController`   | protected   | `request.user.userId`                                           | 401 `UNAUTHORIZED`            | 401 `UNAUTHORIZED`            | cannot authenticate     | missing + `x-user-id` only + invalid/malformed blocked, valid-token service-entry smoke | more HTTP quote business failures                                          |
| `POST /api/v1/orders`                         | `OrdersController`   | protected   | `request.user.userId`                                           | 401 `UNAUTHORIZED`            | 401 `UNAUTHORIZED`            | cannot authenticate     | missing + `x-user-id` only + invalid/malformed blocked, valid-token service-entry smoke | real DB create idempotency race not covered                                |
| `POST /api/v1/orders/:orderId/cancel`         | `OrdersController`   | protected   | `request.user.userId`                                           | 401 `UNAUTHORIZED`            | 401 `UNAUTHORIZED`            | cannot authenticate     | missing + `x-user-id` only + invalid/malformed blocked, valid-token service-entry smoke | real DB cancel visibility not separately covered                           |
| `POST /api/v1/orders/:orderId/execute`        | `OrdersController`   | protected   | `request.user.userId`                                           | 401 `UNAUTHORIZED`            | 401 `UNAUTHORIZED`            | cannot authenticate     | missing + `x-user-id` only + invalid/malformed blocked, valid-token service-entry smoke | exact execute response replay not implemented                              |
| `POST /api/v1/fx/quote`                       | `FxController`       | protected   | `request.user.userId`                                           | 401 `UNAUTHORIZED`            | 401 `UNAUTHORIZED`            | cannot authenticate     | missing + `x-user-id` only + invalid/malformed blocked, valid-token service-entry smoke | more HTTP quote business failures                                          |
| `POST /api/v1/fx/execute`                     | `FxController`       | protected   | `request.user.userId`                                           | 401 `UNAUTHORIZED`            | 401 `UNAUTHORIZED`            | cannot authenticate     | missing + `x-user-id` only + invalid/malformed blocked, valid-token service-entry smoke | stale pending recovery remains unresolved                                  |

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
- Not implemented: cron scheduler, automatic snapshot/ranking jobs, reward policy/catalog, external reward/payment fulfillment, exact order execute replay, partial fill, matching engine.

## Backend Gates

| Gate                                                     | Purpose                                                                                      | Prerequisites                                                                                                                                                                                    | Allowed file changes                                                                                    | Forbidden changes                                                                                  | Required tests                                                                | STOP conditions                                                                                                         | GO conditions                                                                            | Recommended Codex prompt title                                | Estimated risk | Dependency gates    |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------- | ------------------- |
| Gate A: Protected API HTTP e2e baseline                  | Keep public/optional/protected auth behavior stable across current APIs                      | Access-token MVP implemented                                                                                                                                                                     | `test/app.e2e-spec.ts`, docs only if extending coverage                                                 | source logic, schema, package, seed, migration                                                     | `pnpm run test:e2e`, `pnpm test -- auth`                                      | any `x-user-id` fallback, missing-token protected route reaches service, optional invalid token downgrades to anonymous | current baseline passes and protected APIs reject missing/`x-user-id` only               | `Gate A - Protected API HTTP e2e baseline audit`              | LOW            | none                |
| Gate B: Provider final selection readiness               | Re-check provider selection before ingestion                                                 | current provider STOP docs, current quote/execute source policy                                                                                                                                  | docs only; possibly a separate trial-result doc if approved                                             | provider code, scheduler, schema, package, env changes                                             | docs consistency check; no build required unless docs tooling exists          | no OANDA/Twelve Data live/trial evidence, no contract/cost/polling/timestamp decision, sourceType priority undecided    | final selection criteria and remaining STOP list accepted                                | `Gate B - Provider final selection readiness re-check`        | MEDIUM         | Gate A              |
| Gate C: FX provider_api source eligibility               | Decide whether provider USD/KRW snapshots can power financial paths                          | provider row insertion foundation, source/freshness policy                                                                                                                                       | FX read-path tests/docs only if approved                                                                | settlement, order execution changes, scheduler if not in scope, fake/static/manual fallback        | unit source eligibility tests, no-fake policy, build                          | execute/write/final scope or outage policy undecided                                                                    | read-only/quote provider snapshot consumption is explicit and safe by policy             | `Provider API Source Eligibility Gate`                        | HIGH           | Provider foundation |
| Gate D: Asset price provider_api source eligibility      | Decide whether real asset price snapshots can power supported workflows                      | asset universe decision, asset price freshness policy, provider/source decision                                                                                                                  | asset source eligibility tests/docs if approved                                                         | FX provider code unless shared abstraction approved, scheduler if not in scope, fake/sample prices | unit/provider mapping tests, no-fake policy, build                            | execute/write/final scope or outage policy undecided                                                                    | read-only/quote approved source mapping and freshness policy exist                       | `Provider API Source Eligibility Gate`                        | HIGH           | Provider foundation |
| Gate E: Scheduler/batch foundation                       | Define safe automatic job runner foundation                                                  | provider/freshness decisions enough to know job needs                                                                                                                                            | scheduler module/foundation/tests/docs if approved                                                      | provider polling or cron-driven business jobs unless included                                      | unit tests for locking/idempotency/retry; build                               | no lock/idempotency/retry/observability policy; deployment model unknown                                                | batch foundation can run one safe no-op or bounded job with tests; cron remains separate | `Gate E - Scheduler batch foundation preimplementation audit` | HIGH           | Gate B              |
| Gate F: Automatic daily portfolio snapshot generation    | Automate daily snapshot generation                                                           | Gate E, valuation inputs reliable, asset/FX freshness policy                                                                                                                                     | scheduler job + tests/docs                                                                              | ranking, settlement, rewards unless explicit                                                       | unit + integration/smoke for job idempotency and partial participant failures | provider data unavailable, freshness implementation absent, job retry undefined                                         | automatic snapshots are idempotent and observable                                        | `Gate F - Automatic daily portfolio snapshot generation`      | HIGH           | Gate E              |
| Gate G: Automatic season ranking generation              | Automate rankings from daily snapshots                                                       | Gate F                                                                                                                                                                                           | ranking job/tests/docs                                                                                  | settlement/reward unless explicit                                                                  | unit/integration for rank ordering, uniqueness, rerun idempotency             | daily snapshots absent or inconsistent, rank date policy unclear                                                        | repeatable ranking generation from snapshot source                                       | `Gate G - Automatic season ranking generation`                | MEDIUM         | Gate F              |
| Gate H: Settlement extension/final-result audit          | Decide extensions beyond existing snapshot-based settlement MVP                              | Season settlement MVP, final tier assignment MVP, reward-grant gate-closed behavior, internal fulfillment MVP, and Home final-result read model implemented; Gate F/G recommended for automation | docs only                                                                                               | provider/external reward fulfillment/schema code unless explicitly approved                        | no build required; maybe `prisma validate`                                    | final price/FX evidence, recovery, external fulfillment handoff, advanced tier policy, or tie-rank policy undecided     | extension scope and test matrix accepted                                                 | `Gate H - Settlement extension readiness audit`               | MEDIUM         | Gate F, Gate G      |
| Gate I: Settlement extension implementation              | Extend final KRW result, Home integration, recovery, or schema as approved                   | Gate H GO                                                                                                                                                                                        | settlement/home/tests/docs/schema only if approved                                                      | external reward fulfillment unless in Gate J, provider/scheduler unrelated changes                 | unit, integration, rollback/concurrency/idempotency, build                    | no final audit acceptance; schema needs unclear                                                                         | approved extension writes are durable, idempotent, and tested                            | `Gate I - Settlement extension implementation`                | HIGH           | Gate H              |
| Gate J: Reward Policy / Catalog and external fulfillment | Define reward kinds/catalog/amounts and any external delivery beyond internal DB fulfillment | Internal reward fulfillment MVP accepted; Gate I if final-result extension is required                                                                                                           | reward policy/catalog/payment/point/delivery/external fulfillment service/schema/tests/docs if approved | settlement recalculation unless explicit                                                           | unit/integration/idempotency                                                  | no reward amount/payment/point/delivery/external policy                                                                 | fulfillment policy is explicit, idempotent, and tied to settled evidence                 | `Reward Policy / Reward Catalog Gate`                         | HIGH           | Settlement MVP      |
| Gate K: Refresh token/logout/revocation MVP              | Add opaque refresh-token sessions, rotation, logout, logout-all                              | Auth MVP stable; frontend login persistence needed                                                                                                                                               | Auth schema/migration/service/controller/tests/docs                                                     | provider/scheduler/settlement/reward changes                                                       | auth unit/e2e, Prisma validate, build                                         | access-token blacklist/cookie-session/reuse theft-response remain out of scope                                          | refresh session lifecycle works without touching trading/provider domains                | `Gate K - Refresh token logout revocation MVP`                | MEDIUM         | Gate A              |
| Gate L: Deployment/ops readiness                         | Prepare production runtime and operations                                                    | provider/scheduler shape known                                                                                                                                                                   | docs/config/ops scripts if approved                                                                     | business logic expansions                                                                          | build, health checks, migration status, smoke checklist                       | secret/runbook/monitoring/migration/scheduler ownership missing                                                         | deployment checklist and rollback plan accepted                                          | `Gate L - Deployment ops readiness`                           | HIGH           | Gate E recommended  |

## Gate B Re-check Result (2026-05-12)

Gate B was completed as a docs-only readiness re-check in `docs/provider-final-selection-readiness-recheck.md` and `docs/asset-price-freshness-policy.md`.

| Area                                      | Decision                                                                                                                               | Roadmap effect                                                                                                                                                                                                                                     | Required before implementation                                                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Gate B Provider final selection readiness | CONDITIONAL GO                                                                                                                         | Provider roles and source/freshness policy are clear enough for evidence capture and narrow Gate C/D prompts                                                                                                                                       | No code yet; keep official docs and trial/API evidence together                                                                   |
| Gate C FX provider ingestion              | FOUNDATION IMPLEMENTED for ExchangeRate-API USD/KRW row insertion; read-only/quote source eligibility implemented                      | ExchangeRate-API can insert provider_api USD/KRW snapshots and fresh rows can power `/fx quote` plus allowed read-only USD/KRW conversion; OANDA/Twelve Data remain historical candidates for later review                                         | execute/write/final eligibility, broader outage policy, contract/cost/polling approval                                            |
| Gate D Asset price provider ingestion     | FOUNDATION IMPLEMENTED for Binance public crypto and KIS WebSocket stock row insertion; read-only/quote source eligibility implemented | Binance public REST ticker can insert USD-equivalent crypto snapshots for existing mapped assets; KIS WebSocket can insert KRX `H0STCNT0` and US `HDFSCNT0` trade-price snapshots for existing mapped assets and allowed read-only/quote workflows | execute/write/final eligibility, plan/terms approval, broader provider outage policy                                              |
| Gate E Scheduler/batch foundation         | FOUNDATION IMPLEMENTED for job envelope; cron scheduler remains STOP                                                                   | Batch run/idempotency recording exists, but no cron scheduler or business job is authorized                                                                                                                                                        | job-specific partial failure, provider outage handling, manual CLI coexistence, deployment scheduler ownership                    |
| Gate H Settlement extension audit         | MVP IMPLEMENTED for existing snapshot-based operator settlement; extensions remain gated                                               | Further settlement work should focus on true tie rank, provider-backed final evidence, recovery, advanced tier policy, and external fulfillment handoff decisions                                                                                  | final valuation extension source, rerun/idempotency, rollback, external fulfillment handoff, official/reference snapshot decision |

Still blocked:

- KRX and US stock provider_api execute/write until a separate eligibility, freshness, outage, and product/terms decision exists.
- Provider_api source eligibility outside explicitly allowed read-only/quote workflows and operator-run daily snapshot valuation until separate execute/write/final source priority, fallback, freshness, and terms decisions are accepted.
- Cron scheduler implementation until Gate E defines lock/idempotency/retry/ops behavior.
- Settlement extensions until Gate H/I fixes final price evidence, true tie rank, recovery behavior, advanced tier policy, or external fulfillment handoff.
- Actual reward/payment/badge/trophy fulfillment until reward policy/schema are approved.

Recommended next Codex prompt title:

- `Provider Execute/Write Eligibility Gate` or `Provider Daily Snapshot Eligibility Gate`

## Provider Live Smoke Evidence Gate Result (2026-05-28 KST)

Provider live smoke evidence is documented in `docs/provider-evidence-capture.md`.

| Area                           | Decision                                                    | Roadmap effect                                                                                                                                                                                                                                              | Required before source eligibility                      |
| ------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `.env.local` security precheck | PASS                                                        | `.env.local` is ignored/untracked; secret values were not printed or documented                                                                                                                                                                             | Continue to keep env files out of git                   |
| Smoke asset mappings           | GO                                                          | Local DB has active mappings for `KRX:005930`, `NAS:AAPL`, `BINANCE:BTCUSDT`, and `BINANCE:ETHUSDT`; no seed/schema change                                                                                                                                  | Final 41-asset app universe remains separate            |
| ExchangeRate-API live smoke    | GO for row insertion and read-only/quote source eligibility | Dry-run/non-dry-run succeeded and inserted one local `provider_api` USD/KRW row                                                                                                                                                                             | Execute/write/final source eligibility remains separate |
| Binance public REST live smoke | GO for row insertion and read-only/quote source eligibility | Dry-run/non-dry-run succeeded for `BTCUSDT`/`ETHUSDT` and inserted two local `provider_api` USD crypto price rows                                                                                                                                           | Execute/write/final source eligibility remains separate |
| KIS approval_key               | GO                                                          | Approval request success is evidenced by successful WebSocket connect and subscribe acknowledgements; value was not printed                                                                                                                                 | Keep secret redaction and do not persist approval keys  |
| KIS WebSocket connect          | GO                                                          | Dry-run and non-dry-run connected successfully                                                                                                                                                                                                              | Add reconnect/outage policy only in a later gate        |
| KIS domestic `H0STCNT0` tick   | GO for row insertion and read-only/quote source eligibility | Domestic ticks parsed and 12 `kis_krx_realtime_trade` provider_api rows were inserted                                                                                                                                                                       | Execute/write/final source eligibility remains separate |
| KIS US `HDFSCNT0` tick         | GO for row insertion and read-only/quote source eligibility | DB-started market-window rerun sent 25 US subscriptions, acknowledged 25, produced dry-run `wouldCreate=35`, and created 25 `kis_us_delayed_trade` provider_api USD rows.                                                                                   | Execute/write/final source eligibility remains separate |
| Read path isolation            | UPDATED                                                     | `/fx quote`, orders quote, assets withPrice, portfolio/home/positions live valuation, and operator-run daily snapshot valuation can use provider-first rows. Execute/write, ranking, settlement, and reward remain isolated from provider_api direct reads. | Keep write/final isolation tests green                  |

Decision:

- Overall result is GO for provider row insertion evidence used by the read-only/quote implementation gate.
- Provider_api source eligibility is open only for `/fx quote`, assets withPrice, orders quote, live portfolio valuation, home live valuation, and positions live valuation.
- Provider_api source eligibility remains BLOCKED for `/fx execute`, orders create, orders execute, ranking, settlement, and reward paths.
- No KIS order/account/balance/fill/deposit/withdrawal API, Binance authenticated API, schema/migration/package/seed change, or fake/static/sample business price was introduced.

Next recommended Codex prompt title:

- `Provider Execute/Write Eligibility Gate` or `Provider Daily Snapshot Eligibility Gate`

## Gate C/D Live Fixture Capture Result (2026-05-13)

Gate C/D evidence capture is documented in `docs/provider-evidence-capture.md`.

| Area                                  | Decision                                                                                 | Roadmap effect                                                                                                                                                                                    | Required before implementation                                                                                                                             |
| ------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OANDA USD/KRW live fixture            | BLOCKED                                                                                  | OANDA remains conditional FX candidate, but live evidence was not captured because credentials were unavailable                                                                                   | Provide OANDA credentials, capture USD/KRW response, verify endpoint/fields/timestamp/content type/rate basis and terms                                    |
| Twelve Data USD/KRW live fixture      | BLOCKED                                                                                  | Twelve Data remains conditional secondary FX candidate, but live evidence was not captured because `TWELVE_DATA_API_KEY` was unavailable                                                          | Provide `TWELVE_DATA_API_KEY`, capture `/exchange_rate?symbol=USD/KRW`, verify `rate`, `timestamp`, freshness, errors, terms                               |
| Twelve Data US stock live fixture     | BLOCKED                                                                                  | Twelve Data remains conditional US stock candidate, but live evidence was not captured because `TWELVE_DATA_API_KEY` was unavailable                                                              | Capture `/quote?symbol=AAPL`, verify currency, `close`, `timestamp`/`last_quote_at`, `is_market_open`, delayed/real-time status, plan/terms                |
| Binance crypto fixture                | GO for fixture capture, row insertion foundation, and read-only/quote source eligibility | Crypto provider target changed to Binance USD-settled crypto; public REST ticker foundation now stores USD-equivalent provider_api rows for existing mapped assets                                | Execute/write/final source eligibility remains separate                                                                                                    |
| Gate C FX provider ingestion          | BLOCKED for implementation                                                               | No provider client/ingestion work should start yet                                                                                                                                                | Live fixture, sourceType eligibility, timestamp mapping, rate basis, and owner terms decisions                                                             |
| Gate D Asset price provider ingestion | BLOCKED for implementation                                                               | No asset provider ingestion work should start yet                                                                                                                                                 | Live US fixtures, Binance crypto fixtures, symbol/currency mapping, market-open policy, delayed/EOD rejection, USDT-to-USD decision, owner terms decisions |
| Gate E Scheduler/batch foundation     | FOUNDATION IMPLEMENTED for job envelope; cron/business jobs STOP                         | Generic batch run envelope exists, but provider polling jobs and cron scheduler cannot be implemented                                                                                             | Job-specific partial failure policy, accepted provider evidence, deployment scheduler ownership                                                            |
| Gate H Settlement extension audit     | MVP IMPLEMENTED for existing snapshot-based operator settlement; extensions STOP         | Settlement extensions can audit final evidence needs, tie rank, advanced tier policy, external fulfillment handoff, and recovery, not add provider/external fulfillment behavior without approval | Final valuation source, official/reference snapshot policy, recovery/idempotency, final tier/reward fulfillment policy                                     |

Blocked reasons:

- Local environment has no OANDA or Twelve Data credentials.
- No live provider response fixtures exist.
- Official-document error/rate-limit evidence was added in `docs/provider-fixtures/provider-error-samples.md`; no live error or quota calls were made.
- OANDA exact endpoint, response fields, timestamp field, and bid/ask/mid mapping are still unverified.
- Twelve Data live timestamp freshness is unmeasured for USD/KRW and US stock.
- Binance crypto read-only/quote freshness is implemented as capturedAt age <= 60 seconds. USDT-to-USD-equivalent storage policy is accepted for MVP; depeg risk is not modeled.
- Production terms/account approval is still missing.
- Domestic KRX provider_api row insertion evidence exists; read-only/quote eligibility is implemented, while KRX execute/write remains blocked.

Gate transition effect:

- Historical Gate C/D implementation block is superseded by the 2026-05-26 provider ingestion foundation.
- Provider_api source eligibility remains `BLOCKED` outside the read-only/quote plus operator-run daily snapshot valuation allowlist until separate source priority, freshness, fallback, outage, and terms decisions are accepted.
- Crypto provider_api source eligibility is implemented only for BINANCE USD read-only/quote workflows; execute/write/final use remains blocked.
- Gate E batch foundation exists for operator-run jobs only; provider polling jobs and cron scheduler remain `STOP`.
- Settlement extensions may proceed only as separate gated work; the current MVP stays existing-snapshot based.

Historical/future-review prompt title:

- `OANDA/Twelve Data Fallback Provider Recheck`

## Gate C Provider Fixture Capture Prep Result (2026-05-14)

Gate C fixture prep is documented in `docs/provider-evidence-capture.md`.

| Area                              | Decision                                                                            | Roadmap effect                                                                                                                                                                            | Required before implementation                                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Crypto freshness docs consistency | FIXED                                                                               | `docs/asset-price-freshness-policy.md` now states Binance, not Twelve Data, as the crypto MVP provider target                                                                             | Keep Twelve Data scoped to FX fallback and US stock candidate only                                                     |
| Binance BTCUSDT ticker fixture    | GO for fixture capture; CONDITIONAL GO for mapping                                  | Public `/api/v3/ticker/24hr?symbol=BTCUSDT` returned HTTP 200 and was saved to `docs/provider-fixtures/binance-btcusdt-ticker-sample.json`                                                | Decide price field, accept or reject `closeTime` as `effectiveAt`, approve USDT-to-USD policy, sourceType tests, terms |
| Binance BTCUSDT orderbook fixture | CONDITIONAL GO                                                                      | Public `/api/v3/depth?symbol=BTCUSDT&limit=5` returned HTTP 200 and was saved to `docs/provider-fixtures/binance-btcusdt-orderbook-sample.json`                                           | Pair with accepted timestamp source or choose a timestamped endpoint; decide bid/ask/mid policy                        |
| OANDA USD/KRW fixture             | BLOCKED                                                                             | Credentials remain unavailable; no live OANDA call was made                                                                                                                               | Provide credentials and capture USD/KRW response with endpoint/fields/timestamp/rate basis                             |
| Twelve Data USD/KRW fixture       | BLOCKED                                                                             | `TWELVE_DATA_API_KEY` remains unavailable; no live call was made                                                                                                                          | Provide key and capture `/exchange_rate?symbol=USD/KRW`                                                                |
| Twelve Data AAPL quote fixture    | BLOCKED                                                                             | `TWELVE_DATA_API_KEY` remains unavailable; no live call was made                                                                                                                          | Provide key and capture `/quote?symbol=AAPL`                                                                           |
| Gate D mapping blockers           | GO for read-only/quote source eligibility; STOP for execute/write/final eligibility | Binance fixture response shape exists and row insertion foundation exists; read-only/quote provider selection is implemented, but financial write/final path policy decisions are missing | execute/write/final source policy, outage behavior, terms approval                                                     |
| Gate E scheduler audit            | FOUNDATION IMPLEMENTED for batch envelope                                           | Scheduler design can still be audited; provider polling jobs and cron scheduler remain STOP                                                                                               | Accepted provider/source policy, job-specific failure policy, and ops design                                           |
| Gate F/G/H/I extension work       | STOP for provider-backed automation/settlement extensions                           | Provider/source policy and scheduler/final-evidence decisions are not accepted                                                                                                            | Complete provider mapping and later scheduler/settlement extension gates                                               |

Blocked reasons:

- Binance `BTCUSDT` uses provider quote currency `USDT`; internal `CurrencyCode` remains `USD`, and current foundation stores it as USD-equivalent without modeling depeg risk.
- Binance ticker has timestamp candidates, but `closeTime` semantics must be accepted before `effectiveAt` mapping.
- Binance orderbook provides bid/ask levels but no source timestamp.
- OANDA/Twelve Data credentials are not present, so credentialed fixtures remain blocked.
- Production terms/account/raw-payload storage approval is still missing.
- Domestic KRX provider_api row insertion evidence exists; read-only/quote eligibility is implemented, while KRX execute/write remains blocked.

Next recommended Codex prompt title:

- `Provider Execute/Write Eligibility Gate` or `Provider Daily Snapshot Eligibility Gate`

## Next 5 Implementation Candidate Priority

| Candidate                                             | MVP impact | Financial stability impact | Implementation risk | External dependency | Test difficulty | Current prerequisites met?                               | Start now?                                                                                                   | Recommendation                                         | Reason                                                                                                                                                                                                                                                                      | Required prior decisions                                                                                    | Suggested next prompt scope                                                                     |
| ----------------------------------------------------- | ---------- | -------------------------- | ------------------- | ------------------- | --------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1. Provider ingestion foundation                      | HIGH       | HIGH                       | MEDIUM              | HIGH                | MEDIUM          | Enough for ExchangeRate/Binance/KIS WebSocket foundation | Completed for foundation, read-only/quote eligibility, and operator-run daily snapshot valuation eligibility | DONE FOR FOUNDATION + READ-ONLY/QUOTE + DAILY SNAPSHOT | Provider rows can be inserted for ExchangeRate-API USD/KRW, Binance public crypto, and KIS WebSocket domestic/US stock trade prices; read-only/quote and operator-run daily snapshot valuation workflows can consume fresh eligible rows without opening write/final paths. | Execute/write/final eligibility, cost/contract owner, polling/timestamp/freshness checklist                 | Provider Execute/Write Eligibility Gate or Scheduler/Ops Foundation Gate                        |
| 2. Asset price freshness policy finalization          | HIGH       | HIGH                       | MEDIUM              | MEDIUM              | MEDIUM          | Partially                                                | Completed as docs-only policy                                                                                | DONE, CONDITIONAL GO                                   | SourceType roles, timestamp semantics, market freshness, and stale behavior are now documented for future Gate D/F/H work.                                                                                                                                                  | supported asset universe, live fixtures, market-hours acceptance, settlement evidence                       | Use policy in provider evidence capture and later implementation gates                          |
| 3. Season settlement MVP                              | HIGH       | VERY HIGH                  | MEDIUM              | LOW                 | MEDIUM          | Enough for existing snapshots                            | Completed for MVP                                                                                            | DONE FOR MVP                                           | Operator-run settlement can now finalize from existing daily snapshots without provider keys or cron; final tier assignment can consume final rankings, reward-grant stays gate-closed, and internal reward fulfillment MVP can consume explicit fulfillment requests.      | True tie rank, advanced tier policy, reward policy/catalog, and external reward fulfillment remain separate | Keep settlement/final-tier/reward foundation bounded; open separate extension/fulfillment gates |
| 4. Scheduler/batch foundation preimplementation audit | HIGH       | HIGH                       | MEDIUM              | MEDIUM              | HIGH            | Mostly for envelope                                      | Completed for envelope                                                                                       | DONE FOR ENVELOPE                                      | BatchJobRun and BatchService now provide idempotent run recording; cron and business jobs still depend on provider/freshness and ops model.                                                                                                                                 | job-specific partial failure, provider outage, cron/deployment ownership                                    | Add concrete snapshot/ranking job only under its own gate                                       |
| 5. Refresh token/logout/revocation MVP                | MEDIUM     | MEDIUM                     | MEDIUM              | LOW                 | MEDIUM          | Auth MVP complete                                        | Yes                                                                                                          | DONE                                                   | Opaque refresh sessions, rotation, logout, and logout-all are implemented without provider/trading changes.                                                                                                                                                                 | access-token blacklist/cookie-session/reuse theft-response are separate future gates                        | Keep Auth-only boundaries and tests green                                                       |

Recommended next task:

- Provider Execute/Write Eligibility Gate or Scheduler/Ops Foundation Gate.

## STOP / GO Summary

GO or completed:

- Gate A protected API HTTP e2e baseline is complete enough for current access-token MVP.
- Existing read-only APIs may continue using service/unit plus guard e2e coverage.
- Manual admin CLIs may remain bootstrap/manual paths.

STOP:

- Provider_api source eligibility outside explicitly allowed read-only/quote workflows and operator-run daily snapshot valuation until live evidence, freshness, fallback, source priority, and implementation scope are accepted.
- Domestic KRX provider_api read-only/quote eligibility is implemented; KRX execute/write remains blocked until a separate gate accepts source eligibility, freshness, workflow scope, and implementation tests.
- Cron scheduler implementation until Gate E.
- Settlement extensions until Gate H then Gate I.
- Actual reward/payment/badge/trophy fulfillment until Gate J after reward policy/schema approval.
- Access-token blacklist, cookie/session auth, and refresh-token reuse theft-response hardening until a separate Auth hardening gate.
- Durable quote, order exact execute replay, partial fill, matching engine, and fake/static/sample business data remain out of scope.
