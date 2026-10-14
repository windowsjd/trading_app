import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  db,
  app,
  fixture,
  newInstrument,
  now,
  price,
  fxEvidence,
  fxEvidenceIds,
  cleanup,
  holdRowLock,
  untilLockWaiting,
  reject,
  code,
  type Scenario,
} from './futures-integration';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import { FuturesLimitService } from '../src/futures/futures-limit.service';
import { FuturesConditionalEntryService } from '../src/futures/futures-conditional-entry.service';
import { FuturesConditionalEntryWorker } from '../src/futures/futures-conditional-entry-worker.service';
import { OpsJobLockService } from '../src/ops/ops-job-lock.service';
import { OpsJobRunService } from '../src/ops/ops-job-run.service';
import { LimitOrderCancelService } from '../src/orders/limit-order-cancel.service';
import { OrderReservationService } from '../src/orders/order-reservation.service';
import { ConditionalService } from '../src/conditional/conditional.service';
import type { OrdersService } from '../src/orders/orders.service';
import { SeasonSettlementJobService } from '../src/batch/season-settlement-job.service';
import { BatchService } from '../src/batch/batch.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { FuturesLastPriceRetentionService } from '../src/futures/futures-last-price-retention.service';

/**
 * Futures Conditional Entry v1 against actual PostgreSQL: registration
 * guards, LONG/SHORT × market/limit triggers on Futures Last, the existing
 * engines' refusals, cancel/trigger and worker races, idempotent replay,
 * lifecycle cleanup, modes, account isolation and TP/SL independence.
 */
if (
  process.env.NODE_ENV !== 'test' ||
  process.env.FUTURES_CONDITIONAL_ENTRY_DB_INTEGRATION !== '1'
)
  throw new Error(
    'Explicit disposable Futures conditional entry DB opt-in required',
  );
process.env.FUTURES_TRADING_MODE = 'ENABLED';
process.env.FUTURES_CONDITIONAL_ENTRY_ENABLED = 'true';
process.env.CONDITIONAL_ORDERS_ENABLED = 'true';
const access = new TradingAccountAccessService(db);
const limits = new FuturesLimitService(db, access, app.futures);
const entries = new FuturesConditionalEntryService(
  db,
  access,
  app.futures,
  limits,
);
const locks = new OpsJobLockService(db),
  runs = new OpsJobRunService(db);
const worker = () =>
  new FuturesConditionalEntryWorker(db, locks, runs, entries);
const cancelService = new LimitOrderCancelService(
  db,
  new OrderReservationService(),
);
const protections = new ConditionalService(
  db,
  access,
  {} as OrdersService,
  cancelService,
  app.futures,
);
let checks = 0;
const pass = (label: string) => {
  checks++;
  console.log(`PASS ${label}`);
};

/** Fresh Futures Last (trade = receipt = DB now) and a fresh Mark. */
async function market(s: Scenario, value: string, index = 0) {
  await fxEvidence();
  const last = await price(s, value, index, 0);
  const at = await now();
  await db.futuresMarkSnapshot.create({
    data: {
      instrumentId: s.instruments[index].instrument.id,
      symbol: s.instruments[index].asset.symbol,
      price: value,
      source: 'binance_usdm_mark_ws',
      effectiveAt: at,
      capturedAt: at,
    },
  });
  return last;
}
async function staleMark(s: Scenario, value: string, index = 0) {
  const at = await now();
  await db.futuresMarkSnapshot.deleteMany({
    where: { instrumentId: s.instruments[index].instrument.id },
  });
  await db.futuresMarkSnapshot.create({
    data: {
      instrumentId: s.instruments[index].instrument.id,
      symbol: s.instruments[index].asset.symbol,
      price: value,
      source: 'binance_usdm_mark_ws',
      effectiveAt: new Date(+at - 600_000),
      capturedAt: new Date(+at - 600_000),
    },
  });
}
function body(s: Scenario, patch: Record<string, unknown> = {}) {
  return {
    instrumentId: s.instruments[0].instrument.id,
    direction: 'long',
    marginMode: 'isolated',
    leverage: 10,
    quantity: '1',
    triggerCondition: 'at_or_above',
    triggerPrice: '110',
    executionType: 'market',
    idempotencyKey: `entry-${randomUUID()}`,
    ...patch,
  };
}
const wallet = (s: Scenario) =>
  db.cashWallet.findUniqueOrThrow({ where: { id: s.futuresWalletId } });
const row = (id: string) =>
  db.futuresConditionalEntry.findUniqueOrThrow({ where: { id } });
async function presented(s: Scenario, id: string, state = 'open') {
  const list = await entries.list(s.userId, s.accountId, { state });
  return list.data.entries.find((entry) => entry.id === id);
}
/** Financial rows that registration and refusals must never touch. */
async function finance(s: Scenario) {
  const where = { tradingAccountId: s.accountId };
  return JSON.stringify({
    wallet: await wallet(s),
    positions: await db.futuresPosition.count({ where }),
    executions: await db.futuresExecution.count({ where }),
    commands: await db.futuresExecuteRequest.count({ where }),
    limitOrders: await db.futuresLimitOrder.count({ where }),
    ledger: await db.walletTransaction.count({ where }),
  });
}
/**
 * Insert a meeting Futures Last and evaluate. A trade whose clock reads
 * earlier than registration (`awaiting_price`) never triggers by contract;
 * on this host the clock can step back, so only that state is re-sampled.
 */
