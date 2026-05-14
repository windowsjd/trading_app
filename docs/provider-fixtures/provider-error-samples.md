# Provider Error / Rate-Limit Evidence Samples

Checked date: 2026-05-14.

This file records official-document error/rate-limit evidence only. No live provider error request was sent because OANDA and Twelve Data credentials were unavailable in the local environment, and Binance error/rate-limit behavior was not intentionally triggered. Binance public success fixtures were captured separately.

## Scope

- No secret values are stored here.
- No Authorization header value is stored here.
- No account id is stored here.
- Request examples use `<redacted>` only.
- No quota-exhaustion or lockout behavior was intentionally triggered.

## OANDA

Official documents checked:

- https://www.oanda.com/foreign-exchange-data-services/en/exchange-rates-api/
- https://www.oanda.com/foreign-exchange-data-services/en/exchange-rates-api/api-plans/

Evidence:

- OANDA Exchange Rates API official pages describe API-key access and a 7-day trial key.
- Exact live error response shape is unverified because no OANDA credential is available.
- Exact rate-limit headers are unverified from the public pages checked in this task.

Safe request template, not called:

```text
GET <oanda-exchange-rates-endpoint-unverified>?<params>&api_key=<redacted>
```

Implementation policy until live evidence exists:

- Treat OANDA invalid-key, invalid-pair, quota/rate-limit, timeout, and malformed-response cases as no-insert provider failures.
- Do not create `fx_rate_snapshots` rows when OANDA response timestamp, bid/ask/midpoint fields, or rate basis cannot be parsed.
- Requires provider clarification for exact HTTP status/body shape and contractual polling limits.

## Twelve Data

Official documents checked:

- https://twelvedata.com/docs
- https://support.twelvedata.com/en/articles/5615854-credits
- https://twelvedata.com/pricing
- https://twelvedata.com/pricing-business

Evidence:

- Twelve Data support docs state API credits reset every minute.
- Twelve Data support docs state HTTP 429 indicates API credits limit reached.
- Twelve Data support docs state Basic daily quota resets at midnight UTC and paid plans have no daily limits.
- Twelve Data support docs state response headers include `api-credits-used` and `api-credits-left`.
- Exact project-account JSON error body is unverified because no `TWELVE_DATA_API_KEY` is available.

Safe request templates, not called:

```text
GET https://api.twelvedata.com/exchange_rate?symbol=USD/KRW&apikey=<redacted>
GET https://api.twelvedata.com/quote?symbol=AAPL&apikey=<redacted>
```

Implementation policy until live evidence exists:

- Treat 429, quota exhaustion, timeout, invalid symbol, invalid key, and malformed response as no-insert provider failures.
- Do not create `fx_rate_snapshots` or `asset_price_snapshots` rows from responses missing a usable provider timestamp.
- Do not fall back to fake/static/sample data or silent `admin_manual` rows.

## Binance

Policy status:

- Binance is the MVP crypto provider target.
- Crypto is USD-settled internally and uses the USD Wallet.
- Public fixture targets `BTCUSDT` ticker and `BTCUSDT` orderbook were captured as success fixtures.
- No private key is required for public market-data fixture capture.
- `CurrencyCode.USDT` must not be added; USDT-to-USD-equivalent normalization versus Binance USD quote pair requirement remains an owner decision.

Safe public success request templates, called once each for fixture capture:

```text
GET https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT
GET https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=5
```

Implementation policy until live evidence exists:

- Treat Binance timeout, rate limit, invalid symbol, malformed response, and missing timestamp as no-insert provider failures.
- Do not create `asset_price_snapshots` rows until fixture mapping fixes price field, timestamp -> `effectiveAt`, `sourceName`, and USD-equivalent policy.
- Do not store secrets; public endpoints must not require API key/Authorization headers for MVP fixture capture.

## Live Error Capture Status

| Provider | Evidence type | Live call made? | Status | Reason |
|---|---|---|---|---|
| OANDA | Error/rate-limit | No | `BLOCKED` | Credentials unavailable; no safe live request possible |
| Twelve Data | Error/rate-limit | No | `BLOCKED` | `TWELVE_DATA_API_KEY` unavailable; no safe live request possible |
| Binance | Error/rate-limit | No | `NOT CAPTURED` | Success fixtures captured; error/rate-limit triggering intentionally avoided |
| Binance | Public success fixture | Yes | `CAPTURED` | `BTCUSDT` ticker and orderbook public endpoints returned HTTP 200 without auth |

## Redaction Review

| Item | Result |
|---|---|
| Actual API key stored | No |
| Actual Authorization header stored | No |
| Actual account id stored | No |
| Actual token/secret stored | No |
| Personal data stored | No |
| Request URL with real query credential stored | No |
