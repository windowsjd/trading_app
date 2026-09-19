jest.mock('../../generated/prisma/client', () => ({
  Prisma: {
    Decimal: jest.requireActual<{ Decimal: unknown }>(
      '@prisma/client/runtime/client',
    ).Decimal,
  },
  PrismaClient: class {},
  AssetType: { crypto: 'crypto' },
  CurrencyCode: { USD: 'USD' },
}));
import { BinanceOrderBookService } from './binance-order-book.service';
import { BINANCE_FIXED_ASSET_UNIVERSE } from './binance-fixed-asset-universe';
import type { OrderBookEvent } from '../order-book.types';

const frame = (id: number | string, symbol = 'btcusdt') =>
  JSON.stringify({
    stream: `${symbol}@depth10`,
    data: {
      lastUpdateId: id,
      asks: [['68420.10000000', '0.00125000']],
      bids: [['68420.09000000', '12345678901234567890.123456789012345678']],
    },
  });
const receivedAt = new Date('2026-09-19T00:00:00.123Z');
function setup(assets = [{ id: 'btc', symbol: 'BTCUSDT' }]) {
  const prisma = { asset: { findMany: jest.fn().mockResolvedValue(assets) } };
  const pubsub = { publish: jest.fn().mockResolvedValue(true) };
  return {
    prisma,
    pubsub,
    service: new BinanceOrderBookService(prisma as never, pubsub as never),
  };
}

describe('shared Binance order book processor', () => {
  it('maps and publishes depth10 for every fixed asset, including the fifteen additions', async () => {
    const entries = BINANCE_FIXED_ASSET_UNIVERSE;
    const { service, pubsub, prisma } = setup(
      entries.map((entry, index) => ({
        id: `asset-${entry.symbol}`,
        symbol: index % 2 ? entry.baseAsset : entry.symbol,
      })),
    );
    const targets = await service.loadTargets();
    expect(targets.size).toBe(25);
    const query = prisma.asset.findMany.mock.calls[0] as unknown as [
      { where: { symbol: { in: string[] } } },
    ];
    for (const entry of entries) {
      expect(query[0].where.symbol.in).toEqual(
        expect.arrayContaining([entry.symbol, entry.baseAsset]),
      );
      expect(targets.get(entry.symbol)).toEqual({
        assetId: `asset-${entry.symbol}`,
        symbol: entry.symbol,
        baseAsset: entry.baseAsset,
      });
      service.handleFrame(
        frame(1, entry.symbol.toLowerCase()),
        receivedAt,
        targets,
      );
      const published = pubsub.publish.mock.calls.at(-1) as unknown as [
        OrderBookEvent,
      ];
      expect(published[0].book).toMatchObject({
        assetId: `asset-${entry.symbol}`,
        quantityUnit: entry.baseAsset,
        priceUnit: 'USDT',
      });
    }
    await service.onModuleDestroy();
  });

  it('maps only active Binance crypto USD assets in the fixed universe and fails closed on ambiguity', async () => {
    const { service, prisma } = setup([
      { id: 'a', symbol: 'BTC' },
      { id: 'b', symbol: 'BTCUSDT' },
      { id: 'c', symbol: 'ETHUSDT' },
      { id: 'd', symbol: 'NOTSUPPORTEDUSDT' },
      { id: 'e', symbol: '币安人生' },
      { id: 'f', symbol: '币安人生USDT' },
    ]);
    expect([...(await service.loadTargets())]).toEqual([
      ['ETHUSDT', { assetId: 'c', symbol: 'ETHUSDT', baseAsset: 'ETH' }],
    ]);
    expect(
      (
        prisma.asset.findMany.mock.calls[0] as unknown as [
          { where: Record<string, unknown> },
        ]
      )[0].where,
    ).toMatchObject({
      isActive: true,
      assetType: 'crypto',
      market: 'BINANCE',
      currencyCode: 'USD',
    });
    const query = prisma.asset.findMany.mock.calls[0] as unknown as [
      { where: { symbol: { in: string[] } } },
    ];
    expect(query[0].where.symbol.in).toContain('XRPUSDT');
  });

  it('publishes neutral decimal strings with receipt time and no invented effectiveAt, totals or raw fields', async () => {
    const { service, pubsub } = setup();
    service.handleFrame(
      frame('90071992547409931234'),
      receivedAt,
      await service.loadTargets(),
    );
    await Promise.resolve();
    expect(pubsub.publish).toHaveBeenCalledWith({
      type: 'asset_order_book',
      sequence: '90071992547409931234',
      book: {
        assetId: 'btc',
        priceUnit: 'USDT',
        quantityUnit: 'BTC',
        marketLabel: 'BTC / USDT',
        asks: [{ price: '68420.10000000', quantity: '0.00125000' }],
        bids: [
          {
            price: '68420.09000000',
            quantity: '12345678901234567890.123456789012345678',
          },
        ],
        capturedAt: receivedAt.toISOString(),
        effectiveAt: null,
      },
    });
    await service.onModuleDestroy();
  });

  it('rejects duplicate/regressing ids across target reloads and never misroutes unknown symbols', async () => {
    const { service, pubsub } = setup();
    const targets = await service.loadTargets();
    for (const id of [
      '90071992547409931234',
      '90071992547409931234',
      '90071992547409931233',
    ])
      service.handleFrame(frame(id), receivedAt, targets);
    service.handleFrame(frame(999, 'ethusdt'), receivedAt, targets);
    service.handleFrame(
      frame('90071992547409931234'),
      receivedAt,
      await service.loadTargets(),
    );
    expect(pubsub.publish).toHaveBeenCalledTimes(1);
    expect(service.getStatus()).toMatchObject({
      accepted: 1,
      rejected: 1,
      outOfOrder: 3,
    });
    await service.onModuleDestroy();
  });

  it('coalesces a slow Redis publisher per asset and bounds pending work', async () => {
    const { service, pubsub } = setup();
    let release!: (value: boolean) => void;
    pubsub.publish.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const targets = await service.loadTargets();
    for (let id = 1; id <= 104; id += 1)
      service.handleFrame(frame(id), receivedAt, targets);
    expect(service.getStatus()).toMatchObject({ pending: 1, publishing: 1 });
    expect(pubsub.publish).toHaveBeenCalledTimes(1);
    release(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(pubsub.publish).toHaveBeenCalledTimes(2);
    expect(
      (pubsub.publish.mock.calls[1] as unknown as [{ sequence: string }])[0]
        .sequence,
    ).toBe('104');
    expect(service.getStatus()).toMatchObject({ pending: 0, publishing: 0 });
    await service.onModuleDestroy();
  });

  it('records publish failures and recovers on the next fresh snapshot', async () => {
    const { service, pubsub } = setup();
    pubsub.publish.mockResolvedValueOnce(false);
    const targets = await service.loadTargets();
    service.handleFrame(frame(1), receivedAt, targets);
    await new Promise((resolve) => setImmediate(resolve));
    service.handleFrame(frame(2), receivedAt, targets);
    await new Promise((resolve) => setImmediate(resolve));
    expect(service.getStatus()).toMatchObject({
      publishFailed: 1,
      published: 1,
    });
    await service.onModuleDestroy();
    service.handleFrame(frame(3), receivedAt, targets);
    expect(pubsub.publish).toHaveBeenCalledTimes(2);
  });
});
