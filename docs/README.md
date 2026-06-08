# Docs Guide

Use this directory in this order:

1. `docs/current-status.md` - current implementation source of truth.
2. `docs/backend-gate-roadmap.md` - gate decision and next-work source of truth.
3. `docs/backend-test-coverage-matrix.md` - test coverage source of truth.
4. API contracts:
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
   - `docs/operator-api-contract.md`
5. Provider/freshness/crypto policy:
   - `docs/provider-ingestion-foundation.md`
   - `docs/crypto-usd-settlement-policy-update.md`
   - `docs/provider-final-selection-readiness-recheck.md`
   - `docs/asset-price-freshness-policy.md`
   - `docs/realtime-execution-policy.md`
   - `docs/scheduler-ops-foundation.md`
   - `docs/provider-evidence-capture.md`
   - `docs/asset-universe-2026-ytd-volume-selection.md`
   - `docs/provider-source-eligibility-pre-gate.md`

Provider evidence currently has ExchangeRate-API and Binance row insertion evidence, KIS domestic `H0STCNT0` row insertion evidence, and KIS US `HDFSCNT0` tick/DB insertion evidence. Provider_api source eligibility is open only for explicitly allowed workflows: `/fx quote`, `/fx execute`, assets `withPrice`, orders quote, orders execute, live portfolio/home/positions valuation, and operator-run daily portfolio snapshot valuation. Orders create binds a durable quote and does not read provider rows directly.

Read-only/quote source metadata is exposed as backward-compatible optional fields such as `rateSource`, `priceSource`, `assetPriceSource`, `fxRateSource`, and live valuation `sourceSummary`. Daily snapshot batch results include public-safe aggregate `sourceSummary`/fallback information in `batch_job_runs.resultPayloadJson`. These fields contain public-safe source type/name/snapshot/timing/fallback reasons only; raw provider payloads and secrets remain excluded.

Provider_api remains closed for orders create source selection, ranking, settlement/final result, reward/final tier/fulfillment, provider ingestion trigger APIs, batch HTTP APIs, and real trading/account/order/deposit/withdrawal APIs. Scheduler/Ops foundation exists but is disabled by default and does not open those workflows.

`docs/realtime-execution-policy.md` records the active Durable Quote provider execute policy: quote is only a reference quote, `/fx execute` and orders execute reprice from fresh provider_api at execute time, enforce quote-to-execute bps thresholds, consume quotes atomically with writes, and forbid default `admin_manual` execute fallback.

6. Admin/operator authorization and audit foundation:

- `docs/operator-api-contract.md`

7. Batch foundation and operator-run daily snapshot/ranking/cycle/settlement/final-tier/reward-grant internal foundation jobs:
   - `docs/batch-job-foundation.md`

8. Scheduler/Ops disabled-by-default foundation:
   - `docs/scheduler-ops-foundation.md`

`docs/archive/` contains historical STOP/review/preimplementation/plan documents. Archived files are not current source of truth and must not be used to override the current documents above.

`docs/docs-inventory.md` records the classification and archive action for each docs file.
