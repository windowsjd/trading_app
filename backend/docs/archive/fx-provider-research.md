> Historical document.
> This file is not the current source of truth.
> See `docs/current-status.md`, `docs/backend-gate-roadmap.md`, and the relevant API contract or provider policy document.

# FX Provider Research

## Status
- Documentation only.
- Official-document research date: 2026-05-02.
- Do not implement `provider_api`, `official_batch`, scheduler, admin API, `/fx execute`, wallet writes, schema changes, migrations, seed changes, Prisma Client generate, package changes, or fake/static/temporary business rates from this document.
- Provider final selection is pending.

## Purpose
- Compare USD/KRW ingestion candidates against the implemented `/fx quote` 60-second stale threshold.
- Separate `provider_api` candidates for fresh quote operation from `official_batch` candidates for reference or settlement.
- Keep `admin_manual` as bootstrap, fallback, and manual correction only.
- Record only information found in official provider/source documentation. Items not confirmed in official documents are intentionally left as "공식 문서에서 확인하지 못함", "공식 문서상 명시 없음", or "추가 확인 필요".

## Current Project Premises
- `POST /api/v1/fx/quote` read-only API is implemented.
- `/fx quote` reads USD/KRW snapshots from `fx_rate_snapshots`.
- Missing snapshot returns `FX_RATE_UNAVAILABLE`.
- Selected snapshot whose `effectiveAt` is older than 60 seconds returns `FX_RATE_STALE`.
- `/fx quote` does not mutate wallets and does not create `exchange_transactions`, `wallet_transactions`, `fx_execute_requests`, or `equity_snapshots`.
- `admin_manual` FX rate input CLI is implemented and remains bootstrap/fallback/manual correction.
- `provider_api` and `official_batch` ingestion are not implemented.
- `/fx execute` remains STOP.

## Official Documents Used
| Provider/source | Official document URL | Checked date |
| --- | --- | --- |
| Korea Eximbank exchange-rate Open API | https://www.koreaexim.go.kr/ir/HPHKIR020M01?apino=2&viewtype=C&searchselect=&searchword= | 2026-05-02 |
| Korea Eximbank public data listing | https://www.data.go.kr/data/3068846/openapi.do | 2026-05-02 |
| Bank of Korea ECOS Open API | https://ecos.bok.or.kr/api/ | 2026-05-02 |
| Bank of Korea ECOS `StatisticItemList` official API endpoint | https://ecos.bok.or.kr/api/StatisticItemList/sample/json/kr/1/10/731Y001 | 2026-05-02 |
| Bank of Korea ECOS `StatisticSearch` official API endpoint | https://ecos.bok.or.kr/api/StatisticSearch/sample/json/kr/1/10/731Y001/D/20240101/20240131/0000001 | 2026-05-02 |
| Open Exchange Rates API introduction | https://docs.openexchangerates.org/reference/api-introduction | 2026-05-02 |
| Open Exchange Rates latest endpoint | https://docs.openexchangerates.org/reference/latest-json | 2026-05-02 |
| Open Exchange Rates supported currencies | https://docs.openexchangerates.org/reference/supported-currencies | 2026-05-02 |
| Open Exchange Rates pricing | https://openexchangerates.org/signup | 2026-05-02 |
| Open Exchange Rates usage endpoint | https://docs.openexchangerates.org/reference/usage-json | 2026-05-02 |
| Currencylayer documentation | https://currencylayer.com/documentation | 2026-05-02 |
| Currencylayer supported currencies | https://currencylayer.com/currencies | 2026-05-02 |
| Currencylayer pricing | https://currencylayer.com/pricing | 2026-05-02 |
| Twelve Data exchange rate endpoint | https://twelvedata.com/docs/llms/currencies/exchange-rate.md | 2026-05-02 |
| Twelve Data currency conversion endpoint | https://twelvedata.com/docs/llms/currencies/currency-conversion.md | 2026-05-02 |
| Twelve Data WebSocket real-time price | https://twelvedata.com/docs/llms/websocket/ws-real-time-price.md | 2026-05-02 |
| Twelve Data forex product page | https://twelvedata.com/forex | 2026-05-02 |
| Twelve Data pricing | https://twelvedata.com/pricing | 2026-05-02 |
| Twelve Data business pricing | https://twelvedata.com/pricing-business | 2026-05-02 |
| Twelve Data credits support | https://support.twelvedata.com/en/articles/5615854-credits | 2026-05-02 |
| Alpha Vantage API documentation | https://www.alphavantage.co/documentation/ | 2026-05-02 |
| Alpha Vantage premium plans | https://www.alphavantage.co/premium/ | 2026-05-02 |
| exchangerate.host documentation | https://exchangerate.host/documentation | 2026-05-02 |
| exchangerate.host pricing | https://exchangerate.host/pricing | 2026-05-02 |
| OANDA Exchange Rates API | https://www.oanda.com/foreign-exchange-data-services/en/exchange-rates-api/ | 2026-05-02 |
| OANDA API pricing | https://www.oanda.com/foreign-exchange-data-services/en/exchange-rates-api/api-pricing/ | 2026-05-02 |
| OANDA API plans | https://www.oanda.com/foreign-exchange-data-services/en/exchange-rates-api/api-plans/ | 2026-05-02 |

