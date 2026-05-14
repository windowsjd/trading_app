# Backend Test Coverage Matrix

Status: documentation/code-audit matrix, updated 2026-05-14 for Binance-based USD-settled crypto policy.

This document records the current backend test surface before starting the next large backend gates such as provider ingestion, scheduler/batch, settlement, reward, or refresh-token/session work.

This document is a coverage matrix. It does not authorize provider ingestion, scheduler, settlement, reward, Prisma schema, migration, seed, package, or lockfile changes.

Crypto policy update:

- MVP crypto provider is Binance.
- Crypto is USD-settled and uses the USD Wallet.
- Crypto KRW valuation is USD crypto value converted by USD/KRW.
- Upbit/Bithumb and KRW crypto trading are excluded from MVP.
- Binance BTCUSDT ticker/orderbook fixture capture is the next provider evidence step; ingestion remains STOP.

## Audit Basis

- Source of truth:
  - `docs/codex-rulepack.md`
  - `docs/current-status.md`
- API contracts and safety documents:
  - `docs/auth-preimplementation-readiness-audit.md`
  - `docs/fx-api-contract.md`
  - `docs/fx-execute-safety-plan.md`
  - `docs/fx-execute-final-implementation-gate.md`
  - `docs/orders-api-contract.md`
  - `docs/order-execution-safety-plan.md`
  - `docs/order-execution-preimplementation-readiness-audit.md`
  - `docs/home-api-contract.md`
  - `docs/ranking-api-contract.md`
  - `docs/wallets-api-contract.md`
  - `docs/records-api-contract.md`
- Code/test files inspected:
  - `src/auth/**`
  - `src/seasons/**`
  - `src/fx/**`
  - `src/orders/**`
  - `src/home/**`
  - `src/ranking/**`
  - `src/wallets/**`
  - `src/records/**`
  - `src/portfolio/**`
  - `test/app.e2e-spec.ts`
  - admin CLI scripts under `scripts/`

## Coverage Legend

- Covered: Assertions exist for the current MVP behavior.
- Partially covered: Some meaningful assertions exist, but an important runtime path, HTTP path, DB path, or race path is missing.
- Not covered: No meaningful current test was found for that test type and domain.
- Blocking before MVP launch: Whether the missing test must block the current access-token/manual-data/full-fill MVP. Future provider/scheduler/settlement/reward gates may add stronger blocking criteria.

## Test Type Inventory

