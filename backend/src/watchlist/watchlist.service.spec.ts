jest.mock('../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { TransactionIsolationLevel: { ReadCommitted: 'ReadCommitted' } },
}));

import { HttpException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WatchlistService } from './watchlist.service';

describe('WatchlistService transaction policy', () => {
  const fixture = () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'user' }]),
      asset: {
        findUnique: jest.fn().mockResolvedValue({
          symbol: 'BTCUSDT',
          market: 'BINANCE',
          assetType: 'crypto',
          isActive: true,
        }),
      },
      watchlistEntry: {
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(49),
        create: jest.fn().mockResolvedValue({
          assetId: 'asset',
          createdAt: new Date('2026-10-13T00:00:00Z'),
          asset: {
            name: 'Bitcoin',
            symbol: 'BTCUSDT',
            market: 'BINANCE',
            assetType: 'crypto',
            isActive: true,
          },
        }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const prisma = {
      $transaction: jest.fn(
        async (run: (transaction: typeof tx) => Promise<unknown>) => run(tx),
      ),
    };
    return {
      tx,
      prisma,
      service: new WatchlistService(prisma as unknown as PrismaService),
    };
  };
  const code = async (promise: Promise<unknown>) => {
    try {
      await promise;
      throw new Error('Expected rejection');
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      return (error.getResponse() as { error: { code: string } }).error.code;
    }
  };

  it('rejects missing owner and invalid IDs before opening a transaction', async () => {
    const { service, prisma } = fixture();
    expect(await code(service.add(undefined, 'asset'))).toBe('UNAUTHORIZED');
    for (const invalid of ['', ' ', 'a/b', 'a'.repeat(129), {}, null]) {
      expect(await code(service.add('user', invalid))).toBe('INVALID_ASSET_ID');
      expect(await code(service.remove('user', invalid))).toBe(
        'INVALID_ASSET_ID',
      );
    }
    expect(prisma.$transaction.mock.calls.length).toBe(0);
  });

  it('locks the user before counting and inserts exactly at 49', async () => {
    const { service, tx, prisma } = fixture();
    const result = await service.add('user', 'asset');
    expect(result.data.item.assetId).toBe('asset');
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.watchlistEntry.count.mock.invocationCallOrder[0],
    );
    expect(tx.watchlistEntry.count.mock.invocationCallOrder[0]).toBeLessThan(
      tx.watchlistEntry.create.mock.invocationCallOrder[0],
    );
    expect(prisma.$transaction.mock.calls.length).toBe(1);
    expect(
      (
        (tx.watchlistEntry.create.mock.calls as unknown[][])[0][0] as {
          data: { userId: string };
        }
      ).data.userId,
    ).toBe('user');
  });

  it('returns an inactive replay unchanged before asset or capacity validation', async () => {
    const { service, tx } = fixture();
    const timestamp = new Date('2026-10-01T00:00:00Z');
    tx.watchlistEntry.findUnique.mockResolvedValue({
      assetId: 'asset',
      createdAt: timestamp,
      asset: { isActive: false },
    });
    tx.watchlistEntry.count.mockResolvedValue(50);
    const result = await service.add('user', 'asset');
    expect(result.data.item.createdAt).toBe(timestamp.toISOString());
    expect(result.data.item.isActive).toBe(false);
    expect(tx.asset.findUnique.mock.calls.length).toBe(0);
    expect(tx.watchlistEntry.count.mock.calls.length).toBe(0);
    expect(tx.watchlistEntry.create.mock.calls.length).toBe(0);
  });

  it('rejects the 51st new item without writing', async () => {
    const { service, tx } = fixture();
    tx.watchlistEntry.count.mockResolvedValue(50);
    expect(await code(service.add('user', 'asset'))).toBe(
      'WATCHLIST_LIMIT_REACHED',
    );
    expect(tx.watchlistEntry.create.mock.calls.length).toBe(0);
  });

  it.each([
    [null, 'ASSET_NOT_FOUND'],
    [
      {
        symbol: 'BTCUSDT',
        market: 'BINANCE',
        assetType: 'crypto',
        isActive: false,
      },
      'ASSET_INACTIVE',
    ],
    [
      {
        symbol: 'HYPEUSDT',
        market: 'BINANCE',
        assetType: 'crypto',
        isActive: true,
      },
      'WATCHLIST_SPOT_ONLY',
    ],
    [
      {
        symbol: 'HYPE',
        market: 'BINANCE',
        assetType: 'crypto',
        isActive: true,
      },
      'WATCHLIST_SPOT_ONLY',
    ],
  ])('validates eligibility before insertion (%s)', async (asset, expected) => {
    const { service, tx } = fixture();
    tx.asset.findUnique.mockResolvedValue(asset);
    expect(await code(service.add('user', 'asset'))).toBe(expected);
    expect(tx.watchlistEntry.create.mock.calls.length).toBe(0);
  });

  it('idempotently deletes only the owner + asset without eligibility checks', async () => {
    const { service, tx } = fixture();
    expect((await service.remove('user', 'asset')).data.registered).toBe(false);
    expect((await service.remove('user', 'asset')).data.registered).toBe(false);
    expect(
      (
        (tx.watchlistEntry.deleteMany.mock.calls as unknown[][])[0][0] as {
          where: { userId: string; assetId: string };
        }
      ).where.userId,
    ).toBe('user');
    expect(
      (
        (tx.watchlistEntry.deleteMany.mock.calls as unknown[][])[0][0] as {
          where: { userId: string; assetId: string };
        }
      ).where.assetId,
    ).toBe('asset');
    expect(tx.$queryRaw.mock.calls.length).toBe(2);
    expect(tx.asset.findUnique.mock.calls.length).toBe(0);
  });
});
