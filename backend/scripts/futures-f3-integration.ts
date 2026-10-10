import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import {
  db,
  app,
  fixture,
  newInstrument,
  now,
  price,
  spotPrice,
  untilDb,
  fxEvidence,
  fxEvidenceIds,
  openBody,
  cleanup,
  faultyDb,
  code,
  type Scenario,
} from './futures-integration';
import { FUTURES_FINAL_LAST_WINDOW_MS } from '../src/futures/futures-last-price';
import { PrismaService } from '../src/prisma/prisma.service';
import { futuresDecimal as d } from '../src/futures/futures-math';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { GeneralAccountPerformanceService } from '../src/portfolio/general-account-performance.service';
import { GeneralExternalFundingService } from '../src/portfolio/general-external-funding.service';
import {
  FuturesSeasonSettlementService,
  planSeasonFuturesExit,
} from '../src/futures/futures-season-settlement.service';
import { FuturesLiquidationService } from '../src/futures/futures-liquidation.service';
import { SeasonSettlementJobService } from '../src/batch/season-settlement-job.service';
import { BatchService } from '../src/batch/batch.service';
import { RankingRefreshService } from '../src/ranking/ranking-refresh.service';
import { buildDailyPortfolioSnapshotData } from '../src/portfolio/daily-portfolio-snapshot-generation';
import { GeneralDailySnapshotJobService } from '../src/batch/general-daily-snapshot-job.service';
import { AdRewardService } from '../src/ad-rewards/ad-reward.service';
import { AdRewardVerificationRegistry } from '../src/ad-rewards/ad-reward-verifier';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import { TradingAccountPortfolioService } from '../src/portfolio/trading-account-portfolio.service';
import type { FuturesExecuteBody } from '../src/futures/futures-input';

if (
  process.env.NODE_ENV !== 'test' ||
  process.env.FUTURES_F3_DB_INTEGRATION !== '1'
)
  throw new Error('F3 disposable PostgreSQL opt-in required');
