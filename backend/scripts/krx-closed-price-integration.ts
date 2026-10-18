import { zeroCryptoCashWalletData } from '../src/wallets/canonical-cash-wallets';
/** Real PostgreSQL evidence for the closed-stock display/valuation split: the
 * display shows the KOSCOM daily close when that session's daily is stored
 * (2026-10-18), while valuation keeps the completed-session snapshots. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mock } from 'node:test';
import { HttpException } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { AssetsService } from '../src/assets/assets.service';
import { DailyChangeRateService } from '../src/assets/daily-change-rate.service';
import { MarketCandlesRepository } from '../src/assets/market-candles.repository';
import { PositionsService } from '../src/positions/positions.service';
import { HomeService } from '../src/home/home.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { GeneralAccountPerformanceService } from '../src/portfolio/general-account-performance.service';
import { GeneralExternalFundingService } from '../src/portfolio/general-external-funding.service';
import { TradingAccountPortfolioService } from '../src/portfolio/trading-account-portfolio.service';
import { GeneralAccountsService } from '../src/trading-accounts/general-accounts.service';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import { OrdersService } from '../src/orders/orders.service';
import {
  applyMarketSessionOverrideSnapshot,
  resetMarketSessionOverrideStoreForTest,
} from '../src/orders/market-calendar/market-session-override.store';

const url = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid');
assert.ok(
  ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
  'Use a disposable local PostgreSQL database.',
);
const prisma = new PrismaService();
const access = new TradingAccountAccessService(prisma);
const valuation = new PortfolioValuationService(prisma);
const performance = new GeneralAccountPerformanceService(
  prisma,
  valuation,
  new GeneralExternalFundingService(prisma),
);
const general = new GeneralAccountsService(prisma, performance);
const portfolio = new TradingAccountPortfolioService(
  prisma,
  access,
  performance,
  valuation,
);
const positions = new PositionsService(prisma, access);
const candles = new MarketCandlesRepository(prisma);
const assets = new AssetsService(
  prisma,
  undefined,
  new DailyChangeRateService(candles),
);
const home = new HomeService(prisma, valuation);
const orders = new OrdersService(
  prisma,
  undefined,
  undefined,
  undefined,
  access,
  performance,
);
const accountIds: string[] = [];
const assetIds: string[] = [];
let userId: string | undefined;
let seasonId: string | undefined;
const sessionOpen = new Date('2026-07-10T00:00:00Z');
const sessionClose = new Date('2026-07-10T06:30:00Z');
/** KOSCOM's 07-10 daily bar (that KST day) for the first asset only. */
const daily = (close: string, sourceUpdatedAt: Date) => ({
  assetId: assetIds[0],
  interval: '1d' as const,
  openTime: new Date('2026-07-09T15:00:00Z'),
  closeTime: new Date('2026-07-10T15:00:00Z'),
  open: '247000',
  high: '251000',
  low: '246000',
  close,
  volume: '1000',
  amount: '250000000',
  isClosed: true,
  sourceProvider: 'koscom_history',
  sourceUpdatedAt,
});

