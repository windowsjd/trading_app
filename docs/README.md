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
   - `docs/provider-evidence-capture.md`
   - `docs/asset-universe-2026-ytd-volume-selection.md`
   - `docs/provider-source-eligibility-pre-gate.md`

Provider evidence currently has ExchangeRate-API and Binance row insertion evidence, KIS domestic `H0STCNT0` row insertion evidence, and KIS US `HDFSCNT0` tick/DB insertion evidence. Provider_api source eligibility is open only for the read-only/quote gate: `/fx quote`, assets `withPrice`, orders quote, and live portfolio/home/positions valuation.

Read-only/quote source metadata is exposed as backward-compatible optional fields such as `rateSource`, `priceSource`, `assetPriceSource`, `fxRateSource`, and live valuation `sourceSummary`. These fields contain public-safe source type/name/snapshot/timing/fallback reasons only; raw provider payloads and secrets remain excluded.

Provider_api remains closed for `/fx execute`, orders create/execute, daily portfolio snapshot, ranking, settlement/final result, reward/final tier/fulfillment, scheduler/cron, provider ingestion trigger APIs, and real trading/account/order/deposit/withdrawal APIs.

6. Admin/operator authorization and audit foundation:

- `docs/operator-api-contract.md`

7. Batch foundation and operator-run daily snapshot/ranking/cycle/settlement/final-tier/reward-grant internal foundation jobs:
   - `docs/batch-job-foundation.md`

`docs/archive/` contains historical STOP/review/preimplementation/plan documents. Archived files are not current source of truth and must not be used to override the current documents above.

`docs/docs-inventory.md` records the classification and archive action for each docs file.
