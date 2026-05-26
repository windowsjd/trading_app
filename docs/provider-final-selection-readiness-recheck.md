# Provider Final Selection Readiness Re-check

## 1. Purpose

This document re-checks provider readiness before provider_api source eligibility, scheduler, settlement, or reward implementation.

Scope is readiness and policy. Provider ingestion foundation is now tracked separately in `docs/provider-ingestion-foundation.md`; this document does not authorize scheduler/batch jobs, settlement, rewards, schema changes, migrations, package changes, seed changes, provider_api source eligibility, or fake/static/sample business price data.

2026-05-26 implementation update:

- Provider ingestion foundation is implemented for ExchangeRate-API USD/KRW and Binance public REST crypto price snapshots.
- KIS is implemented only as a market data skeleton: config parsing, redaction, watchlist policy, token response parsing, approval key response parsing, and explicit-path low-level client foundation.
- KIS quote ingestion, KIS WebSocket ingestion, Binance WebSocket ingestion, cron scheduling, admin HTTP ingestion API, and provider_api source eligibility are not implemented.

Crypto policy update on 2026-05-14:

- MVP crypto provider is Binance.
- MVP crypto is USD-settled and uses the USD Wallet.
- Upbit/Bithumb are excluded from the MVP provider stack.
- Twelve Data remains a conditional US stock/FX candidate, not the MVP crypto provider.
- `CurrencyCode.USDT` must not be added. Provider ingestion foundation treats Binance USDT quote pairs such as `BTCUSDT` as USD-equivalent for stored provider_api snapshots, while source eligibility and depeg risk remain a later gate.

## 2. Current Project Requirements

- Financial amounts and rates must cross API boundaries as strings.
- FX and order flows use quote -> execute.
- US stock orders use the USD cash wallet.
- Crypto orders use the USD cash wallet.
- Final evaluation is total assets in KRW.
- Crypto valuation in KRW is crypto USD value converted by USD/KRW.
- Trading and FX exchange must be blocked after season end.
- Missing or stale prices must produce explicit errors or unavailable states, not fake data.
- `admin_manual` is an approved bootstrap/manual correction path, not a long-running production provider.
- `provider_api` row insertion foundation exists for ExchangeRate-API and Binance. Provider_api source eligibility, `official_batch` ingestion, scheduler/batch automation, settlement, and reward are not implemented by this document.

## 3. Current Internal Source Policy

Current schema source types:

- FX: `admin_manual`, `provider_api`, `official_batch`.
- Asset price: `admin_manual`, `provider_api`, `official_batch`.

Current implemented source usage:

- `/fx quote`: selects latest eligible USD/KRW by `effectiveAt desc`, then `capturedAt desc`, then `createdAt desc`; current code does not filter `sourceType`; freshness is 60 seconds.
- `/fx execute`: currently allows `admin_manual` only and applies the same 60-second FX freshness rule.
- Order quote/create/execute: asset prices currently use `admin_manual` only; USD assets also require approved fresh `admin_manual` USD/KRW.
- Portfolio valuation/home live valuation: asset prices and USD/KRW currently use `admin_manual`; USD/KRW freshness follows the existing 60-second rule.
- Ranking: reads existing `season_rankings`; it does not fetch prices.
- Daily snapshot/ranking generation: manual CLI foundation exists; automatic scheduler does not.

## 4. Provider Candidates

Primary re-check candidates:

- OANDA Exchange Rates API for USD/KRW FX.
- Twelve Data for FX fallback and asset price provider candidates.

Not re-promoted in this document:

- Korea Eximbank and BOK ECOS remain official/reference/batch candidates from prior research, not real-time quote/execute providers.
- Open Exchange Rates, Currencylayer, Alpha Vantage, and exchangerate.host remain prior supporting candidates only.

## 5. Official Documentation Checked

Checked date: 2026-05-12.

