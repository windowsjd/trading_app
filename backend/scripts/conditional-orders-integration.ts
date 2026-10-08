import { tradingSessions } from '../test/support/trading-session-fixture';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  db,
  app,
  fixture,
  now,
  price,
  fxEvidence,
  fxEvidenceIds,
  openBody,
  positionBody,
  cleanup,
  type Scenario,
} from './futures-integration';
import { Prisma } from '../src/generated/prisma/client';
import { ConditionalService } from '../src/conditional/conditional.service';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import {
  OrdersService,
  type OrderRequestBody,
} from '../src/orders/orders.service';
import { OrderReservationService } from '../src/orders/order-reservation.service';
import { LimitOrderCreateService } from '../src/orders/limit-order-create.service';
import { LimitOrderCancelService } from '../src/orders/limit-order-cancel.service';
import { LimitOrderExecutionService } from '../src/orders/limit-order-execution.service';
import { LimitOrderCandleEvidenceService } from '../src/orders/limit-order-candle-evidence.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { GeneralAccountPerformanceService } from '../src/portfolio/general-account-performance.service';
import { GeneralExternalFundingService } from '../src/portfolio/general-external-funding.service';
import { FuturesLiquidationService } from '../src/futures/futures-liquidation.service';
import type { ProtectionLegInput } from '../src/conditional/conditional-policy';
import { FuturesSeasonSettlementService } from '../src/futures/futures-season-settlement.service';
import { services, faultyDb } from './futures-integration';
import { Client } from 'pg';
import {
  MarketExecutionEvidenceAdapter,
  type MarketExecutionContext,
} from '../src/orders/market-execution-evidence.adapter';
import { setTimeout as delay } from 'node:timers/promises';

if (
  process.env.NODE_ENV !== 'test' ||
  process.env.CONDITIONAL_DB_INTEGRATION !== '1'
)
  throw new Error('Explicit disposable Conditional PG opt-in required');
process.env.CONDITIONAL_ORDERS_ENABLED = 'true';
process.env.FUTURES_TRADING_MODE = 'ENABLED';
process.env.FUTURES_RISK_ENGINE_ENABLED = 'true';
process.env.LIMIT_ORDER_ENABLED = 'true';
process.env.SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED = 'true';
const limitPending = (error: unknown) =>
  error instanceof HttpException &&
  (error.getResponse() as { error: { code: string } }).error.code ===
    'CONDITIONAL_LIMIT_NOT_REACHED';
const access = new TradingAccountAccessService(db);
const valuation = new PortfolioValuationService(db);
const performance = new GeneralAccountPerformanceService(
  db,
  valuation,
  new GeneralExternalFundingService(db),
);
const reservation = new OrderReservationService();
const cancel = new LimitOrderCancelService(db, reservation);
const orders = new OrdersService(
  db,
  undefined,
  new LimitOrderCreateService(db, reservation),
  cancel,
  access,
  performance,
);
const conditional = new ConditionalService(
  db,
  access,
  orders,
  cancel,
  app.futures,
);
const fill = new LimitOrderExecutionService(
  db,
  new LimitOrderCandleEvidenceService(db),
  orders,
  performance,
);
let checks = 0;
function pass(label: string) {
  checks++;
  console.log(`PASS Conditional ${label}`);
}
function leg(
  kind: 'stop_loss' | 'take_profit',
  type: 'market' | 'limit',
  direction = 'long',
): ProtectionLegInput {
  const below = (direction === 'long') === (kind === 'stop_loss');
  return {
    kind,
    triggerPrice: below ? '99' : '101',
    childOrderType: type,
    ...(type === 'limit'
      ? { childLimitPrice: direction === 'long' ? '102' : '98' }
      : {}),
  };
}
async function mark(s: Scenario, value = '100') {
  const at = await now();
  return db.futuresMarkSnapshot.create({
    data: {
      instrumentId: s.instruments[0].instrument.id,
      symbol: s.instruments[0].asset.symbol,
      price: value,
      source: 'binance_usdm_mark_ws',
      effectiveAt: at,
      capturedAt: at,
    },
  });
}
async function fresh(s: Scenario, value = '100') {
  await fxEvidence();
  await price(s, value, 0, 5);
  await mark(s);
}
async function createSpot(s: Scenario, quantity = '10') {
  return db.position.create({
    data: {
      tradingAccountId: s.accountId,
      assetId: s.instruments[0].asset.id,
      quantity,
      averageCost: '100',
      currencyCode: 'USD',
    },
  });
}
async function protect(
  s: Scenario,
  domain: 'spot' | 'futures',
  id: string,
  legs: ProtectionLegInput[],
) {
  const result = await conditional.create(s.userId, s.accountId, {
    domain,
    assetId: s.instruments[0].asset.id,
    positionId: id,
    legs,
    idempotencyKey: randomUUID(),
  });
  return (result as { data: { groupId: string } }).data.groupId;
}
const group = (id: string) =>
  db.protectionGroup.findUniqueOrThrow({
    where: { id },
    include: { children: { orderBy: { triggeredAt: 'asc' } } },
  });