process.env.FUTURES_TRADING_MODE = 'ENABLED';
process.env.FUTURES_RISK_ENGINE_ENABLED = 'true';
const valuation = new PortfolioValuationService(db);
const performance = new GeneralAccountPerformanceService(
  db,
  valuation,
  new GeneralExternalFundingService(db),
);
const final = new FuturesSeasonSettlementService(db);
const liquidator = new FuturesLiquidationService(db);
let checks = 0;
const pass = (label: string) => {
  checks++;
  console.log(`PASS F3 ${label}`);
};
async function mark(s: Scenario, value = '100', index = 0, at?: Date) {
  const t = at ?? (await now());
  const i = s.instruments[index];
  await db.futuresMarkSnapshot.createMany({
    data: [
      {
        instrumentId: i.instrument.id,
        symbol: i.asset.symbol,
        source: 'binance_usdm_mark_ws',
        price: value,
        effectiveAt: t,
        capturedAt: t,
      },
    ],
    skipDuplicates: true,
  });
}
async function fresh(s: Scenario) {
  await fxEvidence();
  for (let i = 0; i < s.instruments.length; i++) {
    await price(s, '100', i, 0);
    await mark(s, '100', i);
  }
}
async function open(s: Scenario, patch: FuturesExecuteBody = {}) {
  return app.futures.execute(s.userId, s.accountId, openBody(s, patch));
}
async function release(s: Scenario) {
  const where = { tradingAccountId: s.accountId };
  await db.adRewardClaim.deleteMany({ where });
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
/** A Futures Last trade received exactly at endAt for each listed instrument. */
async function lastAt(
  s: Scenario,
  value: string,
  index: number,
  at: Date,
  source:
    | 'binance_usdm_agg_trade_ws'
    | 'binance_usdm_ticker_price_rest' = 'binance_usdm_agg_trade_ws',
) {
  return db.futuresLastPriceSnapshot.create({
    data: {
      instrumentId: s.instruments[index].instrument.id,
      symbol: s.instruments[index].asset.symbol,
      price: value,
      source,
      effectiveAt: at,
      capturedAt: at,
    },
  });
}
async function end(s: Scenario, values: string[]) {
  const endAt = await now();
  for (let i = 0; i < values.length; i++) {
    await lastAt(s, values[i], i, endAt);
    // Same-underlying Spot at the boundary must neither price nor leak into the exit.
    await db.assetPriceSnapshot.create({
      data: {
        assetId: s.instruments[i].asset.id,
        price: '777',
        currencyCode: 'USD',
        sourceType: 'provider_api',
        sourceName: 'binance_spot_ws_ticker',
        effectiveAt: endAt,
        capturedAt: endAt,
        rawPayloadJson: { fixtureOnly: 'provider-payload-must-not-be-public' },
      },
    });
  }
  await db.season.update({
    where: { id: s.season!.id },
    data: { status: 'ended', endAt },
  });
  return endAt;
}
async function wallet(s: Scenario) {
  return db.cashWallet.findUniqueOrThrow({ where: { id: s.futuresWalletId } });
}
async function evidence(s: Scenario) {
  return JSON.stringify({
    wallet: await wallet(s),
    positions: await db.futuresPosition.findMany({
      where: { tradingAccountId: s.accountId },
      orderBy: { id: 'asc' },
    }),
    events: await db.futuresSeasonSettlement.findMany({
      where: { tradingAccountId: s.accountId },
    }),
    closes: await db.futuresSeasonClose.findMany({
      where: { tradingAccountId: s.accountId },
    }),
    ledger: await db.walletTransaction.findMany({
      where: { tradingAccountId: s.accountId },
      orderBy: { id: 'asc' },
    }),
  });
}
async function valuationTransitions() {
  for (const mode of ['general', 'season'] as const)
    for (const direction of ['long', 'short'] as const)
      for (const marginMode of ['isolated', 'cross'] as const)
        for (const leverage of [1, 37, 100]) {
          const s = await fixture(mode);
          try {
            await fresh(s);
            const before = await valuation.calculateTradingAccountValuation(
              s.accountId,
              await now(),
            );
            const o = await open(s, { direction, marginMode, leverage });
            const after = await valuation.calculateTradingAccountValuation(
              s.accountId,
              await now(),
            );
            assert.equal(
              after.totalAssetKrw,
              d(before.totalAssetKrw)
                .sub(d(o.data.execution.feeAmount).mul(1400))
                .toFixed(8),
            );
            await delay(2);
            await mark(s, direction === 'long' ? '110' : '90');
            const profit = await valuation.calculateTradingAccountValuation(
              s.accountId,
              await now(),
            );
            assert.equal(profit.futuresUnrealizedPnlUsd, '10.00000000');
            assert.equal(
              profit.totalAssetKrw,
              d(after.totalAssetKrw).add(14000).toFixed(8),
            );
            // Open marks are economic observations, regardless of initial margin/leverage.
            await delay(2);
            await mark(s, direction === 'long' ? '90' : '110');
            assert.equal(
              (
                await valuation.calculateTradingAccountValuation(
                  s.accountId,
                  await now(),
                )
              ).futuresUnrealizedPnlUsd,
              '-10.00000000',
            );
            await delay(2);
            await mark(s, '100');
            const positionId = o.data.position.id;
            const body = {
              ...openBody(s, { direction, marginMode, leverage }),
              positionId,
            };
            await open(s, { ...body, operation: 'increase', quantity: '1' });
            await delay(2);
            await mark(s, direction === 'long' ? '110' : '90');
            const reduced = await open(s, {
              ...body,
              operation: 'reduce',
              quantity: '0.5',
              idempotencyKey: randomUUID(),
            });
            assert.equal(reduced.data.position.quantity, '1.50000000');
            assert.equal(
              (
                await valuation.calculateTradingAccountValuation(
                  s.accountId,
                  await now(),
                )
              ).futuresUnrealizedPnlUsd,
              '15.00000000',
            );
            const current = await db.tradingAccount.findUniqueOrThrow({
              where: { id: s.accountId },
              include: { seasonParticipant: true },
            });
            if (mode === 'general') {
              const live = await performance.resolveLivePerformance({
                account: current,
                valuationAt: await now(),
              });
              assert.ok(live.advance.timeWeightedReturnFactor.gt(0));
              assert.equal(
                live.valuation.futuresUnrealizedPnlUsd,
                '15.00000000',
              );
            }
            await open(s, {
              ...body,
              operation: 'close',
              quantity: '1.5',
              idempotencyKey: randomUUID(),
            });
            const closed = await valuation.calculateTradingAccountValuation(
              s.accountId,
              await now(),
            );
            assert.equal(closed.futuresUnrealizedPnlUsd, '0.00000000');
            const snap = await db.equitySnapshot.findFirstOrThrow({
              where: { tradingAccountId: s.accountId },
              orderBy: { capturedAt: 'desc' },
            });
            assert.ok(snap.futuresUnrealizedPnlUsd!.eq(0));
            assert.equal(snap.totalAssetKrw.toFixed(8), closed.totalAssetKrw);
            pass(
              `${mode} ${direction} ${marginMode} ${leverage}x valuation/open fee/increase/reduce/Spot-Mark basis/close/history`,
            );
          } finally {
            await release(s);
          }
        }
}
async function staleAndGeneration() {
  const s = await fixture('season');
  try {
    await fresh(s);
    await open(s, { marginMode: 'cross' });
    await db.futuresMarkSnapshot.deleteMany({
      where: { instrumentId: s.instruments[0].instrument.id },
    });
    await mark(s, '110', 0, new Date(+(await now()) - 5001));
    await assert.rejects(
      valuation.calculateTradingAccountValuation(s.accountId, await now()),
      /Mark Price/,
    );
    const p = await db.futuresPosition.findFirstOrThrow({
      where: { tradingAccountId: s.accountId, status: 'open' },
    });
    await open(s, {
      positionId: p.id,
      marginMode: p.marginMode,
      operation: 'close',
      quantity: p.quantity.toFixed(8),
    });
    assert.equal(
      (
        await valuation.calculateTradingAccountValuation(
          s.accountId,
          await now(),
        )
      ).futuresUnrealizedPnlUsd,
      '0.00000000',
    );
    pass('fresh Spot + stale Mark fails valuation but allows close');
    await fresh(s);
    await open(s, { marginMode: 'cross' });
    const time = await now();
    const cache = {
      client: db,
      valuationAtMs: +time,
      workflow: 'live_portfolio_valuation' as const,
      assetPrices: new Map(),
    };
    const v1 = await valuation.calculateTradingAccountValuation(
      s.accountId,
      time,
      'live_portfolio_valuation',
      db,
      cache,
    );
    await mark(s, '120', 0, new Date(+time - 1));
    const v2 = await valuation.calculateTradingAccountValuation(
      s.accountId,
      time,
      'live_portfolio_valuation',
      db,
      cache,
    );
    assert.equal(v1.futuresUnrealizedPnlUsd, v2.futuresUnrealizedPnlUsd);
    const data = buildDailyPortfolioSnapshotData({
      valuation: v2,
      capturedAt: time,
      snapshotDate: new Date(time.toISOString().slice(0, 10)),
      tradingAccountId: s.accountId,
      dryRun: false,
    });
    const daily = await db.dailyPortfolioSnapshot.create({ data });
    assert.ok(daily.futuresUnrealizedPnlUsd!.eq(v2.futuresUnrealizedPnlUsd!));
    const ranker = new RankingRefreshService(db, valuation);
    await ranker.refreshCurrentRankingForSeason(s.season!.id, {
      capturedAt: await now(),
    });
    pass('generation reuses Mark evidence and durable daily component');
  } finally {
    await release(s);
  }
}
async function finalCases() {
  for (const direction of ['long', 'short'] as const)
    for (const marginMode of ['isolated', 'cross'] as const)
      for (const value of ['110', '90']) {
        const s = await fixture('season');
        try {
          await fresh(s);
          await open(s, { direction, marginMode });
          const before = (await wallet(s)).balanceAmount;
          const endAt = await end(s, [value]);
          await delay(2);
          await price(s, '999', 0, 0); // A newer post-end price cannot hide the boundary.
          const preview = await final.settleSeason(s.season!.id, true);
          assert.equal(
            await db.futuresSeasonSettlement.count({
              where: { tradingAccountId: s.accountId },
            }),
            0,
          );
          await final.settleSeason(s.season!.id);
          const e = await db.futuresSeasonSettlement.findUniqueOrThrow({
            where: { tradingAccountId: s.accountId },
            include: { closes: { include: { price: true } } },
          });
          const economic = d(value)
            .sub(100)
            .mul(direction === 'long' ? 1 : -1);
          assert.ok(e.realizedPnl.eq(economic));
          assert.ok(e.feeAmount.eq(d(value).mul('0.002')));
          assert.ok(e.walletBalanceAfter.eq(preview.get(s.accountId)!));
          assert.ok(e.walletBalanceAfter.eq(before.add(e.settledCash)));
          assert.equal(+e.closes[0].price.endAt, +endAt);
          assert.equal(
            e.closes[0].executionPrice.toFixed(8),
            d(value).toFixed(8),
          );
          const first = await evidence(s);
          const view = await app.futures.finalSettlement(s.userId, s.accountId);
          assert.equal(view.data.tradingAccountId, s.accountId);
          assert.ok(view.data.settlement);
          assert.ok(!JSON.stringify(view).includes('rawPayloadJson'));
          assert.ok(
            !JSON.stringify(view).includes(
              'provider-payload-must-not-be-public',
            ),
          );
          await assert.rejects(
            app.futures.finalSettlement(randomUUID(), s.accountId),
            (error) => code(error) === 'TRADING_ACCOUNT_NOT_FOUND',
          );
          assert.equal(await evidence(s), first);
          await final.settleSeason(s.season!.id);
          assert.equal(await evidence(s), first);
          assert.equal(
            await db.futuresLiquidation.count({
              where: { tradingAccountId: s.accountId },
            }),
            0,
          );
          assert.equal(e.closes[0].price.assetPriceSnapshotId, null);
          assert.ok(e.closes[0].price.lastPriceSnapshotId);
          pass(
            `final ${direction} ${marginMode} Last=${value} (Spot 777 ignored) preview/exact endAt/fee/shortfall/retry`,
          );
        } finally {
          await release(s);
        }
      }
}
async function mixedFinal() {
  const s = await fixture('season', '100');
  try {
    s.instruments.push(await newInstrument());
    await fresh(s);
    await open(s, { quantity: '10', leverage: 100 });
    await open(s, {
      instrumentId: s.instruments[1].instrument.id,
      direction: 'short',
      marginMode: 'cross',
      quantity: '10',
      leverage: 100,
    });
    await open(s, {
      instrumentId: s.instruments[2].instrument.id,
      direction: 'long',
      marginMode: 'cross',
      quantity: '10',
      leverage: 100,
    });
    await end(s, ['1', '400', '1']);
    const before = (await wallet(s)).balanceAmount;
    await Promise.all([
      final.settleSeason(s.season!.id),
      final.settleSeason(s.season!.id),
    ]);
    const event = await db.futuresSeasonSettlement.findUniqueOrThrow({
      where: { tradingAccountId: s.accountId },
      include: { closes: true },
    });
    assert.equal(event.closes.length, 3);
    assert.ok(event.walletBalanceAfter.eq(0));
    assert.ok(event.settledCash.eq(before.neg()));
    assert.ok(event.realizedPnl.eq('-4980'));
    assert.ok(
      event.bankruptcyShortfall.eq(
        event.settledCash.sub(event.realizedPnl).add(event.feeAmount),
      ),
    );
    assert.equal(
      await db.walletTransaction.count({
        where: {
          tradingAccountId: s.accountId,
          referenceType: 'futures_season_settlement',
        },
      }),
      2,
    );
    assert.equal(
      await db.futuresPosition.count({
        where: { tradingAccountId: s.accountId, status: 'open' },
      }),
      0,
    );
    pass(
      'mixed three-position bankruptcy / duplicate final workers / one atomic scope settlement',
    );
  } finally {
    await release(s);
  }
}
async function jobAndFaults() {
  const s = await fixture('season');
  try {
    await fresh(s);
    await open(s, { marginMode: 'cross' });
    const endAt = await end(s, ['110']);
    const before = await evidence(s);
    const faults = [
      'futuresSeasonSettlement.create',
      'futuresPosition.update',
      'futuresSeasonClose.create',
      'cashWallet.updateMany',
      'walletTransaction.createMany',
    ];
    // Pin phase succeeds independently; account failures must leave all cash/lifetimes/evidence unchanged.
    await final.settleSeason(s.season!.id, true);
    for (const path of faults) {
      const faulty = faultyDb(path);
      await assert.rejects(
        new FuturesSeasonSettlementService(faulty).settleSeason(s.season!.id),
      );
      assert.equal(await evidence(s), before);
      pass(`atomic final rollback ${path}`);
    }
    const jobs = new SeasonSettlementJobService(
      new BatchService(db),
      db,
      valuation,
      final,
    );
    const input = {
      seasonId: s.season!.id,
      settlementDate: endAt.toISOString().slice(0, 10),
      idempotencyKey: `f3-${randomUUID()}`,
    };
    await jobs.run(input);
    assert.equal(
      (await db.season.findUniqueOrThrow({ where: { id: s.season!.id } }))
        .status,
      'settled',
    );
    assert.equal(
      await db.futuresPosition.count({
        where: { tradingAccountId: s.accountId, status: 'open' },
      }),
      0,
    );
    const e = await db.futuresSeasonSettlement.findUniqueOrThrow({
      where: { tradingAccountId: s.accountId },
    });
    const rank = await db.seasonRanking.findFirstOrThrow({
      where: { tradingAccountId: s.accountId, rankType: 'final' },
    });
    const finalV = await valuation.calculateTradingAccountValuation(
      s.accountId,
      endAt,
      'season_settlement',
    );
    assert.equal(rank.totalAssetKrw.toFixed(8), finalV.totalAssetKrw);
    assert.ok(e.feeRate.eq('0.002'));
    const first = await evidence(s);
    await jobs.run({ ...input, idempotencyKey: `f3-${randomUUID()}` });
    assert.equal(await evidence(s), first);
    pass(
      'Season pipeline closes before final ranking/tier/closed/settled; idempotent new job retry',
    );
  } finally {
    await release(s);
  }
  const missing = await fixture('season');
  try {
    await fxEvidence();
    for (let i = 0; i < missing.instruments.length; i++)
      await mark(missing, '100', i);
    // The newest trade is received 9s before the open, so by endAt it lies
    // outside the 10s boundary window. Evidence is immutable: real time passes.
    await db.futuresLastPriceSnapshot.deleteMany({
      where: { instrumentId: missing.instruments[0].instrument.id },
    });
    const lastTrade = await price(missing, '100', 0, 9000);
    await open(missing);
    await untilDb(+lastTrade.capturedAt + FUTURES_FINAL_LAST_WINDOW_MS + 1);
    const endAt = await end(missing, []);
    // Fresh Spot and Mark at the boundary are never a substitute.
    await spotPrice(missing, '100', 0, 0);
    await mark(missing, '100', 0, endAt);
    await assert.rejects(
      final.settleSeason(missing.season!.id),
      (e) => code(e) === 'FUTURES_FINAL_PRICE_UNAVAILABLE',
    );
    // A receipt after endAt is never applied retroactively.
    await untilDb(+endAt + 2);
    await price(missing, '100', 0, 0);
    await assert.rejects(
      final.settleSeason(missing.season!.id),
      (e) => code(e) === 'FUTURES_FINAL_PRICE_UNAVAILABLE',
    );
    assert.equal(
      await db.futuresSeasonPrice.count({
        where: { seasonId: missing.season!.id },
      }),
      0,
    );
    assert.equal(
      (await db.season.findUniqueOrThrow({ where: { id: missing.season!.id } }))
        .status,
      'ended',
    );
    assert.equal(
      await db.futuresPosition.count({
        where: { tradingAccountId: missing.accountId, status: 'open' },
      }),
      1,
    );
    pass(
      'missing bounded end evidence leaves Season ended, position and cash intact',
    );
  } finally {
    await release(missing);
  }
}
async function race() {
  const s = await fixture('season');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    await fresh(s);
    await open(s, { leverage: 100 });
    await mark(s, '50');
    const p = await db.futuresPosition.findFirstOrThrow({
      where: { tradingAccountId: s.accountId, status: 'open' },
    });
    // Season end is held ahead of the liquidation's authorization lock.
    await client.query('BEGIN');
    const endAt = await now();
    await lastAt(s, '100', 0, endAt);
    await client.query(
      "UPDATE seasons SET status='ended', end_at=$1 WHERE id=$2",
      [endAt.toISOString(), s.season!.id],
    );
    const pending = liquidator.liquidate(s.accountId, p.id);
    const userCommands = ['close', 'increase'].map((operation) =>
      open(s, {
        positionId: p.id,
        operation,
        leverage: 100,
      }).then(() => 'unexpected success', code),
    );
    await delay(40);
    await client.query('COMMIT');
    assert.equal((await pending).state, 'lifecycle_blocked');
    for (const rejected of await Promise.all(userCommands))
      assert.equal(rejected, 'SEASON_NOT_ACTIVE');
    await Promise.all([
      final.settleSeason(s.season!.id),
      final.settleSeason(s.season!.id),
    ]);
    assert.equal(
      await db.futuresLiquidation.count({
        where: { tradingAccountId: s.accountId },
      }),
      0,
    );
    assert.equal(
      await db.futuresSeasonClose.count({
        where: { tradingAccountId: s.accountId },
      }),
      1,
    );
    pass(
      'real PG lock: Season end wins liquidation/user close/increase; duplicate final worker settles once',
    );
  } finally {
    await client.end();
    await release(s);
  }
  const before = await fixture('season');
  try {
    await fresh(before);
    await open(before, { leverage: 100 });
    await delay(2);
    await mark(before, '50');
    const p = await db.futuresPosition.findFirstOrThrow({
      where: { tradingAccountId: before.accountId, status: 'open' },
    });
    assert.equal(
      (await liquidator.liquidate(before.accountId, p.id)).state,
      'liquidated',
    );
    await end(before, []);
    await final.settleSeason(before.season!.id);
    assert.equal(
      await db.futuresSeasonClose.count({
        where: { tradingAccountId: before.accountId },
      }),
      0,
    );
    pass('liquidation commits before end: final exit never double settles');
  } finally {
    await release(before);
  }
}
async function generalFundingAndHistory() {
  const s = await fixture('general');
  const access = new TradingAccountAccessService(db);
  const portfolio = new TradingAccountPortfolioService(
    db,
    access,
    performance,
    valuation,
  );
  const live = async () =>
    performance.resolveLivePerformance({
      account: await db.tradingAccount.findUniqueOrThrow({
        where: { id: s.accountId },
        include: { seasonParticipant: true },
      }),
      valuationAt: await now(),
    });
  try {
    await fresh(s);
    const opened = await open(s, { marginMode: 'cross' });
    await mark(s, '110');
    const before = await live();
    await app.transfer.transfer(s.userId, s.accountId, {
      sourceWalletId: s.futuresWalletId,
      destinationWalletId: s.spotWalletId,
      amount: '100',
      idempotencyKey: randomUUID(),
    });
    const transferred = await live();
    assert.equal(
      transferred.valuation.totalAssetKrw,
      before.valuation.totalAssetKrw,
    );
    assert.ok(
      transferred.advance.timeWeightedReturnFactor.eq(
        before.advance.timeWeightedReturnFactor,
      ),
    );
    const quote = await app.composite.quote(s.userId, s.accountId, {
      sourceWalletId: s.futuresWalletId,
      destinationWalletId: s.krwWalletId,
      amount: '50',
    });
    await app.composite.execute(s.userId, s.accountId, {
      quoteId: quote.data.quoteId,
      idempotencyKey: randomUUID(),
    });
    const exchanged = await live();
    assert.ok(
      d(exchanged.valuation.totalAssetKrw).lt(
        transferred.valuation.totalAssetKrw,
      ),
    );
    assert.ok(
      exchanged.advance.timeWeightedReturnFactor.lt(
        transferred.advance.timeWeightedReturnFactor,
      ),
    );
    assert.equal(
      await db.adRewardClaim.count({
        where: { tradingAccountId: s.accountId },
      }),
      0,
    );
    Object.assign(process.env, {
      AD_REWARD_ENABLED: 'true',
      AD_REWARD_PROVIDER: 'f3-test',
      AD_REWARD_AMOUNT_KRW: '1000',
      AD_REWARD_DAILY_MAX_COUNT: '10',
      AD_REWARD_DAILY_MAX_AMOUNT_KRW: '1000000',
      AD_REWARD_COOLDOWN_SECONDS: '0',
      AD_REWARD_DAY_TIME_ZONE: 'UTC',
    });
    const reward = new AdRewardService(
      db,
      access,
      new AdRewardVerificationRegistry([
        {
          provider: 'f3-test',
          async verify(request) {
            return {
              ok: true,
              provider: 'f3-test',
              providerEventId: request.proof,
              occurredAt: new Date(),
              metadata: { source: 'fake' },
            };
          },
        },
      ]),
      performance,
    );
    await reward.claim(s.userId, s.accountId, {
      provider: 'f3-test',
      proof: randomUUID(),
      idempotencyKey: randomUUID(),
    });
    const funded = await live();
    assert.equal(
      funded.valuation.totalAssetKrw,
      d(exchanged.valuation.totalAssetKrw).add(1000).toFixed(8),
    );
    assert.ok(
      funded.advance.timeWeightedReturnFactor.eq(
        exchanged.advance.timeWeightedReturnFactor,
      ),
    );
    const boundaries = await db.equitySnapshot.findMany({
      where: {
        tradingAccountId: s.accountId,
        snapshotReason: {
          in: ['external_funding_before', 'external_funding_after'],
        },
      },
      orderBy: { capturedAt: 'asc' },
    });
    assert.equal(boundaries.length, 2);
    for (const row of boundaries)
      assert.ok(row.futuresUnrealizedPnlUsd!.eq(10));
    assert.ok(
      boundaries[1]
        .cumulativeExternalFundingKrw!.sub(
          boundaries[0].cumulativeExternalFundingKrw!,
        )
        .eq(1000),
    );
    const job = new GeneralDailySnapshotJobService(
      new BatchService(db),
      db,
      performance,
    );
    await job.run({
      snapshotDate: (await now()).toISOString().slice(0, 10),
      idempotencyKey: randomUUID(),
    });
    const daily = await db.dailyPortfolioSnapshot.findFirstOrThrow({
      where: { tradingAccountId: s.accountId },
    });
    assert.ok(daily.futuresUnrealizedPnlUsd!.eq(10));
    assert.ok(daily.totalAssetKrw.eq(funded.valuation.totalAssetKrw));
    for (const range of ['1d', 'all']) {
      const response = await portfolio.getEquity(s.userId, s.accountId, {
        range,
      });
      assert.ok(JSON.stringify(response).includes('futuresUnrealizedPnlUsd'));
    }
    await open(s, {
      marginMode: 'cross',
      positionId: opened.data.position.id,
      operation: 'close',
      quantity: '1',
    });
    assert.equal(
      (await live()).valuation.futuresUnrealizedPnlUsd,
      '0.00000000',
    );
    // A second, isolated lifetime proves bankruptcy cash + zero UPNL feeds TWR.
    await fresh(s);
    const second = await open(s, { leverage: 100 });
    await mark(s, '1');
    assert.equal(
      (await liquidator.liquidate(s.accountId, second.data.position.id)).state,
      'liquidated',
    );
    const after = await live();
    assert.equal(after.valuation.futuresUnrealizedPnlUsd, '0.00000000');
    assert.ok((await wallet(s)).balanceAmount.gte(0));
    assert.ok(
      after.advance.timeWeightedReturnFactor.lt(
        funded.advance.timeWeightedReturnFactor,
      ),
    );
    pass(
      'General Mark TWR / internal USD and FX transfer / external funding neutral boundary / daily and 1d-all history / close and bankruptcy liquidation',
    );
  } finally {
    await release(s);
  }
}