| Provider | Official URL | Checked items | Result |
|---|---|---|---|
| OANDA | https://www.oanda.com/foreign-exchange-data-services/en/exchange-rates-api/ | REST/HTTPS/GET, UTC timestamps, JSON/XML/CSV formats, real-time rates, bid/ask/mid data sets, 7-day trial, broad currency pair coverage | Official marketing/product docs are sufficient for readiness, but exact endpoint response mapping remains unverified |
| OANDA | https://www.oanda.com/foreign-exchange-data-services/en/exchange-rates-api/api-plans/ | Pricing and plan features, 100,000 quotes/month Lite, higher plan unlimited quotes, 3-5 second spot, streaming, cryptocurrency plan | Current as checked on 2026-05-12; cost/contract approval still required |
| OANDA | https://www.oanda.com/foreign-exchange-data-services/en/exchange-rates-api/api-accuracy/ | Data source quality, real FX market inputs, outlier removal, central-bank/reference source claims | Supports OANDA as a strong FX-quality candidate |
| OANDA | https://exchange-rates-api.oanda.com/ | Developer/API documentation entry point | Page rendered as an iframe shell in this check; exact endpoint fields remain unverified |
| Twelve Data | https://twelvedata.com/docs | `/exchange_rate`, `/quote`, `/price`, `/time_series`, `/forex_pairs`, `/cryptocurrencies`, `/market_state`, auth, errors, API shape | Official docs are broad enough for readiness, but exact live response evidence is still required |
| Twelve Data | https://twelvedata.com/pricing | Individual plan usage, API credits per minute, Basic/Grow/Pro/Ultra limits, personal/internal/non-commercial positioning | Current as checked on 2026-05-12 |
| Twelve Data | https://twelvedata.com/pricing-business | Business plan positioning, external display data access, commercial/professional plan context | Current as checked on 2026-05-12; production terms still require owner approval |
| Twelve Data | https://support.twelvedata.com/en/articles/5615854-credits | API/WS credit reset and 429 behavior | Current as checked on 2026-05-12 |
| Twelve Data | https://twelvedata.com/stocks | US/international coverage, real-time US, South Korea EOD delay, plan tiers | KRX real-time quote/execute remains unverified/blocked |
| Twelve Data | https://twelvedata.com/cryptocurrency | Crypto coverage, real-time low-latency streaming, exchanges | Historical/prior crypto candidate evidence only; MVP crypto provider is now Binance |
| Twelve Data | https://twelvedata.com/markets/938314/forex/usd-krw | USD/KRW instrument page | Confirms official USD/KRW market page exists; API response still must be verified |

## 6. OANDA Review

OANDA official documents support the following:

- Exchange Rates API is delivered via REST over HTTPS with GET, with UTC timestamps and JSON/XML/CSV formats.
- OANDA advertises over 38,000 currency pairs and over 200 currencies, commodities, and precious metals.
- Average rates include bid, ask, and midpoint; historical fixing data includes bid/ask/midpoint for open/close/high/low.
- Real-time rates include streaming bid, ask, and midpoint rates through REST or FIX.
- API plan material lists 3-5 second spot and streaming rates on higher plans.
- API key and account are required. A 7-day free API key trial is available.
- Current as checked on 2026-05-12: OANDA listed Lite at USD 450/month or USD 4,850/year, with 100,000 quotes/month. Higher plans list unlimited quotes and higher-rate features.
- One USD/KRW poll every 30 seconds is roughly 86,400 requests/month, which appears within Lite monthly quote volume for one pair, but contract terms and quote accounting must still be confirmed.

OANDA unverified items:

- Exact USD/KRW Exchange Rates API pair response with a trial key.
- Exact endpoint path, request parameters, and response field names.
- Exact source timestamp field name and whether it is a tick/spot timestamp or publication timestamp.
- Exact bid/ask/mid fields and which one should map to `rate`.
- Rate basis policy for KRW per 1 USD.
- Contract permission for 30-second polling and internal/external display or derived valuation use.
- Retry/backoff guidance in API documentation.

OANDA readiness conclusion:

