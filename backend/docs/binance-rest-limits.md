# Binance REST request coordination

Runtime Binance REST GETs and operator scripts go through ProviderHttpClient,
including Futures exchangeInfo and Mark REST recovery. Their Mark validation,
storage and WebSocket policies are unchanged. The frozen Python universe
research script permits offline --replay only: its independent network retry
loop is removed rather than adding a second coordination implementation.
REST coordination does not gate WebSocket connections or KIS/FX requests.

Redis is required for Binance REST. A shared `{binance-rest}` state holds a
cooldown, recovery probe identity, minute weight reservation and expiring
in-flight leases. Redis server TIME supplies the clock; application clock steps
cannot prematurely release a cooldown. Missing/unavailable Redis fails closed
for Binance REST only. Instances and scripts sharing an egress IP must share
this Redis database. Unrelated applications sharing that IP remain outside our
control. No IP rotation, sleep prevention or provider-request retry is added.

HTTP 429/418 preserve only numeric status, parsed Retry-After duration and
numeric X-MBX-USED-WEIGHT-1M. Bodies, arbitrary headers and URLs are discarded.
Valid delta seconds and IMF-fixdate are accepted, with a one-second minimum and
seven-day maximum. Missing/invalid headers use 60 seconds (429), 120 seconds
(418). HTTP dates use the provider Date header when valid, otherwise receipt
time. Concurrent restrictions can extend but cannot shorten an existing block. A
completion always publishes the longest local unpersisted restriction; only
that exact snapshot may be cleared after a successful Redis write. Admission
rechecks pending restrictions on every slot poll. A restriction that Redis never
accepted remains local: a process crash before publication cannot recover it,
and another process cannot infer it. Shared protection requires a successful
Redis publication and preserved Redis state.
After the deadline only one request probes recovery. An unsuccessful probe
without a new rate-limit response pauses for 30 seconds. A successful probe
reopens admission, without retrying the failed request automatically.

Normal admission allows two simultaneous HTTP requests and reserves at most
the configured budget (default 600, at most 1200) per Redis UTC minute.
Existing routes reserve klines=2,
single-symbol ticker/24hr=2, Spot exchangeInfo=20, Futures exchangeInfo=1,
Futures premiumIndex=1 with symbol or 10 without, Futures `/fapi/v2/ticker/price`
=1 with symbol or 2 without (Futures Last re-confirmation, at most every 3s);
unknown routes reserve 80.
Futures `/fapi/v1/klines` follows the official LIMIT tiers: below 100 = 1,
100..499 = 2, 500..1000 = 5, 1001..1500 = 10; omitted LIMIT defaults to 500.
Invalid or duplicate LIMIT parameters retain the conservative weight 80.
Long-range 4h upkeep (2026-10-13) uses Spot `/api/v3/klines` interval `4h`
(≤ 1000 rows, weight 2) and USDⓈ-M `/fapi/v1/klines` interval `4h` (499-row
backfill pages = 2, upkeep `limit<100` = 1), strictly sequentially with
≥ 150 ms between its own calls so Futures Last/Mark recovery keeps a slot
([long-range-4h-candles.md](long-range-4h-candles.md)).
This conservative budget is preventive, not a declaration of Binance's actual
IP capacity. `BINANCE_REST_WEIGHT_BUDGET_PER_MINUTE` can set 20..1200 (unset =
600; 2026-10-14 production target 1200, set explicitly); it must be
identical across instances. Observed used weight can exhaust the local budget
earlier, including traffic from other IP users. Crypto asset fan-out is capped
at two even when its configured value is 4..8. Only ordinary slot contention
gets bounded admission polling (50ms, at most 1s or half the HTTP timeout,
whichever is smaller). Slot exhaustion has a distinct BINANCE_REST_BUSY
category. There is no request queue or HTTP retry; HTTP 418/429 cooldown,
weight exhaustion and recovery-probe contention still fail promptly. Admission
wait consumes the existing HTTP timeout, and admitted requests have no fixed
delay. Sustained overload can still defer work to a later existing sync run.
Lease expiry allows recovery after a process dies. All keys expire; recovery
state outlives the maximum supported cooldown.

## Budget 1200 and the Spot 100 + USDⓈ-M 100 estimate (2026-10-14)

The application budget is one Spot + USDⓈ-M counter with two slots and no
priority classes. Binance limits each product per IP separately (Spot 6000,
USDⓈ-M 2400 weight/min), so 1200 spent entirely on either product is at most
half of that product's own limit; 1200 is our ceiling, not a provider promise.
Futures order books and 24h statistics are WebSocket only (no REST weight).

