# Provider Ingestion Foundation

Status: implemented foundation for explicit operator-run provider ingestion, no cron scheduler.

## Scope

This foundation supports market data provider configuration, secret redaction, raw payload truncation, ExchangeRate-API USD/KRW snapshot ingestion, Binance public crypto price snapshot ingestion, and KIS market data skeleton work.

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
- Adds low-level explicit-path market data client skeleton only.
- Adds watchlist policy: `KIS_DOMESTIC_SYMBOLS + KIS_US_SYMBOLS` unique normalized total must be at most `KIS_MAX_WATCHLIST_SIZE`, default 41.
- If `KIS_REST_BASE_URL` or `KIS_WS_BASE_URL` is empty, KIS live calls are skipped. This does not fail ExchangeRate-API or Binance ingestion.
- KIS domestic or US stock quote ingestion is not implemented in this gate.

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

Both scripts are explicit operator commands. No cron scheduler or admin HTTP ingestion API is added.

## Boundaries

- `provider_api` snapshot rows can now be inserted by explicit provider ingestion services.
- Existing quote, execute, asset list/detail, portfolio valuation, daily snapshot, ranking, settlement, and reward behavior is not switched to provider_api eligibility in this gate.
- `admin_manual` source eligibility in the existing financial paths remains unchanged.
- Provider outages, parse errors, missing mappings, and rate limits must not create fake rows.
- WebSocket ingestion remains a future gate.
- Binance user data streams are not used.
- KIS real-time WebSocket connection and quote subscription are not implemented.
- KIS order, account, balance, fill, deposit, withdrawal, and real trading APIs are not implemented.
- `CurrencyCode.USDT` is not added.

## Next Gate

Recommended next gate: provider_api source eligibility decision and tests.

That gate should decide which provider_api rows can power quote, execute, live valuation, daily snapshots, and final settlement. It should also define stale thresholds, source priority, provider outage behavior, and WebSocket ingestion ownership.