- OANDA remains the recommended primary FX provider candidate.
- OANDA is not a stock provider for this project.
- OANDA must not be treated as the primary crypto provider.

## 7. Twelve Data Review

Twelve Data official documents support the following:

- `/exchange_rate` returns real-time exchange rates for forex and cryptocurrency pairs and includes `symbol`, `rate`, and `timestamp` in examples.
- `/currency_conversion` also returns `rate`, converted `amount`, and `timestamp`.
- `/quote` returns richer market data including `close`, `timestamp`, `last_quote_at`, and `is_market_open`; this is a better asset-price ingestion candidate than `/price` because `/price` returns only a `price`.
- `/time_series` supports intervals including `1min`, `5min`, `15min`, `30min`, `1h`, and `1day`; response `datetime` is local exchange time for equities and UTC for forex/crypto.
- `/forex_pairs` and the USD/KRW market page support USD/KRW as an official candidate, but live-key API response still must be verified.
- `/stocks` and `/exchanges` can support symbol/exchange mapping with currency, exchange, MIC, country, and plan access metadata.
- `/market_state` returns whether a stock exchange is open or closed.
- Pricing says API credits reset every minute. Basic has 8 API credits/minute and 800/day; paid plans have higher minute credits and no daily limit.
- Twelve Data support docs say a 429 response indicates API credit exhaustion, with quota reset at the start of each minute.
- Individual pricing is positioned for personal/internal/non-commercial usage; business pricing is the candidate for commercial/external display use.
- Twelve Data stocks page states US market data is real-time, while South Korea is listed as EOD delay in the inspected plan/coverage page.
- Twelve Data cryptocurrency page states real-time low-latency streaming and broad exchange coverage.

Twelve Data unverified items:

- Actual USD/KRW `/exchange_rate` response using a real key.
- Pair-specific timestamp freshness under 30-second polling.
- Whether `/quote` or WebSocket should be the canonical asset provider endpoint.
- Exact symbol mapping for project asset universe.
- Whether South Korea/KRX can provide quote/execute-grade data under any acceptable plan.
- Business/commercial redistribution and display terms for this product.
- Whether delayed market data can be used in a virtual trading UX without product/legal sign-off.

Twelve Data readiness conclusion:

- Twelve Data remains the secondary FX provider candidate.
- Twelve Data is the recommended conditional candidate for US stock prices.
- Twelve Data is no longer the MVP crypto provider target because MVP crypto is Binance-based USD-settled crypto.
- Twelve Data is not accepted as KRX quote/execute provider in this re-check because official checked coverage shows South Korea EOD delay, not quote/execute-grade real-time coverage.

## 8. FX USD/KRW Requirements

Required before FX provider ingestion:

- USD/KRW pair must be available in the selected provider API, not only on a web converter page.
- Provider must return a usable source timestamp.
- `effectiveAt` must map to provider source timestamp.
- `capturedAt` must be our server response receipt time.
- Provider timestamp must be fresh enough for current quote/execute 60-second policy.
- Polling interval must be shorter than 60 seconds and contractually permitted.
- Rate basis must be fixed:
  - OANDA: bid/ask/midpoint must be chosen before implementation.
  - Twelve Data: single `rate` field is the candidate, but live response must prove semantics.
- No provider outage may create fake/static/sample rows.

## 9. Asset Price Requirements

Required before asset price provider ingestion:

- Asset symbol mapping must be explicit by `market`, `symbol`, `currencyCode`, and asset type.
- Provider response must include or be paired with a source timestamp. `/price` alone is not sufficient because it lacks timestamp evidence in the checked docs.
- Candidate provider endpoint for asset prices is Twelve Data `/quote` or another endpoint with timestamp and close/last quote fields, not timestamp-less `/price`.
- Domestic/KRX, US stock, and crypto must have separate freshness and market-hours rules.
- Delayed/EOD data must not silently power order quote/execute when product expects market-open execution.
- Crypto symbols must use Binance spot-market mapping before use. Initial fixture candidates are `BTCUSDT` and `ETHUSDT`; USDT-to-USD-equivalent normalization versus strict Binance USD quote pairs remains a Gate C/D owner decision.
- Manual fallback must not silently outrank fresh provider data.

