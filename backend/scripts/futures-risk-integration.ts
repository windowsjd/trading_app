import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Client } from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import {
  Prisma,
  type FuturesPosition,
  type TradingAccountMode,
} from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { FuturesLiquidationService } from '../src/futures/futures-liquidation.service';
import { FuturesRiskWorker } from '../src/futures/futures-risk-worker.service';
import { futuresRiskConfig } from '../src/futures/futures.config';
import { FuturesMarkIngestion } from '../src/futures/futures-mark-ingestion.service';
import { OpsJobLockService } from '../src/ops/ops-job-lock.service';
import { OpsJobRunService } from '../src/ops/ops-job-run.service';
import { futuresDecimal as d } from '../src/futures/futures-math';
import { readFuturesMark } from '../src/futures/futures-mark';
import { readFuturesLastPrice } from '../src/futures/futures-last-price';
import { HttpException } from '@nestjs/common';
import {
  adminDiagnosticRequestMiddleware,
  buildAdminDiagnostic,
} from '../src/common/admin-diagnostics';
import {
  db,
  fxEvidenceIds,
  app,
  now,
  fixture,
  newInstrument,
  price,
  fxEvidence,
  openBody,
  reject,
  state,
  invariant,
  cleanup,
  code,
  type Scenario,
} from './futures-integration';
if (
  process.env.NODE_ENV !== 'test' ||
  process.env.FUTURES_RISK_DB_INTEGRATION !== '1'
)
  throw new Error('F2 explicit test opt-in required');
process.env.FUTURES_TRADING_MODE = 'ENABLED';
process.env.FUTURES_RISK_ENGINE_ENABLED = 'true';
const liquidator = new FuturesLiquidationService(db);
let checks = 0;
const check = (label: string) => {
  checks++;
  console.log(`PASS F2 ${label}`);
};
async function mark(
  s: Scenario,
  index = 0,
  value = '100',
  age = 0,
  source:
    | 'binance_usdm_mark_ws'
    | 'binance_usdm_mark_rest' = 'binance_usdm_mark_ws',
) {
  await delay(2);
  const clock = await now();
  const t = new Date(clock.getTime() - age);
  const row = s.instruments[index];
  return db.futuresMarkSnapshot.create({
    data: {
      instrumentId: row.instrument.id,
      symbol: row.asset.symbol,
      source,
      price: value,
      effectiveAt: t,
      capturedAt: t,
    },
  });
}
async function refresh(s: Scenario, values?: string[]) {
  for (let i = 0; i < s.instruments.length; i++) {
    // Fresh transport evidence predates the command; future-time behavior has separate fixtures.
    await price(s, '100', i);
    await mark(s, i, values?.[i] ?? '100');
  }
}
async function setup(mode: TradingAccountMode, cash = '100', count = 4) {
  const s = await fixture(mode, cash);
  while (s.instruments.length < count)
    s.instruments.push(await newInstrument());
  await refresh(s);
  return s;
}
async function open(
  s: Scenario,
  index = 0,
  marginMode: 'isolated' | 'cross' = 'isolated',
  direction: 'long' | 'short' = 'long',
  leverage = 100,
  quantity = '1',
) {
  return app.futures.execute(
    s.userId,
    s.accountId,
    openBody(s, {
      instrumentId: s.instruments[index].instrument.id,
      marginMode,
      direction,
      leverage,
      quantity,
    }),
  );
}
async function command(
  s: Scenario,
  p: FuturesPosition,
  operation: 'reduce' | 'close' | 'increase',
  quantity?: string,
) {
  return app.futures.execute(s.userId, s.accountId, {
    instrumentId: p.instrumentId,
    positionId: p.id,
    operation,
    direction: p.direction,
    marginMode: p.marginMode,
    leverage: p.leverage,
    quantity: quantity ?? p.quantity.toFixed(8),
    idempotencyKey: randomUUID(),
  });
}
const positions = (s: Scenario) =>
  db.futuresPosition.findMany({
    where: { tradingAccountId: s.accountId, status: 'open' },
    orderBy: { instrumentId: 'asc' },
  });
const wallet = (s: Scenario) =>
  db.cashWallet.findUniqueOrThrow({ where: { id: s.futuresWalletId } });
const transfer = (s: Scenario, amount: string, incoming = false) =>
  app.transfer.transfer(s.userId, s.accountId, {
    sourceWalletId: incoming ? s.spotWalletId : s.futuresWalletId,
    destinationWalletId: incoming ? s.futuresWalletId : s.spotWalletId,
    amount,
    idempotencyKey: randomUUID(),
  });
