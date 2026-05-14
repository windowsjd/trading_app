# Provider Evidence Capture

## 1. Purpose

This document records Gate C/D provider evidence capture before any provider ingestion implementation.

The goal is to determine whether OANDA USD/KRW, Twelve Data USD/KRW/US stock, and Binance crypto responses can be mapped safely to the current internal FX and asset price snapshot models.

Evidence capture result as of 2026-05-13: `BLOCKED` for live fixtures because credentials were unavailable in the local environment.

Implementation readiness: not ready for provider ingestion implementation. Official documents support mapping candidates, but live response fixtures, exact OANDA endpoint fields, timestamp freshness measurements, and owner terms decisions are missing.

Remaining blockers: provider credentials where required, live response fixtures, exact timestamp freshness measurement, rate/price field confirmation, OANDA rate basis decision, Binance USDT-to-USD-equivalent owner decision or Binance USD quote pair evidence, commercial/business terms approval, and sourceType eligibility implementation policy.

Required owner decisions: provider account/plan, commercial/external display terms, OANDA bid/ask/mid policy, Twelve Data endpoint choice for US stock, Binance USDT-to-USD-equivalent policy, KRX scope, and whether delayed data is acceptable anywhere in the product.

Recommended next prompt title: `Gate C Binance Crypto Fixture Capture + OANDA/Twelve Data Fixture Capture`.

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

Checked date: 2026-05-13.

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
- Binance crypto fixture: not captured in this task. Public `BTCUSDT` ticker/orderbook fixture capture is next Gate C/D work and requires no private key, but this task intentionally makes no live call.

No live JSON fixture files were created in this task. `docs/provider-fixtures/provider-error-samples.md` was created from official-document error/rate-limit evidence only.

## 5. Official Documents Rechecked

Checked date: 2026-05-13.

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
| Binance | Project policy target; official/live fixture evidence deferred | Ticker/price and orderbook public market data candidates for `BTCUSDT` | Official/live fixture evidence not captured in this task; next Gate C/D fixture target |
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

- Binance crypto live fixture was not captured in this task.
- No request was sent.
- No fixture file was created.

Official-document evidence:

- MVP provider target: Binance.
- MVP settlement currency: USD.
- Candidate fixture file A: `docs/provider-fixtures/binance-btcusdt-ticker-sample.json`.
- Candidate fixture file B: `docs/provider-fixtures/binance-btcusdt-orderbook-sample.json`.
- Candidate symbol/pair: `BTCUSDT` Binance spot market pair. `ETHUSDT` is a later same-pattern candidate.
- Fixture capture should use public market data and no private key.

Unverified items:

- Actual Binance ticker/orderbook response fixture.
- Exact response timestamp fields and which field maps to `effectiveAt`.
- Whether ticker price, orderbook mid/bid/ask, or another price field is canonical for quote/execute.
- Whether `BTCUSDT` can be normalized as USD-equivalent internally.
- Whether Binance USD quote pairs must be required instead of USDT quote pairs.
- Binance symbol mapping for the project's `Asset` row.
- Whether timestamp freshness can satisfy the 30-second crypto quote/execute target.
- Commercial/business terms.

Mapping candidate:

- Internal table: `asset_price_snapshots`.
- `sourceType`: `provider_api`.
- `sourceName`: `binance_ticker` or `binance_orderbook`, pending fixture decision.
- `price`: selected Binance ticker/orderbook price field after owner decision.
- `currencyCode`: internal `USD`. Do not add `USDT`.
- `sourceTimestamp`: selected Binance timestamp field from fixture evidence.
- `effectiveAt`: selected source timestamp converted to UTC DateTime.
- `capturedAt`: local server receipt time.
- `rawPayloadJson`: sanitized response body only after terms/storage approval.

Current decision:

- Binance crypto fixture capture: CONDITIONAL GO for next Gate C/D fixture task only.
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

Timestamp conclusion:

