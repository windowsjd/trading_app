import { tradingSessions } from '../test/support/trading-session-fixture';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import {
  db,
  fixture,
  cleanup,
  now,
  price,
  spotPrice,
  fxEvidence,
  fxEvidenceIds,
  openBody,
} from './futures-integration';
import {
  practiceFoundation,
  practiceOrder,
  practiceServices,
} from './lib/beginner-quest-practice';
import { assertBeginnerLearningAccess } from '../src/trading-accounts/beginner-learning-policy';
import { FuturesLimitService } from '../src/futures/futures-limit.service';

const target = new URL(process.env.DATABASE_URL ?? 'http://invalid');
const disposableDatabase =
  target.pathname.endsWith('_test') ||
  (process.env.GITHUB_ACTIONS === 'true' && target.pathname === '/trading_app');
if (
  process.env.NODE_ENV !== 'test' ||
  process.env.BEGINNER_ACCOUNT_DB_INTEGRATION !== '1' ||
  !['localhost', '127.0.0.1'].includes(target.hostname) ||
  !disposableDatabase
)
  throw new Error('Disposable local test database opt-in required');
// Isolated subprocess fixtures only; application/default configuration is untouched.
process.env.LIMIT_ORDER_ENABLED = 'true';
process.env.CONDITIONAL_ORDERS_ENABLED = 'true';
// New OCO groups are retired by default (2026-10-16); this runner keeps
// covering the legacy OCO engine behind the compatibility flag.
process.env.LEGACY_OCO_REGISTRATION_ENABLED = 'true';
process.env.INDEPENDENT_TP_SL_ORDERS_ENABLED = 'true';
process.env.CONDITIONAL_SELL_ORDERS_ENABLED = 'true';
process.env.FUTURES_TRADING_MODE = 'ENABLED';
process.env.FUTURES_RISK_ENGINE_ENABLED = 'true';
async function rejects(work: Promise<unknown>, code: string) {
  try {
    await work;
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    assert.equal(
      (error.getResponse() as { error: { code: string } }).error.code,
      code,
    );
    return;
  }
  assert.fail(`Expected ${code}`);
}
let checks = 0;
async function main() {
  await db.$connect();
  const s = await fixture('beginner', '10000', true);
  const other = await fixture('general');
  // QUEST 04 through an independent stop-loss instead of the OCO protection.
  const u = await fixture('beginner', '10000', true);
  const stocks: string[] = [];
  const account = { id: s.accountId, mode: 'beginner' };
  const app = practiceServices(db);
  const read = async () =>
    (await app.quests.getQuestProgress(s.userId, s.accountId)).data;
  const assetId = s.instruments[0].asset.id;
  const buy = { assetId, side: 'buy', orderType: 'market', amount: '100' };
  const limit = { ...buy, orderType: 'limit', limitPrice: '90' };
  const fresh = async () => {
    await fxEvidence();
    await spotPrice(s, '100', 0, 0);
    await price(s, '100', 0, 0);
    const at = await now();
    await db.futuresMarkSnapshot.createMany({
      data: [
        {
          instrumentId: s.instruments[0].instrument.id,
          symbol: s.instruments[0].asset.symbol,
          source: 'binance_usdm_mark_ws',
          price: '100',
          effectiveAt: at,
          capturedAt: at,
        },
      ],
      skipDuplicates: true,
    });
  };
  try {
    await fresh();
    await rejects(
      app.orders.quoteOrderForTradingAccount(s.userId, s.accountId, buy),
      'BEGINNER_FEATURE_LOCKED',
    );
    await rejects(
      app.quests.acknowledge(s.userId, s.accountId, {
        stepId: 'holdings_reviewed',
        orderId: 'invented',
      }),
      'BEGINNER_QUEST_PREREQUISITE',
    );
    await rejects(
      app.quests.getQuestProgress(other.userId, s.accountId),
      'TRADING_ACCOUNT_NOT_FOUND',
    );
    const entries = new FuturesLimitService(db, app.access, app.futures);
    await rejects(
      entries.create(s.userId, s.accountId, {
        instrumentId: s.instruments[0].instrument.id,
        direction: 'long',
        marginMode: 'isolated',
        leverage: 2,
        quantity: '1',
        limitPrice: '90',
        idempotencyKey: randomUUID(),
      }),
      'BEGINNER_FEATURE_LOCKED',
    );
    // Legacy exposure may predate learning locks. Every existing safety action
    // still follows the actual settlement/cancellation services before Q1.
    await spotPrice(other, '100', 0, 0);
    const otherAssetId = other.instruments[0].asset.id;
    await practiceOrder(app, other.userId, other.accountId, {
      assetId: otherAssetId,
      side: 'buy',
      orderType: 'market',
      amount: '100',
    });
    const pending = await practiceOrder(app, other.userId, other.accountId, {
      assetId: otherAssetId,
      side: 'buy',
      orderType: 'limit',
      amount: '90',
      limitPrice: '90',
    });
    const holding = await db.position.findFirstOrThrow({
      where: { tradingAccountId: other.accountId, assetId: otherAssetId },
    });
    const protection = await app.conditional.create(
      other.userId,
      other.accountId,
      {
        domain: 'spot',
        assetId: otherAssetId,
        positionId: holding.id,
        idempotencyKey: randomUUID(),
        legs: [
          {
            kind: 'take_profit',
            triggerPrice: '120',
            childOrderType: 'market',
          },
          { kind: 'stop_loss', triggerPrice: '80', childOrderType: 'market' },
        ],
      },
    );
    const markAt = await now();
    await db.futuresMarkSnapshot.create({
      data: {
        instrumentId: other.instruments[0].instrument.id,
        symbol: other.instruments[0].asset.symbol,
        price: '100',
        source: 'binance_usdm_mark_ws',
        capturedAt: markAt,
        effectiveAt: markAt,
      },
    });
    const legacyPosition = await app.futures.execute(
      other.userId,
      other.accountId,
      openBody(other, { leverage: 2, marginMode: 'isolated' }),
    );
    await db.tradingAccount.update({
      where: { id: other.accountId },
      data: { mode: 'beginner' },
    });
    assert.equal(
      (
        await app.quests.getQuestProgress(other.userId, other.accountId)
      ).data.quests.some((q) => q.status !== 'not_started'),
      false,
    );
    await app.orders.cancelOrderForTradingAccount(
      other.userId,
      other.accountId,
      pending.data.order.orderId,
    );
    await app.conditional.cancelGroup(
      other.userId,
      other.accountId,
      (protection as { data: { groupId: string } }).data.groupId,
      { idempotencyKey: randomUUID() },
    );
    await practiceOrder(app, other.userId, other.accountId, {
      assetId: otherAssetId,
      side: 'sell',
      orderType: 'market',
      quantity: holding.quantity.toFixed(8),
    });
    await app.futures.execute(other.userId, other.accountId, {
      instrumentId: other.instruments[0].instrument.id,
      positionId: legacyPosition.data.position.id,
      operation: 'close',
      direction: 'long',
      leverage: 2,
      marginMode: 'isolated',
      quantity: '1',
      idempotencyKey: randomUUID(),
    });
    assert.equal(
      (await app.quests.getQuestProgress(other.userId, other.accountId)).data
        .learningAccess.allTrading,
      false,
    );
    await rejects(
      app.quests.acknowledge(s.userId, s.accountId, {
        stepId: 'holdings_reviewed',
        orderId: pending.data.order.orderId,
      }),
      'BEGINNER_QUEST_PREREQUISITE',
    );
    checks++;
    await practiceFoundation(
      db,
      s.userId,
      s.accountId,
      assetId,
      async (stage) => {
        await fresh();
        const p = await read();
        const count =
          stage === 21 ? 2 : stage === 51 || stage === 52 ? 5 : stage;
        assert.equal(
          p.quests.slice(0, 6).filter((q) => q.status === 'completed').length,
          count,
        );
        assert.equal(p.learningAccess.allTrading, stage === 6);
        if (stage < 6 || stage > 6) {
          await rejects(
            assertBeginnerLearningAccess(db, account, 'allTrading'),
            'BEGINNER_FEATURE_LOCKED',
          );
          await rejects(
            app.futures.execute(
              s.userId,
              s.accountId,
              openBody(s, { leverage: 2 }),
            ),
            'BEGINNER_FEATURE_LOCKED',
          );
        }
        if ([0, 1, 2, 21, 3, 4].includes(stage))
          await rejects(
            app.orders.quoteOrderForTradingAccount(
              s.userId,
              s.accountId,
              limit,
            ),
            'BEGINNER_FEATURE_LOCKED',
          );
        if (stage === 21) {
          assert.equal(p.quests[2].status, 'in_progress');
          await rejects(
            assertBeginnerLearningAccess(db, account, 'spotProtection'),
            'BEGINNER_FEATURE_LOCKED',
          );
        }
        if (stage === 51) {
          const id = p.quests[5].steps[0].referenceId!;
          await rejects(
            app.quests.acknowledge(s.userId, s.accountId, {
              stepId: 'limit_result_reviewed',
              orderId: id,
            }),
            'BEGINNER_QUEST_EVIDENCE_REQUIRED',
          );
        }
        if (stage === 52)
          assert.equal(
            p.quests[5].status,
            'in_progress',
            'cancellation alone is not UI review',
          );
        await new Promise((resolve) => setTimeout(resolve, 5)); // Distinct persisted millisecond evidence instants.
        checks++;
      },
    );
    const completed = await read();
    const counts = async () =>
      Promise.all([
        db.order.count({ where: { tradingAccountId: s.accountId } }),
        db.walletTransaction.count({
          where: { tradingAccountId: s.accountId },
        }),
        db.beginnerQuestAcknowledgement.count({
          where: { tradingAccountId: s.accountId },
        }),
      ]);
    const before = await counts();
    assert.deepEqual(await read(), completed);
    assert.deepEqual(await counts(), before);
    for (const [index, stepId] of [
      [2, 'holdings_reviewed'],
      [5, 'limit_result_reviewed'],
    ] as const) {
      await app.quests.acknowledge(s.userId, s.accountId, {
        stepId,
        orderId: completed.quests[index].steps[0].referenceId,
      });
    }
    assert.deepEqual(await read(), completed);
    assert.deepEqual(await counts(), before);
    // The learned capability never overrides operational flags.
    process.env.LIMIT_ORDER_ENABLED = 'false';
    await rejects(
      app.orders.quoteOrderForTradingAccount(s.userId, s.accountId, limit),
      'LIMIT_ORDER_DISABLED',
    );
    process.env.LIMIT_ORDER_ENABLED = 'true';
    process.env.FUTURES_TRADING_MODE = 'DISABLED';
    await rejects(
      app.futures.execute(s.userId, s.accountId, openBody(s, { leverage: 2 })),
      'FUTURES_TRADING_DISABLED',
    );
    process.env.FUTURES_TRADING_MODE = 'ENABLED';
    // Short first: no dependency on Long or either stock quest.
    for (const direction of ['short', 'long'] as const) {
      await fresh();
      const opened = await app.futures.execute(
        s.userId,
        s.accountId,
        openBody(s, { direction, leverage: 2, marginMode: 'isolated' }),
      );
      const index = direction === 'short' ? 9 : 8;
      assert.equal((await read()).quests[index].status, 'in_progress');
      const partial = await app.futures.execute(s.userId, s.accountId, {
        instrumentId: s.instruments[0].instrument.id,
        positionId: opened.data.position.id,
        direction,
        leverage: 2,
        marginMode: 'isolated',
        operation: 'reduce',
        quantity: '0.25',
        idempotencyKey: randomUUID(),
      });
      assert.equal(partial.data.position.quantity, '0.75000000');
      assert.equal((await read()).quests[index].status, 'in_progress');
      await app.futures.execute(s.userId, s.accountId, {
        instrumentId: s.instruments[0].instrument.id,
        positionId: opened.data.position.id,
        direction,
        leverage: 2,
        marginMode: 'isolated',
        operation: 'close',
        quantity: '0.75',
        idempotencyKey: randomUUID(),
      });
      assert.equal((await read()).quests[index].status, 'completed');
      assert.equal((await read()).quests[6].status, 'not_started');
      checks++;
    }
    // US first; use real trading validators with the existing deterministic calendar fixture.
    for (const [type, market, currency, index, source] of [
      ['us_stock', 'NASDAQ', 'USD', 7, 'kis_us_delayed_trade'],
      ['domestic_stock', 'KRX', 'KRW', 6, 'koscom_krx_realtime_price'],
    ] as const) {
      const asset = await db.asset.create({
        data: {
          assetType: type,
          market,
          symbol: `Q${randomUUID().slice(0, 7)}`,
          name: 'Quest integration fixture',
          currencyCode: currency,
          priceCurrency: currency,
          settlementCurrency: currency,
        },
      });
      stocks.push(asset.id);
      const at = await now();
      tradingSessions.set(at, new Date(at.getTime() + 86400000), ['KRX', 'US']);
      await db.assetPriceSnapshot.create({
        data: {
          assetId: asset.id,
          price: '100',
          currencyCode: currency,
          sourceType: 'provider_api',
          sourceName: source,
          effectiveAt: at,
          capturedAt: at,
        },
      });
      await practiceOrder(app, s.userId, s.accountId, {
        assetId: asset.id,
        side: 'buy',
        orderType: 'market',
        quantity: '1',
      });
      assert.equal((await read()).quests[index].status, 'completed');
      if (index === 7)
        assert.equal((await read()).quests[6].status, 'not_started');
      checks++;
    }
    assert.equal(
      (await read()).quests.every((q) => q.status === 'completed'),
      true,
    );
    // QUEST 04 via the order screen's stop-loss/take-profit setting: crypto
    // TP/SL opens at the TP/SL step (a user condition stays locked), one
    // stop-loss proves the quest, and its automatic sale is not QUEST 05.
    const uAssetId = u.instruments[0].asset.id;
    const uRead = async () =>
      (await app.quests.getQuestProgress(u.userId, u.accountId)).data;
    const uFresh = async () => {
      await fxEvidence();
      await spotPrice(u, '100', 0, 0);
    };
    let settingId = '';
    await practiceFoundation(
      db,
      u.userId,
      u.accountId,
      uAssetId,
      async (stage, practice) => {
        await uFresh();
        const stopLoss = {
          kind: 'protection',
          assetId: uAssetId,
          stopLoss: {
            triggerPrice: '80',
            executionType: 'market',
            quantity: '0.1',
          },
          idempotencyKey: randomUUID(),
        };
        if (stage === 21)
          await rejects(
            practice.conditionalSell.create(u.userId, u.accountId, stopLoss),
            'BEGINNER_FEATURE_LOCKED',
          );
        if (stage === 3)
          await rejects(
            practice.conditionalSell.create(u.userId, u.accountId, {
              kind: 'condition',
              assetId: uAssetId,
              triggerCondition: 'at_or_below',
              triggerPrice: '80',
              executionType: 'market',
              quantity: '0.1',
              idempotencyKey: randomUUID(),
            }),
            'BEGINNER_FEATURE_LOCKED',
          );
        if (stage === 4) {
          const p = await uRead();
          assert.equal(p.quests[3].status, 'completed');
          const row = await db.conditionalSellOrder.findFirstOrThrow({
            where: { tradingAccountId: u.accountId, kind: 'stop_loss' },
          });
          settingId = row.id;
          assert.equal(p.quests[3].steps[0].referenceId, row.id);
          // The stop-loss fires and sells its half automatically.
          await spotPrice(u, '79', 0, 0);
          assert.equal(
            (await practice.conditionalSell.evaluate(row.id)).state,
            'ordered',
          );
          const after = await uRead();
          assert.equal(after.quests[4].status, 'not_started');
          assert.equal(after.learningAccess.cryptoLimitBuy, false);
          await uFresh();
        }
        if (stage === 5)
          assert.equal((await uRead()).quests[4].status, 'completed');
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
      { protection: 'independent' },
    );
    assert.ok(settingId);
    assert.equal(
      (await uRead()).quests.slice(0, 6).every((q) => q.status === 'completed'),
      true,
    );
    checks++;
    assert.equal(
      await db.beginnerQuestAcknowledgement.count({
        where: { tradingAccountId: s.accountId },
      }),
      2,
    );
    console.log(
      `beginner full quest DB integration passed (${checks} staged/independent practice checks)`,
    );
  } finally {
    tradingSessions.reset();
    const uWhere = { tradingAccountId: u.accountId };
    await db.beginnerQuestAcknowledgement.deleteMany({ where: uWhere });
    await db.conditionalSellOrder.deleteMany({ where: uWhere });
    await db.walletTransaction.deleteMany({ where: uWhere });
    await db.order.deleteMany({ where: uWhere });
    await db.position.deleteMany({ where: uWhere });
    await db.dailyPortfolioSnapshot.deleteMany({ where: uWhere });
    await cleanup(u);
    const where = { tradingAccountId: s.accountId };
    await db.beginnerQuestAcknowledgement.deleteMany({ where });
    await db.protectionChild.deleteMany({ where: { group: where } });
    await db.protectionLeg.deleteMany({ where: { group: where } });
    await db.protectionGroup.deleteMany({ where });
    await db.protectionCommand.deleteMany({ where });
    await db.walletTransaction.deleteMany({ where });
    await db.order.deleteMany({ where });
    await db.position.deleteMany({ where });
    await db.dailyPortfolioSnapshot.deleteMany({ where });
    await cleanup(s);
    const otherWhere = { tradingAccountId: other.accountId };
    await db.protectionLeg.deleteMany({ where: { group: otherWhere } });
    await db.protectionGroup.deleteMany({ where: otherWhere });
    await db.protectionCommand.deleteMany({ where: otherWhere });
    await db.walletTransaction.deleteMany({ where: otherWhere });
    await db.order.deleteMany({ where: otherWhere });
    await db.position.deleteMany({ where: otherWhere });
    await db.dailyPortfolioSnapshot.deleteMany({ where: otherWhere });
    await cleanup(other);
    await db.assetPriceSnapshot.deleteMany({
      where: { assetId: { in: stocks } },
    });
    await db.asset.deleteMany({ where: { id: { in: stocks } } });
  }
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