async function clearMarks(s: Scenario) {
  await db.futuresMarkSnapshot.deleteMany({
    where: { instrumentId: { in: s.instruments.map((i) => i.instrument.id) } },
  });
}
async function gap(s: Scenario) {
  await refresh(s, ['100', '1', '400', '1']);
}
async function mixed(s: Scenario) {
  await open(s, 0, 'isolated', 'long', 10);
  await open(s, 1, 'cross', 'long');
  await open(s, 2, 'cross', 'short');
  await open(s, 3, 'cross', 'long');
}
async function assertEvent(s: Scenario, count: number, shortfall: boolean) {
  const event = await db.futuresLiquidation.findFirstOrThrow({
    where: { tradingAccountId: s.accountId },
    include: { closes: { include: { markSnapshot: true } } },
  });
  assert.equal(event.closes.length, count);
  assert.equal(event.bankruptcyShortfall.gt(0), shortfall);
  assert.ok(event.settledCash.eq(event.settledPnl.sub(event.settledFee)));
  assert.ok(
    event.bankruptcyShortfall.eq(
      event.settledCash.sub(event.realizedPnl).add(event.feeAmount),
    ),
  );
  const w = await wallet(s);
  assert.ok(w.balanceAmount.gte(0));
  assert.ok(w.balanceAmount.eq(event.walletBalanceAfter));
  const ledger = await db.walletTransaction.findMany({
    where: { referenceType: 'futures_liquidation', referenceId: event.id },
  });
  const cash = ledger.reduce(
    (n, r) => n.add(d(r.amount).mul(r.direction === 'credit' ? 1 : -1)),
    d('0'),
  );
  assert.ok(cash.eq(event.settledCash));
  assert.equal(ledger.filter((r) => r.txType === 'fee').length, 1);
  assert.ok(
    ledger.find((r) => r.txType === 'fee')!.amount.eq(event.settledFee),
  );
  for (const c of event.closes) {
    assert.ok(c.executionPrice.eq(c.markSnapshot.price));
    assert.equal(c.markSnapshot.instrumentId, c.instrumentId);
  }
  const history = await app.futures.liquidations(s.userId, s.accountId);
  const expected = JSON.parse(JSON.stringify(event)) as {
    closes: Array<{ positionId: string }>;
  };
  expected.closes.sort((a, b) => a.positionId.localeCompare(b.positionId));
  const persisted = (history.data.liquidations as Array<{ id: string }>).find(
    (row) => row.id === event.id,
  );
  // Technical redaction must never alter durable financial evidence/history.
  assert.deepEqual(persisted, expected);
  await invariant(s);
  return event;
}
async function isolatedCases(mode: TradingAccountMode) {
  for (const direction of ['long', 'short'] as const)
    for (const leverage of [1, 37, 100]) {
      const s = await setup(mode, '10000', 2);
      try {
        const o = await open(s, 0, 'isolated', direction, leverage);
        const p = await db.futuresPosition.findUniqueOrThrow({
          where: { id: o.data.position.id },
        });
        const read = await app.futures.positions(s.userId, s.accountId);
        assert.equal(read.data.positions[0].quantity, p.quantity.toFixed(8));
        assert.equal(
          read.data.positions[0].averageEntryPrice,
          p.averageEntryPrice.toFixed(8),
        );
        assert.equal(
          read.data.positions[0].isolatedMargin,
          p.isolatedMargin.toFixed(8),
        );
        assert.equal(read.data.positions[0].markPrice, '100.00000000');
        assert.equal(read.data.positions[0].risk?.markNotional, '100.00000000');
        assert.equal(read.data.positions[0].risk?.unrealizedPnl, '0.00000000');
        assert.equal(
          read.data.collateral.balanceAmount,
          (await wallet(s)).balanceAmount.toFixed(8),
        );
        assert.equal(
          read.data.positions[0].risk?.maintenanceMargin,
          '0.50000000',
        );
        assert.equal(
          read.data.positions[0].risk?.estimatedCloseFee,
          mode === 'general' ? '0.10000000' : '0.20000000',
        );
        assert.equal(
          (await liquidator.liquidate(s.accountId, p.id)).state,
          'healthy',
        );
        await mark(s, 0, direction === 'long' ? '0.01' : '250');
        const result = await liquidator.liquidate(s.accountId, p.id);
        if (direction === 'long' && leverage === 1) {
          assert.equal(result.state, 'healthy'); // Fully collateralized Long cannot go bankrupt at a positive price.
          assert.equal(read.data.positions[0].risk?.liquidationPrice, null);
        } else {
          assert.equal(result.state, 'liquidated');
          const event = await assertEvent(s, 1, true);
          assert.ok(event.collateralAvailable.eq(p.isolatedMargin));
          assert.ok(
            (await wallet(s)).balanceAmount.eq(
              d('10000').sub(o.data.execution.feeAmount).sub(p.isolatedMargin),
            ),
          );
          assert.equal(
            (await liquidator.liquidate(s.accountId, p.id)).state,
            'already_closed',
          );
        }
        check(
          `${mode}/${direction}/${leverage} isolated read, full close or unlevered protection`,
        );
      } finally {
        await cleanup(s);
      }
    }
  // Exact threshold fixtures use an already allocated lifetime, including maintenance boundary rounding.
  for (const delta of ['0.00000001', '0', '-0.00000001']) {
    const s = await setup(mode);
    try {
      const o = await open(s);
      const req = d(mode === 'general' ? '0.6' : '0.7');
      await db.futuresPosition.update({
        where: { id: o.data.position.id },
        data: { isolatedMargin: req.add(delta) },
      });
      const result = await liquidator.liquidate(
        s.accountId,
        o.data.position.id,
      );
      assert.equal(
        result.state,
        delta === '0.00000001' ? 'healthy' : 'liquidated',
      );
      if (result.state === 'liquidated') await assertEvent(s, 1, false);
      check(`${mode} exact isolated maintenance ${delta}`);
    } finally {
      await cleanup(s);
    }
  }
}
async function crossCases(mode: TradingAccountMode) {
  const s = await setup(mode);
  try {
    await mixed(s);
    const initial = await app.futures.positions(s.userId, s.accountId);
    const m = initial.data.cross.metrics!;
    assert.equal(
      m.crossBaseCollateral,
      mode === 'general' ? '89.60000000' : '89.20000000',
    );
    assert.equal(m.crossInitialMarginRequirement, '3.00000000');
    assert.equal(
      initial.data.positions.filter((p) => p.marginMode === 'cross').length,
      3,
    );
    assert.ok(
      initial.data.positions
        .filter((p) => p.marginMode === 'cross')
        .every((p) => p.risk?.liquidationPrice === null),
    );
    // Long -99 would exhaust this pool alone; Short +99 offsets it in Cross.
    await refresh(s, ['100', '1', '1', '100']);
    const offset = (await app.futures.positions(s.userId, s.accountId)).data
      .cross.metrics!;
    assert.equal(offset.crossUnrealizedPnl, '0.00000000');
    assert.equal(
      (await liquidator.liquidate(s.accountId, 'cross')).state,
      'healthy',
    );
    const iso = (await positions(s)).find((p) => p.marginMode === 'isolated')!;
    await gap(s);
    process.env.FUTURES_TRADING_MODE = 'DISABLED';
    const results = await Promise.all([
      liquidator.liquidate(s.accountId, 'cross'),
      new FuturesLiquidationService(db).liquidate(s.accountId, 'cross'),
    ]);
    assert.equal(results.filter((r) => r.state === 'liquidated').length, 1);
    assert.equal(results.filter((r) => r.state === 'already_closed').length, 1);
    const event = await assertEvent(s, 3, true);
    assert.equal((await positions(s)).length, 1);
    assert.deepEqual(
      await db.futuresPosition.findUnique({ where: { id: iso.id } }),
      iso,
    );
    assert.ok((await wallet(s)).balanceAmount.eq(iso.isolatedMargin));
    assert.equal(event.realizedPnl.toString(), '-498');
    const history = await app.futures.liquidations(s.userId, s.accountId, {
      limit: '1',
      offset: '0',
    });
    assert.equal(history.data.pagination.total, 1);
    const before = await state(s);
    await app.futures.liquidations(s.userId, s.accountId);
    await app.futures.positions(s.userId, s.accountId);
    assert.deepEqual(await state(s), before);
    await assert.rejects(app.futures.liquidations(randomUUID(), s.accountId));
    check(
      `${mode} atomic three-position Cross bankruptcy, mixed protection, disabled-mode risk, duplicate worker and history`,
    );
  } finally {
    process.env.FUTURES_TRADING_MODE = 'ENABLED';
    await cleanup(s);
  }
  const t = await setup(mode);
  try {
    await mixed(t);
    const others = (await positions(t)).filter((p) => p.marginMode === 'cross');
    const iso = (await positions(t)).find((p) => p.marginMode === 'isolated')!;
    await mark(t, 0, '1');
    process.env.FUTURES_TRADING_MODE = 'REDUCE_ONLY';
    assert.equal(
      (await liquidator.liquidate(t.accountId, iso.id)).state,
      'liquidated',
    );
    assert.deepEqual(
      (await positions(t)).filter((p) => p.marginMode === 'cross'),
      others,
    );
    await assertEvent(t, 1, true);
    check(`${mode} isolated bankruptcy preserves Cross pool in REDUCE_ONLY`);
  } finally {
    process.env.FUTURES_TRADING_MODE = 'ENABLED';
    await cleanup(t);
  }
}
async function transferCases(mode: TradingAccountMode) {
  for (const route of ['usd', 'fx'] as const) {
    const s = await setup(mode);
    try {
      await open(s, 0, 'cross', 'long', 10);
      const risk = (await app.futures.positions(s.userId, s.accountId)).data
        .cross.metrics!;
      const free = risk.crossFreeCollateral;
      const send = async (amount: string) => {
        if (route === 'usd') return transfer(s, amount);
        await fxEvidence();
        const q = await app.composite.quote(s.userId, s.accountId, {
          sourceWalletId: s.futuresWalletId,
          destinationWalletId: s.krwWalletId,
          amount,
        });
        return app.composite.execute(s.userId, s.accountId, {
          quoteId: q.data.quoteId,
          idempotencyKey: randomUUID(),
        });
      };
      const before = await wallet(s);
      await reject(
        send(d(free).add('0.00000001').toFixed(8)),
        'INSUFFICIENT_FUTURES_FREE_COLLATERAL',
      );
      assert.deepEqual(await wallet(s), before);
      await send(free);
      assert.equal((await wallet(s)).balanceAmount.toFixed(8), '10.00000000');
      await clearMarks(s);
      await mark(s, 0, '100', 6000);
      await reject(send('0.01'), 'FUTURES_MARK_STALE');
      await transfer(s, '1', true);
      assert.equal((await wallet(s)).balanceAmount.toFixed(8), '11.00000000');
      check(
        `${mode} ${route} outgoing exact free/over limit/stale; incoming allowed`,
      );
    } finally {
      await cleanup(s);
    }
  }
  const s = await setup(mode);
  try {
    await open(s, 0, 'cross', 'long', 10, '9');
    await reject(
      open(s, 1, 'isolated', 'long', 10),
      'INSUFFICIENT_FUTURES_FREE_COLLATERAL',
    );
    check(`${mode} Cross and new Isolated cannot double-spend collateral`);
  } finally {
    await cleanup(s);
  }
  const t = await setup(mode);
  try {
    await open(t, 0, 'cross');
    if (mode === 'general') process.env.GENERAL_TRADE_FEE_RATE = '0.02';
    else
      await db.season.update({
        where: { id: t.season!.id },
        data: { tradeFeeRate: '0.02' },
      });
    const free = (await app.futures.positions(t.userId, t.accountId)).data.cross
      .metrics!.crossFreeCollateral;
    await reject(transfer(t, free), 'INSUFFICIENT_FUTURES_FREE_COLLATERAL');
    check(
      `${mode} maintenance plus normal fee blocks a transfer even within initial free collateral`,
    );
  } finally {
    process.env.GENERAL_TRADE_FEE_RATE = '0.001000';
    await cleanup(t);
  }
}
async function modesAndStale(mode: TradingAccountMode) {
  const s = await setup(mode, '1000');
  try {
    const body = openBody(s, { marginMode: 'cross', quantity: '4' });
    const opened = await app.futures.execute(s.userId, s.accountId, body);
    const p = (await positions(s))[0];
    for (const modeName of ['REDUCE_ONLY', 'DISABLED']) {
      process.env.FUTURES_TRADING_MODE = modeName;
      assert.deepEqual(
        await app.futures.execute(s.userId, s.accountId, body),
        opened,
      );
      await reject(
        open(s, 1, 'cross'),
        modeName === 'DISABLED'
          ? 'FUTURES_TRADING_DISABLED'
          : 'FUTURES_REDUCE_ONLY',
      );
      await reject(
        command(s, p, 'increase', '1'),
        modeName === 'DISABLED'
          ? 'FUTURES_TRADING_DISABLED'
          : 'FUTURES_REDUCE_ONLY',
      );
      if (modeName === 'DISABLED') {
        await reject(command(s, p, 'reduce', '1'), 'FUTURES_TRADING_DISABLED');
        await reject(command(s, p, 'close'), 'FUTURES_TRADING_DISABLED');
      }
    }
    process.env.FUTURES_TRADING_MODE = 'ENABLED';
    await clearMarks(s);
    await mark(s, 0, '1', 6000);
    await reject(command(s, p, 'increase', '1'), 'FUTURES_MARK_STALE');
    await reject(open(s, 1, 'cross'), 'FUTURES_MARK_UNAVAILABLE');
    const before = await state(s);
    await reject(
      liquidator.liquidate(s.accountId, 'cross'),
      'FUTURES_MARK_STALE',
    );
    assert.deepEqual(await state(s), before);
    const read = await app.futures.positions(s.userId, s.accountId);
    assert.equal(read.data.cross.metrics, null);
    assert.equal(read.data.positions[0].markPrice, null);
    process.env.FUTURES_TRADING_MODE = 'REDUCE_ONLY';
    await command(s, p, 'reduce', '1');
    await command(s, (await positions(s))[0], 'close');
    assert.equal((await positions(s)).length, 0);
    check(
      `${mode} modes, committed replay, stale mark fail-closed and stale reduce/close allowed`,
    );
  } finally {
    process.env.FUTURES_TRADING_MODE = 'ENABLED';
    await cleanup(s);
  }
}
function faultDb(point: string, nth = 1) {
  return new Proxy(db, {
    get(target, key) {
      if (key === '$transaction')
        return async (
          work: (tx: Prisma.TransactionClient) => Promise<unknown>,
        ) =>
          target.$transaction(
            async (tx) => {
              let hits = 0;
              return work(
                new Proxy(tx, {
                  get(client, prop) {
                    const value = Reflect.get(client, prop);
                    if (prop === '$executeRaw')
                      return async (...args: unknown[]) => {
                        const result = await value.apply(client, args);
                        if (point === '$executeRaw' && ++hits === nth)
                          throw new Error(`injected:${point}`);
                        return result;
                      };
                    if (
                      [
                        'futuresLiquidation',
                        'futuresLiquidationClose',
                        'futuresPosition',
                        'cashWallet',
                        'walletTransaction',
                      ].includes(String(prop))
                    )
                      return new Proxy(value, {
                        get(delegate, method) {
                          const fn = Reflect.get(delegate, method);
                          if (typeof fn !== 'function') return fn;
                          return async (...args: unknown[]) => {
                            const result = await fn.apply(delegate, args);
                            if (
                              `${String(prop)}.${String(method)}` === point &&
                              ++hits === nth
                            )
                              throw new Error(`injected:${point}`);
                            return result;
                          };
                        },
                      });
                    return typeof value === 'function'
                      ? value.bind(client)
                      : value;
                  },
                }),
              );
            },
            { timeout: 15000 },
          );
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
async function rollbackCases(mode: TradingAccountMode) {
  for (const [point, nth] of [
    ['futuresLiquidation.create', 1],
    ['futuresPosition.update', 1],
    ['futuresPosition.update', 2],
    ['futuresPosition.update', 3],
    ['futuresLiquidationClose.create', 2],
    ['futuresLiquidationClose.create', 3],
    ['$executeRaw', 1],
    ['walletTransaction.createMany', 1],
  ] as const) {
    const s = await setup(mode);
    try {
      await mixed(s);
      await gap(s);
      const before = await state(s);
      await assert.rejects(
        new FuturesLiquidationService(faultDb(point, nth)).liquidate(
          s.accountId,
          'cross',
        ),
        new RegExp(`injected:${point.replace('$', '\\$')}`),
      );
      assert.deepEqual(await state(s), before);
      assert.equal((await positions(s)).length, 4);
      assert.equal(
        (await liquidator.liquidate(s.accountId, 'cross')).state,
        'liquidated',
      );
      await assertEvent(s, 3, true);
      check(`${mode} rollback ${point} #${nth} then successful retry`);
    } finally {
      await cleanup(s);
    }
  }
  // Non-bankrupt liquidation debits both economic loss and actual normal fee.
  const s = await setup(mode);
  try {
    const o = await open(s);
    await mark(s, 0, '99.5');
    const before = await state(s);
    await assert.rejects(
      new FuturesLiquidationService(faultDb('$executeRaw', 2)).liquidate(
        s.accountId,
        o.data.position.id,
      ),
      /injected/,
    );
    assert.deepEqual(await state(s), before);
    check(`${mode} rollback after fee cash debit`);
  } finally {
    await cleanup(s);
  }
}
async function waitBlocked(blocker: Client) {
  for (let i = 0; i < 150; i++) {
    // Activity snapshots otherwise stay cached inside the blocker transaction.
    await blocker.query('SELECT pg_stat_clear_snapshot()');
    const r = await blocker.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid <> pg_backend_pid()",
    );
    if (r.rows[0].n > 0) return;
    await delay(10);
  }
  throw new Error('Expected real PostgreSQL lock waiter');
}
async function raceCases(mode: TradingAccountMode) {
  for (const kind of [
    'close',
    'reduce',
    'increase',
    'transfer',
    'cross-open',
    'isolated-execution',
    'unrelated-cross',
  ] as const) {
    const s = await setup(mode, '100');
    const blocker = new Client({ connectionString: process.env.DATABASE_URL });
    await blocker.connect();
    try {
      await mixed(s);
      const p = (await positions(s)).find(
        (p) => p.instrumentId === s.instruments[1].instrument.id,
      )!;
      if (kind === 'unrelated-cross') await mark(s, 0, '1');
      else await gap(s);
      const scope =
        kind === 'unrelated-cross'
          ? (await positions(s)).find((p) => p.marginMode === 'isolated')!.id
          : 'cross';
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT id FROM cash_wallets WHERE id=$1 FOR UPDATE',
        [s.futuresWalletId],
      );
      const system = liquidator.liquidate(s.accountId, scope);
      await waitBlocked(blocker);
      let user: Promise<unknown>;
      if (kind === 'transfer') user = transfer(s, '1');
      else if (kind === 'isolated-execution')
        user = command(
          s,
          (await positions(s)).find((p) => p.marginMode === 'isolated')!,
          'close',
        );
      else if (kind === 'cross-open') user = open(s, 1, 'cross');
      else if (kind === 'unrelated-cross')
        user = command(s, p, 'reduce', '0.5');
      else user = command(s, p, kind, kind === 'reduce' ? '0.5' : undefined);
      // Attach rejection handling before releasing the financial fence.
      const outcome = Promise.allSettled([system, user]);
      await blocker.query('COMMIT');
      const results = await outcome;
      assert.equal(
        results[0].status,
        'fulfilled',
        JSON.stringify({ mode, kind, result: results[0] }),
      );
      if (results[0].status === 'fulfilled')
        assert.equal(
          (results[0].value as { state: string }).state,
          'liquidated',
        );
      if (
        ['close', 'reduce', 'increase', 'transfer', 'cross-open'].includes(kind)
      )
        assert.equal(results[1].status, 'rejected');
      else assert.equal(results[1].status, 'fulfilled');
      await invariant(s);
      assert.equal(
        await db.futuresLiquidation.count({
          where: { tradingAccountId: s.accountId },
        }),
        1,
      );
      assert.equal(
        await db.futuresLiquidationClose.count({
          where: { tradingAccountId: s.accountId },
        }),
        kind === 'unrelated-cross' ? 1 : 3,
      );
      check(
        `${mode} liquidation wins locked race vs ${kind}, no double settlement/deadlock`,
      );
    } finally {
      await blocker.query('ROLLBACK');
      await blocker.end();
      await cleanup(s);
    }
  }
  // Market recovers during the wallet lock wait: stale candidate must be discarded.
  const s = await setup(mode);
  const blocker = new Client({ connectionString: process.env.DATABASE_URL });
  await blocker.connect();
  try {
    await open(s);
    const p = (await positions(s))[0];
    await mark(s, 0, '1');
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM cash_wallets WHERE id=$1 FOR UPDATE', [
      s.futuresWalletId,
    ]);
    const task = liquidator.liquidate(s.accountId, p.id);
    await waitBlocked(blocker);
    await mark(s, 0, '100');
    await blocker.query('COMMIT');
    assert.equal((await task).state, 'healthy');
    assert.equal((await positions(s)).length, 1);
    check(
      `${mode} latest fresh Mark re-read after actual PostgreSQL lock wait`,
    );
  } finally {
    await blocker.query('ROLLBACK');
    await blocker.end();
    await cleanup(s);
  }
  // User close queued first wins the wallet fence. Liquidation observes closed lifetime.
  const t = await setup(mode);
  const b = new Client({ connectionString: process.env.DATABASE_URL });
  await b.connect();
  try {
    await open(t);
    const p = (await positions(t))[0];
    await mark(t, 0, '1');
    await b.query('BEGIN');
    await b.query('SELECT id FROM cash_wallets WHERE id=$1 FOR UPDATE', [
      t.futuresWalletId,
    ]);
    const user = command(t, p, 'close');
    await waitBlocked(b);
    const system = liquidator.liquidate(t.accountId, p.id);
    const results = Promise.all([user, system]);
    await b.query('COMMIT');
    const [, r] = await results;
    assert.equal(r.state, 'already_closed');
    assert.equal(
      await db.futuresLiquidation.count({
        where: { tradingAccountId: t.accountId },
      }),
      0,
    );
    assert.equal(
      await db.futuresExecution.count({
        where: { tradingAccountId: t.accountId, operation: 'close' },
      }),
      1,
    );
    await invariant(t);
    check(
      `${mode} user close wins PostgreSQL race with exactly one PnL/fee settlement`,
    );
  } finally {
    await b.query('ROLLBACK');
    await b.end();
    await cleanup(t);
  }
}
async function evidenceCases() {
  const s = await setup('general');
  try {
    await clearMarks(s);
    const ingest = new FuturesMarkIngestion(db),
      clock = await now();
    const r = s.instruments[0];
    const payload = {
      e: 'markPriceUpdate',
      s: r.asset.symbol,
      p: '101',
      E: clock.getTime(),
      st: 1,
    };
    assert.equal(
      await ingest.persist(
        payload,
        'binance_usdm_mark_ws',
        r.asset.symbol,
        r.instrument.id,
        clock,
      ),
      true,
    );
    assert.equal(
      await ingest.persist(
        { ...payload, p: '999' },
        'binance_usdm_mark_ws',
        r.asset.symbol,
        r.instrument.id,
        clock,
      ),
      false,
    );
    const newer = await mark(s, 0, '102');
    await ingest.persist(
      { ...payload, p: '1', E: clock.getTime() - 1000 },
      'binance_usdm_mark_ws',
      r.asset.symbol,
      r.instrument.id,
      clock,
    );
    await mark(s, 0, '200', 0, 'binance_usdm_mark_rest');
    const instrument = { ...r.instrument, underlyingAsset: r.asset };
    assert.equal(
      (await readFuturesMark(db, instrument, await now()))!.id,
      newer.id,
    );
    // Mark rows never become the execution price, and vice versa.
    const last = await readFuturesLastPrice(db, instrument, await now());
    assert.equal(last!.price.toString(), '100');
    await assert.rejects(
      db.futuresMarkSnapshot.update({
        where: { id: newer.id },
        data: { price: '999' },
      }),
    );
    for (const patch of [
      { symbol: 'WRONGUSDT' },
      { currencyCode: 'KRW' },
      { providerProduct: 'spot' },
      { instrumentId: s.instruments[1].instrument.id },
      { symbol: 'BTCUSD_PERP' },
    ]) {
      await assert.rejects(
        db.futuresMarkSnapshot.create({
          data: {
            instrumentId: r.instrument.id,
            symbol: r.asset.symbol,
            source: 'binance_usdm_mark_ws',
            price: '10',
            effectiveAt: new Date(clock.getTime() - 2000),
            capturedAt: clock,
            ...patch,
          } as any,
        }),
      );
    }
    await mark(s, 0, '100');
    const opened = await open(s, 0, 'cross');
    await reject(
      app.futures.execute(s.userId, s.accountId, {
        ...openBody(s),
        operation: 'increase',
        positionId: opened.data.position.id,
        marginMode: 'isolated',
        leverage: 100,
      }),
      'FUTURES_MARGIN_MODE_MISMATCH',
    );
    await assert.rejects(
      db.futuresPosition.update({
        where: { id: opened.data.position.id },
        data: { marginMode: 'isolated' },
      }),
    );
    await assert.rejects(
      db.futuresPosition.update({
        where: { id: opened.data.position.id },
        data: { isolatedMargin: '1' },
      }),
    );
    check(
      'DB typed immutable Mark, duplicate/out-of-order/WS priority, Spot selector isolation and lifetime margin mode',
    );
  } finally {
    await cleanup(s);
  }
}
async function workerCases() {
  const s = await setup('general');
  const make = () =>
    new FuturesRiskWorker(
      db,
      new OpsJobLockService(db),
      new OpsJobRunService(db),
      new FuturesLiquidationService(db),
    );
  try {
    await open(s);
    await clearMarks(s);
    await mark(s, 0, '1', 6000);
    const before = await state(s);
    await make().tick();
    assert.deepEqual(await state(s), before);
    const run = await db.opsJobRun.findFirstOrThrow({
      where: { jobName: 'futures_liquidation' },
      orderBy: { startedAt: 'desc' },
    });
    assert.ok(JSON.stringify(run.resultJson).includes('FUTURES_MARK_STALE'));
    process.env.FUTURES_TRADING_MODE = 'DISABLED';
    await mark(s, 0, '1');
    await Promise.all([make().tick(), make().tick()]);
    assert.equal(
      await db.futuresLiquidation.count({
        where: { tradingAccountId: s.accountId },
      }),
      1,
    );
    await make().tick();
    assert.equal(
      await db.futuresLiquidation.count({
        where: { tradingAccountId: s.accountId },
      }),
      1,
    );
    check(
      'worker stale durable diagnosis, OpsJobLock overlap, disabled user mode and restart idempotency',
    );
  } finally {
    process.env.FUTURES_TRADING_MODE = 'ENABLED';
    await cleanup(s);
  }
}
async function workerCursorCases() {
  const fixtures: Scenario[] = [];
  const visits: string[] = [];
  const scanner = new FuturesLiquidationService(db);
  const scan = scanner.candidateScopes.bind(scanner);
  scanner.candidateScopes = async (id) => {
    visits.push(id);
    return scan(id);
  };
  const worker = new FuturesRiskWorker(
    db,
    new OpsJobLockService(db),
    new OpsJobRunService(db),
    scanner,
  );
  async function add() {
    const s = await fixture('general');
    fixtures.push(s);
    await db.futuresPosition.create({
      data: {
        tradingAccountId: s.accountId,
        instrumentId: s.instruments[0].instrument.id,
        direction: 'long',
        quantity: '1',
        averageEntryPrice: '100',
        entryNotional: '100',
        leverage: 100,
        isolatedMargin: '1',
      },
    });
    return s;
  }
  async function marks() {
    const at = await now();
    await db.futuresMarkSnapshot.createMany({
      data: fixtures.map((s) => ({
        instrumentId: s.instruments[0].instrument.id,
        symbol: s.instruments[0].asset.symbol,
        source: 'binance_usdm_mark_ws' as const,
        price: '100',
        effectiveAt: at,
        capturedAt: at,
      })),
      skipDuplicates: true,
    });
  }
  try {
    const size = futuresRiskConfig().batchSize;
    for (let i = 0; i < size + 2; i++) await add();
    const sorted = fixtures.map((s) => s.accountId).sort();
    await marks();
    await worker.tick();
    assert.deepEqual(visits.slice().sort(), sorted.slice(0, size));
    const cursor = sorted[size - 1];
    const removed = fixtures.find((s) => s.accountId === sorted.at(-1))!;
    await cleanup(removed);
    fixtures.splice(fixtures.indexOf(removed), 1);
    const closed = fixtures.find((s) => s.accountId === sorted.at(-2))!;
    await db.futuresPosition.updateMany({
      where: { tradingAccountId: closed.accountId },
      data: {
        status: 'closed',
        quantity: '0',
        entryNotional: '0',
        isolatedMargin: '0',
        closedAt: await now(),
      },
    });
    await add();
    const current = fixtures
      .filter((s) => s !== closed)
      .map((s) => s.accountId)
      .sort();
    visits.length = 0;
    await marks();
    await worker.tick();
    assert.deepEqual(
      visits.slice().sort(),
      current.filter((id) => id > cursor),
    );
    visits.length = 0;
    await marks();
    await worker.tick();
    assert.deepEqual(visits.slice().sort(), current.slice(0, size));
    visits.length = 0;
    await marks();
    await worker.tick();
    assert.deepEqual(visits.slice().sort(), current.slice(size));
    visits.length = 0;
    const restarted = new FuturesRiskWorker(
      db,
      new OpsJobLockService(db),
      new OpsJobRunService(db),
      scanner,
    );
    await marks();
    await restarted.tick();
    assert.deepEqual(visits.slice().sort(), current.slice(0, size));
    assert.equal(
      await db.futuresLiquidation.count({
        where: { tradingAccountId: { in: fixtures.map((s) => s.accountId) } },
      }),
      0,
    );
    check(
      'worker actual PostgreSQL multiple batches, lookahead/reset, added/removed/closed accounts and restart without starvation',
    );
  } finally {
    for (const s of fixtures) await cleanup(s);
  }
}

