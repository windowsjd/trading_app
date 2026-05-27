# Provider Ingestion Foundation

Status: implemented foundation for explicit operator-run provider ingestion, no cron scheduler.

## Scope

This foundation supports market data provider configuration, secret redaction, raw payload truncation, ExchangeRate-API USD/KRW snapshot ingestion, Binance public crypto price snapshot ingestion, and KIS WebSocket trade price snapshot ingestion foundation.

This project remains a virtual trading app. External provider APIs are used only for market data evidence. Real orders, account linkage, balances, deposits, withdrawals, fills, and trading endpoints are not implemented.

## Implemented Providers

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
- Inserts `asset_price_snapshots` rows with `sourceType=provider_api` only when an existing active asset mapping is unambiguous:
  - Domestic: `sourceName=kis_krx_realtime_trade`, `currencyCode=KRW`, `assetType=domestic_stock`, 6-digit symbol, KRX/KOSPI/KOSDAQ/KONEX market family.
  - US: `sourceName=kis_us_delayed_trade`, `currencyCode=USD`, `assetType=us_stock`, NAS/NASDAQ, NYS/NYSE, or AMS/AMEX market mapping.
- Uses KIS source timestamps from `BSOP_DATE + STCK_CNTG_HOUR` or `KYMD + KHMS` as Asia/Seoul time converted to UTC. If parsing fails, server receive time is used while preserving sanitized raw payload.
- Stores prices as decimal strings at 8-digit scale, applies per-asset snapshot throttle, skips exact duplicate snapshots, and supports dry-run without DB writes.
- Adds watchlist policy: `KIS_DOMESTIC_SYMBOLS + KIS_US_SYMBOLS` unique normalized total must be at most `KIS_MAX_WATCHLIST_SIZE`, default 41.
- `KIS_US_SYMBOLS` preferred format is `NAS:AAPL,NYS:IBM,AMS:SPY`. Bare symbols such as `AAPL` are resolved from existing active asset market mapping when unambiguous.
- If `KIS_REST_BASE_URL` or `KIS_WS_BASE_URL` is empty, KIS live calls are skipped. This does not fail ExchangeRate-API or Binance ingestion.
- US free delayed feed is allowed for MVP row insertion only; US is documented by KIS as 0-minute delayed/free data. Hong Kong, Vietnam, China, and Japan delayed markets are not allowed in this MVP and are skipped.
- KIS REST current-price quote ingestion is not implemented in this gate.
- KIS order, account, balance, fill, deposit, withdrawal, and real trading APIs are not implemented.
- KIS orderbook/hoga WebSocket, best bid/ask execution, partial fills, and slippage are not implemented.

## Env

Common:

- `PROVIDER_INGESTION_ENABLED`
- `PROVIDER_HTTP_TIMEOUT_MS`
- `PROVIDER_RAW_PAYLOAD_MAX_BYTES`

ExchangeRate-API:

- `EXCHANGE_RATE_API_ENABLED`
- `EXCHANGE_RATE_API_KEY`
- `EXCHANGE_RATE_API_BASE_URL`

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
- `KIS_MAX_WATCHLIST_SIZE`
- `KIS_DOMESTIC_SYMBOLS`
- `KIS_US_SYMBOLS`
- `KIS_WS_CUSTTYPE`
- `KIS_WS_DOMESTIC_TR_ID`
- `KIS_WS_OVERSEAS_DELAYED_TR_ID`
- `KIS_WS_SNAPSHOT_THROTTLE_MS`
- `KIS_WS_MAX_RUNTIME_MS`
- `KIS_WS_ALLOW_US_DELAYED`

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

All scripts are explicit operator commands. No cron scheduler or admin HTTP ingestion API is added.

## Boundaries

- `provider_api` snapshot rows can now be inserted by explicit provider ingestion services.
- Existing quote, execute, asset list/detail, portfolio valuation, daily snapshot, ranking, settlement, and reward behavior is not switched to provider_api eligibility in this gate.
- ExchangeRate-API can create provider_api USD/KRW rows, but `/fx quote` remains `admin_manual` only. A newer provider_api FX row must not power quote until the source eligibility gate opens it.
- `admin_manual` source eligibility in the existing financial paths remains unchanged.
- Provider outages, parse errors, missing mappings, and rate limits must not create fake rows.
- KIS WebSocket trade price ingestion can create provider_api rows, but source eligibility remains closed.
- Binance user data streams are not used.
- KIS REST current-price ingestion is not implemented.
- KIS WebSocket orderbook/hoga ingestion is not implemented.
- KIS order, account, balance, fill, deposit, withdrawal, and real trading APIs are not implemented.
- `CurrencyCode.USDT` is not added.

## Next Gate

Recommended next gate: provider_api source eligibility decision and tests.

That gate should decide which provider_api rows can power quote, execute, live valuation, daily snapshots, and final settlement. It should also define stale thresholds, source priority, provider outage behavior, live smoke evidence requirements, and whether delayed/free KIS rows are acceptable for any product workflow.
