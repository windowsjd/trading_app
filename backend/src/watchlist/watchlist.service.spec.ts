jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));
jest.mock('../assets/assets.service', () => ({
  AssetsService: class AssetsService {},
}));
// The generated client's ESM specifiers are a Jest boundary (see other specs).
jest.mock('../generated/prisma/client', () => ({
  AssetType: {
    domestic_stock: 'domestic_stock',
    us_stock: 'us_stock',
    crypto: 'crypto',
  },
  Prisma: { TransactionIsolationLevel: { ReadCommitted: 'ReadCommitted' } },
}));

import { HttpException } from '@nestjs/common';
import type { AssetsService } from '../assets/assets.service';
import type { PrismaService } from '../prisma/prisma.service';
import { SPOT_ASSET_WHERE } from '../providers/binance/binance-product-catalog';
import { WATCHLIST_LIMIT, WatchlistService } from './watchlist.service';

type Asset = {
  id: string;
  symbol: string;
  name: string;
  market: string;
  assetType: string;
  isActive: boolean;
};

/* eslint-disable @typescript-eslint/require-await -- the fake mirrors Prisma's async client */
/** Records every client call in order; the integration script owns real SQL. */
function createService(state: {
  assets?: Asset[];
  items?: { userId: string; assetId: string; createdAt: Date }[];
  lockedUsers?: string[];
}) {
  const calls: string[] = [];
  const assets = state.assets ?? [];
  const items = state.items ?? [];
  const pick = (row: { assetId: string; createdAt: Date }) => ({
    createdAt: row.createdAt,
    asset: assets.find((asset) => asset.id === row.assetId)!,
  });
  const tx = {
    $queryRaw: jest.fn(async () => {
      calls.push('lock');
      return (state.lockedUsers ?? ['user-1']).map((id) => ({ id }));
    }),
    watchlistItem: {
      findUnique: jest.fn(
        async ({
          where,
        }: {
          where: { userId_assetId: { userId: string; assetId: string } };
        }) => {
          calls.push('findExisting');
          const key = where.userId_assetId;
          const row = items.find(
            (item) =>
              item.userId === key.userId && item.assetId === key.assetId,
          );
          return row ? pick(row) : null;
        },
      ),
      count: jest.fn(async ({ where }: { where: { userId: string } }) => {
        calls.push('count');
        return items.filter((item) => item.userId === where.userId).length;
      }),
      create: jest.fn(
        async ({ data }: { data: { userId: string; assetId: string } }) => {
          calls.push('create');
          const row = { ...data, createdAt: new Date('2026-10-13T00:00:00Z') };
          items.push(row);
          return pick(row);
        },
      ),
    },
    asset: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        calls.push('findAsset');
        return assets.find((asset) => asset.id === where.id) ?? null;
      }),
    },
  };
  const prisma = {
    $transaction: jest.fn(
      async (
        run: (client: typeof tx) => Promise<unknown>,
        options: unknown,
      ) => {
        calls.push(`tx:${JSON.stringify(options)}`);
        return run(tx);
      },
    ),
    watchlistItem: {
      findMany: jest.fn(async () => []),
      deleteMany: jest.fn(
        async ({ where }: { where: { userId: string; assetId: string } }) => {
          const before = items.length;
          const kept = items.filter(
            (item) =>
              item.userId !== where.userId || item.assetId !== where.assetId,
          );
          items.splice(0, items.length, ...kept);
          return { count: before - items.length };
        },
      ),
    },
  };
  const assetsService = {
    getListItemsByIds: jest.fn(async (ids: readonly string[]) => ({
      assets: ids.map((id) => ({ id })),
      priceErrors: [],
    })),
  };
  const service = new WatchlistService(
    prisma as unknown as PrismaService,
    assetsService as unknown as AssetsService,
  );
  return { service, prisma, tx, assetsService, calls, items };
}

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    const body = error.getResponse() as {
      error: { code: string; message: string };
    };
    return { status: error.getStatus(), ...body.error };
  }
  throw new Error('expected an API error');
}

const spot = (id: string, patch: Partial<Asset> = {}): Asset => ({
  id,
  symbol: `SYM${id}`,
  name: `Asset ${id}`,
  market: 'KRX',
  assetType: 'domestic_stock',
  isActive: true,
  ...patch,
});