## Candidate Comparison
| Provider/source name | sourceType candidate | Official document URL | USD/KRW pair support | Real-time/delayed/daily/batch | 60초 stale threshold 충족 가능성 | polling 30초 가능성 | API key required | rate limit | 무료/유료 정책 | commercial usage | Response timestamp | timestamp meaning | Failure/timeout/retry official guide | sandbox/test environment | raw response mapping to `fx_rate_snapshots` | Major risks | Project fit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Korea Eximbank exchange-rate Open API | `official_batch` candidate | https://www.koreaexim.go.kr/ir/HPHKIR020M01?apino=2&viewtype=C&searchselect=&searchword= and https://www.data.go.kr/data/3068846/openapi.do | 공식 예시 응답에 `cur_unit = USD` and `deal_bas_r`, `kftc_deal_bas_r` fields. USD/KRW equivalent can be mapped as KRW per 1 USD. | Public data listing says update cycle is real-time; Korea Eximbank API notice says non-business day or business day before 11:00 can return null. This behaves closer to official reference/batch for `/fx quote` freshness. | 부적합 가능성이 큼. 공식 문서상 request date and daily/null behavior are documented; 60초보다 짧은 market refresh guarantee는 공식 문서에서 확인하지 못함. | 30초 polling 가능성 미확정. 일일 제한 마감 result code exists, but exact numeric limit is 공식 문서에서 확인하지 못함. | Yes. `authkey` is required. | Exact numeric limit 공식 문서에서 확인하지 못함. Response `RESULT = 4` means daily limit exhausted. Public data listing says traffic differs by institution policy. | Public data listing says free. | Public data listing says license scope has no restriction. Additional commercial terms 추가 확인 필요. | No precise source timestamp in response fields. `searchdate` request date exists. | `searchdate` identifies requested date. `deal_bas_r`/`kftc_deal_bas_r` timestamp finer than date 공식 문서에서 확인하지 못함. | Error/result code exists for data code/auth/daily limit. Timeout/retry guide 공식 문서에서 확인하지 못함. | Sandbox/test environment 공식 문서에서 확인하지 못함. | `rate`: parse comma-free `deal_bas_r` or `kftc_deal_bas_r` for `cur_unit = USD`; `sourceName`: `koreaexim`; `sourceTimestamp`: null or requested date only after policy decision; `effectiveAt`: likely capturedAt or approved official publication time after STOP; `capturedAt`: server collection time; `rawPayloadJson`: full row/response; `sourceType`: `official_batch`. | No second-level timestamp; possible null before publication; 30초 polling and 60초 freshness not confirmed; daily limit numeric value unknown. | Good as official reference/settlement candidate. Weak as `/fx quote` primary. |
| Bank of Korea ECOS API, statistic `731Y001` item `0000001` | `official_batch` candidate | https://ecos.bok.or.kr/api/ and official endpoint examples above | Official `StatisticItemList` sample returns `ITEM_NAME = 원/미국달러(매매기준율)`, `CYCLE = D`, `UNIT_NAME = 원`; `StatisticSearch` returns `DATA_VALUE`. | Daily official statistical time series. | 부적합. Official sample shows daily cycle (`CYCLE = D`), so it cannot by itself satisfy 60초 stale for normal `/fx quote` primary. | 30초 polling 가능성 미확정 and likely pointless for daily series; rate limit 공식 문서에서 확인하지 못함. | Sample key exists; production API key requirement 추가 확인 필요 from ECOS key issuance flow. | 공식 문서에서 확인하지 못함. | 공식 문서에서 확인하지 못함. | Commercial usage 공식 문서에서 확인하지 못함. | Yes, but date-level only: `TIME = YYYYMMDD`. | `TIME` is the statistic observation date, not a second-level collection timestamp. | Error response exists in official API output; timeout/retry guide 공식 문서에서 확인하지 못함. | Sample API key endpoint exists for sample queries; dedicated sandbox 공식 문서에서 확인하지 못함. | `rate`: `DATA_VALUE`; `sourceName`: `bok_ecos_731Y001_0000001`; `sourceTimestamp`: parse `TIME` as date if policy accepts date-level timestamp; `effectiveAt`: likely official observation date or capturedAt after STOP; `capturedAt`: server collection time; `rawPayloadJson`: row/response; `sourceType`: `official_batch`. | Date-only timestamp; daily cadence; usage/commercial terms and rate limits not confirmed in official docs accessed. | Strong official reference/settlement candidate. Not suitable as `/fx quote` primary. |
| Open Exchange Rates | `provider_api` candidate | https://docs.openexchangerates.org/reference/latest-json and https://openexchangerates.org/signup | Supported currencies official page says latest API supports available currencies; KRW support should be confirmed via `currencies.json` or account test before final selection. USD base is default on free plan. | Plan-dependent. Pricing page: free/developer hourly, enterprise 30-minute, unlimited 5-minute, VIP up to 1 second. | Only VIP-level update frequency could satisfy 60초 source freshness. Free/developer/enterprise/unlimited listed plans do not satisfy 60초 stale by source update frequency. | 30초 polling 가능성 미확정. Even unlimited request plan has 5-minute updates; VIP terms must be confirmed. | Yes. `app_id` required. | Pricing lists monthly request quotas by plan; `usage.json` exposes quota/update_frequency. Exact per-second limits 공식 문서에서 확인하지 못함. | Free and paid plans. Free 1,000/month hourly; paid tiers with higher quota/update frequency; VIP by contact. | Paid product appears intended for organizations; explicit commercial usage permission/limits 추가 확인 필요 from terms/service agreement. | Yes. Standard response includes `timestamp`; docs for historical state timestamp is UNIX publish time. | `timestamp` indicates time rates were published. | API status link exists; error/retry/backoff guide 공식 문서에서 확인하지 못함. | No dedicated sandbox found. Free plan can be used for evaluation. | `rate`: `rates.KRW` with base USD; `sourceName`: `open_exchange_rates`; `sourceTimestamp`: `timestamp` Unix seconds; `effectiveAt`: sourceTimestamp if accepted; `capturedAt`: server collection time; `rawPayloadJson`: full response; `sourceType`: `provider_api`. | Non-VIP update frequency too slow; KRW must be explicitly verified; commercial terms need review; VIP pricing/contract needed for 60초. | Possible primary only if VIP 1-second update and terms allow 30초 polling; otherwise reference/fallback only. |
| Currencylayer | `provider_api` candidate | https://currencylayer.com/documentation, https://currencylayer.com/currencies, https://currencylayer.com/pricing | Supported currencies official page lists `KRW South Korean Won`; live endpoint default source is USD and returns `quotes.USDKRW`. | Plan-dependent. Docs/pricing say updates range from 60 minutes, 10 minutes, to 60 seconds; Enterprise+ has 60-second updates. | Borderline. Official plan says 60-second updates, but project stale threshold rejects `now - effectiveAt > 60s`; exactly 60-second provider updates may have no failure margin. 30초 polling cannot make sourceTimestamp fresher than provider update frequency. | 30초 polling 가능성 미확정. Enterprise+ has 500,000 monthly requests, enough for 30초 by rough volume, but exact terms/per-minute policy must be confirmed. | Yes. `access_key` required. | Monthly request allowance by plan; error code 104 when monthly usage limit reached. Per-second/minute rate limit 공식 문서에서 확인하지 못함. | Free and paid. Free daily updates/100 calls; Enterprise+ 60-second updates and 500,000 requests/month. | Pricing page says Basic includes commercial use; broader terms and plan-specific redistribution/display limits 추가 확인 필요. | Yes. `timestamp` returned. | `timestamp` is exact UNIX date/time rates were collected. | API error codes documented. Timeout/retry/backoff guide 공식 문서에서 확인하지 못함. | Dedicated sandbox/test environment 공식 문서에서 확인하지 못함; free sign-up exists. | `rate`: `quotes.USDKRW`; `sourceName`: `currencylayer`; `sourceTimestamp`: `timestamp` Unix seconds; `effectiveAt`: sourceTimestamp if accepted; `capturedAt`: server collection time; `rawPayloadJson`: full response; `sourceType`: `provider_api`. | 60-second update has no margin for a 60초 stale threshold; 30초 polling terms not fully confirmed; monthly quota/overage risk. | Viable candidate only if Enterprise+ or custom terms, sourceTimestamp reliability, and polling policy pass STOP review. |
| Twelve Data | `provider_api` candidate | https://twelvedata.com/docs/llms/currencies/exchange-rate.md and https://twelvedata.com/pricing-business | Official exchange-rate endpoint accepts slash-delimited pairs such as `EUR/USD`; forex product page lists Korean Won as supported. USD/KRW final symbol availability must be confirmed with API key before final selection. | Official docs call exchange_rate real-time and return Unix timestamp. Forex product page says prices update at least once per minute depending on pair. WebSocket price stream provides real-time tick prices. | Possible but not confirmed. "At least once per minute" may still be too tight for 60초 stale if source timestamp can lag. WebSocket may fit better than polling, but this project has not designed streaming ingestion. | 30초 polling 가능성 미확정. Credits reset every minute; plan credits may permit it, but pair-specific update and terms must be confirmed. | Yes. `apikey` required. | API credits per minute by plan; exchange_rate cost is 1 credit per symbol. Running out returns 429 and quota resets each minute for API credits. | Free Basic and paid tiers; business pricing covers external display data access. | Individual pricing says personal/internal/non-commercial; business pricing includes external display data access. Project usage needs business/commercial terms confirmation. | Yes. `timestamp` returned. | Unix timestamp of the rate. | 429 credit exhaustion documented. Timeout/retry/backoff guide 공식 문서에서 확인하지 못함. | Free Basic/trial access exists; dedicated sandbox 공식 문서에서 확인하지 못함. | `rate`: `rate`; `sourceName`: `twelve_data`; `sourceTimestamp`: `timestamp` Unix seconds; `effectiveAt`: sourceTimestamp if accepted; `capturedAt`: server collection time; `rawPayloadJson`: full response; `sourceType`: `provider_api`. | Pair-level update cadence not guaranteed below 60초 in docs; 30초 polling and commercial plan must be confirmed; WebSocket would require separate ingestion design. | Good primary candidate to review further, especially if business plan and sourceTimestamp/pair freshness are confirmed. |
| Alpha Vantage | `provider_api` candidate | https://www.alphavantage.co/documentation/ and https://www.alphavantage.co/premium/ | Official docs allow physical currency `from_currency` and `to_currency`; USD/KRW should be tested with a real key before final selection. Demo key did not confirm USD/KRW. | `CURRENCY_EXCHANGE_RATE` is described as realtime; `FX_INTRADAY` supports 1min/5min/etc and is premium. | `CURRENCY_EXCHANGE_RATE` may satisfy if `Last Refreshed` updates within 60 seconds for USD/KRW under chosen plan, but official pair-specific cadence not confirmed. `FX_INTRADAY` 1min is too tight/no margin. | 30초 polling 가능성 미확정. Free standard limit is too low; premium has no daily limits, but exact short-interval polling policy needs confirmation. | Yes. `apikey` required. | Premium page says standard free limit is 25 requests/day; premium no daily limits. Per-minute/30초 polling terms 공식 문서에서 확인하지 못함. | Free key and paid premium. Some FX intraday endpoints are premium. | Documentation says for commercial use, contact sales in several data sections; commercial terms 추가 확인 필요 for FX use. | Yes in realtime endpoint response: `Last Refreshed` and `Time Zone`; `FX_INTRADAY` has time series timestamps. | `Last Refreshed` is UTC timestamp in response for realtime exchange rate. | Code examples include basic request handling; retry/backoff/timeout guide 공식 문서에서 확인하지 못함. | Demo key exists for limited examples; real USD/KRW validation needs own key. Dedicated sandbox 공식 문서에서 확인하지 못함. | `rate`: `Realtime Currency Exchange Rate["5. Exchange Rate"]`; `sourceName`: `alpha_vantage`; `sourceTimestamp`: parse `6. Last Refreshed` with `7. Time Zone`; `effectiveAt`: sourceTimestamp if accepted; `capturedAt`: server collection time; `rawPayloadJson`: full response; `sourceType`: `provider_api`. | USD/KRW not confirmed with demo; free quota too low; commercial use requires sales confirmation; pair refresh cadence unclear. | Candidate only after real-key USD/KRW and commercial/polling STOP review. |
| exchangerate.host | `provider_api` candidate | https://exchangerate.host/documentation and https://exchangerate.host/pricing | Docs use USD default `source` and currency codes; KRW support should be confirmed through official list endpoint/account before final selection. | Plan-dependent. Docs say Free/Basic 60 minutes, Professional 10 minutes, Business 60 seconds. | Borderline on Business plan; 60-second update has no failure margin for 60초 stale. Lower plans are unsuitable for quote primary. | 30초 polling 가능성 미확정. Business monthly quota likely allows rough 30초 volume, but exact polling terms/per-minute policy 공식 문서에서 확인하지 못함. | Yes. `access_key` required. | Pricing lists monthly requests; overage pricing; exact per-second/minute rate limit 공식 문서에서 확인하지 못함. | Free and paid; Business has 500,000 monthly requests and 60-second updates. | Commercial use permission 공식 문서에서 확인하지 못함; terms/privacy links exist. | Yes. `timestamp` returned. | `timestamp` is exact UNIX date/time rates were collected. | API error codes documented; timeout/retry/backoff guide 공식 문서에서 확인하지 못함. | Dedicated sandbox/test environment 공식 문서에서 확인하지 못함; free plan exists. | `rate`: `quotes.USDKRW`; `sourceName`: `exchangerate_host`; `sourceTimestamp`: `timestamp` Unix seconds; `effectiveAt`: sourceTimestamp if accepted; `capturedAt`: server collection time; `rawPayloadJson`: full response; `sourceType`: `provider_api`. | Business 60-second cadence has no freshness margin; KRW and commercial terms require confirmation; APILayer-style docs similar to Currencylayer but terms still need review. | Possible provider candidate only after terms, KRW, and polling confirmation; not an obvious first choice with 60초 threshold. |
| OANDA Exchange Rates API | `provider_api` candidate | https://www.oanda.com/foreign-exchange-data-services/en/exchange-rates-api/ and https://www.oanda.com/foreign-exchange-data-services/en/exchange-rates-api/api-plans/ | Official pricing says 38,000+ currency pairs and 200+ currencies/precious metals; USD/KRW explicit pair support must be confirmed with trial/docs before final selection. | Real-time rates update every five seconds in official pricing/product pages; also daily average/fixing/reference data. | Strong possibility if USD/KRW is included in contracted data and timestamp is accepted. | 30초 polling likely technically compatible with 5-second updates, but polling terms and quota must be confirmed in contract. Mark as 30초 polling 가능성 미확정. | Yes. API key required. | Plans list 100,000 quotes/month for Lite and unlimited quotes for higher plans. | Paid, high-cost plans; 7-day free trial API key. | Product is business/compliance oriented, but contract terms must be reviewed before use. | Product page says UTC timestamps; detailed response mapping requires API documentation/trial. | UTC timestamp. Exact response field name 공식 문서에서 확인하지 못함 from public pages accessed. | Product page says redundant servers; detailed retry/backoff guide 공식 문서에서 확인하지 못함. | 7-day free API trial. | `rate`: bid/ask/mid selected by policy after API response confirmation; `sourceName`: `oanda`; `sourceTimestamp`: UTC timestamp field after trial/docs confirmation; `effectiveAt`: sourceTimestamp if accepted; `capturedAt`: server collection time; `rawPayloadJson`: full response; `sourceType`: `provider_api`. | High cost; public docs do not expose exact field mapping; contract/trial required; USD/KRW explicit confirmation needed. | Strong primary candidate if budget/contract fit and USD/KRW field mapping is verified. |

