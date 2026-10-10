import { zeroCryptoCashWalletData } from '../src/wallets/canonical-cash-wallets';
/** Real HTTP provider contract → parser → ingestion → PostgreSQL → consumers. */
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { mock } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ProviderTargetResolverService } from '../src/providers/provider-target-resolver.service';
import { MarketSnapshotHealthService } from '../src/providers/market-snapshot-health.service';
import { KoscomClient } from '../src/providers/koscom/koscom.client';
import { KoscomIngestionService } from '../src/providers/koscom/koscom-ingestion.service';
import { KoscomMarketMapService } from '../src/providers/koscom/koscom-market-map.service';
import {
  KoscomConfigService,
  readKoscomConfig,
  KOSCOM_PRICE_SOURCE,
} from '../src/providers/koscom/koscom.config';
import { MarketPriceEventService } from '../src/providers/market-price-event.service';
import { KisRealtimePriceEventBus } from '../src/providers/kis/kis-realtime-price-event-bus.service';
import { BinanceRealtimePriceEventBus } from '../src/providers/binance/binance-realtime-price-event-bus.service';
import { PROVIDER_PRICE_PUBSUB_CHANNEL } from '../src/providers/fx-rate-update-event';
import { RedisLockService } from '../src/redis/redis-lock.service';
import { RedisService } from '../src/redis/redis.service';
import { HttpException } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { AssetsService } from '../src/assets/assets.service';
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
const assets = new AssetsService(prisma);
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

const sessionClose = new Date('2026-07-10T06:30:00Z');

// Six-digit unique symbols exercise the real domestic mapping without touching
// any existing local Samsung/Kia asset. Provider field names match KOSCOM v3.
const fixtureSymbols = [
  String(randomInt(800000, 900000)),
  String(randomInt(900000, 999999)),
];
const prices = new Map([
  [fixtureSymbols[0], '248500'],
  [fixtureSymbols[1], '122200'],
]);
const requests: Array<{
  path: string;
  query: Record<string, string>;
}> = [];
let evidenceAvailable = false;
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  res.setHeader('content-type', 'application/json');
  requests.push({
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
  });
  if (url.pathname.endsWith('/lists')) {
    res.end(
      JSON.stringify({
        isuLists: url.pathname.includes('/kospi/')
          ? fixtureSymbols.map((isuSrtCd) => ({ isuSrtCd }))
          : [],
      }),
    );
    return;
  }
  if (url.pathname.includes('/multiquote/stocks/')) {
    const isulist = (url.searchParams.get('isuCd') ?? '')
      .split(',')
      .map((symbol) =>
        url.pathname.endsWith('/price')
          ? {
              isuSrtCd: symbol,
              trdPrc: prices.get(symbol),
              trdTm: '10000000',
              trdDd: '20260714',
              cmpprevddPrc: '0',
              cmpprevddTpCd: '3',
              accTrdvol: '100000',
              accTrdval: '10000000',
            }
          : {
              isuSrtCd: symbol,
              askStep1BstordPrc: prices.get(symbol),
              bidStep1BstordPrc: prices.get(symbol),
              askStep1BstordRqty: '10',
              bidStep1BstordRqty: '20',
            },
      );
    res.end(JSON.stringify({ jsonrpc: '2.0', result: { isulist } }));
    return;
  }
  const symbol = url.pathname.split('/').at(-2) ?? '';
  const price = prices.get(symbol);
  if (!price) {
    res.statusCode = 400;
    res.end('{}');
    return;
  }
  if (!url.pathname.endsWith('/history')) {
    res.statusCode = 404;
    res.end('{}');
    return;
  }
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      result: {
        isuSrtCd: symbol,
        hisLists: [
          {
            ...(evidenceAvailable ? { trdDd: '20260710' } : {}),
            trdPrc: price,
            opnprc: price,
            hgprc: price,
            lwprc: price,
            accTrdvol: '100000',
            accTrdval: '10000000',
          },
        ],
      },
    }),
  );
});
let realtimeEvents = 0;
class FixtureRedis extends RedisService {
  override publish(channel: string, message: string): Promise<number> {
    if (channel === PROVIDER_PRICE_PUBSUB_CHANNEL) realtimeEvents++;
    return super.publish(channel, message);
  }
}
const redis = new FixtureRedis();
const namespace = `krx-recovery-${randomUUID()}`;
const closeKey = `koscom:${namespace}:close:2026-07-10`;

