# Docs Guide

This directory holds policy decisions, contracts, and operational guides that cannot be re-derived from the code. It does not hold implementation-status logs: `current-status.md`, `backend-gate-roadmap.md`, `backend-test-coverage-matrix.md`, `docs-inventory.md`, `v2-backend-contract-alignment-report.md`, `provider-source-eligibility-pre-gate.md`, `provider-evidence-capture.md`, and `docs/archive/` were removed because they were narrative snapshots of implementation progress. To check current implementation status, read the relevant controller/service source directly alongside the matching `docs/*-api-contract.md`.

Use this directory in this order:

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
   - `docs/operator-api-contract.md`
2. `docs/policy-decisions.md` — freshness thresholds, execute repricing/maxChangeBps, source-type priority, crypto USD settlement, and final provider selection, each with a one-line rationale. This is the policy source of truth; it replaces `realtime-execution-policy.md`, `asset-price-freshness-policy.md`, `crypto-usd-settlement-policy-update.md`, and `provider-final-selection-readiness-recheck.md`.
3. `docs/trading-modes-and-accounts.md` — season/general investment mode rules, the general-mode one-time 10M KRW grant + rewarded-ad funding policy, the TradingAccount foundation contract (partial unique index, backfill mapping, join transaction), the deploy-boundary repair layer (deterministic account id, `pnpm trading-accounts:repair-links` incl. excluded-active status correction, `pnpm trading-accounts:repair-financial-scope`, CLI exit-code contract), the exclusion→account-suspended sync, the trading-accounts read API + ownership layer, the financial tables' transitional accountId scope + dual-write + deployment order, the Order/Position/Quote accountId transition (wallet-scope fail-closed rules, FX legacy partial unique, `pnpm trading-accounts:repair-trading-scope`, account-scoped order/position APIs, limit auto-fill account gating), and what is NOT implemented yet (general-mode APIs, snapshot/ranking accountId migration, ad rewards, time-weighted returns).
4. `docs/provider-ingestion-foundation.md` — how provider ingestion is configured and operated (env vars, operator commands, per-provider request/response mapping). The fixed 40-symbol KIS watchlist now lives in code at `src/providers/kis/kis-fixed-asset-universe.ts` (seed with `pnpm tsx scripts/seed-kis-fixed-asset-universe.ts`), not in a doc.
5. `docs/scheduler-ops-foundation.md` — scheduler/ops foundation (disabled-by-default, dry-run-by-default).
6. `docs/batch-job-foundation.md` — batch job foundation for daily snapshot/ranking/cycle/settlement/final-tier/reward-grant jobs.
7. `docs/ranking-backfill-runbook.md` — migration/backfill runbook for ranking tie-breakers.
8. `docs/operator-api-contract.md` — admin/operator authorization, account management, and audit foundation.
9. `docs/codex-rulepack.md` — coding rulepack for Codex/agent work in this repo.
10. `docs/provider-fixtures/` — test fixtures referenced by provider tests.

Read-only/quote source metadata is exposed as backward-compatible optional fields such as `rateSource`, `priceSource`, `assetPriceSource`, `fxRateSource`, and live valuation `sourceSummary`. Daily snapshot batch results include public-safe aggregate `sourceSummary`/fallback information in `batch_job_runs.resultPayloadJson`. These fields contain public-safe source type/name/snapshot/timing/fallback reasons only; raw provider payloads and secrets remain excluded.
