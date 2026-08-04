# Release verification — the canonical environment and commands (작업 11 §16·§17)

One environment, one command per gate. Two runs of the same gate that disagree
must differ in the CODE, not in whose machine ran them — every past
"119/122 here, 63 failures there" report was an environment difference wearing a
regression's clothes.

## Canonical environment

| | Value |
| --- | --- |
| Node | 24.x (24.14.1 verified) — required: the frontend suite relies on Node 24 type stripping |
| pnpm | 10.33.0 (backend; pinned in CI) |
| npm | 11.x (frontend only; `npm ci`) |
| PostgreSQL | 16 |
| Redis | 7 |
| `DATABASE_URL` | `postgresql://trading_app:trading_app_pw@localhost:5432/trading_app?schema=public` |
| `REDIS_URL` | `redis://localhost:6379` |
| DB timezone | **UTC**, without exception |
| Migrations | `prisma migrate deploy` against an empty database; never `migrate reset` on a shared one |
| Seed | none for verification — every suite creates and cleans its own fixtures |
| Test execution | DB suites **serially** (`--runInBand`); they share one database |
| External providers | not configured and not contacted; KIS/Binance/ad-provider suites stay opt-in and skip |

The PostgreSQL server timezone is not a preference. Prisma reads `timestamptz`
against the server zone, so a KST server shifts every stored instant by nine
hours and silently moves snapshot and settlement boundaries — the suites still
pass, and the numbers are wrong.

## The gates

### Backend

```bash
cd backend
pnpm install --frozen-lockfile
pnpm exec prisma format && pnpm exec prisma validate
pnpm exec prisma generate
pnpm exec prisma migrate deploy
pnpm exec prisma migrate status
pnpm exec prisma migrate diff \
  --from-config-datasource --to-schema prisma/schema.prisma --exit-code   # 0 = no drift
pnpm run typecheck
pnpm run build
pnpm test                        # unit
pnpm run lint:candles:check      # gated area 1
pnpm run lint:accounts:check     # gated area 2 (작업 11)
```

`migrate diff --exit-code` returns **2** on any difference, index names
included. Where a migration named an index explicitly, `schema.prisma` pins the
same name with `map:` — otherwise Prisma computes a truncated default, the gate
reports a rename against a database that is in fact correct, and a check that
fails on every green build stops being read.

### Core account DB integration

Serially, against PostgreSQL 16 + Redis 7:

```bash
cd backend
DATABASE_URL=... REDIS_URL=... \
TRADING_ACCOUNT_DB_INTEGRATION=1 SEASON_JOIN_DB_INTEGRATION=1 \
LIMIT_ORDER_ENABLED=true AD_REWARD_ENABLED=true \
AUTH_DB_SMOKE=1 OPS_JOB_LOCK_DB_SMOKE=1 JWT_ACCESS_SECRET=ci-core-account-secret \
pnpm exec jest --runInBand \
  src/seasons/trading-account.integration.spec.ts \
  src/seasons/trading-account-link.integration.spec.ts \
  src/seasons/trading-account-financial-scope.integration.spec.ts \
  src/seasons/trading-account-trading-scope.integration.spec.ts \
  src/trading-accounts/general-account.integration.spec.ts \
  src/orders/order-replay-and-cancel-scope.integration.spec.ts \
  src/portfolio/general-performance-hardening.integration.spec.ts \
  src/portfolio/snapshot-scope-audit.integration.spec.ts \
  src/ranking/season-ranking-scope.integration.spec.ts \
  src/seasons/seasons.join.integration.spec.ts \
  src/auth/auth.integration.spec.ts \
  src/ops/ops-job-lock.integration.spec.ts
```

The money-layer order/FX/limit-order suites run in their own job with
`LIMIT_ORDER_*`, `ORDER_EXECUTE_DB_INTEGRATION`, `FX_EXECUTE_DB_INTEGRATION`
and `MVP_FLOW_DB_SMOKE`. Run everything at once with
`--testPathPatterns=integration` and the union of both flag sets.

### Canonical release-critical E2E

```bash
cd backend && pnpm run test:e2e
```

**It takes no environment variables.** That is a property of the suite, not an
omission: it signs its tokens with the secret the application itself resolves
and pins the scheduler and calendar inputs it depends on. If this command ever
needs a variable again, the suite has gone back to depending on whose machine it
ran on — fix the suite, do not document the variable.

### Frontend

```bash
cd frontend
npm ci
npm run typecheck
npm test            # node --test
npm run export:web  # production bundle; proves every module resolves
```

There is no ESLint in the frontend app and none was added for this work — a new
lint toolchain is infrastructure, and the two gates that catch what mattered
here (`tsc --noEmit`, and the source-scanning
`legacyFinancialCalls.test.ts`) already run on every commit.

### Operational tools (dry-run — must not write)

```bash
cd backend
pnpm run trading-accounts:repair-links
pnpm run trading-accounts:repair-financial-scope
pnpm run trading-accounts:repair-trading-scope
pnpm run trading-accounts:repair-snapshot-scope
pnpm run trading-accounts:repair-ranking-scope
pnpm run trading-accounts:audit-general
```

Bare invocation is a dry-run; writes require `--apply`. Findings 0 with exit 0
is the expected result on a healthy database. **A clean database proves only
half of it** — that these tools say "0" when there is nothing wrong. The other
half, that they say something when there IS, is covered by the damage-injection
integration suites (`snapshot-scope-audit`, `trading-account-*-scope`,
`general-account`), and that is the half worth trusting.

## CI mapping

| Job | Gate |
| --- | --- |
| Backend quality | install, generate, candle lint/format, **trading-account lint**, typecheck, build, unit |
| Frontend quality | `npm ci`, typecheck, tests, **web export** |
| Limit order PostgreSQL integration | migrations + drift + money-layer order/FX suites |
| **Core account PostgreSQL integration** | migrations + drift + account/general/ranking/settlement suites + repair·audit dry-runs |
| **Release-critical E2E** | `pnpm test:e2e`, no environment variables |
| Candle fixture integration | fixture-provider candle pipeline |

## Release checklist

1. `prisma migrate status` — no unapplied migrations.
2. `prisma migrate diff --exit-code` — 0.
3. Repair ×5 + `audit-general` dry-run — findings 0. If any are non-zero, stop:
   apply is a decision, not a step.
4. Backend gates green; core account integration green; canonical e2e green.
5. Frontend typecheck + tests + web export green.
6. Deploy backend, then frontend.
7. Smoke, in this order: login → account list loads → fallback selection →
   season/general switch → order + cancel reflected in wallet and positions →
   general account blocked from trading and FX (and the server still answers
   409) → logout → second user sees none of the first user's data.
