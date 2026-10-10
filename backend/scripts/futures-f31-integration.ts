import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  db,
  app,
  services,
  fixture,
  now,
  price,
  spotPrice,
  fxEvidence,
  fxEvidenceIds,
  openBody,
  positionBody,
  cleanup,
  faultyDb,
  type Scenario,
} from './futures-integration';
import { Prisma } from '../src/generated/prisma/client';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { TradingAccountPortfolioService } from '../src/portfolio/trading-account-portfolio.service';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import { GeneralAccountPerformanceService } from '../src/portfolio/general-account-performance.service';
import { GeneralExternalFundingService } from '../src/portfolio/general-external-funding.service';
import { FuturesSeasonSettlementService } from '../src/futures/futures-season-settlement.service';
import { FuturesLiquidationService } from '../src/futures/futures-liquidation.service';
import { FuturesMarkRetentionService } from '../src/futures/futures-mark-retention.service';
import { FuturesLastPriceRetentionService } from '../src/futures/futures-last-price-retention.service';
import { readFuturesLastPrice } from '../src/futures/futures-last-price';
import { readFuturesMark } from '../src/futures/futures-mark';
import { OpsJobLockService } from '../src/ops/ops-job-lock.service';
import { OpsJobRunService } from '../src/ops/ops-job-run.service';
import { SeasonSettlementJobService } from '../src/batch/season-settlement-job.service';
import { BatchService } from '../src/batch/batch.service';
import { RankingRefreshService } from '../src/ranking/ranking-refresh.service';
import { HomeService } from '../src/home/home.service';

if (
  process.env.NODE_ENV !== 'test' ||
  process.env.FUTURES_F31_DB_INTEGRATION !== '1'
)
  throw new Error('F3.1 disposable PostgreSQL opt-in required');
process.env.FUTURES_TRADING_MODE = 'ENABLED';
process.env.FUTURES_RISK_ENGINE_ENABLED = 'true';
const valuation = new PortfolioValuationService(db);
const performance = new GeneralAccountPerformanceService(
  db,
  valuation,
  new GeneralExternalFundingService(db),
);
const portfolio = new TradingAccountPortfolioService(
  db,
  new TradingAccountAccessService(db),
  performance,
  valuation,
);
const final = new FuturesSeasonSettlementService(db);
const jobs = new SeasonSettlementJobService(
  new BatchService(db),
  db,
  valuation,
  final,
);
let checks = 0;
const pass = (label: string) => {
  checks++;
  console.log(`PASS F3.1 ${label}`);
};
const count = async (s: Scenario) =>
  (
    await db.seasonParticipant.findUniqueOrThrow({
      where: { tradingAccountId: s.accountId },
    })
  ).totalFillCount;
async function mark(s: Scenario, value = '100', index = 0, at?: Date) {
  const t = at ?? new Date(+(await now()) - 20);
  const i = s.instruments[index];
  return db.futuresMarkSnapshot.create({
    data: {
      instrumentId: i.instrument.id,
      symbol: i.asset.symbol,
      source: 'binance_usdm_mark_ws',
      price: value,
      effectiveAt: t,
      capturedAt: t,
    },
  });
}
async function fresh(s: Scenario) {
  await fxEvidence();
  await price(s, '100', 0, 20);
  await mark(s);
}
async function release(s: Scenario) {
  const where = { tradingAccountId: s.accountId };
  await db.futuresSeasonClose.deleteMany({ where });
  await db.futuresSeasonSettlement.deleteMany({ where });
  await db.dailyPortfolioSnapshot.deleteMany({ where });
  await db.seasonRanking.deleteMany({ where });
  await db.position.deleteMany({ where });
  await db.futuresSeasonPrice.deleteMany({
    where: {
      instrumentId: { in: s.instruments.map((row) => row.instrument.id) },
    },
  });
  await cleanup(s);
}
/** Boundary evidence per domain: Futures Last prices the forced exit, Spot
 * values retained Spot holdings. Equal values keep the expected totals. */
