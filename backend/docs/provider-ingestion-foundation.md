# Provider Ingestion Foundation

Explicit operator-run provider ingestion foundation, including an operator/admin HTTP trigger. Scheduler/Ops integration is documented separately in `docs/scheduler-ops-foundation.md`; KIS real-time price ingestion is owned by the long-lived WebSocket streaming service, while scheduler KIS jobs are fallback/manual/debug one-shot runs. Read-only/quote and operator-run daily snapshot `provider_api` source eligibility are implemented separately for the allowed workflows only (see `docs/policy-decisions.md`).

The fixed 40-symbol KIS stock watchlist (15 domestic + 25 US) is defined in code at `src/providers/kis/kis-fixed-asset-universe.ts` and used as the default for `KIS_DOMESTIC_SYMBOLS`/`KIS_US_SYMBOLS` when those env vars are unset. Seed the corresponding assets with `pnpm tsx scripts/seed-kis-fixed-asset-universe.ts`.

## Scope

This foundation supports market data provider configuration, secret redaction, raw payload truncation, Korea EXIM exchange USD/KRW snapshot ingestion, ExchangeRate-API USD/KRW snapshot ingestion, Binance public crypto price snapshot ingestion, KIS WebSocket trade price snapshot ingestion, KIS REST current-price ingestion, KIS REST hoga/orderbook snapshot ingestion, and an operator/admin HTTP trigger for these market-data paths.

This project remains a virtual trading app. External provider APIs are used only for market data evidence. Real orders, account linkage, balances, deposits, withdrawals, fills, and trading endpoints are not implemented.

## Implemented Providers

### Korea EXIM Exchange

- Source name is `korea_exim_exchange_rate`.
- Uses `GET https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON`.
- Sends `authkey`, KST `YYYYMMDD` `searchdate`, and `data=AP01`.
- Reads the USD row by `CUR_UNIT`/`cur_unit` with case-insensitive `USD` prefix matching.
- Parses `DEAL_BAS_R`/`deal_bas_r` as KRW per 1 USD after removing commas, then stores it at 8 decimal places.
- Looks back from the current KST date through `KOREA_EXIM_EXCHANGE_LOOKBACK_DAYS` to tolerate weekends, holidays, or no-data dates.
- Inserts `fx_rate_snapshots` rows with `sourceType=provider_api`, `sourceName=korea_exim_exchange_rate`, `baseCurrency=USD`, `quoteCurrency=KRW`, `effectiveAt=<searchDate KST 00:00 converted to UTC>`, and `capturedAt=<provider receive time>`.
- Stores only safe metadata such as provider, searchDate, curUnit, curName, and dealBasR. It does not store the full raw provider payload.
- Actual auth keys must live only in `.env.local`; `.env.example` keeps `KOREA_EXIM_EXCHANGE_AUTH_KEY=` blank. Error messages and responses must not expose auth keys or full request URLs.
- `/fx quote`, `/fx execute`, and `GET /api/v1/fx/rates/current` prefer this provider when fresh/available.

### ExchangeRate-API

- Uses `/v6/{API_KEY}/latest/USD`.
- Reads `conversion_rates.KRW` as KRW per 1 USD.
- Inserts `fx_rate_snapshots` rows with `sourceType=provider_api`, `baseCurrency=USD`, and `quoteCurrency=KRW`.
- Uses provider update time when present; otherwise uses the server receive time as `effectiveAt`.
- Supports dry-run with fetch and parse, but no DB write.
- Does not print or store the API key in result output or raw payload JSON.

### Binance Public Market Data

- Uses public REST market data only.
- Does not use Binance API key or secret.
- Uses configured symbols such as `BTCUSDT` and `ETHUSDT`.
- Inserts `asset_price_snapshots` rows with `sourceType=provider_api` and `currencyCode=USD` only when an existing active `BINANCE` crypto asset mapping is unambiguous.
- Does not create fake assets.
- MVP treats Binance USDT quote pairs as USD-equivalent for internal USD snapshot storage. USDT depeg risk is not modeled in this MVP foundation.
- WebSocket ingestion is not implemented.