async function main() {
  mock.timers.enable({
    apis: ['Date'],
    now: Date.parse('2026-07-10T09:00:00Z'),
  });
  try {
    await prisma.$connect();
    const user = await prisma.user.create({
      data: {
        email: `krx-price-${randomUUID()}@example.com`,
        nickname: `krx-${randomUUID().slice(0, 8)}`,
        passwordHash: 'fixture-only',
      },
    });
    userId = user.id;
    accountIds.push(
      (await general.openGeneralAccount(user.id)).data.account.id,
    );
    const season = await prisma.season.create({
      data: {
        name: `krx-price-${randomUUID()}`,
        status: 'active',
        startAt: new Date('2026-07-09T00:00:00Z'),
        endAt: new Date('2026-07-15T00:00:00Z'),
        initialCapitalKrw: '10000000',
        tradeFeeRate: '0.001',
        fxFeeRate: '0.001',
      },
    });
    seasonId = season.id;
    const seasonAccount = await prisma.tradingAccount.create({
      data: {
        userId: user.id,
        mode: 'season',
        initialCapitalKrw: '10000000',
        openedAt: new Date(),
      },
    });
    accountIds.push(seasonAccount.id);
    await prisma.seasonParticipant.create({
      data: {
        userId: user.id,
        seasonId: season.id,
        tradingAccountId: seasonAccount.id,
        participantStatus: 'active',
        joinedAt: new Date(),
        initialCapitalKrw: '10000000',
        totalAssetKrw: '10000000',
        totalReturnRate: '0',
        maxDrawdown: '0',
      },
    });
    await prisma.cashWallet.createMany({
      data: [
        {
          tradingAccountId: seasonAccount.id,
          currencyCode: 'KRW',
          balanceAmount: '10000000',
        },
        {
          tradingAccountId: seasonAccount.id,
          currencyCode: 'USD',
          balanceAmount: '0',
        },
        ...zeroCryptoCashWalletData(seasonAccount.id),
      ],
    });
    const snapshots = new Map<string, string>();
    for (const [symbol, name, price, quantity, stale] of [
      ['005930', 'Samsung Electronics', '248500', '2', '278000'],
      ['000270', 'Kia', '122200', '3', '127300'],
    ]) {
      // Unique fixture symbols leave any existing local Samsung/Kia rows alone.
      const asset = await prisma.asset.create({
        data: {
          symbol: `${symbol}-${randomUUID()}`,
          name,
          market: 'KRX',
          assetType: 'domestic_stock',
          currencyCode: 'KRW',
          priceCurrency: 'KRW',
          settlementCurrency: 'KRW',
        },
      });
      assetIds.push(asset.id);
      const close = await prisma.assetPriceSnapshot.create({
        data: {
          assetId: asset.id,
          price,
          currencyCode: 'KRW',
          sourceType: 'provider_api',
          sourceName: 'koscom_krx_realtime_price',
          effectiveAt: sessionClose,
          capturedAt: new Date('2026-07-10T06:30:02Z'),
        },
      });
      snapshots.set(asset.id, close.id);
      await prisma.assetPriceSnapshot.createMany({
        data: Array.from({ length: 25 }, (_, i) => ({
          assetId: asset.id,
          price: '999999',
          currencyCode: 'KRW' as const,
          sourceType: 'provider_api' as const,
          sourceName: 'koscom_krx_realtime_price',
          effectiveAt: new Date(sessionClose.getTime() + (i + 1) * 60000),
          capturedAt: new Date(sessionClose.getTime() + (i + 1) * 60000),
        })),
      });
      await prisma.assetPriceSnapshot.createMany({
        data: [
          {
            assetId: asset.id,
            price: '0',
            sourceName: 'koscom_krx_realtime_price',
          },
          { assetId: asset.id, price: '999999', sourceName: 'wrong_source' },
        ].map((row) => ({
          ...row,
          currencyCode: 'KRW' as const,
          sourceType: 'provider_api' as const,
          effectiveAt: sessionClose,
          capturedAt: new Date('2026-07-10T06:30:03Z'),
        })),
      });
      for (const tradingAccountId of accountIds)
        await prisma.position.create({
          data: {
            tradingAccountId,
            assetId: asset.id,
            quantity,
            averageCost: '100000',
            currencyCode: 'KRW',
            currentPriceLocal: stale,
            currentPriceKrw: stale,
            marketValueLocal: stale,
            marketValueKrw: stale,
            unrealizedPnlLocal: '0',
            unrealizedPnlKrw: '0',
          },
        });
    }
    // A daily differing from the session snapshot (248,500), with no 5m row.
    await candles.upsertMany([
      daily('250000', new Date('2026-07-10T06:50:00Z')),
    ]);
    for (const at of [
      '2026-07-10T09:00:00Z',
      '2026-07-11T09:00:00Z',
      '2026-07-12T09:00:00Z',
      '2026-07-13T09:00:00Z',
    ]) {
      mock.timers.setTime(Date.parse(at));
      if (at.startsWith('2026-07-13'))
        applyMarketSessionOverrideSnapshot(
          [
            {
              market: 'KRX',
              localDate: '2026-07-13',
              overrideType: 'closed',
              openTime: null,
              closeTime: null,
              reason: 'fixture holiday',
            },
          ],
          new Date(),
        );
      for (const assetId of assetIds) {
        // Display: the KOSCOM daily close ahead of the session snapshot, or
        // that snapshot when the session has no daily (second asset).
        const shown =
          assetId === assetIds[0]
            ? { price: '250000.00000000', snapshotId: null }
            : { price: '122200.00000000', snapshotId: snapshots.get(assetId) };
        const result = await assets.getAsset(user.id, assetId);
        assert.equal(result.data.asset.marketStatus, 'closed');
        const ticker = await assets.getAssetPriceForTicker(assetId);
        for (const price of [result.data.asset.price, ticker?.price]) {
          assert.equal(price?.state, 'available');
          if (price?.state === 'available') {
            assert.equal(price.currentPrice, shown.price);
            assert.equal(price.assetPriceSnapshotId, shown.snapshotId);
          }
        }
      }
      for (const accountId of accountIds) {
        const result = await positions.getPositionsForTradingAccount(
          user.id,
          accountId,
        );
        assert.equal(result.data.positions.length, 2);
        // Valuation never uses the display-only daily close.
        for (const position of result.data.positions) {
          assert.equal(position.valuation.state, 'available');
          if (position.valuation.state === 'available')
            assert.equal(
              position.valuation.assetPriceSnapshotId,
              snapshots.get(position.assetId),
            );
        }
        const total = await portfolio.getPortfolio(user.id, accountId);
        assert.equal(total.data.state, 'available');
        assert.equal(total.data.summary?.totalAssetKrw, '10863600.00000000');
        const daily = await valuation.calculateTradingAccountValuation(
          accountId,
          new Date(),
          'daily_portfolio_snapshot',
        );
        assert.equal(daily.totalAssetKrw, '10863600.00000000');
        await assert.rejects(
          orders.quoteOrderForTradingAccount(user.id, accountId, {
            assetId: assetIds[0],
            side: 'buy',
            orderType: 'market',
            quantity: '1.000000',
          }),
          (error) =>
            error instanceof HttpException &&
            (error.getResponse() as { error: { code: string } }).error.code ===
              'MARKET_CLOSED',
        );
      }
      const result = await home.getHome(user.id);
      const summary = result.data.summary;
      assert.ok(summary && typeof summary === 'object');
      assert.ok('state' in summary);
      assert.equal(summary.state, 'available');
      assert.ok('totalAssetKrw' in summary);
      assert.equal(summary.totalAssetKrw, '10863600.00000000');
      console.log(`PASS Market/Position/Portfolio/Home GENERAL/SEASON ${at}`);
    }
    // KOSCOM revises the bar (the final KRX close); the daily job's upsert
    // stores it and later reads show it once the 30 s cached close expires.
    const revisedAt = new Date(Date.now() - 60_000);
    await candles.upsertMany([daily('249000', revisedAt)]);
    const revised = await prisma.marketCandle.findFirstOrThrow({
      where: { assetId: assetIds[0], interval: '1d' },
    });
    assert.equal(revised.close.toFixed(), '249000');
    assert.equal(revised.sourceUpdatedAt.getTime(), revisedAt.getTime());
    mock.timers.setTime(Date.now() + 31_000);
    const revisedPrice = (await assets.getAsset(user.id, assetIds[0])).data
      .asset.price;
    assert.equal(revisedPrice?.state, 'available');
    if (revisedPrice?.state === 'available') {
      assert.equal(revisedPrice.currentPrice, '249000.00000000');
      assert.equal(revisedPrice.priceCapturedAt, revisedAt.toISOString());
    }
    console.log('PASS revised KOSCOM daily close shown after the cache expiry');
    await prisma.assetPriceSnapshot.deleteMany({
      where: {
        assetId: assetIds[0],
        effectiveAt: { gte: sessionOpen, lte: sessionClose },
      },
    });
    // Display still shows the daily close; valuation fails safe without it.
    assert.equal(
      (await assets.getAsset(user.id, assetIds[0])).data.asset.price?.state,
      'available',
    );
    for (const accountId of accountIds) {
      const result = await positions.getPositionsForTradingAccount(
        user.id,
        accountId,
      );
      assert.equal(
        result.data.positions.find((row) => row.assetId === assetIds[0])
          ?.valuation.state,
        'stale_cache',
      );
      const total = await portfolio.getPortfolio(user.id, accountId);
      assert.equal(total.data.state, 'unavailable');
      assert.ok(
        total.data.sectionErrors.some(
          (row) => row.code === 'ASSET_PRICE_UNAVAILABLE',
        ),
      );
    }
    console.log('PASS missing completed-session evidence retains fail-safe');
    console.log('krx closed price integration ok: 6 scenarios');
  } finally {
    resetMarketSessionOverrideStoreForTest();
    mock.timers.reset();
    await prisma.position.deleteMany({
      where: { tradingAccountId: { in: accountIds } },
    });
    await prisma.assetPriceSnapshot.deleteMany({
      where: { assetId: { in: assetIds } },
    });
    await prisma.marketCandle.deleteMany({
      where: { assetId: { in: assetIds } },
    });
    await prisma.asset.deleteMany({ where: { id: { in: assetIds } } });
    await prisma.walletTransaction.deleteMany({
      where: { tradingAccountId: { in: accountIds } },
    });
    await prisma.cashWallet.deleteMany({
      where: { tradingAccountId: { in: accountIds } },
    });
    await prisma.equitySnapshot.deleteMany({
      where: { tradingAccountId: { in: accountIds } },
    });
    await prisma.seasonParticipant.deleteMany({
      where: { tradingAccountId: { in: accountIds } },
    });
    await prisma.tradingAccount.deleteMany({
      where: { id: { in: accountIds } },
    });
    if (seasonId) await prisma.season.delete({ where: { id: seasonId } });
    if (userId) await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  }
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
