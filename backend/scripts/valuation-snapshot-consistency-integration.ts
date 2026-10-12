/** TC-D05 opt-in, disposable PostgreSQL. A valuation must value ONE committed
 * state of an account, never pre-trade cash with post-trade holdings.
 *
 * The concurrent writers are the real financial commands (Spot market/limit,
 * FX, wallet transfer, Futures open/increase/reduce/close). A pg-level barrier
 * on the reader pool commits each command between two SELECTs of the
 * valuation's relational read, which is where the audit observed the mixed
 * 1,540,000 KRW result. No provider/Redis/HTTP calls; fixtures are uniquely
 * named and removed by ID. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../src/generated/prisma/client';
import type { PrismaService } from '../src/prisma/prisma.service';
import { BatchService } from '../src/batch/batch.service';
import { OrdersService } from '../src/orders/orders.service';
import { FxService } from '../src/fx/fx.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { GeneralAccountPerformanceService } from '../src/portfolio/general-account-performance.service';
import { GeneralExternalFundingService } from '../src/portfolio/general-external-funding.service';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import { TradingAccountPortfolioService } from '../src/portfolio/trading-account-portfolio.service';
import { RankingRefreshService } from '../src/ranking/ranking-refresh.service';
import { DailyPortfolioSnapshotJobService } from '../src/batch/daily-portfolio-snapshot-job.service';
import { OrderReservationService } from '../src/orders/order-reservation.service';
import { LimitOrderCreateService } from '../src/orders/limit-order-create.service';
import { LimitOrderCancelService } from '../src/orders/limit-order-cancel.service';
import { LimitOrderExecutionService } from '../src/orders/limit-order-execution.service';
import { LimitOrderMatchingService } from '../src/orders/limit-order-matching.service';
import { LimitOrderCandidateRepository } from '../src/orders/limit-order-candidate.repository';
import { LimitOrderCandleEvidenceService } from '../src/orders/limit-order-candle-evidence.service';
import { PortfolioValuationError } from '../src/portfolio/portfolio-valuation.policy';

// Writes fixtures: loopback, disposable databases only (same rule as the
// beginner suites; CI's service container database is `trading_app`).
const target = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (
  process.env.NODE_ENV !== 'test' ||
  process.env.VALUATION_CONSISTENCY_DB_INTEGRATION !== '1' ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  !(
    target.pathname.endsWith('_test') ||
    (process.env.GITHUB_ACTIONS === 'true' &&
      target.pathname === '/trading_app')
  )
)
  throw new Error(
    'Requires NODE_ENV=test, VALUATION_CONSISTENCY_DB_INTEGRATION=1 and a local disposable *_test DATABASE_URL.',
  );
// The shared Futures fixture module guards on its own opt-in flag.
process.env.FUTURES_DB_INTEGRATION = '1';
process.env.LIMIT_ORDER_ENABLED = 'true';
process.env.SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED = 'true';
Logger.overrideLogger(false);

type Futures = typeof import('./futures-integration.js');
type Scenario = Awaited<ReturnType<Futures['fixture']>>;

// ---------------------------------------------------------------- reader pool
// Every valuation under test runs on this pool. Writer commands use the shared
// fixture module's own PrismaService, i.e. a different pool and connection.
const READER = Symbol('valuation-reader');
type Gate = {
  table: 'positions' | 'futures_positions';
  accountId: string;
  write: () => Promise<unknown>;
  fired: boolean;
  failure?: unknown;
};
let gate: Gate | null = null;
let trace: string[] | null = null;
type Tagged = { [READER]?: true };
type QueryConfig = { text?: string; values?: unknown };
// Invoked with Reflect.apply and the original receiver.
// eslint-disable-next-line @typescript-eslint/unbound-method
const originalQuery = pg.Client.prototype.query as (
  ...args: unknown[]
) => unknown;
function statementLabel(text: string) {
  const head = text.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
  if (head !== 'SELECT') return text.trim().toUpperCase().slice(0, 30);
  return `SELECT ${/FROM "public"\."(\w+)"/.exec(text)?.[1] ?? '?'}`;
}
// Prisma's adapter uses both Pool.query's callback and Client.query's promise
// interface; the barrier supports both.
pg.Client.prototype.query = function (
  this: pg.ClientBase & Tagged,
  ...args: unknown[]
) {
  const run = (): unknown => Reflect.apply(originalQuery, this, args);
  if (!this[READER]) return run();
  const first = args[0];
  const config = typeof first === 'object' ? (first as QueryConfig) : null;
  const text = typeof first === 'string' ? first : config?.text;
  const values = config?.values ?? args[1];
  if (typeof text === 'string') trace?.push(statementLabel(text));
  const current = gate;
  if (
    current &&
    !current.fired &&
    typeof text === 'string' &&
    text.includes(`FROM "public"."${current.table}"`) &&
    JSON.stringify(values ?? []).includes(current.accountId)
  ) {
    current.fired = true;
    // Commit the real command on the writer pool, then let this SELECT run.
    const committed = current.write().catch((error: unknown) => {
      current.failure = error;
    });
    if (args.some((arg) => typeof arg === 'function')) {
      void committed.then(run);
      return undefined;
    }
    return committed.then(run);
  }
  return run();
} as typeof pg.Client.prototype.query;

const readerPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 4,
});
readerPool.on('connect', (client) => {
  (client as pg.PoolClient & Tagged)[READER] = true;
});
const reader = new PrismaClient({
  adapter: new PrismaPg(readerPool),
}) as unknown as PrismaService;

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out: ${label}`)),
          30_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
async function traced<T>(run: () => Promise<T>) {
  const statements: string[] = [];
  trace = statements;
  try {
    return { value: await run(), statements };
  } finally {
    trace = null;
  }
}

type Outcome = {
  label: string;
  before: string;
  during: string;
  after: string;
  consistent: boolean;
  statements: string[];
};
const outcomes: Outcome[] = [];
const notes: string[] = [];

/** before → (barrier: real command commits between two SELECTs) → after. */
async function race(input: {
  label: string;
  accountId: string;
  table: Gate['table'];
  write: () => Promise<unknown>;
  read: () => Promise<string>;
  /** Assets move between wallets only: the total cannot change. */
  totalUnchanged?: boolean;
  /** Some paths persist their value; read it back after `read`. */
  persisted?: () => Promise<string>;
}) {
  const before = await bounded(input.read(), `${input.label} before`);
  gate = {
    table: input.table,
    accountId: input.accountId,
    write: input.write,
    fired: false,
  };
  const active = gate;
  let during: string;
  let statements: string[];
  try {
    ({ value: during, statements } = await traced(() =>
      bounded(input.read(), `${input.label} during`),
    ));
  } finally {
    gate = null;
  }
  if (active.failure)
    throw active.failure instanceof Error
      ? active.failure
      : new Error(JSON.stringify(active.failure));
  assert.equal(active.fired, true, `${input.label}: barrier never reached`);
  if (input.persisted) during = await input.persisted();
  const after = await bounded(input.read(), `${input.label} after`);
  if (input.totalUnchanged) assert.equal(before, after, input.label);
  else
    assert.notEqual(
      before,
      after,
      `${input.label}: the command must change the valuation under test`,
    );
  const consistent = during === before || during === after;
  outcomes.push({
    label: input.label,
    before,
    during,
    after,
    consistent,
    statements,
  });
  console.log(
    `${consistent ? 'CONSISTENT' : 'MIXED'} ${input.label} before=${before} during=${during} after=${after} reader=[${statements.join(', ')}]`,
  );
}