### KIS

- Adds appkey/appsecret config parsing and secret redaction.
- Adds REST token response parsing and WebSocket approval key response parsing foundation.
- Adds WebSocket approval key convenience request using `POST /oauth2/Approval` with `grant_type=client_credentials`, `appkey`, and `secretkey`.
- Adds KIS WebSocket trade-price subscription builders and parsers for:
  - Domestic KRX real-time trade price `H0STCNT0`.
  - Overseas/US delayed trade price `HDFSCNT0`.
- Adds a NestJS lifecycle-owned long-lived KIS WebSocket streaming service gated by `KIS_WEBSOCKET_STREAMING_ENABLED`.
  - It uses the in-memory `KisAuthClient` approval-key cache. Process restart clears that cache; persistent approval-key cache can be considered later without a schema change in this foundation.
  - It keeps the socket open, unsubscribes on backend shutdown, reconnects with backoff after disconnects, and resubscribes the watchlist after reconnect.
  - It updates an in-memory latest-price cache on every tick and publishes safe internal latest-price events for `/api/v1/ws` integration.
  - It still writes DB snapshots through the existing `KIS_WS_SNAPSHOT_THROTTLE_MS` throttle and existing redaction/source/currency rules.
- Adds KIS REST current-price ingestion for:
  - Domestic KRX current price using configurable path/TR ID defaults `KIS_REST_DOMESTIC_CURRENT_PRICE_PATH=/uapi/domestic-stock/v1/quotations/inquire-price` and `KIS_REST_DOMESTIC_CURRENT_PRICE_TR_ID=FHKST01010100`.
  - US current price using configurable path/TR ID defaults `KIS_REST_US_CURRENT_PRICE_PATH=/uapi/overseas-price/v1/quotations/price` and `KIS_REST_US_CURRENT_PRICE_TR_ID=HHDFS00000300`.
- Adds KIS REST hoga/orderbook snapshot ingestion for:
  - Domestic KRX hoga using configurable path/TR ID defaults `KIS_REST_DOMESTIC_HOGA_PATH=/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn` and `KIS_REST_DOMESTIC_HOGA_TR_ID=FHKST01010200`.
  - US hoga using configurable path/TR ID defaults `KIS_REST_US_HOGA_PATH=/uapi/overseas-price/v1/quotations/inquire-asking-price` and `KIS_REST_US_HOGA_TR_ID=HHDFS76200100`.
- Inserts `asset_price_snapshots` rows with `sourceType=provider_api` only when an existing active asset mapping is unambiguous:
  - Domestic: `sourceName=kis_krx_realtime_trade`, `currencyCode=KRW`, `assetType=domestic_stock`, 6-digit symbol, KRX/KOSPI/KOSDAQ/KONEX market family.
  - US: `sourceName=kis_us_delayed_trade`, `currencyCode=USD`, `assetType=us_stock`, NAS/NASDAQ, NYS/NYSE, or AMS/AMEX market mapping.