async function boundary(s: Scenario, value: string, endAt: Date) {
  await db.futuresLastPriceSnapshot.create({
    data: {
      instrumentId: s.instruments[0].instrument.id,
      symbol: s.instruments[0].asset.symbol,
      price: value,
      source: 'binance_usdm_agg_trade_ws',
      effectiveAt: endAt,
      capturedAt: endAt,
    },
  });
  await db.assetPriceSnapshot.create({
    data: {
      assetId: s.instruments[0].asset.id,
      price: value,
      currencyCode: 'USD',
      sourceType: 'provider_api',
      sourceName: 'binance_spot_ws_ticker',
      effectiveAt: endAt,
      capturedAt: endAt,
    },
  });
}
async function end(s: Scenario, value = '100') {
  const endAt = await now();
  await boundary(s, value, endAt);
  await db.season.update({
    where: { id: s.season!.id },
    data: { status: 'ended', endAt },
  });
  return endAt;
}
async function userCounts() {
  const s = await fixture('season');
  try {
    await fresh(s);
    const body = openBody(s);
    const opened = await app.futures.execute(s.userId, s.accountId, body);
    assert.equal(await count(s), 1);
    pass('user open increments once');
    process.env.FUTURES_TRADING_MODE = 'DISABLED';
    assert.deepEqual(
      await app.futures.execute(s.userId, s.accountId, body),
      opened,
    );
    assert.equal(await count(s), 1);
    pass('committed replay across disabled mode does not increment');
    process.env.FUTURES_TRADING_MODE = 'ENABLED';
    await fresh(s);
    await app.futures.execute(
      s.userId,
      s.accountId,
      await positionBody(s, 'increase'),
    );
    assert.equal(await count(s), 2);
    pass('same-direction increase increments once');
    await price(s, '100', 0, 20);
    await app.futures.execute(
      s.userId,
      s.accountId,
      await positionBody(s, 'reduce', { quantity: '0.5' }),
    );
    assert.equal(await count(s), 3);
    pass('partial reduce increments once');
    // Missing Mark may skip the performance observation, never a committed fill.
    await db.futuresMarkSnapshot.deleteMany({
      where: { instrumentId: s.instruments[0].instrument.id },
    });
    await app.futures.execute(
      s.userId,
      s.accountId,
      await positionBody(s, 'reduce', { quantity: '0.5' }),
    );
    assert.equal(await count(s), 4);
    pass(
      'stale/missing valuation observation still counts actual user reduction',
    );
    const close = await positionBody(s, 'close');
    const before = await db.cashWallet.findUniqueOrThrow({
      where: { id: s.futuresWalletId },
    });
    await assert.rejects(
      services(faultyDb('futuresExecuteRequest.create')).futures.execute(
        s.userId,
        s.accountId,
        close,
      ),
    );
    assert.equal(await count(s), 4);
    assert.deepEqual(
      await db.cashWallet.findUniqueOrThrow({
        where: { id: s.futuresWalletId },
      }),
      before,
    );
    pass('late idempotency-write fault rolls back counter and wallet');
    await app.futures.execute(s.userId, s.accountId, close);
    assert.equal(await count(s), 5);
    pass('full close increments once');
    await app.futures.execute(s.userId, s.accountId, close);
    assert.equal(await count(s), 5);
    pass('close replay has no extra count');
    await fresh(s);
    const p = await app.futures.execute(
      s.userId,
      s.accountId,
      openBody(s, { leverage: 100 }),
    );
    await mark(s, '1');
    assert.equal(
      (
        await new FuturesLiquidationService(db).liquidate(
          s.accountId,
          p.data.position.id,
        )
      ).state,
      'liquidated',
    );
    assert.equal(await count(s), 6);
    pass('automatic liquidation has no user fill count');
    await fresh(s);
    await app.futures.execute(s.userId, s.accountId, openBody(s));
    await end(s);
    await final.settleSeason(s.season!.id);
    assert.equal(await count(s), 7);
    pass('final forced settlement has no user fill count');
  } finally {
    process.env.FUTURES_TRADING_MODE = 'ENABLED';
    await release(s);
  }
}

async function snapshot(s: Scenario, capturedAt: Date, total: string) {
  return db.equitySnapshot.create({
    data: {
      tradingAccountId: s.accountId,
      totalAssetKrw: total,
      returnRate: new Prisma.Decimal(total).div(10000000).sub(1).mul(100),
      krwCash: total,
      usdCashKrw: '0',
      domesticStockValueKrw: '0',
      usStockValueKrw: '0',
      cryptoValueKrw: '0',
      snapshotReason: 'scheduled',
      capturedAt,
    },
  });
}