- No provider timestamp mapping is implementation-ready because no live fixtures were captured.
- Twelve Data has the strongest official-doc timestamp shape.
- OANDA remains blocked at exact field mapping.

## 12. Rate / Price Field Mapping

| Provider | Endpoint | Provider field | Internal field | Notes | Status |
|---|---|---|---|---|---|
| OANDA | Exchange Rates API | bid/ask/midpoint field unverified | `fx_rate_snapshots.rate` | Owner must choose bid, ask, or midpoint; rate basis must be KRW per 1 USD | BLOCKED |
| Twelve Data | `/exchange_rate` | `rate` | `fx_rate_snapshots.rate` | Direct candidate for USD/KRW | Official-doc candidate; live fixture BLOCKED |
| Twelve Data | `/quote` | `close` | `asset_price_snapshots.price` | Candidate for US stock; market-open semantics require decision | Official-doc candidate; live fixture BLOCKED |
| Binance | public ticker/orderbook | fixture-dependent | `asset_price_snapshots.price` | Candidate for Binance USD-settled crypto; USDT-to-USD policy remains open | Fixture capture pending |
| Twelve Data | `/price` | `price` | Not accepted alone | Lacks timestamp evidence; do not use alone for `provider_api` snapshots | STOP for provider_api alone |
| Twelve Data | WebSocket `/quotes/price` | `price` | `asset_price_snapshots.price` | Real-time tick candidate; requires separate streaming ingestion design | Not in Gate C/D implementation scope |

Rate/price conclusion:

- No live rate/price mapping is proven.
- Twelve Data `/exchange_rate.rate` and `/quote.close` are FX/US stock mapping candidates only.
- Binance ticker/orderbook price mapping remains blocked until fixture evidence and owner decision.
- OANDA rate mapping remains blocked until exact response shape and rate basis are captured.

## 13. SourceType / SourceName Mapping

| Provider use | Internal table | sourceType | sourceName candidate | Status |
|---|---|---|---|---|
| OANDA USD/KRW FX | `fx_rate_snapshots` | `provider_api` | `oanda` | Candidate only |
| Twelve Data USD/KRW FX | `fx_rate_snapshots` | `provider_api` | `twelve_data_exchange_rate` | Candidate only |
| Twelve Data US stock quote | `asset_price_snapshots` | `provider_api` | `twelve_data_quote` | Candidate only |
| Binance crypto ticker | `asset_price_snapshots` | `provider_api` | `binance_ticker` | Candidate only after fixture/owner decision |
| Binance crypto orderbook | `asset_price_snapshots` | `provider_api` | `binance_orderbook` | Candidate only after fixture/owner decision |

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
| Crypto quote/execute | target 30 seconds | Binance ticker/orderbook fixture target exists; no fixture captured | Not proven |
| Home live valuation | consistency over silent stale fallback | provider timestamp candidates exist but no fixture | Not proven |
| Settlement | finality/reproducibility over live price | provider_api not accepted as sole final source | Not applicable to provider live fixture |

Freshness conclusion:

- Official documents make mapping plausible for Twelve Data and OANDA in FX/US stock paths, and Binance is the fixed MVP crypto target, but no provider path is implementation-ready without fixture timestamps.

## 15. Fixture Inventory

No live provider JSON fixture files were added. Official-document error/rate-limit evidence was added.

| Fixture | Status | Reason |
|---|---|---|
| `docs/provider-fixtures/oanda-usd-krw-sample.json` | Not created | OANDA credentials unavailable |
| `docs/provider-fixtures/twelvedata-usd-krw-exchange-rate-sample.json` | Not created | `TWELVE_DATA_API_KEY` unavailable |
| `docs/provider-fixtures/twelvedata-us-stock-quote-sample.json` | Not created | `TWELVE_DATA_API_KEY` unavailable |
| `docs/provider-fixtures/binance-btcusdt-ticker-sample.json` | Not created | Deferred to next Gate C/D fixture task; no live call in this task |
| `docs/provider-fixtures/binance-btcusdt-orderbook-sample.json` | Not created | Deferred to next Gate C/D fixture task; no live call in this task |
| `docs/provider-fixtures/provider-error-samples.md` | Created | Official-document error/rate-limit evidence only; no live error calls were attempted |

