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
  positionBody,
} from './futures-integration';
import {
  practiceFoundation,
  practiceOrder,
  practiceServices,
} from './lib/beginner-quest-practice';
import { assertBeginnerLearningAccess } from '../src/trading-accounts/beginner-learning-policy';
import { FuturesLimitService } from '../src/futures/futures-limit.service';
import { FuturesConditionalEntryService } from '../src/futures/futures-conditional-entry.service';
import { FuturesLiquidationService } from '../src/futures/futures-liquidation.service';

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
process.env.FUTURES_CONDITIONAL_ENTRY_ENABLED = 'true';
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
  const mark = async (value = '100') => {
    const at = await now();
    await db.futuresMarkSnapshot.createMany({
      data: s.instruments.map(({ instrument, asset }) => ({
        instrumentId: instrument.id,
        symbol: asset.symbol,
        source: 'binance_usdm_mark_ws',
        price: value,
        effectiveAt: at,
        capturedAt: at,
      })),
      skipDuplicates: true,
    });
  };
  const fresh = async () => {
    await fxEvidence();
    await spotPrice(s, '100', 0, 0);
    await price(s, '100', 0, 0);
    await price(s, '100', 1, 0);
    await mark();
  };
  /** The staged permissions that are open, sorted (B차, 2026-10-18). */
  const opened = (permissions: Record<string, boolean>) =>
    Object.entries(permissions)
      .filter(([, allowed]) => allowed)
      .map(([action]) => action)
      .sort();
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
    await price(other, '100', 1, 0);
    const secondMarkAt = await now();
    await db.futuresMarkSnapshot.create({
      data: {
        instrumentId: other.instruments[1].instrument.id,
        symbol: other.instruments[1].asset.symbol,
        price: '100',
        source: 'binance_usdm_mark_ws',
        capturedAt: secondMarkAt,
        effectiveAt: secondMarkAt,
      },
    });
    const acceptedLimit = await entries.create(other.userId, other.accountId, {
      instrumentId: other.instruments[1].instrument.id,
      direction: 'long',
      marginMode: 'isolated',
      leverage: 2,
      quantity: '1',
      limitPrice: '90',
      idempotencyKey: randomUUID(),
    });
    const watches = new FuturesConditionalEntryService(
      db,
      app.access,
      app.futures,
      entries,
    );
    const acceptedWatch = await watches.create(other.userId, other.accountId, {
      instrumentId: other.instruments[0].instrument.id,
      direction: 'long',
      marginMode: 'isolated',
      leverage: 2,
      quantity: '1',
      triggerCondition: 'at_or_above',
      triggerPrice: '120',
      executionType: 'market',
      idempotencyKey: randomUUID(),
    });
    const reserved = (
      await db.cashWallet.findUniqueOrThrow({
        where: { id: other.futuresWalletId },
      })
    ).reservedAmount.toFixed(8);
    assert.equal(
      Number(reserved) > 0,
      true,
      'the accepted limit actually reserves collateral',
    );
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
        await db.cashWallet.findUniqueOrThrow({
          where: { id: other.futuresWalletId },
        })
      ).reservedAmount.toFixed(8),
      reserved,
    );
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
    // Already accepted limits keep their reservation and fill policy under the new lock.
    await price(other, '80', 1, 0);
    assert.equal(
      (await entries.evaluate(acceptedLimit.data.order.id)).state,
      'executed',
    );
    assert.equal(
      (
        await db.cashWallet.findUniqueOrThrow({
          where: { id: other.futuresWalletId },
        })
      ).reservedAmount.toFixed(8),
      '0.00000000',
    );
    const filled = await db.futuresPosition.findFirstOrThrow({
      where: {
        tradingAccountId: other.accountId,
        instrumentId: other.instruments[1].instrument.id,
        status: 'open',
      },
    });
    await app.futures.execute(other.userId, other.accountId, {
      instrumentId: filled.instrumentId,
      positionId: filled.id,
      operation: 'close',
      direction: 'long',
      leverage: 2,
      marginMode: 'isolated',
      quantity: '1',
      idempotencyKey: randomUUID(),
    });
    checks++;
    // A reservation-free watch rechecks learning access when it actually triggers.
    const beforeWatch = await db.futuresExecution.count({
      where: { tradingAccountId: other.accountId },
    });
    await price(other, '120', 0, 0);
    assert.equal(
      (await watches.evaluate(acceptedWatch.data.entry.id)).state,
      'BEGINNER_FEATURE_LOCKED',
    );
    const failedWatch = await db.futuresConditionalEntry.findUniqueOrThrow({
      where: { id: acceptedWatch.data.entry.id },
    });
    assert.deepEqual(
      [failedWatch.status, failedWatch.failureCode],
      ['failed', 'BEGINNER_FEATURE_LOCKED'],
    );
    assert.equal(
      await db.futuresExecution.count({
        where: { tradingAccountId: other.accountId },
      }),
      beforeWatch,
    );
    checks++;
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
        // Staged access: QUEST 06 is not every trade (B차, 2026-10-18).
        assert.equal(p.learningPermissions.allTrading, false);
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
    // B차 (2026-10-18): QUEST 06 is the foundation, not every trade. Only the
    // four market practices open; the legacy key keeps its QUEST 06 meaning.
    await fresh();
    const six = await read();
    assert.equal(six.learningAccess.allTrading, true);
    assert.deepEqual(opened(six.learningPermissions), [
      'exchange',
      'futuresLongOpen',
      'futuresShortOpen',
      'fxTransfer',
      'krStockMarketBuy',
      'transfer',
      'usStockMarketBuy',
    ]);
    // Passed practice and later order types: refused by the real commands.
    for (const body of [buy, limit])
      await rejects(
        app.orders.quoteOrderForTradingAccount(s.userId, s.accountId, body),
        'BEGINNER_FEATURE_LOCKED',
      );
    await rejects(
      app.conditionalSell.create(s.userId, s.accountId, {
        kind: 'protection',
        assetId,
        stopLoss: {
          triggerPrice: '80',
          executionType: 'market',
          quantity: '0.1',
        },
        idempotencyKey: randomUUID(),
      }),
      'BEGINNER_FEATURE_LOCKED',
    );
    await rejects(
      new FuturesLimitService(db, app.access, app.futures).create(
        s.userId,
        s.accountId,
        {
          instrumentId: s.instruments[0].instrument.id,
          direction: 'long',
          marginMode: 'isolated',
          leverage: 2,
          quantity: '1',
          limitPrice: '90',
          idempotencyKey: randomUUID(),
        },
      ),
      'BEGINNER_FEATURE_LOCKED',
    );
    // Another user's account is never a way around the lock.
    await rejects(
      app.orders.quoteOrderForTradingAccount(s.userId, other.accountId, buy),
      'TRADING_ACCOUNT_NOT_FOUND',
    );
    checks++;
    // Short first: no dependency on Long or either stock quest.
    for (const direction of ['short', 'long'] as const) {
      await fresh();
      const index = direction === 'short' ? 9 : 8;
      // A practice open counts only above 1x, so 1x is refused.
      await rejects(
        app.futures.execute(
          s.userId,
          s.accountId,
          openBody(s, { direction, leverage: 1, marginMode: 'isolated' }),
        ),
        'BEGINNER_FEATURE_LOCKED',
      );
      if (direction === 'long') {
        // A liquidated practice never counts and never blocks a retry.
        const liquidated = await app.futures.execute(
          s.userId,
          s.accountId,
          openBody(s, { direction, leverage: 2, marginMode: 'isolated' }),
        );
        await mark('0.01');
        assert.equal(
          (
            await new FuturesLiquidationService(db).liquidate(
              s.accountId,
              liquidated.data.position.id,
            )
          ).state,
          'liquidated',
        );
        const retry = await read();
        assert.equal(retry.quests[index].status, 'not_started');
        assert.equal(retry.learningPermissions.futuresLongOpen, true);
        await fresh();
      }
      const position = await app.futures.execute(
        s.userId,
        s.accountId,
        openBody(s, { direction, leverage: 2, marginMode: 'isolated' }),
      );
      const inProgress = await read();
      assert.equal(inProgress.quests[index].status, 'in_progress');
      // While it is open: no second open in this direction, no increase; the
      // other Futures quest and the stock quests stay independent.
      await rejects(
        app.futures.execute(
          s.userId,
          s.accountId,
          openBody(s, {
            direction,
            leverage: 2,
            marginMode: 'isolated',
            instrumentId: s.instruments[1].instrument.id,
          }),
        ),
        'BEGINNER_FEATURE_LOCKED',
      );
      await rejects(
        app.futures.execute(
          s.userId,
          s.accountId,
          await positionBody(s, 'increase', { quantity: '0.5' }),
        ),
        'BEGINNER_FEATURE_LOCKED',
      );
      assert.equal(
        inProgress.learningPermissions[
          direction === 'short' ? 'futuresLongOpen' : 'futuresShortOpen'
        ],
        direction === 'short',
      );
      assert.equal(inProgress.learningPermissions.krStockMarketBuy, true);
      // Reduce and close stay risk reduction.
      const partial = await app.futures.execute(s.userId, s.accountId, {
        instrumentId: s.instruments[0].instrument.id,
        positionId: position.data.position.id,
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
        positionId: position.data.position.id,
        direction,
        leverage: 2,
        marginMode: 'isolated',
        operation: 'close',
        quantity: '0.75',
        idempotencyKey: randomUUID(),
      });
      assert.equal((await read()).quests[index].status, 'completed');
      assert.equal((await read()).quests[6].status, 'not_started');
      // A completed direction waits for every quest.
      await fresh();
      await rejects(
        app.futures.execute(
          s.userId,
          s.accountId,
          openBody(s, { direction, leverage: 2, marginMode: 'isolated' }),
        ),
        'BEGINNER_FEATURE_LOCKED',
      );
      checks++;
    }
    // US first; use real trading validators with the existing deterministic calendar fixture.
    const stock: Record<'us_stock' | 'domestic_stock', string> = {
      us_stock: '',
      domestic_stock: '',
    };
    for (const [type, market, currency, source] of [
      ['us_stock', 'NASDAQ', 'USD', 'kis_us_delayed_trade'],
      ['domestic_stock', 'KRX', 'KRW', 'koscom_krx_realtime_price'],
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
      stock[type] = asset.id;
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
    }
    // QUEST 08 with a known key: its committed create replays after the lock.
    await fxEvidence();
    const usBody = {
      assetId: stock.us_stock,
      side: 'buy',
      orderType: 'market',
      quantity: '1',
    };
    const usQuote = await app.orders.quoteOrderForTradingAccount(
      s.userId,
      s.accountId,
      usBody,
    );
    const usCreate = {
      ...usBody,
      quoteId: usQuote.data.quoteId,
      idempotencyKey: randomUUID(),
    };
    const usOrder = await app.orders.createOrderForTradingAccount(
      s.userId,
      s.accountId,
      usCreate,
    );
    const usDone = await read();
    assert.equal(usDone.quests[7].status, 'completed');
    assert.equal(usDone.quests[6].status, 'not_started');
    assert.equal(usDone.learningPermissions.usStockMarketBuy, false);
    // A second US BUY is refused; the committed command still replays as is.
    await rejects(
      app.orders.quoteOrderForTradingAccount(s.userId, s.accountId, usBody),
      'BEGINNER_FEATURE_LOCKED',
    );
    const ordersBefore = await db.order.count({
      where: { tradingAccountId: s.accountId },
    });
    const replayed = await app.orders.createOrderForTradingAccount(
      s.userId,
      s.accountId,
      usCreate,
    );
    assert.equal(replayed.data.order.orderId, usOrder.data.order.orderId);
    assert.equal(
      await db.order.count({ where: { tradingAccountId: s.accountId } }),
      ordersBefore,
    );
    // The holding: a user's own limit SELL waits for every quest, a market
    // SELL stays risk reduction.
    await rejects(
      app.orders.quoteOrderForTradingAccount(s.userId, s.accountId, {
        ...usBody,
        side: 'sell',
        orderType: 'limit',
        limitPrice: '120',
      }),
      'BEGINNER_FEATURE_LOCKED',
    );
    const sold = await practiceOrder(app, s.userId, s.accountId, {
      ...usBody,
      side: 'sell',
    });
    assert.equal(sold.data.order.status, 'executed');
    checks++;
    await practiceOrder(app, s.userId, s.accountId, {
      assetId: stock.domestic_stock,
      side: 'buy',
      orderType: 'market',
      quantity: '1',
    });
    const all = await read();
    assert.equal(all.quests[6].status, 'completed');
    assert.equal(
      all.quests.every((q) => q.status === 'completed'),
      true,
    );
    // Every quest complete: the ordinary trading opens, by the same commands.
    assert.equal(Object.values(all.learningPermissions).every(Boolean), true);
    await fresh();
    await practiceOrder(app, s.userId, s.accountId, buy);
    await app.orders.quoteOrderForTradingAccount(s.userId, s.accountId, limit);
    await app.orders.quoteOrderForTradingAccount(s.userId, s.accountId, {
      assetId: stock.domestic_stock,
      side: 'sell',
      orderType: 'limit',
      limitPrice: '120',
      quantity: '1',
    });
    const unlocked = await app.futures.execute(
      s.userId,
      s.accountId,
      openBody(s, { leverage: 1, marginMode: 'isolated' }),
    );
    await app.futures.execute(
      s.userId,
      s.accountId,
      await positionBody(s, 'increase', { quantity: '0.5' }),
    );
    await app.futures.execute(s.userId, s.accountId, {
      ...(await positionBody(s, 'close')),
      positionId: unlocked.data.position.id,
      quantity: '1.5',
    });
    checks++;
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
    await db.futuresConditionalEntry.deleteMany({ where: otherWhere });
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