async function triggerWith(
  s: Scenario,
  id: string,
  value: string,
  index = 0,
  evaluate: () => Promise<{ state: string }> = () => entries.evaluate(id),
) {
  for (let attempt = 0; ; attempt++) {
    await market(s, value, index);
    const result = await evaluate();
    if (result.state !== 'awaiting_price' || attempt >= 5) return result.state;
    await delay(200);
  }
}
async function clean(...scenarios: Scenario[]) {
  for (const s of scenarios) {
    const where = { tradingAccountId: s.accountId };
    await db.futuresConditionalEntry.deleteMany({ where });
    const groups = await db.protectionGroup.findMany({
      where,
      select: { id: true },
    });
    const groupId = { in: groups.map((g) => g.id) };
    await db.protectionChild.deleteMany({ where: { groupId } });
    await db.protectionLeg.deleteMany({ where: { groupId } });
    await db.protectionCommand.deleteMany({ where });
    await db.protectionGroup.deleteMany({ where });
    await cleanup(s);
  }
}

async function registration() {
  const s = await fixture('general');
  const other = await fixture('general');
  try {
    await market(s, '100');
    const before = await finance(s);
    const created = await entries.create(s.userId, s.accountId, body(s));
    const entry = created.data.entry;
    assert.equal(entry.status, 'watching');
    assert.equal(entry.state, 'watching');
    assert.equal(created.data.duplicate, false);
    assert.equal(await finance(s), before);
    assert.equal((await row(entry.id)).registrationSnapshotId === null, false);
    pass(
      'registration stores the watch only: no reservation, position, command or ledger',
    );

    const replay = await entries.create(s.userId, s.accountId, {
      ...body(s),
      idempotencyKey: (await row(entry.id)).idempotencyKey,
    });
    assert.equal(replay.data.entry.id, entry.id);
    assert.equal(replay.data.duplicate, true);
    await reject(
      entries.create(s.userId, s.accountId, {
        ...body(s, { triggerPrice: '111' }),
        idempotencyKey: (await row(entry.id)).idempotencyKey,
      }),
      'FUTURES_IDEMPOTENCY_CONFLICT',
    );
    pass(
      'create replays the same intent and refuses a different one under the same key',
    );

    await reject(
      entries.create(s.userId, s.accountId, body(s, { direction: 'short' })),
      'FUTURES_CONDITIONAL_ENTRY_PENDING',
    );
    await assert.rejects(
      db.$executeRaw`INSERT INTO futures_conditional_entries (id, trading_account_id, instrument_id, direction, margin_mode, leverage, quantity, trigger_condition, trigger_price, execution_type, registration_snapshot_id, idempotency_key, request_hash, updated_at)
        SELECT ${randomUUID()}, trading_account_id, instrument_id, direction, margin_mode, leverage, quantity, trigger_condition, trigger_price, execution_type, registration_snapshot_id, ${randomUUID()}, request_hash, now()
        FROM futures_conditional_entries WHERE id = ${entry.id}`,
    );
    pass(
      'one live entry per instrument: service refusal and the partial unique index',
    );

    for (const [patch, expected] of [
      [{ triggerPrice: '100' }, 'FUTURES_CONDITIONAL_ENTRY_ALREADY_MET'],
      [
        { triggerCondition: 'at_or_below', triggerPrice: '100' },
        'FUTURES_CONDITIONAL_ENTRY_ALREADY_MET',
      ],
      [
        { triggerCondition: 'at_or_below', triggerPrice: '101' },
        'FUTURES_CONDITIONAL_ENTRY_ALREADY_MET',
      ],
    ] as const) {
      await market(s, '100', 1);
      await reject(
        entries.create(
          s.userId,
          s.accountId,
          body(s, { ...patch, instrumentId: s.instruments[1].instrument.id }),
        ),
        expected,
      );
    }
    pass(
      'a condition the current Last already meets (≥ and ≤, equality) is refused',
    );

    // Instrument 1 of another scenario: no Last at all, then only a stale one.
    await db.futuresLastPriceSnapshot.deleteMany({
      where: { instrumentId: other.instruments[1].instrument.id },
    });
    await reject(
      entries.create(
        other.userId,
        other.accountId,
        body(other, { instrumentId: other.instruments[1].instrument.id }),
      ),
      'FUTURES_PRICE_UNAVAILABLE',
    );
    await price(other, '100', 1, 70_000);
    await reject(
      entries.create(
        other.userId,
        other.accountId,
        body(other, { instrumentId: other.instruments[1].instrument.id }),
      ),
      'FUTURES_PRICE_STALE',
    );
    pass('registration requires a fresh verified Futures Last');

    await market(other, '100');
    await app.futures.execute(other.userId, other.accountId, {
      instrumentId: other.instruments[0].instrument.id,
      operation: 'open',
      direction: 'long',
      quantity: '1',
      leverage: 10,
      idempotencyKey: randomUUID(),
    });
    await reject(
      entries.create(other.userId, other.accountId, body(other)),
      'FUTURES_POSITION_ALREADY_OPEN',
    );
    await market(other, '100', 1);
    await limits.create(other.userId, other.accountId, {
      instrumentId: other.instruments[1].instrument.id,
      direction: 'long',
      marginMode: 'isolated',
      leverage: 10,
      quantity: '1',
      limitPrice: '90',
      idempotencyKey: randomUUID(),
    });
    await reject(
      entries.create(
        other.userId,
        other.accountId,
        body(other, { instrumentId: other.instruments[1].instrument.id }),
      ),
      'FUTURES_ENTRY_PENDING',
    );
    pass(
      'existing position and pending limit entry conflicts follow the one-way policy',
    );

    await reject(
      entries.create(other.userId, s.accountId, body(s)),
      'TRADING_ACCOUNT_NOT_FOUND',
    );
    await reject(
      entries.cancel(other.userId, s.accountId, entry.id),
      'TRADING_ACCOUNT_NOT_FOUND',
    );
    await reject(
      entries.cancel(other.userId, other.accountId, entry.id),
      'FUTURES_CONDITIONAL_ENTRY_NOT_FOUND',
    );
    const otherList = await entries.list(other.userId, other.accountId, {});
    assert.equal(
      otherList.data.entries.some((item) => item.id === entry.id),
      false,
    );
    pass('another account can neither read nor cancel the entry');

    process.env.FUTURES_CONDITIONAL_ENTRY_ENABLED = 'false';
    await reject(
      entries.create(
        s.userId,
        s.accountId,
        body(s, { instrumentId: s.instruments[1].instrument.id }),
      ),
      'FUTURES_CONDITIONAL_ENTRY_DISABLED',
    );
    process.env.FUTURES_CONDITIONAL_ENTRY_ENABLED = 'true';
    for (const [mode, expected] of [
      ['REDUCE_ONLY', 'FUTURES_REDUCE_ONLY'],
      ['DISABLED', 'FUTURES_TRADING_DISABLED'],
    ] as const) {
      process.env.FUTURES_TRADING_MODE = mode;
      await reject(
        entries.create(
          s.userId,
          s.accountId,
          body(s, { instrumentId: s.instruments[1].instrument.id }),
        ),
        expected,
      );
    }
    process.env.FUTURES_TRADING_MODE = 'ENABLED';
    pass('feature flag and Reduce Only / Disabled modes refuse new entries');

    const canceled = await entries.cancel(s.userId, s.accountId, entry.id);
    assert.equal(canceled.data.entry.state, 'canceled');
    assert.equal(canceled.data.entry.terminalReason, 'user_canceled');
    const again = await entries.cancel(s.userId, s.accountId, entry.id);
    assert.equal(again.data.duplicate, true);
    await market(s, '120');
    assert.equal((await entries.evaluate(entry.id)).state, 'terminal');
    assert.equal(await finance(s), before);
    assert.equal((await presented(s, entry.id, 'ended'))?.state, 'canceled');
    pass('cancel while watching is terminal, idempotent and never triggers');
  } finally {
    process.env.FUTURES_CONDITIONAL_ENTRY_ENABLED = 'true';
    process.env.FUTURES_TRADING_MODE = 'ENABLED';
    await clean(s, other);
  }
}