async function multiAccountRetry() {
  const accounts = [
    await fixture('season'),
    await fixture('season'),
    await fixture('season'),
  ];
  const [a, b, excluded] = accounts;
  try {
    for (const s of accounts) {
      if (s !== a)
        await db.seasonParticipant.update({
          where: { tradingAccountId: s.accountId },
          data: { seasonId: a.season!.id },
        });
      await fresh(a);
      await open(s, {
        instrumentId: a.instruments[0].instrument.id,
        marginMode: s === a ? 'isolated' : 'cross',
        direction: s === b ? 'short' : 'long',
      });
    }
    await db.seasonParticipant.update({
      where: { tradingAccountId: excluded.accountId },
      data: { participantStatus: 'excluded' },
    });
    const ranker = new RankingRefreshService(db, valuation);
    const currentRanks = () =>
      db.seasonRanking.findMany({
        where: { seasonId: a.season!.id, rankType: 'daily' },
        orderBy: { rank: 'asc' },
      });
    await mark(a, '110');
    await ranker.refreshCurrentRankingForSeason(a.season!.id, {
      capturedAt: await now(),
      createEquitySnapshots: true,
    });
    assert.equal((await currentRanks())[0].tradingAccountId, a.accountId);
    await mark(a, '90');
    await ranker.refreshCurrentRankingForSeason(a.season!.id, {
      capturedAt: await now(),
      createEquitySnapshots: true,
    });
    const lower = await currentRanks();
    assert.equal(lower.length, 2);
    assert.equal(lower[0].tradingAccountId, b.accountId);
    assert.ok(
      lower.find((r) => r.tradingAccountId === a.accountId)!.maxDrawdown.gt(0),
    );
    await db.futuresMarkSnapshot.deleteMany({
      where: { instrumentId: a.instruments[0].instrument.id },
    });
    await assert.rejects(
      ranker.refreshCurrentRankingForSeason(a.season!.id, {
        capturedAt: await now(),
        createEquitySnapshots: true,
      }),
    );
    assert.deepEqual(await currentRanks(), lower);
    await mark(a, '100');
    pass(
      'Season Long/Short Isolated/Cross Mark moves ranking and drawdown; excluded omitted; missing Mark keeps the previous generation intact',
    );
    const endAt = await end(a, ['110']);
    let subjects = 0;
    const partial = new FuturesSeasonSettlementService(db);
    const original = partial.settleAccount.bind(partial);
    partial.settleAccount = async (...args) => {
      if (++subjects === 2) throw new Error('f3 partial account batch');
      return original(...args);
    };
    const input = {
      seasonId: a.season!.id,
      settlementDate: endAt.toISOString().slice(0, 10),
      idempotencyKey: randomUUID(),
    };
    await assert.rejects(
      new SeasonSettlementJobService(
        new BatchService(db),
        db,
        valuation,
        partial,
      ).run(input),
    );
    const where = {
      tradingAccountId: { in: accounts.map((s) => s.accountId) },
    };
    assert.equal(await db.futuresSeasonSettlement.count({ where }), 1);
    assert.equal(
      await db.futuresPosition.count({ where: { ...where, status: 'open' } }),
      2,
    );
    assert.equal(
      await db.seasonRanking.count({
        where: { seasonId: a.season!.id, rankType: 'final' },
      }),
      0,
    );
    assert.equal(
      (await db.season.findUniqueOrThrow({ where: { id: a.season!.id } }))
        .status,
      'ended',
    );
    // A backfilled competing boundary row cannot reprice the remaining accounts.
    await lastAt(a, '999', 0, endAt, 'binance_usdm_ticker_price_rest');
    const jobs = new SeasonSettlementJobService(
      new BatchService(db),
      db,
      valuation,
      final,
    );
    await jobs.run({ ...input, idempotencyKey: randomUUID() });
    assert.equal(
      await db.futuresPosition.count({ where: { ...where, status: 'open' } }),
      0,
    );
    const closes = await db.futuresSeasonClose.findMany({ where });
    assert.equal(closes.length, 3);
    assert.equal(new Set(closes.map((r) => r.priceId)).size, 1);
    for (const row of closes) assert.ok(row.executionPrice.eq(110));
    assert.equal(
      await db.seasonRanking.count({
        where: { seasonId: a.season!.id, rankType: 'final' },
      }),
      2,
    );
    for (const s of accounts)
      assert.equal(
        (
          await db.tradingAccount.findUniqueOrThrow({
            where: { id: s.accountId },
          })
        ).status,
        'closed',
      );
    const first = await Promise.all(accounts.map(evidence));
    await jobs.run({ ...input, idempotencyKey: randomUUID() });
    assert.deepEqual(await Promise.all(accounts.map(evidence)), first);
    pass(
      'partial Season batch retry pins one Spot price across accounts, closes excluded accounts, publishes final ranking only after all exits',
    );
  } finally {
    await release(excluded);
    await release(b);
    await release(a);
  }
}

