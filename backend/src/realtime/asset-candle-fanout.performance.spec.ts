jest.mock('../generated/prisma/client', () => ({
  PrismaClient: class PrismaClient {},
  UserStatus: { active: 'active' },
}));
jest.mock('../assets/live-candle-overlay.service', () => ({
  LiveCandleOverlayService: class LiveCandleOverlayService {},
}));
jest.mock('./live-candle-pubsub.service', () => ({
  LiveCandlePubSubService: class LiveCandlePubSubService {},
}));
jest.mock('../assets/assets.service', () => ({
  AssetsService: class AssetsService {},
}));

import { BinanceRealtimePriceEventBus } from '../providers/binance/binance-realtime-price-event-bus.service';
import { KisRealtimePriceEventBus } from '../providers/kis/kis-realtime-price-event-bus.service';
import type { AssetCandleSnapshotEvent } from '../assets/live-candle.types';
import { AssetTickerGateway } from './asset-ticker.gateway';

describe('asset candle synthetic fanout harness', () => {
  it('fans one shared snapshot to 2,000 clients with bounded slow-client queues and complete cleanup', () => {
    const prisma = {
      asset: { findUnique: jest.fn() },
      marketCandle: { create: jest.fn(), update: jest.fn(), upsert: jest.fn() },
    };
    const gateway = new AssetTickerGateway(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      new KisRealtimePriceEventBus(),
      new BinanceRealtimePriceEventBus(),
      undefined,
      undefined,
      {
        maxSubscriptionsPerClient: 20,
        websocketBackpressureBytes: 1_024,
      } as never,
    );
    const clients = clientMap(gateway);
    const sockets = Array.from({ length: 2_000 }, (_, index) => ({
      readyState: 1,
      bufferedAmount: index < 100 ? 2_048 : 0,
      send: jest.fn(),
    }));
    for (const [index, socket] of sockets.entries()) {
      clients.set(socket, {
        userId: `user-${index}`,
        subscriptions: new Map(),
        candleSubscriptions: new Map([
          ['asset-1\u00005m', { lastSequence: 0, lastRevision: -1 }],
        ]),
        pendingCandles: new Map(),
      });
    }

    push(gateway, event(1));
    push(gateway, event(2));

    expect(
      sockets.slice(100).every((socket) => socket.send.mock.calls.length === 2),
    ).toBe(true);
    for (const socket of sockets.slice(0, 100)) {
      const state = clients.get(socket) as {
        pendingCandles: Map<string, AssetCandleSnapshotEvent>;
      };
      expect(state.pendingCandles.size).toBe(1);
      expect([...state.pendingCandles.values()][0].sequence).toBe(2);
    }
    expect(prisma.asset.findUnique).not.toHaveBeenCalled();
    expect(prisma.marketCandle.create).not.toHaveBeenCalled();
    expect(prisma.marketCandle.update).not.toHaveBeenCalled();
    expect(prisma.marketCandle.upsert).not.toHaveBeenCalled();

    for (const socket of sockets) gateway.handleDisconnect(socket as never);
    expect(clients.size).toBe(0);
  });
});

function clientMap(gateway: AssetTickerGateway): Map<any, any> {
  return (gateway as unknown as { clients: Map<any, any> }).clients;
}

function push(gateway: AssetTickerGateway, value: AssetCandleSnapshotEvent) {
  (
    gateway as unknown as {
      pushLiveCandleEvent(event: AssetCandleSnapshotEvent): void;
    }
  ).pushLiveCandleEvent(value);
}

function event(sequence: number): AssetCandleSnapshotEvent {
  return {
    type: 'asset_candle',
    assetId: 'asset-1',
    interval: '5m',
    candle: {
      time: '2026-07-13T00:00:00.000Z',
      openTime: '2026-07-13T00:00:00.000Z',
      closeTime: '2026-07-13T00:05:00.000Z',
      open: '100.00000000',
      high: '110.00000000',
      low: '90.00000000',
      close: '105.00000000',
      volume: '10.00000000',
      amount: null,
    },
    revision: sequence,
    sequence,
    provisional: true,
    complete: true,
    delayed: false,
    sourceUpdatedAt: '2026-07-13T00:04:00.000Z',
    final: false,
  };
}