async function stockOrCryptoPrice(s: Scenario, value: string) {
  const asset = await db.asset.findUniqueOrThrow({
    where: { id: s.instruments[0].asset.id },
  });
  if (asset.assetType === 'crypto') return price(s, value, 0, 0);
  const at = await now();
  return db.assetPriceSnapshot.create({
    data: {
      assetId: asset.id,
      price: value,
      currencyCode: asset.priceCurrency,
      sourceType: 'provider_api',
      sourceName:
        asset.market === 'KRX'
          ? 'kis_krx_realtime_trade'
          : 'kis_us_delayed_trade',
      capturedAt: at,
      effectiveAt: at,
    },
  });
}
async function settleLimit(s: Scenario, orderId: string, value: string) {
  const snapshot = await stockOrCryptoPrice(s, value);
  await fxEvidence();
  return fill.fillLimitOrder({
    orderId,
    plan: {
      path: 'snapshot',
      assetPriceSnapshotId: snapshot.id,
      executedPrice: new Prisma.Decimal(value),
    },
  });
}
async function sell(s: Scenario, quantity: string) {
  const request: OrderRequestBody = {
    assetId: s.instruments[0].asset.id,
    side: 'sell',
    orderType: 'market',
    quantity,
  };
  const quote = await orders.quoteOrderForTradingAccount(
    s.userId,
    s.accountId,
    request,
  );
  return orders.createOrderForTradingAccount(s.userId, s.accountId, {
    ...request,
    quoteId: quote.data.quoteId,
    idempotencyKey: randomUUID(),
  });
}
async function release(s: Scenario) {
  const where = { tradingAccountId: s.accountId };
  await db.protectionChild.deleteMany({ where: { group: where } });
  await db.protectionLeg.deleteMany({ where: { group: where } });
  await db.protectionGroup.deleteMany({ where });
  await db.protectionCommand.deleteMany({ where });
  await db.order.deleteMany({ where });
  await db.position.deleteMany({ where });
  await db.seasonRanking.deleteMany({ where });
  await db.dailyPortfolioSnapshot.deleteMany({ where });
  await db.futuresSeasonClose.deleteMany({ where });
  await db.futuresSeasonSettlement.deleteMany({ where });
  await db.futuresSeasonPrice.deleteMany({
    where: {
      instrumentId: { in: s.instruments.map((row) => row.instrument.id) },
    },
  });
  await cleanup(s);
}
async function matrix() {
  for (const mode of ['general', 'season'] as const)
    for (const domain of ['spot', 'futures'] as const)
      for (const direction of domain === 'spot'
        ? (['long'] as const)
        : (['long', 'short'] as const))
        for (const kind of ['stop_loss', 'take_profit'] as const)
          for (const type of ['market', 'limit'] as const) {
            const s = await fixture(mode);
            try {
              await fresh(s);
              const p =
                domain === 'spot'
                  ? await createSpot(s)
                  : (
                      await app.futures.execute(
                        s.userId,
                        s.accountId,
                        openBody(s, { direction, leverage: 1 }),
                      )
                    ).data.position;
              const id = await protect(s, domain, p.id, [
                leg(kind, type, direction),
              ]);
              const before = s.season
                ? (
                    await db.seasonParticipant.findUniqueOrThrow({
                      where: { tradingAccountId: s.accountId },
                    })
                  ).totalFillCount
                : 0;
              const trigger =
                (direction === 'long') === (kind === 'stop_loss')
                  ? '99'
                  : '101';
              await price(s, trigger, 0, 0);
              if (domain === 'futures' && type === 'limit')
                await assert.rejects(conditional.evaluate(id), limitPending);
              else await conditional.evaluate(id);
              if (type === 'limit') {
                assert.equal((await group(id)).status, 'active');
                if (s.season)
                  assert.equal(
                    (
                      await db.seasonParticipant.findUniqueOrThrow({
                        where: { tradingAccountId: s.accountId },
                      })
                    ).totalFillCount,
                    before,
                  );
                if (domain === 'spot') {
                  const child = (await group(id)).children[0];
                  assert.ok(child.orderId);
                  assert.equal(
                    (await settleLimit(s, child.orderId!, '103')).state,
                    'filled',
                  );
                } else {
                  await price(s, direction === 'long' ? '103' : '97', 0, 0);
                  await conditional.evaluate(id);
                }
              }
              assert.equal((await group(id)).status, 'completed');
              assert.equal(
                (await group(id)).children.filter((c) => c.status === 'filled')
                  .length,
                1,
              );
              await conditional.evaluate(id);
              if (s.season)
                assert.equal(
                  (
                    await db.seasonParticipant.findUniqueOrThrow({
                      where: { tradingAccountId: s.accountId },
                    })
                  ).totalFillCount,
                  before + 1,
                );
              pass(
                `${mode}/${domain}/${direction}/${kind}/${type}: one fill, full exit, terminal replay`,
              );
            } finally {
              await release(s);
            }
          }
}
async function oco() {
  for (const domain of ['spot', 'futures'] as const) {
    const s = await fixture('season');
    try {
      await fresh(s);
      const p =
        domain === 'spot'
          ? await createSpot(s, '100')
          : (
              await app.futures.execute(
                s.userId,
                s.accountId,
                openBody(s, { leverage: 1 }),
              )
            ).data.position;
      const id = await protect(s, domain, p.id, [
        leg('stop_loss', 'limit'),
        leg('take_profit', 'limit'),
      ]);
      const evaluate = async () => {
        try {
          await conditional.evaluate(id);
        } catch (e) {
          assert.ok(limitPending(e));
        }
      };
      await price(s, '101', 0, 0);
      await evaluate();
      const first = (await group(id)).children[0];
      await evaluate();
      assert.equal((await group(id)).children.length, 1);
      if (domain === 'spot')
        assert.equal(
          (
            await db.position.findFirstOrThrow({
              where: { tradingAccountId: s.accountId },
            })
          ).reservedQuantity.toFixed(8),
          '100.00000000',
        );
      await price(s, '99', 0, 0);
      await evaluate();
      assert.equal(
        (await group(id)).children.find((c) => c.id === first.id)!.status,
        'canceled',
      );
      if (first.orderId)
        assert.equal(
          (await db.order.findUniqueOrThrow({ where: { id: first.orderId } }))
            .status,
          'canceled',
        );
      await price(s, '101', 0, 0);
      await evaluate();
      const children = (await group(id)).children;
      assert.equal(children.length, 3);
      assert.equal(children.filter((c) => c.status === 'pending').length, 1);
      assert.equal(
        (
          await db.seasonParticipant.findUniqueOrThrow({
            where: { tradingAccountId: s.accountId },
          })
        ).totalFillCount,
        domain === 'spot' ? 0 : 1,
      );
      pass(
        `${domain}: OCO opposite replacement both ways, old leg re-arm, one reservation, no trigger fill count`,
      );
      await price(s, '100', 0, 0);
      if (domain === 'spot') await sell(s, '40');
      else
        await app.futures.execute(
          s.userId,
          s.accountId,
          await positionBody(s, 'reduce', { quantity: '0.4' }),
        );
      assert.equal(
        (await group(id)).children.filter((c) => c.status === 'pending').length,
        0,
      );
      assert.equal((await group(id)).status, 'active');
      if (domain === 'spot') await sell(s, '60');
      else
        await app.futures.execute(
          s.userId,
          s.accountId,
          await positionBody(s, 'close', { quantity: '0.6' }),
        );
      assert.equal((await group(id)).status, 'completed');
      pass(
        `${domain}: manual partial reduce re-arms remainder and manual close completes`,
      );
    } finally {
      await release(s);
    }
  }
}
async function sourceAndModes() {
  const s = await fixture('season');
  try {
    await fresh(s);
    const opened = await app.futures.execute(
      s.userId,
      s.accountId,
      openBody(s, { leverage: 1 }),
    );
    const body = {
      domain: 'futures',
      assetId: s.instruments[0].asset.id,
      positionId: opened.data.position.id,
      legs: [leg('stop_loss', 'market')],
      idempotencyKey: randomUUID(),
    };
    const created = await conditional.create(s.userId, s.accountId, body);
    const id = (created as { data: { groupId: string } }).data.groupId;
    await mark(s, '90');
    await conditional.evaluate(id);
    assert.equal((await group(id)).children.length, 0);
    await db.assetPriceSnapshot.updateMany({
      where: { assetId: s.instruments[0].asset.id },
      data: {
        effectiveAt: new Date(+(await now()) - 20000),
        capturedAt: new Date(+(await now()) - 20000),
      },
    });
    assert.equal((await conditional.evaluate(id)).state, 'price_unavailable');
    await db.assetPriceSnapshot.deleteMany({
      where: {
        assetId: s.instruments[0].asset.id,
        futuresExecutions: { none: {} },
        quotes: { none: {} },
      },
    });
    assert.equal((await conditional.evaluate(id)).state, 'price_unavailable');
    process.env.FUTURES_TRADING_MODE = 'DISABLED';
    assert.deepEqual(
      await conditional.create(s.userId, s.accountId, body),
      created,
    );
    await price(s, '99', 0, 0);
    assert.equal((await conditional.evaluate(id)).state, 'disabled');
    assert.equal((await group(id)).children.length, 0);
    process.env.FUTURES_TRADING_MODE = 'REDUCE_ONLY';
    await conditional.evaluate(id);
    assert.equal((await group(id)).status, 'completed');
    pass(
      'Spot-only trigger source; stale/missing defer; disabled pauses; reduce-only exits; command replay',
    );
  } finally {
    process.env.FUTURES_TRADING_MODE = 'ENABLED';
    await release(s);
  }
}
async function attachedEntries() {
  for (const market of ['BINANCE', 'KRX', 'NAS'] as const)
    for (const outcome of ['fill', 'cancel', 'end'] as const) {
      const s = await fixture('season');
      try {
        await fresh(s);
        if (market !== 'BINANCE') {
          const currencyCode = market === 'KRX' ? 'KRW' : 'USD';
          tradingSessions.set(await now(), undefined, ['KRX', 'US']);
          await db.asset.update({
            where: { id: s.instruments[0].asset.id },
            data: {
              market,
              assetType: market === 'KRX' ? 'domestic_stock' : 'us_stock',
              currencyCode,
              priceCurrency: currencyCode,
              settlementCurrency: currencyCode,
            },
          });
          await db.cashWallet.updateMany({
            where: {
              tradingAccountId: s.accountId,
              walletScope: 'securities',
              currencyCode,
            },
            data: { balanceAmount: '100000' },
          });
          await stockOrCryptoPrice(s, '100');
        }
        const payload = {
          assetId: s.instruments[0].asset.id,
          side: 'buy' as const,
          orderType: 'limit' as const,
          ...(market === 'BINANCE' ? { amount: '500' } : { quantity: '5' }),
          limitPrice: '100',
        };
        const quote = await orders.quoteOrderForTradingAccount(
          s.userId,
          s.accountId,
          payload,
        );
        const body = {
          ...payload,
          quoteId: quote.data.quoteId,
          idempotencyKey: randomUUID(),
          attachedProtection: [
            leg('stop_loss', 'market'),
            leg('take_profit', 'limit'),
          ],
        };
        const result = await orders.createOrderForTradingAccount(
          s.userId,
          s.accountId,
          body,
        );
        assert.deepEqual(
          await orders.createOrderForTradingAccount(
            s.userId,
            s.accountId,
            body,
          ),
          result,
        );
        const orderId = result.data.order.orderId;
        const attachment = await db.protectionGroup.findUniqueOrThrow({
          where: { parentOrderId: orderId },
        });
        assert.equal(attachment.status, 'holding');
        await stockOrCryptoPrice(s, '98');
        assert.equal(
          (await conditional.evaluate(attachment.id)).state,
          'holding',
        );
        assert.equal((await group(attachment.id)).children.length, 0);
        if (outcome === 'fill') {
          assert.equal((await settleLimit(s, orderId, '100')).state, 'filled');
          assert.equal((await group(attachment.id)).status, 'active');
          await stockOrCryptoPrice(s, '99');
          await conditional.evaluate(attachment.id);
          assert.equal((await group(attachment.id)).status, 'completed');
          assert.equal(
            (
              await db.seasonParticipant.findUniqueOrThrow({
                where: { tradingAccountId: s.accountId },
              })
            ).totalFillCount,
            2,
          );
        } else if (outcome === 'cancel') {
          await orders.cancelOrderForTradingAccount(
            s.userId,
            s.accountId,
            orderId,
          );
          assert.equal((await group(attachment.id)).status, 'canceled');
        } else {
          await db.season.update({
            where: { id: s.season!.id },
            data: { status: 'ended' },
          });
          await cancel.cleanupEndedSeasonLimitReservations({
            now: await now(),
          });
          assert.equal((await group(attachment.id)).status, 'canceled');
        }
        assert.equal(
          (
            await db.cashWallet.findUniqueOrThrow({
              where: { id: s.spotWalletId },
            })
          ).reservedAmount.toFixed(8),
          '0.00000000',
        );
        pass(
          `attached ${market} parent ${outcome}: holding, replay, lifecycle, reservation, fill count`,
        );
      } finally {
        tradingSessions.reset();
        await release(s);
      }
    }
}
async function stockCoverage() {
  for (const market of ['KRX', 'NAS'] as const)
    for (const kind of ['stop_loss', 'take_profit'] as const)
      for (const type of ['market', 'limit'] as const) {
        const s = await fixture('season');
        try {
          const clock = await now();
          tradingSessions.set(clock, undefined, ['KRX', 'US']);
          const currencyCode = market === 'KRX' ? 'KRW' : 'USD';
          const asset = await db.asset.update({
            where: { id: s.instruments[0].asset.id },
            data: {
              market,
              assetType: market === 'KRX' ? 'domestic_stock' : 'us_stock',
              currencyCode,
              priceCurrency: currencyCode,
              settlementCurrency: currencyCode,
            },
          });
          const stockPrice = async (value: string) => {
            const at = await now();
            return db.assetPriceSnapshot.create({
              data: {
                assetId: asset.id,
                price: value,
                currencyCode,
                sourceType: 'provider_api',
                sourceName:
                  market === 'KRX'
                    ? 'kis_krx_realtime_trade'
                    : 'kis_us_delayed_trade',
                effectiveAt: at,
                capturedAt: at,
              },
            });
          };
          const position = await db.position.create({
            data: {
              tradingAccountId: s.accountId,
              assetId: asset.id,
              currencyCode,
              quantity: '10',
              averageCost: '100',
            },
          });
          await stockPrice('100');
          await fxEvidence();
          const id = await protect(s, 'spot', position.id, [leg(kind, type)]);
          tradingSessions.set(clock, clock, ['KRX', 'US']);
          await stockPrice(kind === 'stop_loss' ? '99' : '101');
          assert.equal(
            (await conditional.evaluate(id)).state,
            'price_unavailable',
          );
          tradingSessions.set(await now(), undefined, ['KRX', 'US']);
          await stockPrice(kind === 'stop_loss' ? '99' : '101');
          await conditional.evaluate(id);
          if (type === 'limit') {
            const child = (await group(id)).children[0],
              snapshot = await stockPrice('103');
            assert.equal(
              (
                await fill.fillLimitOrder({
                  orderId: child.orderId!,
                  plan: {
                    path: 'snapshot',
                    assetPriceSnapshotId: snapshot.id,
                    executedPrice: new Prisma.Decimal('103'),
                  },
                })
              ).state,
              'filled',
            );
          }
          assert.equal((await group(id)).status, 'completed');
          pass(
            `${market} ${kind}/${type}: canonical stock source and closed-session defer`,
          );
        } finally {
          tradingSessions.reset();
          await release(s);
        }
      }
}
async function races() {
  for (const opponent of [
    'manual_close',
    'manual_reduce',
    'liquidation',
    'season_end',
    'duplicate',
  ] as const) {
    const s = await fixture('season');
    try {
      await fresh(s);
      const opened = await app.futures.execute(
        s.userId,
        s.accountId,
        openBody(s, { leverage: 100 }),
      );
      const id = await protect(s, 'futures', opened.data.position.id, [
        { kind: 'stop_loss', triggerPrice: '99.7', childOrderType: 'market' },
      ]);
      await price(s, '99.6', 0, 0);
      await mark(s, opponent === 'liquidation' ? '98' : '100');
      const manual = await positionBody(
        s,
        opponent === 'manual_reduce' ? 'reduce' : 'close',
        opponent === 'manual_reduce' ? { quantity: '0.4' } : {},
      );
      const blocker = new Client({
        connectionString: process.env.DATABASE_URL,
      });
      await blocker.connect();
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT id FROM season_participants WHERE trading_account_id=$1 FOR NO KEY UPDATE',
        [s.accountId],
      );
      if (opponent === 'season_end') {
        // Fixed end boundary, set before either contender enters.
        await db.season.update({
          where: { id: s.season!.id },
          data: { endAt: new Date((await now()).getTime() + 100) },
        });
      }
      const a = conditional.evaluate(id);
      const b =
        opponent === 'duplicate'
          ? conditional.evaluate(id)
          : opponent === 'liquidation'
            ? new FuturesLiquidationService(db).liquidate(
                s.accountId,
                opened.data.position.id,
              )
            : opponent === 'season_end'
              ? db.season.update({
                  where: { id: s.season!.id },
                  data: { status: 'ended' },
                })
              : app.futures.execute(s.userId, s.accountId, manual);
      // Observe simultaneous real lock waiters; release the fixture fence only.
      const pending = Promise.allSettled([a, b]);
      await delay(opponent === 'season_end' ? 130 : 40);
      await blocker.query('COMMIT');
      await blocker.end();
      const outcomes = await pending;
      for (const r of outcomes)
        if (r.status === 'rejected')
          assert.ok(
            !/deadlock/i.test(String(r.reason)),
            JSON.stringify(r.reason),
          );
      await conditional.evaluate(id);
      const p = await db.futuresPosition.findUniqueOrThrow({
        where: { id: opened.data.position.id },
      });
      const closes = await db.futuresExecution.findMany({
        where: { positionId: p.id, operation: { in: ['reduce', 'close'] } },
      });
      const liquidations = await db.futuresLiquidationClose.count({
        where: { positionId: p.id },
      });
      assert.ok(
        closes
          .reduce((sum, row) => sum.add(row.quantity), new Prisma.Decimal(0))
          .lte(1),
      );
      if (opponent === 'season_end') {
        const season = await db.season.findUniqueOrThrow({
          where: { id: s.season!.id },
        });
        assert.ok(closes.every((row) => row.executedAt < season.endAt));
        await cancel.cleanupEndedSeasonLimitReservations({ now: await now() });
        await new FuturesSeasonSettlementService(db).settleSeason(season.id);
        assert.equal(
          await db.futuresPosition.count({
            where: { tradingAccountId: s.accountId, status: 'open' },
          }),
          0,
        );
      } else {
        assert.equal(p.status, 'closed');
        assert.equal(
          closes.filter((row) => row.operation === 'close').length +
            liquidations,
          1,
        );
      }
      assert.ok(
        (
          await db.cashWallet.findUniqueOrThrow({
            where: { id: s.futuresWalletId },
          })
        ).balanceAmount.gte(0),
      );
      const ledger = await db.walletTransaction.findMany({
        where: { tradingAccountId: s.accountId },
      });
      assert.equal(
        new Set(ledger.map((r) => `${r.referenceId}:${r.txType}`)).size,
        ledger.length,
      );
      pass(
        `real PG conditional vs ${opponent}: single quantity settlement, fee/ledger uniqueness, no deadlock`,
      );
    } finally {
      await release(s);
    }
  }
}
async function rollback() {
  for (const point of [
    'protectionChild.create',
    'futuresPosition.update',
    'futuresExecution.create',
    'walletTransaction.createMany',
    'protectionChild.update',
    'futuresExecuteRequest.create',
  ]) {
    const s = await fixture('season');
    try {
      await fresh(s);
      const opened = await app.futures.execute(
        s.userId,
        s.accountId,
        openBody(s, { leverage: 1 }),
      );
      const id = await protect(s, 'futures', opened.data.position.id, [
        leg('take_profit', 'market'),
      ]);
      const cash = (
        await db.cashWallet.findUniqueOrThrow({
          where: { id: s.futuresWalletId },
        })
      ).balanceAmount;
      const ledger = await db.walletTransaction.count({
        where: { tradingAccountId: s.accountId },
      });
      await price(s, '101', 0, 0);
      const faulty = faultyDb(point),
        service = new ConditionalService(
          faulty,
          new TradingAccountAccessService(faulty),
          orders,
          cancel,
          services(faulty).futures,
        );
      await assert.rejects(
        service.evaluate(id),
        new RegExp(point.replace('.', '\\.')),
      );
      assert.equal(
        (
          await db.futuresPosition.findUniqueOrThrow({
            where: { id: opened.data.position.id },
          })
        ).quantity.toFixed(8),
        '1.00000000',
      );
      assert.ok(
        (
          await db.cashWallet.findUniqueOrThrow({
            where: { id: s.futuresWalletId },
          })
        ).balanceAmount.eq(cash),
      );
      assert.equal(
        await db.walletTransaction.count({
          where: { tradingAccountId: s.accountId },
        }),
        ledger,
      );
      assert.equal(
        (
          await db.seasonParticipant.findUniqueOrThrow({
            where: { tradingAccountId: s.accountId },
          })
        ).totalFillCount,
        1,
      );
      await conditional.evaluate(id);
      assert.equal((await group(id)).status, 'completed');
      pass(`${point}: atomic rollback then one retry fill`);
    } finally {
      await release(s);
    }
  }
}
async function spotRaces() {
  for (const opponent of [
    'manual_close',
    'manual_reduce',
    'opposite',
    'duplicate',
  ] as const) {
    const s = await fixture('season');
    try {
      await fresh(s);
      const p = await createSpot(s, '100');
      const id = await protect(s, 'spot', p.id, [
        leg('stop_loss', 'limit'),
        leg('take_profit', 'limit'),
      ]);
      await price(s, '101', 0, 0);
      await conditional.evaluate(id);
      const child = (await group(id)).children[0];
      const candidate = await price(s, '103', 0, 0);
      if (opponent === 'opposite') await price(s, '98', 0, 0);
      const blocker = new Client({
        connectionString: process.env.DATABASE_URL,
      });
      await blocker.connect();
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT id FROM season_participants WHERE trading_account_id=$1 FOR NO KEY UPDATE',
        [s.accountId],
      );
      const fillChild = () =>
        fill.fillLimitOrder({
          orderId: child.orderId!,
          plan: {
            path: 'snapshot',
            assetPriceSnapshotId: candidate.id,
            executedPrice: new Prisma.Decimal(103),
          },
        });
      const a = fillChild(),
        b =
          opponent === 'duplicate'
            ? fillChild()
            : opponent === 'opposite'
              ? conditional.evaluate(id)
              : sell(s, opponent === 'manual_close' ? '100' : '40');
      const all = Promise.allSettled([a, b]);
      await delay(35);
      await blocker.query('COMMIT');
      await blocker.end();
      const results = await all;
      for (const row of results)
        if (row.status === 'rejected')
          assert.doesNotMatch(String(row.reason), /deadlock/i);
      const position = await db.position.findUniqueOrThrow({
        where: { id: p.id },
      });
      assert.ok(position.quantity.gte(0));
      assert.ok(position.reservedQuantity.gte(0));
      assert.ok(position.quantity.gte(position.reservedQuantity));
      const executed = await db.order.findMany({
        where: {
          tradingAccountId: s.accountId,
          side: 'sell',
          status: 'executed',
        },
      });
      assert.ok(
        executed
          .reduce(
            (a, o) => a.add(o.executedQuantity ?? o.quantity!),
            new Prisma.Decimal(0),
          )
          .lte(100),
      );
      assert.ok(
        (await group(id)).children.filter((c) => c.status === 'pending')
          .length <= 1,
      );
      assert.equal(
        (
          await db.seasonParticipant.findUniqueOrThrow({
            where: { tradingAccountId: s.accountId },
          })
        ).totalFillCount,
        executed.length,
      );
      const g = await group(id);
      if (g.status === 'active')
        await conditional.cancelGroup(s.userId, s.accountId, id, {
          idempotencyKey: randomUUID(),
        });
      assert.equal(
        (
          await db.position.findUniqueOrThrow({ where: { id: p.id } })
        ).reservedQuantity.toFixed(8),
        '0.00000000',
      );
      pass(
        `Spot child fill vs ${opponent}: one reservation owner and no oversell`,
      );
    } finally {
      await release(s);
    }
  }
}
async function commandsAndConflicts() {
  const s = await fixture('general'),
    other = await fixture('general');
  try {
    await fresh(s);
    const p = await createSpot(s, '10');
    const body = {
      domain: 'spot' as const,
      assetId: s.instruments[0].asset.id,
      positionId: p.id,
      legs: [leg('stop_loss', 'limit'), leg('take_profit', 'limit')],
      idempotencyKey: randomUUID(),
    };
    await assert.rejects(conditional.create(other.userId, s.accountId, body));
    const broken = faultyDb('protectionCommand.create');
    const svc = new ConditionalService(
      broken,
      new TradingAccountAccessService(broken),
      orders,
      cancel,
      app.futures,
    );
    await assert.rejects(svc.create(s.userId, s.accountId, body));
    assert.equal(
      await db.protectionGroup.count({
        where: { tradingAccountId: s.accountId },
      }),
      0,
    );
    const created = await conditional.create(s.userId, s.accountId, body);
    const id = (created as { data: { groupId: string } }).data.groupId;
    await assert.rejects(
      conditional.create(s.userId, s.accountId, {
        ...body,
        legs: [leg('stop_loss', 'market')],
      }),
    );
    await assert.rejects(
      conditional.create(s.userId, s.accountId, {
        ...body,
        idempotencyKey: randomUUID(),
      }),
    );
    await price(s, '101', 0, 0);
    await conditional.evaluate(id);
    const before = await db.position.findUniqueOrThrow({ where: { id: p.id } });
    const cancelBody = { idempotencyKey: randomUUID() };
    await assert.rejects(
      svc.cancelGroup(s.userId, s.accountId, id, cancelBody),
    );
    assert.ok(
      (
        await db.position.findUniqueOrThrow({ where: { id: p.id } })
      ).reservedQuantity.eq(before.reservedQuantity),
    );
    assert.equal((await group(id)).children[0].status, 'pending');
    const canceled = await conditional.cancelGroup(
      s.userId,
      s.accountId,
      id,
      cancelBody,
    );
    process.env.CONDITIONAL_ORDERS_ENABLED = 'false';
    assert.deepEqual(
      await conditional.create(s.userId, s.accountId, body),
      created,
    );
    assert.deepEqual(
      await conditional.cancelGroup(s.userId, s.accountId, id, cancelBody),
      canceled,
    );
    assert.equal(
      (
        await db.position.findUniqueOrThrow({ where: { id: p.id } })
      ).reservedQuantity.toFixed(8),
      '0.00000000',
    );
    pass(
      'create/cancel rollback, replay across disable, ownership and one-group conflicts',
    );
  } finally {
    process.env.CONDITIONAL_ORDERS_ENABLED = 'true';
    await release(s);
    await release(other);
  }
  for (const direction of ['long', 'short'] as const) {
    const s = await fixture('season');
    try {
      await fresh(s);
      const p = (
        await app.futures.execute(
          s.userId,
          s.accountId,
          openBody(s, { direction, marginMode: 'cross', leverage: 37 }),
        )
      ).data.position;
      const id = await protect(s, 'futures', p.id, [
        leg('take_profit', 'limit', direction),
      ]);
      await price(s, direction === 'long' ? '101' : '99', 0, 0);
      await assert.rejects(conditional.evaluate(id), limitPending);
      await mark(s);
      await assert.rejects(
        app.futures.execute(
          s.userId,
          s.accountId,
          await positionBody(s, 'increase', { quantity: '0.1' }),
        ),
        (e) =>
          e instanceof HttpException &&
          JSON.stringify(e.getResponse()).includes('PROTECTION_CHILD_PENDING'),
      );
      await price(s, direction === 'long' ? '103' : '97', 0, 0);
      await conditional.evaluate(id);
      assert.equal((await group(id)).status, 'completed');
      pass(
        `Cross ${direction}: bound Limit exit and conflicting increase blocked`,
      );
    } finally {
      await release(s);
    }
  }
}
async function invalidEvidence() {
  for (const mode of ['general', 'season'] as const) {
    const s = await fixture(mode);
    try {
      await fresh(s);
      const p = (
        await app.futures.execute(
          s.userId,
          s.accountId,
          openBody(s, { leverage: 1 }),
        )
      ).data.position;
      const id = await protect(s, 'futures', p.id, [
        leg('stop_loss', 'market'),
      ]);
      await db.assetPriceSnapshot.updateMany({
        where: { assetId: s.instruments[0].asset.id },
        data: { capturedAt: new Date((await now()).getTime() - 11000) },
      });
      for (const bad of ['future', 'source', 'currency', 'asset'] as const) {
        const at = await now();
        const row = await db.assetPriceSnapshot.create({
          data: {
            assetId:
              bad === 'asset'
                ? s.instruments[1].asset.id
                : s.instruments[0].asset.id,
            price: '90',
            currencyCode: bad === 'currency' ? 'KRW' : 'USD',
            sourceType: 'provider_api',
            sourceName:
              bad === 'source'
                ? 'binance_usdm_mark_ws'
                : 'binance_spot_ws_ticker',
            capturedAt: bad === 'future' ? new Date(at.getTime() + 10000) : at,
            effectiveAt: at,
          },
        });
        assert.equal(
          (await conditional.evaluate(id)).state,
          'price_unavailable',
        );
        assert.equal((await group(id)).children.length, 0);
        await db.assetPriceSnapshot.delete({ where: { id: row.id } });
      }
      pass(`${mode}: future/wrong source/currency/asset never trigger Futures`);
    } finally {
      await release(s);
    }
  }
}
async function partialMarket() {
  const s = await fixture('season');
  try {
    await fresh(s);
    const p = await createSpot(s, '10');
    const id = await protect(s, 'spot', p.id, [
      leg('stop_loss', 'market'),
      leg('take_profit', 'market'),
    ]);
    const adapter = new (class extends MarketExecutionEvidenceAdapter {
      read(ctx: MarketExecutionContext) {
        return {
          source: 'generic_test_l2',
          evidence: {
            ...ctx,
            kind: 'l2' as const,
            effectiveAt: ctx.executedAt,
            capturedAt: ctx.executedAt,
            asks: [],
            bids: [{ price: '99', quantity: '4' }],
          },
        };
      }
      validate() {
        return { sourceEligible: true, sessionEligible: true, fresh: true };
      }
    })();
    const partialOrders = new OrdersService(
      db,
      undefined,
      new LimitOrderCreateService(db, reservation),
      cancel,
      access,
      performance,
      adapter,
    );
    const svc = new ConditionalService(
      db,
      access,
      partialOrders,
      cancel,
      app.futures,
    );
    await price(s, '99', 0, 0);
    await svc.evaluate(id);
    assert.equal((await group(id)).status, 'active');
    assert.equal(
      (
        await db.position.findUniqueOrThrow({ where: { id: p.id } })
      ).quantity.toFixed(8),
      '6.00000000',
    );
    await svc.evaluate(id);
    assert.equal(
      (
        await db.position.findUniqueOrThrow({ where: { id: p.id } })
      ).quantity.toFixed(8),
      '2.00000000',
    );
    await svc.evaluate(id);
    assert.equal((await group(id)).status, 'completed');
    const children = (await group(id)).children;
    assert.deepEqual(
      children.map((c) => c.quantity.toFixed()),
      ['10', '6', '2'],
    );
    assert.equal(
      (
        await db.seasonParticipant.findUniqueOrThrow({
          where: { tradingAccountId: s.accountId },
        })
      ).totalFillCount,
      3,
    );
    pass(
      'ERS partial Market exits retain OCO until actual remainder reaches flat',
    );
  } finally {
    await release(s);
  }
}

