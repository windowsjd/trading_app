# Asset Price Freshness Policy

## 1. Purpose

This document fixes the near-term freshness and source policy for FX and asset price snapshots before provider ingestion, scheduler/batch, ranking automation, settlement, or reward implementation.

This is a docs-only policy. It does not authorize source code, test, package, Prisma schema, migration, seed, provider API client, scheduler, settlement, reward, durable quote, order replay, partial fill, or matching-engine changes.

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

- `/fx quote` reads the latest eligible USD/KRW snapshot by `effectiveAt`, `capturedAt`, then `createdAt`; it currently does not filter `sourceType`; it applies a 60-second FX freshness threshold.
- `/fx execute` allows only approved fresh `admin_manual` USD/KRW snapshots and applies the same 60-second threshold.
- Order quote/create/execute currently allow only `admin_manual` asset price snapshots. USD assets also require approved fresh `admin_manual` USD/KRW.
- Portfolio valuation/home live valuation currently use `admin_manual` asset prices and approved fresh `admin_manual` USD/KRW when USD conversion is needed.
- Ranking APIs read existing `season_rankings`; they do not fetch or calculate prices.
- Daily snapshot and ranking generation exist only as manual CLI foundations.

## 3. Existing Source Types

Current source types are:

- `admin_manual`
- `provider_api`
- `official_batch`

Policy meanings:

- `admin_manual`: bootstrap, manual correction, emergency fallback, and provider outage fallback through explicit operator action. It is not recommended as the long-running production real-time primary source.
- `provider_api`: future real-time or near-real-time source for quote, execute, and live valuation only after provider selection, timestamp evidence, ingestion implementation, and tests are accepted.
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

- `/fx quote`: USD/KRW snapshot must be at most 60 seconds old by `effectiveAt` at quote time.
- `/fx execute`: USD/KRW snapshot must be at most 60 seconds old by `effectiveAt` at execute time.
- Exactly 60 seconds is accepted; older than 60 seconds is stale.
- Current execute source is approved `admin_manual` only.

Future provider policy:

- OANDA is the conditional primary FX provider candidate.
- Twelve Data is the conditional secondary FX provider candidate.
- `provider_api` USD/KRW requires provider timestamp -> `effectiveAt`, server receipt -> `capturedAt`, fixed rate basis, sourceType/sourceName correctness, stale response rejection, and no fake/static fallback.
- `/fx quote` sourceType selection must be tightened before mixed `admin_manual` and `provider_api` rows are introduced, because current quote code is sourceType-agnostic.

## 6. Domestic Stock Freshness Policy

Current implementation:

- Domestic stock asset prices use `admin_manual` snapshots when present.
- There is no implemented asset-price stale threshold.

Policy decision:

- KRX market-open quote/execute remains BLOCKED for `provider_api` until a provider with quote/execute-grade timestamp and coverage is verified.
- Twelve Data is not accepted as KRX quote/execute provider in the current re-check because checked official coverage identifies Korea Stock Exchange and KOSDAQ as EOD delay, not real-time quote/execute-grade coverage.
- Delayed/EOD domestic data may be considered for daily/reference valuation only if product and settlement policy accept that behavior in a later gate.
- `official_batch` may be a domestic close/reference candidate after a batch/source gate, not a market-open execute source.

## 7. US Stock Freshness Policy

Current implementation:

- US stock prices use `admin_manual` snapshots when present.
- There is no implemented asset-price stale threshold.
- USD assets require fresh approved USD/KRW for KRW valuation/audit consistency.

Target policy after provider ingestion:

- During regular market hours, quote/execute should require a provider timestamp no older than 60 seconds.
- Delayed data must not power market-open quote/execute unless product explicitly accepts delayed virtual trading behavior.
- During market closed periods, the latest regular-session close may be allowed for read-only valuation and daily snapshots, but must not be mislabeled as live executable price.
- Twelve Data is a conditional US stock provider candidate through `/quote` or WebSocket evidence with usable timestamp fields. `/price` alone is not sufficient because it lacks timestamp evidence in the checked official docs.

## 8. Crypto Freshness Policy

Current implementation:

- Crypto asset prices use `admin_manual` snapshots when present.
- There is no implemented asset-price stale threshold.

Target policy after provider ingestion:

- Crypto is treated as 24/7.
- Quote/execute should require a provider timestamp no older than 30 seconds.
- Home live valuation should require a provider timestamp no older than 60 seconds.
- Daily snapshot capture should use a timestamp close to the scheduled capture time, with a maximum provider age of 5 minutes unless a later gate narrows it.
- Twelve Data is a conditional crypto provider candidate, but exchange/symbol aggregation and timestamp evidence must be accepted first.

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
  - Manual CLI exists today.
  - Future scheduler must be idempotent and must record which price evidence was used.
- Ranking
  - Reads generated `season_rankings`.
  - Ranking should inherit the source policy of the daily/final snapshots it consumes.