## Captured Fixture Summary

| Fixture file | Provider | Asset class | Captured? | CapturedAt | Status | Security checked? | Key fields found | Blocking issue |
|---|---|---|---|---|---|---|---|---|
| `docs/provider-fixtures/oanda-usd-krw-sample.json` | OANDA | FX USD/KRW | No | n/a | `BLOCKED` | n/a; file absent | n/a | Credentials unavailable; endpoint/fields unverified |
| `docs/provider-fixtures/twelvedata-usd-krw-exchange-rate-sample.json` | Twelve Data | FX USD/KRW | No | n/a | `BLOCKED` | n/a; file absent | n/a | `TWELVE_DATA_API_KEY` unavailable |
| `docs/provider-fixtures/twelvedata-us-stock-quote-sample.json` | Twelve Data | US stock | No | n/a | `BLOCKED` | n/a; file absent | n/a | `TWELVE_DATA_API_KEY` unavailable |
| `docs/provider-fixtures/binance-btcusdt-ticker-sample.json` | Binance | Crypto | No | n/a | `CONDITIONAL GO next gate` | n/a; file absent | n/a | Fixture capture deferred; USDT-to-USD decision open |
| `docs/provider-fixtures/binance-btcusdt-orderbook-sample.json` | Binance | Crypto | No | n/a | `CONDITIONAL GO next gate` | n/a; file absent | n/a | Fixture capture deferred; price-field decision open |
| `docs/provider-fixtures/provider-error-samples.md` | OANDA / Twelve Data | Error/rate-limit | Official docs only | n/a | Documented | Yes | Twelve Data 429/credits headers; OANDA error shape unverified | No live credentials for actual error fixture |

## Live Mapping Result

| Provider | Endpoint | Internal table | sourceName | price/rate field | timestamp field | effectiveAt mapping | capturedAt mapping | Freshness compatible? | Implementation decision |
|---|---|---|---|---|---|---|---|---|---|
| OANDA | Exact Exchange Rates API endpoint unverified | `fx_rate_snapshots` | `oanda` | Unverified bid/ask/midpoint | Unverified UTC timestamp | Provider timestamp if captured and accepted | Server receipt time | Not proven | `BLOCKED` |
| Twelve Data | `/exchange_rate?symbol=USD/KRW` | `fx_rate_snapshots` | `twelve_data_exchange_rate` | `rate` candidate | `timestamp` candidate | Unix seconds -> UTC DateTime | Server receipt time | Not proven | `BLOCKED` |
| Twelve Data | `/quote?symbol=AAPL` | `asset_price_snapshots` | `twelve_data_quote` | `close` candidate | `last_quote_at` preferred candidate; `timestamp` fallback candidate | Selected Unix seconds -> UTC DateTime | Server receipt time | Not proven | `BLOCKED` |
| Binance | `BTCUSDT` ticker | `asset_price_snapshots` | `binance_ticker` | fixture-dependent | fixture-dependent | Selected timestamp -> UTC DateTime | Server receipt time | Not proven | `CONDITIONAL GO for fixture capture; STOP for ingestion` |
| Binance | `BTCUSDT` orderbook | `asset_price_snapshots` | `binance_orderbook` | fixture-dependent bid/ask/mid decision | fixture-dependent | Selected timestamp -> UTC DateTime | Server receipt time | Not proven | `CONDITIONAL GO for fixture capture; STOP for ingestion` |

## Secret Redaction Review

