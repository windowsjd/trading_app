# Provider Evidence Capture

## 1. Purpose

This document records Gate C/D provider evidence capture before any provider ingestion implementation.

The goal is to determine whether OANDA USD/KRW and Twelve Data USD/KRW, US stock, and crypto responses can be mapped safely to the current internal FX and asset price snapshot models.

Evidence capture result: BLOCKED for live fixtures because credentials were unavailable in the local environment.

Implementation readiness: not ready for provider ingestion implementation. Official documents support mapping candidates, but live response fixtures and owner terms decisions are missing.

Remaining blockers: provider credentials, live response fixtures, exact timestamp freshness measurement, rate/price field confirmation, OANDA rate basis decision, commercial/business terms approval, and sourceType eligibility implementation policy.

Required owner decisions: provider account/plan, commercial/external display terms, OANDA bid/ask/mid policy, Twelve Data endpoint choice for US stock/crypto, KRX scope, and whether delayed data is acceptable anywhere in the product.

Recommended next prompt title: `Gate C/D Live Provider Fixture Capture - Provide OANDA and Twelve Data Credentials`.

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
- `/fx execute` allows only `admin_manual` USD/KRW snapshots and applies the same 60-second freshness rule.
- Order quote/create/execute asset prices use `admin_manual` only.
- Portfolio valuation uses `admin_manual` asset prices and approved fresh `admin_manual` USD/KRW.
- Ranking reads existing `season_rankings`; it does not fetch prices.

Current timestamp policy:

- `effectiveAt`: market-data validity time; provider timestamp must map here for `provider_api`.
- `capturedAt`: our server response receipt or admin save time.
- `createdAt`: DB row creation time; tie-breaker only.

## 4. Environment / Credentials Status

Checked date: 2026-05-12.

Credential presence was checked without printing values.

| Credential/env | Status | Effect |
|---|---|---|
| `OANDA_API_KEY` | unset | OANDA live fixture BLOCKED |
| `OANDA_ACCOUNT_ID` | unset | OANDA account-bound request evidence BLOCKED if required |
| `OANDA_ACCOUNT` | unset | OANDA account-bound request evidence BLOCKED if required |
| `OANDA_EXCHANGE_RATES_API_KEY` | unset | OANDA live fixture BLOCKED |
| `TWELVE_DATA_API_KEY` | unset | Twelve Data live fixtures BLOCKED |

No live provider API calls were attempted because the required credentials were unavailable.

No fixture files were created in this task.

## 5. Official Documents Rechecked

Checked date: 2026-05-12.

| Provider | Official document | Checked items | Evidence result |
|---|---|---|---|
| OANDA | https://www.oanda.com/foreign-exchange-data-services/en/exchange-rates-api/ | REST/GET/HTTPS, UTC timestamps, JSON/XML/CSV, real-time rates, bid/ask/midpoint, trial | Official docs support OANDA as FX candidate; exact response fields remain unverified |
| OANDA | https://www.oanda.com/foreign-exchange-data-services/en/exchange-rates-api/api-plans/ | 7-day trial, 100,000 quotes/month Lite, higher plans, account/API key | Current as checked on 2026-05-12; contract/cost approval still required |
| Twelve Data | https://twelvedata.com/docs | `/exchange_rate`, `/quote`, `/price`, WebSocket quote price, symbol examples, fields, API shape | Official docs support mapping candidates; live response still required |
| Twelve Data | https://twelvedata.com/docs/currencies/exchange-rate | `/exchange_rate` endpoint, slash-delimited symbol, `rate`, `timestamp` | Official docs support USD/KRW candidate shape, but USD/KRW live response not captured |
| Twelve Data | https://twelvedata.com/docs/market-data/quote | `/quote` endpoint, `close`, `timestamp`, `last_quote_at`, `previous_close`, `is_market_open`, extended-hours fields | Official docs support US stock quote candidate shape |
| Twelve Data | https://twelvedata.com/docs/market-data/price | `/price` endpoint returns only `price` | Not sufficient alone for `provider_api` snapshot because timestamp evidence is missing |
| Twelve Data | https://twelvedata.com/pricing | API credits/minute, Basic 8 API credits and 800/day, real-time US equities/forex/crypto statements, individual plan scope | Current as checked on 2026-05-12; production terms still require owner approval |
| Twelve Data | https://support.twelvedata.com/en/articles/5615854-credits | API credit reset, 429 behavior, response headers for credits used/left | Current as checked on 2026-05-12 |
| Twelve Data | https://twelvedata.com/stocks | US/global coverage; South Korea EOD delay | KRX quote/execute remains blocked |
| Twelve Data | https://twelvedata.com/cryptocurrency | Crypto coverage and real-time/streaming positioning | Crypto candidate remains conditional without live fixture |
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
- OANDA API plans currently list Lite with 100,000 quotes/month and higher plans with broader quote capacity.

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

