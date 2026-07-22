jest.mock('../../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');
  return {
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    CurrencyCode: { KRW: 'KRW', USD: 'USD' },
    Prisma: { Decimal },
    PrismaClient: class PrismaClient {},
    OpsJobName: { limit_order_matcher: 'limit_order_matcher' },
    OpsJobRunStatus: { running: 'running', failed: 'failed' },
    OpsJobTrigger: { worker: 'worker' },
    FxRateSourceType: {
      admin_manual: 'admin_manual',
      provider_api: 'provider_api',
    },
    AssetPriceSourceType: { provider_api: 'provider_api' },
    OrderSide: { buy: 'buy', sell: 'sell' },
    OrderStatus: {
      submitted: 'submitted',
      executed: 'executed',
      canceled: 'canceled',
      rejected: 'rejected',
    },
    OrderType: { market: 'market', limit: 'limit' },
    ParticipantStatus: {
      active: 'active',
      excluded: 'excluded',
      finished: 'finished',
    },
    SeasonStatus: { active: 'active', ended: 'ended' },
    SnapshotReason: { order_executed: 'order_executed' },
    WalletTransactionDirection: { debit: 'debit', credit: 'credit' },
    WalletTransactionReferenceType: { order: 'order' },
    WalletTransactionType: { order_buy: 'order_buy' },
    SeasonRankingType: { daily: 'daily', weekly: 'weekly', season: 'season' },
  };
});

import { AssetType, CurrencyCode } from '../../generated/prisma/client';
import { LimitOrderEventPollerService } from './limit-order-event-poller.service';
import { buildLimitOrderPriceEvent } from './limit-order-price-event.types';

const ASSET = {
  id: 'asset-1',
  symbol: 'BTC',
  market: 'BINANCE',
  assetType: AssetType.crypto,
  settlementCurrency: CurrencyCode.USD,
};

function buildEvent(price = '90') {
  const now = new Date();
  return buildLimitOrderPriceEvent({
    tick: {
      provider: 'binance',
      providerEventId: `trade-${price}`,
      providerSequence: '1',
      providerConnectionId: 'gen-1',
      assetId: ASSET.id,
      symbol: ASSET.symbol,
      providerSymbol: 'BTCUSDT',
      price,
      currencyCode: CurrencyCode.USD,
      providerEventAt: new Date(now.getTime() - 20).toISOString(),
      receivedAt: new Date(now.getTime() - 10).toISOString(),
      sourceName: 'binance_spot_ws_trade',
      marketSessionCode: null,
      eventType: 'trade',
    },
    asset: ASSET,
    publishedAt: now,
  });
}

type Trace = string[];

function harness(options: { alreadyProcessed?: boolean } = {}) {
  const trace: Trace = [];
  let assetQueryCount = 0;
  const prisma = {
    asset: {
      findUnique: () => {
        assetQueryCount += 1;
        trace.push('asset_query');
        return Promise.resolve({
          symbol: ASSET.symbol,
          market: ASSET.market,
          assetType: ASSET.assetType,
          currencyCode: CurrencyCode.USD,
          settlementCurrency: CurrencyCode.USD,
          isActive: true,
        });
      },
    },
    limitOrderProcessedEvent: {
      findUnique: () => {
        trace.push('dedupe_read');
        return Promise.resolve(
          options.alreadyProcessed ? { eventId: 'x' } : null,
        );
      },
      create: () => {
        trace.push('processed_insert');
        return Promise.resolve({});
      },
    },
  };
  const stream = {
    acknowledge: () => {
      trace.push('ack');
      return Promise.resolve();
    },
    moveToDlq: () => {
      trace.push('dlq');
      return Promise.resolve();
    },
    inspect: () =>
      Promise.resolve({
        firstId: '1-0',
        lastId: '2-0',
        groupLastDeliveredId: '2-0',
        pendingCount: 0,
        lag: 0,
        length: 2,
        oldestPendingId: null,
      }),
  };
  const candidates = {
    findCandidates: () => {
      trace.push('candidate_query');
      return Promise.resolve([]);
    },
  };
  const execution = { executeCandidate: () => Promise.resolve({}) };
  const boundary = {
    acquireSession: () => {
      trace.push('boundary_acquire');
      return Promise.resolve({
        release: () => {
          trace.push('boundary_release');
          return Promise.resolve();
        },
      });
    },
  };
  const health = {
    recordEventFailure: () => Promise.resolve(),
    collectProcessedEventStats: () => Promise.resolve(null),
  };
  const poller = new LimitOrderEventPollerService(
    prisma as never,
    stream as never,
    {} as never,
    health as never,
    candidates as never,
    execution as never,
    boundary as never,
  );
  return {
    trace,
    poller,
    assetQueryCount: () => assetQueryCount,
  };
}

