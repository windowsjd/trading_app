jest.mock('../generated/prisma/client', () => ({
  Prisma: {
    Decimal: jest.requireActual('@prisma/client/runtime/client').Decimal,
    DbNull: 'DbNull',
  },
}));
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
import {
  FUTURES_COVERAGE_MAX_AGE_MS,
  verifiedFuturesInstrument,
} from './futures-instrument-coverage';
import { FuturesMarkIngestion } from './futures-mark-ingestion.service';
import { PrismaService } from '../prisma/prisma.service';

const now = new Date('2026-10-10T00:00:00Z');
const contract = {
  symbol: 'BTCUSDT',
  pair: 'BTCUSDT',
  baseAsset: 'BTC',
  contractType: 'PERPETUAL',
  status: 'TRADING',
  quoteAsset: 'USDT',
  marginAsset: 'USDT',
  underlyingType: 'COIN',
};
const instrument = (markVerifiedAt: Date | null) =>
  ({
    id: 'i',
    isActive: true,
    productType: 'synthetic_perpetual',
    settlementCurrency: 'USD',
    markContractJson: contract,
    markVerifiedAt,
    underlyingAsset: {
      symbol: 'BTCUSDT',
      isActive: true,
      assetType: 'crypto',
      market: 'BINANCE',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
  }) as never;

describe('Futures contract verification lifetime', () => {
  it('expires exactly after 24 hours and never trusts a future or missing check', () => {
    const at = (ms: number) => new Date(+now + ms);
    expect(
      verifiedFuturesInstrument(
        instrument(at(-FUTURES_COVERAGE_MAX_AGE_MS)),
        now,
      ),
    ).toBe(true);
    expect(
      verifiedFuturesInstrument(
        instrument(at(-FUTURES_COVERAGE_MAX_AGE_MS - 1)),
        now,
      ),
    ).toBe(false);
    expect(verifiedFuturesInstrument(instrument(at(1)), now)).toBe(false);
    expect(verifiedFuturesInstrument(instrument(null), now)).toBe(false);
  });
});

describe('coverage refresh', () => {
  const oldFetch = global.fetch;
  const update = jest.fn();
  let service: FuturesMarkIngestion;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
    update.mockReset();
    service = new FuturesMarkIngestion(
      {
        futuresInstrument: {
          findMany: jest.fn().mockResolvedValue([
            { id: 'btc', underlyingAsset: { symbol: 'BTCUSDT' } },
            { id: 'gone', underlyingAsset: { symbol: 'GONEUSDT' } },
          ]),
          update,
        },
      } as unknown as PrismaService,
      { eval: jest.fn().mockResolvedValue([1, 0, 0]) } as never,
    );
  });
  afterEach(async () => {
    await service.onModuleDestroy();
    global.fetch = oldFetch;
    jest.useRealTimers();
  });
  it('renews listed contracts and removes a delisted mapping', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ symbols: [contract] })),
    });
    await service.refreshCoverage();
    const byId = new Map(
      update.mock.calls.map(
        ([args]: [{ where: { id: string }; data: unknown }]) => [
          args.where.id,
          args.data,
        ],
      ),
    );
    expect(byId.get('btc')).toEqual({
      markContractJson: contract,
      markVerifiedAt: now,
    });
    expect(byId.get('gone')).toEqual({
      markContractJson: 'DbNull',
      markVerifiedAt: null,
    });
  });
  it('a provider failure keeps the previous verification until it expires', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('offline'));
    await expect(service.refreshCoverage()).rejects.toBeDefined();
    expect(update).not.toHaveBeenCalled();
  });
});