| File | API key present? | Authorization present? | Account id present? | Token/secret present? | Personal data present? | Result |
|---|---|---|---|---|---|---|
| `docs/provider-evidence-capture.md` | No actual value; env names and `<redacted>` only | No actual header; policy wording only | No actual value; env names and policy wording only | No actual value; policy wording only | No | PASS |
| `docs/provider-fixtures/provider-error-samples.md` | No actual value; `<redacted>` only | No actual header; policy wording only | No actual value | No actual value; policy wording only | No | PASS |
| `docs/provider-fixtures/oanda-usd-krw-sample.json` | n/a | n/a | n/a | n/a | n/a | File not created |
| `docs/provider-fixtures/twelvedata-usd-krw-exchange-rate-sample.json` | n/a | n/a | n/a | n/a | n/a | File not created |
| `docs/provider-fixtures/twelvedata-us-stock-quote-sample.json` | n/a | n/a | n/a | n/a | n/a | File not created |
| `docs/provider-fixtures/binance-btcusdt-ticker-sample.json` | n/a | n/a | n/a | n/a | n/a | File not created |
| `docs/provider-fixtures/binance-btcusdt-orderbook-sample.json` | n/a | n/a | n/a | n/a | n/a | File not created |

## 16. Security Review of Captured Fixtures

No captured provider JSON fixture files exist.

Security status:

- API keys were not printed.
- Authorization headers were not printed.
- Account ids were not printed.
- No raw provider response was stored.
- No personal account or email information was stored.
- No paid account identifier was stored.
- No provider secret/token/account id appears in this document.

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
| Binance crypto fixture capture | CONDITIONAL GO | Public fixture capture is the next task; no live call or fixture file was created here; USDT-to-USD decision remains open |
| FX provider ingestion implementation | BLOCKED | Live fixture, timestamp mapping, sourceType eligibility, rate basis, and terms/account decisions are missing |
| Asset price provider ingestion implementation | BLOCKED | Live US stock fixtures, Binance crypto fixtures, symbol/currency mapping, timestamp decision, USDT-to-USD decision, and terms/account decisions are missing; KRX quote/execute remains blocked |
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

- `Gate C Binance Crypto Fixture Capture + OANDA/Twelve Data Fixture Capture`

Recommended scope:

- Docs/fixture-only.
- Use environment variables only for credentialed providers; Binance public crypto fixture capture must not require private key material.
- Capture one minimal live response per target:
  - OANDA USD/KRW.
  - Twelve Data USD/KRW `/exchange_rate`.
  - Twelve Data AAPL or MSFT `/quote`.
  - Binance BTCUSDT ticker sample.
  - Binance BTCUSDT orderbook sample.
- Save sanitized fixture JSON only if provider terms allow storage or mark storage terms as unverified.
- Do not implement provider clients, ingestion, scheduler, DB writes, schema changes, seed changes, package changes, source code, or tests.

Implementation gates remain closed until live fixtures and owner decisions are accepted.

## Provider Fixture Matrix

| Provider | Asset class | Endpoint | Symbol/pair | Fixture captured? | Credential required? | Timestamp field | Price/rate field | Market/open field | Rate limit evidence | Current status |
|---|---|---|---|---|---|---|---|---|---|---|
| OANDA | FX | Exchange Rates API exact endpoint unverified | USD/KRW | No | Yes | UTC timestamp field unverified | bid/ask/midpoint unverified | n/a | Plan docs: Lite 100,000 quotes/month; trial key | BLOCKED |
| Twelve Data | FX | `/exchange_rate` | `USD/KRW` | No | Yes | `timestamp` | `rate` | n/a | Credits reset per minute; 429 on credit exhaustion | BLOCKED |
| Twelve Data | US stock | `/quote` | `AAPL` or `MSFT` | No | Yes | `timestamp`, `last_quote_at` | `close` candidate | `is_market_open` | Credits reset per minute; endpoint cost documented in docs | BLOCKED |
| Binance | Crypto | Public ticker and orderbook | `BTCUSDT` | No | No private key | Fixture-dependent | Fixture-dependent ticker price or orderbook bid/ask/mid | 24/7 spot market; fixture evidence pending | Public market data; live fixture not captured here | CONDITIONAL GO for fixture capture; STOP for ingestion |

