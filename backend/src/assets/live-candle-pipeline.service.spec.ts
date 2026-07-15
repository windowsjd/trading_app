jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<{ Decimal: unknown }>(
    '@prisma/client/runtime/client',
  );
  return {
    PrismaClient: class PrismaClient {},
    Prisma: { Decimal },
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    MarketCandleSyncMode: { repair: 'repair' },
  };
});
jest.mock('./live-candle-hydrator.service', () => ({
  LiveCandleHydratorService: class LiveCandleHydratorService {},
}));

import { AssetType } from '../generated/prisma/client';
import { LiveCandleHealthService } from './live-candle-health.service';
import { LiveCandlePipelineService } from './live-candle-pipeline.service';
import type {
  LiveFiveMinuteCandleState,
  NormalizedLiveCandleEvent,
} from './live-candle.types';

describe('LiveCandlePipelineService', () => {
  const setup = () => {
    const store = {
      getCurrent: jest.fn().mockResolvedValue(null),
      applyEvent: jest.fn(),
      markIncomplete: jest.fn().mockResolvedValue(true),
    };
    const hydrator = {
      hydrate: jest
        .fn()
        .mockResolvedValue({ baseline: null, canonicalClosed: false }),
    };
    const publisher = { publishState: jest.fn().mockResolvedValue([]) };
    const health = new LiveCandleHealthService();
    const service = new LiveCandlePipelineService(
      store as never,
      hydrator as never,
      publisher as never,
      health,
    );
    return { store, hydrator, publisher, health, service };
  };

  it('marks only a bucket entered after a continuous connection as complete-capable', async () => {
    const { store, hydrator, service } = setup();
    const event = deltaEvent('2026-07-13T00:05:00.000Z');
    store.applyEvent.mockImplementation(
      (input: { event: NormalizedLiveCandleEvent }) =>
        Promise.resolve({
          status: 'updated',
          stateKey: 'state-1',
          state: stateFor(input.event),
        }),
    );
    service.markProviderConnected({
      provider: 'kis',
      ownerGeneration: 'owner-1',
      connectedAt: new Date('2026-07-13T00:02:00.000Z'),
    });

    await service.process({
      event,
      ownerGeneration: 'owner-1',
      ownerLeaseKey: 'lease',
    });

    expect(store.applyEvent).toHaveBeenCalledWith(
      expect.objectContaining({ continuousAtBucketOpen: true }),
    );
    expect(hydrator.hydrate).not.toHaveBeenCalled();
  });

  it('keeps a reconnect in the middle of the current bucket incomplete', async () => {
    const { store, service } = setup();
    const event = deltaEvent('2026-07-13T00:05:00.000Z');
    store.applyEvent.mockResolvedValue({
      status: 'updated',
      stateKey: 'state-1',
      state: stateFor(event),
    });
    service.markProviderConnected({
      provider: 'kis',
      ownerGeneration: 'owner-1',
      connectedAt: new Date('2026-07-13T00:07:00.000Z'),
    });
    await service.process({
      event,
      ownerGeneration: 'owner-1',
      ownerLeaseKey: 'lease',
    });
    expect(store.applyEvent).toHaveBeenCalledWith(
      expect.objectContaining({ continuousAtBucketOpen: false }),
    );
  });

  it('requires an overlap between a current REST baseline and stream continuity', async () => {
    const { store, hydrator, service } = setup();
    const event = deltaEvent('2026-07-13T00:05:00.000Z');
    store.applyEvent.mockResolvedValue({
      status: 'updated',
      stateKey: 'state-1',
      state: stateFor(event),
    });
    hydrator.hydrate.mockResolvedValue({
      canonicalClosed: false,
      baseline: {
        open: '99.00000000',
        high: '101.00000000',
        low: '98.00000000',
        close: '100.00000000',
        volume: '10.00000000',
        amount: null,
        firstEventAt: new Date('2026-07-13T00:05:00.000Z'),
        lastEventAt: new Date('2026-07-13T00:06:00.000Z'),
        sourceUpdatedAt: new Date('2026-07-13T00:06:00.000Z'),
        baselineEventTime: new Date('2026-07-13T00:06:00.000Z'),
        complete: true,
      },
    });
    service.markProviderConnected({
      provider: 'kis',
      ownerGeneration: 'owner-1',
      connectedAt: new Date('2026-07-13T00:06:01.000Z'),
    });

    await service.process({
      event,
      ownerGeneration: 'owner-1',
      ownerLeaseKey: 'lease',
    });
    expect(store.applyEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ continuousAtBucketOpen: false }),
    );

    service.markProviderConnected({
      provider: 'kis',
      ownerGeneration: 'owner-2',
      connectedAt: new Date('2026-07-13T00:05:59.000Z'),
    });
    await service.process({
      event,
      ownerGeneration: 'owner-2',
      ownerLeaseKey: 'lease',
    });
    expect(store.applyEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ continuousAtBucketOpen: true }),
    );
  });

  it('keeps the first valid event as the continuity boundary for one owner generation', () => {
    const { service } = setup();
    service.markProviderConnected({
      provider: 'kis',
      ownerGeneration: 'owner-1',
      connectedAt: new Date('2026-07-13T00:02:00.000Z'),
    });
    service.markProviderConnected({
      provider: 'kis',
      ownerGeneration: 'owner-1',
      connectedAt: new Date('2026-07-13T00:06:00.000Z'),
    });
    expect(
      (
        service as unknown as {
          continuityByProvider: Map<string, { since: Date }>;
        }
      ).continuityByProvider
        .get('kis')
        ?.since.toISOString(),
    ).toBe('2026-07-13T00:02:00.000Z');
  });

  it('bounds continuity-loss tracking to the latest bucket per asset', async () => {
    const { store, service } = setup();
    store.applyEvent
      .mockImplementationOnce(
        ({ event }: { event: NormalizedLiveCandleEvent }) =>
          Promise.resolve({
            status: 'updated',
            stateKey: 'old-state',
            state: stateFor(event),
          }),
      )
      .mockImplementationOnce(
        ({ event }: { event: NormalizedLiveCandleEvent }) =>
          Promise.resolve({
            status: 'updated',
            stateKey: 'current-state',
            state: stateFor(event),
          }),
      );
    await service.process({
      event: deltaEvent('2026-07-13T00:00:00.000Z'),
      ownerGeneration: 'owner-1',
      ownerLeaseKey: 'lease',
    });
    await service.process({
      event: deltaEvent('2026-07-13T00:05:00.000Z'),
      ownerGeneration: 'owner-1',
      ownerLeaseKey: 'lease',
    });

    await service.markProviderContinuityLost({
      provider: 'kis',
      ownerGeneration: 'owner-1',
      ownerLeaseKey: 'lease',
    });

    expect(store.markIncomplete).toHaveBeenCalledTimes(1);
    expect(store.markIncomplete).toHaveBeenCalledWith(
      expect.objectContaining({ stateKey: 'current-state' }),
    );
  });

  it('does not create a provisional overlay over an already closed canonical row', async () => {
    const { store, hydrator, service } = setup();
    hydrator.hydrate.mockResolvedValue({
      baseline: null,
      canonicalClosed: true,
    });
    const result = await service.process({
      event: deltaEvent('2026-07-13T00:05:00.000Z'),
      ownerGeneration: 'owner-1',
      ownerLeaseKey: 'lease',
    });
    expect(result.status).toBe('baseline_covered');
    expect(store.applyEvent).not.toHaveBeenCalled();
  });
});