| Test type | Current coverage | Main files | Important assertions | Main gap |
|---|---|---|---|---|
| Unit test | Covered across most implemented domains | `src/**/*.spec.ts` | Policies, calculations, guards, read-only behavior, write-path branching | Seasons service and admin CLIs have weaker direct coverage than FX/orders |
| Controller test | Partially covered | `src/seasons/seasons.controller.spec.ts` | Optional current-season auth, protected join identity extraction, `x-user-id` ignored | Most controllers rely on mock e2e plus service tests, not controller unit tests |
| Service test | Covered for Auth, FX, Orders, Home, Ranking, Wallets, Records, Portfolio | `src/auth/auth.service.spec.ts`, `src/fx/**/*.spec.ts`, `src/orders/**/*.spec.ts`, `src/home/**/*.spec.ts`, `src/ranking/**/*.spec.ts`, `src/wallets/**/*.spec.ts`, `src/records/**/*.spec.ts`, `src/portfolio/**/*.spec.ts` | Business rules, financial string outputs, no-mutation read paths, write-path guards | Real DB semantics are only covered for selected opt-in integration paths |
| Mock e2e test | Covered for auth baseline and protected API smoke | `test/app.e2e-spec.ts` | Public/optional/protected auth behavior, missing token rejection, `x-user-id` cannot authenticate, selected valid-token smoke | No valid-token HTTP write-path e2e for order create/cancel/execute or FX execute |
| Real PostgreSQL integration test | Covered for FX execute and orders execute, opt-in only | `src/auth/auth.integration.spec.ts`, `src/fx/fx.execute.integration.spec.ts`, `src/orders/orders.execute.integration.spec.ts` | DB write-path success, rollback, race, idempotency, read visibility | Disabled unless env flags are set; not part of default `pnpm test` without opt-in env |
| Opt-in smoke test | Covered for Auth DB smoke and selected execute integration | `src/auth/auth.integration.spec.ts`, `src/fx/fx.execute.integration.spec.ts`, `src/orders/orders.execute.integration.spec.ts` | Can run against real PostgreSQL when env flags are enabled | No opt-in smoke for provider/scheduler/settlement/reward because not implemented |
| Rollback / failure injection test | Covered for FX execute and orders execute | `src/fx/fx.execute.integration.spec.ts`, `src/orders/orders.execute.integration.spec.ts` | Mid-transaction failures roll back debits, credits, ledgers, orders, and positions | Season join rollback and admin CLI rollback are not covered at the same depth |
| Concurrency test | Covered for FX execute and orders execute | `src/fx/fx.execute.integration.spec.ts`, `src/orders/orders.execute.integration.spec.ts` | Concurrent idempotency replay, overspend/oversell protection, same-order execute race, cancel-vs-execute race | Order create duplicate idempotency race is mostly mock/service-level |
| Idempotency test | Covered for FX execute, order create, order execute current-state behavior | `src/fx/**/*.spec.ts`, `src/orders/**/*.spec.ts`, `src/fx/fx.execute.integration.spec.ts`, `src/orders/orders.execute.integration.spec.ts` | Same command replay, conflict rejection, duplicate execute no double mutation | Orders execute exact response replay is not implemented; FX stale pending recovery is not implemented |
| Auth guard regression test | Covered | `src/auth/access-token.guard.spec.ts`, `test/app.e2e-spec.ts` | Public bypass, optional anonymous, protected missing/invalid rejection, inactive user rejection, `x-user-id` ignored | Route-by-route invalid token e2e is not exhaustive |
| No-mutation read-only test | Covered for major read APIs and quote APIs | `src/fx/fx.service.spec.ts`, `src/orders/orders.service.spec.ts`, `src/home/home.service.spec.ts`, `src/ranking/ranking.service.spec.ts`, `src/wallets/wallets.service.spec.ts`, `src/records/records.service.spec.ts` | Reads and quotes do not create wallets, ledgers, orders, rankings, snapshots, or exchange rows | Real DB no-mutation coverage is selective, not exhaustive for every read endpoint |
| No-fake-data policy test | Covered for key admin input and read APIs | `src/assets/asset-admin-input.validation.spec.ts`, `src/fx/fx-rate-input.validation.spec.ts`, `src/home/home.service.spec.ts`, `src/records/records.service.spec.ts` | Static/sample/fake/temporary business trading data is rejected or not synthesized | Provider ingestion must add source-specific no-fake tests before implementation is marked GO |

## Domain Coverage Matrix

