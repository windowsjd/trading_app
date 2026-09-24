# Docs Guide

This directory holds policy decisions, contracts, and operational guides that cannot be re-derived from the code. It does not hold implementation-status logs: `current-status.md`, `backend-gate-roadmap.md`, `backend-test-coverage-matrix.md`, `docs-inventory.md`, `v2-backend-contract-alignment-report.md`, `provider-source-eligibility-pre-gate.md`, `provider-evidence-capture.md`, and `docs/archive/` were removed because they were narrative snapshots of implementation progress. To check current implementation status, read the relevant controller/service source directly alongside the matching `docs/*-api-contract.md`.

First compare current implementation, tests and migrations with explicit current product policy. Investigate conflicts; neither code nor an old document silently overrides an intentional policy. Then use this directory in this order:

1. API contracts — the request/response contract for each surface:
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
   - `docs/trading-accounts-api-contract.md`
   - `docs/trading-account-finance-api-contract.md`
   - `docs/trading-account-orders-api-contract.md`
   - `docs/general-account-and-ad-rewards-api-contract.md`
   - `docs/operator-api-contract.md`
2. `docs/policy-decisions.md` — freshness thresholds, execute repricing/maxChangeBps, source-type priority, crypto USD settlement, and final provider selection, each with a one-line rationale. This is the policy source of truth; it replaces `realtime-execution-policy.md`, `asset-price-freshness-policy.md`, `crypto-usd-settlement-policy-update.md`, and `provider-final-selection-readiness-recheck.md`.
3. `docs/trading-modes-and-accounts.md` — season/general investment-mode and
   TradingAccount scope rules, general account funding/TWR, shared
   market/limit orders and positions, account-scoped frontend behavior,
   integrity/repair boundaries, and the remaining exclusions (general
   ranking/rewards and a real ad-provider adapter). Required account scope and
   removal of legacy financial participant scope are complete in the
   `20260910120000` / `20260911120000` migrations; older transition sections are historical. General KRW↔USD FX is implemented through the shared
   account-scoped FX core.
4. `docs/provider-ingestion-foundation.md` — how provider ingestion is configured and operated (env vars, operator commands, per-provider request/response mapping). The fixed 40-symbol KIS watchlist now lives in code at `src/providers/kis/kis-fixed-asset-universe.ts` (seed with `pnpm tsx scripts/seed-kis-fixed-asset-universe.ts`), not in a doc.
5. `docs/scheduler-ops-foundation.md` — scheduler/ops contracts: flags default off; enabled scheduled jobs execute with `dryRun=false`. PostgreSQL lease renewal/loss and safe work boundaries are described there.
6. `docs/batch-job-foundation.md` — batch job foundation for daily snapshot/ranking/cycle/settlement/final-tier/reward-grant jobs.
7. `docs/ranking-backfill-runbook.md` — migration/backfill runbook for ranking tie-breakers.
8. `docs/operator-api-contract.md` — admin/operator authorization, account management, and audit foundation.
9. `docs/codex-rulepack.md` — coding rulepack for Codex/agent work in this repo.
10. `docs/provider-fixtures/` — test fixtures referenced by provider tests.

Historical HANDOVER/investigation records and explicitly historical migration sections preserve past evidence, not current authority. For orders/FX use the account-scoped contracts above, for lock ordering and fee pinning use `orders-api-contract.md` / current `policy-decisions.md`, and for ownership use the current section of `trading-modes-and-accounts.md`.

Read-only/quote source metadata is exposed as backward-compatible optional fields such as `rateSource`, `priceSource`, `assetPriceSource`, `fxRateSource`, and live valuation `sourceSummary`. Daily snapshot batch results include public-safe aggregate `sourceSummary`/fallback information in `batch_job_runs.resultPayloadJson`. These fields contain public-safe source type/name/snapshot/timing/fallback reasons only; raw provider payloads and secrets remain excluded.