## 9. Twelve Data Crypto Evidence

Live fixture status:

- Twelve Data crypto live fixture BLOCKED: `TWELVE_DATA_API_KEY` unavailable.
- No request was sent.
- No fixture file was created.

Official-document evidence:

- Candidate endpoint A: `/exchange_rate`.
- Candidate request template A: `GET https://api.twelvedata.com/exchange_rate?symbol=BTC/USD&apikey=<redacted>`.
- Candidate endpoint B: `/quote` or WebSocket quote price, pending live fixture and product choice.
- Official docs describe `/exchange_rate` as supporting cryptocurrency pairs and returning `symbol`, `rate`, and `timestamp`.
- Official crypto/reference docs use slash-delimited symbols such as `BTC/USD` and expose available exchanges for cryptocurrency pairs.
- Official support docs describe WebSocket `/quotes/price` as real-time tick price with UNIX timestamp and price.
- Official pricing pages state real-time crypto market data availability by plan.

Unverified items:

- Actual BTC/USD or ETH/USD response with this account.
- Whether `/exchange_rate` or `/quote` is better for asset price snapshots.
- Exchange/aggregation policy.
- Whether response includes enough currency and exchange context for the project's `Asset` row.
- Whether timestamp freshness can satisfy the 30-second crypto quote/execute target.
- Commercial/business terms.

Mapping candidate:

- Internal table: `asset_price_snapshots`.
- `sourceType`: `provider_api`.
- `sourceName`: `twelve_data_exchange_rate` or `twelve_data_quote`, depending on selected endpoint.
- `price`: `/exchange_rate.rate` or `/quote.close`, pending endpoint decision.
- `currencyCode`: quote currency from symbol, expected `USD`.
- `sourceTimestamp`: `/exchange_rate.timestamp`, `/quote.last_quote_at`, `/quote.timestamp`, or WebSocket `timestamp`.
- `effectiveAt`: selected source timestamp converted from Unix seconds to UTC DateTime.
- `capturedAt`: local server receipt time.
- `rawPayloadJson`: sanitized response body only after terms/storage approval.

Current decision:

- Twelve Data crypto fixture capture: BLOCKED.
- Crypto provider implementation: BLOCKED until live fixture, endpoint decision, exchange policy, and terms decision exist.

## 10. Error / Rate Limit / Outage Evidence

Live error fixture status:

- No invalid-symbol or invalid-key requests were sent because credentials are unavailable and live fixture capture was already blocked.

Official error/rate-limit evidence:

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
| Twelve Data | `/exchange_rate` | `rate` | `fx_rate_snapshots.rate` or crypto `asset_price_snapshots.price` | Direct candidate for USD/KRW and possibly BTC/USD | Official-doc candidate; live fixture BLOCKED |
| Twelve Data | `/quote` | `close` | `asset_price_snapshots.price` | Candidate for US stock and maybe crypto; market-open semantics require decision | Official-doc candidate; live fixture BLOCKED |
| Twelve Data | `/price` | `price` | Not accepted alone | Lacks timestamp evidence; do not use alone for `provider_api` snapshots | STOP for provider_api alone |
| Twelve Data | WebSocket `/quotes/price` | `price` | `asset_price_snapshots.price` | Real-time tick candidate; requires separate streaming ingestion design | Not in Gate C/D implementation scope |

Rate/price conclusion:

- No live rate/price mapping is proven.
- Twelve Data `/exchange_rate.rate` and `/quote.close` are mapping candidates only.
- OANDA rate mapping remains blocked until exact response shape and rate basis are captured.

## 13. SourceType / SourceName Mapping

| Provider use | Internal table | sourceType | sourceName candidate | Status |
|---|---|---|---|---|
| OANDA USD/KRW FX | `fx_rate_snapshots` | `provider_api` | `oanda` | Candidate only |
| Twelve Data USD/KRW FX | `fx_rate_snapshots` | `provider_api` | `twelve_data_exchange_rate` | Candidate only |
| Twelve Data US stock quote | `asset_price_snapshots` | `provider_api` | `twelve_data_quote` | Candidate only |
| Twelve Data crypto exchange rate | `asset_price_snapshots` | `provider_api` | `twelve_data_exchange_rate` | Candidate only |
| Twelve Data crypto quote | `asset_price_snapshots` | `provider_api` | `twelve_data_quote` | Candidate only |

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
| Crypto quote/execute | target 30 seconds | `/exchange_rate`, `/quote`, or WebSocket candidates exist; no live fixture | Not proven |
| Home live valuation | consistency over silent stale fallback | provider timestamp candidates exist but no fixture | Not proven |
| Settlement | finality/reproducibility over live price | provider_api not accepted as sole final source | Not applicable to provider live fixture |

