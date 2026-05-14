# Provider Evidence Capture

## 1. Purpose

This document records Gate C/D provider evidence capture before any provider ingestion implementation.

The goal is to determine whether OANDA USD/KRW, Twelve Data USD/KRW/US stock, and Binance crypto responses can be mapped safely to the current internal FX and asset price snapshot models.

Evidence capture result as of 2026-05-14: Binance public `BTCUSDT` ticker and orderbook fixtures were captured successfully without credentials. OANDA and Twelve Data live fixtures remain `BLOCKED` because credentials were unavailable in the local environment.

Implementation readiness: not ready for provider ingestion implementation. Binance fixture evidence now proves public response shapes, but Binance USDT-to-USD policy, executable price-field decision, standalone `effectiveAt` mapping, sourceType eligibility tests, and owner terms decisions are still missing. OANDA/Twelve Data still need credentialed live response fixtures.

Remaining blockers: provider credentials where required, live response fixtures, exact timestamp freshness measurement, rate/price field confirmation, OANDA rate basis decision, Binance USDT-to-USD-equivalent owner decision or Binance USD quote pair evidence, commercial/business terms approval, and sourceType eligibility implementation policy.

Required owner decisions: provider account/plan, commercial/external display terms, OANDA bid/ask/mid policy, Twelve Data endpoint choice for US stock, Binance USDT-to-USD-equivalent policy, KRX scope, and whether delayed data is acceptable anywhere in the product.

Recommended next prompt title: `Gate C/D Provider Mapping Decision - Binance USDT-to-USD Policy and SourceType Eligibility`.

Crypto policy update on 2026-05-14: MVP crypto provider is Binance, crypto is USD-settled, crypto uses the USD Wallet, Upbit/Bithumb are excluded from MVP, and `CurrencyCode.USDT` must not be added.

## 2. Scope and Non-goals

Scope:

- Re-check official provider documents.
- Check local credential availability without printing secrets.
- Record live fixture capture status.
- Record official-document mapping candidates.
- Record error/rate-limit evidence available from official documentation.
- Update current status and roadmap summaries.

Non-goals:

- No provider client implementation.
- No provider ingestion implementation.
- No scheduler/batch implementation.
- No DB write.
- No schema, migration, seed, package, source, or test changes.
- No durable quote, exact execute replay, partial fill, matching engine, settlement, reward, refresh token, logout, or revocation work.
- No fake/static/sample business price data.
- No API key, secret, account id, token, or Authorization header stored in docs or fixtures.

## 3. Internal Policy Baseline

Current internal source policy:

- FX source types: `admin_manual`, `provider_api`, `official_batch`.
- Asset price source types: `admin_manual`, `provider_api`, `official_batch`.
- `provider_api` schema enum exists but provider ingestion is not implemented.
- `official_batch` schema enum exists but batch ingestion is not implemented.
- `admin_manual` remains bootstrap/manual correction/emergency fallback, not silent long-running production primary.

Current code behavior:

- `/fx quote` reads latest USD/KRW by `effectiveAt`, `capturedAt`, then `createdAt`; it currently does not filter `sourceType`; it applies 60-second freshness.
- `/fx execute` allows only approved fresh `admin_manual` USD/KRW snapshots and applies the same 60-second freshness rule.
- Order quote/create/execute asset prices use `admin_manual` only.
- USD stock and USD-settled crypto orders use the USD wallet and still require a fresh approved `admin_manual` USD/KRW snapshot for audit consistency.
- Portfolio valuation uses `admin_manual` asset prices and approved fresh `admin_manual` USD/KRW.
- Ranking reads existing `season_rankings`; it does not fetch prices.
- Scheduler/batch, provider ingestion, settlement, and reward remain unimplemented.

Current timestamp policy:

- `effectiveAt`: market-data validity time; provider timestamp must map here for `provider_api`.
- `capturedAt`: our server response receipt or admin save time.
- `createdAt`: DB row creation time; tie-breaker only.

## 4. Environment / Credentials Status

Checked date: 2026-05-14.

Credential presence was checked without printing values.

| Credential/env | Status | Effect |
|---|---|---|
| `OANDA_EXCHANGE_RATES_API_KEY` | unset | Preferred OANDA Exchange Rates API credential unavailable; OANDA live fixture `BLOCKED` |
| `OANDA_API_KEY` | unset | Secondary/fallback OANDA credential unavailable |
| `OANDA_ACCOUNT_ID` | unset | OANDA account-bound request evidence `BLOCKED` if the chosen official endpoint requires account context |
| `OANDA_ACCOUNT` | unset | OANDA account-bound request evidence `BLOCKED` if the chosen official endpoint requires account context |
| `TWELVE_DATA_API_KEY` | unset | Twelve Data USD/KRW and US stock live fixtures `BLOCKED` |

No live provider API calls were attempted because the required credentials were unavailable.

OANDA credential naming note:

- `OANDA_EXCHANGE_RATES_API_KEY` remains the preferred env name for this project because OANDA Exchange Rates API official pages describe an API key for OANDA Rates.
- `OANDA_API_KEY`, `OANDA_ACCOUNT_ID`, and `OANDA_ACCOUNT` were checked because they were provided in the task. The exact Exchange Rates API endpoint and whether it requires account context remain unverified without a live key or accessible developer response.
- If OANDA official developer documentation requires another credential name for Exchange Rates API, document the official reason before using it.

Capture availability:

- OANDA USD/KRW fixture: `BLOCKED`, credentials unavailable.
- Twelve Data USD/KRW fixture: `BLOCKED`, credentials unavailable.
- Twelve Data US stock fixture: `BLOCKED`, credentials unavailable.
- Binance crypto ticker fixture: `GO` for fixture capture; public `BTCUSDT` 24hr ticker returned HTTP 200 without auth.
- Binance crypto orderbook fixture: `CONDITIONAL GO` for fixture capture; public `BTCUSDT` depth returned HTTP 200 without auth, but the response has no source timestamp.