async function candidateCases() {
  const s = await setup('general');
  try {
    const o = await open(s);
    assert.deepEqual(await liquidator.candidateScopes(s.accountId), [
      { scope: o.data.position.id, candidate: false },
    ]);
    await mark(s, 0, '1');
    assert.deepEqual(await liquidator.candidateScopes(s.accountId), [
      { scope: o.data.position.id, candidate: true },
    ]);
    await mark(s, 0, '100');
    assert.equal(
      (await liquidator.liquidate(s.accountId, o.data.position.id)).state,
      'healthy',
    );
    await clearMarks(s);
    await mark(s, 0, '1', 6000);
    assert.deepEqual(await liquidator.candidateScopes(s.accountId), [
      { scope: o.data.position.id, candidate: true },
    ]);
    await reject(
      liquidator.liquidate(s.accountId, o.data.position.id),
      'FUTURES_MARK_STALE',
    );
    await mark(s, 0, '100');
    await db.cashWallet.update({
      where: { id: s.futuresWalletId },
      data: { balanceAmount: '0.1' },
    });
    assert.deepEqual(await liquidator.candidateScopes(s.accountId), [
      { scope: o.data.position.id, candidate: true },
    ]);
    await reject(
      liquidator.liquidate(s.accountId, o.data.position.id),
      'FUTURES_COLLATERAL_INTEGRITY',
    );
    check(
      'readonly hints never authorize liquidation: recovery/stale/underfunded evidence rechecked by the original transaction',
    );
  } finally {
    await cleanup(s);
  }
}

