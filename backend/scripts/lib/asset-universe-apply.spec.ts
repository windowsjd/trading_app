jest.mock('../../src/generated/prisma/client', () => ({
  AssetType: { domestic_stock: 'domestic_stock', us_stock: 'us_stock' },
  CurrencyCode: { KRW: 'KRW', USD: 'USD' },
}));

import { applyAssetUniverse } from './asset-universe-apply';
import type { AssetUniverseDesired } from './asset-universe-upsert';

const abt: AssetUniverseDesired = {
  symbol: 'ABT',
  name: 'Abbott Laboratories',
  market: 'NYS',
  assetType: 'us_stock',
  currencyCode: 'USD',
  priceCurrency: 'USD',
  settlementCurrency: 'USD',
};

function fakePrisma(
  activeRetired: { id: string; market: string; symbol: string }[],
) {
  const tx = { asset: { create: jest.fn(), update: jest.fn() } };
  const prisma = {
    asset: {
      findMany: jest.fn((args: { where: { isActive?: boolean } }) =>
        Promise.resolve(args.where.isActive === true ? activeRetired : []),
      ),
    },
    $transaction: jest.fn(async (fn: (client: typeof tx) => Promise<void>) =>
      fn(tx),
    ),
  };
  return { prisma, tx };
}

describe('applyAssetUniverse retired members', () => {
  const retired = [{ market: 'NAS', symbol: 'WBD' }];

  it('plans the deactivation in a dry run without writing', async () => {
    const { prisma } = fakePrisma([
      { id: 'wbd-id', market: 'NAS', symbol: 'WBD' },
    ]);
    const result = await applyAssetUniverse({
      prisma: prisma as never,
      desired: [abt],
      apply: false,
      retired,
    });
    expect(result.counts.create).toBe(1);
    expect(result.deactivations).toEqual([
      { existingId: 'wbd-id', market: 'NAS', symbol: 'WBD' },
    ]);
    expect(result.deactivated).toBe(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('only sets isActive=false on the retired row, in the same transaction', async () => {
    const { prisma, tx } = fakePrisma([
      { id: 'wbd-id', market: 'NAS', symbol: 'WBD' },
    ]);
    const result = await applyAssetUniverse({
      prisma: prisma as never,
      desired: [abt],
      apply: true,
      retired,
    });
    expect(result.deactivated).toBe(1);
    expect(tx.asset.create).toHaveBeenCalledTimes(1);
    expect(tx.asset.update).toHaveBeenCalledWith({
      where: { id: 'wbd-id' },
      data: { isActive: false },
    });
  });

  it('changes nothing for an already inactive retired row', async () => {
    const { prisma, tx } = fakePrisma([]);
    const result = await applyAssetUniverse({
      prisma: prisma as never,
      desired: [abt],
      apply: true,
      retired,
    });
    expect(result.deactivations).toEqual([]);
    expect(tx.asset.update).not.toHaveBeenCalled();
  });

  it('refuses a retired member that is still in the desired universe', async () => {
    const { prisma } = fakePrisma([]);
    await expect(
      applyAssetUniverse({
        prisma: prisma as never,
        desired: [abt],
        apply: false,
        retired: [{ market: 'NYS', symbol: 'ABT' }],
      }),
    ).rejects.toThrow('Retired asset is still in the fixed universe: NYS:ABT');
  });
});
