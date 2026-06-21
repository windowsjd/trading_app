# Asset Price Freshness Policy

## 1. Purpose

This document fixes the near-term freshness and source policy for FX and asset price snapshots before provider ingestion, scheduler/batch, ranking automation, settlement, or reward implementation.

This policy records freshness and source boundaries after provider ingestion foundation, the read-only/quote provider eligibility gate, the operator-run daily snapshot eligibility gate, the 2026-06-08 Durable Quote provider execute gate, and the season settlement valuation follow-up. It does not authorize package, seed, reward, order replay, partial fill, matching-engine changes, real external trading APIs, or provider_api source eligibility changes outside the explicitly approved workflows.

2026-05-26 update:

- Provider ingestion foundation can insert `provider_api` rows for ExchangeRate-API USD/KRW and Binance public crypto prices.
- KIS WebSocket trade price ingestion foundation can insert `provider_api` asset price rows for domestic KRX `H0STCNT0` and US delayed/free `HDFSCNT0` trades when existing active asset mapping is unambiguous.
- Provider API Source Eligibility Implementation Gate later opened provider_api only for `/fx quote`, assets `withPrice`, orders quote, and live portfolio/home/positions valuation.
- Provider-backed Daily Snapshot Eligibility Gate later opened provider_api only for operator-run daily snapshot valuation, using the same provider sourceName allowlist and freshness thresholds.
- `docs/realtime-execution-policy.md` now defines and the services implement the stricter execute/write freshness and quote-to-execute movement policy for `/fx execute` and orders execute: KRX/US/BINANCE asset execute freshness <= 10 seconds by `capturedAt`, USD/KRW FX execute freshness <= 60 seconds by `capturedAt`, no default admin_manual execute fallback, and quote is only a reference quote.
- Orders create uses a durable quote and immediate market execution. Provider ingestion trigger APIs, KIS REST current-price ingestion, and KIS REST hoga/orderbook snapshot ingestion were opened later as explicit operator/admin market-data paths. Ranking, reward/final tier/fulfillment, hoga-based execution, and order/account/balance/real-trading APIs remain closed unless separately opened.

## 2. Current Price Storage Model

Current schema stores market evidence in two snapshot tables:

- `fx_rate_snapshots`
  - pair fields: `baseCurrencyCode`, `quoteCurrencyCode`
  - price field: `rate`
  - source fields: `sourceType`, `sourceName`, `sourceTimestamp`, `rawPayloadJson`
  - timing fields: `effectiveAt`, `capturedAt`, `createdAt`
  - approval fields for manual input: `approvedByUserId`
- `asset_price_snapshots`
  - asset link: `assetId`
  - price fields: `price`, `currencyCode`
  - source fields: `sourceType`, `sourceName`, `sourceTimestamp`, `rawPayloadJson`
  - timing fields: `effectiveAt`, `capturedAt`, `createdAt`

Current code behavior:

- `/fx quote` reads fresh eligible `provider_api` USD/KRW first by source priority (`korea_exim_exchange_rate`, then `exchange_rate_api`) using capturedAt age <= 300 seconds, then existing safe `admin_manual` fallback with the established 60-second effectiveAt freshness rule.
- `/fx execute` requires a matching active durable FX quote and a fresh eligible `provider_api` USD/KRW row by source priority (`korea_exim_exchange_rate`, then `exchange_rate_api`) with capturedAt age <= 60 seconds. Default `admin_manual` fallback is forbidden.
- Orders quote can use fresh eligible `provider_api` asset price and USD/KRW rows first, then `admin_manual` fallback. Orders create binds an active durable quote but does not read provider rows directly. Orders execute requires fresh eligible provider asset rows with capturedAt age <= 10 seconds and fresh provider USD/KRW rows for USD assets with capturedAt age <= 60 seconds; default `admin_manual` fallback is forbidden.
- Assets `withPrice`, live portfolio/home/positions valuation, and operator-run daily snapshot valuation can use fresh eligible `provider_api` asset price and USD/KRW rows first, then `admin_manual` fallback.
- Season settlement valuation uses `Season.endAt` as the valuation time and selects the latest valid asset price and USD/KRW rows with `effectiveAt <= Season.endAt`; it does not enforce quote/execute capturedAt freshness windows.
- Daily snapshot valuation stores source evidence in the batch job result `sourceSummary`; `daily_portfolio_snapshots` row schema is unchanged.
- Ranking APIs read existing `season_rankings`; they do not fetch or calculate prices.
- Daily snapshot and ranking generation exist only as manual CLI foundations.