async function finalHistoryAndReads() {
  const a = await fixture('season');
  const b = await fixture('season');
  try {
    const unusedSeasonId = b.season!.id;
    await db.seasonParticipant.update({
      where: { tradingAccountId: b.accountId },
      data: { seasonId: a.season!.id },
    });
    await db.season.delete({ where: { id: unusedSeasonId } });
    b.season = null;
    await db.season.update({
      where: { id: a.season!.id },
      data: { tradeFeeRate: '0' },
    });
    for (const s of [a, b]) {
      await fresh(s);
      await app.futures.execute(s.userId, s.accountId, openBody(s));
      if (s === a) {
        await app.futures.execute(
          s.userId,
          s.accountId,
          await positionBody(s, 'increase'),
        );
        await app.futures.execute(
          s.userId,
          s.accountId,
          await positionBody(s, 'reduce', { quantity: '1' }),
        );
      }
      await app.futures.execute(
        s.userId,
        s.accountId,
        await positionBody(s, 'close'),
      );
    }
    assert.equal(await count(a), 4);
    assert.equal(await count(b), 2);
    const ranker = new RankingRefreshService(db, valuation);
    await ranker.refreshCurrentRankingForSeason(a.season!.id, {
      capturedAt: await now(),
    });
    const current = await db.seasonRanking.findMany({
      where: { seasonId: a.season!.id, rankType: 'daily' },
      orderBy: { rank: 'asc' },
    });
    assert.ok(current[0].returnRate.eq(current[1].returnRate));
    assert.ok(current[0].maxDrawdown.eq(current[1].maxDrawdown));
    assert.equal(current[0].tradingAccountId, b.accountId);
    pass('actual Futures counts decide an otherwise tied current ranking');
    // Retained Spot holdings make live revaluation after settlement materially wrong.
    for (const subject of [a, b])
      await db.position.create({
        data: {
          tradingAccountId: subject.accountId,
          assetId: subject.instruments[0].asset.id,
          currencyCode: 'USD',
          quantity: '2',
          averageCost: '100',
          realizedPnl: '0',
          reservedQuantity: '0',
        },
      });
    const liveBefore = await portfolio.getPortfolio(a.userId, a.accountId);
    await spotPrice(a, '200', 0, 0); // Spot holdings revalue on Spot evidence.
    const liveAfter = await portfolio.getPortfolio(a.userId, a.accountId);
    assert.notEqual(
      liveBefore.data.summary?.totalAssetKrw,
      liveAfter.data.summary?.totalAssetKrw,
    );
    pass('active Season remains live');
    // The $200 Spot row is Spot-only evidence; Futures executions below use
    // their own fresh Futures Last rows from fresh().
    await new Promise((resolve) => setTimeout(resolve, 30));
    for (const subject of [a, b]) {
      await fresh(subject);
      await app.futures.execute(
        subject.userId,
        subject.accountId,
        openBody(subject),
      );
    }
    const endAt = await end(a, '105');
    await boundary(b, '105', endAt);
    for (const s of [a, b]) {
      await db.tradingAccount.update({
        where: { id: s.accountId },
        data: { openedAt: new Date(+endAt - 2000) },
      });
      await db.equitySnapshot.deleteMany({
        where: { tradingAccountId: s.accountId },
      });
      await snapshot(s, new Date(+endAt - 1000), '30000000');
      await snapshot(s, endAt, '18000000');
    }
    await snapshot(a, new Date(+endAt + 1), '1');
    await snapshot(a, new Date(+endAt + 2), '900000000');
    const input = {
      seasonId: a.season!.id,
      settlementDate: endAt.toISOString().slice(0, 10),
      idempotencyKey: randomUUID(),
    };
    await jobs.run(input);
    const ranks = await db.seasonRanking.findMany({
      where: { seasonId: a.season!.id, rankType: 'final' },
      orderBy: { rank: 'asc' },
    });
    for (const r of ranks) {
      assert.equal(r.maxDrawdown.toFixed(8), '40.00000000');
      assert.equal(+r.reachedReturnAt!, +endAt - 1000);
    }
    pass(
      'pre-end peak and exact-end trough included; post-end extremes excluded from final MDD/reached time',
    );
    assert.equal(ranks[0].tradingAccountId, b.accountId);
    pass('post-end history cannot change final fill-count tie-break');
    const fixed = await portfolio.getPortfolio(a.userId, a.accountId);
    assert.equal(fixed.data.summary, null);
    assert.ok(
      'finalResult' in fixed.data &&
        fixed.data.finalResult.state === 'available',
    );
    assert.equal(
      fixed.data.finalResult.totalAssetKrw,
      ranks[1].totalAssetKrw.toFixed(8),
    );
    pass(
      'settled Portfolio uses final ranking and matching settlement allocation',
    );
    assert.equal(fixed.data.finalResult.totalAssetKrw, '25701000.00000000');
    assert.equal(await count(a), 5);
    assert.equal(await count(b), 3);
    pass(
      'final Futures cash/PnL included once; forced exits do not increment counts',
    );
    const history = await portfolio.getEquity(a.userId, a.accountId, {
      range: 'all',
    });
    assert.equal(history.data.points.length, 3);
    assert.ok(
      history.data.points.every(
        (p) => +new Date(p.time) <= +endAt || p.snapshotReason === 'settlement',
      ),
    );
    pass(
      'settled account history omits post-end observations and keeps final settlement evidence',
    );
    await price(a, '999999', 0, 0);
    await spotPrice(a, '999999', 0, 0);
    await fxEvidence();
    await jobs.run({ ...input, idempotencyKey: randomUUID() });
    assert.deepEqual(
      await portfolio.getPortfolio(a.userId, a.accountId),
      fixed,
    );
    assert.deepEqual(
      await db.seasonRanking.findMany({
        where: { seasonId: a.season!.id, rankType: 'final' },
        orderBy: { rank: 'asc' },
      }),
      ranks,
    );
    pass(
      'post-end Futures Last/Spot/FX evidence and settlement retry cannot reprice final results',
    );
    const home = await new HomeService(db, valuation).getHome(a.userId);
    assert.equal(home.data.mode, 'settled_joined');
    const result = home.data.finalResult as {
      totalAssetKrw: string;
      returnRate: string;
      rank: number;
    };
    assert.equal(result.totalAssetKrw, fixed.data.finalResult.totalAssetKrw);
    assert.equal(result.returnRate, fixed.data.finalResult.returnRate);
    assert.equal(result.rank, fixed.data.finalResult.rank);
    pass('settled Home, Portfolio and final ranking agree');
    const rows = await db.equitySnapshot.count({
      where: { tradingAccountId: a.accountId },
    });
    await portfolio.getPortfolio(a.userId, a.accountId);
    assert.equal(
      await db.equitySnapshot.count({
        where: { tradingAccountId: a.accountId },
      }),
      rows,
    );
    pass('settled GET creates no observations or repairs');
    await db.seasonRanking.delete({ where: { id: ranks[1].id } });
    const missing = await portfolio.getPortfolio(a.userId, a.accountId);
    assert.equal(missing.data.state, 'unavailable');
    assert.equal(missing.data.summary, null);
    pass('missing final ranking fails closed instead of using live prices');
  } finally {
    await release(b);
    await release(a);
  }
}