Live JSON fixture files created in this task:

- `docs/provider-fixtures/binance-btcusdt-ticker-sample.json`
- `docs/provider-fixtures/binance-btcusdt-orderbook-sample.json`

No OANDA or Twelve Data live call was attempted because credentials were unavailable.

## 5. Official Documents Rechecked

Checked date: 2026-05-14.

| Provider | Official document | Checked items | Evidence result |
|---|---|---|---|
| OANDA | https://www.oanda.com/foreign-exchange-data-services/en/exchange-rates-api/ | REST/GET/HTTPS, UTC timestamps, JSON/XML/CSV, real-time rates, bid/ask/midpoint, trial | Official docs support OANDA as FX candidate; exact response fields remain unverified |
| OANDA | https://www.oanda.com/foreign-exchange-data-services/en/exchange-rates-api/api-plans/ | 7-day trial, 100,000 quotes/month Lite, higher plans, account/API key | Current as checked on 2026-05-13; contract/cost approval still required |
| Twelve Data | https://twelvedata.com/docs | `/exchange_rate`, `/quote`, `/price`, WebSocket quote price, symbol examples, fields, API shape | Official docs support mapping candidates; live response still required |
| Twelve Data | https://twelvedata.com/docs/currencies/exchange-rate | `/exchange_rate` endpoint, slash-delimited symbol, `rate`, `timestamp` | Official docs support USD/KRW candidate shape, but USD/KRW live response not captured |
| Twelve Data | https://twelvedata.com/docs/market-data/quote | `/quote` endpoint, `close`, `timestamp`, `last_quote_at`, `previous_close`, `is_market_open`, extended-hours fields | Official docs support US stock quote candidate shape |
| Twelve Data | https://twelvedata.com/docs/market-data/price | `/price` endpoint returns only `price` | Not sufficient alone for `provider_api` snapshot because timestamp evidence is missing |
| Twelve Data | https://twelvedata.com/pricing | API credits/minute, Basic 8 API credits and 800/day, real-time US equities/forex/crypto statements, individual plan scope | Current as checked on 2026-05-13; production terms still require owner approval |
| Twelve Data | https://twelvedata.com/pricing-business | Business/external display positioning and business credits | Current as checked on 2026-05-13; commercial/external display approval still required |
| Twelve Data | https://support.twelvedata.com/en/articles/5615854-credits | API credit reset, 429 behavior, response headers for credits used/left | Current as checked on 2026-05-13 |
| Twelve Data | https://twelvedata.com/stocks | US/global coverage; South Korea EOD delay | KRX quote/execute remains blocked |
| Binance | `https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT` and `https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=5` | Public spot-market ticker and orderbook response shape for `BTCUSDT` | HTTP 200 fixtures captured without auth; ingestion remains STOP pending USDT-to-USD policy, effectiveAt mapping, sourceType eligibility tests, and terms approval |
| Twelve Data | https://twelvedata.com/markets/938314/forex/usd-krw | Official USD/KRW market page | Supports pair existence as a market page; API response still unverified |

## 6. OANDA USD/KRW Evidence

Live fixture status:

- OANDA live fixture BLOCKED: credentials unavailable.
- No request was sent.
- No fixture file was created.

Official-document evidence:

- OANDA Exchange Rates API is documented as REST over HTTPS using GET.
- OANDA documents UTC timestamps and JSON/XML/CSV formats.
- OANDA documents average rates with bid, ask, and midpoint, and real-time streaming bid/ask/midpoint rates through REST or FIX API.
- OANDA documents a 7-day trial API key.
- OANDA API plans currently list Lite with 100,000 quotes/month and higher plans with broader quote capacity. Current as checked on 2026-05-13.

Unverified items:

- Actual USD/KRW API pair request.
- Exact endpoint path.
- Exact request parameters.
- Exact authentication header/query.
- Response status and content type.
- Response field names.
- Bid/ask/mid response shape.
- Timestamp field name and timezone in the API response.
- Whether rate basis is KRW per 1 USD for the selected endpoint.
- Error response shape.
- Whether 30-second polling is contractually permitted.

Mapping candidate:

- Internal table: `fx_rate_snapshots`.
- `sourceType`: `provider_api`.
- `sourceName`: `oanda`.
- `rate`: selected bid/ask/midpoint after owner decision.
- `baseCurrency`: `USD`.
- `quoteCurrency`: `KRW`.
- `sourceTimestamp`: OANDA response timestamp field, unverified.
- `effectiveAt`: OANDA response timestamp if confirmed.
- `capturedAt`: local server receipt time.
- `rawPayloadJson`: sanitized response body only after terms/storage approval.

Current decision:

- OANDA USD/KRW fixture capture: BLOCKED.
- OANDA FX provider implementation: BLOCKED until live fixture and owner terms decisions exist.

## 7. Twelve Data USD/KRW Evidence

Live fixture status:

- Twelve Data USD/KRW live fixture BLOCKED: `TWELVE_DATA_API_KEY` unavailable.
- No request was sent.
- No fixture file was created.

Official-document evidence:

- Candidate endpoint: `/exchange_rate`.
- Candidate request template: `GET https://api.twelvedata.com/exchange_rate?symbol=USD/KRW&apikey=<redacted>`.
- Official docs describe slash-delimited currency pair symbols.
- Official docs describe `/exchange_rate` as returning real-time rates for forex and cryptocurrency pairs.
- Official docs show response fields `symbol`, `rate`, and `timestamp`.
- Official docs define `timestamp` as Unix timestamp of the rate.
- Official pricing/support docs state API credits reset every minute and 429 is used when API credits are exhausted.

Unverified items:

- Actual USD/KRW response with a live key.
- Whether the account plan can access USD/KRW.
- Whether `timestamp` freshness stays within the 60-second quote/execute threshold under polling.
- Actual response status and content type.
- Error response shape for invalid USD/KRW or invalid API key.
- Commercial/business terms for production use.

Mapping candidate:

- Internal table: `fx_rate_snapshots`.
- `sourceType`: `provider_api`.
- `sourceName`: `twelve_data_exchange_rate`.
- `rate`: response `rate`.
- `baseCurrency`: `USD`.
- `quoteCurrency`: `KRW`.
- `sourceTimestamp`: response `timestamp`.
- `effectiveAt`: response `timestamp` converted from Unix seconds to UTC DateTime.
- `capturedAt`: local server receipt time.
- `rawPayloadJson`: sanitized response body only after terms/storage approval.

Current decision:

- Twelve Data USD/KRW fixture capture: BLOCKED.
- Twelve Data FX fallback implementation: BLOCKED until live fixture and owner terms decisions exist.

## 8. Twelve Data US Stock Evidence

Live fixture status:

- Twelve Data US stock live fixture BLOCKED: `TWELVE_DATA_API_KEY` unavailable.
- No request was sent.
- No fixture file was created.

Official-document evidence:

- Candidate endpoint: `/quote`.
- Candidate request template: `GET https://api.twelvedata.com/quote?symbol=AAPL&apikey=<redacted>`.
- Candidate symbol: `AAPL`.
- Official `/quote` docs expose response fields including `symbol`, `exchange`, `name`, `currency`, `datetime`, `timestamp`, `last_quote_at`, `open`, `high`, `low`, `close`, `previous_close`, `change`, `percent_change`, and `is_market_open`.
- Official `/quote` docs define `timestamp` as Unix timestamp representing the opening candle of the specified interval.
- Official `/quote` docs define `last_quote_at` as Unix timestamp of the last minute candle.
- Official pricing/coverage pages state real-time US equities/US stocks availability by plan.
- Official `/price` docs return only `price`; `/price` alone is not enough for internal snapshot mapping because it lacks timestamp and market-open evidence.

Unverified items:

- Actual `AAPL` response with this account.
- Whether the account plan has real-time US stock access.
- Which field should be canonical for executable price during open market.
- Whether `close` from `/quote` is acceptable for quote/execute or only valuation.
- Whether `last_quote_at` is fresher or more semantically correct than `timestamp` for `effectiveAt`.
- Exact behavior when the US market is closed.
- Commercial/business terms.

Mapping candidate:

- Internal table: `asset_price_snapshots`.
- `sourceType`: `provider_api`.
- `sourceName`: `twelve_data_quote`.
- `price`: candidate `close`, pending live fixture and owner decision.
- `currencyCode`: response `currency`, expected `USD` for AAPL/MSFT.
- `sourceTimestamp`: candidate `last_quote_at` or `timestamp`.
- `effectiveAt`: preferred candidate `last_quote_at` if live fixture confirms it represents the latest quote/candle; otherwise `timestamp` requires review.
- `capturedAt`: local server receipt time.
- `rawPayloadJson`: sanitized response body only after terms/storage approval.

Current decision:

- Twelve Data US stock fixture capture: BLOCKED.
- US stock provider implementation: BLOCKED until live fixture, timestamp decision, and terms decision exist.

## 9. Binance Crypto Evidence

Live fixture status:

- Binance public `BTCUSDT` ticker fixture captured: `GO`.
- Binance public `BTCUSDT` orderbook fixture captured: `CONDITIONAL GO`.
- No private/auth/account/order endpoint was called.
- No API key or Authorization header was used.

Captured endpoint evidence:

- MVP provider target: Binance.
- MVP settlement currency: USD.
- Fixture file A: `docs/provider-fixtures/binance-btcusdt-ticker-sample.json`.
  - Endpoint path: `/api/v3/ticker/24hr`.
  - Request method: `GET`.
  - Request symbol: `BTCUSDT`.
  - Response status: `200`.
  - Response content-type: `application/json;charset=UTF-8`.
  - Symbol field: `symbol = BTCUSDT`.
  - Price candidates: `lastPrice`, `weightedAvgPrice`, `bidPrice`, `askPrice`.
  - Timestamp candidates: `openTime`, `closeTime`.
  - Timestamp unit: Unix milliseconds.
  - Captured `closeTime`: `1778732937003` -> `2026-05-14T04:28:57.003Z`.
  - Captured `lastPrice`: `79336.00000000`.
  - `closeTime` can be converted to UTC DateTime as an `effectiveAt` candidate only if owner accepts rolling 24hr ticker close time semantics for quote/valuation.
- Fixture file B: `docs/provider-fixtures/binance-btcusdt-orderbook-sample.json`.
  - Endpoint path: `/api/v3/depth`.
  - Request method: `GET`.
  - Request symbol: `BTCUSDT`.
  - Response status: `200`.
  - Response content-type: `application/json;charset=UTF-8`.
  - Bid/ask fields: `bids[0][0]`, `asks[0][0]`.
  - Midpoint is calculable as `(bestBid + bestAsk) / 2`.
  - Captured best bid: `79336.00000000`.
  - Captured best ask: `79336.01000000`.
  - Captured midpoint candidate: `79336.00500000`.
  - Timestamp candidate: none. `lastUpdateId` is a sequence id, not a time.
  - Standalone orderbook response cannot map to `effectiveAt` without pairing with another timestamped source or an accepted source timestamp rule.
- Candidate symbol/pair: `BTCUSDT` Binance spot market pair. `ETHUSDT` is a later same-pattern candidate.

Analysis:

- Ticker is currently the stronger standalone snapshot candidate because it has `closeTime`.
- Orderbook is stronger for bid/ask/mid price semantics, but it lacks source timestamp evidence.
- Quote/execute may need either ticker `lastPrice`, orderbook best bid/ask/mid with a paired timestamp, or a different Binance endpoint that includes both executable price evidence and a usable timestamp.
- `BTCUSDT` can only be used internally as `CurrencyCode.USD` after an explicit USDT-to-USD-equivalent owner decision, or else true Binance USD quote pair evidence must be required.
- A 30-second crypto freshness policy is plausible only if accepted source timestamps remain fresh under capture cadence; this fixture alone does not prove production freshness.
- Raw payload storage requires Binance terms/retention approval before ingestion.

Still unverified:

- Binance symbol mapping for the project's `Asset` row.
- Whether `lastPrice`, `bid/ask`, or midpoint is canonical for quote/create/execute.
- Whether `closeTime` is accepted as `effectiveAt`.
- Whether another timestamped endpoint is required for orderbook-based pricing.
- USDT-to-USD-equivalent policy.
- Commercial/business terms and raw payload retention permission.

Mapping candidate:

- Internal table: `asset_price_snapshots`.
- `sourceType`: `provider_api`.
- `sourceName`: `binance_ticker` for 24hr ticker, or `binance_orderbook` for depth if paired timestamp policy is accepted.
- `price`: selected Binance ticker/orderbook price field after owner decision.
- `currencyCode`: internal `USD`. Do not add `USDT`.
- `sourceTimestamp`: ticker `closeTime` candidate, or blocked for standalone orderbook.
- `effectiveAt`: selected source timestamp converted to UTC DateTime; standalone orderbook is blocked.
- `capturedAt`: local server receipt time.
- `rawPayloadJson`: sanitized response body only after terms/storage approval.

Current decision:

- Binance BTCUSDT ticker fixture: GO for fixture capture; CONDITIONAL GO for mapping.
- Binance BTCUSDT orderbook fixture: CONDITIONAL GO because response has bid/ask evidence but no timestamp.
- Binance crypto provider implementation: STOP until fixture evidence, timestamp/effectiveAt mapping, sourceType eligibility tests, USDT-to-USD owner decision or Binance USD pair evidence, and terms decision exist.

## 10. Error / Rate Limit / Outage Evidence

Live error fixture status:

- No invalid-symbol, invalid-key, quota, or rate-limit requests were sent because credentials are unavailable and live fixture capture was already blocked.
- Rate-limit exhaustion was not attempted.

Official error/rate-limit evidence:

- `docs/provider-fixtures/provider-error-samples.md` records official-document evidence only.
- Twelve Data support docs state that API credits reset every minute.
- Twelve Data support docs state that HTTP 429 indicates API credits limit reached.
- Twelve Data support docs state paid plans have no daily limits, while Basic daily quota resets at midnight UTC.
- Twelve Data support docs state response headers include `api-credits-used` and `api-credits-left`.
- OANDA public docs confirm API key/trial account is required; exact error response shape is unverified without developer docs or a trial response.

Policy evidence:

- Provider timeout/outage must not insert a row.
- Provider parse failure must not insert a row.
- Provider timestamp missing must not insert a `provider_api` row for quote/execute/live valuation.
- Provider rate limit must not trigger fake/static fallback.
- Existing stale rows may remain for audit, but quote/execute must return stale/unavailable behavior.

Unverified:

- OANDA HTTP status and body for invalid key, invalid pair, quota/rate limit, and malformed request.
- Twelve Data actual JSON error shape for invalid key, invalid symbol, quota, and malformed request under the project account.

## 11. Timestamp Mapping

| Provider | Endpoint | Provider field | Meaning from evidence | Internal `sourceTimestamp` | Internal `effectiveAt` | Status |
|---|---|---|---|---|---|---|
| OANDA | Exchange Rates API, exact endpoint unverified | UTC timestamp field unverified | Public docs say UTC timestamps | Unverified | Use provider UTC timestamp only after live fixture | BLOCKED |
| Twelve Data | `/exchange_rate` | `timestamp` | Unix timestamp of the rate | Convert Unix seconds to UTC DateTime | Same as `sourceTimestamp` | Official-doc candidate; live fixture BLOCKED |
| Twelve Data | `/quote` | `timestamp` | Unix timestamp representing opening candle of specified interval | Candidate | Candidate only after quote semantics decision | Official-doc candidate; live fixture BLOCKED |
| Twelve Data | `/quote` | `last_quote_at` | Unix timestamp of last minute candle | Preferred candidate for latest quote evidence if live fixture confirms | Preferred candidate if accepted | Official-doc candidate; live fixture BLOCKED |
| Twelve Data | WebSocket `/quotes/price` | `timestamp` | Unix timestamp in real-time tick price event | Candidate | Candidate if streaming ingestion is separately approved | Official-doc candidate; streaming design not approved |
| Binance | `/api/v3/ticker/24hr?symbol=BTCUSDT` | `closeTime` | Rolling 24hr ticker close time from fixture; Unix milliseconds | Candidate after owner accepts semantics | Candidate: Unix milliseconds -> UTC DateTime | Captured; CONDITIONAL GO for mapping |
| Binance | `/api/v3/ticker/24hr?symbol=BTCUSDT` | `openTime` | Rolling 24hr ticker window open time from fixture; Unix milliseconds | Not preferred for latest price | Not preferred | Captured; not suitable for latest effectiveAt |
| Binance | `/api/v3/depth?symbol=BTCUSDT&limit=5` | none | Response includes `lastUpdateId`, which is a sequence id, not a timestamp | Blocked standalone | Blocked standalone | Captured; needs paired timestamp or different endpoint |

Timestamp conclusion:

- Binance ticker provides a live `closeTime` timestamp candidate in Unix milliseconds, but implementation is not ready until owner accepts its semantics for `effectiveAt`.
- Binance orderbook does not provide a timestamp in the captured response, so it is blocked as a standalone `provider_api` snapshot source.
- OANDA/Twelve Data timestamp mapping remains blocked by missing credentials and absent live fixtures.

## 12. Rate / Price Field Mapping