async function beginnerGate() {
  const s = await fixture('beginner', '10000', true);
  try {
    await market(s, '100');
    await reject(
      entries.create(s.userId, s.accountId, body(s)),
      'BEGINNER_FEATURE_LOCKED',
    );
    pass('beginner accounts need allTrading learning access');
  } finally {
    await clean(s);
  }
}

async function marketEntry(
  mode: 'general' | 'season',
  direction: 'long' | 'short',
) {
  const s = await fixture(mode);
  try {
    await market(s, '100');
    const long = direction === 'long';
    const created = await entries.create(
      s.userId,
      s.accountId,
      body(s, {
        direction,
        marginMode: long ? 'isolated' : 'cross',
        leverage: long ? 10 : 25,
        quantity: '2',
        triggerCondition: long ? 'at_or_above' : 'at_or_below',
        triggerPrice: long ? '110' : '90',
      }),
    );
    const id = created.data.entry.id;
    await market(s, long ? '109.99' : '90.01');
    assert.equal((await entries.evaluate(id)).state, 'watching');
    const before = await wallet(s);
    const fills =
      mode === 'season'
        ? (
            await db.seasonParticipant.findFirstOrThrow({
              where: { tradingAccountId: s.accountId },
            })
          ).totalFillCount
        : 0;
    assert.equal(await triggerWith(s, id, long ? '110' : '90'), 'ordered');
    const entry = await row(id);
    assert.equal(entry.status, 'ordered');
    assert.equal(entry.triggerSnapshotId === null, false);
    const execution = await db.futuresExecution.findUniqueOrThrow({
      where: { id: entry.executionId! },
    });
    assert.equal(execution.operation, 'open');
    assert.equal(execution.direction, direction);
    assert.equal(execution.marginMode, long ? 'isolated' : 'cross');
    assert.equal(execution.leverage, long ? 10 : 25);
    assert.equal(execution.quantity.toFixed(8), '2.00000000');
    assert.equal(
      execution.executionPrice.toFixed(2),
      long ? '110.00' : '90.00',
    );
    assert.equal(execution.lastPriceSnapshotId === null, false);
    const command = await db.futuresExecuteRequest.findUniqueOrThrow({
      where: { executionId: execution.id },
    });
    assert.equal(command.idempotencyKey, `futures-conditional:${id}`);
    const after = await wallet(s);
    assert.equal(
      after.balanceAmount.toFixed(8),
      before.balanceAmount.sub(execution.feeAmount).toFixed(8),
    );
    assert.equal(after.reservedAmount.toFixed(8), '0.00000000');
    const position = await db.futuresPosition.findFirstOrThrow({
      where: { tradingAccountId: s.accountId, status: 'open' },
    });
    assert.equal(position.direction, direction);
    assert.equal(position.id, execution.positionId);
    if (mode === 'season')
      assert.equal(
        (
          await db.seasonParticipant.findFirstOrThrow({
            where: { tradingAccountId: s.accountId },
          })
        ).totalFillCount,
        fills + 1,
      );
    const shown = await presented(s, id, 'ended');
    assert.equal(shown?.state, 'filled');
    assert.equal(shown?.execution?.executionId, execution.id);
    pass(
      `${mode} ${direction.toUpperCase()} market entry triggers on Futures Last ${long ? '≥' : '≤'} and opens through the existing engine`,
    );

    // The worker retry path and the command key replay the single execution.
    const replay = await app.futures.execute(
      s.userId,
      s.accountId,
      {
        instrumentId: entry.instrumentId,
        operation: 'open',
        direction,
        marginMode: entry.marginMode,
        leverage: entry.leverage,
        quantity: entry.quantity.toFixed(8),
        idempotencyKey: `futures-conditional:${id}`,
      },
      undefined,
      undefined,
      id,
    );
    assert.equal(replay.data.execution.id, execution.id);
    assert.equal(
      await db.futuresExecution.count({
        where: { tradingAccountId: s.accountId },
      }),
      1,
    );
    assert.equal((await entries.evaluate(id)).state, 'terminal');
    pass(
      `${mode} ${direction.toUpperCase()} retry replays the committed command; no second execution`,
    );

    // TP/SL of the opened position stays the existing protection feature.
    await market(s, long ? '110' : '90');
    const group = (await protections.create(s.userId, s.accountId, {
      domain: 'futures',
      assetId: s.instruments[0].asset.id,
      positionId: position.id,
      idempotencyKey: randomUUID(),
      legs: [
        {
          kind: 'take_profit',
          triggerPrice: long ? '130' : '70',
          childOrderType: 'market',
        },
        {
          kind: 'stop_loss',
          triggerPrice: long ? '100' : '100.5',
          childOrderType: 'market',
        },
      ],
    })) as { data: { groupId: string; status: string } };
    assert.equal(group.data.status, 'active');
    assert.equal((await row(id)).status, 'ordered');
    assert.equal(
      (await entries.list(s.userId, s.accountId, {})).data.entries.some(
        (item) => item.id === group.data.groupId,
      ),
      false,
    );
    pass(
      `${mode} ${direction.toUpperCase()} position TP/SL is a separate protection group`,
    );
  } finally {
    await clean(s);
  }
}