## 3. Existing Source Types

Current source types are:

- `admin_manual`
- `provider_api`
- `official_batch`

Policy meanings:

- `admin_manual`: bootstrap, manual correction, emergency fallback, and provider outage fallback through explicit operator action. It is not recommended as the long-running production real-time primary source.
- `provider_api`: implemented source for approved read-only/quote, live valuation, and operator-run daily snapshot valuation workflows. Future execute/write use requires the separate realtime execution policy gate and must not silently fall back to admin_manual.
- `official_batch`: future official/reference/reconciliation source for daily snapshots, ranking input, and settlement candidate evidence. It is not a real-time order execute source.

## 4. Timestamp Semantics

- `effectiveAt`
  - The market-data validity time.
  - For `provider_api`, this must map to the provider's quote, candle, tick, or exchange-rate timestamp.
  - If a provider endpoint does not provide a usable source timestamp, `provider_api` ingestion is not GO for quote, execute, or live valuation.
  - For `official_batch`, date-only or close-time evidence may be valid for daily/reference workflows, but not for real-time quote or execute.
- `capturedAt`
  - The time our server received and accepted a provider response, or the time admin input was saved.
  - It is useful for lag monitoring, tie-breaking, and operator audit.
  - It must not replace `effectiveAt` as the primary market freshness signal.
- `createdAt`
  - The DB row creation time.
  - It is only a tie-breaker and audit field.
  - It must not be used as the main market freshness basis.

## 5. FX USD/KRW Freshness Policy

Current confirmed policy:

- `/fx quote`: provider USD/KRW snapshot must be positive, not future-dated, sourceName `korea_exim_exchange_rate` or `exchange_rate_api` in that priority order, and at most 300 seconds old by `capturedAt`; admin_manual fallback must be at most 60 seconds old by `effectiveAt`.
- `/fx execute`: provider USD/KRW snapshot must be at most 60 seconds old by `capturedAt` at execute time.
- Exactly 60 seconds is accepted; older than 60 seconds is stale.
- Current quote source is fresh provider_api first, then explicit admin_manual fallback.
- Current execute source is fresh eligible `provider_api` only; default `admin_manual` fallback is forbidden.

Future provider policy:

- OANDA is the conditional primary FX provider candidate.
- Twelve Data is the conditional secondary FX provider candidate.
- `provider_api` USD/KRW requires provider timestamp -> `effectiveAt`, server receipt -> `capturedAt`, fixed rate basis, sourceType/sourceName correctness, stale response rejection, and no fake/static fallback.
- `/fx quote` uses fresh eligible provider_api first with admin_manual fallback after the read-only/quote eligibility gate. `/fx execute` now implements provider-required execute-time repricing and `RATE_CHANGED_REQUOTE_REQUIRED`.

## 6. Domestic Stock Freshness Policy

Current implementation:

- Domestic stock asset prices use `admin_manual` snapshots when present.
- There is no implemented asset-price stale threshold.
- KIS WebSocket `H0STCNT0` can insert `provider_api` KRX trade-price rows for existing active KRW domestic stock assets. Fresh matching rows are eligible for approved read-only/quote workflows, orders execute, and operator-run daily snapshot valuation; season settlement valuation can use the latest valid stored row at or before `Season.endAt`. Ranking and reward paths remain closed.

Policy decision:

- KRX market-open quote and orders execute are open only through explicit provider eligibility and durable quote gates. Other write/final uses remain BLOCKED until separately approved.
- Twelve Data is not accepted as KRX quote/execute provider in the current re-check because checked official coverage identifies Korea Stock Exchange and KOSDAQ as EOD delay, not real-time quote/execute-grade coverage.
- Delayed/EOD domestic data may be considered for daily/reference valuation only if product and settlement policy accept that behavior in a later gate.
- `official_batch` may be a domestic close/reference candidate after a batch/source gate, not a market-open execute source.

## 7. US Stock Freshness Policy

Current implementation:

- US stock prices use `admin_manual` snapshots when present.
- There is no implemented asset-price stale threshold.
- USD assets require fresh approved USD/KRW for KRW valuation/audit consistency.
- KIS WebSocket `HDFSCNT0` can insert `provider_api` US trade-price rows for existing active USD US stock assets with NAS/NYS/AMS market mapping. KIS documents US free quotes as 0-minute delayed; Hong Kong, Vietnam, China, and Japan 15-minute delayed markets are skipped in this MVP foundation.
- KIS US provider_api rows are eligible only for the approved read-only/quote workflows after the 2026-06-03 source eligibility gate, operator-run daily snapshot valuation after the 2026-06-05 gate, orders execute after the 2026-06-08 Durable Quote provider execute gate, and season settlement valuation after the settlement follow-up. Ranking and reward paths remain closed.

Target policy after provider ingestion:

- During regular market hours, quote/read workflows use the current approved freshness rules. Orders execute uses the stricter 10-second provider capturedAt threshold from `docs/realtime-execution-policy.md`.
- Delayed data must not power market-open quote/execute unless product explicitly accepts delayed virtual trading behavior.
- During market closed periods, the latest regular-session close may be allowed for read-only valuation and daily snapshots, but must not be mislabeled as live executable price.
- Twelve Data is a conditional US stock provider candidate through `/quote` or WebSocket evidence with usable timestamp fields. `/price` alone is not sufficient because it lacks timestamp evidence in the checked official docs.

## 8. Crypto Freshness Policy

Current implementation:

- Crypto asset prices use `admin_manual` snapshots when present.
- There is no implemented asset-price stale threshold.

Target policy after provider ingestion:

- Crypto is treated as 24/7.
- MVP crypto provider is Binance.
- MVP crypto is USD-settled and uses the USD Wallet.
- Crypto KRW valuation is crypto USD value converted with USD/KRW.
- Upbit/Bithumb are excluded from the MVP provider stack.
- Quote/read workflows use the current approved freshness rules. Orders execute uses the stricter 10-second provider capturedAt threshold from `docs/realtime-execution-policy.md`.
- Home live valuation should require a provider timestamp no older than 60 seconds.
- Daily snapshot capture should use a timestamp close to the scheduled capture time, with a maximum provider age of 5 minutes unless a later gate narrows it.
- Binance `BTCUSDT` ticker/orderbook public fixtures were captured in Gate C prep; mapping remains conditional.
- `CurrencyCode.USDT` must not be added. Gate C/D must decide whether USDT quote pairs are normalized as USD-equivalent or whether Binance USD quote pairs are required.

## 9. Quote vs Execute vs Valuation vs Ranking vs Settlement

- Quote
  - Read-only.
  - May use a fresh eligible source.
  - Must return explicit unavailable/stale errors rather than fake prices.
- Execute
  - Financial mutation path.
  - Must reselect or validate a fresh eligible source at execute time before wallet/position mutations.
  - Must not use `official_batch` as real-time execute evidence.
- Home live valuation
  - Read-only.
  - May return unavailable state when prices or FX are missing/stale.
  - Consistency is preferred over silently mixing stale data.
- Daily snapshot
  - Manual/operator-run CLI exists today.
  - Operator-run valuation may use fresh eligible provider_api first with explicit admin_manual fallback.
  - Future scheduler must be idempotent and must record which price evidence was used.
- Ranking
  - Reads generated `season_rankings`.
  - Ranking should inherit the source policy of the daily/final snapshots it consumes.