async function mixedScopeAndMidwayRollback() {
  const s = await fixture('season', '100');
  try {
    s.instruments.push(await newInstrument());
    await fresh(s);
    await open(s, { quantity: '10', leverage: 100 });
    for (const i of [1, 2])
      await open(s, {
        instrumentId: s.instruments[i].instrument.id,
        marginMode: 'cross',
        quantity: '10',
        leverage: 100,
      });
    const endAt = await end(s, ['110', '1', '1']);
    const before = await evidence(s);
    await assert.rejects(
      new FuturesSeasonSettlementService(
        faultyDb('futuresSeasonClose.create', 2),
      ).settleSeason(s.season!.id),
    );
    assert.equal(await evidence(s), before);
    const positions = await db.futuresPosition.findMany({
      where: { tradingAccountId: s.accountId, status: 'open' },
    });
    const pins = await db.futuresSeasonPrice.findMany({
      where: { seasonId: s.season!.id },
      include: { snapshot: true, lastPriceSnapshot: true },
    });
    const prices = new Map(pins.map((p) => [p.instrumentId, p]));
    const w = await wallet(s);
    const forward = planSeasonFuturesExit(
      w,
      positions,
      prices,
      endAt,
      d('0.002'),
    );
    const reverse = planSeasonFuturesExit(
      w,
      [...positions].reverse(),
      prices,
      endAt,
      d('0.002'),
    );
    assert.ok(forward.settledCash.eq(reverse.settledCash));
    assert.ok(forward.bankruptcyShortfall.eq(reverse.bankruptcyShortfall));
    await final.settleSeason(s.season!.id);
    const event = await db.futuresSeasonSettlement.findUniqueOrThrow({
      where: { tradingAccountId: s.accountId },
    });
    assert.ok(event.walletBalanceAfter.eq('107.8')); // protected 10 + isolated profit 100 - normal fee 2.2
    assert.ok(event.bankruptcyShortfall.gt(0));
    pass(
      'mixed profitable Isolated cannot subsidize bankrupt Cross; iteration invariant; failure after second close rolls back all three',
    );
  } finally {
    await release(s);
  }
}