async function workerLockedAccountCase() {
  const a = await setup('general'),
    b = await setup('general');
  const [slow, fast] = [a, b].sort((x, y) =>
    x.accountId.localeCompare(y.accountId),
  );
  const blocker = new Client({ connectionString: process.env.DATABASE_URL });
  const worker = new FuturesRiskWorker(
    db,
    new OpsJobLockService(db),
    new OpsJobRunService(db),
    new FuturesLiquidationService(db),
  );
  let pending: Promise<void> | undefined;
  let forcedRelease = false;
  let escape: NodeJS.Timeout | undefined;
  await blocker.connect();
  try {
    await open(slow);
    await open(fast);
    await mark(slow, 0, '1');
    await mark(fast, 0, '1');
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM cash_wallets WHERE id=$1 FOR UPDATE', [
      slow.futuresWalletId,
    ]);
    // Escape only prevents a broken timeout from hanging the test/cleanup forever.
    // Passing requires the original transaction bound to finish with the lock held.
    escape = setTimeout(() => {
      forcedRelease = true;
      void blocker.query('ROLLBACK');
    }, 25000);
    pending = worker.tick();
    await waitBlocked(blocker);
    const deadline = performance.now() + 5000;
    while ((await positions(fast)).length && performance.now() < deadline)
      await delay(10);
    assert.equal(
      (await positions(fast)).length,
      0,
      'another account lane must progress while the first wallet is locked',
    );
    await pending;
    assert.equal(
      forcedRelease,
      false,
      'a locked account outlived the financial transaction bound',
    );
    assert.equal((await positions(slow)).length, 1);
    const run = await db.opsJobRun.findFirstOrThrow({
      where: { jobName: 'futures_liquidation' },
      orderBy: { startedAt: 'desc' },
    });
    assert.ok(
      JSON.stringify(run.resultJson).includes(
        'FUTURES_RISK_TRANSACTION_FAILED',
      ),
    );
    clearTimeout(escape);
    await blocker.query('ROLLBACK');
    await mark(slow, 0, '1');
    await worker.tick();
    assert.equal(
      (await positions(slow)).length,
      0,
      'timed-out account must be revisited after the lock is released',
    );
    await invariant(slow);
    await invariant(fast);
    check(
      'worker real PostgreSQL slow wallet: other lane progresses, transaction expires and next sweep revisits',
    );
  } finally {
    clearTimeout(escape);
    await blocker.query('ROLLBACK');
    await pending?.catch(() => undefined);
    await blocker.end();
    await cleanup(a);
    await cleanup(b);
  }
}

