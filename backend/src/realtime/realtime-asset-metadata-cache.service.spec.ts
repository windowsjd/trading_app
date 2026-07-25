jest.mock('../generated/prisma/client', () => ({
  PrismaClient: class PrismaClient {},
  AssetType: {
    domestic_stock: 'domestic_stock',
    us_stock: 'us_stock',
    crypto: 'crypto',
  },
  CurrencyCode: { KRW: 'KRW', USD: 'USD' },
}));

import { RealtimeAssetMetadataCacheService } from './realtime-asset-metadata-cache.service';

const dogeRow = {
  id: 'asset-doge',
  symbol: 'DOGEUSDT',
  name: 'Dogecoin',
  assetType: 'crypto',
  market: 'BINANCE',
  currencyCode: 'USD',
  priceCurrency: 'USD',
};

function createService(
  findFirst: jest.Mock = jest.fn().mockResolvedValue(dogeRow),
  decimals: number | null = 5,
) {
  const prisma = { asset: { findFirst } };
  const binanceSymbolMetadata = {
    getDisplayPriceDecimals: jest.fn().mockReturnValue(decimals),
  };
  const service = new RealtimeAssetMetadataCacheService(
    prisma as never,
    binanceSymbolMetadata as never,
  );
  return { service, findFirst, binanceSymbolMetadata };
}

describe('RealtimeAssetMetadataCacheService', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-25T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('queries the DB once and serves later events from memory', async () => {
    const { service, findFirst } = createService();

    const first = await service.getMetadata('asset-doge');
    const second = await service.getMetadata('asset-doge');
    const third = await service.getMetadata('asset-doge');

    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'asset-doge', isActive: true },
      }),
    );
    expect(first).toMatchObject({
      assetId: 'asset-doge',
      symbol: 'DOGEUSDT',
      name: 'Dogecoin',
      assetType: 'crypto',
      market: 'BINANCE',
      priceCurrency: 'USD',
      displayPriceDecimals: 5,
    });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it('re-reads the DB after the TTL expires', async () => {
    const { service, findFirst } = createService();

    await service.getMetadata('asset-doge');
    jest.setSystemTime(new Date('2026-07-25T00:06:00.000Z'));
    await service.getMetadata('asset-doge');

    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent misses into one query', async () => {
    const { service, findFirst } = createService();

    const [a, b] = await Promise.all([
      service.getMetadata('asset-doge'),
      service.getMetadata('asset-doge'),
    ]);

    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it('caches unknown/inactive assets negatively (no query per event)', async () => {
    const { service, findFirst } = createService(
      jest.fn().mockResolvedValue(null),
    );

    expect(await service.getMetadata('asset-gone')).toBeNull();
    expect(await service.getMetadata('asset-gone')).toBeNull();
    expect(findFirst).toHaveBeenCalledTimes(1);

    // Negative entries expire faster so a re-activated asset comes back.
    jest.setSystemTime(new Date('2026-07-25T00:00:31.000Z'));
    await service.getMetadata('asset-gone');
    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  it('serves the last known entry when the DB read fails', async () => {
    const findFirst = jest.fn().mockResolvedValueOnce(dogeRow);
    const { service } = createService(findFirst);

    await service.getMetadata('asset-doge');
    jest.setSystemTime(new Date('2026-07-25T00:06:00.000Z'));
    findFirst.mockRejectedValue(new Error('db down'));

    const stale = await service.getMetadata('asset-doge');
    expect(stale).toMatchObject({ assetId: 'asset-doge', symbol: 'DOGEUSDT' });
  });

  it('returns null (not a crash) when the very first read fails', async () => {
    const { service } = createService(
      jest.fn().mockRejectedValue(new Error('db down')),
    );

    await expect(service.getMetadata('asset-doge')).resolves.toBeNull();
  });

  it('resolves display decimals live so a precision refresh needs no flush', async () => {
    const { service, binanceSymbolMetadata } = createService();

    await service.getMetadata('asset-doge');
    binanceSymbolMetadata.getDisplayPriceDecimals.mockReturnValue(4);

    const updated = await service.getMetadata('asset-doge');
    expect(updated?.displayPriceDecimals).toBe(4);
  });

  it('invalidate() forces the next event to re-read the DB', async () => {
    const { service, findFirst } = createService();

    await service.getMetadata('asset-doge');
    service.invalidate('asset-doge');
    await service.getMetadata('asset-doge');

    expect(findFirst).toHaveBeenCalledTimes(2);
  });
});
