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
600 weight per Redis UTC minute. Existing routes reserve klines=2,
single-symbol ticker/24hr=2, Spot exchangeInfo=20, Futures exchangeInfo=1,
Futures premiumIndex=1 with symbol or 10 without; unknown routes reserve 80.
This conservative budget is preventive, not a declaration of Binance's actual
IP capacity. `BINANCE_REST_WEIGHT_BUDGET_PER_MINUTE` can set 20..600; it must be
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