async function fractionalProtectedStock() {
  for (const market of ['KRX', 'NAS'] as const) {
    const s = await fixture('season');
    try {
      tradingSessions.set(await now(), undefined, ['KRX', 'US']);
      await fxEvidence();
      const currencyCode = market === 'KRX' ? 'KRW' : 'USD';
      await db.asset.update({
        where: { id: s.instruments[0].asset.id },
        data: {
          market,
          assetType: market === 'KRX' ? 'domestic_stock' : 'us_stock',
          currencyCode,
          priceCurrency: currencyCode,
          settlementCurrency: currencyCode,
        },
      });
      const p = await db.position.create({
        data: {
          tradingAccountId: s.accountId,
          assetId: s.instruments[0].asset.id,
          quantity: '10',
          averageCost: '100',
          currencyCode,
        },
      });
      await stockOrCryptoPrice(s, '100');
      const id = await protect(s, 'spot', p.id, [
        leg('stop_loss', 'limit'),
        leg('take_profit', 'limit'),
      ]);
      await sell(s, '0.5');
      assert.equal(
        (
          await db.position.findUniqueOrThrow({ where: { id: p.id } })
        ).quantity.toFixed(),
        '9.5',
      );
      const normal = {
        assetId: s.instruments[0].asset.id,
        side: 'sell',
        orderType: 'limit',
        quantity: '9.5',
        limitPrice: '102',
        protectionChildId: 'forged-http-field',
      };
      await assert.rejects(
        orders.quoteOrderForTradingAccount(s.userId, s.accountId, normal),
        (e) =>
          e instanceof HttpException &&
          JSON.stringify(e.getResponse()).includes(
            'FRACTIONAL_LIMIT_ORDER_NOT_SUPPORTED',
          ),
      );
      await stockOrCryptoPrice(s, '101');
      await conditional.evaluate(id);
      const child = (await group(id)).children[0];
      assert.equal(child.quantity.toFixed(), '9.5');
      assert.equal(
        (
          await db.position.findUniqueOrThrow({ where: { id: p.id } })
        ).reservedQuantity.toFixed(),
        '9.5',
      );
      assert.equal(
        (await settleLimit(s, child.orderId!, '103')).state,
        'filled',
      );
      assert.equal((await group(id)).status, 'completed');
      pass(
        `${market} manual fractional reduce -> whole remaining protected Limit; normal Limit still integer-only`,
      );
    } finally {
      tradingSessions.reset();
      await release(s);
    }
  }
}