function deltaEvent(openTime: string): NormalizedLiveCandleEvent {
  const open = new Date(openTime);
  return {
    provider: 'kis',
    source: 'kis_krx_realtime_trade',
    assetId: 'asset-1',
    assetType: AssetType.domestic_stock,
    market: 'KRX',
    symbol: '005930',
    eventTime: new Date(open.getTime() + 60_000),
    receivedAt: new Date(open.getTime() + 61_000),
    price: '100.00000000',
    tradeQuantity: '1.00000000',
    amount: null,
    eventId: `event-${open.getTime()}`,
    sequence: String(open.getTime()),
    marketSession: 'regular',
    delayed: false,
    openTime: open,
    closeTime: new Date(open.getTime() + 300_000),
    mode: 'delta',
    absolute: null,
  };
}

function stateFor(event: NormalizedLiveCandleEvent): LiveFiveMinuteCandleState {
  return {
    schemaVersion: 1,
    assetId: event.assetId,
    assetType: event.assetType,
    market: event.market,
    symbol: event.symbol,
    interval: '5m',
    openTime: event.openTime.toISOString(),
    closeTime: event.closeTime.toISOString(),
    open: event.price,
    high: event.price,
    low: event.price,
    close: event.price,
    volume: '1.00000000',
    amount: null,
    firstEventAt: event.eventTime.toISOString(),
    lastEventAt: event.eventTime.toISOString(),
    sourceUpdatedAt: event.eventTime.toISOString(),
    baselineEventTime: null,
    eventCount: 1,
    revision: 1,
    provisional: true,
    complete: false,
    finalized: false,
    providerFinal: false,
    sourceContinuity: false,
    sourceProvider: event.source,
    delayed: false,
    ownerGeneration: 'owner-1',
    lastSequence: event.sequence,
  };
}
