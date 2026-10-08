import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { Prisma } from '../src/generated/prisma/client';
import {
  db,
  app,
  fixture,
  now,
  price,
  fxEvidence,
  fxEvidenceIds,
  cleanup,
  faultyDb,
  services,
  reject,
  code,
  type Scenario,
} from './futures-integration';
import { FuturesLimitService } from '../src/futures/futures-limit.service';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import { ConditionalService } from '../src/conditional/conditional.service';
import { LimitOrderCancelService } from '../src/orders/limit-order-cancel.service';
import { OrderReservationService } from '../src/orders/order-reservation.service';
import { OrdersService } from '../src/orders/orders.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { FuturesLimitWorker } from '../src/futures/futures-limit-worker.service';
import { OpsJobLockService } from '../src/ops/ops-job-lock.service';
import { OpsJobRunService } from '../src/ops/ops-job-run.service';
import { FuturesSeasonSettlementService } from '../src/futures/futures-season-settlement.service';

if (
  process.env.NODE_ENV !== 'test' ||
  process.env.FUTURES_LIMIT_DB_INTEGRATION !== '1'
)
  throw new Error('Explicit disposable Futures Limit DB opt-in required');
process.env.FUTURES_TRADING_MODE = 'ENABLED';
process.env.CONDITIONAL_ORDERS_ENABLED = 'true';
const access = new TradingAccountAccessService(db);
const entries = new FuturesLimitService(db, access, app.futures);
const cancel = new LimitOrderCancelService(db, new OrderReservationService());
const conditional = new ConditionalService(
  db,
  access,
  {} as OrdersService,
  cancel,
  app.futures,
);
let checks = 0;
const pass = (label: string) => {
  checks++;
  console.log(`PASS ${label}`);
};
async function fresh(s: Scenario, value = '100', index = 0) {
  await fxEvidence();
  await price(s, value, index, 0);
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
}
function body(s: Scenario, patch: Record<string, unknown> = {}) {
  return {
    instrumentId: s.instruments[0].instrument.id,
    direction: 'long',
    marginMode: 'isolated',
    quantity: '1',
    leverage: 37,
    limitPrice: '100',
    idempotencyKey: randomUUID(),
    ...patch,
  };
}
const wallet = (s: Scenario) =>
  db.cashWallet.findUniqueOrThrow({ where: { id: s.futuresWalletId } });
async function snapshot(s: Scenario) {
  const where = { tradingAccountId: s.accountId };
  return JSON.stringify({
    wallet: await wallet(s),
    positions: await db.futuresPosition.findMany({ where }),
    orders: await db.futuresLimitOrder.findMany({ where }),
    executions: await db.futuresExecution.findMany({ where }),
    ledger: await db.walletTransaction.findMany({ where }),
    participant: await db.seasonParticipant.findFirst({ where }),
    groups: await db.protectionGroup.findMany({
      where,
      include: {
        legs: { orderBy: { id: 'asc' } },
        children: { orderBy: { id: 'asc' } },
      },
    }),
  });
}
async function clean(s: Scenario) {
  const where = { tradingAccountId: s.accountId };
  const groups = await db.protectionGroup.findMany({
    where,
    select: { id: true },
  });
  const groupId = { in: groups.map((g) => g.id) };
  await db.protectionChild.deleteMany({ where: { groupId } });
  await db.protectionLeg.deleteMany({ where: { groupId } });
  await db.protectionCommand.deleteMany({ where });
  await db.protectionGroup.deleteMany({ where });
  await db.futuresSeasonClose.deleteMany({ where });
  await db.futuresSeasonSettlement.deleteMany({ where });
  if (s.season)
    await db.futuresSeasonPrice.deleteMany({
      where: { seasonId: s.season.id },
    });
  await cleanup(s);
}

