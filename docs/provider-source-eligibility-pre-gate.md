# Provider API Source Eligibility Pre-Gate

Status: historical pre-gate draft; superseded by the 2026-06-03 KST read-only/quote implementation gate, the 2026-06-05 KST operator-run daily snapshot eligibility gate, and the 2026-06-08 KST Durable Quote provider execute gate.

Date: 2026-05-30 KST.

## 0.1 Implementation Update On 2026-06-08 KST

The Durable Quote provider execute gate is implemented.

Additional opened provider_api workflows:

- `fx_execute`
- `orders_execute`

Still closed workflows/surfaces:

- `orders_create` provider source selection. Orders create binds an active durable quote and creates a submitted order only.
- `season_ranking`
- `season_settlement`
- `reward_final_tier`
- `reward_fulfillment`
- scheduler/cron, provider ingestion trigger APIs, batch HTTP APIs, and real trading/account/order/deposit/withdrawal APIs

Execute provider freshness:

- KRX domestic stock, NAS/NYS US stock, and BINANCE USD crypto execute prices require `capturedAt` age <= 10 seconds.
- USD/KRW execute FX requires `capturedAt` age <= 60 seconds.
- Execute requires `sourceType=provider_api`, the expected `sourceName`, positive value, `effectiveAt <= executeNow`, and `capturedAt <= executeNow`.
- Default `admin_manual` execute fallback is forbidden.

Durable Quote behavior:

- `/fx quote` and orders quote persist active `Quote` rows and return `quoteId`, `expiresAt`, and `maxChangeBps`.
- `/fx execute` and orders execute validate quote ownership, active status, expiry, requestHash, and request field match before repricing.
- Successful execute consumes the quote atomically with wallet/order/position/ledger writes.
- Missing/stale provider rows, quote mismatch/expired/consumed, and movement beyond threshold fail closed.

## 0. Implementation Update On 2026-06-03 KST

The Provider API Source Eligibility Implementation Gate read-only/quote phase is implemented.

Opened provider_api workflows:

- `fx_quote`
- `assets_with_price`
- `orders_quote`
- `live_portfolio_valuation`
- `home_live_valuation`
- `positions_live_valuation`
- `daily_portfolio_snapshot` (operator-run daily snapshot valuation only)

Closed workflows remain:

- `fx_execute`
- `orders_create`
- `orders_execute`
- `season_ranking`
- `season_settlement`
- `reward_final_tier`
- `reward_fulfillment`
- scheduler/cron, provider ingestion trigger APIs, batch HTTP APIs, and real trading/account/order/deposit/withdrawal APIs

Allowed provider source names:

- FX USD/KRW: `exchange_rate_api`
- BINANCE USD crypto: `binance_public_rest_24hr_ticker`
- KRX-family domestic stock: `kis_krx_realtime_trade`
- NAS/NYS US stock: `kis_us_delayed_trade`

Freshness policy:

- Provider USD/KRW: `capturedAt` age <= 300 seconds, with positive rate and `effectiveAt <= now`.
- Provider asset prices: `capturedAt` age <= 60 seconds, with positive price and `effectiveAt <= now`.
- Existing `admin_manual` fallback behavior is preserved where the workflow already allowed manual data, including the existing 60-second `effectiveAt` stale check for FX paths that used it.

Fallback and metadata policy:

- Read-only/quote workflows select fresh provider_api first, then explicitly fall back to existing safe `admin_manual` selection.
- Daily snapshot valuation selects fresh provider_api first, then explicitly falls back to existing safe `admin_manual` selection. If neither source is available, the participant keeps the existing participant-level failure behavior.
- Stale, future, non-positive, wrong-source, or ineligible provider rows are rejected and must not be used.
- Source decision metadata is now exposed only as public-safe optional fields for read-only/quote UX: `rateSource`, `priceSource`, `assetPriceSource`, `fxRateSource`, and live valuation source summaries where applicable.
- Daily snapshot source decisions are exposed only as aggregate batch result `sourceSummary`/fallback information; `daily_portfolio_snapshots` row schema is unchanged.
- Metadata fields are limited to `sourceType`, `sourceName`, `snapshotId`, `effectiveAt`, `capturedAt`, `fallbackUsed`, `fallbackReason`, `rejectedProviderReason`, and `freshnessAgeSeconds`.
- Existing API response shapes remain backward-compatible; raw provider payloads, `metadataJson`, and secrets are not exposed.

## 1. Purpose

This document records the pre-gate policy draft for opening selected
`provider_api` snapshot sources in a later implementation gate.

