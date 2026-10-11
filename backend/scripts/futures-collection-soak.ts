import {
  BINANCE_FUTURES_SYMBOLS,
  BINANCE_FUTURES_ONLY_ASSETS,
} from '../src/providers/binance/binance-product-catalog';
/** Real Last + Mark + Spot collection, finance probes, workers and recovery.
 * Disposable loopback DB/Redis only; public Binance market APIs only.
 * SOAK_SECONDS=86400 SOAK_REPORT=/absolute/path.json (also .samples.jsonl).
 * Reports RUNNING until the actual monotonic duration completes; never labels
 * a short run as a 24-hour PASS. Interrupted runs retain incremental evidence.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { db, app, now, fxEvidence } from './futures-integration';
import { RedisService } from '../src/redis/redis.service';
import { ProviderHttpClient } from '../src/providers/provider-http.client';
import { ProviderConfigService } from '../src/providers/provider-config.service';
import { BINANCE_FIXED_ASSET_UNIVERSE } from '../src/providers/binance/binance-fixed-asset-universe';
import { BinancePublicClient } from '../src/providers/binance/binance-public.client';
import { BinancePriceIngestionService } from '../src/providers/binance/binance-price.ingestion.service';
import { BinanceWebSocketIngestionService } from '../src/providers/binance/binance-websocket.ingestion.service';
import { BinanceWebSocketStreamingService } from '../src/providers/binance/binance-websocket-streaming.service';
import { BinanceRealtimePriceCacheService } from '../src/providers/binance/binance-realtime-price-cache.service';
import { BinanceRealtimePriceEventBus } from '../src/providers/binance/binance-realtime-price-event-bus.service';
import { BinanceOrderBookService } from '../src/providers/binance/binance-order-book.service';
import { OrderBookPubSubService } from '../src/providers/order-book-pubsub.service';
import { FuturesLastPriceIngestion } from '../src/futures/futures-last-price-ingestion.service';
import { FuturesMarkIngestion } from '../src/futures/futures-mark-ingestion.service';
import { FuturesLastPriceRetentionService } from '../src/futures/futures-last-price-retention.service';
import { FuturesMarkRetentionService } from '../src/futures/futures-mark-retention.service';
import { FuturesLimitService } from '../src/futures/futures-limit.service';
import { FuturesLimitWorker } from '../src/futures/futures-limit-worker.service';
import { FuturesRiskWorker } from '../src/futures/futures-risk-worker.service';
import { FuturesLiquidationService } from '../src/futures/futures-liquidation.service';
import { ConditionalWorker } from '../src/conditional/conditional-worker.service';
import { ConditionalService } from '../src/conditional/conditional.service';
import { OrdersService } from '../src/orders/orders.service';
import { LimitOrderCancelService } from '../src/orders/limit-order-cancel.service';
import { OrderReservationService } from '../src/orders/order-reservation.service';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import { OpsJobLockService } from '../src/ops/ops-job-lock.service';
import { OpsJobRunService } from '../src/ops/ops-job-run.service';
import {
  parseFuturesContracts,
  FUTURES_EXCHANGE_INFO_URL,
} from '../src/futures/futures-instrument-coverage';
import { readFuturesReferencePrices } from '../src/futures/futures-reference-prices';
import { Prisma } from '../src/generated/prisma/client';

for (const key of ['DATABASE_URL', 'REDIS_URL']) {
  const u = new URL(process.env[key]!);
  assert.ok(
    ['localhost', '127.0.0.1'].includes(u.hostname),
    'Disposable loopback connections required',
  );
  if (key === 'DATABASE_URL') assert.ok(u.pathname.endsWith('_test'));
}
assert.equal(process.env.NODE_ENV, 'test');
const seconds = Number(process.env.SOAK_SECONDS ?? 86400);
assert.ok(Number.isSafeInteger(seconds) && seconds >= 60 && seconds <= 172800);
const reportPath = process.env.SOAK_REPORT!;
assert.ok(reportPath);
Object.assign(process.env, {
  FUTURES_TRADING_MODE: 'ENABLED',
  FUTURES_RISK_ENGINE_ENABLED: 'true',
  FUTURES_MARK_INGESTION_ENABLED: 'true',
  FUTURES_LAST_PRICE_INGESTION_ENABLED: 'true',
  FUTURES_LAST_PRICE_RETENTION_ENABLED: 'true',
  FUTURES_MARK_RETENTION_ENABLED: 'true',
  CONDITIONAL_ORDERS_ENABLED: 'true',
  PROVIDER_INGESTION_ENABLED: 'true',
  BINANCE_PUBLIC_MARKET_DATA_ENABLED: 'true',
  BINANCE_WEBSOCKET_STREAMING_ENABLED: 'true',
  LIVE_CANDLE_ENABLED: 'false',
  LIVE_CANDLE_BINANCE_ENABLED: 'false',
});
const quantiles = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const at = (p: number) =>
    +(s[Math.max(0, Math.ceil(s.length * p) - 1)] ?? 0).toFixed(2);
  return {
    samples: s.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: at(1),
  };
};
const redis = new RedisService(),
  http = new ProviderHttpClient(redis),
  config = new ProviderConfigService();
const last = new FuturesLastPriceIngestion(db, redis),
  mark = new FuturesMarkIngestion(db, redis);
const pubsub = new OrderBookPubSubService(redis),
  orderBooks = new BinanceOrderBookService(db, pubsub);
const spotIngestion = new BinanceWebSocketIngestionService(db, config);
const spot = new BinanceWebSocketStreamingService(
  config,
  spotIngestion,
  new BinanceRealtimePriceCacheService(),
  new BinanceRealtimePriceEventBus(),
  orderBooks,
);
const spotRest = new BinancePriceIngestionService(
  db,
  config,
  new BinancePublicClient(config, http),
);
const locks = new OpsJobLockService(db),
  runs = new OpsJobRunService(db);
const access = new TradingAccountAccessService(db);
const entries = new FuturesLimitService(db, access, app.futures);
const conditional = new ConditionalService(
  db,
  access,
  {} as OrdersService,
  new LimitOrderCancelService(db, new OrderReservationService()),
  app.futures,
);
const workers = [
  new FuturesLimitWorker(db, locks, runs, entries),
  new FuturesRiskWorker(db, locks, runs, new FuturesLiquidationService(db)),
  new ConditionalWorker(db, locks, runs, conditional),
  new FuturesLastPriceRetentionService(db, locks, runs),
  new FuturesMarkRetentionService(db, locks, runs),
];
let stopped = false;
process.on('SIGTERM', () => {
  stopped = true;
});
process.on('SIGINT', () => {
  stopped = true;
});
const nativeFetch = global.fetch;
const rest: Record<
  string,
  { calls: number; failures: number; statuses: Record<string, number> }
> = {};
let faultNetwork = false,
  blockSockets = false;
global.fetch = async (...args) => {
  const u = new URL(String(args[0]));
  const item = (rest[u.hostname + u.pathname] ??= {
    calls: 0,
    failures: 0,
    statuses: {},
  });
  item.calls++;
  try {
    if (faultNetwork && u.hostname === 'fapi.binance.com')
      throw new Error('Injected public-market transport outage');
    const response = await nativeFetch(args[0], args[1]);
    item.statuses[response.status] = (item.statuses[response.status] ?? 0) + 1;
    return response;
  } catch (error) {
    item.failures++;
    throw error;
  }
};
const connections = { last: 0, mark: 0 };
for (const [key, service] of [
  ['last', last],
  ['mark', mark],
] as const) {
  const connect = Reflect.get(service, 'connect').bind(service);
  Reflect.set(service, 'connect', () => {
    if (!blockSockets) {
      connections[key]++;
      connect();
    }
  });
}
const frames: Record<
  string,
  { accepted: number; rejected: number; maxGapMs: number; lastAt: number }
> = {};
const originalAccept = last.accept.bind(last);
const rejectionChecks: Record<string, boolean> = {};
last.accept = (payload, receivedAt) => {
  const ok = originalAccept(payload, receivedAt);
  const p = payload as Record<string, unknown>,
    symbol = typeof p?.s === 'string' ? p.s : '?';
  const row = (frames[symbol] ??= {
    accepted: 0,
    rejected: 0,
    maxGapMs: 0,
    lastAt: performance.now(),
  });
  if (ok) {
    row.accepted++;
    row.maxGapMs = Math.max(row.maxGapMs, performance.now() - row.lastAt);
    row.lastAt = performance.now();
    if (Object.keys(rejectionChecks).length === 0) {
      rejectionChecks.duplicate = !originalAccept(payload, receivedAt);
      rejectionChecks.outOfOrder = !originalAccept(
        { ...p, a: Number(p.a) - 1 },
        receivedAt,
      );
      rejectionChecks.nonPositive = !originalAccept(
        { ...p, a: Number(p.a) + 1, p: '0' },
        receivedAt,
      );
      rejectionChecks.future = !originalAccept(
        { ...p, a: Number(p.a) + 1, T: +receivedAt + 1 },
        receivedAt,
      );
      rejectionChecks.wrongDomain = !originalAccept(
        { ...p, a: Number(p.a) + 1, e: 'markPriceUpdate' },
        receivedAt,
      );
    }
  } else row.rejected++;
  return ok;
};
async function main() {
  await redis.ping();
  const { json } = await http.getJson(FUTURES_EXCHANGE_INFO_URL, {
    provider: 'binance',
    timeoutMs: 5000,
  });
  const contracts = parseFuturesContracts(json);
  const selected = process.env.SOAK_SYMBOLS?.split(',');
  if (selected)
    assert.ok(
      selected.every((symbol) => BINANCE_FUTURES_SYMBOLS.includes(symbol)),
      'SOAK_SYMBOLS must use approved exact Futures identities',
    );
  const universe = [
    ...BINANCE_FIXED_ASSET_UNIVERSE.filter((a) =>
      BINANCE_FUTURES_SYMBOLS.includes(a.symbol),
    ),
    ...BINANCE_FUTURES_ONLY_ASSETS.map((a) => ({
      ...a,
      baseAsset: a.symbol.slice(0, -4),
      priceTickSize: null,
      displayPriceDecimals: 8,
      market: 'BINANCE' as const,
      assetType: 'crypto' as const,
      currencyCode: 'USD' as const,
      priceCurrency: 'USD' as const,
      settlementCurrency: 'USD' as const,
    })),
  ].filter((a) => !selected || selected.includes(a.symbol));
  assert.ok(universe.length > 0);
  process.env.BINANCE_SYMBOLS = BINANCE_FIXED_ASSET_UNIVERSE.filter((a) =>
    universe.some((u) => u.symbol === a.symbol),
  )
    .map((a) => a.symbol)
    .join(',');
  for (const item of universe) {
    const {
      baseAsset: _base,
      priceTickSize: _tick,
      displayPriceDecimals,
      ...asset
    } = item;
    void displayPriceDecimals;
    const created = await db.asset.create({ data: asset });
    if (contracts.has(item.symbol))
      await db.futuresInstrument.create({
        data: {
          underlyingAssetId: created.id,
          markVerifiedAt: await now(),
          markContractJson: contracts.get(item.symbol)!,
        },
      });
  }
  const instruments = await db.futuresInstrument.findMany({
    include: { underlyingAsset: true },
  });
  assert.ok(instruments.length > 0);
  const btc = instruments.find((i) => i.underlyingAsset.symbol === 'BTCUSDT')!;
  assert.ok(btc);
  const user = await db.user.create({
    data: {
      email: `soak-${randomUUID()}@example.invalid`,
      nickname: randomUUID().slice(0, 16),
      passwordHash: 'disposable-fixture',
    },
  });
  const accountId = (await app.general.openGeneralAccount(user.id)).data.account
    .id;
  await db.cashWallet.updateMany({
    where: { tradingAccountId: accountId, walletScope: 'crypto_futures' },
    data: { balanceAmount: '10000' },
  });
  // One-way policy forbids a pending entry and a live lifetime for the same
  // account/instrument. Use a separate owner for the persistent matcher probe.
  const limitUser = await db.user.create({
    data: {
      email: `soak-limit-${randomUUID()}@example.invalid`,
      nickname: randomUUID().slice(0, 16),
      passwordHash: 'disposable-fixture',
    },
  });
  const limitAccountId = (await app.general.openGeneralAccount(limitUser.id))
    .data.account.id;
  await db.cashWallet.updateMany({
    where: { tradingAccountId: limitAccountId, walletScope: 'crypto_futures' },
    data: { balanceAmount: '10000' },
  });
  const fillUser = await db.user.create({
    data: {
      email: `soak-fill-${randomUUID()}@example.invalid`,
      nickname: randomUUID().slice(0, 16),
      passwordHash: 'disposable-fixture',
    },
  });
  const fillAccountId = (await app.general.openGeneralAccount(fillUser.id)).data
    .account.id;
  await db.cashWallet.updateMany({
    where: { tradingAccountId: fillAccountId, walletScope: 'crypto_futures' },
    data: { balanceAmount: '10000' },
  });
  const start = performance.now(),
    startedAt = new Date().toISOString(),
    cpuStart = process.cpuUsage();
  const marketLatency: number[] = [],
    limitLatency: number[] = [],
    limitFillLatency: number[] = [],
    pendingLimitOutcomes: Record<string, number> = {},
    commandErrors: Record<string, number> = {};
  const faults: unknown[] = [],
    clockSteps: unknown[] = [];
  let lastWall = Date.now(),
    lastMono = performance.now(),
    nextProbe = 0,
    nextCommand = 30,
    nextSpotRest = 0;
  let positionId: string | undefined,
    orderId: string | undefined,
    openedWorkerPosition = false,
    samples = 0,
    evaluatedFreshSamples = 0,
    badFreshSamples = 0,
    expectedOutageBlocks = 0,
    peakRss = 0;
  let disconnectInjected = false,
    outageInjected = false;
  const tables =
    () => db.$queryRaw`SELECT 'last' AS domain, count(*)::text AS rows, pg_total_relation_size('futures_last_price_snapshots')::text AS bytes FROM futures_last_price_snapshots
    UNION ALL SELECT 'mark', count(*)::text, pg_total_relation_size('futures_mark_snapshots')::text FROM futures_mark_snapshots
    UNION ALL SELECT 'spot', count(*)::text, pg_total_relation_size('asset_price_snapshots')::text FROM asset_price_snapshots`;
  const before = await tables();
  const save = (state: string, elapsedSeconds: number, extra = {}) =>
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          state,
          requestedSeconds: seconds,
          elapsedSeconds,
          actual24hCompleted: elapsedSeconds >= 86400 && state !== 'RUNNING',
          startedAt,
          database: urlIdentity(),
          instruments: instruments.length,
          spotSymbols: BINANCE_FIXED_ASSET_UNIVERSE.filter((a) =>
            universe.some((u) => u.symbol === a.symbol),
          ).length,
          samples,
          evaluatedFreshSamples,
          badFreshSamples,
          frames,
          rest,
          connections,
          spot: spot.getStatus(),
          rejectionChecks,
          faults,
          clockSteps,
          commands: {
            marketLatencyMs: quantiles(marketLatency),
            limitEvaluationMs: quantiles(limitLatency),
            limitFillMs: quantiles(limitFillLatency),
            pendingLimitOutcomes,
            expectedOutageBlocks,
            errors: commandErrors,
          },
          peakRssMiB: peakRss / 1048576,
          ...extra,
        },
        null,
        2,
      ),
    );
  save('RUNNING', 0, { before });
  last.onModuleInit();
  mark.onModuleInit();
  spot.onModuleInit();
  workers.forEach((w) => w.onModuleInit());
  try {
    while (!stopped && performance.now() - start < seconds * 1000) {
      await delay(100);
      const mono = performance.now(),
        wall = Date.now(),
        elapsed = (mono - start) / 1000;
      const drift = wall - lastWall - (mono - lastMono);
      if (Math.abs(drift) > 20)
        clockSteps.push({ elapsedSeconds: elapsed, stepMs: drift });
      lastWall = wall;
      lastMono = mono;
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      if (elapsed >= 60 && !disconnectInjected) {
        disconnectInjected = true;
        for (const svc of [last, mark])
          (Reflect.get(svc, 'socket') as WebSocket | undefined)?.terminate();
        faults.push({
          elapsedSeconds: elapsed,
          type: 'last_mark_socket_disconnect',
        });
      }
      if (elapsed >= 150 && !outageInjected) {
        outageInjected = true;
        faultNetwork = true;
        blockSockets = true;
        for (const svc of [last, mark])
          (Reflect.get(svc, 'socket') as WebSocket | undefined)?.terminate();
        faults.push({
          elapsedSeconds: elapsed,
          type: '20s_last_mark_ws_rest_outage',
        });
      }
      if (elapsed >= 170 && faultNetwork) {
        faultNetwork = false;
        blockSockets = false;
        faults.push({ elapsedSeconds: elapsed, type: 'transport_restored' });
      }
      if (elapsed >= nextSpotRest) {
        nextSpotRest = elapsed + 60;
        // Exercises the same Redis budget as Futures REST; no manual inserts.
        await spotRest.ingestPrices({ symbols: ['BTCUSDT'] });
      }
      if (elapsed >= nextCommand) {
        nextCommand = elapsed + 30;
        const at = performance.now();
        try {
          await fxEvidence();
          const result = await app.futures.execute(user.id, accountId, {
            instrumentId: btc.id,
            operation: positionId ? 'close' : 'open',
            ...(positionId ? { positionId } : {}),
            direction: 'long',
            quantity: '0.001',
            leverage: 10,
            idempotencyKey: randomUUID(),
          });
          marketLatency.push(performance.now() - at);
          positionId =
            result.data.position.status === 'open'
              ? result.data.position.id
              : undefined;
          if (positionId && !openedWorkerPosition) {
            openedWorkerPosition = true;
            const p = result.data.execution.executionPrice;
            const limit = (
              await entries.create(limitUser.id, limitAccountId, {
                instrumentId: btc.id,
                direction: 'long',
                marginMode: 'isolated',
                leverage: 10,
                quantity: '0.001',
                limitPrice: '1000',
                idempotencyKey: randomUUID(),
              })
            ).data.order;
            orderId = limit.id;
            await conditional.create(user.id, accountId, {
              domain: 'futures',
              assetId: btc.underlyingAssetId,
              positionId,
              idempotencyKey: randomUUID(),
              legs: [
                {
                  kind: 'take_profit',
                  triggerPrice: new Prisma.Decimal(p).mul(2).toFixed(8),
                  childOrderType: 'market',
                },
              ],
            });
          }
        } catch (error) {
          const code =
            (
              error as { getResponse?: () => { error?: { code?: string } } }
            ).getResponse?.()?.error?.code ?? 'UNEXPECTED';
          commandErrors[code] = (commandErrors[code] ?? 0) + 1;
        }
        if (orderId) {
          const at = performance.now();
          try {
            await entries.evaluate(orderId);
          } catch (error) {
            const code =
              (
                error as { getResponse?: () => { error?: { code?: string } } }
              ).getResponse?.()?.error?.code ?? 'UNEXPECTED';
            // This probe deliberately remains nonmarketable. Its explicit
            // predicate rejection is evidence of correct matching, not a fill.
            const outcomes =
              code === 'FUTURES_ENTRY_LIMIT_NOT_REACHED'
                ? pendingLimitOutcomes
                : commandErrors;
            outcomes[`limit:${code}`] = (outcomes[`limit:${code}`] ?? 0) + 1;
          } finally {
            limitLatency.push(performance.now() - at);
          }
        }
        // A separate owner exercises actual scheduler fills and closes, so
        // latency includes worker polling and transactional execution.
        try {
          const reference = (
            await readFuturesReferencePrices(db, [btc], await now())
          ).get(btc.id)?.last;
          if (reference) {
            const at = performance.now();
            const order = (
              await entries.create(fillUser.id, fillAccountId, {
                instrumentId: btc.id,
                direction: 'long',
                marginMode: 'isolated',
                leverage: 10,
                quantity: '0.001',
                limitPrice: reference.price.mul('1.02').toFixed(8),
                idempotencyKey: randomUUID(),
              })
            ).data.order;
            let filled = await db.futuresLimitOrder.findUniqueOrThrow({
              where: { id: order.id },
            });
            while (
              filled.status === 'submitted' &&
              performance.now() - at < 10000
            ) {
              await delay(100);
              filled = await db.futuresLimitOrder.findUniqueOrThrow({
                where: { id: order.id },
              });
            }
            if (
              filled.status === 'submitted' &&
              elapsed >= 150 &&
              elapsed < 170
            ) {
              // Without post-entry Last evidence the injected outage must
              // leave the order pending. Cancel the fixture through the normal
              // command so recovery probes can continue on the same owner.
              await entries.cancel(fillUser.id, fillAccountId, order.id);
              assert.equal(
                (
                  await db.futuresLimitOrder.findUniqueOrThrow({
                    where: { id: order.id },
                  })
                ).status,
                'canceled',
              );
              expectedOutageBlocks++;
            } else {
              assert.equal(
                filled.status,
                'executed',
                'Scheduler must fill marketable fixture',
              );
              assert.ok(filled.executionId);
              const execution = await db.futuresExecution.findUniqueOrThrow({
                where: { id: filled.executionId },
              });
              limitFillLatency.push(performance.now() - at);
              await app.futures.execute(fillUser.id, fillAccountId, {
                instrumentId: btc.id,
                operation: 'close',
                positionId: execution.positionId,
                direction: 'long',
                quantity: '0.001',
                leverage: 10,
                idempotencyKey: randomUUID(),
              });
            }
          }
        } catch (error) {
          const code =
            (
              error as { getResponse?: () => { error?: { code?: string } } }
            ).getResponse?.()?.error?.code ?? 'UNEXPECTED';
          commandErrors[`fill:${code}`] =
            (commandErrors[`fill:${code}`] ?? 0) + 1;
        }
      }
      if (elapsed >= nextProbe) {
        nextProbe = elapsed + 10;
        const references = await readFuturesReferencePrices(
          db,
          instruments,
          await now(),
        );
        const fresh = [...references.values()].filter(
          (r) => !!r.last && !!r.mark,
        ).length;
        const plannedFault = elapsed < 30 || (elapsed >= 150 && elapsed <= 190);
        samples++;
        if (!plannedFault) {
          evaluatedFreshSamples++;
          if (fresh !== instruments.length) badFreshSamples++;
        }
        const workerRuns = await db.opsJobRun.findMany({
          where: {
            jobName: {
              in: [
                'futures_limit_matching',
                'conditional_orders',
                'futures_liquidation',
                'futures_last_price_retention',
                'futures_mark_retention',
              ],
            },
          },
          orderBy: { startedAt: 'desc' },
          distinct: ['jobName'],
        });
        const sample = {
          elapsedSeconds: elapsed,
          evaluatedAt: new Date().toISOString(),
          fresh,
          references: instruments.map((instrument) => {
            const ref = references.get(instrument.id)!;
            return {
              symbol: instrument.underlyingAsset.symbol,
              last: ref.last
                ? {
                    source: ref.last.source,
                    effectiveAt: ref.last.effectiveAt,
                    capturedAt: ref.last.capturedAt,
                  }
                : null,
              mark: ref.mark
                ? {
                    source: ref.mark.source,
                    effectiveAt: ref.mark.effectiveAt,
                    capturedAt: ref.mark.capturedAt,
                  }
                : null,
            };
          }),
          expected: instruments.length,
          plannedFault,
          memory: process.memoryUsage(),
          processCpu: process.cpuUsage(cpuStart),
          databaseStats:
            await db.$queryRaw`SELECT xact_commit::text, xact_rollback::text, blks_read::text, blks_hit::text, tup_inserted::text, tup_updated::text, tup_deleted::text, temp_bytes::text,
            (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS connections
            FROM pg_stat_database WHERE datname = current_database()`,
          opsLocks: await db.opsJobLock.findMany(),
          tables: await tables(),
          spot: spot.getStatus(),
          workers: workerRuns,
          coverageVerifiedAt: await db.futuresInstrument.findMany({
            select: { id: true, markVerifiedAt: true },
          }),
        };
        appendFileSync(
          reportPath + '.samples.jsonl',
          JSON.stringify(sample) + '\n',
        );
        save('RUNNING', elapsed, { before, latestSample: sample });
      }
    }
    const elapsed = (performance.now() - start) / 1000,
      cpu = process.cpuUsage(cpuStart);
    const after = await tables();
    // Deliberate outages are documented, not subtracted from raw measurements.
    const assertions = {
      allInvalidFramesRejected:
        Object.keys(rejectionChecks).length === 5 &&
        Object.values(rejectionChecks).every(Boolean),
      collectedAllThree: (after as Array<{ rows: string }>).every(
        (r) => Number(r.rows) > 0,
      ),
      recoveredFinalPrices: [
        ...(
          await readFuturesReferencePrices(db, instruments, await now())
        ).values(),
      ].every((r) => !!r.last && !!r.mark),
      noUnplannedFinancialErrors: Object.keys(commandErrors).length === 0,
      actualMarketAndLimitFills:
        marketLatency.length > 0 && limitFillLatency.length > 0,
      freshOutsidePlannedFaults:
        evaluatedFreshSamples > 0 &&
        badFreshSamples / evaluatedFreshSamples <= 0.01,
      noClockSteps: clockSteps.length === 0,
    };
    save(
      stopped
        ? 'INTERRUPTED'
        : Object.values(assertions).every(Boolean)
          ? 'PASS'
          : 'FAIL',
      elapsed,
      {
        before,
        after,
        assertions,
        cpuCorePercent: (cpu.user + cpu.system) / (elapsed * 10000),
        completedAt: new Date().toISOString(),
      },
    );
    if (stopped || !Object.values(assertions).every(Boolean))
      process.exitCode = 1;
  } finally {
    workers.forEach((w) => w.onModuleDestroy());
    await last.onModuleDestroy();
    await mark.onModuleDestroy();
    await spot.onModuleDestroy();
    await orderBooks.onModuleDestroy();
    await pubsub.onModuleDestroy();
  }
}
function urlIdentity() {
  const u = new URL(process.env.DATABASE_URL!);
  return `${u.hostname}:${u.port}/${u.pathname.slice(1)}`;
}
main()
  .catch((error) => {
    console.error(error);
    writeFileSync(
      reportPath + '.failure.json',
      JSON.stringify({
        state: 'FAIL',
        message: error instanceof Error ? error.message : 'unknown failure',
        at: new Date().toISOString(),
      }),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    global.fetch = nativeFetch;
    await http.onModuleDestroy();
    await redis.onModuleDestroy();
    await db.$disconnect();
  });