## 10. Timestamp / Freshness Evidence

Provider timestamp policy:

- `effectiveAt`: provider's source timestamp. If missing, `provider_api` ingestion is not GO.
- `capturedAt`: our server receipt/storage time.
- `createdAt`: DB insertion time only; it must not be the primary market freshness signal.

OANDA:

- Official product docs mention UTC timestamps, but exact response field mapping was not visible in the public developer page during this check.
- OANDA timestamp mapping remains unverified until trial/API documentation response is captured.

Twelve Data:

- `/exchange_rate` and `/currency_conversion` examples include `timestamp`.
- `/quote` examples include `timestamp`, `last_quote_at`, and `is_market_open`.
- `/time_series` uses `datetime`, with local exchange time for equities and UTC for forex/crypto.
- `/price` lacks timestamp in the inspected docs, so it must not be used alone as a `provider_api` snapshot source.

## 11. Rate Limit / Polling Feasibility

OANDA:

- Current as checked on 2026-05-12: Lite listed 100,000 quotes/month; higher plans list unlimited quotes.
- One USD/KRW poll every 30 seconds is approximately 86,400 polls per 30-day month.
- This looks technically feasible for one FX pair on Lite volume, but contract terms, quote counting, retries, monitoring calls, and production usage must be confirmed before implementation.

Twelve Data:

- Current as checked on 2026-05-12: API credits reset per minute; endpoint costs are documented per endpoint.
- `/exchange_rate`, `/quote`, and `/price` are documented as 1 credit per symbol.
- Basic 8 credits/minute may support tiny trials but not broad asset polling. Paid/business plans are required for production-like polling.
- Scheduler design must prevent credit exhaustion and handle 429 without fake fallback.

## 12. Cost / Account / Trial Readiness

OANDA:

- API key and account are required.
- 7-day trial key exists.
- Cost is high but technically aligned for FX freshness.
- Cost/contract approval is still required.

Twelve Data:

- API key and account are required.
- Basic/free plan can support limited trial checks.
- Business plan likely needed for commercial/external display or professional product use.
- Paid plan selection depends on asset universe size, polling interval, WebSocket use, and whether delayed data is acceptable.

## 13. Contract / Terms / Redistribution Risk

- Provider usage terms are not fully accepted by this document.
- Production provider selection requires explicit owner approval for commercial/internal/external display and derived valuation/ranking/settlement use.
- Twelve Data individual plans are not assumed sufficient for production commercial use.
- OANDA contract must confirm polling, storage of raw payloads, derived rates/valuations, and display/redistribution boundaries.
- If terms are unclear, implementation remains blocked.

## 14. Data Quality and Market Coverage

OANDA:

- Strong FX quality candidate. Official accuracy pages describe market-rate sourcing, outlier removal, and redundant/trusted sources.
- Best fit for USD/KRW freshness if trial response proves pair and timestamp mapping.
- Not a general stock provider for this project.

Twelve Data:

- Broad multi-asset coverage candidate.
- US stock: conditional candidate due real-time US market docs and `/quote` timestamp.
- Crypto: Binance MVP provider target; fixture/evidence must prove symbol, timestamp, price, and USDT-to-USD policy before ingestion implementation.
- KRX/domestic stock: not GO for quote/execute. Official checked page lists South Korea as EOD delay, so domestic stock real-time provider remains unverified.

## 15. Failure Mode and Fallback Policy

- Provider outage: do not insert rows.
- Provider timeout: do not insert rows.
- Provider rate limit/429: do not insert rows; alert/retry according to future scheduler policy.
- Provider parse error: do not insert rows.
- Provider timestamp missing: reject `provider_api` row unless a future policy explicitly allows a non-real-time source for non-execute workflows.
- Existing stale rows remain for audit but must produce stale/unavailable behavior in quote/execute/live valuation.
- `admin_manual` may be used only through explicit operator action as bootstrap/manual correction/emergency fallback.
- No automatic fallback from stale/unavailable provider data to `admin_manual`.
- `official_batch` is not a real-time execute fallback.