| Domain | Covered | Partially covered | Not covered | Main test files | Important assertions | Missing high-value tests | Blocking before MVP launch |
|---|---|---|---|---|---|---|---|
| Auth | Access-token signup/login/me service behavior; global guard behavior; mock e2e public/protected baseline; opt-in real DB smoke | Route-by-route invalid-token e2e is not exhaustive | Refresh token, logout, revocation, cookie/session auth | `src/auth/auth.service.spec.ts`, `src/auth/access-token.guard.spec.ts`, `src/auth/auth.integration.spec.ts`, `test/app.e2e-spec.ts` | Password hashing, duplicate email, wrong password, inactive user, JWT secret fail-closed, `request.user` identity, `x-user-id` rejected | Full HTTP invalid-token matrix for every protected route; refresh/logout/revocation schema and behavior tests when that gate opens | No for access-token MVP. Yes before any refresh/session launch |
| Seasons | Optional current-season controller behavior; mock e2e anonymous and valid optional token behavior; protected join rejects missing token and ignores `x-user-id` | Join transaction behavior is implemented but lacks deep service/integration rollback and race tests | Real PostgreSQL duplicate join race, rollback failure injection, initial wallet grant failure simulation | `src/seasons/seasons.controller.spec.ts`, `test/app.e2e-spec.ts` | Current season may be anonymous; invalid optional token rejects; join identity comes from access token only | Season join real DB test for participant/wallet/ledger atomicity and duplicate join race | Not currently blocking, but should be hardened before large public launch |
| Wallets | Protected auth e2e baseline; service read-only behavior; wallet balances returned as strings | Real DB read visibility coverage is indirect through execute integration | Real HTTP valid-token wallet query against seeded DB | `src/wallets/wallets.service.spec.ts`, `test/app.e2e-spec.ts`, `src/orders/orders.execute.integration.spec.ts` | Missing token blocked; valid token smoke; no mutations from wallet read; USD/KRW cash wallets remain string-valued | Real PostgreSQL read-only smoke for wallet listing after season join and trade/FX writes | No |
| FX quote | Service-level validation, season/join checks, fresh snapshot selection, financial string calculation, no-mutation behavior; protected HTTP valid-token smoke | HTTP e2e does not fully exercise real DB quote data | Provider-backed quote, durable quote reservation, provider source freshness policy | `src/fx/fx.service.spec.ts`, `src/fx/fx-rate-input.validation.spec.ts`, `test/app.e2e-spec.ts` | Quote uses latest approved fresh admin_manual snapshot; stale/missing snapshot errors; quote does not write exchange or wallet rows | Real PostgreSQL HTTP quote with manual snapshot fixtures; final provider timestamp/source-priority tests | No for manual snapshot MVP. Provider-backed quote remains STOP |
| FX execute | Unit/policy tests; opt-in PostgreSQL integration for success, replay, conflict, rollback, concurrency, and insufficient funds | Valid-token HTTP execute e2e is missing; stale pending recovery remains unresolved | Provider-backed execution, durable quote execution, async recovery worker | `src/fx/**/*.spec.ts`, `src/fx/fx.execute.integration.spec.ts` | Transaction creates command, wallet debits/credits, exchange row, two wallet ledgers, and final response atomically; no equity snapshots/fee rows; concurrent overspend blocked | HTTP execute e2e; stale pending retry/recovery design; response payload storage failure recovery | No for current direct-execute MVP. Yes before provider/recovery claims |
| Orders read | Service read-only behavior; protected HTTP auth and valid-token smoke | Real DB order list e2e is limited | Search/pagination hardening beyond current contract | `src/orders/orders.service.spec.ts`, `test/app.e2e-spec.ts`, `src/orders/orders.execute.integration.spec.ts` | Listing does not mutate orders, wallets, positions, ledgers, snapshots, or rankings | Real PostgreSQL order list after create/cancel/execute lifecycle | No |
| Orders quote | Service validation and no-mutation behavior; protected HTTP valid-token smoke; Binance crypto USD quote unit coverage | Real DB HTTP quote with asset/price fixtures is not exhaustive | Durable quote, matching-engine quote, partial fill quote | `src/orders/orders.service.spec.ts`, `test/app.e2e-spec.ts` | Quote uses latest approved admin_manual price; BUY/SELL calculations are strings; Binance crypto USD quote uses USD Wallet and USD/KRW conversion; no order or ledger write | Real PostgreSQL quote with KRW, US stock USD, and Binance crypto USD assets; stale price; missing FX for KRW valuation where applicable | No for full-fill MVP. Durable quote remains STOP |
| Orders create | Service-level submitted-order creation, idempotency replay/conflict, no financial side effects; Binance crypto USD create unit coverage | No opt-in PostgreSQL create race test; no valid-token HTTP create e2e | Matching-engine enqueue, durable quote binding | `src/orders/orders.service.spec.ts`, `test/app.e2e-spec.ts` | Create stores submitted order only; Binance crypto USD create stores USD currency and FX snapshot id; no wallet, position, snapshot, ranking, or settlement side effects; duplicate idempotency handled | Real DB duplicate idempotency race; HTTP create e2e with access token and real asset/price fixtures | Not blocking for current MVP if execute path remains separately hardened; recommended before high traffic |
| Orders cancel | Service-level ownership/status guard and no financial side effects; execute integration covers cancel-vs-execute race | No standalone valid-token HTTP cancel e2e | Batch cancellation or expiry | `src/orders/orders.service.spec.ts`, `src/orders/orders.execute.integration.spec.ts`, `test/app.e2e-spec.ts` | Cancel only updates owned submitted orders; filled/cancelled orders cannot be cancelled; no ledger/wallet/position writes | HTTP cancel e2e; real DB cancellation visibility in orders/records | No |
| Orders execute | Unit and opt-in PostgreSQL integration cover buy/sell success, rollback, overspend/oversell, same-order race, cancel-vs-execute race, read visibility; Binance crypto USD execute unit coverage | Exact response replay for duplicate execute is not implemented; partial fill and matching are intentionally absent | Matching, partial fill, durable quote, settlement-trigger side effects | `src/orders/orders.service.spec.ts`, `src/orders/orders.execute.integration.spec.ts` | Full-fill MVP mutates cash/position/order/ledger atomically; US stocks and Binance crypto use USD wallet; no snapshots, rankings, settlement, or reward writes | HTTP execute e2e; real DB Binance crypto USD execute fixture; exact replay if product requires idempotent response payload; settlement integration tests when settlement gate opens | No for full-fill MVP. Yes for matching/partial-fill/settlement expansion |
| Portfolio valuation | Policy-level valuation, KRW total calculation, stale/missing FX behavior, dry-run snapshot/ranking helpers; Binance crypto USD value -> `cryptoValueKrw` unit coverage | Real DB valuation service coverage is indirect | Provider freshness policy, automatic scheduled valuation | `src/portfolio/portfolio-valuation.policy.spec.ts`, `src/portfolio/portfolio-ranking.policy.spec.ts`, `src/portfolio/snapshot-ranking-generation.spec.ts`, `src/home/home.service.spec.ts` | Final valuation basis is KRW; USD assets require USD/KRW conversion; USD crypto positions contribute to `cryptoValueKrw`; stale data fails instead of faking | Asset price freshness policy finalization; real DB valuation fixtures across KRW/USD/Binance crypto positions | No for manual admin MVP. Yes before final settlement/ranking automation |
| Daily snapshot manual CLI | Dry-run helper behavior and no-write policy are covered | CLI process invocation and non-dry-run real DB writes are not covered | Automatic daily scheduler generation | `src/portfolio/snapshot-ranking-generation.spec.ts`, `scripts/admin-generate-daily-portfolio-snapshot.ts` | Snapshot generation can be planned without mutation; no automatic scheduler implied | Opt-in PostgreSQL smoke for manual snapshot CLI; idempotent rerun behavior; scheduler tests after Gate E | No for manual operation. Yes before automatic daily snapshot claims |
| Ranking manual CLI | Ranking sort/tie behavior and dry-run generation covered; read API covered separately | Manual CLI non-dry-run real DB write path is not covered | Automatic season ranking scheduler | `src/portfolio/portfolio-ranking.policy.spec.ts`, `src/portfolio/snapshot-ranking-generation.spec.ts`, `src/ranking/ranking.service.spec.ts`, `scripts/admin-generate-season-ranking.ts` | Rankings are derived from KRW total assets; ranking API is read-only and does not synthesize data | Opt-in PostgreSQL smoke for ranking CLI; automatic generation tests after scheduler gate | No for read-only API. Yes before automatic ranking claims |
| Home | Service-level aggregate behavior, blocked/guide states, no fake data, no mutation; protected HTTP auth/valid smoke | Real DB HTTP home scenario coverage is limited | Automatic snapshot freshness and settlement/reward integration | `src/home/home.service.spec.ts`, `test/app.e2e-spec.ts` | Home is one aggregate API; season non-participation is blocked/guide, not empty success; read does not mutate | Real PostgreSQL home scenarios for joined/not joined, stale valuation, daily snapshot fallback | No for current MVP baseline |
| Records | Service-level read-only records behavior; protected HTTP auth/valid smoke; execute integration proves write visibility in records | Real DB records filtering/pagination coverage is limited | External provider event records, settlement/reward records | `src/records/records.service.spec.ts`, `test/app.e2e-spec.ts`, `src/orders/orders.execute.integration.spec.ts` | Records read exchange, wallet transaction, and order history without mutation or fake data | Real PostgreSQL records read after FX execute plus order create/cancel/execute lifecycle | No |

