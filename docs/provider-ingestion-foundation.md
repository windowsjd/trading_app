# Provider Ingestion Foundation

Status: implemented foundation for explicit operator-run provider ingestion, no cron scheduler. Read-only/quote provider_api source eligibility is implemented separately for the allowed workflows only.

Fixed KIS stock universe status as of 2026-05-30 KST:

- KIS stock watchlist is fixed at 40 symbols: 15 domestic KRX stocks and 25 US stocks.
- The universe is a fixed high-liquidity watchlist candidate selected by project decision. It is not a new Codex stock investigation and does not claim official YTD rank verification.
- `KIS_DOMESTIC_SYMBOLS=005930,000660,034020,010140,042660,005380,000270,035420,035720,068270,051910,066570,086520,247540,028300`
- `KIS_US_SYMBOLS=NAS:NVDA,NAS:TSLA,NAS:AMD,NAS:AAPL,NAS:AMZN,NAS:MSFT,NAS:GOOGL,NAS:META,NAS:PLTR,NAS:INTC,NAS:SOFI,NAS:RIVN,NAS:MARA,NAS:WBD,NAS:CSCO,NAS:MU,NAS:QCOM,NAS:PYPL,NAS:MSTR,NAS:SMCI,NYS:F,NYS:BAC,NYS:PFE,NYS:T,NYS:UBER`
- Local watchlist policy validation returned domestic 15, US 25, total 40, max 41, within limit.
- Binance `BTCUSDT` and `ETHUSDT` remain separate crypto assets and are not included in the KIS stock watchlist.
- After the local DB was started on 2026-05-30, all fixed 40 stock assets were upserted successfully and DB mapping counts passed: domestic 15/15, US 25/25, KIS total 40/41.
- ExchangeRate and Binance dry-runs succeeded after DB restart; Binance `BTCUSDT` and `ETHUSDT` mapped to existing active `BINANCE` USD crypto assets.
- KIS live smoke remained blocked on 2026-05-30 because KIS REST/WS endpoint env values were missing in the loaded env. Explicit WebSocket policy env values were also absent, but code defaults are defined.
- `provider_api` source eligibility is open only for the 2026-06-03 read-only/quote workflows. Execute/write, daily snapshot, ranking, settlement, reward, scheduler/cron, provider trigger APIs, and real trading/account surfaces remain closed.

KIS env completion pre-gate update as of 2026-05-30 KST:

- Required KIS live smoke env is still incomplete because `KIS_REST_BASE_URL` and `KIS_WS_BASE_URL` are missing in the loaded env.
- KIS policy env values are not present but have explicit code defaults: custtype `P`, domestic TR `H0STCNT0`, overseas delayed TR `HDFSCNT0`, snapshot throttle `5000`, max runtime `30000`, and US delayed enabled `true`.
- The fixed CLI watchlist remains domestic 15 plus US 25, total 40 within the max 41 limit.
- DB mapping recheck passed for domestic 15/15, US 25/25, and separate Binance crypto 2/2.
- ExchangeRate-API and Binance public REST regression dry-runs succeeded.
- KIS approval_key, WebSocket connect, subscribe ack, domestic tick, US tick, and KIS DB insertion remain `BLOCKED` before request because the required endpoints are absent.
- `docs/provider-source-eligibility-pre-gate.md` documents the next source eligibility policy draft. No read path has been changed.

KIS endpoint env completion gate update as of 2026-05-30 KST:

- Required endpoint env is still incomplete: `KIS_REST_BASE_URL` and `KIS_WS_BASE_URL` are missing in the loaded env.
- KIS dry-run and non-dry-run live smoke were not executed.
- DB mapping remains valid for domestic 15/15, US 25/25, KIS watchlist 40/41, and separate Binance crypto 2/2.
- ExchangeRate-API and Binance public REST regression dry-runs succeeded.
- Provider API Source Eligibility Implementation Gate remains after KIS live evidence capture.

KIS endpoint env completion retry as of 2026-06-01 KST:

- `.env.local` was confirmed ignored/untracked before editing, then updated only with non-secret KIS endpoint/policy env keys. Secret values and `.env.local` contents were not printed or documented.
- Expected endpoint env is present: `KIS_REST_BASE_URL=https://openapi.koreainvestment.com:9443` and `KIS_WS_BASE_URL=ws://ops.koreainvestment.com:21000`.
- KIS policy env is present for custtype `P`, domestic TR `H0STCNT0`, overseas delayed TR `HDFSCNT0`, snapshot throttle `5000`, max runtime `30000`, and US delayed enabled `true`.
- The fixed CLI watchlist remains domestic 15 plus US 25, total 40 within the max 41 limit.
- DB mapping recheck passed for domestic 15/15, US 25/25 with NAS 20 and NYS 5, and separate Binance crypto 2/2.
- KIS dry-run succeeded with 40 subscriptions sent, 40 subscribe acknowledgements, 47 received frames, domestic `H0STCNT0` tick evidence, 12 `wouldCreate`, and no DB writes.
- KIS non-dry-run succeeded with 40 subscriptions sent, 40 subscribe acknowledgements, 62 received frames, 12 created domestic provider_api rows, 35 duplicate/throttle skips, and 0 failures.
- DB evidence confirmed the 12 inserted KIS rows are `sourceType=provider_api`, `sourceName=kis_krx_realtime_trade`, `currencyCode=KRW`, mapped to active KRX domestic_stock assets.
- US `HDFSCNT0` subscriptions were acknowledged, but no US tick or `kis_us_delayed_trade` DB row was observed in the 30-second smoke window. This remains an open evidence item.
- ExchangeRate-API and Binance public REST regression dry-runs succeeded.
- `provider_api` source eligibility remains closed outside the explicitly allowed read-only/quote workflows.

KIS US `HDFSCNT0` retry as of 2026-06-01 KST:

- Retry ran around 2026-06-01 11:14-11:21 KST, which is 2026-05-31 22:14-22:21 EDT and outside the US regular market window.
- `.env.local` stayed ignored/untracked and was not modified. No secret values or `.env.local` contents were printed or documented.
- Required KIS env and WebSocket policy env were present. The fixed US CLI watchlist was supplied for the smoke command.
- DB mapping recheck passed for US 25/25 with NAS 20 and NYS 5, domestic 15/15, and separate Binance crypto 2/2.
- A first US-focused dry-run with one domestic symbol sent 26 subscriptions and received acknowledgement count 26, but domestic ticks reached the max snapshot cap before a useful US wait window completed.
- A second US-only 60-second dry-run sent 25 US subscriptions, received aggregate acknowledgement count 30, received 30 frames, and completed with `created=0`, `wouldCreate=0`, `failed=0`, and no snapshots.
- US `HDFSCNT0` tick remains unobserved and `kis_us_delayed_trade` provider_api DB row count remains 0. The result is classified as `SUBSCRIBE_ACK_BUT_NO_US_TICK` / `MARKET_CLOSED_OR_NO_TICK`.
- Non-dry-run was skipped because dry-run did not produce US tick evidence. Existing domestic `kis_krx_realtime_trade` provider_api row count remains 12.
- ExchangeRate-API and Binance public REST regression dry-runs succeeded.
- `provider_api` source eligibility remains closed outside the explicitly allowed read-only/quote workflows.

KIS US `HDFSCNT0` market-data window validation as of 2026-06-03 KST:

- Retry ran around 2026-06-03 00:23 KST, which is 2026-06-02 11:23 EDT and within the US regular market window.
- `.env.local` stayed ignored/untracked and was not modified. No secret values or `.env.local` contents were printed or documented.
- Required KIS env and WebSocket policy env were present by presence-only check.
- Local PostgreSQL was unreachable at `127.0.0.1:5432`; `pnpm exec prisma migrate dev`, `pnpm exec prisma migrate status`, and provider dry-runs could not complete DB-backed checks.
- US-only KIS dry-run reached the US tick parsing/asset mapping path, then failed on DB mapping lookup with Prisma `P1001`. This gives partial US tick-path evidence but not clean dry-run counts or DB insertion evidence.
- Non-dry-run was skipped because local DB insertion was unavailable.
- ExchangeRate-API and Binance public REST regression dry-runs were also blocked by the same local DB unreachable condition.
- `provider_api` source eligibility remains closed outside the explicitly allowed read-only/quote workflows.