Freshness conclusion:

- Official documents make mapping plausible for Twelve Data and OANDA, but no provider is proven compatible with current freshness policy without live response timestamps.

## 15. Fixture Inventory

No fixture files were added.

| Fixture | Status | Reason |
|---|---|---|
| `docs/provider-fixtures/oanda-usd-krw-sample.json` | Not created | OANDA credentials unavailable |
| `docs/provider-fixtures/twelvedata-usd-krw-exchange-rate-sample.json` | Not created | `TWELVE_DATA_API_KEY` unavailable |
| `docs/provider-fixtures/twelvedata-us-stock-quote-sample.json` | Not created | `TWELVE_DATA_API_KEY` unavailable |
| `docs/provider-fixtures/twelvedata-crypto-quote-sample.json` | Not created | `TWELVE_DATA_API_KEY` unavailable |
| `docs/provider-fixtures/provider-error-samples.md` | Not created | No live error calls were attempted; official error evidence is recorded in this document |

## 16. Security Review of Captured Fixtures

No captured fixture files exist.

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
| OANDA USD/KRW fixture capture | BLOCKED | OANDA credentials unavailable; exact endpoint/fields/timestamp/rate basis remain unverified |
| Twelve Data USD/KRW fixture capture | BLOCKED | `TWELVE_DATA_API_KEY` unavailable; official docs show mapping candidate but no live fixture |
| Twelve Data US stock fixture capture | BLOCKED | `TWELVE_DATA_API_KEY` unavailable; official docs show `/quote` mapping candidate but no live fixture |
| Twelve Data crypto fixture capture | BLOCKED | `TWELVE_DATA_API_KEY` unavailable; endpoint choice and exchange aggregation remain unverified |
| FX provider ingestion implementation | BLOCKED | Live fixture, timestamp mapping, sourceType eligibility, rate basis, and terms/account decisions are missing |
| Asset price provider ingestion implementation | BLOCKED | Live US stock/crypto fixtures, symbol/currency mapping, timestamp decision, and terms/account decisions are missing; KRX quote/execute remains blocked |
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
- crypto fixture mapping.
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

- Which OANDA environment variable name should be canonical for Exchange Rates API credentials?
- Does OANDA Exchange Rates API require only an API key for the chosen endpoint, or also an account id?
- What is the exact OANDA endpoint path for USD/KRW real-time rates?
- Should OANDA `rate` map from bid, ask, midpoint, or side-aware bid/ask?
- Can OANDA raw payloads be stored in `rawPayloadJson` under the chosen contract?
- Is Twelve Data `/exchange_rate` acceptable for crypto asset prices, or should crypto use `/quote` or WebSocket?
- Should US stock `effectiveAt` use `/quote.last_quote_at` or `/quote.timestamp`?
- Is delayed data acceptable for any virtual trading UX path?
- Is Twelve Data Basic enough for fixture capture, and which business plan is required for production?
- What provider or official source will cover KRX if domestic stock trading remains in MVP?

## 20. Next Gate Recommendation

Recommended next prompt title:

- `Gate C/D Live Provider Fixture Capture - Provide OANDA and Twelve Data Credentials`

Recommended scope:

- Docs/fixture-only.
- Use environment variables only.
- Capture one minimal live response per target:
  - OANDA USD/KRW.
  - Twelve Data USD/KRW `/exchange_rate`.
  - Twelve Data AAPL or MSFT `/quote`.
  - Twelve Data BTC/USD or ETH/USD selected endpoint.
- Save sanitized fixture JSON only if provider terms allow storage or mark storage terms as unverified.
- Do not implement provider clients, ingestion, scheduler, DB writes, schema changes, seed changes, package changes, source code, or tests.

Implementation gates remain closed until live fixtures and owner decisions are accepted.

## Provider Fixture Matrix