This gate does not change quote, execute, valuation, daily snapshot, ranking,
settlement, reward, or read/write path code. Existing financial paths remain
`admin_manual` only where current code requires price or FX evidence.

## 2. Evidence Basis

Provider row insertion foundation exists for explicit operator-run ingestion:

| Domain                | Candidate `sourceName`            | Evidence status                                                                                                             |
| --------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| FX USD/KRW            | `exchange_rate_api`               | Live smoke row insertion evidence exists.                                                                                   |
| Crypto USD prices     | `binance_public_rest_24hr_ticker` | Live smoke row insertion evidence exists for `BTCUSDT` and `ETHUSDT`.                                                       |
| Domestic stock prices | `kis_krx_realtime_trade`          | Live smoke evidence exists for approval/connect/subscribe ack, domestic tick parsing, and 12 local provider_api DB inserts. |
| US stock prices       | `kis_us_delayed_trade`            | DB-started market-window rerun evidence exists: 25 provider_api USD rows inserted for active US stock assets.               |

The fixed KIS stock universe remains 40 symbols: 15 domestic KRX stocks and 25
US NAS/NYS stocks. Binance `BTCUSDT` and `ETHUSDT` remain separate crypto
assets and are not part of the KIS stock watchlist.

## 3. Workflow Eligibility Draft

| Workflow                       | Provider API use candidate   | Conservative rule                                                                             | Fallback draft                                                                                           |
| ------------------------------ | ---------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `/fx quote`                    | Candidate                    | Fresh `exchange_rate_api` USD/KRW may be eligible after tests.                                | `admin_manual` fallback only when fresh, approved, and explicitly selected by policy.                    |
| `/fx execute`                  | Candidate with stricter gate | Fresh `exchange_rate_api` required if opened; stale rows fail.                                | No silent `admin_manual` fallback except explicit emergency override policy.                             |
| orders quote                   | Candidate                    | Fresh provider asset price and USD/KRW evidence may be eligible after source selection tests. | `admin_manual` fallback only when fresh, approved, and audited.                                          |
| orders execute                 | Candidate with stricter gate | Fresh provider price and FX evidence required if opened; stale rows fail.                     | No silent fallback except explicit emergency override policy.                                            |
| assets list/detail withPrice   | Candidate                    | Read-only display can use fresh provider rows first after tests.                              | Fallback can be more permissive than execute but must expose source metadata.                            |
| positions valuation            | Candidate                    | Fresh provider asset price and FX rows can be considered for live valuation.                  | Fallback must be explicit and auditable.                                                                 |
| home live valuation            | Candidate                    | Fresh provider rows can be considered for active-season live valuation.                       | Fallback must not hide provider outage or stale state.                                                   |
| daily portfolio snapshot       | Later candidate              | Requires job-time freshness and outage policy before opening.                                 | If provider unavailable, snapshot should fail or record participant-level failure rather than fake data. |
| season ranking                 | Not direct                   | Ranking should read existing daily/final snapshots, not live provider rows directly.          | No provider fallback in ranking itself.                                                                  |
| season settlement/final result | Not direct in first gate     | Final result needs daily/final snapshot evidence policy before provider-backed settlement.    | Do not open settlement directly from live rows in this gate.                                             |
| reward/final tier              | Not direct                   | Reward and final tier should read settled rankings and participant fields only.               | No provider fallback.                                                                                    |

## 4. Freshness Threshold Draft

These thresholds are draft candidates only. The next implementation gate must
finalize exact values and tests before code changes.

| Source domain      | Quote candidate                                        | Execute candidate                                      | Valuation candidate            | Daily snapshot candidate                           |
| ------------------ | ------------------------------------------------------ | ------------------------------------------------------ | ------------------------------ | -------------------------------------------------- |
| FX USD/KRW         | 60 seconds                                             | 60 seconds                                             | 60 to 300 seconds under review | n/a unless snapshot valuation needs FX             |
| Binance crypto     | 30 seconds                                             | 30 seconds                                             | 60 seconds                     | 300 seconds or stricter job-time fresh requirement |
| KIS domestic stock | 30 to 60 seconds                                       | 30 to 60 seconds                                       | 60 seconds                     | 300 seconds or separate intraday/close policy      |
| KIS US stock       | 30 to 60 seconds, subject to KIS US free-data evidence | 30 to 60 seconds, subject to KIS US free-data evidence | 60 seconds                     | 300 seconds or separate intraday/close policy      |

For KIS US `HDFSCNT0`, the implementation gate must preserve the documented
basis that the US free quote feed is understood as 0-minute delayed/free data.