async function lifecycleCases() {
  for (const boundary of [
    'ended',
    'settled',
    'closed',
    'excluded',
    'suspended',
  ] as const) {
    const s = await setup('season');
    try {
      const o = await open(s);
      await mark(s, 0, '1');
      if (boundary === 'ended')
        await db.season.update({
          where: { id: s.season!.id },
          data: { endAt: new Date((await now()).getTime() - 1) },
        });
      if (boundary === 'settled')
        await db.season.update({
          where: { id: s.season!.id },
          data: { status: 'settled' },
        });
      if (boundary === 'closed' || boundary === 'suspended')
        await db.tradingAccount.update({
          where: { id: s.accountId },
          data: { status: boundary },
        });
      if (boundary === 'excluded')
        await db.seasonParticipant.updateMany({
          where: { tradingAccountId: s.accountId },
          data: { participantStatus: 'excluded' },
        });
      const before = await state(s);
      const result = await liquidator.liquidate(
        s.accountId,
        o.data.position.id,
      );
      assert.equal(
        result.state,
        ['excluded', 'suspended'].includes(boundary)
          ? 'liquidated'
          : 'lifecycle_blocked',
      );
      if (result.state === 'lifecycle_blocked')
        assert.deepEqual(await state(s), before);
      check(`Season ${boundary} forced risk reduction boundary`);
    } finally {
      await cleanup(s);
    }
  }
}
async function reservedAndScopeProtection() {
  const s = await setup('general');
  try {
    await mixed(s);
    await db.cashWallet.update({
      where: { id: s.futuresWalletId },
      data: { reservedAmount: '5' },
    });
    const iso = (await positions(s)).find((p) => p.marginMode === 'isolated')!;
    // An explicit user Isolated close cannot spend Cross cash even with stale marks.
    await price(s, '1', 0, 0);
    await clearMarks(s);
    await reject(command(s, iso, 'close'), 'FUTURES_LIQUIDATION_REQUIRED');
    await gap(s);
    assert.equal(
      (await liquidator.liquidate(s.accountId, 'cross')).state,
      'liquidated',
    );
    const w = await wallet(s);
    assert.equal(w.balanceAmount.toString(), '15');
    assert.equal(w.reservedAmount.toString(), '5');
    assert.deepEqual(
      await db.futuresPosition.findUnique({ where: { id: iso.id } }),
      iso,
    );
    const e = await db.futuresLiquidation.findFirstOrThrow({
      where: { tradingAccountId: s.accountId },
    });
    assert.equal(e.collateralAvailable.toFixed(8), '84.60000000');
    check(
      'reserved cash plus isolated allocation both survive Cross bankruptcy; manual isolated close cannot raid Cross',
    );
  } finally {
    await cleanup(s);
  }
}

