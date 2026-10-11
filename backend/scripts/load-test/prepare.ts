import {
  BINANCE_FUTURES_SYMBOLS,
  BINANCE_FUTURES_ONLY_ASSETS,
  isFuturesOnlyAsset,
} from '../../src/providers/binance/binance-product-catalog';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  MarketCandlesRepository,
  type MarketCandleUpsertInput,
} from '../../src/assets/market-candles.repository';
import {
  resolveRegularSessionForEvent,
  resolveStockMarketSessionState,
} from '../../src/orders/market-calendar.policy';
import { KIS_US_DELAYED_TRADE_SOURCE_NAME } from '../../src/providers/kis/kis-websocket.types';
import type { Credentials, Manifest } from './manifest';
import { Metrics, writeJson } from './metrics';
import { CRYPTO, STOCKS, replayPrice, contract } from './replay';
import { AppClient } from './client';
import { Actor, type Fixture, type FixtureActor } from './actor';
import { preflight, verifyApi } from './preflight';
import { parseFuturesContracts } from '../../src/futures/futures-instrument-coverage';

export async function prepare(
  m: Manifest,
  c: Credentials,
  manifestHash: string,
  out: string,
  metrics: Metrics,
) {
  await preflight(m, c);
  await verifyApi(m, c, manifestHash);
  process.env.DATABASE_URL = c.databaseUrl;
  const db = new PrismaService();
  await db.$connect();
  try {
    if ((await db.user.count()) !== 0)
      throw new Error('LOAD_TEST_PREPARE_REQUIRES_EMPTY_USER_DATA');
    const at = new Date();
    for (const a of [
      ...CRYPTO,
      ...STOCKS,
      ...BINANCE_FUTURES_ONLY_ASSETS.map((a) => ({
        ...a,
        market: 'BINANCE' as const,
        assetType: 'crypto' as const,
        currencyCode: 'USD' as const,
      })),
    ])
      await db.asset.create({
        data: {
          symbol: a.symbol,
          name: a.name,
          market: a.market,
          assetType: a.assetType,
          currencyCode: a.currencyCode,
          priceCurrency: a.currencyCode,
          settlementCurrency: a.currencyCode,
        },
      });
    const assets = await db.asset.findMany({
      orderBy: [{ assetType: 'asc' }, { symbol: 'asc' }],
    });
    const eligible = parseFuturesContracts({
      symbols: BINANCE_FUTURES_SYMBOLS.map(contract),
    });
    // The CURRENT coverage parser rejects non-ASCII contracts. Keep all Spot
    // assets, but never invent an alias or register an unverified Futures row.
    for (const asset of assets.filter(
      (a) => a.assetType === 'crypto' && eligible.has(a.symbol),
    ))
      await db.futuresInstrument.create({
        data: {
          underlyingAssetId: asset.id,
          markContractJson: contract(asset.symbol),
          markVerifiedAt: at,
        },
      });
    const instruments = await db.futuresInstrument.findMany({
      orderBy: { underlyingAsset: { symbol: 'asc' } },
    });
    const candles = new MarketCandlesRepository(db);
    const lastClosed = Math.floor(+at / 300000) * 300000;
    for (const asset of assets.filter((a) => !isFuturesOnlyAsset(a))) {
      const rows: MarketCandleUpsertInput[] = [];
      for (
        let t = lastClosed - m.fixture.candleDays * 86400000;
        t < lastClosed;
        t += 300000
      ) {
        if (
          asset.assetType !== 'crypto' &&
          !resolveRegularSessionForEvent(asset, new Date(t))
        )
          continue;
        const price =
          asset.assetType === 'crypto'
            ? replayPrice(asset.symbol, 0, m.seed)
            : asset.assetType === 'domestic_stock'
              ? '100000'
              : '100';
        rows.push({
          assetId: asset.id,
          interval: '5m',
          openTime: new Date(t),
          closeTime: new Date(t + 300000),
          open: price,
          high: price,
          low: price,
          close: price,
          volume: '10000',
          amount: '1000000',
          isClosed: true,
          sourceProvider:
            asset.assetType === 'crypto'
              ? 'binance'
              : asset.assetType === 'domestic_stock'
                ? 'koscom'
                : 'kis',
          sourceUpdatedAt: at,
        });
      }
      for (let i = 0; i < rows.length; i += 500)
        await candles.upsertMany(rows.slice(i, i + 500));
      // Stock carry-forward is pinned to an ACTUAL completed market session,
      // never a Sunday synthetic 'open' or a bypassed freshness check.
      if (asset.assetType !== 'crypto') {
        const session = resolveStockMarketSessionState(
          asset,
          at,
        )?.latestCompletedSession;
        if (session)
          await db.assetPriceSnapshot.create({
            data: {
              assetId: asset.id,
              price: asset.assetType === 'domestic_stock' ? '100000' : '100',
              currencyCode: asset.currencyCode,
              sourceType: 'provider_api',
              sourceName:
                asset.assetType === 'domestic_stock'
                  ? 'koscom_krx_realtime_price'
                  : KIS_US_DELAYED_TRADE_SOURCE_NAME,
              effectiveAt: session.closeTime,
              capturedAt: session.closeTime,
              sourceTimestamp: session.closeTime,
              note: 'load-test historical provider fixture',
            },
          });
      }
    }
    const season = await db.season.create({
      data: {
        name: `Load test ${m.runId}`,
        status: 'active',
        startAt: new Date(+at - 86400000),
        endAt: new Date(+at + 7 * 86400000),
        initialCapitalKrw: '10000000',
        tradeFeeRate: '0.002',
        fxFeeRate: '0.001',
      },
    });
    // Ingestion keeps its existing 30s discovery / 1s write cadence.
    const end = Date.now() + 45000;
    while (
      (await db.futuresLastPriceSnapshot.count()) < instruments.length ||
      (await db.assetPriceSnapshot.count({
        where: { asset: { assetType: 'crypto' } },
      })) < CRYPTO.length
    ) {
      if (Date.now() > end) throw new Error('REPLAY_INITIAL_PRICES_TIMEOUT');
      await delay(500);
    }
    const actors: FixtureActor[] = [];
    const crypto = assets.filter(
      (a) => a.assetType === 'crypto' && !isFuturesOnlyAsset(a),
    );
    const data: Fixture = {
      version: 1,
      runId: m.runId,
      manifestHash,
      actors,
      assets: assets
        .filter((a) => !isFuturesOnlyAsset(a))
        .map((a) => ({
          id: a.id,
          symbol: a.symbol,
          assetType: a.assetType,
        })),
      instruments: instruments.map((i) => ({
        id: i.id,
        underlyingAssetId: i.underlyingAssetId,
      })),
      counts: {},
      preparedAt: at.toISOString(),
    };
    // Bounded preparation concurrency; it is OUTSIDE measurement and uses all
    // real credential/account/funding/transaction validation paths.
    let cursor = 0;
    let preparationError: unknown;
    const preparation = await Promise.allSettled(
      Array.from({ length: Math.min(4, m.users) }, async () => {
        while (cursor < m.users && !preparationError) {
          try {
            const index = cursor++;
            const email = `${m.runId}-${index}@example.invalid`;
            const http = new AppClient(m, c, email, metrics);
            const signed = await http.request(
              'POST',
              '/auth/signup',
              {
                email,
                password: c.userPassword,
                nickname: `load-${index}-${m.runId.slice(-6)}`,
              },
              false,
            );
            await http.login();
            const percentile = (index + 0.5) / m.users;
            const mode =
              percentile < m.accountWeights.general
                ? 'general'
                : percentile <
                    m.accountWeights.general + m.accountWeights.season
                  ? 'season'
                  : 'beginner';
            let accountId: string;
            if (mode === 'season') {
              await http.request('POST', `/seasons/${season.id}/join`);
              accountId = (
                await db.tradingAccount.findFirstOrThrow({
                  where: { userId: signed.user.id, mode: 'season' },
                })
              ).id;
            } else
              accountId = (
                await http.request('POST', `/trading-accounts/${mode}`)
              ).account.id;
            const actorData: FixtureActor = {
              index,
              email,
              userId: signed.user.id,
              accountId,
              mode,
            };
            actors[index] = actorData;
            const actor = new Actor(
              m,
              actorData,
              data,
              http,
              metrics,
              resolve(out, 'prepare.commands.jsonl'),
            );
            const wallets = await db.cashWallet.findMany({
              where: { tradingAccountId: accountId },
            });
            for (const scope of ['crypto_spot', 'crypto_futures'] as const) {
              const quote = await http.request(
                'POST',
                actor.path('/wallet-transfers/quote'),
                {
                  sourceWalletId: wallets.find((w) => w.currencyCode === 'KRW')!
                    .id,
                  destinationWalletId: wallets.find(
                    (w) => w.walletScope === scope,
                  )!.id,
                  amount: '3000000',
                },
              );
              await actor.command('/wallet-transfers/execute', {
                quoteId: quote.quoteId,
                idempotencyKey: actor.idempotency(),
              });
            }
            for (let j = 0; j < m.fixture.historyRounds; j++) {
              const asset = crypto[(index + j) % crypto.length];
              await actor.spotTrade('buy', asset, 'market');
              await actor.spotTrade('sell', asset, 'market');
            }
            for (let j = 0; j < m.fixture.spotHoldings; j++)
              await actor.spotTrade(
                'buy',
                crypto[(index + j) % crypto.length],
                'market',
              );
            for (let j = 0; j < m.fixture.futuresPositions; j++)
              await actor.futuresTrade(true, (index + j) % instruments.length);
            if (index / m.users < m.fixture.pendingRatio) {
              await actor.spotTrade(
                'buy',
                crypto[index % crypto.length],
                'limit',
              );
              const unused =
                (index + m.fixture.futuresPositions) % instruments.length;
              await actor.futuresTrade(false, unused, true);
            }
          } catch (e) {
            preparationError = e;
            throw e;
          }
        }
      }),
    );
    const failed = preparation.find((r) => r.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    if (Object.keys(metrics.counters).some((k) => /failure:/.test(k)))
      throw new Error('PREPARE_REQUEST_OR_IDEMPOTENCY_FAILURE');
    data.counts = {
      users: await db.user.count(),
      accounts: await db.tradingAccount.count(),
      wallets: await db.cashWallet.count(),
      orders: await db.order.count(),
      positions: await db.position.count(),
      futuresPositions: await db.futuresPosition.count(),
      futuresLimitOrders: await db.futuresLimitOrder.count(),
      protections: await db.protectionGroup.count(),
      ledger: await db.walletTransaction.count(),
      candles: await db.marketCandle.count(),
      lastPrices: await db.futuresLastPriceSnapshot.count(),
      marks: await db.futuresMarkSnapshot.count(),
    };
    writeJson(resolve(out, 'fixture.json'), data);
    writeJson(resolve(out, 'prepare-summary.json'), metrics.serializable());
    return data;
  } finally {
    writeJson(resolve(out, 'prepare-summary.json'), metrics.serializable());
    await db.$disconnect();
  }
}