## Not Promoted / Official Documentation Check
| Candidate | Result |
| --- | --- |
| Seoul Foreign Exchange Brokerage direct Open API | 공식 API 문서를 이번 조사에서 확인하지 못함. Korea Eximbank exposes `kftc_deal_bas_r`, but a direct official API candidate is not promoted without official docs. |
| Generic web converter pages without API contract | 공식 API docs, pricing, terms, timestamp, and rate-limit confirmation이 없으면 후보에서 제외. |

## Provider API vs Official Batch Conclusion
- `/fx quote` has a 60-second stale threshold, so primary ingestion must use a source that updates faster than 60 seconds or at least gives enough operational margin to keep `effectiveAt` fresh.
- `provider_api` polling remains the primary `/fx quote` ingestion direction.
- `official_batch` sources such as Korea Eximbank and BOK ECOS are better treated as settlement/reference candidates because official documents show daily/date-based behavior or do not provide second-level update guarantees.
- `admin_manual` remains bootstrap/fallback/manual correction only.
- Currencylayer and exchangerate.host list 60-second update tiers, but exactly 60-second update frequency has almost no margin against this project's 60초 stale rule. They remain candidates only after terms, timestamp, and polling review.
- Twelve Data and OANDA look more promising for fresh provider ingestion, but USD/KRW exact availability, commercial usage, API key plan, source timestamp reliability, and 30초 polling permission remain STOP decisions.
- Open Exchange Rates ordinary plans are too slow for primary `/fx quote`; VIP-level 1-second updates could be reviewed if commercial terms and polling are acceptable.
- Alpha Vantage remains a candidate only after real-key USD/KRW validation and commercial/polling review.
- Do not implement anything before provider final selection.

