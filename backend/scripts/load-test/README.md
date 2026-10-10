# Trading Class 1,000-user harness

This executable uses the existing Nest AppModule, normal `/api/v1` HTTP and raw authenticated WebSocket contracts. PostgreSQL remains the financial source of truth. The production entry point never imports this directory. No infrastructure is created automatically.

**Execution requires separate approval.** Never point this at production, including a different Redis logical DB on the production Valkey instance. Baseline is one run: 1,000 users / 300-second ramp / 3,600-second hold / 300-second drain. Start with the 10-user smoke. Diagnostic user counts are optional after a failed baseline. There is no automatic repetition or distributed coordinator.

## Prepare approved isolated resources

Use a physically separate API, PostgreSQL and Valkey, and a separate Linux generator. Pin the same commit, Node version, lockfile, PostgreSQL/Valkey versions, provider cadence, account funding, seed and fixture parameters for Render and Lightsail. A Render API needs its private database/Valkey URLs; the external generator may use separately approved observer URLs.

The database must have a dedicated `load_test_*` role, a name ending `_load_test`, UTC timezone and no users before migrations/preparation. Prefer a fresh physical DB and Valkey for every run. The tool refuses existing unclaimed data, nonzero Redis DB numbers, known production resource IDs/hosts, mismatched URL credentials, changed SHA, dirty cloud trees, overwritten output and a reused run fixture. `cloudExecutionApproved` records the explicit external execution approval; creating the template does not authorize execution.

Install existing backend dependencies, generate the existing Prisma client and build with the repository's normal commands. No new package or migration is needed. The compiled entry is `dist/scripts/load-test/cli.js`; the source entry is `npm run load-test -- ...`.

```bash
cd backend
npm run load-test -- template --smoke --manifest /secure/smoke.json --credentials /secure/smoke.credentials.json
```

Edit the template to the approved targets and resource IDs. Credentials stay mode `0600`, outside Git. Supply fresh `jwtSecret`, `userPassword`, `controlSecret` and dedicated database/Valkey credentials. Do not copy production secrets. Optional external observer fields are `target.databaseObserverHost/Port`, `target.valkeyObserverHost/Port` and `databaseObserverUrl`, `valkeyObserverUrl` in credentials. They must identify the same separately approved physical test resources. For Render execution, supply a newly authorized `renderApiKey`; the tool uses GET metrics only.

```bash
node dist/scripts/load-test/cli.js migrate --manifest /secure/smoke.json --credentials /secure/smoke.credentials.json --out /evidence/migrate
node dist/scripts/load-test/cli.js serve --manifest /secure/smoke.json --credentials /secure/smoke.credentials.json --out /evidence/server
```

Run `serve` as a long-lived process on the isolated API host. Keep its evidence directory durable or export it before stopping a Render instance. This process discards inherited credentials, bootstraps from an empty working directory so repository dotenv files cannot load, injects synthetic provider transports and uses the existing guards, middleware, scheduler, locks and financial services. It never exposes test authentication or financial bypass routes. Only the test process enables the mixed launch trading profile. The production Futures flag remains unchanged.

After `/health` is ready, run preparation and smoke on the generator:

```bash
node dist/scripts/load-test/cli.js prepare --manifest /secure/smoke.json --credentials /secure/smoke.credentials.json --out /evidence/fixture
node dist/scripts/load-test/cli.js guard --manifest /secure/smoke.json --credentials /secure/smoke.credentials.json --out /evidence/guard
node dist/scripts/load-test/cli.js run --manifest /secure/smoke.json --credentials /secure/smoke.credentials.json --fixture /evidence/fixture/fixture.json --out /evidence/run
node dist/scripts/load-test/cli.js audit --manifest /secure/smoke.json --credentials /secure/smoke.credentials.json --fixture /evidence/fixture/fixture.json --out /evidence/audit-review
```