| Provider | Asset class | Endpoint | Symbol/pair | Fixture captured? | Credential required? | Timestamp field | Price/rate field | Market/open field | Rate limit evidence | Current status |
|---|---|---|---|---|---|---|---|---|---|---|
| OANDA | FX | Exchange Rates API exact endpoint unverified | USD/KRW | No | Yes | UTC timestamp field unverified | bid/ask/midpoint unverified | n/a | Plan docs: Lite 100,000 quotes/month; trial key | BLOCKED |
| Twelve Data | FX | `/exchange_rate` | `USD/KRW` | No | Yes | `timestamp` | `rate` | n/a | Credits reset per minute; 429 on credit exhaustion | BLOCKED |
| Twelve Data | US stock | `/quote` | `AAPL` or `MSFT` | No | Yes | `timestamp`, `last_quote_at` | `close` candidate | `is_market_open` | Credits reset per minute; endpoint cost documented in docs | BLOCKED |
| Twelve Data | Crypto | `/exchange_rate`, `/quote`, or WebSocket `/quotes/price` | `BTC/USD` or `ETH/USD` | No | Yes | `timestamp` or `last_quote_at` | `rate`, `close`, or tick `price` | 24/7/market metadata unverified for chosen endpoint | Credits reset per minute; WebSocket credit model documented | BLOCKED |

## Internal Snapshot Mapping Candidate

| Provider | Asset class | Internal table | sourceType | sourceName | rate/price mapping | currency mapping | sourceTimestamp mapping | effectiveAt mapping | capturedAt mapping | rawPayloadJson storage | Open blockers |
|---|---|---|---|---|---|---|---|---|---|---|---|
| OANDA | FX | `fx_rate_snapshots` | `provider_api` | `oanda` | bid/ask/midpoint after owner decision | base `USD`, quote `KRW` | OANDA timestamp field unverified | same as source timestamp if confirmed | local receipt time | sanitized raw response if terms allow | credentials, endpoint, fields, rate basis, terms |
| Twelve Data | FX | `fx_rate_snapshots` | `provider_api` | `twelve_data_exchange_rate` | `/exchange_rate.rate` | symbol base/quote `USD/KRW` | `/exchange_rate.timestamp` | Unix seconds -> UTC DateTime | local receipt time | sanitized raw response if terms allow | credentials, live fixture, timestamp freshness, terms |
| Twelve Data | US stock | `asset_price_snapshots` | `provider_api` | `twelve_data_quote` | `/quote.close` candidate | `/quote.currency` expected `USD` | `/quote.last_quote_at` preferred candidate, `/quote.timestamp` fallback candidate | selected source timestamp -> UTC DateTime | local receipt time | sanitized raw response if terms allow | credentials, field semantics, market closed behavior, terms |
| Twelve Data | Crypto | `asset_price_snapshots` | `provider_api` | `twelve_data_exchange_rate` or `twelve_data_quote` | `/exchange_rate.rate`, `/quote.close`, or WS `price` | quote currency from symbol expected `USD` | endpoint timestamp field | selected source timestamp -> UTC DateTime | local receipt time | sanitized raw response if terms allow | credentials, endpoint choice, exchange aggregation, terms |

## Implementation Readiness Matrix

| Area | Evidence status | Terms/account status | Timestamp status | Freshness status | Test requirements | Decision: GO / CONDITIONAL GO / STOP / BLOCKED | Reason |
|---|---|---|---|---|---|---|---|
| OANDA USD/KRW fixture capture | No live fixture | No local credentials; contract not approved | Exact field unverified | Not measured | fixture mapping, redaction, source timestamp conversion | BLOCKED | Cannot capture without credentials |
| Twelve Data USD/KRW fixture capture | No live fixture | No local credentials; business terms not approved | Official `timestamp` candidate | Not measured | `/exchange_rate` mapping, 60-second age check | BLOCKED | Cannot capture without API key |
| Twelve Data US stock fixture capture | No live fixture | No local credentials; plan/terms not approved | Official `timestamp`/`last_quote_at` candidates | Not measured | `/quote` mapping, market-open behavior | BLOCKED | Cannot capture without API key |
| Twelve Data crypto fixture capture | No live fixture | No local credentials; plan/terms not approved | Official timestamp candidates by endpoint | Not measured | endpoint decision, exchange/symbol mapping | BLOCKED | Cannot capture without API key |
| FX provider ingestion implementation | Official docs only | No owner approval | Not live-proven | Not live-proven | full provider ingestion test matrix | BLOCKED | Live fixture is required before implementation GO |
| Asset price provider ingestion implementation | Official docs only | No owner approval | Not live-proven | Not live-proven | US/crypto provider test matrix | BLOCKED | Live fixtures and KRX decision missing |
| Scheduler/batch foundation | Docs policy exists | Provider account path missing | Provider timestamp not live-proven | Provider polling not live-proven | lock/idempotency/retry/outage tests | CONDITIONAL GO for audit only | Scheduler implementation must wait |
| Settlement preimplementation audit | Docs policy exists | Final evidence source undecided | Settlement timestamp source undecided | Finality source undecided | settlement audit test matrix | CONDITIONAL GO for docs audit only | Implementation remains STOP |
