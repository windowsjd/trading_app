# Domestic market data: KOSCOM v3

The domestic provider is KOSCOM; US KIS and Binance retain their transports and financial policies. Public API paths remain `/api/v1`. No database migration, asset seed, deployment or production configuration change is required by this implementation.

## Collection contract

- Resolve active domestic assets against KOSPI/KOSDAQ/KONEX lists, preserving asset IDs and the database's `KRX` label. Never infer KOSPI from `KRX`, create assets from a list, or batch KONEX.
- Collect price and ten-level order books centrally, using at most 20 symbols per market/request. Bounded requests share Redis admission and an ingestion lease; an unavailable Redis fails closed. No user subscription opens a provider price request.
- Keep money as decimal text, including numeric JSON tokens before JavaScript number conversion. Runtime requires Node 22 or newer for lossless JSON reviver source tokens (locally verified with Node 24.14.1); unsupported runtimes fail closed. Provider trade time is `HHMMSSmm`, with leading zeroes sometimes omitted. Non-clock market signals are rejected. Receipt time and exchange time remain distinct.
- Only `koscom_krx_realtime_price` is eligible for new domestic live prices. Legacy KIS evidence remains stored and usable by historical workflows. Existing quote/execute freshness and market-session rules are retained.
- Credentials are backend-only `apikey` query parameters. Errors, persisted evidence and diagnostics never contain request URLs, keys, response error bodies or transport exception text.

## Candle contract

Reuse PostgreSQL `market_candles`, existing locks/checkpoints, five-minute builder and higher-interval aggregation. Preserve closed KIS rows during overlapping KOSCOM imports; never relabel historical rows. Intraday requests use documented one-minute windows of at most 100 rows, with no invented continuation token or guaranteed historical retention. Missing constituent minutes cannot produce a complete five-minute candle.

History supports D/W; weekly provider dates identify the last trading day and must be normalized to the existing week boundary. KOSCOM documents no adjusted-price request flag. Preserve existing adjusted KIS history and expose provider provenance; corporate-action continuity and provider adjustment semantics require live verification before rollout.