Preparation uses real signup/login, account creation or Season join, initial grant and wallet transfer quote/execute, Spot quote/create, Futures execute/limit. Direct fixture writes contain only assets, verified contracts, candle/history observations and a test Season. There are no direct financial balance/position/ledger writes. Preparation and final audit must have zero findings. A failed run still attempts an audit and retains failed artifacts; output is never relabeled PASS.

For baseline, generate a **new** template without `--smoke`, use **fresh** approved test resources and new output directories, then repeat these explicit steps. The default baseline has 1,000 actors but this command must not be run until separate user approval. Do not reuse the post-smoke financial dataset. API and generator use the same approved manifest; only observer credential URLs may differ by host.

## Workload

Time occupancy targets: market 30%, detail/chart/book 25%, Spot orders 10%, Futures 15%, home/wallet/portfolio 15%, history/FX 5%. These are initial code-derived assumptions, not measured production analytics. Dwell ranges respectively: 30–90, 30–60, 60–180, 60–180, 30–90, 30–90 seconds. Dwell-weighted transitions prevent different dwell lengths from distorting target occupancy.

Each actor has one shared WS, retaining at least one ticker expressly for the 1,000-WS stress condition. Market mounted-row subscriptions persist as the current UI does; detail candle/book subscriptions follow focus. Futures instrument/position polling is two seconds only while focused; pending Spot history polling is four seconds; FX fallback is 300 seconds. Cached reads retain current stale intervals and in-flight deduplication; chart reads run on entry/recovery, not continuous polling. First subscription waits 100ms after open to model UI/WAN dispatch: the current asynchronous gateway authentication can miss immediate loopback frames. This assumption is recorded in the manifest; the gateway is not changed.

Spot defaults are market/limit 70/30, BUY/SELL 60/40, 60–180 seconds between trade decisions. Futures defaults are market/limit 70/30 for eligible flat entry decisions, 30% of Futures viewers trade, with 120–240 seconds between decisions. Existing positions choose valid increase/reduce/close operations. Only flat positions create entry limits. Direction, existing position, wallet scope, reservation and Last availability are checked through actual endpoints. Protection and cancel decisions are configurable, default 10% and 20%. Nothing overrides server validation or converts a Spot price into Futures execution evidence.

Baseline preparation: 1,000 users/accounts, four wallets/account, 12 buy/sell history rounds and three holdings/account, two Futures positions/account, up to 20% pending Spot/Futures entry orders, seven days of candles. Smoke uses one history round and two candle days. Exact row counts are saved. Current contract validation rejects the Unicode Spot symbol, so the current-code fixture has 25 Spot assets and 24 verified Futures contracts; no alias is invented. A future catalog change requires new fixture/replay validation before either cloud comparison.

Replay preserves real response parsing, normalization, candle reducer/hydration/finalization, Last/Mark selection, limiter/coordinator, Pub/Sub, fan-out and normal persistence. Prices follow a seeded bounded triangular trajectory. Ticker/candle/Mark are 1Hz, depth 1.67Hz, Last 5Hz per subscribed symbol; existing persistence cadence is unchanged. Synthetic FX drives the existing Ops ingestion job every 30 seconds (including its lock, parser and database writes), independently of the unchanged shared scheduler tick. The production hourly FX schedule cannot sustain the existing 60-second execution freshness requirement; the harness does not relax that requirement. Event IDs and relative price sequence are deterministic; UTC timestamps are translated to actual arrival time to retain normal freshness and JWT policies. Preparation freezes the price trajectory; ramp starts its monotonic price sequence. Missed ticks are counted and skipped. Unknown provider HTTP paths or sockets fail; a process-level network guard blocks unauthorized destinations before a connection. An attempted external provider connection invalidates the run even if blocked.

## Evidence and interpretation