| Provider | Endpoint | Provider field | Internal field | Notes | Status |
|---|---|---|---|---|---|
| OANDA | Exchange Rates API | bid/ask/midpoint field unverified | `fx_rate_snapshots.rate` | Owner must choose bid, ask, or midpoint; rate basis must be KRW per 1 USD | BLOCKED |
| Twelve Data | `/exchange_rate` | `rate` | `fx_rate_snapshots.rate` | Direct candidate for USD/KRW | Official-doc candidate; live fixture BLOCKED |
| Twelve Data | `/quote` | `close` | `asset_price_snapshots.price` | Candidate for US stock; market-open semantics require decision | Official-doc candidate; live fixture BLOCKED |
| Binance | `/api/v3/ticker/24hr` | `lastPrice` candidate; `bidPrice`/`askPrice` also present | `asset_price_snapshots.price` | Ticker fixture captured; owner must choose executable/valuation price field | Captured; CONDITIONAL GO for mapping |
| Binance | `/api/v3/depth` | `bids[0][0]`, `asks[0][0]`, calculated midpoint | `asset_price_snapshots.price` | Orderbook fixture captured; bid/ask/mid possible, but standalone effectiveAt is blocked because no timestamp exists | Captured; STOP for standalone ingestion |
| Twelve Data | `/price` | `price` | Not accepted alone | Lacks timestamp evidence; do not use alone for `provider_api` snapshots | STOP for provider_api alone |
| Twelve Data | WebSocket `/quotes/price` | `price` | `asset_price_snapshots.price` | Real-time tick candidate; requires separate streaming ingestion design | Not in Gate C/D implementation scope |

Rate/price conclusion:

- Binance live price/bid/ask fields are proven by fixture, but the canonical field is not approved.
- Twelve Data `/exchange_rate.rate` and `/quote.close` are FX/US stock mapping candidates only.
- Binance ticker/orderbook price mapping remains blocked until owner chooses ticker price versus bid/ask/mid and approves USDT-to-USD policy.
- OANDA rate mapping remains blocked until exact response shape and rate basis are captured.

## 13. SourceType / SourceName Mapping

| Provider use | Internal table | sourceType | sourceName candidate | Status |
|---|---|---|---|---|
| OANDA USD/KRW FX | `fx_rate_snapshots` | `provider_api` | `oanda` | Candidate only |
| Twelve Data USD/KRW FX | `fx_rate_snapshots` | `provider_api` | `twelve_data_exchange_rate` | Candidate only |
| Twelve Data US stock quote | `asset_price_snapshots` | `provider_api` | `twelve_data_quote` | Candidate only |
| Binance crypto ticker | `asset_price_snapshots` | `provider_api` | `binance_ticker` | Fixture captured; candidate only after effectiveAt/price/USDT policy and tests |
| Binance crypto orderbook | `asset_price_snapshots` | `provider_api` | `binance_orderbook` | Fixture captured; standalone ingestion STOP because timestamp is absent |

Implementation note:

- Current code does not yet allow `provider_api` in execute/order/valuation source selection.
- `/fx quote` is currently sourceType-agnostic and must be tightened before provider rows are introduced.
- `official_batch` remains excluded from real-time quote/execute source candidates.

## 14. Freshness Compatibility

| Area | Current/project target | Evidence status | Compatibility result |
|---|---|---|---|
| FX USD/KRW quote/execute | 60 seconds by `effectiveAt` | OANDA public docs mention real-time rates and UTC timestamps, but no live fixture; Twelve Data docs expose `timestamp`, but no live fixture | Not proven |
| Twelve Data USD/KRW | 60 seconds by `effectiveAt` | Official docs expose `timestamp`; pair page exists | Not proven until live timestamp age is measured |
| US stock quote/execute | target 60 seconds during market hours | `/quote` has timestamp candidates and market-open field; no live fixture | Not proven |
| Crypto quote/execute | target 30 seconds | Binance ticker fixture captured with `closeTime`; orderbook fixture captured without timestamp | Partially proven for response shape; freshness not implementation-ready |
| Home live valuation | consistency over silent stale fallback | provider timestamp candidates exist but no fixture | Not proven |
| Settlement | finality/reproducibility over live price | provider_api not accepted as sole final source | Not applicable to provider live fixture |

Freshness conclusion:

- Official documents make mapping plausible for Twelve Data and OANDA in FX/US stock paths, and Binance fixture response shapes are now captured for crypto. No provider path is implementation-ready until source timestamp semantics, sourceType eligibility, terms, and owner decisions are accepted.

## 15. Fixture Inventory

Binance public success fixture JSON files were added. OANDA/Twelve Data fixture files remain absent because credentials were unavailable. Official-document error/rate-limit evidence remains in `provider-error-samples.md`.

| Fixture | Status | Reason |
|---|---|---|
| `docs/provider-fixtures/oanda-usd-krw-sample.json` | Not created | OANDA credentials unavailable |
| `docs/provider-fixtures/twelvedata-usd-krw-exchange-rate-sample.json` | Not created | `TWELVE_DATA_API_KEY` unavailable |
| `docs/provider-fixtures/twelvedata-us-stock-aapl-quote-sample.json` | Not created | `TWELVE_DATA_API_KEY` unavailable |
| `docs/provider-fixtures/binance-btcusdt-ticker-sample.json` | Created | Public Binance 24hr ticker returned HTTP 200 without auth |
| `docs/provider-fixtures/binance-btcusdt-orderbook-sample.json` | Created | Public Binance depth returned HTTP 200 without auth |
| `docs/provider-fixtures/provider-error-samples.md` | Updated | Official-document error/rate-limit evidence plus Binance public success fixture references; no live error calls were attempted |

## Captured Fixture Summary