Estimate for the universe of 100 Spot + 100 USDⓈ-M symbols (implemented 2026-10-16; written when it was 25 + 25),
one ingesting process, live candles/ticker on WebSocket:

| Source (cadence) | Weight per run | Average/min | Peak/min |
|---|---|---|---|
| Spot 5m/1d/1w sync (600 s, 3 warm requests/asset × 2) | 600 | 60 | 300–600 |
| Crypto reconciliation (300 s, 1/asset; first run of a UTC day 2, of a week 9) | 200 (400 daily, 1800 weekly) | 40 | 200; weekly ≈ 400–600 for a few minutes |
| Spot 4h upkeep (after each 4h close, 1/asset × 2) | 200 | ≈ 1 | 200 |
| USDⓈ-M 4h upkeep (≈ 60–120 s, 1/contract, limit < 100 = 1) | 100 | 50–100 | 100 |
| Futures Last re-confirmation (`/fapi/v2/ticker/price`, ≤ every 3 s) | 2 | 35–40 | 40 |
| Futures Mark recovery (`premiumIndex`, only when Mark WS degrades) | 10 | 0 | 200 |
| exchangeInfo (Spot 6 h, Futures 5 min) | 21 | < 1 | 21 |

Average ≈ 240/min. A typical busy minute is ≈ 440–940; everything in one
minute (daily reconciliation + Spot sync + Mark degraded) ≈ 1340–1540, which
still exceeds 1200: the excess is refused (`PROVIDER_RATE_LIMITED`) and the
existing sync runs defer it, without retries or extra concurrency.

- At 600, one Spot sync run for 100 assets (600) can exhaust a whole minute,
  and Futures Last/Mark REST recovery is then refused until the minute rolls
  over. 1200 leaves ≈ 260–760 for that recovery in typical busy minutes.
- Completion: a 100-asset Spot sync run (300 requests on two slots) finishes
  in one run at 1200; at 600 the remainder waits for the next 600 s run.
- 96-day 4h backfill: Spot 100 × 1 call (200) + USDⓈ-M 100 × 2 calls (300),
  strictly sequential with ≥ 150 ms spacing, ≈ 250/min for about two minutes.
- Cold 5m/1d/1w seeding of 100 new Spot assets is ≈ 2,600 weight; it is paced
  by the existing two-asset fan-out and defers when the minute is exhausted.
  Run it outside busy periods; do not raise concurrency for it.
- More instances: Mark, Last and Futures exchangeInfo run per process (≈ +40/min
  each, + up to 200 when Mark degrades); scheduled Ops jobs run once.

Deployment order: older code rejects values above 600 at the first Binance
call (`must be 20..600`), which would fail every Binance REST request. Deploy
this code first, then set `BINANCE_REST_WEIGHT_BUDGET_PER_MINUTE=1200` on every
instance sharing the Redis database.

Crypto scheduled reconciliation uses the latest real running/succeeded/failed
Ops attempt for its retry interval, including startup. Success remains the
authority for canonical coverage and daily/weekly target decisions. A local
in-flight guard complements the existing distributed Ops lock. Stock schedules
and manual reconciliation are unchanged; the reconciliation service's default
crypto feed remains 5m.

Scheduled candle sync defaults to all active supported DB assets, with 5m/1d/1w
feeds. `SCHEDULER_MARKET_CANDLE_SYNC_ASSET_IDS` explicitly overrides this set;
manual assetIds still restrict a manual run. The reported 10-of-25 incident is
consistent with a stale configured allowlist, not a default 25-asset cap.
After approval and ban release, remove/empty that allowlist and retain
`SCHEDULER_MARKET_CANDLE_SYNC_ENABLED=true`. Do not widen live requests during
a ban. Incremental overlap revisits recent unclosed daily rows; old interior
gaps require the existing bounded repair path. No canonical validation changes.

Operational changes, deployment and data repair require separate approval.
Verify shared Redis first, inspect cooldown TTL without deleting it, wait for
admission's single recovery probe, then use existing bounded sync/repair.
Read each active asset's previous UTC 1d row: exact window, binance_klines,
isClosed, post-close sourceUpdatedAt and valid OHLC. Finally compare REST and
WS paired price/changeRate and web/APK rendering. A deployment is not evidence
that the ban or daily data has recovered.

Reference: https://developers.binance.com/en/docs/products/spot/rest-api (IP Limits).