async function main() {
  const f: Futures = await import('./futures-integration.js');
  const { db, app, fixture, now, price, fxEvidence, cleanup, untilDb } = f;

  // Writer-side real commands (fixture module's pool).
  const writerValuation = new PortfolioValuationService(db);
  const writerPerformance = new GeneralAccountPerformanceService(
    db,
    writerValuation,
    new GeneralExternalFundingService(db),
  );
  const writerAccess = new TradingAccountAccessService(db);
  const reservation = new OrderReservationService();
  const orders = new OrdersService(
    db,
    undefined,
    new LimitOrderCreateService(db, reservation),
    new LimitOrderCancelService(db, reservation),
    writerAccess,
    writerPerformance,
  );
  const candles = new LimitOrderCandleEvidenceService(db);
  const matcher = new LimitOrderMatchingService(
    db,
    new LimitOrderCandidateRepository(db),
    candles,
    new LimitOrderExecutionService(db, candles, orders, writerPerformance),
  );
  const fx = new FxService(
    db,
    undefined,
    undefined,
    writerAccess,
    writerPerformance,
    writerValuation,
  );

  // Reader-side services under test.
  const valuation = new PortfolioValuationService(reader);
  const portfolio = new TradingAccountPortfolioService(
    reader,
    new TradingAccountAccessService(reader),
    new GeneralAccountPerformanceService(
      reader,
      valuation,
      new GeneralExternalFundingService(reader),
    ),
    valuation,
  );
  const ranking = new RankingRefreshService(reader, valuation);
  const daily = new DailyPortfolioSnapshotJobService(
    new BatchService(reader),
    reader,
    valuation,
  );

  const scenarios: Scenario[] = [];
  const batchKeys: string[] = [];
  const open = async (mode: 'season' | 'general') => {
    const s = await fixture(mode, '10000');
    scenarios.push(s);
    return s;
  };
  /** Valuation evidence 1s before `at`: Spot 100, Mark 105, FX 1400. The
   * Mark differs from the Futures Last 100 used for execution, so an open
   * Futures position always carries a non-zero unrealized PnL. */
  let lastCommandEvidence = 0;
  async function evidence(s: Scenario) {
    // Valuation evidence must be the newest at `at`, never a command's.
    await untilDb(lastCommandEvidence + 1100);
    await fxEvidence();
    const clock = await now();
    const observed = new Date(clock.getTime() - 1000);
    for (const row of s.instruments) {
      await db.assetPriceSnapshot.create({
        data: {
          assetId: row.asset.id,
          price: '100',
          currencyCode: 'USD',
          sourceType: 'provider_api',
          sourceName: 'binance_spot_ws_ticker',
          effectiveAt: observed,
          capturedAt: observed,
        },
      });
      await db.futuresMarkSnapshot.createMany({
        data: [
          {
            instrumentId: row.instrument.id,
            symbol: row.asset.symbol,
            source: 'binance_usdm_mark_ws',
            price: '105',
            effectiveAt: observed,
            capturedAt: observed,
          },
        ],
        skipDuplicates: true,
      });
    }
    return clock;
  }
  const total =
    (
      s: Scenario,
      at: Date,
      workflow:
        | 'home_live_valuation'
        | 'live_portfolio_valuation'
        | 'daily_portfolio_snapshot' = 'home_live_valuation',
    ) =>
    async () =>
      (
        await valuation.calculateTradingAccountValuation(
          s.accountId,
          at,
          workflow,
        )
      ).totalAssetKrw;

  async function spotOrder(
    s: Scenario,
    side: 'buy' | 'sell',
    orderType: 'market' | 'limit' = 'market',
    assetId = s.instruments[0].asset.id,
  ) {
    const body = {
      assetId,
      side,
      orderType,
      ...(side === 'buy' ? { amount: '200' } : { quantity: '1' }),
      ...(orderType === 'limit' ? { limitPrice: '100' } : {}),
    };
    const quote = await orders.quoteOrderForTradingAccount(
      s.userId,
      s.accountId,
      body,
    );
    return orders.createOrderForTradingAccount(s.userId, s.accountId, {
      ...body,
      quoteId: quote.data.quoteId!,
      idempotencyKey: randomUUID(),
    });
  }
  async function usdWallet(s: Scenario, scope: 'securities' | 'crypto_spot') {
    return db.cashWallet.findUniqueOrThrow({
      where: {
        tradingAccountId_walletScope_currencyCode: {
          tradingAccountId: s.accountId,
          walletScope: scope,
          currencyCode: 'USD',
        },
      },
    });
  }
  /** Real Futures command with execution evidence (Last = Mark = 100) taken at
   * command time, i.e. newer than any fixed valuation instant `at`. */
  async function futuresCommand(
    s: Scenario,
    operation: 'open' | 'increase' | 'reduce' | 'close',
  ) {
    await price(s, '100', 0, 0);
    const clock = await now();
    lastCommandEvidence = clock.getTime();
    await db.futuresMarkSnapshot.createMany({
      data: [
        {
          instrumentId: s.instruments[0].instrument.id,
          symbol: s.instruments[0].asset.symbol,
          source: 'binance_usdm_mark_ws',
          price: '100',
          effectiveAt: clock,
          capturedAt: clock,
        },
      ],
      skipDuplicates: true,
    });
    const body =
      operation === 'open'
        ? f.openBody(s, { quantity: '2', leverage: 5 })
        : await f.positionBody(
            s,
            operation,
            operation === 'close'
              ? {
                  quantity: (
                    await db.futuresPosition.findFirstOrThrow({
                      where: { tradingAccountId: s.accountId, status: 'open' },
                    })
                  ).quantity.toString(),
                }
              : {},
          );
    return app.futures.execute(s.userId, s.accountId, body);
  }

  try {
    await db.$connect();
    await reader.$connect();

    // ---- 7.1/7.2 Spot: market buy/sell and matcher limit fill (season).
    {
      const s = await open('season');
      let at = await evidence(s);
      await race({
        label: 'season spot market buy',
        accountId: s.accountId,
        table: 'positions',
        write: () => spotOrder(s, 'buy'),
        read: total(s, at),
      });
      at = await evidence(s);
      await race({
        label: 'season spot market sell',
        accountId: s.accountId,
        table: 'positions',
        write: () => spotOrder(s, 'sell'),
        read: total(s, at),
      });
      await evidence(s);
      await spotOrder(s, 'buy', 'limit');
      at = await evidence(s);
      await race({
        label: 'season spot limit fill (matcher Path A)',
        accountId: s.accountId,
        table: 'positions',
        write: async () => {
          // Path A needs a ticker observed after submission (newer than `at`).
          const clock = await now();
          lastCommandEvidence = clock.getTime();
          await db.assetPriceSnapshot.create({
            data: {
              assetId: s.instruments[0].asset.id,
              price: '100',
              currencyCode: 'USD',
              sourceType: 'provider_api',
              sourceName: 'binance_spot_ws_ticker',
              effectiveAt: clock,
              capturedAt: clock,
            },
          });
          const summary = await matcher.matchDueLimitOrders({
            now: await now(),
          });
          assert.ok(summary.filledPathA >= 1, JSON.stringify(summary));
        },
        read: total(s, at),
      });
    }

    // ---- 7.2 FX and wallet transfer (wallet-only atomic changes, season).
    {
      const s = await open('season');
      let at = await evidence(s);
      await race({
        label: 'season FX execute KRW→USD',
        accountId: s.accountId,
        table: 'positions',
        write: async () => {
          const request = {
            fromCurrency: 'KRW',
            toCurrency: 'USD',
            sourceAmount: '1000000',
          };
          const quote = await fx.quoteForTradingAccount(
            s.userId,
            s.accountId,
            request,
          );
          await fx.executeForTradingAccount(s.userId, s.accountId, {
            ...request,
            quoteId: quote.data.quoteId,
            idempotencyKey: randomUUID(),
          });
        },
        read: total(s, at),
      });
      // 7.6 The season FX command valued its OWN uncommitted wallets in-tx.
      const fxSnapshot = await db.equitySnapshot.findFirstOrThrow({
        where: {
          tradingAccountId: s.accountId,
          snapshotReason: 'exchange_executed',
        },
        orderBy: { capturedAt: 'desc' },
      });
      const committed = await valuation.calculateTradingAccountValuation(
        s.accountId,
        fxSnapshot.capturedAt,
        'live_portfolio_valuation',
      );
      assert.equal(
        fxSnapshot.totalAssetKrw.toFixed(8),
        committed.totalAssetKrw,
        'in-transaction FX equity snapshot must equal the committed state',
      );
      notes.push(
        `in-tx season FX equity snapshot ${fxSnapshot.totalAssetKrw.toFixed(8)} = committed valuation`,
      );
      at = await evidence(s);
      await race({
        label: 'season wallet transfer securities→crypto_spot',
        accountId: s.accountId,
        table: 'positions',
        totalUnchanged: true,
        write: async () => {
          const [source, destination] = await Promise.all([
            usdWallet(s, 'securities'),
            usdWallet(s, 'crypto_spot'),
          ]);
          await app.transfer.transfer(s.userId, s.accountId, {
            sourceWalletId: source.id,
            destinationWalletId: destination.id,
            amount: '100',
            idempotencyKey: randomUUID(),
          });
        },
        read: total(s, at),
      });
    }

    // ---- 7.3 Futures wallet + position change together (season, general).
    for (const mode of ['season', 'general'] as const) {
      const s = await open(mode);
      for (const operation of [
        'open',
        'increase',
        'reduce',
        'close',
      ] as const) {
        const at = await evidence(s);
        await race({
          label: `${mode} futures ${operation}`,
          accountId: s.accountId,
          table: 'futures_positions',
          write: () => futuresCommand(s, operation),
          read: total(s, at),
        });
      }
    }

    // ---- 7.4 Season portfolio GET (default client) / general GET (RR tx).
    {
      const s = await open('season');
      await evidence(s);
      await race({
        label: 'season portfolio GET during spot buy',
        accountId: s.accountId,
        table: 'positions',
        write: () => spotOrder(s, 'buy'),
        read: async () => {
          const response = await portfolio.getPortfolio(s.userId, s.accountId);
          const data = response.data as {
            summary?: { totalAssetKrw: string };
          };
          assert.ok(data.summary, JSON.stringify(response.data));
          return data.summary.totalAssetKrw;
        },
      });
    }
    {
      const s = await open('general');
      await evidence(s);
      await race({
        label: 'general portfolio GET during futures open',
        accountId: s.accountId,
        table: 'futures_positions',
        write: () => futuresCommand(s, 'open'),
        read: async () => {
          const response = await portfolio.getPortfolio(s.userId, s.accountId);
          const data = response.data as {
            summary?: { totalAssetKrw: string };
          };
          assert.ok(data.summary, JSON.stringify(response.data));
          return data.summary.totalAssetKrw;
        },
      });
      const general = outcomes.at(-1)!.statements;
      assert.equal(
        general.filter((label) => label === 'BEGIN').length,
        1,
        'general GET must remain ONE RepeatableRead tx',
      );
      // Prisma 7 nests tx.$transaction as a SAVEPOINT, not another BEGIN; the
      // only isolation statement is the existing wrapper's own.
      assert.equal(
        general.filter((label) => label.startsWith('SET TRANSACTION')).length,
        1,
        `one isolation statement: ${general.join(', ')}`,
      );
      assert.equal(
        general.some((label) => label.startsWith('SAVEPOINT')),
        false,
        `no nested transaction: ${general.join(', ')}`,
      );
    }

    // ---- 7.5 Current ranking: two participants valued in sequence, sharing
    // one asset price read; the second account trades mid-valuation.
    {
      const a = await open('season');
      const b = await open('season');
      await db.seasonParticipant.update({
        where: { tradingAccountId: b.accountId },
        data: { seasonId: a.season!.id },
      });
      await evidence(a);
      await evidence(b);
      const assetId = a.instruments[0].asset.id;
      await spotOrder(a, 'buy', 'market', assetId);
      await spotOrder(b, 'buy', 'market', assetId);
      const at = await evidence(a);
      const participantB = await db.seasonParticipant.findUniqueOrThrow({
        where: { tradingAccountId: b.accountId },
      });
      const aValue = await total(a, at, 'live_portfolio_valuation')();
      const single = await traced(() =>
        total(a, at, 'live_portfolio_valuation')(),
      );
      await race({
        label: 'current ranking refresh (participant B buys mid-valuation)',
        accountId: b.accountId,
        table: 'positions',
        write: () => spotOrder(b, 'buy', 'market', assetId),
        read: async () => {
          if (!gate) return total(b, at, 'live_portfolio_valuation')();
          // Traced: the refresh alone; `persisted` supplies its value.
          await ranking.refreshCurrentRankingForSeason(a.season!.id, {
            capturedAt: at,
            createEquitySnapshots: true,
          });
          return 'persisted';
        },
        persisted: async () => {
          const rows = await db.seasonRanking.findMany({
            where: { seasonId: a.season!.id, rankType: 'daily' },
          });
          assert.equal(rows.length, 2);
          const rowA = rows.find((r) => r.tradingAccountId === a.accountId)!;
          assert.equal(rowA.totalAssetKrw.toFixed(8), aValue);
          const refreshed = await db.seasonParticipant.findUniqueOrThrow({
            where: { id: participantB.id },
          });
          const rowB = rows.find((r) => r.tradingAccountId === b.accountId)!;
          assert.equal(
            refreshed.totalAssetKrw.toFixed(8),
            rowB.totalAssetKrw.toFixed(8),
          );
          return rowB.totalAssetKrw.toFixed(8);
        },
      });
      const rankingTrace = outcomes.at(-1)!.statements;
      const count = (list: string[], table: string) =>
        list.filter((l) => l === `SELECT ${table}`).length;
      for (const table of ['asset_price_snapshots', 'fx_rate_snapshots'])
        assert.equal(
          count(rankingTrace, table),
          count(single.statements, table),
          `ranking must reuse ${table} reads across participants`,
        );
      notes.push(
        `ranking price reads: asset_price_snapshots=${count(rankingTrace, 'asset_price_snapshots')} fx_rate_snapshots=${count(rankingTrace, 'fx_rate_snapshots')} for 2 participants (single valuation: ${count(single.statements, 'asset_price_snapshots')}/${count(single.statements, 'fx_rate_snapshots')})`,
      );
    }

    // ---- 7.5 Daily portfolio snapshot job.
    {
      const s = await open('season');
      await evidence(s);
      const clock = await now();
      const idempotencyKey = `tc-d05-${randomUUID()}`;
      batchKeys.push(idempotencyKey);
      await race({
        label: 'daily portfolio snapshot job during spot buy',
        accountId: s.accountId,
        table: 'positions',
        write: () => spotOrder(s, 'buy'),
        read: async () => {
          if (gate) {
            const run = await daily.run({
              seasonId: s.season!.id,
              snapshotDate: clock.toISOString().slice(0, 10),
              requestedBy: 'tc-d05-integration',
              idempotencyKey,
            });
            assert.equal(
              (run as { status?: string }).status ?? 'succeeded',
              'succeeded',
              JSON.stringify(run),
            );
            return 'persisted';
          }
          return (
            await valuation.calculateTradingAccountValuation(
              s.accountId,
              new Date((await now()).getTime()),
              'daily_portfolio_snapshot',
            )
          ).totalAssetKrw;
        },
        persisted: async () =>
          (
            await db.dailyPortfolioSnapshot.findFirstOrThrow({
              where: { tradingAccountId: s.accountId },
            })
          ).totalAssetKrw.toFixed(8),
      });
    }

    // ---- 7.6 Inside a caller's transaction: own uncommitted changes, no
    // nested transaction, no deadlock.
    {
      const s = await open('season');
      const at = await evidence(s);
      const before = await total(s, at)();
      const rollback = new Error('tc-d05-rollback');
      let inTx = '';
      const { statements } = await traced(() =>
        bounded(
          reader
            .$transaction(async (tx) => {
              await tx.cashWallet.update({
                where: {
                  tradingAccountId_walletScope_currencyCode: {
                    tradingAccountId: s.accountId,
                    walletScope: 'crypto_spot',
                    currencyCode: 'USD',
                  },
                },
                data: { balanceAmount: { decrement: '50' } },
              });
              await tx.position.create({
                data: {
                  tradingAccountId: s.accountId,
                  assetId: s.instruments[1].asset.id,
                  quantity: '1',
                  averageCost: '100',
                  currencyCode: 'USD',
                  realizedPnl: '0',
                  realizedPnlKrw: '0',
                },
              });
              inTx = (
                await valuation.calculateTradingAccountValuation(
                  s.accountId,
                  at,
                  'home_live_valuation',
                  tx,
                )
              ).totalAssetKrw;
              throw rollback;
            })
            .catch((error: unknown) => {
              if (error !== rollback) throw error;
            }),
          'in-transaction valuation',
        ),
      );
      // −50 USD cash, +1 × 100 USD position at 1400 KRW/USD = +70,000 KRW.
      assert.equal(
        new Prisma.Decimal(inTx).sub(before).toFixed(8),
        '70000.00000000',
        'in-transaction valuation must see its own uncommitted changes',
      );
      assert.equal(await total(s, at)(), before, 'rolled back');
      assert.equal(
        statements.filter((l) => l === 'BEGIN').length,
        1,
        `no nested transaction inside the caller's: ${statements.join(', ')}`,
      );
      assert.equal(
        statements.some((l) => /^(SAVEPOINT|SET TRANSACTION)/.test(l)),
        false,
        `no savepoint/isolation change inside the caller's: ${statements.join(', ')}`,
      );
      notes.push(
        `in-tx valuation sees uncommitted +70000 KRW; reader=[${statements.join(', ')}]`,
      );

      // ---- 7.3 Invalid evidence keeps the existing fail-closed error codes.
      await futuresCommand(s, 'open');
      const codeAt = async (at: Date) => {
        try {
          await valuation.calculateTradingAccountValuation(
            s.accountId,
            at,
            'home_live_valuation',
          );
          return 'NO_ERROR';
        } catch (error) {
          assert.ok(error instanceof PortfolioValuationError, String(error));
          return error.code;
        }
      };
      const later = new Date((await now()).getTime() + 60_000);
      const earlier = new Date(at.getTime() - 3_600_000);
      const stale = await codeAt(later);
      const missing = await codeAt(earlier);
      notes.push(`Mark 60s old → ${stale}; no evidence yet → ${missing}`);
      // Pinned to the pre-change behavior: a stale or missing Mark is
      // FUTURES_MARK_UNAVAILABLE (readFuturesMark returns no candidate).
      assert.equal(stale, 'FUTURES_MARK_UNAVAILABLE');
      assert.equal(missing, 'FUTURES_MARK_UNAVAILABLE');
      // The pool is not left holding a failed transaction.
      assert.notEqual(await total(s, await evidence(s))(), '');
    }

    for (const note of notes) console.log(`NOTE ${note}`);
    const mixed = outcomes.filter((o) => !o.consistent);
    console.log(
      `valuation snapshot consistency: ${outcomes.length - mixed.length}/${outcomes.length} consistent`,
    );
    assert.deepEqual(
      mixed.map((o) => o.label),
      [],
      'mixed-snapshot valuations observed',
    );
    console.log('valuation snapshot consistency PostgreSQL ok');
  } finally {
    const accountIds = scenarios.map((s) => s.accountId);
    const seasonIds = scenarios.flatMap((s) => (s.season ? [s.season.id] : []));
    await db.seasonRanking.deleteMany({
      where: {
        OR: [
          { seasonId: { in: seasonIds } },
          { tradingAccountId: { in: accountIds } },
        ],
      },
    });
    await db.dailyPortfolioSnapshot.deleteMany({
      where: { tradingAccountId: { in: accountIds } },
    });
    await db.batchJobRun.deleteMany({
      where: { idempotencyKey: { in: batchKeys } },
    });
    await db.order.deleteMany({
      where: { tradingAccountId: { in: accountIds } },
    });
    await db.position.deleteMany({
      where: { tradingAccountId: { in: accountIds } },
    });
    for (const s of scenarios.reverse())
      await cleanup(s).catch((error: unknown) => {
        console.error('cleanup failed', s.accountId, error);
        process.exitCode = 1;
      });
    await db.fxRateSnapshot.deleteMany({
      where: { id: { in: f.fxEvidenceIds } },
    });
    await reader.$disconnect();
    await readerPool.end().catch(() => undefined);
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