| Fixture file | Provider | Asset class | Captured? | CapturedAt | Status | Security checked? | Key fields found | Blocking issue |
|---|---|---|---|---|---|---|---|---|
| `docs/provider-fixtures/oanda-usd-krw-sample.json` | OANDA | FX USD/KRW | No | n/a | `BLOCKED` | n/a; file absent | n/a | Credentials unavailable; endpoint/fields unverified |
| `docs/provider-fixtures/twelvedata-usd-krw-exchange-rate-sample.json` | Twelve Data | FX USD/KRW | No | n/a | `BLOCKED` | n/a; file absent | n/a | `TWELVE_DATA_API_KEY` unavailable |
| `docs/provider-fixtures/twelvedata-us-stock-aapl-quote-sample.json` | Twelve Data | US stock | No | n/a | `BLOCKED` | n/a; file absent | n/a | `TWELVE_DATA_API_KEY` unavailable |
| `docs/provider-fixtures/binance-btcusdt-ticker-sample.json` | Binance | Crypto | Yes | `2026-05-14T04:29:33.440Z` | `GO for fixture capture; CONDITIONAL GO for mapping` | Yes | `symbol`, `lastPrice`, `bidPrice`, `askPrice`, `openTime`, `closeTime` | USDT-to-USD decision, price-field decision, closeTime semantics, terms |
| `docs/provider-fixtures/binance-btcusdt-orderbook-sample.json` | Binance | Crypto | Yes | `2026-05-14T04:29:33.440Z` | `CONDITIONAL GO for fixture capture; STOP standalone ingestion` | Yes | `lastUpdateId`, best bid, best ask, quantity levels | No source timestamp; USDT-to-USD decision, bid/ask/mid decision, terms |
| `docs/provider-fixtures/provider-error-samples.md` | OANDA / Twelve Data | Error/rate-limit | Official docs only | n/a | Documented | Yes | Twelve Data 429/credits headers; OANDA error shape unverified | No live credentials for actual error fixture |

## Live Mapping Result

| Provider | Endpoint | Internal table | sourceName | price/rate field | timestamp field | effectiveAt mapping | capturedAt mapping | Freshness compatible? | Implementation decision |
|---|---|---|---|---|---|---|---|---|---|
| OANDA | Exact Exchange Rates API endpoint unverified | `fx_rate_snapshots` | `oanda` | Unverified bid/ask/midpoint | Unverified UTC timestamp | Provider timestamp if captured and accepted | Server receipt time | Not proven | `BLOCKED` |
| Twelve Data | `/exchange_rate?symbol=USD/KRW` | `fx_rate_snapshots` | `twelve_data_exchange_rate` | `rate` candidate | `timestamp` candidate | Unix seconds -> UTC DateTime | Server receipt time | Not proven | `BLOCKED` |
| Twelve Data | `/quote?symbol=AAPL` | `asset_price_snapshots` | `twelve_data_quote` | `close` candidate | `last_quote_at` preferred candidate; `timestamp` fallback candidate | Selected Unix seconds -> UTC DateTime | Server receipt time | Not proven | `BLOCKED` |
| Binance | `/api/v3/ticker/24hr?symbol=BTCUSDT` | `asset_price_snapshots` | `binance_ticker` | `lastPrice` candidate; `bidPrice`/`askPrice` present | `closeTime` candidate, Unix milliseconds | Conditional: `closeTime` -> UTC DateTime if accepted | Server receipt time | Not proven; requires age measurement and semantics decision | `CONDITIONAL GO for mapping; STOP for ingestion` |
| Binance | `/api/v3/depth?symbol=BTCUSDT&limit=5` | `asset_price_snapshots` | `binance_orderbook` | best bid/ask or midpoint candidate | none; `lastUpdateId` is not a timestamp | Blocked standalone | Server receipt time | Not proven | `STOP standalone ingestion; possible only with paired timestamp policy` |

## Secret Redaction Review

| File | API key present? | Authorization present? | Account id present? | Token/secret present? | Personal data present? | Result |
|---|---|---|---|---|---|---|
| `docs/provider-evidence-capture.md` | No actual value; env names and `<redacted>` only | No actual header; policy wording only | No actual value; env names and policy wording only | No actual value; policy wording only | No | PASS |
| `docs/provider-fixtures/provider-error-samples.md` | No actual value; `<redacted>` only | No actual header; policy wording only | No actual value | No actual value; policy wording only | No | PASS |
| `docs/provider-fixtures/oanda-usd-krw-sample.json` | n/a | n/a | n/a | n/a | n/a | File not created |
| `docs/provider-fixtures/twelvedata-usd-krw-exchange-rate-sample.json` | n/a | n/a | n/a | n/a | n/a | File not created |
| `docs/provider-fixtures/twelvedata-us-stock-aapl-quote-sample.json` | n/a | n/a | n/a | n/a | n/a | File not created |
| `docs/provider-fixtures/binance-btcusdt-ticker-sample.json` | No | No | No | No | No | PASS |
| `docs/provider-fixtures/binance-btcusdt-orderbook-sample.json` | No | No | No | No | No | PASS |

## 16. Security Review of Captured Fixtures

Two captured Binance public JSON fixture files exist.

Security status:

- API keys were not printed.
- Authorization headers were not printed.
- Account ids were not printed.
- Binance raw public market-data responses were stored only in the two fixture JSON files.
- No personal account or email information was stored.
- No paid account identifier was stored.
- No provider secret/token/account id appears in this document.
- OANDA and Twelve Data fixture files were not created because credentials were unavailable.

If future fixtures are captured, each fixture must confirm:

- `apiKeyRemoved: true`.
- `accountIdRemoved: true`.
- no Authorization header.
- no API key query parameter.
- no secret/token/account id.
- raw payload storage allowed or explicitly marked terms-unverified.

## 17. Gate C/D STOP / GO Decision