/** A Season pinned with Spot evidence before the switch keeps that pin: the
 * retry re-verifies and reuses it, even when Futures Last at endAt differs. */
async function legacySpotPinRetry() {
  const s = await fixture('season');
  try {
    await fresh(s);
    await open(s);
    const endAt = await now();
    await lastAt(s, '110', 0, endAt);
    const spot = await db.assetPriceSnapshot.create({
      data: {
        assetId: s.instruments[0].asset.id,
        price: '120',
        currencyCode: 'USD',
        sourceType: 'provider_api',
        sourceName: 'binance_spot_ws_ticker',
        effectiveAt: endAt,
        capturedAt: endAt,
      },
    });
    const season = await db.season.update({
      where: { id: s.season!.id },
      data: { status: 'ended', endAt },
    });
    const pin = await db.futuresSeasonPrice.create({
      data: {
        seasonId: season.id,
        instrumentId: s.instruments[0].instrument.id,
        assetPriceSnapshotId: spot.id,
        endAt,
        feeRate: season.tradeFeeRate,
      },
    });
    // A pin holding both evidence kinds (or neither) is rejected by the DB.
    const last = await db.futuresLastPriceSnapshot.findFirstOrThrow({
      where: {
        instrumentId: s.instruments[0].instrument.id,
        capturedAt: endAt,
      },
    });
    for (const data of [
      { assetPriceSnapshotId: spot.id, lastPriceSnapshotId: last.id },
      { assetPriceSnapshotId: null, lastPriceSnapshotId: null },
    ])
      await assert.rejects(
        db.futuresSeasonPrice.create({
          data: {
            seasonId: season.id,
            instrumentId: s.instruments[1].instrument.id,
            endAt,
            feeRate: season.tradeFeeRate,
            ...data,
          },
        }),
      );
    await final.settleSeason(season.id);
    const close = await db.futuresSeasonClose.findFirstOrThrow({
      where: { tradingAccountId: s.accountId },
    });
    assert.equal(close.priceId, pin.id);
    assert.equal(close.executionPrice.toFixed(8), '120.00000000');
    assert.equal(
      await db.futuresSeasonPrice.count({ where: { seasonId: season.id } }),
      1,
    );
    const view = await app.futures.finalSettlement(s.userId, s.accountId);
    const shown = JSON.parse(JSON.stringify(view.data.settlement)) as {
      closes: Array<{
        price: { snapshot: { id: string } | null; lastPriceSnapshot: unknown };
      }>;
    };
    assert.equal(shown.closes[0].price.snapshot?.id, spot.id);
    assert.equal(shown.closes[0].price.lastPriceSnapshot, null);
    pass('legacy Spot Season pin is re-verified and reused unchanged on retry');
  } finally {
    await release(s);
  }
}

async function main() {
  await legacySpotPinRetry();
  await valuationTransitions();
  await staleAndGeneration();
  await finalCases();
  await mixedFinal();
  await jobAndFaults();
  await race();
  await generalFundingAndHistory();
  await multiAccountRetry();
  await mixedScopeAndMidwayRollback();
  console.log(`futures F3 db integration ok (${checks} scenarios)`);
}
main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.fxRateSnapshot.deleteMany({
      where: { id: { in: fxEvidenceIds } },
    });
    await db.$disconnect();
  });
