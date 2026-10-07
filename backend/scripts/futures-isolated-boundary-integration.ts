import assert from 'node:assert/strict';
import { Client } from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import { FuturesLiquidationService } from '../src/futures/futures-liquidation.service';
import { parseFuturesCommand } from '../src/futures/futures-input';
import {
  futuresDecimal as d,
  planFuturesExecution,
} from '../src/futures/futures-math';
import {
  db,
  app,
  fixture,
  now,
  price,
  openBody,
  state as readState,
  cleanup,
  reject,
  invariant,
  services,
  faultyDb,
  type Scenario,
} from './futures-integration';
import type {
  FuturesPosition,
  TradingAccountMode,
} from '../src/generated/prisma/client';

assert.equal(process.env.FUTURES_RISK_DB_INTEGRATION, '1');
process.env.FUTURES_TRADING_MODE = 'ENABLED';
process.env.FUTURES_RISK_ENGINE_ENABLED = 'true';
let checks = 0;
const state = async (s: Scenario) =>
  (await readState(s)) as {
    wallets: Array<{ id: string; balanceAmount: string }>;
    positions: Array<{ id: string }>;
    commands: unknown[];
    executions: unknown[];
  };
const liquidator = new FuturesLiquidationService(db);
async function mark(s: Scenario, value = '100', index = 0) {
  const at = await now();
  const row = s.instruments[index];
  await db.futuresMarkSnapshot.createMany({
    data: [
      {
        instrumentId: row.instrument.id,
        symbol: row.asset.symbol,
        source: 'binance_usdm_mark_ws',
        price: value,
        effectiveAt: at,
        capturedAt: at,
      },
    ],
    skipDuplicates: true,
  });
}
async function setup(
  mode: TradingAccountMode,
  leverage: number,
  mixed: boolean,
  partial: boolean,
  direction: 'short' | 'long' = 'short',
) {
  const s = await fixture(mode, '1000000');
  await mark(s);
  const opened = await app.futures.execute(
    s.userId,
    s.accountId,
    openBody(s, { leverage, direction, quantity: partial ? '2' : '1' }),
  );
  if (mixed) {
    await price(s, '100', 1);
    await mark(s, '100', 1);
    await app.futures.execute(
      s.userId,
      s.accountId,
      openBody(s, {
        instrumentId: s.instruments[1].instrument.id,
        marginMode: 'cross',
        leverage: 37,
      }),
    );
  }
  return {
    s,
    p: await db.futuresPosition.findUniqueOrThrow({
      where: { id: opened.data.position.id },
    }),
  };
}
function body(s: Scenario, p: FuturesPosition, partial: boolean) {
  return openBody(s, {
    positionId: p.id,
    leverage: p.leverage,
    direction: p.direction,
    operation: partial ? 'reduce' : 'close',
    quantity: '1',
  });
}
function fee(s: Scenario) {
  return d(s.mode === 'general' ? '0.001' : '0.002');
}
function boundaryPrice(
  s: Scenario,
  p: FuturesPosition,
  partial: boolean,
  offset: string,
) {
  const command = parseFuturesCommand(body(s, p, partial));
  const initial = planFuturesExecution(command, p, d('100'), fee(s));
  const released = d(p.isolatedMargin).sub(initial.isolatedMargin);
  const target = released.add(offset);
  // Short cash debit = price - entry + rounded(price * fee). Only the production
  // plan decides cash rounding; search nearby cash quanta for exact fixtures.
  const approximate = d(p.averageEntryPrice)
    .add(target)
    .div(d('1').add(fee(s)))
    .toDecimalPlaces(8);
  for (let q = -5; q <= 5; q++) {
    const candidate = approximate.add(d('0.00000001').mul(q));
    const plan = planFuturesExecution(command, p, candidate, fee(s));
    if (plan.feeAmount.sub(plan.realizedPnl).eq(target))
      return { candidate, plan, released };
  }
  throw new Error('Exact boundary fixture is not representable.');
}
async function boundaries() {
  for (const mode of ['general', 'season'] as const)
    for (const leverage of [1, 37, 100])
      for (const mixed of [false, true])
        for (const partial of [true, false])
          for (const offset of ['-0.00000001', '0', '0.00000001']) {
            const { s, p } = await setup(mode, leverage, mixed, partial);
            try {
              const { candidate, plan, released } = boundaryPrice(
                s,
                p,
                partial,
                offset,
              );
              await price(s, candidate.toFixed(8));
              const before = await state(s),
                command = body(s, p, partial);
              assert.equal(
                plan.feeAmount.sub(plan.realizedPnl).sub(released).toFixed(8),
                d(offset).toFixed(8),
              );
              if (offset === '0.00000001') {
                await reject(
                  app.futures.execute(s.userId, s.accountId, command),
                  'FUTURES_LIQUIDATION_REQUIRED',
                );
                assert.deepEqual(await state(s), before);
                await reject(
                  app.futures.execute(s.userId, s.accountId, command),
                  'FUTURES_LIQUIDATION_REQUIRED',
                );
                assert.deepEqual(await state(s), before);
              } else {
                const result = await app.futures.execute(
                  s.userId,
                  s.accountId,
                  command,
                );
                assert.equal(
                  result.data.position.isolatedMargin,
                  plan.isolatedMargin.toFixed(8),
                );
                assert.equal(
                  result.data.execution.realizedPnl,
                  plan.realizedPnl.toFixed(8),
                );
                assert.equal(
                  result.data.execution.feeAmount,
                  plan.feeAmount.toFixed(8),
                );
                const after = await state(s);
                const beforeWallet = before.wallets.find(
                  (w: { id: string }) => w.id === s.futuresWalletId,
                );
                assert.ok(beforeWallet);
                assert.equal(
                  result.data.collateral.balanceAmount,
                  d(beforeWallet.balanceAmount)
                    .add(plan.realizedPnl)
                    .sub(plan.feeAmount)
                    .toFixed(8),
                );
                assert.deepEqual(
                  await app.futures.execute(s.userId, s.accountId, command),
                  result,
                );
                assert.deepEqual(await state(s), after);
                if (mixed)
                  assert.deepEqual(
                    after.positions.filter(
                      (row: { id: string }) => row.id !== p.id,
                    ),
                    before.positions.filter(
                      (row: { id: string }) => row.id !== p.id,
                    ),
                  );
              }
              await invariant(s);
              checks++;
            } finally {
              await cleanup(s);
            }
          }
  console.log(
    'PASS F2.1 General/Season, 1/37/100x, partial/full, Cross parity and exact +/- cash quantum matrix (72 cases)',
  );
  for (const mode of ['general', 'season'] as const)
    for (const partial of [true, false])
      for (const exit of ['90', '101']) {
        const { s, p } = await setup(mode, 37, false, partial);
        try {
          await price(s, exit);
          const plan = planFuturesExecution(
            parseFuturesCommand(body(s, p, partial)),
            p,
            d(exit),
            fee(s),
          );
          assert.ok(
            plan.feeAmount
              .sub(plan.realizedPnl)
              .lt(d(p.isolatedMargin).sub(plan.isolatedMargin)),
          );
          const result = await app.futures.execute(
            s.userId,
            s.accountId,
            body(s, p, partial),
          );
          assert.equal(
            result.data.execution.realizedPnl,
            plan.realizedPnl.toFixed(8),
          );
          await invariant(s);
          checks++;
        } finally {
          await cleanup(s);
        }
      }
}
async function rollback() {
  for (const mode of ['general', 'season'] as const) {
    const { s, p } = await setup(mode, 1, false, true);
    try {
      for (const [exit, points] of [
        ['90', ['cashWallet.updateMany', 'debit-1']],
        ['101', ['debit-1', 'debit-2']],
      ] as const) {
        await price(s, exit);
        for (const point of [
          ...points,
          'futuresPosition.update',
          'futuresExecution.create',
          'walletTransaction.createMany',
          'futuresExecuteRequest.create',
        ]) {
          const before = await state(s);
          await assert.rejects(
            services(faultyDb(point)).futures.execute(
              s.userId,
              s.accountId,
              body(s, p, true),
            ),
            new RegExp(point),
          );
          assert.deepEqual(await state(s), before);
          checks++;
        }
      }
      // The first write is PnL settlement; injecting immediately before it verifies
      // the post-guard/no-write seam without a new production failure hook.
      const before = await state(s);
      const failing = services(
        new Proxy(db, {
          get(target, key) {
            if (key === '$transaction')
              return (work: Parameters<typeof db.$transaction>[0]) =>
                target.$transaction(async (tx) => {
                  const wrapped = new Proxy(tx, {
                    get(client, prop) {
                      if (prop === '$executeRaw')
                        return () => {
                          throw new Error('after-collateral-guard');
                        };
                      const value = Reflect.get(client, prop);
                      return typeof value === 'function'
                        ? value.bind(client)
                        : value;
                    },
                  });
                  return (work as (tx: typeof wrapped) => Promise<unknown>)(
                    wrapped,
                  );
                });
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
      ).futures;
      await assert.rejects(
        failing.execute(s.userId, s.accountId, body(s, p, true)),
        /after-collateral-guard/,
      );
      assert.deepEqual(await state(s), before);
      checks++;
    } finally {
      await cleanup(s);
    }
  }
  console.log(
    'PASS F2.1 no partial commit after guard/PnL/fee/Position/Execution/Ledger/Request faults',
  );
}
async function wait(blocker: Client, n: number) {
  for (let i = 0; i < 300; i++) {
    await blocker.query('SELECT pg_stat_clear_snapshot()');
    const result = await blocker.query(
      `SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()`,
    );
    if (result.rows[0].n >= n) return;
    await delay(10);
  }
  throw new Error('Financial lock barrier timed out.');
}
async function races() {
  for (const mode of ['general', 'season'] as const)
    for (const order of [
      'safe-user-first',
      'liquidation-first',
      'unsafe-user-first',
    ] as const) {
      const { s, p } = await setup(mode, 100, false, false, 'long');
      const blocker = new Client({
        connectionString: process.env.DATABASE_URL,
      });
      const pending: Promise<unknown>[] = [];
      try {
        await blocker.connect();
        await mark(s, '1');
        await price(s, order === 'unsafe-user-first' ? '1' : '100');
        await blocker.query('BEGIN');
        await blocker.query(
          'SELECT id FROM cash_wallets WHERE id=$1 FOR UPDATE',
          [s.futuresWalletId],
        );
        const before = await state(s);
        const command = body(s, p, false);
        const user = () => app.futures.execute(s.userId, s.accountId, command);
        const system = () => liquidator.liquidate(s.accountId, p.id);
        const first = order === 'liquidation-first' ? system() : user();
        void first.catch(() => {});
        pending.push(first);
        await wait(blocker, 1);
        const second = order === 'liquidation-first' ? user() : system();
        void second.catch(() => {});
        pending.push(second);
        await wait(blocker, 2);
        const outcomes = Promise.allSettled([first, second]);
        await blocker.query('COMMIT');
        const result = await outcomes;
        if (order === 'safe-user-first') {
          assert.equal(result[0].status, 'fulfilled');
          assert.equal(
            (result[1] as PromiseFulfilledResult<{ state: string }>).value
              .state,
            'already_closed',
          );
          assert.equal(
            await db.futuresLiquidation.count({
              where: { tradingAccountId: s.accountId },
            }),
            0,
          );
          assert.deepEqual(
            await user(),
            (result[0] as PromiseFulfilledResult<unknown>).value,
          );
        } else {
          const userResult = result[order === 'liquidation-first' ? 1 : 0];
          assert.equal(userResult.status, 'rejected');
          if (order === 'unsafe-user-first')
            assert.equal(
              (userResult as PromiseRejectedResult).reason.getResponse().error
                .code,
              'FUTURES_LIQUIDATION_REQUIRED',
            );
          assert.equal(
            await db.futuresLiquidation.count({
              where: { tradingAccountId: s.accountId },
            }),
            1,
          );
          assert.equal((await system()).state, 'already_closed');
          const after = await state(s);
          assert.equal(after.commands.length, before.commands.length);
          assert.equal(after.executions.length, before.executions.length);
          const b = before.wallets.find(
              (w: { id: string }) => w.id === s.futuresWalletId,
            ),
            a = after.wallets.find(
              (w: { id: string }) => w.id === s.futuresWalletId,
            );
          assert.ok(a && b);
          assert.equal(
            d(b.balanceAmount).sub(a.balanceAmount).toFixed(8),
            p.isolatedMargin.toFixed(8),
          );
          assert.ok(d(a.balanceAmount).gt('999000'));
        }
        await invariant(s);
        checks++;
      } finally {
        await blocker.query('ROLLBACK').catch(() => {});
        await Promise.allSettled(pending);
        await blocker.end();
        await cleanup(s);
      }
    }
  console.log(
    'PASS F2.1 General/Season safe user first, liquidation first and unsafe user first races/replay; free cash protected',
  );
}
async function main() {
  await db.$connect();
  await boundaries();
  await rollback();
  await races();
  console.log(
    `futures F2.1 isolated boundary integration ok (${checks} checks)`,
  );
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