async function quantumAndCreditRollback() {
  const s = await setup('general');
  try {
    const o = await open(s, 0, 'isolated', 'long', 50, '0.00000001');
    await mark(s, 0, '0.00000001');
    assert.equal(
      (await liquidator.liquidate(s.accountId, o.data.position.id)).state,
      'liquidated',
    );
    const e = await assertEvent(s, 1, true);
    assert.equal(e.realizedPnl.toFixed(8), '-0.00000100');
    assert.equal(e.feeAmount.toFixed(8), '0.00000000');
    check(
      'gap liquidation closes quantity even when Mark notional rounds to zero',
    );
  } finally {
    await cleanup(s);
  }
  const t = await setup('general');
  try {
    await open(t, 0, 'cross');
    await mark(t, 0, '110');
    process.env.GENERAL_TRADE_FEE_RATE = '1';
    const before = await state(t);
    await assert.rejects(
      new FuturesLiquidationService(faultDb('cashWallet.updateMany')).liquidate(
        t.accountId,
        'cross',
      ),
      /injected/,
    );
    assert.deepEqual(await state(t), before);
    assert.equal(
      (await liquidator.liquidate(t.accountId, 'cross')).state,
      'liquidated',
    );
    await assertEvent(t, 1, true);
    check(
      'rollback after positive PnL credit and current-fee-policy liquidation',
    );
  } finally {
    process.env.GENERAL_TRADE_FEE_RATE = '0.001000';
    await cleanup(t);
  }
}