- Settlement
  - Finality and reproducibility are more important than real-time display freshness.
  - Final settlement source remains a Gate H decision.
  - `provider_api` real-time price alone is not accepted as final settlement evidence in this policy.

## 10. SourceType Priority

SourceType priority is workflow-specific:

1. Quote/execute after provider implementation:
   - Prefer eligible fresh `provider_api`.
   - Do not silently prefer stale `admin_manual` over fresh `provider_api`.
   - Allow `admin_manual` only as explicit operator fallback with sourceName, timestamp, approval evidence, and fresh threshold compliance.
   - Reject `official_batch`.
2. Home live valuation:
   - Prefer eligible fresh `provider_api`.
   - Allow fresh `admin_manual` while provider ingestion is absent or during explicit fallback.
   - Allow unavailable state instead of silent stale fallback.
3. Daily snapshot and ranking:
   - Prefer the source selected by the snapshot generation policy.
   - `official_batch` may outrank `provider_api` for daily/reference workflows after Gate F/H approval.
4. Settlement:
   - Source priority must be fixed in Gate H.
   - `official_batch` or a frozen reference snapshot is the likely candidate, not live `provider_api`.

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
- settlement: abort or require operator recovery; do not partially settle.

## 15. Market Hours and Closed-Market Behavior

- FX: treat USD/KRW as quote/execute fresh only by the 60-second `effectiveAt` threshold until a market-hours policy says otherwise.
- Domestic stocks: market-open quote/execute is blocked until real-time KRX provider evidence exists. Closed-market close/reference use remains conditional.
- US stocks: market-open quote/execute requires fresh non-delayed data or explicit product approval for delayed simulation. Closed-market read-only valuation may use latest regular close when clearly identified.
- Crypto: treat as 24/7; no closed-market relaxation.
- Settlement: market-hours behavior must be frozen by Gate H and must not rely on ambiguous live price drift.

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

FX provider ingestion implementation tests:

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

Asset price provider ingestion implementation tests:

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

| Area | Decision | Reason |
|---|---|---|
| Asset price freshness policy | CONDITIONAL GO | Policy is now explicit enough for evidence capture and narrow provider implementation prompts, but code is unchanged |
| FX USD/KRW current 60-second policy | GO for current `admin_manual` behavior | Existing code and tests already use the 60-second threshold |
| FX provider freshness | CONDITIONAL GO | Requires OANDA/Twelve Data live response timestamp evidence before ingestion code |
| US stock freshness | CONDITIONAL GO | Twelve Data is a candidate, but live fixtures, symbol mapping, plan, and terms are required |
| Crypto freshness | CONDITIONAL GO | Twelve Data is a candidate, but exchange/symbol aggregation and timestamp proof are required |
| KRX quote/execute freshness | BLOCKED | Real-time KRX provider evidence is not verified; checked Twelve Data coverage indicates Korea exchanges are EOD delay |
| Scheduler/batch foundation | CONDITIONAL GO for audit only | Freshness requirements are clearer, but scheduler implementation needs its own gate |
| Settlement implementation | STOP | Final evidence source and reproducibility policy belong to Gate H/I |

## 19. Open Questions

- Which OANDA field and rate basis, bid/ask/midpoint, will be canonical for USD/KRW?
- What exact OANDA endpoint and response field maps to `effectiveAt`?
- Which Twelve Data endpoint, `/quote` or WebSocket, will be canonical for US stocks and crypto?
- Is delayed US or domestic stock data ever acceptable for virtual trading UX?
- What provider or official batch source will cover KRX if domestic stocks remain in MVP?
- Should asset quote/execute stale errors be separate public API error codes before provider code?
- Should manual fallback require a separate operator note or approval field for asset price snapshots?
- What final price evidence should settlement use: official close, frozen provider snapshot, official batch, or operator-approved reference?

## SourceType Role Matrix

| sourceType | Intended use | Allowed for quote | Allowed for execute | Allowed for home live valuation | Allowed for daily snapshot | Allowed for ranking | Allowed for settlement | Conditions | Current implementation status |
|---|---|---|---|---|---|---|---|---|---|
| `admin_manual` | Bootstrap, manual correction, emergency/provider outage fallback | Yes, current/fallback | Yes, current/fallback | Yes, current/fallback | Yes, current manual CLI input | Indirectly through generated snapshots/rankings | Conditional only if Gate H approves emergency evidence | Explicit operator action, meaningful `effectiveAt`, no fake/static/sample data, freshness rules still apply where defined | Implemented for FX, asset price, order/valuation consumers, and manual CLIs |
| `provider_api` | Future real-time or near-real-time provider source | Conditional after Gate C/D | Conditional after Gate C/D | Conditional after Gate C/D | Conditional after Gate F job policy | Indirectly through snapshots/rankings | Not accepted as sole final source | Provider timestamp required, sourceName required, stale/missing/outage rejected, tests required | Schema enum exists; ingestion not implemented; not currently allowed by execute/order selection |
| `official_batch` | Future official/reference/reconciliation source | No | No | No for live valuation | Conditional after Gate F/H | Conditional through batch-backed snapshots | Conditional primary candidate after Gate H | Reference date/close evidence, reproducible batch, no real-time execute use | Schema enum exists; ingestion not implemented |