| Area | Decision | Reason |
|---|---|---|
| OANDA USD/KRW live fixture | BLOCKED | OANDA credentials unavailable; exact endpoint/fields/timestamp/rate basis remain unverified |
| Twelve Data USD/KRW live fixture | BLOCKED | `TWELVE_DATA_API_KEY` unavailable; official docs show mapping candidate but no live fixture |
| Twelve Data US stock live fixture | BLOCKED | `TWELVE_DATA_API_KEY` unavailable; official docs show `/quote` mapping candidate but no live fixture |
| Binance BTCUSDT ticker fixture | GO for fixture capture; CONDITIONAL GO for mapping | Public ticker returned HTTP 200 and exposes `lastPrice`, `bidPrice`, `askPrice`, `openTime`, `closeTime`; USDT-to-USD and `closeTime` semantics remain open |
| Binance BTCUSDT orderbook fixture | CONDITIONAL GO | Public depth returned HTTP 200 and exposes bid/ask levels, but no source timestamp exists in the response |
| Binance effectiveAt mapping | STOP | Ticker `closeTime` requires owner acceptance; orderbook standalone mapping is blocked |
| Binance USDT-to-USD policy | OWNER_DECISION_REQUIRED | Internal `CurrencyCode` remains USD and `CurrencyCode.USDT` must not be added |
| Binance provider ingestion implementation | STOP | Fixture exists, but sourceType eligibility tests, effectiveAt mapping, price-field decision, USDT-to-USD decision, and terms approval are missing |
| FX provider ingestion implementation | BLOCKED | Live fixture, timestamp mapping, sourceType eligibility, rate basis, and terms/account decisions are missing |
| Asset price provider ingestion implementation | BLOCKED | Live US stock fixtures, Binance mapping decisions, symbol/currency mapping, timestamp decision, USDT-to-USD decision, and terms/account decisions are missing; KRX quote/execute remains blocked |
| Scheduler/batch foundation | CONDITIONAL GO for docs-only Gate E audit; STOP for implementation | Scheduler design can be audited, but provider polling jobs cannot be implemented without accepted provider evidence |
| Settlement preimplementation audit | CONDITIONAL GO for docs-only audit; STOP for implementation | Settlement audit can discuss final evidence source, but implementation remains blocked until final valuation source and scheduler/provider path are accepted |

## 18. Required Implementation Tests

FX provider ingestion tests:

- OANDA fixture mapping.
- Twelve Data fallback fixture mapping.
- timestamp -> `effectiveAt`.
- `capturedAt` assignment.
- rate basis fixed.
- stale response rejected.
- missing timestamp rejected.
- duplicate snapshot idempotency.
- provider error no insert.
- rate limit no fake fallback.
- sourceType/sourceName correctness.
- quote/execute source eligibility.

Asset provider ingestion tests:

- US stock fixture mapping.
- Binance crypto fixture mapping.
- market/currency match.
- symbol mapping.
- timestamp -> `effectiveAt`.
- market open/closed behavior.
- delayed/EOD rejection where required.
- stale response rejected.
- missing timestamp rejected.
- duplicate snapshot idempotency.
- no fake/static/sample rows.
- manual fallback not silently preferred.

Additional evidence tests before implementation GO:

- fixture redaction test for stored raw payload.
- no secret in fixture/log output.
- provider outage does not insert rows.
- invalid provider body parse failure does not insert rows.
- `official_batch` cannot be selected for real-time execute.
- `/fx quote` sourceType eligibility after provider rows are introduced.

## 19. Open Questions

- Which OANDA endpoint path is the canonical Exchange Rates API path for USD/KRW?
- Does OANDA Exchange Rates API require only an API key for the chosen endpoint, or also an account id?
- What is the exact OANDA endpoint path for USD/KRW real-time rates?
- Should OANDA `rate` map from bid, ask, midpoint, or side-aware bid/ask?
- Can OANDA raw payloads be stored in `rawPayloadJson` under the chosen contract?
- Is Binance `BTCUSDT` acceptable as USD-equivalent internally, or must Binance USD quote pair evidence be required?
- Should US stock `effectiveAt` use `/quote.last_quote_at` or `/quote.timestamp`?
- Is delayed data acceptable for any virtual trading UX path?
- Is Twelve Data Basic enough for fixture capture, and which business plan is required for production?
- What provider or official source will cover KRX if domestic stock trading remains in MVP?

## 20. Next Gate Recommendation

Recommended next prompt title:

- `Gate C/D Provider Mapping Decision - Binance USDT-to-USD Policy and SourceType Eligibility`

Recommended scope:

- Docs/fixture-only.
- Decide whether Binance `BTCUSDT` USDT quote can be treated as USD-equivalent internally, or require true Binance USD quote pair evidence.
- Decide canonical crypto price evidence: ticker `lastPrice`, ticker bid/ask, orderbook best bid/ask, midpoint, or a paired source.
- Decide whether ticker `closeTime` is acceptable as `effectiveAt`; if not, identify a timestamped Binance endpoint or pair orderbook data with accepted timestamp evidence.
- Define sourceType/sourceName eligibility tests before any provider ingestion implementation.
- Keep OANDA/Twelve Data fixture completion blocked until credentials are available.
- Do not implement provider clients, ingestion, scheduler, DB writes, schema changes, seed changes, package changes, source code, or tests.

Implementation gates remain closed until live fixtures and owner decisions are accepted.

## Provider Fixture Matrix