async function processEntry(
  poller: LimitOrderEventPollerService,
  streamId: string,
  event: ReturnType<typeof buildEvent>,
): Promise<void> {
  await (
    poller as unknown as {
      processEntry(entry: {
        streamId: string;
        eventId: string;
        payload: string;
      }): Promise<void>;
    }
  ).processEntry({
    streamId,
    eventId: event.eventId,
    payload: JSON.stringify(event),
  });
}

describe('LimitOrderEventPollerService boundary and ACK ordering', () => {
  const original = { ...process.env };
  beforeEach(() => {
    process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED = 'true';
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it('does every durable step inside the boundary and ACKs only afterwards', async () => {
    const { poller, trace } = harness();
    await processEntry(poller, '100-1', buildEvent());

    expect(trace).toEqual([
      'asset_query',
      'boundary_acquire',
      'dedupe_read',
      'candidate_query',
      'processed_insert',
      'boundary_release',
      'ack',
    ]);
    // The processed row must be durable BEFORE the ACK: an ACK first would
    // lose the event entirely on a crash.
    expect(trace.indexOf('processed_insert')).toBeLessThan(
      trace.indexOf('ack'),
    );
    // The boundary must be released BEFORE the Redis round trip so a create
    // never waits on network I/O.
    expect(trace.indexOf('boundary_release')).toBeLessThan(
      trace.indexOf('ack'),
    );
    // Candidate discovery happens under the boundary, so a create cannot
    // commit between the query and the fill.
    expect(trace.indexOf('boundary_acquire')).toBeLessThan(
      trace.indexOf('candidate_query'),
    );
    expect(trace.indexOf('candidate_query')).toBeLessThan(
      trace.indexOf('boundary_release'),
    );
  });

  it('releases the boundary before ACKing an already-processed duplicate', async () => {
    const { poller, trace } = harness({ alreadyProcessed: true });
    await processEntry(poller, '100-1', buildEvent());

    expect(trace).toEqual([
      'asset_query',
      'boundary_acquire',
      'dedupe_read',
      'boundary_release',
      'ack',
    ]);
    expect(trace).not.toContain('processed_insert');
  });

  it('serves repeated trades on one asset from cache instead of the database', async () => {
    const { poller, assetQueryCount } = harness();
    for (let index = 0; index < 25; index += 1) {
      await processEntry(
        poller,
        `100-${index}`,
        buildEvent(String(90 + index)),
      );
    }
    // One read for the first trade; the rest are served from the bounded
    // per-generation cache.
    expect(assetQueryCount()).toBe(1);
  });

  it('re-reads the asset after the cache TTL elapses', async () => {
    process.env.LIMIT_ORDER_ASSET_CACHE_TTL_MS = '0';
    const { poller, assetQueryCount } = harness();
    await processEntry(poller, '100-1', buildEvent('90'));
    await processEntry(poller, '100-2', buildEvent('91'));
    expect(assetQueryCount()).toBe(2);
  });
});