## 16. Recommended Provider Role

- Primary FX provider: OANDA, CONDITIONAL. Use only after trial/API response proves USD/KRW, timestamp, rate fields, and contract/polling approval.
- Secondary FX provider: Twelve Data, CONDITIONAL. Use only after live-key USD/KRW response and timestamp freshness measurements.
- Primary US stock provider: Twelve Data, CONDITIONAL. Candidate endpoint is `/quote` or WebSocket with timestamp evidence, not `/price` alone.
- Primary crypto provider: Binance, GO for REST ticker row insertion foundation and STOP for financial source eligibility. Requires timestamp freshness proof, terms approval, and source eligibility before quote/execute/valuation use.
- KRX domestic stock provider: BLOCKED/UNVERIFIED for quote/execute. Twelve Data may be an EOD/reference candidate only if product accepts delayed/EOD use.
- Manual fallback: `admin_manual`, explicit operator action only.
- Official batch role: reference, reconciliation, daily snapshot, and settlement candidate only; not real-time order execute.
- Provider implementation GO/STOP: row insertion foundation is implemented for ExchangeRate-API and Binance; financial source eligibility remains a separate gate.

## 17. STOP / GO Decision

| Area | Decision | Reason |
|---|---|---|
| Gate B Provider final selection readiness | CONDITIONAL GO | Official docs were rechecked and provider roles are now clear enough to proceed to evidence collection and narrow Gate C/D prompts |
| FX provider ingestion foundation | GO for ExchangeRate-API USD/KRW row insertion | Source eligibility and final provider selection remain separate gates |
| Asset price provider ingestion foundation | GO for Binance public crypto row insertion, BLOCKED for KRX quote/execute | Binance MVP crypto row insertion exists; Twelve Data US stock and KRX real-time remain later gates |
| Scheduler/batch foundation | CONDITIONAL GO for preimplementation audit only | Polling/credit/failure rules are clearer, but scheduler implementation still needs provider decisions and tests |
| Settlement preimplementation audit | CONDITIONAL GO for docs-only audit, STOP for implementation | Freshness/source policy is clearer, but final official/reference source remains a settlement gate decision |

## 18. Required Evidence Before Implementation

Before FX provider_api source eligibility:

- OANDA trial response for USD/KRW.
- Exact OANDA endpoint path, params, auth header/query, response fields.
- OANDA `effectiveAt` mapping from provider timestamp.
- OANDA `capturedAt` assignment rule.
- OANDA bid/ask/mid applied-rate decision.
- OANDA cost/contract approval.
- Twelve Data fallback live-key response and timestamp freshness measurement if used.
- SourceType/sourceName values accepted.
- Rate limit/backoff and outage behavior accepted.

Before asset price provider_api source eligibility:

- Twelve Data symbol mapping for each supported market/asset.
- US stock `/quote` or WebSocket response fixture with timestamp.
- Binance crypto ticker/orderbook fixture with timestamp/effectiveAt mapping.
- USDT-to-USD-equivalent normalization decision or Binance USD quote pair evidence.
- KRX provider proof or explicit product decision to avoid KRX quote/execute until real-time data is available.
- Delayed/EOD handling policy.
- Business/commercial terms approval.

## 19. Next Gate Recommendation

Recommended next prompt title:

- `Provider API Source Eligibility Gate - Quote Valuation and Execute Allowlist`

Allowed scope for that prompt:

- Source eligibility policy and tests.
- Live smoke evidence where credentials and terms permit.
- Keep Binance private key, KIS order/account/balance APIs, cron scheduler, and WebSocket ingestion out of scope unless separately approved.
- No scheduler, settlement, reward, schema, migration, package, seed, or business logic changes.