async function limitEntry(direction: 'long' | 'short') {
  const s = await fixture('general');
  try {
    await market(s, '100');
    const long = direction === 'long';
    const created = await entries.create(
      s.userId,
      s.accountId,
      body(s, {
        direction,
        quantity: '1.5',
        leverage: 20,
        triggerCondition: long ? 'at_or_above' : 'at_or_below',
        triggerPrice: long ? '110' : '90',
        executionType: 'limit',
        limitPrice: long ? '111' : '89',
      }),
    );
    const id = created.data.entry.id;
    assert.equal(
      created.data.entry.limitPrice,
      long ? '111.00000000' : '89.00000000',
    );
    const before = await wallet(s);
    assert.equal(await triggerWith(s, id, long ? '110' : '90'), 'ordered');
    const entry = await row(id);
    const order = await db.futuresLimitOrder.findUniqueOrThrow({
      where: { id: entry.limitOrderId! },
    });
    assert.equal(order.status, 'submitted');
    assert.equal(order.idempotencyKey, `futures-conditional:${id}`);
    assert.equal(
      order.limitPrice.toFixed(8),
      long ? '111.00000000' : '89.00000000',
    );
    assert.equal(order.direction, direction);
    assert.equal(
      (await wallet(s)).reservedAmount.toFixed(8),
      order.reservedAmount.toFixed(8),
    );
    assert.equal(
      (await wallet(s)).balanceAmount.toFixed(8),
      before.balanceAmount.toFixed(8),
    );
    assert.equal(
      await db.futuresPosition.count({
        where: { tradingAccountId: s.accountId },
      }),
      0,
    );
    assert.equal((await presented(s, id))?.state, 'order_pending');
    pass(
      `${direction.toUpperCase()} limit entry: trigger creates the existing limit entry and reserves only then`,
    );

    await reject(
      entries.cancel(s.userId, s.accountId, id),
      'FUTURES_CONDITIONAL_ENTRY_ALREADY_ORDERED',
    );
    // Fill by the existing matcher on Futures Last after the order exists.
    for (let attempt = 0; ; attempt++) {
      await market(s, long ? '110.5' : '89.5');
      const state = await limits.evaluate(order.id).then(
        (result) => result.state,
        (error: unknown) => code(error),
      );
      if (state === 'executed') break;
      assert.ok(
        state === 'FUTURES_ENTRY_LIMIT_NOT_REACHED' && attempt < 5,
        `limit fill state ${state}`,
      );
      await delay(200);
    }
    const filled = await db.futuresLimitOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    assert.equal(filled.status, 'executed');
    const position = await db.futuresPosition.findFirstOrThrow({
      where: { tradingAccountId: s.accountId, status: 'open' },
    });
    assert.equal(position.direction, direction);
    assert.equal((await wallet(s)).reservedAmount.toFixed(8), '0.00000000');
    assert.equal((await presented(s, id, 'ended'))?.state, 'filled');
    pass(
      `${direction.toUpperCase()} limit entry fills only through the existing matcher (creation ≠ fill)`,
    );
  } finally {
    await clean(s);
  }
}

