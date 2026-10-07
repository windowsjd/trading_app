# Futures F2.1 hardening verification — 2026-10-07

This record accompanies the current [execution contract](futures-api-contract.md)
and [risk contract](futures-risk-contract.md). It records measured evidence, not a
new financial policy or production SLA. User-facing Futures remains disabled until F3.

## Basis and boundaries

- Branch `main`; starting HEAD and fetched `origin/main`:
  `a74b2c879f031476f67fde17675a5992ab6b3809`; starting working tree clean.
- Latest repository superseded the requested `5a2129b...` reference.
- No branch switch, commit, push, deployment, persistent DB write or user activation.
- Financial tests and benchmarks used new disposable PostgreSQL clusters under `/tmp`.

## Isolated manual execution

The original allocation guard ran only when Cross positions existed. Isolated-only
commands could therefore fund a loss from unrelated free wallet cash even when the
operation's release was insufficient. The existing guard now applies to every
Isolated reduce/close. No new write path, bankruptcy model or arithmetic primitive
was added.

`released = current.isolatedMargin - plan.isolatedMargin` and
`netCashDelta = plan.realizedPnl - plan.feeAmount`, using the existing 60-digit
Decimal plan, 8-place HALF_UP cash/fee and proportional ROUND_CEIL remaining margin.
The guard requires `netCashDelta >= -released`; equality succeeds, an excess of
`0.00000001` fails with existing HTTP 409 `FUTURES_LIQUIDATION_REQUIRED` before writes.
Observed diagnostic evidence remains booleans/classifications, without raw amounts.

The new PostgreSQL runner checks 72 combinations of General/Season fee, 1/37/100x,
Cross absent/present, partial/full and release minus/equal/plus one quantum. Profitable
and smaller-loss operations, exact replay, rejected retries, all write-stage rollback,
and safe user first/liquidation first/unsafe user first races bring it to 112 checks.
Existing F1 lifetime tests explicitly reject the former excessive-loss close before
testing an admissible smaller loss. Fault tests use an allocation that reaches their
intended downstream write seam. Automatic liquidation and its durable bankruptcy
evidence are unchanged.

## Worker measurement and selected change

The baseline uses a 1-second timer, 50-account cursor scan and sequential locked
transactions for every scope, including healthy positions. Its 1,000-account sweep
was 19.835s healthy / 19.869s with candidates, and revisit reached 21.111s / 21.063s.
Increasing concurrency alone still missed the target. The selected change keeps
the current PostgreSQL/Ops infrastructure:

- 250 accounts with one-row lookahead, at most eight continuously draining account
  lanes; one account's scopes remain sequential.
- Read-only candidate hints reuse current PostgreSQL Mark selection and risk math.
  Healthy scopes avoid financial locks. Every incomplete preview becomes a candidate.
- Every actual liquidation retains the original transaction, full integrity checks,
  latest Mark reload after locks, lifecycle/season gates and bankruptcy settlement.
- Lease loss prevents new work, drains started lanes and preserves unfinished cursor
  work; local overlap and durable cross-worker exclusion remain in place.
- Existing pool limits and Prisma 15-second financial transaction deadline remain.
  A real long-held wallet lock demonstrated that the adapter's callback deadline
  alone did not cancel the waiting PostgreSQL statement: the test's 25-second escape
  released it. The original path therefore had an unbounded server-side lock wait.
  A transaction-local 15-second PostgreSQL statement timeout now also bounds SQL.
  The regression holds that lock until the worker finishes, checks progress on a
  different lane, unchanged blocked position, safe Ops failure and next-sweep
  liquidation after unlocking. Started tasks drain before the lease is released.
  This is a SQL cancellation bound, not a full-sweep latency SLA under contention.
  No infrastructure or financial queue was added.

Benchmark uses real worker ticks and PostgreSQL OpsJobLock/Run. Empty named loopback
DB plus `NODE_ENV=test` and explicit opt-in are mandatory. Each workload runs two
sweeps. One third of accounts has one Isolated position, one third one Cross, and one
third both (average 1.33 positions). Positions use 100x; all financial accounts have
the canonical four wallets and valid General initial-grant ledger shape. Ten percent
of accounts in the second workload has adverse deterministic Mark evidence; mixed
accounts can have two liquidation scopes. Mark refresh and monitoring use separate
clients; no Provider/network price calls or mocked clocks are used. Fixture creation,
Mark upkeep and cleanup are outside worker timings. Active connections and lock
waiters are sampled every 100ms, so they are observed maxima, not exhaustive tracing.

Environment: PostgreSQL 17.11, Node 24.14.1, AMD Ryzen 9 9950X, 32 available CPUs,
30.2 GiB memory. [Raw observations](benchmarks/futures-f21-risk-worker.json) include
baseline and final runs.