## Market Freshness Matrix

| Market / asset class | Current source | Quote freshness | Execute freshness | Home live valuation freshness | Daily snapshot freshness | Ranking freshness | Settlement freshness | Current decision | Open questions |
|---|---|---|---|---|---|---|---|---|---|
| FX USD/KRW | approved `admin_manual`; OANDA/Twelve Data candidates | 60 seconds by `effectiveAt` | 60 seconds by `effectiveAt` | 60 seconds when live valuation needs USD/KRW | Current manual CLI valuation still depends on fresh FX when USD conversion is needed; future batch/reference policy pending | Inherited from snapshot source | Gate H decision; likely official/reference snapshot | GO for current 60-second policy; CONDITIONAL GO for provider | OANDA endpoint/field/rate basis, contract, trial response |
| Domestic stock KRX | `admin_manual` only | BLOCKED for provider market-open quote; target would be max 60 seconds if real-time source is verified | BLOCKED for provider market-open execute; target would be max 60 seconds if real-time source is verified | Conditional read-only valuation using explicit manual/EOD/reference evidence | Conditional EOD/reference after batch/source gate | Inherited from daily snapshots | Gate H decision | BLOCKED for KRX quote/execute provider_api | Real-time KRX source, delayed/EOD product acceptance, official close source |
| US stock | `admin_manual` only; Twelve Data candidate | Target max 60 seconds during market hours | Target max 60 seconds during market hours | Target max 15 minutes during market hours, latest regular close when clearly closed | Official close/EOD or provider snapshot near scheduled capture, Gate F decision | Inherited from daily snapshots | Gate H decision | CONDITIONAL GO | Twelve Data live fixture, plan/terms, delayed data acceptance |
| Crypto | `admin_manual` only; Twelve Data candidate | Target max 30 seconds | Target max 30 seconds | Target max 60 seconds | Target max 5 minutes near scheduled capture | Inherited from daily snapshots | Gate H decision | CONDITIONAL GO | Exchange/symbol aggregation, provider timestamp, volatility tolerance |

## Stale Behavior Matrix

| API / workflow | If no snapshot | If stale snapshot | If provider outage | If manual fallback exists | Expected error/state | Mutation allowed? |
|---|---|---|---|---|---|---|
| `POST /api/v1/fx/quote` | Reject | Reject | No provider row inserted | Explicit fresh `admin_manual` may be used | `FX_RATE_UNAVAILABLE` or `FX_RATE_STALE` | No |
| `POST /api/v1/fx/execute` | Reject before debit | Reject before debit | No provider row inserted | Explicit fresh approved `admin_manual` may be used | `FX_RATE_UNAVAILABLE` or `FX_RATE_STALE` | No |
| `POST /api/v1/orders/quote` | Reject | Future reject once asset stale policy is implemented | No provider row inserted | Explicit fresh `admin_manual` may be used | Current `ASSET_PRICE_UNAVAILABLE`; future `ASSET_PRICE_STALE` | No |
| `POST /api/v1/orders` | Reject before order create | Future reject before order create | No provider row inserted | Explicit fresh `admin_manual` may be used | Current `ASSET_PRICE_UNAVAILABLE`; future `ASSET_PRICE_STALE` | No |
| `POST /api/v1/orders/:orderId/execute` | Reject before wallet/position mutation | Future reject before wallet/position mutation | No provider row inserted | Explicit fresh `admin_manual` may be used | Current `ORDER_PRICE_UNAVAILABLE`; future `ORDER_PRICE_STALE` | No |
| `GET /api/v1/home` live valuation | Summary unavailable | Summary unavailable | Use last eligible evidence only if fresh | Explicit fresh `admin_manual` may be used | `summary.state = unavailable` or valuation unavailable reason | No |
| Daily snapshot manual CLI/future job | Fail participant or skip in season-wide mode with error | Fail participant or skip with error | Job failure/alert; no fake row | Explicit operator-created snapshot may unblock later rerun | CLI/job error report | Only successful participant snapshot upsert |
| Ranking generation | Ranking unavailable without snapshots | Ranking unavailable if source snapshots are not generated | No ranking from fake data | Manual snapshot/ranking CLI may be run explicitly | `data.state = unavailable` or CLI error | Only explicit ranking generation writes |
| Settlement | Abort | Abort | Abort and require recovery policy | Only if Gate H approves final evidence | Settlement blocked/recovery-required | No partial settlement |