async function limitCancelAfterOrder() {
  const s = await fixture('general');
  try {
    await market(s, '100');
    const id = (
      await entries.create(
        s.userId,
        s.accountId,
        body(s, { executionType: 'limit', limitPrice: '95' }),
      )
    ).data.entry.id;
    assert.equal(await triggerWith(s, id, '110'), 'ordered');
    const orderId = (await row(id)).limitOrderId!;
    await limits.cancel(s.userId, s.accountId, orderId);
    assert.equal((await wallet(s)).reservedAmount.toFixed(8), '0.00000000');
    assert.equal((await presented(s, id, 'ended'))?.state, 'order_canceled');
    pass(
      'the created limit entry is canceled through the existing limit cancel (order_canceled)',
    );
  } finally {
    await clean(s);
  }
}

async function refusals() {
  const s = await fixture('general', '50');
  try {
    // Insufficient collateral is checked only at execution: failed, untouched.
    await market(s, '100');
    const id = (
      await entries.create(
        s.userId,
        s.accountId,
        body(s, { quantity: '100', leverage: 2 }),
      )
    ).data.entry.id;
    const before = await finance(s);
    const state = await triggerWith(s, id, '110');
    assert.equal(state, 'INSUFFICIENT_FUTURES_FREE_COLLATERAL');
    const failed = await row(id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.terminalReason, 'execution_failed');
    assert.equal(failed.failureCode, 'INSUFFICIENT_FUTURES_FREE_COLLATERAL');
    assert.equal(await finance(s), before);
    assert.equal((await presented(s, id, 'ended'))?.state, 'failed');
    pass(
      'insufficient collateral at execution fails the entry; no position or ledger',
    );

    // Isolated maintenance: the existing risk check refuses (Mark far below Last).
    await market(s, '100', 1);
    const risky = (
      await entries.create(
        s.userId,
        s.accountId,
        body(s, {
          instrumentId: s.instruments[1].instrument.id,
          quantity: '0.01',
          leverage: 100,
        }),
      )
    ).data.entry.id;
    for (let attempt = 0; ; attempt++) {
      await price(s, '110', 1, 0);
      const at = await now();
      await db.futuresMarkSnapshot.create({
        data: {
          instrumentId: s.instruments[1].instrument.id,
          symbol: s.instruments[1].asset.symbol,
          price: '100',
          source: 'binance_usdm_mark_ws',
          effectiveAt: at,
          capturedAt: at,
        },
      });
      const result = await entries.evaluate(risky);
      if (result.state !== 'awaiting_price' || attempt >= 5) {
        assert.equal(result.state, 'FUTURES_MAINTENANCE_UNSAFE');
        break;
      }
      await delay(200);
    }
    assert.equal((await row(risky)).status, 'failed');
    pass(
      'isolated leverage/maintenance policy is the existing engine’s refusal',
    );
  } finally {
    await clean(s);
  }
}

async function positionConflictAtTrigger() {
  const s = await fixture('general');
  try {
    await market(s, '100');
    const id = (await entries.create(s.userId, s.accountId, body(s))).data.entry
      .id;
    // A manual open after registration is allowed (nothing is reserved)...
    await app.futures.execute(s.userId, s.accountId, {
      instrumentId: s.instruments[0].instrument.id,
      operation: 'open',
      direction: 'short',
      quantity: '1',
      leverage: 5,
      idempotencyKey: randomUUID(),
    });
    const position = await db.futuresPosition.findFirstOrThrow({
      where: { tradingAccountId: s.accountId, status: 'open' },
    });
    // ...and the trigger then never increases, reduces or flips it.
    assert.equal(
      await triggerWith(s, id, '110'),
      'FUTURES_POSITION_ALREADY_OPEN',
    );
    assert.equal((await row(id)).status, 'failed');
    const unchanged = await db.futuresPosition.findUniqueOrThrow({
      where: { id: position.id },
    });
    assert.equal(unchanged.quantity.toFixed(8), position.quantity.toFixed(8));
    assert.equal(unchanged.direction, 'short');
    assert.equal(
      await db.futuresExecution.count({
        where: { tradingAccountId: s.accountId },
      }),
      1,
    );
    pass(
      'a position opened meanwhile makes the trigger fail clearly; the position is untouched',
    );
  } finally {
    await clean(s);
  }
}

