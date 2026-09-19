jest.mock('../../src/generated/prisma/client', () => ({
  PrismaClient: class {},
  AssetType: { crypto: 'crypto' },
  CurrencyCode: { USD: 'USD' },
}));
import {
  seedBinanceFixedAssetUniverse,
  buildBinanceDesiredUniverse,
} from '../seed-binance-fixed-asset-universe';
import { BINANCE_FIXED_ASSET_UNIVERSE } from '../../src/providers/binance/binance-fixed-asset-universe';
import { ProviderHttpClient } from '../../src/providers/provider-http.client';

function setup() {
  const desired = buildBinanceDesiredUniverse();
  const rows = desired.slice(0, 10).map((entry) => ({
    ...entry,
    id: `existing-${entry.symbol}`,
    isActive: true,
  }));
  const original = structuredClone(rows);
  const tx = {
    asset: {
      create: jest.fn(({ data }: { data: (typeof desired)[number] }) => {
        const row = { ...data, id: `new-${data.symbol}`, isActive: true };
        rows.push(row);
        return Promise.resolve(row);
      }),
      update: jest.fn(),
    },
  };
  const prisma = {
    asset: {
      findMany: jest.fn().mockImplementation(() => Promise.resolve([...rows])),
    },
    $transaction: jest.fn((work: (client: typeof tx) => Promise<void>) =>
      work(tx),
    ),
  };
  const symbols = BINANCE_FIXED_ASSET_UNIVERSE.map((entry) => ({
    symbol: entry.symbol,
    baseAsset: entry.baseAsset,
    quoteAsset: 'USDT',
    status: 'TRADING',
    isSpotTradingAllowed: true,
  }));
  jest.spyOn(ProviderHttpClient.prototype, 'getJson').mockResolvedValue({
    json: { symbols },
    receivedAt: new Date(),
    status: 200,
  });
  return { prisma, rows, original, tx, symbols };
}

afterEach(() => jest.restoreAllMocks());

describe('fixed Binance seed with the YTD expansion', () => {
  it('plans exactly fifteen creates without writing in dry-run', async () => {
    const { prisma } = setup();
    const result = await seedBinanceFixedAssetUniverse({
      prisma: prisma as never,
      apply: false,
      skipProviderValidation: false,
    });
    expect(result.validation.ok).toBe(true);
    expect(result.universe?.counts).toEqual({
      total: 25,
      create: 15,
      update: 0,
      unchanged: 10,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('aborts before DB access if even one new symbol fails validation', async () => {
    const { prisma, symbols } = setup();
    symbols[24].status = 'BREAK';
    const result = await seedBinanceFixedAssetUniverse({
      prisma: prisma as never,
      apply: true,
      skipProviderValidation: false,
    });
    expect(result.ok).toBe(false);
    expect(prisma.asset.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('applies all additions in one transaction, preserves original IDs and is idempotent', async () => {
    const { prisma, rows, original, tx } = setup();
    const input = {
      prisma: prisma as never,
      apply: true,
      skipProviderValidation: false,
    };
    const result = await seedBinanceFixedAssetUniverse(input);
    expect(result.ok).toBe(true);
    expect(result.verification).toEqual({
      total: 25,
      verified: 25,
      issues: [],
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.asset.create).toHaveBeenCalledTimes(15);
    expect(tx.asset.update).not.toHaveBeenCalled();
    expect(rows.slice(0, 10)).toEqual(original);
    const repeated = await seedBinanceFixedAssetUniverse(input);
    expect(repeated.universe?.counts).toEqual({
      total: 25,
      create: 0,
      update: 0,
      unchanged: 25,
    });
    expect(tx.asset.create).toHaveBeenCalledTimes(15);
  });
});