## 5. Source Priority Options

| Option | Policy                                                                                                                                     | Strength                                      | Risk                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------ |
| A      | `provider_api` first, `admin_manual` emergency fallback                                                                                    | Simple operational path.                      | Execute paths may silently use manual data unless heavily audited. |
| B      | `provider_api` only for quote/valuation, execute stays `admin_manual` or stricter provider-only after more evidence                        | Conservative for writes.                      | Mixed behavior between quote and execute can surprise users.       |
| C      | `provider_api` first for read-only, execute requires fresh provider evidence, no `admin_manual` fallback except explicit operator override | Strongest audit posture for financial writes. | Needs careful outage UX and override policy.                       |

Recommended draft:

- Read-only quote and valuation: fresh `provider_api` first, with
  `admin_manual` fallback only if explicitly fresh and marked approved.
- Financial execute: fresh `provider_api` required once opened.
  `admin_manual` fallback is forbidden unless a separate emergency override
  policy is implemented and audited.
- Settlement/final result: do not open directly from live provider rows. Decide
  daily snapshot and final snapshot evidence policy first.

## 6. Delayed and Free Data Policy

- KIS US `HDFSCNT0` is treated as the US 0-minute delayed/free quote feed
  described in the current provider policy documents.
- Hong Kong, Vietnam, China, and Japan 15-minute delayed markets are excluded
  from MVP source eligibility.
- The fixed stock universe contains only KRX domestic symbols and US NAS/NYS
  symbols.
- Whether US `HDFSCNT0` is acceptable for quote, valuation, or execute must be
  decided in the next implementation gate using live smoke evidence.
- Domestic KRX `H0STCNT0` is the domestic KRX real-time trade price feed.

## 7. Financial Write Path Safety Conditions

- Execute workflows must be more conservative than quote workflows.
- Stale `provider_api` rows must fail, not silently fall back.
- Fake prices are forbidden.
- Provider outage must not trigger silent fallback.
- If `admin_manual` fallback is allowed, response and audit payloads must record
  the fallback reason.
- When `provider_api` and `admin_manual` sources can mix, audit payloads must
  preserve `sourceType`, `sourceName`, `effectiveAt`, `capturedAt`, and snapshot
  `id`.
- Order execute and FX execute mutate wallet, position, ledger, and command
  rows, so source selection tests are mandatory.
- Source eligibility changes must not break existing rollback, concurrency, or
  idempotency tests.

## 8. Not Opened In This Gate

- No `provider_api` source eligibility implementation.
- No schema or migration change.
- No quote, execute, valuation, ranking, settlement, reward, or read path code
  change.
- No scheduler or cron job.
- No provider-backed settlement/final result policy.
- No KIS order, account, balance, fill, deposit, withdrawal, or real trading API.
- No KIS orderbook/hoga ingestion.
- No Binance authenticated API, order endpoint, account endpoint, or user data
  stream.

## 9. Next Implementation Gate Candidates

The read-only/quote and operator-run daily snapshot gates are now implemented.
Future execute/write gates should use `docs/realtime-execution-policy.md` and
plan/test:

- Source selection policy file.
- Freshness policy file.
- Source priority policy.
- Provider outage behavior.
- `admin_manual` fallback rule.
- Service-level tests.
- Integration tests where needed.
- `/fx quote` source selection.
- `/fx execute` source selection with execute-time provider repricing.
- Orders execute source selection with quote-to-execute bps protection.
- Assets, positions, and home valuation source selection.
- Daily snapshot source selection.
- Audit payload and source evidence tests.
- Stale, unavailable, and fallback tests.

## 10. Decision

Pre-gate policy draft was GO.

Implementation is now GO only for the read-only/quote workflows and
operator-run daily snapshot valuation workflow listed in section 0.
`provider_api` source eligibility remains closed for orders create source
selection, ranking, settlement, reward, automation, provider trigger, batch
HTTP API, and real trading/account surfaces. `/fx execute` and orders execute
are now open only through the 2026-06-08 Durable Quote provider execute gate.

The next execute/write gate has a separate policy foundation in
`docs/realtime-execution-policy.md`. Quote is a reference quote, execute must
reprice at execute time from fresh provider_api data, and default
`admin_manual` execute fallback remains forbidden.

Implementation sequencing:

1. KIS US `HDFSCNT0` tick and DB insertion evidence was captured on
   2026-06-03 KST in the DB-started market-window rerun.
2. The read-only/quote implementation gate opened only the workflows and source
   names with accepted evidence.
