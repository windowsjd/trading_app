# Provider Error / Rate-Limit Evidence Samples

Checked date: 2026-05-13.

This file records official-document evidence only. No live provider error request was sent because OANDA and Twelve Data credentials were unavailable in the local environment.

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
GET https://api.twelvedata.com/exchange_rate?symbol=BTC/USD&apikey=<redacted>
```

Implementation policy until live evidence exists:

- Treat 429, quota exhaustion, timeout, invalid symbol, invalid key, and malformed response as no-insert provider failures.
- Do not create `fx_rate_snapshots` or `asset_price_snapshots` rows from responses missing a usable provider timestamp.
- Do not fall back to fake/static/sample data or silent `admin_manual` rows.

## Live Error Capture Status

| Provider | Evidence type | Live call made? | Status | Reason |
|---|---|---|---|---|
| OANDA | Error/rate-limit | No | `BLOCKED` | Credentials unavailable; no safe live request possible |
| Twelve Data | Error/rate-limit | No | `BLOCKED` | `TWELVE_DATA_API_KEY` unavailable; no safe live request possible |

## Redaction Review

| Item | Result |
|---|---|
| Actual API key stored | No |
| Actual Authorization header stored | No |
| Actual account id stored | No |
| Actual token/secret stored | No |
| Personal data stored | No |
| Request URL with real query credential stored | No |