async function evidence() {
  const s = await fixture('general');
  try {
    await market(s, '100');
    const id = (await entries.create(s.userId, s.accountId, body(s))).data.entry
      .id;
    const created = await row(id);
    // A late receipt of a trade that predates registration never triggers.
    const at = await now();
    await db.futuresLastPriceSnapshot.create({
      data: {
        instrumentId: s.instruments[0].instrument.id,
        symbol: s.instruments[0].asset.symbol,
        price: '150',
        source: 'binance_usdm_agg_trade_ws',
        effectiveAt: new Date(+created.createdAt - 1),
        capturedAt: at,
      },
    });
    assert.equal((await entries.evaluate(id)).state, 'awaiting_price');
    assert.equal((await row(id)).status, 'watching');
    pass('evidence of a trade before registration never triggers');

    // A meeting Last that went stale (receipt > 10 s) never triggers.
    await market(s, '120');
    const staleAt = (await now()).getTime() + 11_000;
    while ((await now()).getTime() < staleAt) await delay(250);
    assert.equal((await entries.evaluate(id)).state, 'price_unavailable');
    assert.equal((await row(id)).status, 'watching');
    pass('a stale Futures Last never triggers (price_unavailable)');

    // Transient execution refusal: triggered stays retryable inside the window.
    await staleMark(s, '120');
    for (let attempt = 0; ; attempt++) {
      await price(s, '120', 0, 0);
      const state = (await entries.evaluate(id)).state;
      if (state !== 'awaiting_price' || attempt >= 5) {
        assert.equal(state, 'FUTURES_MARK_STALE');
        break;
      }
      await delay(200);
    }
    const triggered = await row(id);
    assert.equal(triggered.status, 'triggered');
    assert.equal(triggered.attemptCount, 1);
    assert.equal(triggered.failureCode, 'FUTURES_MARK_STALE');
    assert.equal((await presented(s, id))?.state, 'triggered');
    // The in-transaction window guard refuses an expired trigger.
    await db.futuresConditionalEntry.update({
      where: { id },
      data: { triggeredAt: new Date(+(await now()) - 31_000) },
    });
    await market(s, '120');
    await reject(
      app.futures.execute(
        s.userId,
        s.accountId,
        {
          instrumentId: s.instruments[0].instrument.id,
          operation: 'open',
          direction: 'long',
          marginMode: 'isolated',
          quantity: '1',
          leverage: 10,
          idempotencyKey: `futures-conditional:${id}`,
        },
        undefined,
        undefined,
        id,
      ),
      'FUTURES_CONDITIONAL_ENTRY_EXECUTION_WINDOW_EXPIRED',
    );
    assert.equal((await entries.evaluate(id)).state, 'failed');
    const expired = await row(id);
    assert.equal(expired.terminalReason, 'execution_window_expired');
    assert.equal(expired.failureCode, 'FUTURES_MARK_STALE');
    assert.equal(
      await db.futuresExecution.count({
        where: { tradingAccountId: s.accountId },
      }),
      0,
    );
    pass(
      'a transient refusal retries; a trigger 30 s old never executes and keeps its root cause',
    );
  } finally {
    await clean(s);
  }
}

async function races() {
  // 1) Cancel first: cancel and the worker wait on the same account lock.
  const s = await fixture('general');
  try {
    await market(s, '100');
    const id = (await entries.create(s.userId, s.accountId, body(s))).data.entry
      .id;
    await staleMark(s, '110');
    for (let attempt = 0; ; attempt++) {
      await price(s, '110', 0, 0);
      const state = (await entries.evaluate(id)).state;
      if (state !== 'awaiting_price' || attempt >= 5) {
        assert.equal(state, 'FUTURES_MARK_STALE');
        break;
      }
      await delay(200);
    }
    assert.equal((await row(id)).status, 'triggered');
    await market(s, '110');
    const holder = await holdRowLock(
      (tx) =>
        tx.$queryRaw`SELECT id FROM trading_accounts WHERE id = ${s.accountId} FOR UPDATE`,
    );
    const canceled = entries.cancel(s.userId, s.accountId, id);
    await untilLockWaiting();
    const evaluated = entries.evaluate(id);
    await delay(100);
    await holder.release();
    assert.equal((await canceled).data.entry.state, 'canceled');
    assert.equal((await evaluated).state, 'terminal');
    assert.equal(
      await db.futuresExecution.count({
        where: { tradingAccountId: s.accountId },
      }),
      0,
    );
    await reject(
      app.futures.execute(
        s.userId,
        s.accountId,
        {
          instrumentId: s.instruments[0].instrument.id,
          operation: 'open',
          direction: 'long',
          marginMode: 'isolated',
          quantity: '1',
          leverage: 10,
          idempotencyKey: `futures-conditional:${id}`,
        },
        undefined,
        undefined,
        id,
      ),
      'FUTURES_CONDITIONAL_ENTRY_CHANGED',
    );
    pass('cancel committed first: the triggered entry never executes');
  } finally {
    await clean(s);
  }

  // 2) Execution first: it holds the account lock while it waits on the wallet.
  const t = await fixture('general');
  try {
    await market(t, '100');
    const id = (await entries.create(t.userId, t.accountId, body(t))).data.entry
      .id;
    const holder = await holdRowLock(
      (tx) =>
        tx.$queryRaw`SELECT id FROM cash_wallets WHERE id = ${t.futuresWalletId} FOR UPDATE`,
    );
    let evaluated!: Promise<string>;
    for (let attempt = 0; ; attempt++) {
      await market(t, '110');
      evaluated = entries.evaluate(id).then((r) => r.state);
      // Wait until the execution queues on the held wallet (or settles).
      const settled = await Promise.race([
        evaluated.then(() => true),
        untilLockWaiting().then(() => false),
      ]);
      if (!settled) break;
      assert.ok((await evaluated) === 'awaiting_price' && attempt < 5);
    }
    const canceled = entries.cancel(t.userId, t.accountId, id).then(
      () => 'canceled',
      (error: unknown) => code(error),
    );
    await delay(100);
    await holder.release();
    assert.equal(await evaluated, 'ordered');
    assert.equal(await canceled, 'FUTURES_CONDITIONAL_ENTRY_ALREADY_ORDERED');
    assert.equal(
      await db.futuresExecution.count({
        where: { tradingAccountId: t.accountId },
      }),
      1,
    );
    pass(
      'execution committed first: the late cancel sees ordered; one execution',
    );
  } finally {
    await clean(t);
  }

  // 3) Duplicate workers and evaluations: exactly one execution.
  const u = await fixture('general');
  try {
    await market(u, '100');
    const id = (await entries.create(u.userId, u.accountId, body(u))).data.entry
      .id;
    for (let attempt = 0; ; attempt++) {
      await market(u, '110');
      const states = await Promise.all([
        entries.evaluate(id),
        entries.evaluate(id),
        entries.evaluate(id),
      ]);
      if (states.every((r) => r.state === 'awaiting_price') && attempt < 5) {
        await delay(200);
        continue;
      }
      assert.equal(
        states.filter((r) => r.state === 'ordered').length >= 1,
        true,
      );
      break;
    }
    const [a, b] = await Promise.all([worker().tick(), worker().tick()]);
    assert.equal(a === undefined || b === undefined, true);
    assert.equal(
      await db.futuresExecution.count({
        where: { tradingAccountId: u.accountId },
      }),
      1,
    );
    assert.equal(
      await db.futuresExecuteRequest.count({
        where: { tradingAccountId: u.accountId },
      }),
      1,
    );
    pass(
      'concurrent evaluations and workers produce one execution and one command',
    );
  } finally {
    await clean(u);
  }
}