async function marketOcoAndIncrease() {
  for (const domain of ['spot', 'futures'] as const)
    for (const kind of ['stop_loss', 'take_profit'] as const) {
      const s = await fixture('season');
      try {
        await fresh(s);
        const p =
          domain === 'spot'
            ? await createSpot(s, '10')
            : (
                await app.futures.execute(
                  s.userId,
                  s.accountId,
                  openBody(s, { leverage: 1 }),
                )
              ).data.position;
        const id = await protect(s, domain, p.id, [
          leg('stop_loss', 'market'),
          leg('take_profit', 'market'),
        ]);
        if (domain === 'futures') {
          await fresh(s);
          await app.futures.execute(
            s.userId,
            s.accountId,
            await positionBody(s, 'increase', { quantity: '0.25' }),
          );
        } else {
          const body = {
            assetId: s.instruments[0].asset.id,
            side: 'buy',
            orderType: 'market',
            amount: '100',
          };
          const quote = await orders.quoteOrderForTradingAccount(
            s.userId,
            s.accountId,
            body,
          );
          await orders.createOrderForTradingAccount(s.userId, s.accountId, {
            ...body,
            quoteId: quote.data.quoteId,
            idempotencyKey: randomUUID(),
          });
        }
        const before = (
          await db.seasonParticipant.findUniqueOrThrow({
            where: { tradingAccountId: s.accountId },
          })
        ).totalFillCount;
        await price(s, kind === 'stop_loss' ? '99' : '101', 0, 0);
        await conditional.evaluate(id);
        const g = await group(id);
        assert.equal(g.status, 'completed');
        assert.equal(g.children.length, 1);
        assert.equal(
          g.children[0].quantity.toFixed(),
          domain === 'spot' ? '11' : '1.25',
        );
        const read = await conditional.list(s.userId, s.accountId, {
          domain,
          history: 'true',
        });
        const row = read.data.groups.find((g) => g.id === id)!;
        assert.equal(row.legs.find((l) => l.kind === kind)!.state, 'completed');
        assert.equal(row.legs.find((l) => l.kind !== kind)!.state, 'canceled');
        assert.equal(
          (
            await db.seasonParticipant.findUniqueOrThrow({
              where: { tradingAccountId: s.accountId },
            })
          ).totalFillCount,
          before + 1,
        );
        pass(
          `${domain} ${kind} Market fill completes OCO; armed increase extends whole-position protection`,
        );
      } finally {
        await release(s);
      }
    }
}
async function spotRollback() {
  for (const attached of [false, true]) {
    const s = await fixture('season');
    try {
      await fresh(s);
      const point = attached
          ? 'protectionGroup.create'
          : 'protectionGroup.updateMany',
        broken = faultyDb(point);
      const svcOrders = new OrdersService(
        broken,
        undefined,
        new LimitOrderCreateService(broken, reservation),
        new LimitOrderCancelService(broken, reservation),
        new TradingAccountAccessService(broken),
        performance,
      );
      if (attached) {
        const payload = {
          assetId: s.instruments[0].asset.id,
          side: 'buy',
          orderType: 'limit',
          amount: '100',
          limitPrice: '100',
        };
        const quote = await orders.quoteOrderForTradingAccount(
          s.userId,
          s.accountId,
          payload,
        );
        const body = {
          ...payload,
          quoteId: quote.data.quoteId,
          idempotencyKey: randomUUID(),
          attachedProtection: [leg('stop_loss', 'market')],
        };
        await assert.rejects(
          svcOrders.createOrderForTradingAccount(s.userId, s.accountId, body),
        );
        assert.equal(
          await db.order.count({ where: { tradingAccountId: s.accountId } }),
          0,
        );
        assert.equal(
          await db.protectionGroup.count({
            where: { tradingAccountId: s.accountId },
          }),
          0,
        );
        assert.equal(
          (
            await db.cashWallet.findUniqueOrThrow({
              where: { id: s.spotWalletId },
            })
          ).reservedAmount.toFixed(),
          '0',
        );
        await orders.createOrderForTradingAccount(s.userId, s.accountId, body);
      } else {
        const p = await createSpot(s);
        const id = await protect(s, 'spot', p.id, [
          leg('take_profit', 'market'),
          leg('stop_loss', 'market'),
        ]);
        const cash = (
          await db.cashWallet.findUniqueOrThrow({
            where: { id: s.spotWalletId },
          })
        ).balanceAmount;
        const svc = new ConditionalService(
          db,
          access,
          svcOrders,
          cancel,
          app.futures,
        );
        await price(s, '101', 0, 0);
        await assert.rejects(svc.evaluate(id));
        assert.ok(
          (
            await db.cashWallet.findUniqueOrThrow({
              where: { id: s.spotWalletId },
            })
          ).balanceAmount.eq(cash),
        );
        assert.equal(
          (
            await db.position.findUniqueOrThrow({ where: { id: p.id } })
          ).quantity.toFixed(),
          '10',
        );
        assert.equal(
          await db.order.count({ where: { tradingAccountId: s.accountId } }),
          0,
        );
        assert.equal(
          await db.walletTransaction.count({
            where: { tradingAccountId: s.accountId },
          }),
          0,
        );
        assert.equal((await group(id)).children[0].status, 'pending');
        assert.equal(
          (
            await db.seasonParticipant.findUniqueOrThrow({
              where: { tradingAccountId: s.accountId },
            })
          ).totalFillCount,
          0,
        );
        await conditional.evaluate(id);
        assert.equal((await group(id)).status, 'completed');
      }
      pass(
        `Spot ${attached ? 'attached parent reservation' : 'Market cash/position/ledger/count'} rollback and same-command retry`,
      );
    } finally {
      await release(s);
    }
  }
}