## High-Value Missing Tests Before Opening Future Gates

| Future gate | Missing tests that should be planned before implementation GO |
|---|---|
| Provider final selection / ingestion | Source contract fixtures, Binance BTCUSDT ticker/orderbook fixtures, USDT-to-USD owner decision, timestamp/freshness handling, stale provider rejection, duplicate snapshot handling, no fake/static fallback, provider outage behavior |
| Scheduler / batch | Locking/idempotency, rerun safety, skipped-run recovery, partial failure reporting, manual override coexistence |
| Settlement | Pre/post season cutoff, final KRW valuation freeze, trade/FX block enforcement after season end, reward/ranking side-effect boundaries |
| Reward / badge / trophy | Settlement-only source of truth, duplicate grant prevention, rollback on reward failure, read model consistency |
| Refresh token / logout / revocation | Schema migration tests, token rotation, revocation replay, inactive user handling, cookie/session policy if introduced |
| Deployment / operations | Environment validation, migration status, seed policy, health/db behavior, real smoke tests against deployed-like PostgreSQL |

## Coverage Conclusions

- The strongest current safety coverage is in `FX execute` and `Orders execute`, especially under opt-in PostgreSQL integration tests.
- The strongest auth coverage is at the guard/service level plus mock e2e baseline. The current backend is access-token-only.
- Read-only APIs have solid service-level no-mutation assertions, but only limited real DB HTTP e2e.
- Provider ingestion, scheduler/batch, settlement, reward, and refresh/logout/revocation have no implementation coverage because those gates remain closed.
- Manual CLI and automatic scheduler must not be treated as equivalent: daily snapshots and rankings currently have manual script surfaces and helper tests, not automatic batch execution.