The supplied v3 specification is the implementation contract. Additional field semantics were checked against the official [realtime documentation](https://koscom.gitbook.io/open-api/api/marketv3/stocks/stocksa) and [closed/history documentation](https://koscom.gitbook.io/open-api/api/marketv3/stocks/closeda). Actual authentication, response shapes, history availability and rate limits remain unverified without a user-provided key.

## Runtime configuration and operator verification

Set these variables on the backend only. This change does not set them or deploy anything.

| Variable | Default / purpose |
| --- | --- |
| `KOSCOM_API_KEY` | Required; absent key disables all KOSCOM requests |
| `KOSCOM_BASE_URL` | `https://oap.k-mydata.org`; only this origin or `https://testoap.k-mydata.org` is accepted |
| `KOSCOM_MARKET_DATA_ENABLED` | Enabled when a key is present; `false` disables |
| `PROVIDER_INGESTION_ENABLED` | Existing global gate must be `true` |
| `KOSCOM_POLLING_ENABLED` | `false`; explicitly enable central collection after connection checks |
| `KOSCOM_POLL_INTERVAL_MS` | 3000; allowed 1000–60000 |
| `KOSCOM_MAX_CONCURRENCY` | 2; allowed 1–4; shared across instances via Redis |
| `KOSCOM_MIN_REQUEST_INTERVAL_MS` | 200; allowed 50–10000; shared request-start spacing |
| `KOSCOM_HTTP_TIMEOUT_MS` | 5000; allowed 100–15000 |

Defaults are application load limits, not a claim about provider quotas. Each process admits at most 64 outstanding calls. Network/timeout/5xx failures retry once after 500 ms; 401/403 and malformed/auth API responses do not retry. A 429 starts a shared 10-second cooldown. Collection uses a renewable 60-second Redis lease and bounded workers. Failed list loads back off for 30 seconds; partial lists do not guess unresolved symbols. With the current 15 domestic assets spanning KOSPI/KOSDAQ, a successful polling cycle normally takes four batch calls (two markets × price/book), plus infrequent cached list loads. US KIS watchlist/environment and Binance settings are independent.

When the existing live candle supervisor is enabled, its KOSCOM owner performs price/book polling. It separately refreshes native minute candles once per minute for active domestic assets, with bounded workers and the same global HTTP admission limits. Only contiguous completed native minutes form a provisional five-minute OHLCV snapshot; all five minutes are required for finalization. Quotes never generate synthetic candle OHLCV. The existing Redis reducer, higher-interval overlay, publisher and finalizer distribute and persist these absolute candle snapshots. A missing final native response goes through existing REST reconciliation. Native chart updates therefore follow completed-minute availability, not every price poll. This adds up to 15 intraday calls/minute for the current 15 domestic assets, independent of user count.

Otherwise the existing OpsScheduler owns the price/book polling timer; existing candle serving/reconciliation remains responsible for charts. Both price paths and manual collection share the same lease. No new standalone collector or user-specific poller is created. With live candles and KOSCOM polling enabled, retain `CANDLE_RECONCILIATION_KRX_ENABLED=true`; US KIS live flags no longer require KRX reconciliation. Closed-session recovery uses exact-date `history` D evidence and checks coverage again; it never publishes a recovered close as a realtime tick.

Existing candle serving, backfill/reconcile jobs and `/api/v1/assets/:assetId/candles` remain the entry points. Compatibility reads also use the existing Redis cache/single flight. Source diagnostics, including a current live overlay over legacy history, report `koscom`, `kis`, or `mixed`, with `sourceProviders` for KOSCOM/mixed answers; OHLCV response fields and intervals remain unchanged. Existing closed KIS rows cannot be overwritten by an overlapping KOSCOM import. This preserves stored history but also means a historical corporate-action repair needs a separately reviewed data policy.

### Endpoint status

| API | Integration |
| --- | --- |
| `multiquote/stocks/price` | Central KOSPI/KOSDAQ price collection, max 20 each |
| `multiquote/stocks/orderbook` | Central KOSPI/KOSDAQ ten-level collection, max 20 each |
| `stocks/{code}/price`, `orderbook` | Single-symbol KONEX fallback; no assumed KONEX batch support |
| `closed/{market}/lists` | Cached mapping of existing active assets; only positive list membership is accepted; another market’s list failure does not disable proven symbols |
| `closed/{market}/{code}/master` | Validated adapter method for inspection; not an extra per-poll request |
| `stocks/{code}/intraday` | 1-minute feed, current KST date only, HHMM request windows ≤95 minutes and response ≤100 rows |
| `closed/{market}/{code}/history` | D/W with date-window paging, max 100 rows per request; completed-session close recovery |
| `closeprice` | Deliberately unused: documented result has no trading date; recovery uses dated history |
| M history, all-market lists/ohlclists/quotelists, indices | Not called; existing app does not require these features |

### Remaining live checks after the user registers the key

1. With central polling still disabled, run the existing authenticated operator endpoint `POST /api/v1/operator/providers/koscom/run` with `{"dryRun":true,"symbols":["005930","086520"],"maxSnapshots":4}` during a covered KRX session. Confirm both official market mappings and price/book success. The response contains fixed error codes and sanitized summaries, never the API key or full URLs.
2. Confirm actual query-key authentication, JSON-RPC wrappers and exact field names; check all three list responses. Verify the documented sign codes, lossless turnover, BBO, and ten book levels against actual output. Validate rate and concurrency limits using the bounded defaults before changing them.
3. Inspect minute timestamps at 09:00/09:05/15:30 KST. The implementation treats `inddTm` as an **end label**, inferred from the official first 10-minute example at 09:10. This inference must be confirmed against a real 1-minute response before enabling chart collection. Check boundary inclusivity, absent minute rows, auction coverage, and any special calendar session. Past-minute availability is deliberately unpromised; old PostgreSQL data remains available.
4. Validate D/W business dates, weekly Monday normalization, current unfinished period behavior, and price-adjustment semantics against preserved KIS history. Check a split/dividend boundary. Do not silently concatenate differently adjusted series or rewrite old candles.
5. Enable `KOSCOM_POLLING_ENABLED=true` only after these checks. Confirm the existing `asset_candle` event carries accurate native minute-derived volume/amount, partial/final flags, and monotonic revisions; confirm snapshots carry `koscom_krx_realtime_price` with distinct exchange/receipt times, and existing Redis/`/api/v1/ws` tickers reach two backend instances while only one collector owns the lease. Restart/fail over the owner; check partial batch failures, expired prices, and missing-key degradation.
6. Verify `/api/v1/assets`, asset detail/chart, home and portfolio valuations; create quote → execute and eligible limit fills using existing virtual trading flows. Confirm US KIS authentication/REST/WebSocket/candles and Binance spot/futures feeds remain healthy.
7. After close, verify exact-date history recovery and coverage recheck, and verify that it does not generate a live ticker or satisfy a new order's post-submission evidence rule.

No live authentication, provider connectivity, production response shape, actual quotas, corporate-action equivalence, device UI, or deployed multi-server failover is claimed from fixture tests. Redis/PostgreSQL-backed integration suites require a dedicated local test environment; never point them at Render or production data.
