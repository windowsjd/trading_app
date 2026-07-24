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
  };
});

import {
  AssetType,
  Prisma,
  type MarketCandle,
} from '../generated/prisma/client';
import { MarketCandleAggregationService } from './market-candle-aggregation.service';
import { LiveCandleOverlayService } from './live-candle-overlay.service';
import type { LiveFiveMinuteCandleState } from './live-candle.types';

describe('LiveCandleOverlayService', () => {
  it('combines closed 5m DB rows with the Redis current candle through the existing aggregation service', async () => {
    const repository = {
      findRange: jest
        .fn()
        .mockResolvedValue([
          row('2026-07-13T00:00:00.000Z', '100', '101'),
          row('2026-07-13T00:05:00.000Z', '101', '102'),
        ]),
    };
    const service = new LiveCandleOverlayService(
      {} as never,
      repository as never,
      new MarketCandleAggregationService(repository as never),
    );
    const events = await service.buildCurrentSnapshots(state());

    expect(events.find((event) => event.interval === '5m')).toMatchObject({
      candle: {
        openTime: '2026-07-13T00:10:00.000Z',
        close: '103.00000000',
      },
      provisional: true,
      complete: true,
    });
    expect(events.find((event) => event.interval === '15m')).toMatchObject({
      candle: {
        openTime: '2026-07-13T00:00:00.000Z',
        open: '100.00000000',
        close: '103.00000000',
        volume: '3.00000000',
      },
      provisional: true,
      complete: true,
    });
    expect(repository.findRange).toHaveBeenCalledTimes(1);
  });

  it('never lets a provisional state override a closed row at the same openTime', async () => {
    const canonical = row('2026-07-13T00:10:00.000Z', '200', '201');
    const repository = { findRange: jest.fn().mockResolvedValue([canonical]) };
    const service = new LiveCandleOverlayService(
      {} as never,
      repository as never,
      new MarketCandleAggregationService(repository as never),
    );
    const event = (await service.buildCurrentSnapshots(state())).find(
      (candidate) => candidate.interval === '5m',
    );
    expect(event).toMatchObject({
      candle: { open: '200.00000000', close: '201.00000000' },
      provisional: false,
      final: true,
    });
  });
});

function row(openTime: string, open: string, close: string): MarketCandle {
  const time = new Date(openTime);
  return {
    id: openTime,
    assetId: 'asset-1',
    interval: '5m',
    openTime: time,
    closeTime: new Date(time.getTime() + 300_000),
    open: new Prisma.Decimal(open),
    high: new Prisma.Decimal(close),
    low: new Prisma.Decimal(open),
    close: new Prisma.Decimal(close),
    volume: new Prisma.Decimal('1'),
    amount: new Prisma.Decimal('100'),
    isClosed: true,
    sourceProvider: 'binance_rest',
    sourceUpdatedAt: new Date(time.getTime() + 299_000),
    createdAt: time,
    updatedAt: time,
  };
}

function state(): LiveFiveMinuteCandleState {
  return {
    schemaVersion: 1,
    assetId: 'asset-1',
    assetType: AssetType.crypto,
    market: 'BINANCE',
    symbol: 'BTC',
    interval: '5m',
    openTime: '2026-07-13T00:10:00.000Z',
    closeTime: '2026-07-13T00:15:00.000Z',
    open: '102.00000000',
    high: '104.00000000',
    low: '101.00000000',
    close: '103.00000000',
    volume: '1.00000000',
    amount: '100.00000000',
    firstEventAt: '2026-07-13T00:10:01.000Z',
    lastEventAt: '2026-07-13T00:12:00.000Z',
    sourceUpdatedAt: '2026-07-13T00:12:00.000Z',
    baselineEventTime: null,
    eventCount: 1,
    revision: 1,
    provisional: true,
    complete: true,
    finalized: false,
    providerFinal: false,
    sourceContinuity: true,
    sourceProvider: 'binance_spot_ws_5m_kline',
    delayed: false,
    ownerGeneration: 'owner-1',
    lastSequence: '1',
  };
}