- REST current-price ingestion deliberately reuses the existing eligible trade source names above so quote/execute source eligibility remains aligned.
- Hoga/orderbook ingestion inserts only `asset_orderbook_snapshots` rows with `sourceType=provider_api`, source names `kis_krx_realtime_hoga` or `kis_us_delayed_hoga`, bid/ask/quantity/spread_bps, currency, effective/captured timestamps, and redacted/truncated raw payload metadata. Hoga rows are not used for order quote/create/execute pricing.
- Uses KIS source timestamps from `BSOP_DATE + STCK_CNTG_HOUR` or `KYMD + KHMS` as Asia/Seoul time converted to UTC. If parsing fails, server receive time is used while preserving sanitized raw payload.
- Stores prices as decimal strings at 8-digit scale, applies per-asset snapshot throttle, skips exact duplicate snapshots, and supports dry-run without DB writes.
- Adds watchlist policy: `KIS_DOMESTIC_SYMBOLS + KIS_US_SYMBOLS` unique normalized total must be at most `KIS_MAX_WATCHLIST_SIZE`, default 41.
- `KIS_US_SYMBOLS` preferred format is `NAS:AAPL,NYS:IBM,AMS:SPY`. Bare symbols such as `AAPL` are resolved from existing active asset market mapping when unambiguous.
- If `KIS_REST_BASE_URL` or `KIS_WS_BASE_URL` is empty, KIS live calls are skipped. This does not fail ExchangeRate-API or Binance ingestion.
- US free delayed feed is allowed for MVP row insertion only; US is documented by KIS as 0-minute delayed/free data. Hong Kong, Vietnam, China, and Japan delayed markets are not allowed in this MVP and are skipped.
- KIS order, account, balance, fill, deposit, withdrawal, and real trading APIs are not implemented.
- Best bid/ask execution, partial fills, slippage models, and use of hoga data for execution are not implemented.

## Env

Common:

- `PROVIDER_INGESTION_ENABLED`
- `PROVIDER_HTTP_TIMEOUT_MS`
- `PROVIDER_RAW_PAYLOAD_MAX_BYTES`

ExchangeRate-API:

- `EXCHANGE_RATE_API_ENABLED`
- `EXCHANGE_RATE_API_KEY`
- `EXCHANGE_RATE_API_BASE_URL`

Korea EXIM exchange:

- `KOREA_EXIM_EXCHANGE_ENABLED`
- `KOREA_EXIM_EXCHANGE_AUTH_KEY`
- `KOREA_EXIM_EXCHANGE_BASE_URL`
- `KOREA_EXIM_EXCHANGE_DATA`
- `KOREA_EXIM_EXCHANGE_LOOKBACK_DAYS`

Binance:

- `BINANCE_PUBLIC_MARKET_DATA_ENABLED`
- `BINANCE_REST_BASE_URL`
- `BINANCE_WS_MARKET_DATA_BASE_URL`
- `BINANCE_CRYPTO_SYMBOLS`
- `BINANCE_CRYPTO_USDT_AS_USD_EQUIVALENT`

KIS:

- `KIS_MARKET_DATA_ENABLED`
- `KIS_APP_KEY`
- `KIS_APP_SECRET`
- `KIS_REST_BASE_URL`
- `KIS_WS_BASE_URL`
- `KIS_REST_DOMESTIC_CURRENT_PRICE_PATH`
- `KIS_REST_DOMESTIC_CURRENT_PRICE_TR_ID`
- `KIS_REST_US_CURRENT_PRICE_PATH`
- `KIS_REST_US_CURRENT_PRICE_TR_ID`
- `KIS_REST_DOMESTIC_HOGA_PATH`
- `KIS_REST_DOMESTIC_HOGA_TR_ID`
- `KIS_REST_US_HOGA_PATH`
- `KIS_REST_US_HOGA_TR_ID`
- `KIS_MAX_WATCHLIST_SIZE`
- `KIS_DOMESTIC_SYMBOLS`
- `KIS_US_SYMBOLS`
- `KIS_WS_CUSTTYPE`
- `KIS_WS_DOMESTIC_TR_ID`
- `KIS_WS_OVERSEAS_DELAYED_TR_ID`
- `KIS_WS_SNAPSHOT_THROTTLE_MS`
- `KIS_WS_MAX_RUNTIME_MS`
- `KIS_WS_ALLOW_US_DELAYED`
- `KIS_WEBSOCKET_STREAMING_ENABLED`
- `KIS_WEBSOCKET_STREAMING_RECONNECT_MIN_MS`
- `KIS_WEBSOCKET_STREAMING_RECONNECT_MAX_MS`
- `KIS_WEBSOCKET_STREAMING_HEARTBEAT_TIMEOUT_MS`