## Mapping To `fx_rate_snapshots`
General candidate mapping:
- Provider rate -> `fx_rate_snapshots.rate`.
- Provider/source name -> `sourceName`.
- Provider timestamp -> `sourceTimestamp`.
- `effectiveAt`:
  - If provider timestamp is reliable and accepted, use `sourceTimestamp`.
  - If provider timestamp is missing, use `capturedAt` only after a source-specific STOP decision.
- `capturedAt`: server collection time.
- `rawPayloadJson`: full upstream raw response or selected raw row.
- `sourceType`: `provider_api` or `official_batch`.

Provider-specific mapping candidates:
- Korea Eximbank: `rate = deal_bas_r` or `kftc_deal_bas_r` for `cur_unit = USD`; `sourceTimestamp` not available beyond request/publication date; `sourceType = official_batch`.
- BOK ECOS: `rate = DATA_VALUE`; `sourceTimestamp = TIME` only as date-level observation timestamp if accepted; `sourceType = official_batch`.
- Open Exchange Rates: `rate = rates.KRW`; `sourceTimestamp = timestamp`; `sourceType = provider_api`.
- Currencylayer: `rate = quotes.USDKRW`; `sourceTimestamp = timestamp`; `sourceType = provider_api`.
- Twelve Data: `rate = rate` from `/exchange_rate?symbol=USD/KRW`; `sourceTimestamp = timestamp`; `sourceType = provider_api`.
- Alpha Vantage: `rate = "5. Exchange Rate"`; `sourceTimestamp = "6. Last Refreshed"` plus `"7. Time Zone"`; `sourceType = provider_api`.
- exchangerate.host: `rate = quotes.USDKRW`; `sourceTimestamp = timestamp`; `sourceType = provider_api`.
- OANDA: `rate = bid/ask/mid` only after rate-basis policy; `sourceTimestamp = UTC timestamp field` after trial/docs confirmation; `sourceType = provider_api`.