async function entrySafety() {
  for (const boundary of [
    'general_inactive',
    'season_excluded',
    'season_ended',
  ] as const) {
    const s = await fixture(
      boundary === 'general_inactive' ? 'general' : 'season',
    );
    try {
      await fresh(s);
      const order = (
        await entries.create(
          s.userId,
          s.accountId,
          body(s, {
            attachedProtection: [
              {
                kind: 'take_profit',
                triggerPrice: '110',
                childOrderType: 'market',
              },
            ],
          }),
        )
      ).data.order;
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
      process.env.FUTURES_TRADING_MODE = 'DISABLED';
      assert.equal((await entries.evaluate(order.id)).state, 'canceled');
      const reason =
        boundary === 'general_inactive'
          ? 'account_not_tradable'
          : boundary === 'season_excluded'
            ? 'participant_excluded'
            : 'season_ended';
      assert.equal(
        (
          await db.futuresLimitOrder.findUniqueOrThrow({
            where: { id: order.id },
          })
        ).terminalReason,
        reason,
      );
      assert.equal(
        (
          await db.protectionGroup.findUniqueOrThrow({
            where: { parentFuturesOrderId: order.id },
          })
        ).terminalReason,
        reason,
      );
      assert.equal((await wallet(s)).reservedAmount.toFixed(8), '0.00000000');
      assert.equal(
        await db.futuresExecution.count({
          where: { tradingAccountId: s.accountId },
        }),
        0,
      );
      pass(
        `${boundary}: disabled worker cleanup preserves lifecycle reason and releases attached reservation once`,
      );
    } finally {
      process.env.FUTURES_TRADING_MODE = 'ENABLED';
      await clean(s);
    }
  }
  for (const kind of [
    'missing',
    'stale',
    'wrong_source',
    'before_entry',
    'mark_only',
    'missing_mark',
  ] as const) {
    const s = await fixture('general');
    try {
      await fresh(s);
      const a = await entries.create(s.userId, s.accountId, body(s));
      if (kind !== 'before_entry') {
        await db.assetPriceSnapshot.deleteMany({
          where: { assetId: s.instruments[0].asset.id },
        });
        if (kind === 'stale') await price(s, '99', 0, 11000);
        if (kind === 'wrong_source') {
          const wrong = await price(s, '99', 0, 0);
          await db.assetPriceSnapshot.update({
            where: { id: wrong.id },
            data: { sourceName: 'binance_usdm_mark_ws' },
          });
        }
        if (kind === 'mark_only') {
          await fresh(s, '99');
          await db.assetPriceSnapshot.deleteMany({
            where: { assetId: s.instruments[0].asset.id },
          });
          await price(s, '101', 0, 0);
        }
        if (kind === 'missing_mark') {
          await price(s, '99', 0, 0);
          await db.futuresMarkSnapshot.deleteMany({
            where: { instrumentId: s.instruments[0].instrument.id },
          });
        }
      }
      const before = await snapshot(s);
      await reject(
        entries.evaluate(a.data.order.id),
        kind === 'stale'
          ? 'FUTURES_PRICE_STALE'
          : kind === 'before_entry' || kind === 'mark_only'
            ? 'FUTURES_ENTRY_LIMIT_NOT_REACHED'
            : kind === 'missing_mark'
              ? 'FUTURES_MARK_UNAVAILABLE'
              : 'FUTURES_PRICE_UNAVAILABLE',
      );
      assert.equal(await snapshot(s), before);
      pass(
        `${kind}: no Position, ledger, fee, reservation release or fill-count mutation`,
      );
    } finally {
      await clean(s);
    }
  }
  for (const mode of ['general', 'season'] as const) {
    const s = await fixture(mode, '3');
    try {
      await fresh(s);
      await fresh(s, '100', 1);
      const intent = body(s);
      const created = await Promise.all([
        entries.create(s.userId, s.accountId, intent),
        entries.create(s.userId, s.accountId, intent),
      ]);
      assert.equal(created[0].data.order.id, created[1].data.order.id);
      const before = await snapshot(s);
      await reject(
        entries.create(s.userId, s.accountId, { ...intent, quantity: '2' }),
        'FUTURES_IDEMPOTENCY_CONFLICT',
      );
      await reject(
        app.transfer.transfer(s.userId, s.accountId, {
          sourceWalletId: s.futuresWalletId,
          destinationWalletId: s.spotWalletId,
          amount: '1',
          idempotencyKey: randomUUID(),
        }),
        'INSUFFICIENT_FUTURES_FREE_COLLATERAL',
      );
      await reject(
        entries.create(
          s.userId,
          s.accountId,
          body(s, { instrumentId: s.instruments[1].instrument.id }),
        ),
        'INSUFFICIENT_FUTURES_FREE_COLLATERAL',
      );
      assert.equal(await snapshot(s), before);
      const read = (await app.futures.positions(s.userId, s.accountId)).data;
      assert.equal(read.positions.length, 0);
      assert.equal(read.cross.positionIds.length, 0);
      for (const paused of ['REDUCE_ONLY', 'DISABLED']) {
        process.env.FUTURES_TRADING_MODE = paused;
        assert.equal(
          (await entries.create(s.userId, s.accountId, intent)).data.order.id,
          created[0].data.order.id,
        );
      }
      await entries.cancel(s.userId, s.accountId, created[0].data.order.id);
      const canceled = await snapshot(s);
      assert.equal(
        (await entries.evaluate(created[0].data.order.id)).state,
        'terminal',
      );
      assert.equal(await snapshot(s), canceled);
      pass(
        `${mode}: concurrent create/replay/conflict, reserved collateral cannot transfer/reuse, pending is not risk Position, disabled cancel`,
      );
    } finally {
      process.env.FUTURES_TRADING_MODE = 'ENABLED';
      await clean(s);
    }
  }
  const a = await fixture('general'),
    b = await fixture('general');
  try {
    await fresh(a);
    await fresh(b);
    const order = (await entries.create(a.userId, a.accountId, body(a))).data
      .order;
    const before = await snapshot(a),
      other = await snapshot(b);
    await assert.rejects(entries.read(b.userId, a.accountId, {}));
    await reject(
      entries.cancel(b.userId, b.accountId, order.id),
      'FUTURES_ENTRY_NOT_FOUND',
    );
    await assert.rejects(entries.cancel(b.userId, a.accountId, order.id));
    await assert.rejects(entries.create(b.userId, a.accountId, body(a)));
    assert.equal(await snapshot(a), before);
    assert.equal(await snapshot(b), other);
    assert.equal(
      (await entries.read(b.userId, b.accountId, {})).data.orders.length,
      0,
    );
    pass('read/create/cancel isolate foreign user and account');
  } finally {
    await clean(a);
    await clean(b);
  }

  for (const leverage of [1, 100]) {
    const s = await fixture('general');
    try {
      await fresh(s);
      for (const invalid of [0, 101, 1.5])
        await assert.rejects(
          entries.create(s.userId, s.accountId, body(s, { leverage: invalid })),
        );
      for (const legs of [
        [{ kind: 'stop_loss', triggerPrice: '100', childOrderType: 'market' }],
        [
          {
            kind: 'take_profit',
            triggerPrice: '101',
            childOrderType: 'market',
          },
        ],
      ])
        await assert.rejects(
          entries.create(
            s.userId,
            s.accountId,
            body(s, { direction: 'short', attachedProtection: legs }),
          ),
        );
      const order = (
        await entries.create(
          s.userId,
          s.accountId,
          body(s, {
            direction: 'short',
            leverage,
            attachedProtection: [
              {
                kind: 'stop_loss',
                triggerPrice: '101',
                childOrderType: 'limit',
                childLimitPrice: '99',
              },
              {
                kind: 'take_profit',
                triggerPrice: '99',
                childOrderType: 'market',
              },
            ],
          }),
        )
      ).data.order;
      const group = await db.protectionGroup.findUniqueOrThrow({
        where: { parentFuturesOrderId: order.id },
      });
      await fresh(s, '102');
      assert.equal((await conditional.evaluate(group.id)).state, 'holding');
      await entries.evaluate(order.id);
      await reject(
        conditional.evaluate(group.id),
        'CONDITIONAL_LIMIT_NOT_REACHED',
      );
      await fresh(s, '98');
      await conditional.evaluate(group.id);
      assert.equal(
        (
          await db.protectionGroup.findUniqueOrThrow({
            where: { id: group.id },
          })
        ).status,
        'completed',
      );
      const executions = await db.futuresExecution.findMany({
        where: { tradingAccountId: s.accountId },
        orderBy: { executedAt: 'asc' },
      });
      assert.equal(executions.length, 2);
      assert.equal(executions[0].executionPrice.toFixed(8), '102.00000000');
      pass(
        `Short ${leverage}x: validation, HOLDING cannot trigger, favorable fill and fill-wins OCO`,
      );
    } finally {
      await clean(s);
    }
  }
  const s = await fixture('season');
  try {
    await fresh(s);
    const order = (await entries.create(s.userId, s.accountId, body(s))).data
      .order;
    await fresh(s);
    const locks = new OpsJobLockService(db),
      runs = new OpsJobRunService(db);
    const worker = () => new FuturesLimitWorker(db, locks, runs, entries);
    await Promise.all([worker().tick(), worker().tick()]);
    assert.equal(
      (
        await db.futuresLimitOrder.findUniqueOrThrow({
          where: { id: order.id },
        })
      ).status,
      'executed',
    );
    assert.equal(
      await db.futuresExecution.count({
        where: { tradingAccountId: s.accountId },
      }),
      1,
    );
    assert.equal(
      (
        await db.seasonParticipant.findUniqueOrThrow({
          where: { tradingAccountId: s.accountId },
        })
      ).totalFillCount,
      1,
    );
    assert.equal((await wallet(s)).reservedAmount.toFixed(8), '0.00000000');
    pass(
      'duplicate real Ops workers: one entry fill and one Season fill count',
    );
  } finally {
    await db.opsJobRun.deleteMany({
      where: { jobName: 'futures_limit_matching' },
    });
    await db.opsJobLock.deleteMany({
      where: { jobName: 'futures_limit_matching' },
    });
    await clean(s);
  }
}