async function diagnosticSafety() {
  const capture = async (
    s: Scenario,
    action: () => Promise<unknown>,
    expectedCode: string,
  ) => {
    let pending!: Promise<ReturnType<typeof buildAdminDiagnostic>>;
    adminDiagnosticRequestMiddleware(
      {
        method: 'POST',
        originalUrl: `/api/v1/trading-accounts/${s.accountId}/futures/execute`,
        headers: { 'x-request-id': 'futures-db-p0' },
        user: { userId: s.userId, role: 'admin' },
      } as never,
      { setHeader() {} } as never,
      () => {
        pending = action().then(
          () => {
            throw new Error('Expected guard rejection');
          },
          (error: unknown) => {
            assert.ok(error instanceof HttpException);
            assert.equal(code(error), expectedCode);
            const diagnostic = buildAdminDiagnostic(
              error,
              expectedCode,
              error.getStatus(),
            );
            assert.ok(diagnostic);
            assert.equal(diagnostic.domain, 'futures');
            assert.equal(diagnostic.operation, 'market_execute');
            assert.equal(diagnostic.requestId, 'futures-db-p0');
            assert.equal(
              diagnostic.exception.message,
              (error.getResponse() as { error: { message: string } }).error
                .message,
            );
            assert.ok(
              diagnostic.nextInvestigation?.includes(
                'backend/src/futures/futures.service.ts',
              ),
            );
            const serialized = JSON.stringify(diagnostic);
            assert.ok(Buffer.byteLength(serialized) <= 24 * 1024);
            assert.doesNotMatch(
              serialized,
              /987654\.12345678|"(?:balance|reserved|marginUsed|marginAfter|feeAmount|realizedPnl|freeAfter|quantity|price|balanceAmount|reservedAmount)":/,
            );
            return diagnostic;
          },
        );
      },
    );
    return (await pending)!;
  };
  const s = await setup('general', '987654.12345678');
  try {
    const before = await state(s);
    const insufficient = await capture(
      s,
      () =>
        app.futures.execute(
          s.userId,
          s.accountId,
          openBody(s, { quantity: '99999', leverage: 10 }),
        ),
      'INSUFFICIENT_FUTURES_FREE_COLLATERAL',
    );
    assert.equal(
      (insufficient.evidence?.financialGuard as Record<string, unknown>)
        .failureReason,
      'isolated_allocation_underfunded',
    );
    assert.deepEqual(await state(s), before);
    await mark(s, 0, '0.12345678');
    const maintenance = await capture(
      s,
      () => app.futures.execute(s.userId, s.accountId, openBody(s)),
      'FUTURES_MAINTENANCE_UNSAFE',
    );
    assert.equal(
      (maintenance.evidence?.financialGuard as Record<string, unknown>)
        .maintenanceSufficient,
      false,
    );
    check(
      'admin financial guards retain scope/predicates without exact amounts; failures roll back',
    );
  } finally {
    await cleanup(s);
  }
  const t = await setup('season');
  try {
    await db.cashWallet.delete({ where: { id: t.spotWalletId } });
    const integrity = await capture(
      t,
      () => app.futures.execute(t.userId, t.accountId, openBody(t)),
      'FINANCIAL_SCOPE_REPAIR_REQUIRED',
    );
    assert.equal(
      (integrity.evidence?.financialGuard as Record<string, unknown>)
        .canonicalWalletSetValid,
      false,
    );
    check('admin wallet integrity evidence excludes canonical financial rows');
  } finally {
    await cleanup(t);
  }
}

async function main() {
  await db.$connect();
  await diagnosticSafety();
  await evidenceCases();
  await quantumAndCreditRollback();
  await reservedAndScopeProtection();
  for (const mode of ['general', 'season'] as const) {
    await isolatedCases(mode);
    await crossCases(mode);
    await transferCases(mode);
    await modesAndStale(mode);
    await rollbackCases(mode);
    await raceCases(mode);
  }
  await lifecycleCases();
  await workerCases();
  await candidateCases();
  await workerCursorCases();
  await workerLockedAccountCase();
  console.log(
    `futures F2 db integration ok (${checks} consolidated financial/evidence/race/rollback checks)`,
  );
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.fxRateSnapshot.deleteMany({
      where: { id: { in: fxEvidenceIds } },
    });
    await db.$disconnect();
  });