## Internal Snapshot Mapping Candidate

| Provider | Asset class | Internal table | sourceType | sourceName | rate/price mapping | currency mapping | sourceTimestamp mapping | effectiveAt mapping | capturedAt mapping | rawPayloadJson storage | Open blockers |
|---|---|---|---|---|---|---|---|---|---|---|---|
| OANDA | FX | `fx_rate_snapshots` | `provider_api` | `oanda` | bid/ask/midpoint after owner decision | base `USD`, quote `KRW` | OANDA timestamp field unverified | same as source timestamp if confirmed | local receipt time | sanitized raw response if terms allow | credentials, endpoint, fields, rate basis, terms |
| Twelve Data | FX | `fx_rate_snapshots` | `provider_api` | `twelve_data_exchange_rate` | `/exchange_rate.rate` | symbol base/quote `USD/KRW` | `/exchange_rate.timestamp` | Unix seconds -> UTC DateTime | local receipt time | sanitized raw response if terms allow | credentials, live fixture, timestamp freshness, terms |
| Twelve Data | US stock | `asset_price_snapshots` | `provider_api` | `twelve_data_quote` | `/quote.close` candidate | `/quote.currency` expected `USD` | `/quote.last_quote_at` preferred candidate, `/quote.timestamp` fallback candidate | selected source timestamp -> UTC DateTime | local receipt time | sanitized raw response if terms allow | credentials, field semantics, market closed behavior, terms |
| Binance | Crypto | `asset_price_snapshots` | `provider_api` | `binance_ticker` or `binance_orderbook` | selected ticker/orderbook price after owner decision | internal `USD`; do not add `USDT` | selected fixture timestamp field | selected source timestamp -> UTC DateTime | local receipt time | sanitized raw response if terms allow | fixture capture, USDT-to-USD decision or USD pair evidence, terms |

## Implementation Readiness Matrix

| Area | Evidence status | Terms/account status | Timestamp status | Freshness status | Test requirements | Decision: GO / CONDITIONAL GO / STOP / BLOCKED | Reason |
|---|---|---|---|---|---|---|---|
| OANDA USD/KRW fixture capture | No live fixture | No local credentials; contract not approved | Exact field unverified | Not measured | fixture mapping, redaction, source timestamp conversion | BLOCKED | Cannot capture without credentials |
| Twelve Data USD/KRW fixture capture | No live fixture | No local credentials; business terms not approved | Official `timestamp` candidate | Not measured | `/exchange_rate` mapping, 60-second age check | BLOCKED | Cannot capture without API key |
| Twelve Data US stock fixture capture | No live fixture | No local credentials; plan/terms not approved | Official `timestamp`/`last_quote_at` candidates | Not measured | `/quote` mapping, market-open behavior | BLOCKED | Cannot capture without API key |
| Binance crypto fixture capture | No live fixture | Public market data target; terms not approved | Fixture timestamp unverified | Not measured | ticker/orderbook mapping, USDT-to-USD decision, exchange/symbol mapping | CONDITIONAL GO | Fixture capture is next, but was intentionally not done in this task |
| FX provider ingestion implementation | Official docs only | No owner approval | Not live-proven | Not live-proven | full provider ingestion test matrix | BLOCKED | Live fixture is required before implementation GO |
| Asset price provider ingestion implementation | Official docs/policy only | No owner approval | Not live-proven | Not live-proven | US/Binance crypto provider test matrix | BLOCKED | Live fixtures, USDT-to-USD decision, and KRX decision missing |
| Scheduler/batch foundation | Docs policy exists | Provider account path missing | Provider timestamp not live-proven | Provider polling not live-proven | lock/idempotency/retry/outage tests | CONDITIONAL GO for audit only | Scheduler implementation must wait |
| Settlement preimplementation audit | Docs policy exists | Final evidence source undecided | Settlement timestamp source undecided | Finality source undecided | settlement audit test matrix | CONDITIONAL GO for docs audit only | Implementation remains STOP |