async function burst() {
  // 12 watches of one account, all met in one worker cycle.
  const s = await fixture('general', '100000');
  const extra: Awaited<ReturnType<typeof newInstrument>>[] = [];
  try {
    for (let i = 0; i < 10; i++) extra.push(await newInstrument());
    s.instruments.push(...extra);
    const ids: string[] = [];
    for (let index = 0; index < s.instruments.length; index++) {
      await market(s, '100', index);
      ids.push(
        (
          await entries.create(
            s.userId,
            s.accountId,
            body(s, {
              instrumentId: s.instruments[index].instrument.id,
              direction: index % 2 ? 'short' : 'long',
              triggerCondition: index % 2 ? 'at_or_below' : 'at_or_above',
              triggerPrice: index % 2 ? '95' : '105',
              marginMode: index % 3 ? 'isolated' : 'cross',
            }),
          )
        ).data.entry.id,
      );
    }
    for (let attempt = 0; attempt < 6; attempt++) {
      for (let index = 0; index < s.instruments.length; index++)
        await market(s, index % 2 ? '95' : '105', index);
      await worker().tick();
      const open = await db.futuresConditionalEntry.count({
        where: { id: { in: ids }, status: { in: ['watching', 'triggered'] } },
      });
      if (!open) break;
      await delay(200);
    }
    const rows = await db.futuresConditionalEntry.findMany({
      where: { id: { in: ids } },
    });
    assert.equal(rows.length, 12);
    assert.equal(
      rows.every((r) => r.status === 'ordered'),
      true,
    );
    assert.equal(
      await db.futuresPosition.count({
        where: { tradingAccountId: s.accountId, status: 'open' },
      }),
      12,
    );
    assert.equal(
      await db.futuresExecution.count({
        where: { tradingAccountId: s.accountId },
      }),
      12,
    );
    assert.equal(new Set(rows.map((r) => r.executionId)).size, 12);
    pass(
      '12 simultaneous triggers: one execution per entry, one position per instrument',
    );
  } finally {
    await clean(s);
  }
}

async function liveLimit() {
  const s = await fixture('general', '100000');
  try {
    for (let i = 0; i < 19; i++) s.instruments.push(await newInstrument());
    for (let index = 0; index < 20; index++) {
      await market(s, '100', index);
      await entries.create(
        s.userId,
        s.accountId,
        body(s, { instrumentId: s.instruments[index].instrument.id }),
      );
    }
    s.instruments.push(await newInstrument());
    await market(s, '100', 21);
    await reject(
      entries.create(
        s.userId,
        s.accountId,
        body(s, { instrumentId: s.instruments[21].instrument.id }),
      ),
      'FUTURES_CONDITIONAL_ENTRY_LIMIT_EXCEEDED',
    );
    pass('at most 20 live entries per account');
  } finally {
    await clean(s);
  }
}

async function lifecycle() {
  for (const boundary of [
    'general_inactive',
    'season_excluded',
    'season_ended',
  ] as const) {
    const s = await fixture(
      boundary === 'general_inactive' ? 'general' : 'season',
    );
    try {
      await market(s, '100');
      const id = (await entries.create(s.userId, s.accountId, body(s))).data
        .entry.id;
      if (boundary === 'general_inactive')
        await db.tradingAccount.update({
          where: { id: s.accountId },
          data: { status: 'suspended' },
        });
      else if (boundary === 'season_excluded')
        await db.seasonParticipant.update({
          where: { tradingAccountId: s.accountId },
          data: { participantStatus: 'excluded' },
        });
      else
        await db.season.update({
          where: { id: s.season!.id },
          data: { status: 'ended', endAt: new Date(+(await now()) - 1) },
        });
      // Lifecycle cleanup runs with the feature and trading switched off.
      process.env.FUTURES_CONDITIONAL_ENTRY_ENABLED = 'false';
      process.env.FUTURES_TRADING_MODE = 'DISABLED';
      assert.equal((await entries.evaluate(id)).state, 'lifecycle_canceled');
      const reason =
        boundary === 'general_inactive'
          ? 'account_not_tradable'
          : boundary === 'season_excluded'
            ? 'participant_excluded'
            : 'season_ended';
      assert.equal((await row(id)).terminalReason, reason);
      pass(
        `${boundary}: the worker ends the watch (${reason}) even while disabled`,
      );
    } finally {
      process.env.FUTURES_CONDITIONAL_ENTRY_ENABLED = 'true';
      process.env.FUTURES_TRADING_MODE = 'ENABLED';
      await clean(s);
    }
  }

  const s = await fixture('season');
  try {
    await market(s, '100');
    const id = (await entries.create(s.userId, s.accountId, body(s))).data.entry
      .id;
    const jobs = new SeasonSettlementJobService(
      new BatchService(db),
      db,
      new PortfolioValuationService(db),
    );
    const guard = jobs as unknown as {
      assertNoOpenLimitReservations(seasonId: string): Promise<void>;
    };
    await reject(
      guard.assertNoOpenLimitReservations(s.season!.id),
      'OPEN_LIMIT_ORDER_RESERVATIONS',
    );
    await db.season.update({
      where: { id: s.season!.id },
      data: { status: 'ended', endAt: new Date(+(await now()) - 1) },
    });
    await cancelService.cleanupEndedSeasonLimitReservations({
      now: await now(),
    });
    const ended = await row(id);
    assert.equal(ended.status, 'canceled');
    assert.equal(ended.terminalReason, 'season_ended');
    await guard.assertNoOpenLimitReservations(s.season!.id);
    pass(
      'Season settlement waits for live entries; the ended-Season sweep cancels them',
    );
  } finally {
    await clean(s);
  }
}

