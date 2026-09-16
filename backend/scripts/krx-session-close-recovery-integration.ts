/** Real HTTP provider contract → parser → ingestion → PostgreSQL → consumers. */
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { mock } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ProviderConfigService } from '../src/providers/provider-config.service';
import { ProviderTargetResolverService } from '../src/providers/provider-target-resolver.service';
import { MarketSnapshotHealthService } from '../src/providers/market-snapshot-health.service';
import { KisAuthClient } from '../src/providers/kis/kis-auth.client';
import { KisWebSocketIngestionService } from '../src/providers/kis/kis-websocket.ingestion.service';
import { parseKisWebSocketMessage } from '../src/providers/kis/kis-websocket.trade-parser';
import { KisQuoteClient } from '../src/providers/kis/kis-quote.client';
import { KisRestCurrentPriceIngestionService } from '../src/providers/kis/kis-rest-current-price.ingestion.service';
import { KisKrxSessionCloseIngestionService } from '../src/providers/kis/kis-krx-session-close.ingestion.service';
import { KisKrxStartupCatchUpService } from '../src/providers/kis/kis-krx-startup-catch-up.service';
import { KisRateLimiterService } from '../src/providers/kis/coordination/kis-rate-limiter.service';
import { KisRequestCoordinatorService } from '../src/providers/kis/coordination/kis-request-coordinator.service';
import { readKisRateLimitConfig } from '../src/providers/kis/coordination/kis-rate-limit.config';
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
// any existing local Samsung/Kia asset. Provider field names match KIS contracts.
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
  trId: string | undefined;
}> = [];
let evidenceAvailable = false;
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  res.setHeader('content-type', 'application/json');
  if (url.pathname === '/oauth2/tokenP') {
    res.end(
      JSON.stringify({
        access_token: 'fixture-token',
        token_type: 'Bearer',
        expires_in: 86400,
      }),
    );
    return;
  }
  requests.push({
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    trId: req.headers.tr_id as string | undefined,
  });
  const symbol = url.searchParams.get('FID_INPUT_ISCD') ?? '';
  const price = prices.get(symbol);
  if (!price) {
    res.statusCode = 400;
    res.end('{}');
    return;
  }
  if (url.pathname.endsWith('/inquire-price')) {
    // Actual current-price contract has neither business date nor trade clock.
    res.end(
      JSON.stringify({
        rt_cd: '0',
        output: { stck_shrn_iscd: symbol, stck_prpr: price },
      }),
    );
    return;
  }
  if (!url.pathname.endsWith('/inquire-daily-itemchartprice')) {
    res.statusCode = 404;
    res.end('{}');
    return;
  }
  res.end(
    JSON.stringify({
      rt_cd: '0',
      output1: { stck_shrn_iscd: symbol },
      output2: [
        {
          ...(evidenceAvailable ? { stck_bsop_date: '20260710' } : {}),
          stck_clpr: price,
          stck_oprc: price,
          stck_hgpr: price,
          stck_lwpr: price,
          acml_vol: '100000',
        },
      ],
    }),
  );
});
const redis = new RedisService();
const coordinator = new KisRequestCoordinatorService(
  new KisRateLimiterService(
    redis,
    readKisRateLimitConfig({ KIS_RATE_LIMIT_ENABLED: 'false' }),
  ),
);

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
    class FixtureConfig extends ProviderConfigService {
      override getConfig() {
        return super.getConfig({
          PROVIDER_INGESTION_ENABLED: 'true',
          KIS_MARKET_DATA_ENABLED: 'true',
          KIS_APP_KEY: 'fixture-key',
          KIS_APP_SECRET: 'fixture-secret',
          KIS_REST_BASE_URL: fixtureBaseUrl,
          KIS_DOMESTIC_SYMBOLS: fixtureSymbols.join(','),
          KIS_US_SYMBOLS: '',
        });
      }
    }
    const config = new FixtureConfig();
    const auth = new KisAuthClient(config, coordinator);
    const quote = new KisQuoteClient(config, coordinator);
    const current = new KisRestCurrentPriceIngestionService(
      prisma,
      config,
      auth,
      quote,
    );
    const close = new KisKrxSessionCloseIngestionService(
      prisma,
      config,
      auth,
      quote,
    );
    const health = new MarketSnapshotHealthService(
      prisma,
      new ProviderTargetResolverService(prisma),
    );
    const catchUp = () =>
      new KisKrxStartupCatchUpService(config, health, close);
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
    const currentResult = await current.ingestCurrentPrices({
      domesticSymbols: fixtureSymbols,
      usSymbols: [],
    });
    assert.equal(currentResult.created, 2);
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
    const failed = await catchUp().startOnce();
    assert.equal(failed.state, 'failed');
    if (failed.state === 'failed') {
      assert.equal(failed.reason, 'COMPLETED_SESSION_PRICE_UNAVAILABLE');
      assert.equal(failed.failures?.length, 2);
      assert.ok(
        failed.failures?.every(
          (row) => row.reason === 'KIS_SESSION_CLOSE_DATE_MISSING_OR_AMBIGUOUS',
        ),
      );
    }
    assert.equal(
      await prisma.assetPriceSnapshot.count({ where: fixtureWhere }),
      2,
    );
    await assertUnavailable();
    console.log(
      'PASS CASE 2 timestamp-less current response and absent daily date retain fail-safe',
    );

    evidenceAvailable = true;
    const recovery = catchUp();
    const recovered = await recovery.startOnce();
    assert.equal(recovered.state, 'completed');
    if (recovered.state === 'completed') assert.equal(recovered.created, 2);
    const snapshots = await prisma.assetPriceSnapshot.findMany({
      where: { ...fixtureWhere, effectiveAt: sessionClose },
    });
    assert.equal(snapshots.length, 2);
    for (const row of snapshots) {
      assert.equal(row.sourceTimestamp, null);
      assert.equal(row.capturedAt.toISOString(), '2026-07-10T09:00:00.000Z');
      assert.equal(row.price.toString(), expected.get(row.assetId));
      assert.ok(
        JSON.stringify(row.rawPayloadJson).includes(
          'provider_daily_close_trading_date',
        ),
      );
    }
    const dailyRequests = requests.filter((row) =>
      row.path.endsWith('/inquire-daily-itemchartprice'),
    );
    assert.equal(dailyRequests.length, 4);
    for (const request of dailyRequests) {
      assert.equal(request.trId, 'FHKST03010100');
      assert.deepEqual(request.query, {
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_INPUT_ISCD: request.query.FID_INPUT_ISCD,
        FID_INPUT_DATE_1: '20260710',
        FID_INPUT_DATE_2: '20260710',
        FID_PERIOD_DIV_CODE: 'D',
        FID_ORG_ADJ_PRC: '1',
      });
      assert.ok(fixtureSymbols.includes(request.query.FID_INPUT_ISCD));
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
    assert.strictEqual(await recovery.startOnce(), recovered);
    assert.deepEqual(await catchUp().startOnce(), {
      state: 'not_needed',
      reason: 'LATEST_COMPLETED_SESSION_COVERED',
    });
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
      assert.deepEqual(await catchUp().startOnce(), {
        state: 'skipped',
        reason: 'NO_COMPLETED_KRX_SESSION_TODAY',
      });
      assert.equal(requests.length, callsAfterRecovery);
      await assertAvailable();
    }
    console.log(
      'PASS CASE 4 weekend/holiday reuse latest completed session without today recovery',
    );
    resetMarketSessionOverrideStoreForTest();
    mock.timers.setTime(Date.parse('2026-07-14T01:00:00Z'));
    assert.deepEqual(await catchUp().startOnce(), {
      state: 'skipped',
      reason: 'NO_COMPLETED_KRX_SESSION_TODAY',
    });
    assert.equal(requests.length, callsAfterRecovery);
    assert.equal(
      await prisma.assetPriceSnapshot.count({ where: fixtureWhere }),
      4,
    );
    // The existing WebSocket parser and ingestion still own OPEN prices.
    const ws = new KisWebSocketIngestionService(prisma, config);
    const fields = fixtureSymbols.flatMap((symbol) => {
      const row = Array.from({ length: 46 }, () => '');
      row[0] = symbol;
      row[1] = '100000';
      row[2] = prices.get(symbol)!;
      row[33] = '20260714';
      row[35] = 'N';
      return row;
    });
    const live = parseKisWebSocketMessage({
      frame: `0|H0STCNT0|002|${fields.join('^')}`,
      receivedAt: new Date(),
    });
    assert.equal(live.state, 'trades');
    assert.equal((await ws.ingestParsedMessage(live)).created, 2);
    for (const assetId of assetIds) {
      const detail = (await assets.getAsset(user.id, assetId)).data.asset;
      assert.equal(detail.marketStatus, 'open');
      assert.equal(detail.price?.state, 'available');
    }
    console.log(
      'PASS CASE 5 OPEN skips recovery and keeps live provider ingestion available',
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
    await coordinator.onModuleDestroy();
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