- `identity.json`, `manifest.json`, `server-manifest.json`: SHA, lock/schema hashes, targets, manifest/workload/replay identities, flags and versions. Workload hash excludes deployment target/run ID; compare it and the fixture financial audit across clouds.
- `summary.json`, `histograms.json`, `commands.jsonl`: separate run validity, correctness, performance and headroom; endpoint counts/latencies/errors, WS ACK/traffic/recovery, action counts, command key/result linkage. Fixed bounded logarithmic histograms have approximately 1% relative precision.
- `generator.samples.jsonl`: CPU/RAM, event-loop delay, actual Linux socket count, subscriptions, occupancy, in-flight actions, receive backlog. `generator.dispatchDelay` separates generator timing from intentional order think time and server-induced action delay.
- `server.samples.jsonl`, `server-metrics-final.json`, API `server-summary.json`: CPU/RAM/event loop, pool occupancy/acquire wait, query and transaction spans, existing gateway pending/coalesced/drop/send state, serialized bytes, worker cycles/revisits/lock/lease outcomes, Valkey command failures/timeouts. Observers never alter pool settings or transaction isolation.
- `database-valkey.samples.jsonl`: connections, lock waits, deadlocks, storage, Valkey memory/noeviction/client/errors/PubSub, pending counts and incomplete triggered children. `render.samples.jsonl`: API/PG/Valkey CPU/RAM and managed connection metrics, through read-only 30-second Render API queries.
- `audit.json`, `financial-latencies.json`: exact Decimal financial reconciliation and all-fixture create/accepted→execution timestamps. Worker `eligibleEvaluationToCommit` starts when a positive candidate evaluation/fill call starts; it does not claim to measure the first theoretical price crossing. Conditional triggered→commit, revisit and worker policy are reported separately from HTTP SLOs.
- `wall-clock-steps.jsonl`, `observer-errors.jsonl`: measurement validity evidence. Clock steps/offset uncertainty, insufficient generator CPU/RAM/event-loop/scheduling/backlog capacity, missing observations/WS latency, or incomplete workload are `INVALID RUN`, never server PASS.

General HTTP p95/p99 goals are 1s/2s; normal order p95/p99 2s/5s; realtime ingress p95/p99 2s/5s; unrecovered intended request error rate <0.1%. Expected expiry-401 followed by real refresh is recorded without counting a successfully recovered request as an unrecovered error. Snapshot fallback age is separate from live ingress latency. Financial findings are always `CORRECTNESS FAIL`, independent of performance; missing audit is incomplete. CPU/RAM/pool/network utilization is headroom review, not automatic latency failure. Restart/OOM/deadlock/timeout, send failures and accumulating fan-out queues are actual failures.

Use a stable Linux clock; this repository's WSL clock regression can invalidate an otherwise functional local smoke. Never disable the clock guard or infer a 1,000-user capacity result from a local smoke. Render metrics credentials, series availability and units require an isolated cloud smoke before the baseline; on Lightsail capture DB process CPU/RAM and instance/network metrics using its native read-only monitoring in addition to the shared harness artifacts. Empty/missing cloud telemetry is a measurement gap, not zero utilization. API egress bytes are payload accounting, not the final TLS/network invoice. The default payload budget is 90GB; obtain approval for the cloud budget before execution. The local 10-user smoke extrapolates to approximately 69GB for 1,000 users during hold alone, before ramp/drain and transport overhead.

## Verification

```bash
npm run test:load-test
npm run typecheck
npm run lint:accounts:check
```

Use the existing PostgreSQL financial gate on a separate dedicated test DB. Never delete or weaken existing tests. The harness tests use pure 1,000-actor allocation calculations; they do not open 1,000 network connections. Multi-generator execution fails closed because synchronized phase coordination is not implemented.

The current local 10-user smoke completed the normal HTTP/WS/financial checks with zero financial findings and zero external provider attempts. WSL clock steps correctly made the run `INVALID RUN`, so it supplies no valid performance baseline. Use `[skip render]` in the implementation commit to preserve the no-deploy instruction when pushing main; this is Render's documented auto-deploy skip phrase, not a change to service configuration.