async function main() {
  mock.timers.enable({
    apis: ['Date'],
    now: Date.parse('2026-07-10T09:00:00Z'),
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const fixtureBaseUrl = `http://127.0.0.1:${address.port}`;
    class FixtureConfig extends KoscomConfigService {
      override getConfig() {
        return {
          ...readKoscomConfig({
            PROVIDER_INGESTION_ENABLED: 'true',
            KOSCOM_API_KEY: 'fixture-key',
          }),
          baseUrl: fixtureBaseUrl,
          namespace,
        };
      }
    }
    const config = new FixtureConfig();
    const locks = new RedisLockService(redis);
    const client = new KoscomClient(config, redis, locks);
    const markets = new KoscomMarketMapService(client, redis, config);
    const health = new MarketSnapshotHealthService(
      prisma,
      new ProviderTargetResolverService(prisma),
    );
    const events = new MarketPriceEventService(
      new KisRealtimePriceEventBus(),
      new BinanceRealtimePriceEventBus(),
    );
    events.subscribe(() => {
      realtimeEvents++;
    });
    const collector = new KoscomIngestionService(
      prisma,
      config,
      client,
      markets,
      locks,
      redis,
      events,
      health,
    );
    const collect = () => collector.collect({ symbols: fixtureSymbols });
    await prisma.$connect();
    const user = await prisma.user.create({
      data: {
        email: `krx-recovery-${randomUUID()}@example.com`,
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
        name: `krx-recovery-${randomUUID()}`,
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
    const expected = new Map<string, string>();
    for (const [index, [name, quantity, stale]] of [
      ['Samsung Electronics', '2', '278000'],
      ['Kia', '3', '127300'],
    ].entries()) {
      const asset = await prisma.asset.create({
        data: {
          symbol: fixtureSymbols[index],
          name,
          market: 'KRX',
          assetType: 'domestic_stock',
          currencyCode: 'KRW',
          priceCurrency: 'KRW',
          settlementCurrency: 'KRW',
        },
      });
      assetIds.push(asset.id);
      expected.set(asset.id, prices.get(asset.symbol)!);
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
    const fixtureWhere = { assetId: { in: assetIds } };
    assert.equal(
      await prisma.assetPriceSnapshot.count({ where: fixtureWhere }),
      0,
    );
    // A timestamp-less receipt from after close is not session-close evidence.
    // Preserve the old fixture's negative case without calling retired KIS APIs.
    await prisma.assetPriceSnapshot.createMany({
      data: assetIds.map((assetId, i) => ({
        assetId,
        price: prices.get(fixtureSymbols[i])!,
        currencyCode: 'KRW',
        sourceType: 'provider_api',
        sourceName: KOSCOM_PRICE_SOURCE,
        sourceTimestamp: null,
        effectiveAt: new Date(),
        capturedAt: new Date(),
      })),
    });
    const receipts = await prisma.assetPriceSnapshot.findMany({
      where: fixtureWhere,
    });
    for (const row of receipts) {
      assert.equal(row.sourceTimestamp, null);
      assert.equal(row.effectiveAt.toISOString(), '2026-07-10T09:00:00.000Z');
      assert.equal(row.capturedAt.toISOString(), row.effectiveAt.toISOString());
    }
    async function assertUnavailable() {
      for (const assetId of assetIds) {
        assert.equal(
          (await assets.getAsset(user.id, assetId)).data.asset.price?.state,
          'unavailable',
        );
      }
      for (const accountId of accountIds) {
        const p = await positions.getPositionsForTradingAccount(
          user.id,
          accountId,
        );
        assert.equal(p.data.positions.length, 2);
        for (const row of p.data.positions) {
          assert.equal(row.valuation.state, 'stale_cache');
          assert.equal(
            row.valuation.state === 'stale_cache'
              ? row.valuation.currentPrice
              : null,
            row.assetId === assetIds[0] ? '278000.00000000' : '127300.00000000',
          );
        }
        const total = await portfolio.getPortfolio(user.id, accountId);
        assert.equal(total.data.state, 'unavailable');
        assert.equal(total.data.summary, null);
        assert.ok(
          total.data.sectionErrors.some(
            (row) => row.code === 'ASSET_PRICE_UNAVAILABLE',
          ),
        );
      }
    }
    await assertUnavailable();
    const failed = await collect();
    assert.equal(failed.success, false);
    assert.equal(failed.errorCode, 'KOSCOM_CLOSE_RECOVERY_INCOMPLETE');
    assert.equal(failed.failed, 2);
    assert.ok(
      failed.snapshots.every(
        (row) => row.reason === 'KOSCOM_CLOSE_DATE_MISMATCH',
      ),
    );
    assert.equal(realtimeEvents, 0);
    assert.equal(
      await prisma.assetPriceSnapshot.count({ where: fixtureWhere }),
      2,
    );
    await assertUnavailable();
    console.log(
      'PASS CASE 2 timestamp-less current response and absent daily date retain fail-safe',
    );

    evidenceAvailable = true;
    // Simulate expiry of this fixture's retry marker; provider retry TTL is
    // independently checked by the ingestion unit contract.
    await redis.delete(closeKey);
    const recovered = await collect();
    assert.equal(recovered.success, true);
    assert.equal(recovered.created, 2);
    assert.equal(
      realtimeEvents,
      0,
      'recovered closes cannot become realtime ticks',
    );
    const snapshots = await prisma.assetPriceSnapshot.findMany({
      where: { ...fixtureWhere, effectiveAt: sessionClose },
    });
    assert.equal(snapshots.length, 2);
    for (const row of snapshots) {
      assert.equal(row.sourceTimestamp, null);
      assert.equal(row.capturedAt.toISOString(), '2026-07-10T09:00:00.000Z');
      assert.equal(row.price.toString(), expected.get(row.assetId));
      assert.ok(
        JSON.stringify(row.rawPayloadJson).includes('provider_history'),
      );
    }
    const dailyRequests = requests.filter((row) =>
      row.path.endsWith('/history'),
    );
    assert.equal(dailyRequests.length, 4);
    for (const request of dailyRequests) {
      assert.deepEqual(request.query, {
        trnsmCycleTpCd: 'D',
        inqStrtDd: '20260710',
        inqEndDd: '20260710',
        reqCnt: '1',
        apikey: 'fixture-key',
      });
      assert.ok(fixtureSymbols.includes(request.path.split('/').at(-2)!));
    }
    async function assertAvailable() {
      const market = await assets.getAssets(user.id, {
        withPrice: 'true',
        limit: '100',
      });
      for (const assetId of assetIds) {
        assert.equal(
          market.data.assets.find((row) => row.id === assetId)?.price?.state,
          'available',
        );
        const detail = (await assets.getAsset(user.id, assetId)).data.asset;
        assert.equal(detail.price?.state, 'available');
        const ticker = await assets.getAssetPriceForTicker(assetId);
        assert.equal(ticker?.price.state, 'available');
        if (ticker?.price.state === 'available')
          assert.equal(
            ticker.price.assetPriceSnapshotId,
            snapshots.find((row) => row.assetId === assetId)?.id,
          );
      }
      for (const accountId of accountIds) {
        const p = await positions.getPositionsForTradingAccount(
          user.id,
          accountId,
        );
        assert.equal(p.data.positions.length, 2);
        for (const row of p.data.positions) {
          assert.equal(row.valuation.state, 'available');
          if (row.valuation.state === 'available')
            assert.equal(
              row.valuation.assetPriceSnapshotId,
              snapshots.find((s) => s.assetId === row.assetId)?.id,
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
      const summary = (await home.getHome(user.id)).data.summary;
      assert.ok(
        summary &&
          typeof summary === 'object' &&
          'state' in summary &&
          'totalAssetKrw' in summary,
      );
      assert.equal(summary.state, 'available');
      assert.equal(summary.totalAssetKrw, '10863600.00000000');
    }
    await assertAvailable();
    console.log(
      'PASS CASE 1 provider HTTP → parser → recovery → DB → Market/Position/Portfolio/Home, GENERAL/SEASON, orders closed',
    );
    const callsAfterRecovery = requests.length;
    assert.equal((await collect()).errorCode, 'KOSCOM_CLOSE_ALREADY_CHECKED');
    await redis.delete(closeKey);
    const covered = await collect();
    assert.equal(covered.success, true);
    assert.equal(covered.created, 0);
    assert.equal(requests.length, callsAfterRecovery);
    console.log(
      'PASS CASE 3 covered session and repeated bootstrap cause no provider calls',
    );
    for (const at of ['2026-07-11T09:00:00Z', '2026-07-13T09:00:00Z']) {
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
      assert.equal(
        (await collect()).errorCode,
        'MARKET_CLOSED_EXPECTED_NO_DATA',
      );
      assert.equal(requests.length, callsAfterRecovery);
      await assertAvailable();
    }
    console.log(
      'PASS CASE 4 weekend/holiday reuse latest completed session without today recovery',
    );
    resetMarketSessionOverrideStoreForTest();
    mock.timers.setTime(Date.parse('2026-07-14T01:00:00Z'));
    const dailyCallsBeforeOpen = requests.filter((r) =>
      r.path.endsWith('/history'),
    ).length;
    assert.equal(
      await prisma.assetPriceSnapshot.count({ where: fixtureWhere }),
      4,
    );
    // OPEN uses central KOSCOM price/book collection, without close recovery.
    const live = await collect();
    assert.equal(live.success, true);
    assert.equal(live.created, 4);
    assert.equal(
      realtimeEvents,
      2,
      'only the two OPEN prices emit realtime ticks',
    );
    assert.equal(live.snapshots.filter((r) => r.kind === 'price').length, 2);
    assert.equal(
      requests.filter((r) => r.path.endsWith('/history')).length,
      dailyCallsBeforeOpen,
    );
    for (const assetId of assetIds) {
      const detail = (await assets.getAsset(user.id, assetId)).data.asset;
      assert.equal(detail.marketStatus, 'open');
      assert.equal(detail.price?.state, 'available');
    }
    console.log(
      'PASS CASE 5 OPEN skips close recovery and keeps central KOSCOM ingestion available',
    );
    console.log('krx recovery integration ok: 5 scenarios');
  } finally {
    resetMarketSessionOverrideStoreForTest();
    mock.timers.reset();
    await prisma.position.deleteMany({
      where: { tradingAccountId: { in: accountIds } },
    });
    await prisma.assetPriceSnapshot.deleteMany({
      where: { assetId: { in: assetIds } },
    });
    await prisma.assetOrderbookSnapshot.deleteMany({
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
    // Only this fixture's Redis namespace is cleaned.
    await redis.delete(closeKey);
    for (const market of ['kospi', 'kosdaq', 'konex'])
      await redis.delete(`koscom:${namespace}:symbols:${market}`);
    await redis.onModuleDestroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