async function modes() {
  const s = await fixture('general');
  try {
    await market(s, '100');
    const id = (await entries.create(s.userId, s.accountId, body(s))).data.entry
      .id;
    for (const mode of ['REDUCE_ONLY', 'DISABLED'] as const) {
      process.env.FUTURES_TRADING_MODE = mode;
      await market(s, '120');
      assert.equal((await entries.evaluate(id)).state, 'paused');
      assert.equal((await row(id)).status, 'watching');
    }
    process.env.FUTURES_TRADING_MODE = 'ENABLED';
    process.env.FUTURES_CONDITIONAL_ENTRY_ENABLED = 'false';
    assert.equal((await entries.evaluate(id)).state, 'disabled');
    process.env.FUTURES_CONDITIONAL_ENTRY_ENABLED = 'true';
    pass('Reduce Only / Disabled pause watches; the flag stops new triggers');

    // Triggered, then the mode turns Reduce Only: the engine refuses.
    await staleMark(s, '120');
    for (let attempt = 0; ; attempt++) {
      await price(s, '120', 0, 0);
      const state = (await entries.evaluate(id)).state;
      if (state !== 'awaiting_price' || attempt >= 5) {
        assert.equal(state, 'FUTURES_MARK_STALE');
        break;
      }
      await delay(200);
    }
    process.env.FUTURES_TRADING_MODE = 'REDUCE_ONLY';
    await market(s, '120');
    assert.equal((await entries.evaluate(id)).state, 'FUTURES_REDUCE_ONLY');
    const failed = await row(id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureCode, 'FUTURES_REDUCE_ONLY');
    assert.equal(
      await db.futuresExecution.count({
        where: { tradingAccountId: s.accountId },
      }),
      0,
    );
    pass('a trigger under Reduce Only fails without opening a position');
  } finally {
    process.env.FUTURES_TRADING_MODE = 'ENABLED';
    process.env.FUTURES_CONDITIONAL_ENTRY_ENABLED = 'true';
    await clean(s);
  }
}

async function retention() {
  const s = await fixture('general');
  try {
    await market(s, '100');
    // Old, superseded receipts as retention selects them (evidence rows are
    // immutable, so they are inserted old): two referenced by an entry, one
    // unreferenced control that the same batch must delete.
    const old = async (days: number) => price(s, '100', 0, days * 86_400_000);
    const [registration, trigger, control] = [
      await old(30),
      await old(31),
      await old(32),
    ];
    const at = await now();
    await db.futuresConditionalEntry.create({
      data: {
        tradingAccountId: s.accountId,
        instrumentId: s.instruments[0].instrument.id,
        direction: 'long',
        marginMode: 'isolated',
        leverage: 10,
        quantity: '1',
        triggerCondition: 'at_or_above',
        triggerPrice: '110',
        executionType: 'market',
        status: 'canceled',
        registrationSnapshotId: registration.id,
        triggerSnapshotId: trigger.id,
        triggeredAt: at,
        terminalReason: 'user_canceled',
        idempotencyKey: `entry-${randomUUID()}`,
        requestHash: 'retention-fixture',
        endedAt: at,
      },
    });
    const service = new FuturesLastPriceRetentionService(db, locks, runs);
    await service.deleteBatch(new Date(+at - 86_400_000), 10_000);
    const remaining = await db.futuresLastPriceSnapshot.findMany({
      where: { id: { in: [registration.id, trigger.id, control.id] } },
      select: { id: true },
    });
    assert.deepEqual(
      remaining.map((r) => r.id).sort(),
      [registration.id, trigger.id].sort(),
    );
    pass(
      'Last retention keeps registration/trigger snapshots of entries and deletes the rest',
    );
  } finally {
    await clean(s);
  }
}

async function main() {
  await registration();
  await beginnerGate();
  for (const mode of ['general', 'season'] as const)
    for (const direction of ['long', 'short'] as const)
      await marketEntry(mode, direction);
  await limitEntry('long');
  await limitEntry('short');
  await limitCancelAfterOrder();
  await refusals();
  await positionConflictAtTrigger();
  await evidence();
  await races();
  await burst();
  await liveLimit();
  await lifecycle();
  await modes();
  await retention();
  console.log(`Futures conditional entry PostgreSQL PASS (${checks} checks)`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : code(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.fxRateSnapshot.deleteMany({
      where: { id: { in: fxEvidenceIds } },
    });
    await db.$disconnect();
  });
