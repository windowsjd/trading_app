# Provider API Source Eligibility Pre-Gate

Status: policy draft only, source eligibility closed.

Date: 2026-05-30 KST.

## 1. Purpose

This document records the pre-gate policy draft for opening selected
`provider_api` snapshot sources in a later implementation gate.

This gate does not change quote, execute, valuation, daily snapshot, ranking,
settlement, reward, or read/write path code. Existing financial paths remain
`admin_manual` only where current code requires price or FX evidence.

## 2. Evidence Basis

Provider row insertion foundation exists for explicit operator-run ingestion:

| Domain | Candidate `sourceName` | Evidence status |
| --- | --- | --- |
| FX USD/KRW | `exchange_rate_api` | Live smoke row insertion evidence exists. |
| Crypto USD prices | `binance_public_rest_24hr_ticker` | Live smoke row insertion evidence exists for `BTCUSDT` and `ETHUSDT`. |
| Domestic stock prices | `kis_krx_realtime_trade` | Live smoke evidence exists for approval/connect/subscribe ack, domestic tick parsing, and 12 local provider_api DB inserts. |
| US stock prices | `kis_us_delayed_trade` | Subscription ack evidence exists, but no US tick or DB insertion was observed in the 2026-06-01 30-second smoke window or the later US-only 60-second retry outside the US regular market window. |

The fixed KIS stock universe remains 40 symbols: 15 domestic KRX stocks and 25
US NAS/NYS stocks. Binance `BTCUSDT` and `ETHUSDT` remain separate crypto
assets and are not part of the KIS stock watchlist.

## 3. Workflow Eligibility Draft

| Workflow | Provider API use candidate | Conservative rule | Fallback draft |
| --- | --- | --- | --- |
| `/fx quote` | Candidate | Fresh `exchange_rate_api` USD/KRW may be eligible after tests. | `admin_manual` fallback only when fresh, approved, and explicitly selected by policy. |
| `/fx execute` | Candidate with stricter gate | Fresh `exchange_rate_api` required if opened; stale rows fail. | No silent `admin_manual` fallback except explicit emergency override policy. |
| orders quote | Candidate | Fresh provider asset price and USD/KRW evidence may be eligible after source selection tests. | `admin_manual` fallback only when fresh, approved, and audited. |
| orders execute | Candidate with stricter gate | Fresh provider price and FX evidence required if opened; stale rows fail. | No silent fallback except explicit emergency override policy. |
| assets list/detail withPrice | Candidate | Read-only display can use fresh provider rows first after tests. | Fallback can be more permissive than execute but must expose source metadata. |
| positions valuation | Candidate | Fresh provider asset price and FX rows can be considered for live valuation. | Fallback must be explicit and auditable. |
| home live valuation | Candidate | Fresh provider rows can be considered for active-season live valuation. | Fallback must not hide provider outage or stale state. |
| daily portfolio snapshot | Later candidate | Requires job-time freshness and outage policy before opening. | If provider unavailable, snapshot should fail or record participant-level failure rather than fake data. |
| season ranking | Not direct | Ranking should read existing daily/final snapshots, not live provider rows directly. | No provider fallback in ranking itself. |
| season settlement/final result | Not direct in first gate | Final result needs daily/final snapshot evidence policy before provider-backed settlement. | Do not open settlement directly from live rows in this gate. |
| reward/final tier | Not direct | Reward and final tier should read settled rankings and participant fields only. | No provider fallback. |

## 4. Freshness Threshold Draft

These thresholds are draft candidates only. The next implementation gate must
finalize exact values and tests before code changes.

| Source domain | Quote candidate | Execute candidate | Valuation candidate | Daily snapshot candidate |
| --- | --- | --- | --- | --- |
| FX USD/KRW | 60 seconds | 60 seconds | 60 to 300 seconds under review | n/a unless snapshot valuation needs FX |
| Binance crypto | 30 seconds | 30 seconds | 60 seconds | 300 seconds or stricter job-time fresh requirement |
| KIS domestic stock | 30 to 60 seconds | 30 to 60 seconds | 60 seconds | 300 seconds or separate intraday/close policy |
| KIS US stock | 30 to 60 seconds, subject to KIS US free-data evidence | 30 to 60 seconds, subject to KIS US free-data evidence | 60 seconds | 300 seconds or separate intraday/close policy |

For KIS US `HDFSCNT0`, the implementation gate must preserve the documented
basis that the US free quote feed is understood as 0-minute delayed/free data.

## 5. Source Priority Options

| Option | Policy | Strength | Risk |
| --- | --- | --- | --- |
| A | `provider_api` first, `admin_manual` emergency fallback | Simple operational path. | Execute paths may silently use manual data unless heavily audited. |
| B | `provider_api` only for quote/valuation, execute stays `admin_manual` or stricter provider-only after more evidence | Conservative for writes. | Mixed behavior between quote and execute can surprise users. |
| C | `provider_api` first for read-only, execute requires fresh provider evidence, no `admin_manual` fallback except explicit operator override | Strongest audit posture for financial writes. | Needs careful outage UX and override policy. |

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

The next gate should plan and test:

- Source selection policy file.
- Freshness policy file.
- Source priority policy.
- Provider outage behavior.
- `admin_manual` fallback rule.
- Service-level tests.
- Integration tests where needed.
- `/fx quote` source selection.
- `/fx execute` source selection.
- Orders quote/execute source selection.
- Assets, positions, and home valuation source selection.
- Daily snapshot source selection.
- Audit payload and source evidence tests.
- Stale, unavailable, and fallback tests.

## 10. Decision

Pre-gate policy draft is GO.

Implementation remains STOP. `provider_api` source eligibility is still closed
for quote, execute, valuation, daily snapshot, ranking, settlement, reward, and
all existing financial read/write paths.

Implementation sequencing:

1. Capture KIS US `HDFSCNT0` tick and DB insertion evidence during an
   appropriate US market-data window, or record an explicit owner decision to
   scope US live evidence separately.
2. Start Provider API Source Eligibility Implementation Gate for only the
   workflows and source names with accepted live evidence.