describe('WatchlistService', () => {
  it('rejects a missing user and malformed input before any database call', async () => {
    const { service, prisma } = createService({});
    expect(await errorOf(service.add(undefined, 'asset-1'))).toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
    });
    for (const bad of [undefined, '', 'a b', 'a/b', 'x'.repeat(65)]) {
      expect(await errorOf(service.add('user-1', bad))).toMatchObject({
        status: 400,
        code: 'INVALID_ASSET_ID',
        message: 'Invalid asset id.',
      });
      expect(await errorOf(service.remove('user-1', bad))).toMatchObject({
        status: 400,
        code: 'INVALID_ASSET_ID',
      });
    }
    expect(
      await errorOf(service.listAssets('user-1', { assetType: 'futures' })),
    ).toMatchObject({
      status: 400,
      code: 'INVALID_ASSET_TYPE',
      message: 'Invalid assetType.',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.watchlistItem.findMany).not.toHaveBeenCalled();
  });

  it('locks the user under READ COMMITTED before counting, then inserts', async () => {
    const { service, calls } = createService({ assets: [spot('a1')] });
    const result = await service.add('user-1', 'a1');
    expect(result.data.created).toBe(true);
    expect(result.data.item).toEqual({
      assetId: 'a1',
      symbol: 'SYMa1',
      name: 'Asset a1',
      market: 'KRX',
      assetType: 'domestic_stock',
      isActive: true,
      addedAt: '2026-10-13T00:00:00.000Z',
    });
    expect(calls).toEqual([
      'tx:{"isolationLevel":"ReadCommitted"}',
      'lock',
      'findExisting',
      'findAsset',
      'count',
      'create',
    ]);
  });

  it('answers an existing item as success without re-validating or re-timing it', async () => {
    const addedAt = new Date('2026-01-01T00:00:00Z');
    const { service, calls, tx } = createService({
      assets: [spot('a1', { isActive: false })],
      items: [{ userId: 'user-1', assetId: 'a1', createdAt: addedAt }],
    });
    const result = await service.add('user-1', 'a1');
    expect(result.data).toMatchObject({
      created: false,
      item: { assetId: 'a1', isActive: false, addedAt: addedAt.toISOString() },
    });
    expect(calls.slice(1)).toEqual(['lock', 'findExisting']);
    expect(tx.watchlistItem.create).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown asset', [], 404, 'ASSET_NOT_FOUND', 'Asset not found.'],
    [
      'a Futures-only Binance asset',
      [
        spot('a1', {
          market: 'BINANCE',
          assetType: 'crypto',
          symbol: 'HYPEUSDT',
        }),
      ],
      400,
      'ASSET_NOT_TRADABLE',
      'Asset is not a Spot product.',
    ],
    [
      'an inactive asset',
      [spot('a1', { isActive: false })],
      409,
      'ASSET_NOT_TRADABLE',
      'Asset is not active.',
    ],
  ])(
    'rejects a new add of %s without writing',
    async (_label, assets, status, code, message) => {
      const { service, tx } = createService({ assets });
      expect(await errorOf(service.add('user-1', 'a1'))).toEqual({
        status,
        code,
        message,
      });
      expect(tx.watchlistItem.create).not.toHaveBeenCalled();
    },
  );

  it('accepts the 50th item and rejects the 51st, counting inactive items', async () => {
    const assets = Array.from({ length: WATCHLIST_LIMIT + 1 }, (_, index) =>
      spot(`a${index}`, { isActive: index !== 0 }),
    );
    const items = assets.slice(0, WATCHLIST_LIMIT - 1).map((asset) => ({
      userId: 'user-1',
      assetId: asset.id,
      createdAt: new Date(),
    }));
    const { service, tx } = createService({ assets, items });
    const last = await service.add('user-1', `a${WATCHLIST_LIMIT - 1}`);
    expect(last.data.created).toBe(true);
    expect(await errorOf(service.add('user-1', `a${WATCHLIST_LIMIT}`))).toEqual(
      {
        status: 409,
        code: 'WATCHLIST_LIMIT_EXCEEDED',
        message: 'The watchlist is full.',
      },
    );
    expect(tx.watchlistItem.create).toHaveBeenCalledTimes(1);
    // At the cap an existing item is still the target state.
    expect((await service.add('user-1', 'a0')).data.created).toBe(false);
  });

  it('treats a user row that vanished before the lock as unauthenticated', async () => {
    const { service, tx } = createService({
      assets: [spot('a1')],
      lockedUsers: [],
    });
    expect(await errorOf(service.add('user-1', 'a1'))).toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
    });
    expect(tx.watchlistItem.create).not.toHaveBeenCalled();
  });

  it('removes only the caller item and reports an absent item as success', async () => {
    const { service, prisma, items } = createService({
      items: [
        { userId: 'user-1', assetId: 'a1', createdAt: new Date() },
        { userId: 'user-2', assetId: 'a1', createdAt: new Date() },
      ],
    });
    expect((await service.remove('user-1', 'a1')).data).toEqual({
      assetId: 'a1',
      removed: true,
    });
    expect((await service.remove('user-1', 'a1')).data).toEqual({
      assetId: 'a1',
      removed: false,
    });
    expect(prisma.watchlistItem.deleteMany).toHaveBeenLastCalledWith({
      where: { userId: 'user-1', assetId: 'a1' },
    });
    expect(items.map((item) => item.userId)).toEqual(['user-2']);
  });

  it('lists the caller items newest first with the asset id as tie-break', async () => {
    const { service, prisma } = createService({});
    const result = await service.list('user-1');
    expect(result.data).toEqual({ items: [], limit: WATCHLIST_LIMIT });
    expect(prisma.watchlistItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1' },
        orderBy: [{ createdAt: 'desc' }, { assetId: 'desc' }],
      }),
    );
  });

  it('prices only watched Spot assets of the requested market, in watchlist order', async () => {
    const { service, prisma, assetsService } = createService({});
    prisma.watchlistItem.findMany.mockResolvedValueOnce([
      { assetId: 'newer' },
      { assetId: 'older' },
    ] as never);
    const result = await service.listAssets('user-1', { assetType: 'crypto' });
    expect(prisma.watchlistItem.findMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        asset: { ...SPOT_ASSET_WHERE, assetType: 'crypto' },
      },
      orderBy: [{ createdAt: 'desc' }, { assetId: 'desc' }],
      select: { assetId: true },
    });
    expect(assetsService.getListItemsByIds).toHaveBeenCalledWith([
      'newer',
      'older',
    ]);
    expect(result.data.assets.map((asset) => asset.id)).toEqual([
      'newer',
      'older',
    ]);
  });
});