// Pause only after a real PostgreSQL wallet lock. The competing request must
// demonstrably wait on a DB lock before the winner is released.
function pausedWallet() {
  let reached!: () => void, release!: () => void;
  const held = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let once = false;
  const prisma = new Proxy(db, {
    get(target, key) {
      if (key === '$transaction')
        return (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          target.$transaction(async (tx) =>
            work(
              new Proxy(tx, {
                get(client, prop) {
                  const value = Reflect.get(client, prop);
                  if (prop === '$queryRaw')
                    return async (...args: unknown[]) => {
                      const result = await value.apply(client, args);
                      if (
                        !once &&
                        String(args[0]).includes('crypto_futures') &&
                        String(args[0]).includes('FOR UPDATE')
                      ) {
                        once = true;
                        reached();
                        await gate;
                      }
                      return result;
                    };
                  return typeof value === 'function'
                    ? value.bind(client)
                    : value;
                },
              }),
            ),
          );
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { prisma, held, release };
}
async function waitForLock(client: Client) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await client.query('SELECT pg_stat_clear_snapshot()');
    const row = await client.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'",
    );
    if (row.rows[0].n > 0) return;
    await delay(10);
  }
  assert.fail('competing financial transaction did not reach the lock barrier');
}
async function entryRaces() {
  for (const boundary of ['REDUCE_ONLY', 'DISABLED', 'endAt'] as const) {
    const s = await fixture('season'),
      fence = pausedWallet();
    let pending: Promise<unknown> | undefined;
    try {
      await fresh(s);
      const order = (await entries.create(s.userId, s.accountId, body(s))).data
        .order;
      if (boundary === 'endAt')
        await db.season.update({
          where: { id: s.season!.id },
          data: { endAt: new Date(+(await now()) + 500) },
        });
      await fresh(s);
      const before = await snapshot(s);
      pending = new FuturesLimitService(
        db,
        access,
        services(fence.prisma).futures,
      ).evaluate(order.id);
      void pending.catch(() => undefined);
      await Promise.race([
        fence.held,
        delay(3000).then(() => {
          throw new Error('fill did not reach wallet fence');
        }),
      ]);
      if (boundary === 'endAt') {
        const endAt = (
          await db.season.findUniqueOrThrow({ where: { id: s.season!.id } })
        ).endAt;
        const deadline = Date.now() + 3000;
        while ((await now()) < endAt) {
          assert.ok(Date.now() < deadline, 'DB time did not cross endAt');
          await delay(10);
        }
      } else process.env.FUTURES_TRADING_MODE = boundary;
      fence.release();
      await reject(
        pending,
        boundary === 'endAt'
          ? 'SEASON_ENDED'
          : boundary === 'DISABLED'
            ? 'FUTURES_TRADING_DISABLED'
            : 'FUTURES_REDUCE_ONLY',
      );
      assert.equal(await snapshot(s), before);
      if (boundary === 'endAt') {
        assert.equal((await entries.evaluate(order.id)).state, 'canceled');
        assert.equal(
          (
            await db.futuresLimitOrder.findUniqueOrThrow({
              where: { id: order.id },
            })
          ).terminalReason,
          'season_ended',
        );
        assert.equal((await wallet(s)).reservedAmount.toFixed(8), '0.00000000');
      }
      pass(
        `post-wallet-lock ${boundary}: no entry fill after authoritative boundary`,
      );
    } finally {
      fence.release();
      await pending?.catch(() => undefined);
      process.env.FUTURES_TRADING_MODE = 'ENABLED';
      await clean(s);
    }
  }
  for (const mode of ['general', 'season'] as const)
    for (const winner of ['fill', 'cancel'] as const) {
      const s = await fixture(mode),
        observer = new Client({ connectionString: process.env.DATABASE_URL }),
        fence = pausedWallet();
      const pending: Promise<unknown>[] = [];
      try {
        await observer.connect();
        await fresh(s);
        const order = (
          await entries.create(
            s.userId,
            s.accountId,
            body(s, {
              attachedProtection: [
                {
                  kind: 'take_profit',
                  triggerPrice: '110',
                  childOrderType: 'market',
                },
              ],
            }),
          )
        ).data.order;
        await fresh(s);
        const service = new FuturesLimitService(
          winner === 'cancel' ? fence.prisma : db,
          access,
          services(fence.prisma).futures,
        );
        pending.push(
          winner === 'fill'
            ? service.evaluate(order.id)
            : service.cancel(s.userId, s.accountId, order.id),
        );
        void pending[0].catch(() => undefined);
        await Promise.race([
          fence.held,
          delay(3000).then(() => {
            throw new Error('winner did not reach wallet fence');
          }),
        ]);
        pending.push(
          winner === 'fill'
            ? entries.cancel(s.userId, s.accountId, order.id)
            : entries.evaluate(order.id),
        );
        void pending[1].catch(() => undefined);
        await waitForLock(observer);
        fence.release();
        const results = await Promise.allSettled(pending);
        assert.equal(results[0].status, 'fulfilled');
        if (results[1].status === 'rejected')
          assert.equal(code(results[1].reason), 'FUTURES_ENTRY_NOT_PENDING');
        assert.equal(
          (
            await db.futuresLimitOrder.findUniqueOrThrow({
              where: { id: order.id },
            })
          ).status,
          winner === 'fill' ? 'executed' : 'canceled',
        );
        assert.equal(
          await db.futuresExecution.count({
            where: { tradingAccountId: s.accountId },
          }),
          winner === 'fill' ? 1 : 0,
        );
        assert.equal((await wallet(s)).reservedAmount.toFixed(8), '0.00000000');
        if (s.season)
          assert.equal(
            (
              await db.seasonParticipant.findUniqueOrThrow({
                where: { tradingAccountId: s.accountId },
              })
            ).totalFillCount,
            winner === 'fill' ? 1 : 0,
          );
        assert.equal(
          (
            await db.protectionGroup.findUniqueOrThrow({
              where: { parentFuturesOrderId: order.id },
            })
          ).status,
          winner === 'fill' ? 'active' : 'canceled',
        );
        pass(
          `${mode} real lock race: ${winner} wins; one financial outcome and attached lifecycle`,
        );
      } finally {
        fence.release();
        await Promise.allSettled(pending);
        await observer.end();
        await clean(s);
      }
    }
  for (const winner of ['fill', 'season'] as const) {
    const s = await fixture('season'),
      observer = new Client({ connectionString: process.env.DATABASE_URL }),
      fence = pausedWallet();
    const pending: Promise<unknown>[] = [];
    try {
      await observer.connect();
      await fresh(s);
      const order = (
        await entries.create(
          s.userId,
          s.accountId,
          body(s, {
            attachedProtection: [
              {
                kind: 'take_profit',
                triggerPrice: '110',
                childOrderType: 'market',
              },
            ],
          }),
        )
      ).data.order;
      await fresh(s);
      if (winner === 'season') {
        await observer.query('BEGIN');
        await observer.query(
          "UPDATE seasons SET end_at=clock_timestamp(),status='ended' WHERE id=$1",
          [s.season!.id],
        );
        pending.push(entries.evaluate(order.id));
        void pending[0].catch(() => undefined);
        await waitForLock(observer);
        await observer.query('COMMIT');
      } else {
        pending.push(
          new FuturesLimitService(
            db,
            access,
            services(fence.prisma).futures,
          ).evaluate(order.id),
        );
        void pending[0].catch(() => undefined);
        await Promise.race([
          fence.held,
          delay(3000).then(() => {
            throw new Error('fill did not reach wallet fence');
          }),
        ]);
        pending.push(
          db.$executeRaw`UPDATE seasons SET end_at=clock_timestamp(),status='ended' WHERE id=${s.season!.id}`,
        );
        void pending[1].catch(() => undefined);
        await waitForLock(observer);
        fence.release();
      }
      await Promise.all(pending);
      await cancel.cleanupEndedSeasonLimitReservations({ now: await now() });
      const before = await snapshot(s);
      await entries.evaluate(order.id);
      assert.equal(await snapshot(s), before);
      assert.equal(
        (
          await db.futuresLimitOrder.findUniqueOrThrow({
            where: { id: order.id },
          })
        ).status,
        winner === 'fill' ? 'executed' : 'canceled',
      );
      assert.equal((await wallet(s)).reservedAmount.toFixed(8), '0.00000000');
      assert.equal(
        (
          await db.seasonParticipant.findUniqueOrThrow({
            where: { tradingAccountId: s.accountId },
          })
        ).totalFillCount,
        winner === 'fill' ? 1 : 0,
      );
      await new FuturesSeasonSettlementService(db).settleSeason(s.season!.id);
      assert.equal(
        await db.futuresPosition.count({
          where: { tradingAccountId: s.accountId, status: 'open' },
        }),
        0,
      );
      assert.equal(
        await db.protectionGroup.count({
          where: {
            tradingAccountId: s.accountId,
            status: { in: ['holding', 'active'] },
          },
        }),
        0,
      );
      assert.equal((await wallet(s)).balanceAmount.gte(0), true);
      pass(
        `real Season lock race: ${winner} wins, reservations cleaned before final settlement, no late fill`,
      );
    } finally {
      fence.release();
      await observer.query('ROLLBACK').catch(() => undefined);
      await Promise.allSettled(pending);
      await observer.end();
      await clean(s);
    }
  }
}
async function run() {
  for (const mode of ['general', 'season'] as const)
    for (const direction of ['long', 'short'] as const)
      for (const marginMode of ['isolated', 'cross'] as const) {
        const s = await fixture(mode);
        try {
          await fresh(s);
          const intent = body(s, { direction, marginMode });
          const a = await entries.create(s.userId, s.accountId, intent),
            id = a.data.order.id;
          assert.equal(
            (await entries.create(s.userId, s.accountId, intent)).data.order.id,
            id,
          );
          const reserved = await wallet(s);
          assert.equal(reserved.balanceAmount.toFixed(8), '10000.00000000');
          assert.equal(
            reserved.reservedAmount.toFixed(8),
            mode === 'general' ? '2.80270271' : '2.90270271',
          );
          assert.equal(
            await db.futuresPosition.count({
              where: { tradingAccountId: s.accountId },
            }),
            0,
          );
          await reject(
            entries.create(s.userId, s.accountId, body(s)),
            'FUTURES_ENTRY_PENDING',
          );
          await reject(
            app.futures.execute(s.userId, s.accountId, {
              ...intent,
              operation: 'open',
              limitPrice: undefined,
            } as never),
            'INVALID_FUTURES_COMMAND',
          );
          const { limitPrice: ignored, ...market } = intent;
          void ignored;
          await reject(
            app.futures.execute(s.userId, s.accountId, {
              ...market,
              operation: 'open',
            }),
            'FUTURES_ENTRY_PENDING',
          );
          await fresh(s, direction === 'long' ? '101' : '99');
          const before = await snapshot(s);
          await reject(entries.evaluate(id), 'FUTURES_ENTRY_LIMIT_NOT_REACHED');
          assert.equal(await snapshot(s), before);
          for (const tradingMode of ['REDUCE_ONLY', 'DISABLED']) {
            process.env.FUTURES_TRADING_MODE = tradingMode;
            assert.equal((await entries.evaluate(id)).state, 'paused');
            await assert.rejects(
              entries.create(s.userId, s.accountId, body(s)),
            );
          }
          process.env.FUTURES_TRADING_MODE = 'ENABLED';
          await fresh(s);
          const race = await Promise.all([
            entries.evaluate(id),
            entries.evaluate(id),
          ]);
          assert.equal(race.length, 2);
          const executed = await db.futuresLimitOrder.findUniqueOrThrow({
            where: { id },
          });
          assert.equal(executed.status, 'executed');
          assert.equal(
            (await wallet(s)).reservedAmount.toFixed(8),
            '0.00000000',
          );
          assert.equal(
            await db.futuresExecution.count({
              where: { tradingAccountId: s.accountId },
            }),
            1,
          );
          if (mode === 'season')
            assert.equal(
              (
                await db.seasonParticipant.findUniqueOrThrow({
                  where: { tradingAccountId: s.accountId },
                })
              ).totalFillCount,
              1,
            );
          const after = await snapshot(s);
          await entries.cancel(s.userId, s.accountId, id);
          await entries.evaluate(id);
          assert.equal(await snapshot(s), after);
          pass(
            `${mode}/${direction}/${marginMode} reservation, equality fill, duplicate/replay, modes, fill count`,
          );
        } finally {
          process.env.FUTURES_TRADING_MODE = 'ENABLED';
          await clean(s);
        }
      }
  for (const mode of ['general', 'season'] as const) {
    const s = await fixture(mode);
    try {
      await fresh(s);
      const legs = [
        {
          kind: 'stop_loss',
          triggerPrice: '99',
          childOrderType: 'limit',
          childLimitPrice: '101',
        },
        { kind: 'take_profit', triggerPrice: '101', childOrderType: 'market' },
      ];
      const before = await snapshot(s);
      await assert.rejects(
        entries.create(
          s.userId,
          s.accountId,
          body(s, {
            attachedProtection: [{ ...legs[0], triggerPrice: '100' }],
          }),
        ),
      );
      assert.equal(await snapshot(s), before);
      const a = await entries.create(
        s.userId,
        s.accountId,
        body(s, { attachedProtection: legs }),
      );
      const group = await db.protectionGroup.findUniqueOrThrow({
        where: { parentFuturesOrderId: a.data.order.id },
      });
      assert.equal(group.status, 'holding');
      assert.equal((await conditional.evaluate(group.id)).state, 'holding');
      await fresh(s, '98'); // Gap crosses SL: entry still commits unchanged protection.
      await entries.evaluate(a.data.order.id);
      const active = await db.protectionGroup.findUniqueOrThrow({
        where: { id: group.id },
        include: { legs: true },
      });
      assert.equal(active.status, 'active');
      assert.ok(active.futuresPositionId);
      assert.equal(
        active.legs
          .find((l) => l.kind === 'stop_loss')!
          .triggerPrice.toFixed(8),
        '99.00000000',
      );
      // Trigger commits the Limit child; the normal execution primitive reports
      // that 98 cannot fill the requested sell limit of 101. OCO stays live.
      await reject(
        conditional.evaluate(group.id),
        'CONDITIONAL_LIMIT_NOT_REACHED',
      );
      assert.equal(
        await db.protectionChild.count({
          where: { groupId: group.id, status: 'pending' },
        }),
        1,
      );
      await fresh(s, '102');
      await conditional.evaluate(group.id);
      assert.equal(
        (
          await db.futuresPosition.findUniqueOrThrow({
            where: { id: active.futuresPositionId! },
          })
        ).status,
        'closed',
      );
      assert.equal(
        (
          await db.protectionGroup.findUniqueOrThrow({
            where: { id: group.id },
          })
        ).status,
        'completed',
      );
      pass(
        `${mode} attached holding, entry-limit equality rejection, gap fill, Limit child, sibling replacement and actual OCO close`,
      );
    } finally {
      await clean(s);
    }
  }
  for (const point of [
    'debit-1',
    'debit-2',
    'futuresPosition.create',
    'futuresExecution.create',
    'walletTransaction.createMany',
    'futuresLimitOrder.update',
    'protectionGroup.updateMany',
    'equitySnapshot.create',
  ]) {
    const s = await fixture('general');
    try {
      await fresh(s);
      const a = await entries.create(
        s.userId,
        s.accountId,
        body(s, {
          attachedProtection: [
            {
              kind: 'take_profit',
              triggerPrice: '110',
              childOrderType: 'market',
            },
          ],
        }),
      );
      await fresh(s);
      const before = await snapshot(s),
        broken = faultyDb(point);
      const service = new FuturesLimitService(
        broken,
        new TradingAccountAccessService(broken),
        services(broken).futures,
      );
      await assert.rejects(
        service.evaluate(a.data.order.id),
        new RegExp(point.replace('.', '\\.')),
      );
      assert.equal(await snapshot(s), before);
      pass(`atomic rollback ${point}`);
    } finally {
      await clean(s);
    }
  }
  for (const mode of ['general', 'season'] as const) {
    const s = await fixture(mode);
    try {
      await fresh(s);
      const a = await entries.create(
        s.userId,
        s.accountId,
        body(s, {
          attachedProtection: [
            { kind: 'stop_loss', triggerPrice: '90', childOrderType: 'market' },
          ],
        }),
      );
      process.env.FUTURES_TRADING_MODE = 'DISABLED';
      await Promise.all([
        entries.cancel(s.userId, s.accountId, a.data.order.id),
        entries.cancel(s.userId, s.accountId, a.data.order.id),
      ]);
      assert.equal((await wallet(s)).reservedAmount.toFixed(8), '0.00000000');
      assert.equal(
        (
          await db.protectionGroup.findUniqueOrThrow({
            where: { parentFuturesOrderId: a.data.order.id },
          })
        ).status,
        'canceled',
      );
      process.env.FUTURES_TRADING_MODE = 'ENABLED';
      if (s.season) {
        await fresh(s);
        const b = await entries.create(s.userId, s.accountId, body(s));
        await db.season.update({
          where: { id: s.season.id },
          data: {
            endAt: new Date((await now()).getTime() - 1),
            status: 'ended',
          },
        });
        await cancel.cleanupEndedSeasonLimitReservations({ now: await now() });
        assert.equal(
          (
            await db.futuresLimitOrder.findUniqueOrThrow({
              where: { id: b.data.order.id },
            })
          ).status,
          'canceled',
        );
        assert.equal((await wallet(s)).reservedAmount.toFixed(8), '0.00000000');
      }
      pass(
        `${mode} disabled cancel/replay, holding cancellation and unattached Season cleanup`,
      );
    } finally {
      process.env.FUTURES_TRADING_MODE = 'ENABLED';
      await clean(s);
    }
  }
  const s = await fixture('general', '3');
  try {
    await fresh(s);
    const a = await entries.create(
      s.userId,
      s.accountId,
      body(s, { direction: 'short' }),
    );
    await fresh(s, '200'); // Favorable Short entry, but higher absolute initial margin.
    const before = await snapshot(s);
    await reject(
      entries.evaluate(a.data.order.id),
      'INSUFFICIENT_FUTURES_FREE_COLLATERAL',
    );
    assert.equal(await snapshot(s), before);
    await db.cashWallet.update({
      where: { id: s.futuresWalletId },
      data: { balanceAmount: '10000' },
    });
    await fresh(s, '200');
    await entries.evaluate(a.data.order.id);
    assert.equal(
      (
        await db.futuresExecution.findFirstOrThrow({
          where: { tradingAccountId: s.accountId },
        })
      ).executionPrice.toFixed(8),
      '200.00000000',
    );
    pass(
      'Short improvement additional collateral: insufficient rollback then funded full fill',
    );
  } finally {
    await clean(s);
  }
  await entrySafety();
  await entryRaces();
  console.log(`Futures Limit PostgreSQL PASS ${checks} checks`);
}
run()
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