KIS US `HDFSCNT0` DB-started rerun as of 2026-06-03 KST:

- Docker Compose Postgres/Redis were healthy and pending existing migrations were applied without DB reset, seed, schema edit, or new migration creation.
- Migration status reported DB schema up to date. Runtime schema checks passed for `UserRole`, `OperatorAuditResult`, `users.role`, and `operator_audit_logs`.
- DB mapping passed for active US 25/25 with NAS 20 and NYS 5, domestic KRX 15/15, and separate BINANCE crypto 2/2.
- US-only dry-run completed with 25 subscriptions sent, 25 acknowledgements, 50 received frames, 35 `wouldCreate`, and 0 failures.
- US-only non-dry-run completed with 25 subscriptions sent, 25 acknowledgements, 86 received frames, 25 created, 53 skipped, and 0 failures.
- DB evidence confirmed 25 inserted `kis_us_delayed_trade` rows are `sourceType=provider_api`, `currencyCode=USD`, mapped to active `us_stock` USD assets with NAS 20 / NYS 5 market distribution.
- Existing domestic `kis_krx_realtime_trade` provider_api row count remained 12. This US-only rerun created no domestic side effect.
- ExchangeRate-API and Binance public REST regression dry-runs succeeded.
- `provider_api` source eligibility remains closed outside the explicitly allowed read-only/quote workflows.

Live smoke evidence status as of 2026-05-28 KST:

- ExchangeRate-API dry-run and non-dry-run live smoke succeeded and created one local `fx_rate_snapshots` row with `sourceType=provider_api`, `sourceName=exchange_rate_api`, `USD/KRW`, and positive decimal rate evidence.
- Binance public REST dry-run and non-dry-run live smoke succeeded for `BTCUSDT` and `ETHUSDT`, mapped to existing active `BINANCE` crypto USD assets, and created two local `asset_price_snapshots` rows with `sourceType=provider_api`, `sourceName=binance_public_rest_24hr_ticker`, and `currencyCode=USD`.
- KIS WebSocket live smoke was not executed because required endpoint env was incomplete: `KIS_REST_BASE_URL` and `KIS_WS_BASE_URL` were missing. KIS approval_key, WebSocket connect, subscribe ack, domestic `H0STCNT0` tick, US `HDFSCNT0` tick, and KIS DB row insertion remain `BLOCKED`.
- No secret values, approval keys, `.env.local` contents, `DATABASE_URL`, or full raw WebSocket frames were printed or documented.
- This evidence is now accepted for the read-only/quote source eligibility gate. It still does not open execute, create, daily snapshot, ranking, settlement, reward, scheduler/cron, provider trigger, or real trading/account paths.

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
- Provider_api rows are eligible only for `/fx quote`, assets `withPrice`, orders quote, live portfolio valuation, home live valuation, and positions live valuation.
- ExchangeRate-API can create provider_api USD/KRW rows, and fresh `exchange_rate_api` USD/KRW rows may power `/fx quote` and allowed read-only USD/KRW conversion with safe `admin_manual` fallback.
- `admin_manual` fallback eligibility in the existing financial paths remains available where the workflow already allowed manual data.
- Provider outages, parse errors, missing mappings, and rate limits must not create fake rows.
- KIS WebSocket trade price ingestion can create provider_api rows, and fresh KRX/NAS/NYS rows may power allowed read-only/quote workflows only.
- Binance user data streams are not used.
- KIS REST current-price ingestion is not implemented.
- KIS WebSocket orderbook/hoga ingestion is not implemented.
- KIS order, account, balance, fill, deposit, withdrawal, and real trading APIs are not implemented.
- `CurrencyCode.USDT` is not added.

## Next Gate

Provider API Source Eligibility Implementation Gate read-only/quote phase is implemented using `docs/provider-source-eligibility-pre-gate.md`.

Next provider-related gates should remain narrower and explicit: execute/write eligibility, daily snapshot eligibility, settlement/final evidence policy, scheduler/deployment ownership, provider trigger APIs, KIS REST current-price ingestion, KIS orderbook/hoga, or real trading/account APIs each require separate approval.