## SourceType Priority STOP
Current `/fx quote` selection does not inspect `sourceType`; it selects the latest eligible USD/KRW snapshot by `effectiveAt`, then `capturedAt`, then `createdAt`.

Before mixing `provider_api`, `official_batch`, and `admin_manual`, decide sourceType priority. Options:
- Latest `effectiveAt` first across all source types.
- Prefer `provider_api`, with `admin_manual` fallback.
- Prefer `admin_manual` correction when a fresh manual correction is intentionally inserted.
- Exclude `official_batch` from quote selection and use it only for settlement/reference.

This document does not force a conclusion. SourceType priority remains STOP.

## Implementation STOP Checklist
- Provider final selection.
- API key/secret management.
- Polling interval confirmation.
- Provider timestamp reliability confirmation.
- `sourceType` priority confirmation.
- Retry/backoff policy.
- Failure alerting policy.
- Retention/archive policy.
- Commercial usage and terms confirmation.
- `.env.example`/config reflection decision.
- Scheduler execution model.
- Rate basis decision for bid/ask/mid/reference-rate providers.
- Quote vs execute freshness policy review before `/fx execute`.

## Source Quality Notes
- 모든 provider 정보는 공식 문서만 기준으로 삼음.
- 확인 불가 항목은 추정하지 않음.
- 비공식 블로그/예제/요약은 제외.
- 공식 문서 URL과 확인 날짜를 기록함.
- Web/search 결과 자체가 아니라 provider/source 공식 페이지와 공식 API 응답을 근거로 삼음.