| Accounts | Workload | Accounts/s | First full sweep | Max observed revisit | Avg positions | Peak active DB connections | Peak lock waiters | Transaction failures |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | healthy mixed | 246.46 | 0.406s | 0.989s | 1.33 | 6 | 5 | 0 |
| 100 | 10% candidates | 221.58 | 0.451s | 1.039s | 1.33 | 5 | 5 | 0 |
| 1,000 | healthy mixed | 271.87 | 3.678s | 4.056s | 1.333 | 8 | 7 | 0 |
| 1,000 | 10% candidates | 258.69 | 3.866s | 4.026s | 1.333 | 9 | 7 | 0 |
| 10,000 | healthy mixed | 251.76 | 39.720s | 40.114s | 1.3333 | 9 | 7 | 0 |
| 10,000 | 10% candidates | 251.35 | 39.784s | 40.037s | 1.3333 | 9 | 7 | 0 |

The final hardened run had no other validation jobs running. The representative
1,000-account workload meets the approximate five-second target
on this machine. 10,000 accounts is outside the measured practical range for prompt
risk revisits. The validated operating envelope is 1,000 accounts for these shapes;
do not advertise a larger capacity or a production SLA from these results. Batch
and lane constants live in `futuresRiskConfig`; any future tuning must rerun this
benchmark against deployment hardware, connection budget and contention. Increasing
lanes indefinitely or weakening financial rechecks is not an operating workaround.
The stress result is recorded instead of adding distributed/sharded infrastructure.
Correctness CI has no wall-clock performance assertion.

After creating and migrating **only** an empty disposable DB named
`futures_f21_benchmark`, reproduce from `backend/`:

```sh
NODE_ENV=test FUTURES_RISK_BENCHMARK=1 \
  DATABASE_URL="$F21_DISPOSABLE_DATABASE_URL" \
  FUTURES_BENCHMARK_SIZES=100,1000,10000 \
  FUTURES_BENCHMARK_REPORT=/tmp/futures-f21-benchmark.json \
  pnpm exec tsx scripts/futures-risk-benchmark.ts
```

## Migration READ ONLY audit

Runtime `.env.local` target was checked with driver-enforced
`default_transaction_read_only=on` and `BEGIN READ ONLY`. Server version was
17.11 (Debian). There were no unfinished migration records. DSN/credentials were
not printed. `.env.development`/`.env` pointed to the same separate local target;
that target refused connection, so its migration state is unknown.

| Migration | Started UTC | Finished UTC | Rolled back | DB checksum = current file SHA-256 |
| --- | --- | --- | --- | --- |
| `20261007180000_add_synthetic_perpetual_futures` | 2026-10-07 04:54:26.301 | 2026-10-07 04:54:26.709 | null | `f9cad2a48e69a8f04a8632241e4024fed2202420ef4a9550014ef7a5ccc7f7e0` |
| `20261007210000_add_futures_cross_risk_liquidation` | 2026-10-07 09:48:44.902 | 2026-10-07 09:48:45.209 | null | `da6bb95390534eb356692ebe0d140ebfb41b1145043d6715c30618ede913fa7b` |

This is policy CASE C: **both files are preserved byte-for-byte**. No transaction
wrapper, whitespace edit, history/checksum repair or migration deploy was performed
on the persistent target. Lack of an explicit whole-file transaction remains a
historical operational risk for a future failed fresh apply; already-applied history
is not rewritten. Atomic-wrapper/failure-injection experiments are inapplicable to
this applied chain and were not performed.

Fresh disposable PG16.15 and PG17.11 each applied all 62 migrations, reported fully
applied status and no schema drift. Prisma format/validate/generate succeeded;
schema and committed generated artifacts did not change.

## Validation and remaining scope

The F2.1 runner is part of the existing financial PostgreSQL CI gate. Worker unit
tests cover healthy preview, lease loss, overlap, cursor boundaries, additions and
removals, bounded lanes and draining on read failure. F2 PostgreSQL coverage adds
real multiple batches with 252 accounts, removed/closed/new accounts and restart;
candidate recovery/staleness/underfunding still reaches the original locked guard.
Existing F2 concurrent increase/close/transfer, stale Mark and lifecycle tests remain.
The final F2 runner passed 83 consolidated checks, including real long-held wallet
lock cancellation and successful revisit. F2.1 passed 112 checks on PG16 and PG17.