- Settlement
  - Finality and reproducibility are more important than real-time display freshness.
  - The implemented MVP settlement job evaluates at `Season.endAt`.
  - It selects the latest valid stored asset price and USD/KRW row with `effectiveAt <= Season.endAt`.
  - It does not enforce quote/execute capturedAt freshness windows because stock markets may be closed at the documented Sunday 23:59 KST season end.

## 10. SourceType Priority

SourceType priority is workflow-specific:

1. Quote/execute after provider implementation:
   - Prefer eligible fresh `provider_api`.
   - Do not silently prefer stale `admin_manual` over fresh `provider_api`.
   - Quote/read fallbacks may use explicit eligible `admin_manual` where current policy allows.
   - Execute must not use default `admin_manual` fallback; emergency manual override requires a separate operator override gate.
   - Reject `official_batch`.
2. Home live valuation:
   - Prefer eligible fresh `provider_api`.
   - Allow fresh `admin_manual` while provider ingestion is absent or during explicit fallback.
   - Allow unavailable state instead of silent stale fallback.
3. Daily snapshot and ranking:
   - Daily snapshot valuation currently prefers fresh eligible `provider_api` first, then explicit `admin_manual` fallback.
   - Ranking reads existing snapshots only and does not directly select provider rows.
   - `official_batch` may outrank `provider_api` for future official daily/reference workflows only after a separate Gate F/H approval.
4. Settlement:
   - Use the latest valid stored provider row at or before `Season.endAt` when available, with explicit `admin_manual` fallback.
   - Do not use quote/execute freshness windows.
   - Future `official_batch` or frozen reference snapshot priority can still be introduced by a separate gate.

## 11. Manual Fallback Policy

`admin_manual` is allowed for:

- bootstrap before provider ingestion,
- manual correction,
- emergency fallback,
- provider outage fallback,
- controlled smoke or operator-run valuation support.

`admin_manual` is not allowed for:

- automatic fake fallback,
- silent override of fresh provider data,
- long-running production real-time primary source,
- undocumented settlement evidence,
- sample/static business price creation.

Manual fallback rows must keep `sourceType = admin_manual`, an explicit `sourceName`, operator approval where applicable, and meaningful `effectiveAt`/`capturedAt`.

## 12. Official Batch Policy

`official_batch` is allowed only after a separate provider/batch gate for:

- daily close/reference snapshots,
- reconciliation,
- official daily portfolio snapshot inputs,
- final settlement evidence candidate,
- post-season audit.

`official_batch` is not allowed for:

- market-open quote,
- order execute,
- FX execute,
- real-time home live valuation,
- automatic fallback from provider outage.

## 13. Provider API Policy

`provider_api` is allowed only after Gate C/D implementation acceptance and required tests:

- provider response fields map deterministically to internal decimal strings,
- provider timestamp maps to `effectiveAt`,
- server receipt maps to `capturedAt`,
- `sourceType` and `sourceName` are correct,
- duplicate snapshots are handled idempotently,
- stale/missing timestamp responses are rejected,
- provider outage and rate limits do not create fake rows,
- quote/execute source eligibility is explicit.

## 14. Stale Data Behavior

Stale data must produce explicit workflow behavior:

- quote/execute: reject with stale/unavailable error before mutation.
- home live valuation: return unavailable state for affected summary fields.
- daily snapshot: fail or skip the participant with explicit error depending on job mode.
- ranking: do not synthesize rankings without source snapshots.
- settlement: use latest valid rows at or before `Season.endAt`; abort or require operator recovery if required price/FX rows are unavailable, and do not partially settle.

## 15. Market Hours and Closed-Market Behavior

- FX: execute requires fresh eligible provider USD/KRW by the active realtime execution policy; quote/read workflows use their separate freshness windows.
- Domestic stocks: market-open quote/execute is open only through the approved KIS KRX provider evidence and durable quote gates. Closed-market settlement uses latest valid rows at or before `Season.endAt`.
- US stocks: market-open quote/execute requires fresh non-delayed data or explicit product approval for delayed simulation. Closed-market read-only valuation may use latest regular close when clearly identified.
- Crypto: treat as 24/7; no closed-market relaxation.
- Settlement: use `Season.endAt` as the as-of time and select latest valid rows at or before that time; do not require the market to be open or the row to satisfy quote/execute freshness.