async function retention() {
  const s = await fixture('general');
  const retention = new FuturesMarkRetentionService(
    db,
    new OpsJobLockService(db),
    new OpsJobRunService(db),
  );
  try {
    const clock = await now();
    const old = new Date(+clock - 25 * 3600000);
    const cutoff = new Date(+clock - 24 * 3600000);
    const oldMark = await mark(s, '1', 1, old);
    // A valid immutable historical liquidation, including a real FK to its Mark.
    const p = await db.futuresPosition.create({
      data: {
        tradingAccountId: s.accountId,
        instrumentId: s.instruments[1].instrument.id,
        direction: 'long',
        marginMode: 'isolated',
        leverage: 100,
        quantity: '0',
        averageEntryPrice: '100',
        entryNotional: '0',
        isolatedMargin: '0',
        status: 'closed',
        closedAt: old,
      },
    });
    const event = await db.futuresLiquidation.create({
      data: {
        tradingAccountId: s.accountId,
        marginMode: 'isolated',
        evaluationAt: old,
        executedAt: old,
        collateralAvailable: '1',
        preEquity: '-98',
        maintenanceMargin: '0.005',
        estimatedCloseFee: '0.001',
        liquidationRequirement: '0.006',
        realizedPnl: '-99',
        feeAmount: '0.001',
        settledPnl: '-1',
        settledFee: '0',
        settledCash: '-1',
        bankruptcyShortfall: '98.001',
        walletBalanceBefore: '100',
        walletBalanceAfter: '99',
      },
    });
    await db.futuresLiquidationClose.create({
      data: {
        liquidationId: event.id,
        tradingAccountId: s.accountId,
        positionId: p.id,
        instrumentId: p.instrumentId,
        markSnapshotId: oldMark.id,
        direction: 'long',
        quantity: '1',
        executionPrice: '1',
        maintenanceMargin: '0.005',
        estimatedCloseFee: '0.001',
        realizedPnl: '-99',
        feeRate: '0.001',
        feeAmount: '0.001',
      },
    });
    await mark(s, '100', 1);
    const latestOldRest = await db.futuresMarkSnapshot.create({
      data: {
        instrumentId: s.instruments[1].instrument.id,
        symbol: s.instruments[1].asset.symbol,
        source: 'binance_usdm_mark_rest',
        price: '100',
        effectiveAt: old,
        capturedAt: old,
      },
    });

    const oldIds: string[] = [];
    for (let i = 1; i <= 9; i++)
      oldIds.push((await mark(s, '100', 0, new Date(+old + i))).id);
    const exact = await mark(s, '100', 0, cutoff);
    const recent = await mark(s, '100', 0, new Date(+cutoff + 1));
    await fresh(s);
    await app.futures.execute(s.userId, s.accountId, openBody(s));
    const before = await valuation.calculateTradingAccountValuation(
      s.accountId,
      await now(),
    );
    const historic = await db.equitySnapshot.findFirstOrThrow({
      where: {
        tradingAccountId: s.accountId,
        snapshotReason: 'order_executed',
      },
    });
    const evidence = historic.futuresValuationJson as {
      positions: Array<Record<string, unknown>>;
    };
    for (const field of [
      'markPrice',
      'source',
      'effectiveAt',
      'capturedAt',
      'instrumentId',
      'symbol',
      'providerProduct',
      'currencyCode',
    ])
      assert.ok(evidence.positions[0][field]);
    pass('snapshot copies complete Mark audit evidence before retention');
    const history = await app.futures.liquidations(s.userId, s.accountId, {});
    assert.equal(await retention.deleteBatch(cutoff, 3), 3);
    assert.equal(
      await db.futuresMarkSnapshot.count({ where: { id: { in: oldIds } } }),
      6,
    );
    pass('retention deletes only a bounded batch of old unreferenced rows');
    assert.equal(await retention.deleteBatch(cutoff, 3), 3);
    assert.equal(await retention.deleteBatch(cutoff, 3), 3);
    assert.equal(await retention.deleteBatch(cutoff, 3), 0);
    pass('multiple bounded batches drain safely; repeated run is a no-op');
    for (const id of [oldMark.id, latestOldRest.id, exact.id, recent.id])
      assert.ok(await db.futuresMarkSnapshot.findUnique({ where: { id } }));
    pass('referenced old Mark, exact cutoff and newer marks survive');
    const instrument = await db.futuresInstrument.findUniqueOrThrow({
      where: { id: s.instruments[0].instrument.id },
      include: { underlyingAsset: true },
    });
    assert.ok(await readFuturesMark(db, instrument, await now()));
    assert.equal(
      (
        await valuation.calculateTradingAccountValuation(
          s.accountId,
          await now(),
        )
      ).totalAssetKrw,
      before.totalAssetKrw,
    );
    assert.deepEqual(
      await app.futures.liquidations(s.userId, s.accountId, {}),
      history,
    );
    pass(
      'fresh selection, live valuation and immutable liquidation history survive retention',
    );
    assert.equal(
      await db.seasonParticipant.count({
        where: { tradingAccountId: s.accountId },
      }),
      0,
    );
    pass('General execution does not create a Season fill counter');
    process.env.FUTURES_MARK_RETENTION_ENABLED = 'true';
    const results = await Promise.all([
      retention.run(),
      new FuturesMarkRetentionService(
        db,
        new OpsJobLockService(db),
        new OpsJobRunService(db),
      ).run(),
    ]);
    assert.ok(results.some(Boolean));
    assert.ok(
      await db.futuresMarkSnapshot.findUnique({ where: { id: oldMark.id } }),
    );
    pass('duplicate Ops workers preserve referenced financial evidence');
  } finally {
    delete process.env.FUTURES_MARK_RETENTION_ENABLED;
    await release(s);
    await db.opsJobRun.deleteMany({
      where: { jobName: 'futures_mark_retention' },
    });
    await db.opsJobLock.deleteMany({
      where: { jobName: 'futures_mark_retention' },
    });
  }
}

