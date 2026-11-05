import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Prisma, type FuturesDirection } from '../src/generated/prisma/client';
import {
  db,
  app,
  fixture,
  now,
  price,
  fxEvidence,
  fxEvidenceIds,
  cleanup,
  code,
  type Scenario,
} from './futures-integration';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import { FuturesLimitService } from '../src/futures/futures-limit.service';
import { FuturesConditionalEntryService } from '../src/futures/futures-conditional-entry.service';
import { FuturesTpSlService } from '../src/futures/futures-tp-sl.service';
import { FuturesLeverageService } from '../src/futures/futures-leverage.service';
import { FuturesLiquidationService } from '../src/futures/futures-liquidation.service';
import { FuturesSeasonSettlementService } from '../src/futures/futures-season-settlement.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { assertFuturesTransferCollateral } from '../src/futures/futures-collateral';

/**
 * Two-way Futures positions and approved leverage changes (2026-11-06) on a
 * disposable PostgreSQL: one open lifetime per account/instrument/direction,
 * same-direction merges for every order method, the opposite direction kept
 * apart, leverage changes alone or with an add (immediately or at a pending
 * entry's fill, only as approved), and the per-lifetime TP/SL, liquidation,
 * Season final exit and valuation paths with a long and a short at once.
 */
if (
  process.env.NODE_ENV !== 'test' ||
  process.env.FUTURES_TWO_WAY_DB_INTEGRATION !== '1'
)
  throw new Error('Explicit disposable Futures two-way PG opt-in required');
process.env.FUTURES_TRADING_MODE = 'ENABLED';
process.env.FUTURES_RISK_ENGINE_ENABLED = 'true';
process.env.FUTURES_TP_SL_ORDERS_ENABLED = 'true';
process.env.FUTURES_CONDITIONAL_ENTRY_ENABLED = 'true';
process.env.INDEPENDENT_TP_SL_ORDERS_ENABLED = 'true';
process.env.LEGACY_OCO_REGISTRATION_ENABLED = 'false';

const D = (value: string | number | Prisma.Decimal) =>
  new Prisma.Decimal(value);
const access = new TradingAccountAccessService(db);
const limits = new FuturesLimitService(db, access, app.futures);
const watches = new FuturesConditionalEntryService(
  db,
  access,
  app.futures,
  limits,
);
const tpSl = new FuturesTpSlService(db, access, app.futures);
const leverage = new FuturesLeverageService(db, access, app.futures);
const liquidator = new FuturesLiquidationService(db);
const final = new FuturesSeasonSettlementService(db);
const valuation = new PortfolioValuationService(db);
let checks = 0;
const pass = (label: string) => {
  checks++;
  console.log(`PASS two-way ${label}`);
};

async function mark(s: Scenario, value: string, index = 0) {
  const at = await now();
  await db.futuresMarkSnapshot.createMany({
    data: [
      {
        instrumentId: s.instruments[index].instrument.id,
        symbol: s.instruments[index].asset.symbol,
        source: 'binance_usdm_mark_ws',
        price: value,
        effectiveAt: at,
        capturedAt: at,
      },
    ],
    skipDuplicates: true,
  });
}
/** Fresh Futures Last and Mark at `value` (one millisecond older Last). */
async function fresh(s: Scenario, value = '100', index = 0) {
  await fxEvidence();
  await price(s, value, index, 0);
  await mark(s, value, index);
}
const instrumentId = (s: Scenario, index = 0) =>
  s.instruments[index].instrument.id;
function exec(s: Scenario, body: Record<string, unknown>) {
  return app.futures.execute(s.userId, s.accountId, {
    instrumentId: instrumentId(s),
    quantity: '1',
    idempotencyKey: randomUUID(),
    ...body,
  });
}
function openCmd(
  s: Scenario,
  direction: FuturesDirection,
  lev: number,
  patch: Record<string, unknown> = {},
) {
  return exec(s, {
    operation: 'open',
    direction,
    leverage: lev,
    marginMode: 'isolated',
    ...patch,
  });
}
async function lifetime(s: Scenario, direction: FuturesDirection, index = 0) {
  return db.futuresPosition.findFirst({
    where: {
      tradingAccountId: s.accountId,
      instrumentId: instrumentId(s, index),
      direction,
      status: 'open',
    },
  });
}
async function onPosition(
  s: Scenario,
  direction: FuturesDirection,
  operation: 'increase' | 'reduce' | 'close',
  patch: Record<string, unknown> = {},
) {
  const p = (await lifetime(s, direction))!;
  return exec(s, {
    operation,
    positionId: p.id,
    direction,
    leverage: p.leverage,
    marginMode: p.marginMode,
    quantity: operation === 'close' ? p.quantity.toFixed(8) : '1',
    ...patch,
  });
}
async function reject(work: Promise<unknown>, expected: string) {
  await assert.rejects(work, (error: unknown) => {
    assert.equal(code(error), expected);
    return true;
  });
  checks++;
}
const wallet = (s: Scenario) =>
  db.cashWallet.findUniqueOrThrow({ where: { id: s.futuresWalletId } });
/** Test-only cash edit that leaves the row's updated_at as it was. */
const setCash = (s: Scenario, amount: string | Prisma.Decimal) =>
  db.$executeRaw`UPDATE cash_wallets SET balance_amount = ${amount.toString()}::numeric WHERE id = ${s.futuresWalletId}`;