## 16. Error Codes / Failure Behavior

Current implemented error behavior:

- FX no snapshot: `FX_RATE_UNAVAILABLE`.
- FX stale snapshot: `FX_RATE_STALE`.
- Order quote/create missing asset price: `ASSET_PRICE_UNAVAILABLE`.
- Order execute missing asset price: `ORDER_PRICE_UNAVAILABLE`.
- Home live valuation reports unavailable state when valuation inputs are missing.

Future implementation should codify before code:

- asset quote stale: proposed `ASSET_PRICE_STALE`,
- order execute stale: proposed `ORDER_PRICE_STALE`,
- provider outage: proposed provider-specific unavailable/logged job failure, not API fake fallback,
- provider rate limit: retry/backoff and alert path, not snapshot insertion,
- provider timestamp missing: reject provider snapshot.

## 17. Required Tests for Future Implementation

FX provider_api source eligibility tests:

- provider response mapping unit test,
- provider timestamp -> `effectiveAt` mapping,
- `capturedAt` assignment,
- stale provider response rejection,
- duplicate snapshot handling,
- provider outage handling,
- no fake/static fallback,
- sourceType/sourceName correctness,
- rate limit/backoff behavior,
- quote/execute only allowed sourceType check.

Asset price provider_api source eligibility tests:

- asset symbol mapping,
- market/currency match,
- timestamp/`effectiveAt` mapping,
- stale quote rejection,
- market closed behavior,
- domestic/US/crypto separated freshness,
- `official_batch` vs `provider_api` priority,
- manual fallback not silently preferred over fresh provider,
- no fake/static/sample data,
- valuation/ranking no-mutation behavior retained.

Scheduler/batch implementation tests:

- job lock,
- idempotent rerun,
- partial failure handling,
- retry/backoff,
- dry-run mode if applicable,
- no duplicate snapshots/rankings,
- manual CLI coexistence,
- provider outage behavior.

Settlement implementation tests:

- season cutoff enforcement,
- order/FX blocked after season end,
- final valuation source fixed,
- ranking finalization idempotency,
- reward handoff boundary,
- rollback on partial failure,
- duplicate settlement prevention.

## 18. STOP / GO Decision

| Area                                   | Decision                               | Reason                                                                                                                                                                       |
| -------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Asset price freshness policy           | CONDITIONAL GO                         | Policy is now explicit enough for evidence capture and narrow provider implementation prompts, but code is unchanged                                                         |
| FX USD/KRW current 60-second policy    | GO for current `admin_manual` behavior | Existing code and tests already use the 60-second threshold                                                                                                                  |
| FX provider freshness                  | CONDITIONAL GO                         | Requires OANDA/Twelve Data live response timestamp evidence before ingestion code                                                                                            |
| US stock freshness                     | CONDITIONAL GO                         | Twelve Data is a candidate, but live fixtures, symbol mapping, plan, and terms are required                                                                                  |
| Crypto provider_api row insertion      | GO for foundation                      | Binance public REST ticker can create USD-equivalent provider_api snapshot rows for existing mapped BINANCE crypto assets                                                    |
| Crypto provider_api source eligibility | PARTIAL GO                             | Binance provider_api rows may power approved read-only/quote, durable quote execution, operator-run daily snapshot valuation, and season settlement valuation workflows only |
| KRX quote/execute freshness            | PARTIAL GO                             | KIS KRX provider rows may power approved read-only/quote and durable quote execution workflows; Twelve Data Korea exchange EOD delay remains rejected for realtime execute   |
| Scheduler/batch foundation             | CONDITIONAL GO for audit only          | Freshness requirements are clearer, but scheduler implementation needs its own gate                                                                                          |
| Settlement implementation              | PARTIAL GO                             | MVP settlement uses latest valid stored price/FX rows at or before `Season.endAt`; reward payout and future official batch priority remain separate gates                    |