/** Last observations are bounded transport data; referenced financial evidence,
 * Season end windows and the newest row per instrument/source are never deleted. */
async function lastPriceRetention() {
  const s = await fixture('general');
  const t = await fixture('season');
  const extra = await db.season.create({
    data: {
      name: `f31-window-${randomUUID()}`,
      status: 'ended',
      startAt: new Date(Date.now() - 86400000),
      endAt: new Date(Date.now() - 86400000),
      initialCapitalKrw: '10000000',
      tradeFeeRate: '0.002',
      fxFeeRate: '0.001',
    },
  });
  const retention = new FuturesLastPriceRetentionService(
    db,
    new OpsJobLockService(db),
    new OpsJobRunService(db),
  );
  try {
    // Unreferenced history outside every Season end window (the window guard
    // is global), then a referenced execution price.
    const disposable: string[] = [];
    for (let i = 0; i < 5; i++)
      disposable.push((await price(s, '100', 0, 40000 - i)).id);
    await fresh(s);
    const executed = await app.futures.execute(
      s.userId,
      s.accountId,
      openBody(s),
    );
    const executionRow = executed.data.execution.priceEvidence
      .lastPriceSnapshotId as string;
    // A Season pin and an unreferenced receipt inside another Season's window.
    await fresh(t);
    await app.futures.execute(t.userId, t.accountId, openBody(t));
    const endAt = await end(t, '101');
    await final.settleSeason(t.season!.id);
    const pinRow = (
      await db.futuresSeasonPrice.findFirstOrThrow({
        where: { seasonId: t.season!.id },
      })
    ).lastPriceSnapshotId!;
    const windowRow = await price(t, '100', 0, 0);
    await db.season.update({
      where: { id: extra.id },
      data: { endAt: new Date(+windowRow.capturedAt + 5000) },
    });
    const newest = await price(s, '100', 0, 0);
    // A future cutoff treats every row as old; only the guards keep rows.
    const cutoff = new Date((await now()).getTime() + 3600000);
    let deleted = 0;
    for (let i = 0; i < 20; i++) {
      const batch = await retention.deleteBatch(cutoff, 2);
      assert.ok(batch <= 2);
      deleted += batch;
      if (batch === 0) break;
    }
    assert.ok(deleted >= disposable.length);
    assert.equal(await retention.deleteBatch(cutoff, 2), 0);
    for (const id of disposable)
      assert.equal(
        await db.futuresLastPriceSnapshot.count({ where: { id } }),
        0,
      );
    for (const id of [executionRow, pinRow, windowRow.id, newest.id])
      assert.equal(
        await db.futuresLastPriceSnapshot.count({ where: { id } }),
        1,
        id,
      );
    pass(
      'Last retention keeps execution/pin evidence, Season windows and newest rows; bounded batches drain',
    );
    const instrument = await db.futuresInstrument.findUniqueOrThrow({
      where: { id: s.instruments[0].instrument.id },
      include: { underlyingAsset: true },
    });
    assert.equal(
      (await readFuturesLastPrice(db, instrument, await now()))?.id,
      newest.id,
    );
    const history = await app.futures.executions(s.userId, s.accountId, {});
    assert.equal(
      history.data.executions[0].priceEvidence.lastPriceSnapshotId,
      executionRow,
    );
    const view = await app.futures.finalSettlement(t.userId, t.accountId);
    assert.ok(JSON.stringify(view).includes(pinRow));
    assert.ok(+endAt > 0);
    pass(
      'selection, execution history and final evidence survive Last retention',
    );
    process.env.FUTURES_LAST_PRICE_RETENTION_ENABLED = 'true';
    const results = await Promise.all([
      retention.run(),
      new FuturesLastPriceRetentionService(
        db,
        new OpsJobLockService(db),
        new OpsJobRunService(db),
      ).run(),
    ]);
    assert.ok(results.some(Boolean));
    assert.equal(
      await db.futuresLastPriceSnapshot.count({ where: { id: executionRow } }),
      1,
    );
    pass('duplicate Last retention workers serialize on the Ops lock');
  } finally {
    delete process.env.FUTURES_LAST_PRICE_RETENTION_ENABLED;
    await release(t);
    await release(s);
    await db.season.delete({ where: { id: extra.id } });
    await db.opsJobRun.deleteMany({
      where: { jobName: 'futures_last_price_retention' },
    });
    await db.opsJobLock.deleteMany({
      where: { jobName: 'futures_last_price_retention' },
    });
  }
}

async function main() {
  await userCounts();
  await finalHistoryAndReads();
  await retention();
  await lastPriceRetention();
  console.log(`futures F3.1 db integration ok (${checks} checks)`);
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