async function inactiveAccountCleanup() {
  for (const mode of ['general', 'season'] as const) {
    const s = await fixture(mode);
    try {
      await fresh(s);
      const p = await createSpot(s);
      const id = await protect(s, 'spot', p.id, [leg('take_profit', 'limit')]);
      await price(s, '101', 0, 0);
      await conditional.evaluate(id);
      const child = (await group(id)).children[0];
      assert.ok(child.orderId);
      assert.equal(
        (
          await db.position.findUniqueOrThrow({ where: { id: p.id } })
        ).reservedQuantity.toFixed(),
        '10',
      );
      const ledgerCount = await db.walletTransaction.count({
        where: { tradingAccountId: s.accountId },
      });
      if (mode === 'general')
        await db.tradingAccount.update({
          where: { id: s.accountId },
          data: { status: 'closed' },
        });
      else
        await db.seasonParticipant.update({
          where: { tradingAccountId: s.accountId },
          data: { participantStatus: 'excluded' },
        });
      const expectedReason =
        mode === 'general' ? 'account_not_tradable' : 'participant_excluded';
      assert.equal(
        (await conditional.evaluate(id)).state,
        'lifecycle_canceled',
      );
      const result = await group(id);
      assert.equal(result.status, 'canceled');
      assert.equal(result.terminalReason, expectedReason);
      assert.equal(result.children[0].status, 'canceled');
      const order = await db.order.findUniqueOrThrow({
        where: { id: child.orderId },
      });
      assert.equal(order.status, 'canceled');
      assert.equal(order.cancelReason, expectedReason);
      const remaining = await db.position.findUniqueOrThrow({
        where: { id: p.id },
      });
      assert.equal(remaining.quantity.toFixed(), '10');
      assert.equal(remaining.reservedQuantity.toFixed(), '0');
      assert.equal(
        await db.walletTransaction.count({
          where: { tradingAccountId: s.accountId },
        }),
        ledgerCount,
      );
      if (mode === 'season')
        assert.equal(
          (
            await db.seasonParticipant.findUniqueOrThrow({
              where: { tradingAccountId: s.accountId },
            })
          ).totalFillCount,
          0,
        );
      assert.equal((await conditional.evaluate(id)).state, 'terminal');
      pass(
        `${mode} inactive lifecycle cancels child once, releases reservation and preserves accurate reason without fill`,
      );
    } finally {
      await release(s);
    }
  }
}

async function main() {
  await db.$connect();
  try {
    await matrix();
    await oco();
    await sourceAndModes();
    await attachedEntries();
    await stockCoverage();
    await races();
    await rollback();
    await spotRaces();
    await commandsAndConflicts();
    await invalidEvidence();
    await partialMarket();
    await fractionalProtectedStock();
    await marketOcoAndIncrease();
    await spotRollback();
    await inactiveAccountCleanup();
    console.log(`Conditional PostgreSQL PASS ${checks} checks`);
  } finally {
    await db.fxRateSnapshot.deleteMany({
      where: { id: { in: fxEvidenceIds } },
    });
    await db.$disconnect();
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