| Provider | Asset class | Endpoint | Symbol/pair | Fixture captured? | Credential required? | Timestamp field | Price/rate field | Market/open field | Rate limit evidence | Current status |
|---|---|---|---|---|---|---|---|---|---|---|
| OANDA | FX | Exchange Rates API exact endpoint unverified | USD/KRW | No | Yes | UTC timestamp field unverified | bid/ask/midpoint unverified | n/a | Plan docs: Lite 100,000 quotes/month; trial key | BLOCKED |
| Twelve Data | FX | `/exchange_rate` | `USD/KRW` | No | Yes | `timestamp` | `rate` | n/a | Credits reset per minute; 429 on credit exhaustion | BLOCKED |
| Twelve Data | US stock | `/quote` | `AAPL` or `MSFT` | No | Yes | `timestamp`, `last_quote_at` | `close` candidate | `is_market_open` | Credits reset per minute; endpoint cost documented in docs | BLOCKED |
| Binance | Crypto | `/api/v3/ticker/24hr` | `BTCUSDT` | Yes | No private key | `openTime`, `closeTime` Unix milliseconds | `lastPrice`, `bidPrice`, `askPrice`, `weightedAvgPrice` | 24/7 spot market | Public response headers include Binance weight headers; no rate-limit triggering attempted | GO for fixture capture; STOP for ingestion |
| Binance | Crypto | `/api/v3/depth` | `BTCUSDT` | Yes | No private key | none; `lastUpdateId` is not a timestamp | best bid, best ask, calculable midpoint | 24/7 spot market | Public response headers include Binance weight headers; no rate-limit triggering attempted | CONDITIONAL GO for fixture capture; STOP standalone ingestion |

## Internal Snapshot Mapping Candidate

| Provider | Asset class | Internal table | sourceType | sourceName | rate/price mapping | currency mapping | sourceTimestamp mapping | effectiveAt mapping | capturedAt mapping | rawPayloadJson storage | Open blockers |
|---|---|---|---|---|---|---|---|---|---|---|---|
| OANDA | FX | `fx_rate_snapshots` | `provider_api` | `oanda` | bid/ask/midpoint after owner decision | base `USD`, quote `KRW` | OANDA timestamp field unverified | same as source timestamp if confirmed | local receipt time | sanitized raw response if terms allow | credentials, endpoint, fields, rate basis, terms |
| Twelve Data | FX | `fx_rate_snapshots` | `provider_api` | `twelve_data_exchange_rate` | `/exchange_rate.rate` | symbol base/quote `USD/KRW` | `/exchange_rate.timestamp` | Unix seconds -> UTC DateTime | local receipt time | sanitized raw response if terms allow | credentials, live fixture, timestamp freshness, terms |
| Twelve Data | US stock | `asset_price_snapshots` | `provider_api` | `twelve_data_quote` | `/quote.close` candidate | `/quote.currency` expected `USD` | `/quote.last_quote_at` preferred candidate, `/quote.timestamp` fallback candidate | selected source timestamp -> UTC DateTime | local receipt time | sanitized raw response if terms allow | credentials, field semantics, market closed behavior, terms |
| Binance | Crypto | `asset_price_snapshots` | `provider_api` | `binance_ticker` | `lastPrice` candidate; bid/ask also present | internal `USD`; do not add `USDT` | ticker `closeTime` candidate | `closeTime` Unix milliseconds -> UTC DateTime if accepted | local receipt time | sanitized raw response if terms allow | USDT-to-USD decision or USD pair evidence, price-field decision, closeTime semantics, terms |
| Binance | Crypto | `asset_price_snapshots` | `provider_api` | `binance_orderbook` | best bid/ask or midpoint candidate | internal `USD`; do not add `USDT` | none in standalone response | blocked standalone | local receipt time | sanitized raw response if terms allow | paired timestamp policy, USDT-to-USD decision, bid/ask/mid decision, terms |

## Implementation Readiness Matrix

| Area | Evidence status | Terms/account status | Timestamp status | Freshness status | Test requirements | Decision: GO / CONDITIONAL GO / STOP / BLOCKED | Reason |
|---|---|---|---|---|---|---|---|
| OANDA USD/KRW fixture capture | No live fixture | No local credentials; contract not approved | Exact field unverified | Not measured | fixture mapping, redaction, source timestamp conversion | BLOCKED | Cannot capture without credentials |
| Twelve Data USD/KRW fixture capture | No live fixture | No local credentials; business terms not approved | Official `timestamp` candidate | Not measured | `/exchange_rate` mapping, 60-second age check | BLOCKED | Cannot capture without API key |
| Twelve Data US stock fixture capture | No live fixture | No local credentials; plan/terms not approved | Official `timestamp`/`last_quote_at` candidates | Not measured | `/quote` mapping, market-open behavior | BLOCKED | Cannot capture without API key |
| Binance BTCUSDT ticker fixture capture | Captured HTTP 200 public fixture | Public endpoint; terms/raw-payload storage not approved | `closeTime` candidate captured | Not measured for production cadence | ticker mapping, USDT-to-USD decision, exchange/symbol mapping | GO for fixture capture; CONDITIONAL GO for mapping | Response shape captured, but owner decisions remain |
| Binance BTCUSDT orderbook fixture capture | Captured HTTP 200 public fixture | Public endpoint; terms/raw-payload storage not approved | No source timestamp in response | Not measurable standalone | orderbook mapping, paired timestamp policy, USDT-to-USD decision | CONDITIONAL GO for fixture capture; STOP standalone ingestion | Bid/ask evidence exists, but no effectiveAt source timestamp |
| FX provider ingestion implementation | Official docs only | No owner approval | Not live-proven | Not live-proven | full provider ingestion test matrix | BLOCKED | Live fixture is required before implementation GO |
| Asset price provider ingestion implementation | Official docs/policy only | No owner approval | Not live-proven | Not live-proven | US/Binance crypto provider test matrix | BLOCKED | Live fixtures, USDT-to-USD decision, and KRX decision missing |
| Scheduler/batch foundation | Docs policy exists | Provider account path missing | Provider timestamp not live-proven | Provider polling not live-proven | lock/idempotency/retry/outage tests | CONDITIONAL GO for audit only | Scheduler implementation must wait |
| Settlement preimplementation audit | Docs policy exists | Final evidence source undecided | Settlement timestamp source undecided | Finality source undecided | settlement audit test matrix | CONDITIONAL GO for docs audit only | Implementation remains STOP |