/** Every financial row of the account, in a fixed order. */
async function snapshot(s: Scenario) {
  const where = { tradingAccountId: s.accountId };
  const orderBy = { id: 'asc' } as const;
  // transaction_id is a BIGINT.
  const json = (_: string, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value;
  return JSON.stringify(
    {
      wallets: await db.cashWallet.findMany({ where, orderBy }),
      positions: await db.futuresPosition.findMany({ where, orderBy }),
      executions: await db.futuresExecution.findMany({ where, orderBy }),
      commands: await db.futuresExecuteRequest.findMany({ where, orderBy }),
      changes: await db.futuresLeverageChange.findMany({ where, orderBy }),
      limits: await db.futuresLimitOrder.findMany({ where, orderBy }),
      watches: await db.futuresConditionalEntry.findMany({ where, orderBy }),
      settings: await db.futuresTpSlSetting.findMany({ where, orderBy }),
      ledger: await db.walletTransaction.findMany({ where, orderBy }),
    },
    json,
  );
}
/** Cash = start + realized PnL − fees; no reservation left; allocations funded. */
async function invariant(s: Scenario, start = '10000') {
  const w = await wallet(s);
  const executions = await db.futuresExecution.findMany({
    where: { tradingAccountId: s.accountId },
  });
  const liquidations = await db.futuresLiquidation.findMany({
    where: { tradingAccountId: s.accountId },
  });
  const settlements = await db.futuresSeasonSettlement.findMany({
    where: { tradingAccountId: s.accountId },
  });
  const expected = executions
    .reduce((sum, e) => sum.add(e.realizedPnl).sub(e.feeAmount), D(start))
    .add(liquidations.reduce((sum, l) => sum.add(l.settledCash), D(0)))
    .add(settlements.reduce((sum, e) => sum.add(e.settledCash), D(0)));
  assert.equal(w.balanceAmount.toFixed(8), expected.toFixed(8));
  const open = await db.futuresPosition.findMany({
    where: { tradingAccountId: s.accountId, status: 'open' },
  });
  assert.equal(
    new Set(open.map((p) => `${p.instrumentId}:${p.direction}`)).size,
    open.length,
  );
  const allocated = open.reduce((sum, p) => sum.add(p.isolatedMargin), D(0));
  assert.ok(w.balanceAmount.sub(w.reservedAmount).gte(allocated));
  const pending = await db.futuresLimitOrder.findMany({
    where: { tradingAccountId: s.accountId, status: 'submitted' },
  });
  assert.equal(
    w.reservedAmount.toFixed(8),
    pending.reduce((sum, o) => sum.add(o.reservedAmount), D(0)).toFixed(8),
  );
}
async function clean(s: Scenario) {
  const where = { tradingAccountId: s.accountId };
  await db.entryTpSlPlan.deleteMany({ where });
  await db.futuresTpSlSetting.deleteMany({ where });
  await db.futuresConditionalEntry.deleteMany({ where });
  await db.pendingOrderModification.deleteMany({ where });
  await db.futuresSeasonClose.deleteMany({ where });
  await db.futuresSeasonSettlement.deleteMany({ where });
  await db.dailyPortfolioSnapshot.deleteMany({ where });
  await db.seasonRanking.deleteMany({ where });
  if (s.season)
    await db.futuresSeasonPrice.deleteMany({
      where: { seasonId: s.season.id },
    });
  await cleanup(s);
}

/** 1–11: open, add, hedge, reduce and close per direction; the other stays. */
async function positions(
  mode: 'general' | 'season',
  marginMode: 'isolated' | 'cross',
) {
  const s = await fixture(mode);
  try {
    await fresh(s);
    const long = await openCmd(s, 'long', 10, { marginMode });
    assert.equal(long.data.position.direction, 'long');
    assert.equal(long.data.execution.operation, 'open');
    assert.equal(
      long.data.position.isolatedMargin,
      marginMode === 'cross' ? '0.00000000' : '10.00000000',
    );
    await reject(
      openCmd(s, 'long', 10, { marginMode }),
      'FUTURES_POSITION_ALREADY_OPEN',
    );
    const longRow = await db.futuresPosition.findUniqueOrThrow({
      where: { id: long.data.position.id },
    });
    const short = await openCmd(s, 'short', 20, { marginMode });
    assert.notEqual(short.data.position.id, long.data.position.id);
    assert.equal(short.data.position.leverage, 20);
    assert.deepEqual(
      await db.futuresPosition.findUniqueOrThrow({ where: { id: longRow.id } }),
      longRow,
    );
    pass(`${mode}/${marginMode} a short opens beside the long, untouched`);

    await fresh(s, '104');
    const shortRow = (await lifetime(s, 'short'))!;
    const added = await onPosition(s, 'long', 'increase');
    assert.equal(added.data.position.id, long.data.position.id);
    assert.equal(added.data.position.quantity, '2.00000000');
    assert.equal(added.data.position.averageEntryPrice, '102.00000000');
    assert.equal(added.data.execution.operation, 'increase');
    assert.deepEqual(
      await db.futuresPosition.findUniqueOrThrow({
        where: { id: shortRow.id },
      }),
      shortRow,
    );
    const longAfterAdd = (await lifetime(s, 'long'))!;
    const shortAdded = await onPosition(s, 'short', 'increase');
    assert.equal(shortAdded.data.position.id, short.data.position.id);
    assert.equal(shortAdded.data.position.quantity, '2.00000000');
    assert.equal(shortAdded.data.position.averageEntryPrice, '102.00000000');
    assert.deepEqual(
      await db.futuresPosition.findUniqueOrThrow({
        where: { id: longAfterAdd.id },
      }),
      longAfterAdd,
    );
    pass(`${mode}/${marginMode} each add merges into its own direction only`);

    const shortBefore = (await lifetime(s, 'short'))!;
    const reduced = await onPosition(s, 'long', 'reduce', {
      quantity: '0.5',
    });
    assert.equal(reduced.data.position.quantity, '1.50000000');
    assert.equal(reduced.data.execution.realizedPnl, '1.00000000');
    const closed = await onPosition(s, 'long', 'close');
    assert.equal(closed.data.position.status, 'closed');
    assert.equal(closed.data.execution.operation, 'close');
    assert.deepEqual(
      await db.futuresPosition.findUniqueOrThrow({
        where: { id: shortBefore.id },
      }),
      shortBefore,
    );
    pass(
      `${mode}/${marginMode} a partial and a full close of the long leave the short`,
    );

    await reject(
      exec(s, {
        operation: 'reduce',
        positionId: short.data.position.id,
        direction: 'long',
        leverage: 20,
        marginMode,
        quantity: '0.1',
      }),
      'FUTURES_ONE_WAY_VIOLATION',
    );
    await reject(
      exec(s, {
        operation: 'reduce',
        positionId: long.data.position.id,
        direction: 'long',
        leverage: 10,
        marginMode,
        quantity: '0.1',
      }),
      'FUTURES_POSITION_NOT_FOUND',
    );
    await fresh(s, '104', 1);
    await reject(
      exec(s, {
        instrumentId: instrumentId(s, 1),
        operation: 'reduce',
        positionId: short.data.position.id,
        direction: 'short',
        leverage: 20,
        marginMode,
        quantity: '0.1',
      }),
      'FUTURES_POSITION_NOT_FOUND',
    );
    pass(`${mode}/${marginMode} a wrong direction or lifetime is refused`);

    const read = await app.futures.positions(s.userId, s.accountId);
    assert.deepEqual(
      read.data.positions.map((p) => [p.direction, p.quantity]),
      [['short', '2.00000000']],
    );
    await fresh(s, '104');
    await openCmd(s, 'long', 10, { marginMode });
    const both = await app.futures.positions(s.userId, s.accountId);
    assert.deepEqual(both.data.positions.map((p) => p.direction).sort(), [
      'long',
      'short',
    ]);
    if (marginMode === 'cross') {
      assert.equal(both.data.cross.positionIds.length, 2);
      // Requirements are summed per lifetime, never netted.
      const sum = both.data.positions.reduce(
        (total, p) => total.add(p.risk!.initialRequirement),
        D(0),
      );
      assert.equal(
        both.data.cross.metrics!.crossInitialMarginRequirement,
        sum.toFixed(8),
      );
    }
    await invariant(s);
    pass(`${mode}/${marginMode} reads list both lifetimes; cash reconciles`);
  } finally {
    await clean(s);
  }
}

/** 11: concurrent same-direction opens never make a second lifetime. */
async function races() {
  const s = await fixture('general');
  try {
    await fresh(s);
    const results = await Promise.allSettled([
      openCmd(s, 'long', 10),
      openCmd(s, 'long', 10),
      openCmd(s, 'short', 10),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
    assert.equal(results[2].status, 'fulfilled');
    const refused = results.find((r) => r.status === 'rejected');
    assert.equal(
      code((refused as PromiseRejectedResult).reason),
      'FUTURES_POSITION_ALREADY_OPEN',
    );
    const open = await db.futuresPosition.findMany({
      where: { tradingAccountId: s.accountId, status: 'open' },
    });
    assert.deepEqual(open.map((p) => p.direction).sort(), ['long', 'short']);
    assert.equal(
      await db.futuresExecution.count({
        where: { tradingAccountId: s.accountId },
      }),
      2,
    );
    await assert.rejects(
      db.$executeRaw`INSERT INTO futures_positions (id, trading_account_id, instrument_id, direction, margin_mode, status, quantity, average_entry_price, entry_notional, leverage, isolated_margin, updated_at)
        SELECT ${randomUUID()}, trading_account_id, instrument_id, direction, margin_mode, status, quantity, average_entry_price, entry_notional, leverage, isolated_margin, now()
        FROM futures_positions WHERE trading_account_id = ${s.accountId} AND direction = 'long' AND status = 'open'`,
      /futures_positions_one_open_per_direction/u,
    );
    await invariant(s);
    pass(
      'concurrent opens: one lifetime per direction, enforced by the partial unique index',
    );
  } finally {
    await clean(s);
  }
}

/** Leverage 1–8, 11 and the DB guards. */
async function leverageChanges(marginMode: 'isolated' | 'cross') {
  const s = await fixture('general');
  try {
    await fresh(s);
    const opened = await openCmd(s, 'long', 10, { marginMode });
    const id = opened.data.position.id;
    const iso = marginMode === 'isolated';

    // Same leverage: a plain add (existing allocation rule).
    const same = await onPosition(s, 'long', 'increase');
    assert.equal(same.data.position.leverage, 10);
    assert.equal(
      same.data.position.isolatedMargin,
      iso ? '20.00000000' : '0.00000000',
    );
    assert.equal(same.data.leverageChange, null);

    // A different leverage without the user's confirmation never applies.
    const before = await snapshot(s);
    await reject(
      onPosition(s, 'long', 'increase', { leverage: 20 }),
      'FUTURES_LEVERAGE_MISMATCH',
    );
    await reject(
      onPosition(s, 'long', 'increase', { leverage: 20, fromLeverage: 15 }),
      'FUTURES_POSITION_CHANGED',
    );
    assert.equal(await snapshot(s), before);
    pass(
      `${marginMode} an unconfirmed or stale leverage change changes nothing`,
    );

    // Higher leverage with the add, in one transaction.
    await fresh(s);
    const up = await onPosition(s, 'long', 'increase', {
      leverage: 20,
      fromLeverage: 10,
    });
    assert.equal(up.data.position.id, id);
    assert.equal(up.data.position.leverage, 20);
    assert.equal(up.data.position.quantity, '3.00000000');
    assert.equal(up.data.position.averageEntryPrice, '100.00000000');
    assert.equal(up.data.execution.leverage, 20);
    assert.equal(up.data.execution.operation, 'increase');
    assert.equal(
      up.data.position.isolatedMargin,
      iso ? '15.00000000' : '0.00000000',
    );
    assert.deepEqual(up.data.leverageChange, {
      fromLeverage: 10,
      toLeverage: 20,
      isolatedMarginBefore: iso ? '20.00000000' : '0.00000000',
      isolatedMarginAfter: iso ? '15.00000000' : '0.00000000',
    });
    const upRow = await db.futuresLeverageChange.findUniqueOrThrow({
      where: { executionId: up.data.execution.id },
    });
    assert.equal(upRow.idempotencyKey, null);
    assert.equal(upRow.positionId, id);
    // Lower leverage with the add.
    await fresh(s);
    const down = await onPosition(s, 'long', 'increase', {
      leverage: 5,
      fromLeverage: 20,
    });
    assert.equal(down.data.position.leverage, 5);
    assert.equal(
      down.data.position.isolatedMargin,
      iso ? '80.00000000' : '0.00000000',
    );
    pass(`${marginMode} an add changes leverage up or down as confirmed`);

    // Leverage only: nothing but leverage and the allocation moves.
    const ledgerBefore = await db.walletTransaction.count({
      where: { tradingAccountId: s.accountId },
    });
    const executionsBefore = await db.futuresExecution.count({
      where: { tradingAccountId: s.accountId },
    });
    const walletBefore = await wallet(s);
    const positionBefore = await db.futuresPosition.findUniqueOrThrow({
      where: { id },
    });
    await fresh(s);
    const preview = await leverage.preview(s.userId, s.accountId, id, {
      leverage: '10',
    });
    assert.equal(preview.data.refusal, null);
    const key = randomUUID();
    const changed = await leverage.change(s.userId, s.accountId, id, {
      leverage: 10,
      fromLeverage: 5,
      idempotencyKey: key,
    });
    assert.equal(changed.data.position.leverage, 10);
    assert.equal(
      changed.data.position.isolatedMargin,
      iso ? '40.00000000' : '0.00000000',
    );
    assert.equal(
      preview.data.after?.isolatedMargin,
      changed.data.position.isolatedMargin,
    );
    assert.equal(
      preview.data.collateral?.freeCollateralAfter,
      changed.data.collateral.freeCollateral,
    );
    const positionAfter = await db.futuresPosition.findUniqueOrThrow({
      where: { id },
    });
    for (const field of [
      'quantity',
      'averageEntryPrice',
      'entryNotional',
      'realizedPnl',
      'status',
      'direction',
      'marginMode',
    ] as const)
      assert.deepEqual(positionAfter[field], positionBefore[field], field);
    assert.deepEqual(await wallet(s), walletBefore);
    assert.equal(
      await db.walletTransaction.count({
        where: { tradingAccountId: s.accountId },
      }),
      ledgerBefore,
    );
    assert.equal(
      await db.futuresExecution.count({
        where: { tradingAccountId: s.accountId },
      }),
      executionsBefore,
    );
    pass(`${marginMode} a leverage-only change moves no cash, PnL or history`);

    // Replay, conflict and concurrent duplicates.
    assert.deepEqual(
      await leverage.change(s.userId, s.accountId, id, {
        leverage: 10,
        fromLeverage: 5,
        idempotencyKey: key,
      }),
      changed,
    );
    await reject(
      leverage.change(s.userId, s.accountId, id, {
        leverage: 20,
        fromLeverage: 5,
        idempotencyKey: key,
      }),
      'FUTURES_IDEMPOTENCY_CONFLICT',
    );
    await reject(
      leverage.change(s.userId, s.accountId, id, {
        leverage: 20,
        fromLeverage: 5,
        idempotencyKey: randomUUID(),
      }),
      'FUTURES_POSITION_CHANGED',
    );
    await fresh(s);
    const twin = randomUUID();
    const pair = await Promise.all([
      leverage.change(s.userId, s.accountId, id, {
        leverage: 25,
        fromLeverage: 10,
        idempotencyKey: twin,
      }),
      leverage.change(s.userId, s.accountId, id, {
        leverage: 25,
        fromLeverage: 10,
        idempotencyKey: twin,
      }),
    ]);
    assert.deepEqual(pair[0], pair[1]);
    assert.equal(
      await db.futuresLeverageChange.count({ where: { idempotencyKey: twin } }),
      1,
    );
    pass(`${marginMode} a change replays once per key; a stale one is refused`);

    // Refusals leave every row as it was.
    const steady = await snapshot(s);
    await fresh(s);
    if (iso) {
      // A loss leaves no maintenance room at a higher leverage.
      await fresh(s, '97');
      await reject(
        leverage.change(s.userId, s.accountId, id, {
          leverage: 100,
          fromLeverage: 25,
          idempotencyKey: randomUUID(),
        }),
        'FUTURES_MAINTENANCE_UNSAFE',
      );
      const unsafe = await leverage.preview(s.userId, s.accountId, id, {
        leverage: '100',
      });
      assert.equal(unsafe.data.refusal, 'FUTURES_MAINTENANCE_UNSAFE');
      await fresh(s, '100');
    }
    // 1x needs the whole notional as margin: more than the free collateral.
    await setCash(s, '150');
    await reject(
      leverage.change(s.userId, s.accountId, id, {
        leverage: 1,
        fromLeverage: 25,
        idempotencyKey: randomUUID(),
      }),
      'INSUFFICIENT_FUTURES_FREE_COLLATERAL',
    );
    const short = await leverage.preview(s.userId, s.accountId, id, {
      leverage: '1',
    });
    assert.equal(short.data.refusal, 'INSUFFICIENT_FUTURES_FREE_COLLATERAL');
    await setCash(s, walletBefore.balanceAmount);
    assert.equal(await snapshot(s), steady);
    pass(`${marginMode} maintenance and collateral refusals change nothing`);

    // No fresh Mark: no estimate is shown and no change is made.
    await db.futuresMarkSnapshot.deleteMany({
      where: { instrumentId: instrumentId(s) },
    });
    const blind = await leverage.preview(s.userId, s.accountId, id, {
      leverage: '20',
    });
    assert.equal(blind.data.markState, 'unavailable_or_stale');
    assert.equal(blind.data.after, null);
    assert.equal(blind.data.collateral, null);
    await reject(
      leverage.change(s.userId, s.accountId, id, {
        leverage: 20,
        fromLeverage: 25,
        idempotencyKey: randomUUID(),
      }),
      'FUTURES_MARK_UNAVAILABLE',
    );
    await fresh(s);
    pass(`${marginMode} a missing Mark refuses the change and its estimate`);

    // DB guards: no leverage change without same-transaction evidence, never
    // on a closed lifetime, and the evidence is immutable.
    await assert.rejects(
      db.$executeRaw`UPDATE futures_positions SET leverage = 7 WHERE id = ${id}`,
      /evidence is missing/u,
    );
    await assert.rejects(
      db.$executeRaw`UPDATE futures_leverage_changes SET to_leverage = 7 WHERE position_id = ${id}`,
      /immutable/u,
    );
    await onPosition(s, 'long', 'close');
    await assert.rejects(
      db.$executeRaw`UPDATE futures_positions SET leverage = 7 WHERE id = ${id}`,
      /leverage changes only while open/u,
    );
    await reject(
      leverage.change(s.userId, s.accountId, id, {
        leverage: 7,
        fromLeverage: 25,
        idempotencyKey: randomUUID(),
      }),
      'FUTURES_POSITION_NOT_FOUND',
    );
    await invariant(s);
    pass(
      `${marginMode} DB guards bind leverage to evidence and open lifetimes`,
    );
  } finally {
    await clean(s);
  }
}

/** Leverage 9–10: a change racing a liquidation or another fill. */
async function leverageRaces() {
  const s = await fixture('general');
  try {
    await fresh(s);
    const { data } = await openCmd(s, 'long', 10);
    const raced = await Promise.allSettled([
      leverage.change(s.userId, s.accountId, data.position.id, {
        leverage: 20,
        fromLeverage: 10,
        idempotencyKey: randomUUID(),
      }),
      onPosition(s, 'long', 'increase', { leverage: 20, fromLeverage: 10 }),
    ]);
    // Serialized on the wallet: exactly one applies the 10 → 20 change; the
    // other was approved from 10 and now meets 20.
    assert.equal(raced.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(
      code(
        (raced.find((r) => r.status === 'rejected') as PromiseRejectedResult)
          .reason,
      ),
      'FUTURES_POSITION_CHANGED',
    );
    assert.equal(
      await db.futuresLeverageChange.count({
        where: { positionId: data.position.id },
      }),
      1,
    );
    pass('a change racing an add: one applies, the other sees the change');

    // Liquidation first: the change then finds no open lifetime.
    const current = (await lifetime(s, 'long'))!;
    await fresh(s, '60');
    const liquidated = await liquidator.liquidate(s.accountId, current.id);
    assert.equal(liquidated.state, 'liquidated');
    await reject(
      leverage.change(s.userId, s.accountId, current.id, {
        leverage: 5,
        fromLeverage: current.leverage,
        idempotencyKey: randomUUID(),
      }),
      'FUTURES_POSITION_NOT_FOUND',
    );
    await invariant(s);
    pass('a liquidated lifetime cannot be changed afterwards');
  } finally {
    await clean(s);
  }
}

/** Limit and conditional entries open or add with one rule. */
async function entries() {
  const s = await fixture('general');
  try {
    await fresh(s);
    const held = await openCmd(s, 'long', 10);
    const entry = (patch: Record<string, unknown> = {}) =>
      limits.create(s.userId, s.accountId, {
        instrumentId: instrumentId(s),
        direction: 'long',
        marginMode: 'isolated',
        leverage: 10,
        quantity: '1',
        limitPrice: '100',
        idempotencyKey: randomUUID(),
        ...patch,
      });
    await reject(entry({ leverage: 20 }), 'FUTURES_LEVERAGE_MISMATCH');
    await reject(
      entry({ marginMode: 'cross' }),
      'FUTURES_MARGIN_MODE_MISMATCH',
    );
    await reject(
      entry({ leverage: 20, fromLeverage: 15 }),
      'FUTURES_POSITION_CHANGED',
    );
    pass(
      'a Limit entry beside a lifetime keeps its mode and asks for a change',
    );

    // Same leverage: the fill adds to the lifetime.
    const add = await entry();
    assert.equal(add.data.order.leverageChange, null);
    await reject(entry(), 'FUTURES_ENTRY_PENDING');
    // A market trade of the direction is no longer blocked by it.
    await fresh(s);
    const market = await onPosition(s, 'long', 'increase');
    assert.equal(market.data.position.quantity, '2.00000000');
    await fresh(s, '99');
    assert.equal((await limits.evaluate(add.data.order.id)).state, 'executed');
    const merged = (await lifetime(s, 'long'))!;
    assert.equal(merged.id, held.data.position.id);
    assert.equal(merged.quantity.toFixed(8), '3.00000000');
    const fill = await db.futuresExecution.findFirstOrThrow({
      where: { limitOrder: { id: add.data.order.id } },
    });
    assert.equal(fill.operation, 'increase');
    assert.equal(fill.positionId, merged.id);
    await invariant(s);
    pass(
      'a Limit fill adds to the open lifetime; a market add beside it works',
    );

    // Approved change at the fill, with entry TP/SL plans on the merged lifetime.
    await fresh(s, '100');
    const approved = await entry({
      leverage: 20,
      fromLeverage: 10,
      entryTpSl: [{ kind: 'stop_loss', triggerPrice: '80', ratio: 100 }],
    });
    assert.deepEqual(approved.data.order.leverageChange, {
      positionId: merged.id,
      fromLeverage: 10,
    });
    assert.equal(
      (await lifetime(s, 'long'))!.leverage,
      10,
      'registering never changes the lifetime',
    );
    await fresh(s, '99');
    assert.equal(
      (await limits.evaluate(approved.data.order.id)).state,
      'executed',
    );
    const changed = (await lifetime(s, 'long'))!;
    assert.equal(changed.leverage, 20);
    assert.equal(changed.quantity.toFixed(8), '4.00000000');
    const evidence = await db.futuresLeverageChange.findFirstOrThrow({
      where: { positionId: changed.id, fromLeverage: 10, toLeverage: 20 },
    });
    assert.ok(evidence.executionId);
    const setting = await db.futuresTpSlSetting.findFirstOrThrow({
      where: { positionId: changed.id, kind: 'stop_loss' },
    });
    assert.equal(setting.quantity.toFixed(8), '1.00000000');
    pass('an approved change applies only at the fill, with the fill’s plans');

    // The lifetime changed after approval: the reachable entry ends instead.
    await fresh(s, '100');
    const stale = await entry({ leverage: 30, fromLeverage: 20 });
    await leverage.change(s.userId, s.accountId, changed.id, {
      leverage: 15,
      fromLeverage: 20,
      idempotencyKey: randomUUID(),
    });
    const lifetimeBefore = (await lifetime(s, 'long'))!;
    await fresh(s, '101');
    await reject(
      limits.evaluate(stale.data.order.id),
      'FUTURES_ENTRY_LIMIT_NOT_REACHED',
    );
    await fresh(s, '99');
    assert.equal(
      (await limits.evaluate(stale.data.order.id)).state,
      'position_changed',
    );
    const ended = await db.futuresLimitOrder.findUniqueOrThrow({
      where: { id: stale.data.order.id },
    });
    assert.equal(ended.status, 'canceled');
    assert.equal(ended.terminalReason, 'position_changed');
    assert.deepEqual(await lifetime(s, 'long'), lifetimeBefore);
    await invariant(s);
    pass(
      'an approval the lifetime outgrew ends the entry and frees its reservation',
    );

    // The other direction: a short Limit entry opens its own lifetime.
    await fresh(s, '100');
    const shortEntry = await entry({
      direction: 'short',
      leverage: 3,
      limitPrice: '100',
    });
    await fresh(s, '101');
    assert.equal(
      (await limits.evaluate(shortEntry.data.order.id)).state,
      'executed',
    );
    const short = (await lifetime(s, 'short'))!;
    assert.equal(short.leverage, 3);
    assert.deepEqual(await lifetime(s, 'long'), lifetimeBefore);
    pass('a short Limit fill beside the long opens the short lifetime');

    // Conditional entries: market add with an approved change; limit add.
    await fresh(s, '100');
    const watch = await watches.create(s.userId, s.accountId, {
      instrumentId: instrumentId(s),
      direction: 'long',
      marginMode: 'isolated',
      leverage: 12,
      fromLeverage: 15,
      quantity: '1',
      triggerCondition: 'at_or_above',
      triggerPrice: '105',
      executionType: 'market',
      idempotencyKey: randomUUID(),
    });
    await fresh(s, '106');
    assert.equal(
      (await watches.evaluate(watch.data.entry.id)).state,
      'ordered',
    );
    const watched = (await lifetime(s, 'long'))!;
    assert.equal(watched.id, lifetimeBefore.id);
    assert.equal(watched.leverage, 12);
    assert.equal(
      watched.quantity.toFixed(8),
      lifetimeBefore.quantity.add(1).toFixed(8),
    );
    await fresh(s, '100');
    const limitWatch = await watches.create(s.userId, s.accountId, {
      instrumentId: instrumentId(s),
      direction: 'short',
      marginMode: 'isolated',
      leverage: 4,
      fromLeverage: 3,
      quantity: '1',
      triggerCondition: 'at_or_below',
      triggerPrice: '95',
      executionType: 'limit',
      limitPrice: '96',
      idempotencyKey: randomUUID(),
    });
    await fresh(s, '94');
    assert.equal(
      (await watches.evaluate(limitWatch.data.entry.id)).state,
      'ordered',
    );
    const child = await db.futuresLimitOrder.findFirstOrThrow({
      where: { conditionalEntry: { id: limitWatch.data.entry.id } },
    });
    assert.equal(child.leverageChangePositionId, short.id);
    assert.equal(child.leverageChangeFrom, 3);
    await fresh(s, '96');
    assert.equal((await limits.evaluate(child.id)).state, 'executed');
    assert.equal((await lifetime(s, 'short'))!.leverage, 4);
    assert.equal(
      (await lifetime(s, 'short'))!.quantity.toFixed(8),
      '2.00000000',
    );
    await invariant(s);
    pass('conditional entries add with the change the user approved');

    // Cancel releases a pending entry's reservation.
    await fresh(s, '100');
    const canceled = await entry({ leverage: 12, limitPrice: '90' });
    assert.ok((await wallet(s)).reservedAmount.gt(0));
    await limits.cancel(s.userId, s.accountId, canceled.data.order.id);
    assert.equal((await wallet(s)).reservedAmount.toFixed(8), '0.00000000');
    await invariant(s);
    pass('a pending entry cancel releases its reservation');
  } finally {
    await clean(s);
  }
}

/** TP/SL on a long and a short at once; a leverage change keeps them. */
async function protections() {
  const s = await fixture('general');
  try {
    await fresh(s);
    const long = (await openCmd(s, 'long', 10)).data.position;
    const short = (await openCmd(s, 'short', 10)).data.position;
    const setting = async (
      positionId: string,
      leg: 'stopLoss' | 'takeProfit',
      triggerPrice: string,
      quantity: string,
    ) =>
      (
        await tpSl.create(s.userId, s.accountId, {
          positionId,
          idempotencyKey: randomUUID(),
          [leg]: { triggerPrice, quantity },
        })
      ).data.settings[0];
    const longSl = await setting(long.id, 'stopLoss', '98', '0.4');
    const shortSl = await setting(short.id, 'stopLoss', '105', '1');
    const shortTp = await setting(short.id, 'takeProfit', '90', '0.5');
    // A leverage change keeps the settings exactly.
    await fresh(s);
    await leverage.change(s.userId, s.accountId, long.id, {
      leverage: 20,
      fromLeverage: 10,
      idempotencyKey: randomUUID(),
    });
    for (const row of [longSl, shortSl, shortTp]) {
      const kept = await db.futuresTpSlSetting.findUniqueOrThrow({
        where: { id: row.id },
      });
      assert.equal(kept.status, 'watching');
      assert.equal(kept.quantity.toFixed(8), row.quantity);
      assert.equal(kept.triggerPrice.toFixed(8), row.triggerPrice);
    }
    pass('a leverage change keeps every stop-loss/take-profit setting');

    const shortBefore = await db.futuresPosition.findUniqueOrThrow({
      where: { id: short.id },
    });
    await fresh(s, '97.9');
    assert.equal((await tpSl.evaluate(longSl.id)).state, 'ordered');
    const longAfter = await db.futuresPosition.findUniqueOrThrow({
      where: { id: long.id },
    });
    assert.equal(longAfter.quantity.toFixed(8), '0.60000000');
    const fired = await db.futuresExecution.findFirstOrThrow({
      where: { tpSlSetting: { id: longSl.id } },
    });
    assert.equal(fired.leverage, 20);
    assert.equal(fired.operation, 'reduce');
    assert.deepEqual(
      await db.futuresPosition.findUniqueOrThrow({ where: { id: short.id } }),
      shortBefore,
    );
    // The short's take-profit (≤ 90) is not met at 97.9.
    assert.equal((await tpSl.evaluate(shortTp.id)).state, 'watching');
    await fresh(s, '106');
    const longKept = await db.futuresPosition.findUniqueOrThrow({
      where: { id: long.id },
    });
    assert.equal((await tpSl.evaluate(shortSl.id)).state, 'ordered');
    const shortClosed = await db.futuresPosition.findUniqueOrThrow({
      where: { id: short.id },
    });
    assert.equal(shortClosed.status, 'closed');
    assert.deepEqual(
      await db.futuresPosition.findUniqueOrThrow({ where: { id: long.id } }),
      longKept,
    );
    // The short's other setting ended with its lifetime; the long never saw it.
    assert.equal(
      (
        await db.futuresTpSlSetting.findUniqueOrThrow({
          where: { id: shortTp.id },
        })
      ).status,
      'canceled',
    );
    await invariant(s);
    pass('a long and a short stop-loss each reduce only their own lifetime');
  } finally {
    await clean(s);
  }
}

/** Liquidation scopes: Isolated per lifetime, Cross for both directions. */
async function liquidations() {
  const s = await fixture('general');
  try {
    await fresh(s);
    const long = (await openCmd(s, 'long', 50)).data.position;
    const short = (await openCmd(s, 'short', 50)).data.position;
    const shortBefore = await db.futuresPosition.findUniqueOrThrow({
      where: { id: short.id },
    });
    await fresh(s, '98.5');
    assert.equal(
      (await liquidator.liquidate(s.accountId, short.id)).state,
      'healthy',
    );
    assert.equal(
      (await liquidator.liquidate(s.accountId, long.id)).state,
      'liquidated',
    );
    const close = await db.futuresLiquidationClose.findMany({
      where: { tradingAccountId: s.accountId },
    });
    assert.deepEqual(
      close.map((c) => c.positionId),
      [long.id],
    );
    assert.deepEqual(
      await db.futuresPosition.findUniqueOrThrow({ where: { id: short.id } }),
      shortBefore,
    );
    await invariant(s);
    pass('an Isolated liquidation closes only its own direction');
  } finally {
    await clean(s);
  }
  const c = await fixture('general', '30');
  try {
    await fresh(c);
    await openCmd(c, 'long', 10, { marginMode: 'cross' });
    await openCmd(c, 'short', 10, { marginMode: 'cross' });
    // Offsetting PnL never discounts the summed requirements: 2 × 10 initial.
    await reject(
      leverage.change(c.userId, c.accountId, (await lifetime(c, 'long'))!.id, {
        leverage: 2,
        fromLeverage: 10,
        idempotencyKey: randomUUID(),
      }),
      'INSUFFICIENT_FUTURES_FREE_COLLATERAL',
    );
    await setCash(c, '1.2');
    await fresh(c, '100');
    assert.equal(
      (await liquidator.liquidate(c.accountId, 'cross')).state,
      'liquidated',
    );
    assert.equal(
      await db.futuresPosition.count({
        where: { tradingAccountId: c.accountId, status: 'open' },
      }),
      0,
    );
    assert.equal(
      await db.futuresLiquidationClose.count({
        where: { tradingAccountId: c.accountId },
      }),
      2,
    );
    pass('a Cross liquidation closes the long and the short together');
  } finally {
    await clean(c);
  }
}

/** Season final exit and valuation with both directions open. */
async function seasonAndValuation() {
  const s = await fixture('season');
  try {
    await fresh(s);
    await openCmd(s, 'long', 10);
    await openCmd(s, 'short', 5, { marginMode: 'cross' });
    await fresh(s, '110');
    const at = await now();
    const value = await valuation.calculateTradingAccountValuation(
      s.accountId,
      at,
      'live_portfolio_valuation',
      db,
    );
    // Long +10 and short −10 at Mark 110: both lifetimes are valued.
    assert.equal(D(value.futuresUnrealizedPnlUsd!).toFixed(8), '0.00000000');
    const read = await app.futures.positions(s.userId, s.accountId);
    assert.deepEqual(
      read.data.positions.map((p) => [p.direction, p.markUnrealizedPnl]).sort(),
      [
        ['long', '10.00000000'],
        ['short', '-10.00000000'],
      ],
    );
    // Outgoing cash keeps both lifetimes' collateral (the shared seam of
    // USD and FX transfers).
    const free = D(read.data.collateral.freeCollateral!);
    const source = await wallet(s);
    await assert.rejects(
      db.$transaction((tx) =>
        assertFuturesTransferCollateral(tx, source, free.add(1).toFixed(8)),
      ),
      (error: unknown) =>
        code(error) === 'INSUFFICIENT_FUTURES_FREE_COLLATERAL',
    );
    await db.$transaction((tx) =>
      assertFuturesTransferCollateral(tx, source, '1.00000000'),
    );
    pass('valuation and transfers count both directions');

    const endAt = await now();
    await db.futuresLastPriceSnapshot.create({
      data: {
        instrumentId: instrumentId(s),
        symbol: s.instruments[0].asset.symbol,
        price: '110',
        source: 'binance_usdm_agg_trade_ws',
        effectiveAt: endAt,
        capturedAt: endAt,
      },
    });
    await db.season.update({
      where: { id: s.season!.id },
      data: { status: 'ended', endAt },
    });
    await final.settleSeason(s.season!.id);
    await final.settleSeason(s.season!.id);
    const settlement = await db.futuresSeasonSettlement.findUniqueOrThrow({
      where: { tradingAccountId: s.accountId },
      include: { closes: true },
    });
    assert.deepEqual(settlement.closes.map((c) => c.direction).sort(), [
      'long',
      'short',
    ]);
    assert.equal(
      settlement.feeAmount.toFixed(8),
      settlement.closes
        .reduce((sum, c) => sum.add(c.feeAmount), D(0))
        .toFixed(8),
    );
    assert.equal(
      await db.futuresPosition.count({
        where: { tradingAccountId: s.accountId, status: 'open' },
      }),
      0,
    );
    assert.equal(
      await db.walletTransaction.count({
        where: {
          referenceType: 'futures_season_settlement',
          referenceId: settlement.id,
          txType: 'fee',
        },
      }),
      1,
    );
    await invariant(s);
    pass('the Season final exit closes both directions once, one fee');
  } finally {
    await clean(s);
  }
}

async function main() {
  await db.$connect();
  for (const mode of ['general', 'season'] as const)
    for (const marginMode of ['isolated', 'cross'] as const)
      await positions(mode, marginMode);
  await races();
  for (const marginMode of ['isolated', 'cross'] as const)
    await leverageChanges(marginMode);
  await leverageRaces();
  await entries();
  await protections();
  await liquidations();
  await seasonAndValuation();
  console.log(`futures two-way db integration ok (${checks} checks)`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.fxRateSnapshot.deleteMany({
      where: { id: { in: fxEvidenceIds } },
    });
    await db.$disconnect();
  });