| Command / gate | Result |
| --- | --- |
| `pnpm exec prisma format`, `validate`, `generate` | PASS; schema/generated diff empty |
| Fresh full `prisma migrate deploy`, `status`, `migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` | PASS on disposable PG16.15 and PG17.11; 62 migrations each, no drift |
| `pnpm run typecheck`, `build`, `lint:accounts:check` | PASS |
| `NODE_ENV=test pnpm exec jest --runInBand` | PASS: 239 suites / 3,847 tests; 54 DB-opt-in suites / 59 tests skipped here |
| Existing financial CI test list, all opt-ins, `jest --runInBand --runTestsByPath` | PASS: 18 suites / 19 tests on PG17; F1/F2/F2.1, Transfer, FX/FX+Transfer, Orders |
| Existing Core account CI test list, all opt-ins | PASS: 21 suites / 22 tests on PG16 |
| Final `FUTURES_RISK_DB_INTEGRATION=1 pnpm exec tsx scripts/futures-risk-integration.ts` | PASS: 83 checks on PG17, including the new SQL timeout after the combined gate |
| Final F2.1 `jest --runInBand --runTestsByPath src/futures/futures-isolated-boundary.integration.spec.ts` with Futures opt-ins | PASS on PG16: 112 boundary/rollback/race checks after the SQL timeout change |
| `pnpm run test:e2e -- --runInBand` | PASS: 2 suites / 394 tests |
| Frontend `npm run check` | PASS: lint + typecheck + 203 suites / 1,680 tests |
| Frontend `npm run export:web` | PASS |
| Final risk benchmark (explicit empty disposable DB opt-in) | PASS; all sizes/workloads, no transaction failures; observations above |

The combined financial/Core commands used their exact checked-in
`.github/workflows/ci.yml` test lists and switches, overriding only disposable DB,
Redis and UTC environment. Opt-in suites skipped by the unit run were exercised by
the required F1/F2/financial/Core integration gates. Other opt-in integration suites
remain skipped and are not counted as passes.

Initial combined runs encountered standalone FX fault-injection, General price
fixture, F2 Mark-selection, limit-create season-time and Ops lease-timing assertion
failures. Independent/combined reruns passed without unrelated code/policy edits;
their underlying intermittent timing cause was not established. A unit run inside
the restricted sandbox failed on git/IPC/subprocess permissions (`EPERM`); the
properly permitted full run passed. The new real long-held-lock test instead exposed
a reproducible SQL cancellation issue and passed only after the fix described above.
Final review and results are also recorded in HANDOVER.

## Changed files and review

| File | Purpose |
| --- | --- |
| `src/futures/futures.service.ts` | Apply existing Isolated allocation guard without a Cross prerequisite; bounded diagnostic reason |
| `src/futures/futures-liquidation.service.ts` | Read-only candidate hints; transaction-local SQL cancellation bound |
| `src/futures/futures-risk-worker.service.ts` | Bounded account lanes, lookahead, lease-loss drain and completed-prefix cursor |
| `src/futures/futures.config.ts` | Fixed 250-account/eight-lane worker bounds |
| `src/futures/futures-diagnostics.spec.ts` | Preserve safe allocation evidence and existing role/redaction regression |
| `src/futures/futures-risk-worker.spec.ts` | Cursor/overlap/lease/concurrency/failure-drain correctness |
| `src/futures/futures-isolated-boundary.integration.spec.ts` | Opt-in PostgreSQL F2.1 runner in the existing CI gate |
| `scripts/futures-integration.ts` | Correct old unsafe-loss expectation; reuse existing write-fault harness |
| `scripts/futures-risk-integration.ts` | Real multiple batches, candidate recovery, long-held wallet lock and revisit |
| `scripts/futures-isolated-boundary-integration.ts` | Exact cash-quantum matrix, rollback, replay and deterministic liquidation races |
| `scripts/futures-risk-benchmark.ts` | Empty disposable-only real PostgreSQL benchmark, fresh Mark stream and numeric report |
| `docs/futures-api-contract.md` | Canonical manual Isolated collateral boundary |
| `docs/futures-risk-contract.md` | Canonical worker/candidate/SQL-timeout behavior |
| `docs/futures-f21-hardening.md` | Investigation, evidence, reproduction, outcomes and remaining limits |
| `docs/benchmarks/futures-f21-risk-worker.json` | Actual baseline and final numeric observations |
| `../HANDOVER.md` | Implementation intent and verified handoff |
| `../.github/workflows/ci.yml` | Add F2.1 to the financial PostgreSQL test list |

All tracked diffs and new files were reviewed. No deletions, schema/migration,
committed generated artifact or frontend changes; no financial calculation,
Provider priority/freshness, settlement, idempotency or lock-order redesign.
Both applied migration SHA-256 values still match. `git diff --check` passed.
Final state is 12 modified tracked files and five new files, uncommitted on `main`.

F3 still owns Futures UI, coherent Home/Portfolio/TWR/Ranking/Settlement open-UPNL
valuation and final Season settlement. Conditional orders, funding, hedge mode,
partial liquidation, ADL and insurance remain excluded. Persistent deploy/user
activation, remote GitHub Actions and live Provider exercises were not performed.