## 19. Open Questions

- Which OANDA field and rate basis, bid/ask/midpoint, will be canonical for USD/KRW?
- What exact OANDA endpoint and response field maps to `effectiveAt`?
- Which Twelve Data endpoint, `/quote` or WebSocket, will be canonical for US stocks?
- Will Binance crypto use USDT quote pairs normalized as USD-equivalent, or require Binance USD quote pairs?
- Is delayed US or domestic stock data ever acceptable for virtual trading UX?
- What provider or official batch source will cover KRX if domestic stocks remain in MVP?
- Should asset quote/execute stale errors be separate public API error codes before provider code?
- Should manual fallback require a separate operator note or approval field for asset price snapshots?
- What final price evidence should settlement use: official close, frozen provider snapshot, official batch, or operator-approved reference?

## SourceType Role Matrix

| sourceType       | Intended use                                                       | Allowed for quote                          | Allowed for execute            | Allowed for home live valuation           | Allowed for daily snapshot                    | Allowed for ranking                             | Allowed for settlement                                 | Conditions                                                                                                                | Current implementation status                                                                                                                             |
| ---------------- | ------------------------------------------------------------------ | ------------------------------------------ | ------------------------------ | ----------------------------------------- | --------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin_manual`   | Bootstrap, manual correction, emergency/provider outage fallback   | Yes, current/fallback                      | Yes, current/fallback          | Yes, current/fallback                     | Yes, current manual CLI input                 | Indirectly through generated snapshots/rankings | Conditional only if Gate H approves emergency evidence | Explicit operator action, meaningful `effectiveAt`, no fake/static/sample data, freshness rules still apply where defined | Implemented for FX, asset price, order/valuation consumers, and manual CLIs                                                                               |
| `provider_api`   | Real-time or near-real-time provider source for approved workflows | Yes for approved read-only/quote workflows | No for execute/write workflows | Yes for approved live valuation workflows | Yes for operator-run daily snapshot valuation | Indirectly through snapshots/rankings only      | Not accepted as sole final source                      | Provider timestamp required, sourceName required, stale/missing/outage rejected, tests required                           | Row insertion foundation exists for ExchangeRate-API, Binance, and KIS; allowed only for approved read-only/quote plus daily snapshot valuation workflows |
| `official_batch` | Future official/reference/reconciliation source                    | No                                         | No                             | No for live valuation                     | Conditional after Gate F/H                    | Conditional through batch-backed snapshots      | Conditional primary candidate after Gate H             | Reference date/close evidence, reproducible batch, no real-time execute use                                               | Schema enum exists; ingestion not implemented                                                                                                             |

## Market Freshness Matrix

| Market / asset class | Current source                                                           | Quote freshness                                                         | Execute freshness                        | Home live valuation freshness                                           | Daily snapshot freshness                                                                                                    | Ranking freshness              | Settlement freshness                                | Current decision                                                           | Open questions                                            |
| -------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------- |
| FX USD/KRW           | approved `admin_manual`; OANDA/Twelve Data candidates                    | 60 seconds by `effectiveAt`                                             | 60 seconds by `effectiveAt`              | 60 seconds when live valuation needs USD/KRW                            | Current manual CLI valuation still depends on fresh FX when USD conversion is needed; future batch/reference policy pending | Inherited from snapshot source | Gate H decision; likely official/reference snapshot | GO for current 60-second policy; CONDITIONAL GO for provider               | OANDA endpoint/field/rate basis, contract, trial response |
| Domestic stock KRX   | `admin_manual` fallback plus KIS KRX provider_api for approved workflows | Provider capturedAt age <= 60 seconds for approved quote/read workflows | BLOCKED for provider market-open execute | Provider capturedAt age <= 60 seconds, else admin fallback if available | Provider capturedAt age <= 60 seconds, else admin fallback if available                                                     | Inherited from daily snapshots | Gate H decision                                     | GO for read-only/quote and daily snapshot valuation; execute/write blocked | Official close source for final evidence                  |
| US stock             | `admin_manual` fallback plus KIS US provider_api for approved workflows  | Provider capturedAt age <= 60 seconds for approved quote/read workflows | BLOCKED for provider market-open execute | Provider capturedAt age <= 60 seconds, else admin fallback if available | Provider capturedAt age <= 60 seconds, else admin fallback if available                                                     | Inherited from daily snapshots | Gate H decision                                     | GO for read-only/quote and daily snapshot valuation; execute/write blocked | Delayed data acceptance for broader workflows             |
| Crypto               | `admin_manual` fallback plus Binance provider_api for approved workflows | Provider capturedAt age <= 60 seconds for approved quote/read workflows | BLOCKED for provider execute             | Provider capturedAt age <= 60 seconds, else admin fallback if available | Provider capturedAt age <= 60 seconds, else admin fallback if available                                                     | Inherited from daily snapshots | Gate H decision                                     | GO for read-only/quote and daily snapshot valuation; execute/write blocked | USDT-to-USD policy remains MVP-only; depeg not modeled    |

## Stale Behavior Matrix

| API / workflow                         | If no snapshot                                          | If stale snapshot                                                                 | If provider outage                       | If manual fallback exists                                  | Expected error/state                                          | Mutation allowed?                           |
| -------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------- |
| `POST /api/v1/fx/quote`                | Reject                                                  | Reject                                                                            | No provider row inserted                 | Explicit fresh `admin_manual` may be used                  | `FX_RATE_UNAVAILABLE` or `FX_RATE_STALE`                      | No                                          |
| `POST /api/v1/fx/execute`              | Reject before debit                                     | Reject before debit                                                               | No provider row inserted                 | Explicit fresh approved `admin_manual` may be used         | `FX_RATE_UNAVAILABLE` or `FX_RATE_STALE`                      | No                                          |
| `POST /api/v1/orders/quote`            | Reject                                                  | Future reject once asset stale policy is implemented                              | No provider row inserted                 | Explicit fresh `admin_manual` may be used                  | Current `ASSET_PRICE_UNAVAILABLE`; future `ASSET_PRICE_STALE` | No                                          |
| `POST /api/v1/orders`                  | Reject before order create                              | Future reject before order create                                                 | No provider row inserted                 | Explicit fresh `admin_manual` may be used                  | Current `ASSET_PRICE_UNAVAILABLE`; future `ASSET_PRICE_STALE` | No                                          |
| `POST /api/v1/orders/:orderId/execute` | Reject before wallet/position mutation                  | Future reject before wallet/position mutation                                     | No provider row inserted                 | Explicit fresh `admin_manual` may be used                  | Current `ORDER_PRICE_UNAVAILABLE`; future `ORDER_PRICE_STALE` | No                                          |
| `GET /api/v1/home` live valuation      | Summary unavailable                                     | Summary unavailable                                                               | Use last eligible evidence only if fresh | Explicit fresh `admin_manual` may be used                  | `summary.state = unavailable` or valuation unavailable reason | No                                          |
| Daily snapshot operator-run job        | Fail participant or skip in season-wide mode with error | Provider stale falls back to eligible admin_manual; otherwise participant failure | Job failure/alert; no fake row           | Explicit operator-created snapshot may unblock later rerun | CLI/job error report plus batch `sourceSummary`               | Only successful participant snapshot create |
| Ranking generation                     | Ranking unavailable without snapshots                   | Ranking unavailable if source snapshots are not generated                         | No ranking from fake data                | Manual snapshot/ranking CLI may be run explicitly          | `data.state = unavailable` or CLI error                       | Only explicit ranking generation writes     |
| Settlement                             | Abort                                                   | Abort                                                                             | Abort and require recovery policy        | Only if Gate H approves final evidence                     | Settlement blocked/recovery-required                          | No partial settlement                       |