KIS non-secret endpoint examples:

- `KIS_REST_BASE_URL` live approval-key domain: `https://openapi.koreainvestment.com:9443`
- `KIS_REST_BASE_URL` mock approval-key domain: `https://openapivts.koreainvestment.com:29443`
- `KIS_WS_BASE_URL` live trade WebSocket domain: `ws://ops.koreainvestment.com:21000`
- `KIS_WS_BASE_URL` domestic mock trade WebSocket domain: `ws://ops.koreainvestment.com:31000`
- KIS overseas delayed trade WebSocket is not supported in mock investment mode.

Live smoke:

- `ENABLE_PROVIDER_LIVE_SMOKE`

`.env.example` contains variable names only. Production or local secret values must not be committed.

## Operator Commands

FX:

```bash
pnpm tsx scripts/provider-ingest-fx-rate.ts --dry-run --base USD --requested-by local-operator
```

Binance:

```bash
pnpm tsx scripts/provider-ingest-binance-prices.ts --dry-run --symbols BTCUSDT,ETHUSDT --requested-by local-operator
```

KIS WebSocket trade prices:

```bash
pnpm tsx scripts/provider-ingest-kis-websocket-prices.ts --dry-run --duration-ms 30000 --domestic-symbols 005930,000660 --us-symbols NAS:AAPL,NYS:IBM --requested-by local-operator
```

Operator/admin HTTP trigger:

```http
POST /api/v1/operator/provider-ingestions/binance/run
POST /api/v1/operator/provider-ingestions/kis/run
```

Example body:

```json
{
  "dryRun": true,
  "symbols": ["005930", "NAS:AAPL"],
  "maxSnapshots": 20,
  "kisModes": ["rest_current_price", "rest_hoga"],
  "reason": "manual_smoke"
}
```

Supported provider path values are `exchange-rate`, `korea-exim`, `binance`, and `kis`. `dryRun` defaults to `true`; non-dry-run requires explicit `"dryRun": false`. The HTTP trigger writes safe `OperatorAuditLog` metadata and returns aggregate summaries only. Raw provider payloads, access tokens, approval keys, app keys/secrets, and `.env.local` contents are not returned.

All scripts and HTTP triggers are explicit operator actions. Scheduler-owned provider ingestion is configured through the separate Scheduler/Ops foundation; no batch HTTP API is added here.

## Boundaries

- `provider_api` snapshot rows can now be inserted by explicit provider ingestion services and by the Korea EXIM refresh path used when `/fx` needs a current USD/KRW provider row.
- Provider_api rows are eligible only for `/fx quote`, assets `withPrice`, orders quote, live portfolio valuation, home live valuation, positions live valuation, and operator-run daily snapshot valuation.
- Korea EXIM exchange and ExchangeRate-API can create provider_api USD/KRW rows. Fresh `korea_exim_exchange_rate` rows are preferred, fresh `exchange_rate_api` rows remain fallback, and `/fx quote`/allowed read-only USD/KRW conversion keep safe `admin_manual` fallback.
- `/fx execute` requires fresh provider_api USD/KRW and does not open default `admin_manual` fallback.
- `admin_manual` fallback eligibility in the existing financial paths remains available where the workflow already allowed manual data.
- Provider outages, parse errors, missing mappings, and rate limits must not create fake rows.
- KIS WebSocket trade price ingestion can create provider_api rows, and fresh KRX/NAS/NYS rows may power allowed read-only/quote workflows plus operator-run daily snapshot valuation only.
- Binance user data streams are not used.
- KIS REST current-price ingestion can create provider_api stock price rows for mapped domestic/US assets.
- KIS REST hoga/orderbook ingestion can create `asset_orderbook_snapshots` rows for mapped domestic/US assets.
- KIS order, account, balance, fill, deposit, withdrawal, and real trading APIs are not implemented.
- `CurrencyCode.USDT` is not added.
