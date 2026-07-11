jest.mock('../generated/prisma/client', () => ({
  PrismaClient: class PrismaClient {},
  OpsJobName: {
    provider_fx_ingest: 'provider_fx_ingest',
    provider_binance_ingest: 'provider_binance_ingest',
    provider_kis_ingest: 'provider_kis_ingest',
    daily_portfolio_snapshot: 'daily_portfolio_snapshot',
    season_ranking_generation: 'season_ranking_generation',
    season_settlement: 'season_settlement',
    reward_marker: 'reward_marker',
    market_candle_retention: 'market_candle_retention',
  },
}));

import { OpsJobName } from '../generated/prisma/client';
import { OpsJobLockService } from './ops-job-lock.service';

describe('OpsJobLockService', () => {
  const now = new Date('2026-06-08T00:00:00.000Z');

  const createPrisma = () => ({
    opsJobLock: {
      findUnique: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(),
  });

  const createService = () => {
    const prisma = createPrisma();
    prisma.$transaction.mockImplementation((callback) => callback(prisma));

    return {
      prisma,
      service: new OpsJobLockService(prisma as never),
    };
  };

  it('acquires a lock when no active lock exists', async () => {
    const { prisma, service } = createService();
    prisma.opsJobLock.findUnique.mockResolvedValueOnce(null);
    prisma.opsJobLock.create.mockResolvedValueOnce({ id: 'lock-1' });

    const result = await service.acquireLock({
      jobName: OpsJobName.daily_portfolio_snapshot,
      lockKey: 'daily_portfolio_snapshot:season-1:2026-06-08',
      ttlSeconds: 600,
      now,
      ownerId: 'owner-1',
    });

    expect(result).toEqual({
      acquired: true,
      lockKey: 'daily_portfolio_snapshot:season-1:2026-06-08',
      ownerId: 'owner-1',
      expiresAt: new Date('2026-06-08T00:10:00.000Z'),
    });
    expect(prisma.opsJobLock.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        lockKey: 'daily_portfolio_snapshot:season-1:2026-06-08',
        jobName: OpsJobName.daily_portfolio_snapshot,
        ownerId: 'owner-1',
        acquiredAt: now,
        expiresAt: new Date('2026-06-08T00:10:00.000Z'),
        releasedAt: null,
      }),
    });
  });

  it('rejects an unexpired active lock', async () => {
    const { prisma, service } = createService();
    prisma.opsJobLock.findUnique.mockResolvedValueOnce({
      id: 'lock-1',
      ownerId: 'owner-existing',
      expiresAt: new Date('2026-06-08T00:10:00.000Z'),
      releasedAt: null,
    });

    const result = await service.acquireLock({
      jobName: OpsJobName.daily_portfolio_snapshot,
      lockKey: 'daily_portfolio_snapshot:season-1:2026-06-08',
      ttlSeconds: 600,
      now,
      ownerId: 'owner-2',
    });

    expect(result).toEqual({
      acquired: false,
      lockKey: 'daily_portfolio_snapshot:season-1:2026-06-08',
      ownerId: null,
      activeOwnerId: 'owner-existing',
      expiresAt: new Date('2026-06-08T00:10:00.000Z'),
    });
    expect(prisma.opsJobLock.updateMany).not.toHaveBeenCalled();
    expect(prisma.opsJobLock.create).not.toHaveBeenCalled();
  });

  it('takes over an expired lock', async () => {
    const { prisma, service } = createService();
    prisma.opsJobLock.findUnique.mockResolvedValueOnce({
      id: 'lock-1',
      ownerId: 'owner-expired',
      expiresAt: new Date('2026-06-07T23:59:59.000Z'),
      releasedAt: null,
    });
    prisma.opsJobLock.updateMany.mockResolvedValueOnce({ count: 1 });

    const result = await service.acquireLock({
      jobName: OpsJobName.daily_portfolio_snapshot,
      lockKey: 'daily_portfolio_snapshot:season-1:2026-06-08',
      ttlSeconds: 600,
      now,
      ownerId: 'owner-2',
    });

    expect(result).toMatchObject({
      acquired: true,
      ownerId: 'owner-2',
    });
    expect(prisma.opsJobLock.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'lock-1',
        OR: [
          {
            releasedAt: {
              not: null,
            },
          },
          {
            expiresAt: {
              lte: now,
            },
          },
        ],
      },
      data: expect.objectContaining({
        ownerId: 'owner-2',
        releasedAt: null,
      }),
    });
  });

  it('releases a lock by lockKey and ownerId', async () => {
    const { prisma, service } = createService();
    prisma.opsJobLock.updateMany.mockResolvedValueOnce({ count: 1 });

    await expect(
      service.releaseLock({
        lockKey: 'provider_fx_ingest',
        ownerId: 'owner-1',
        releasedAt: now,
      }),
    ).resolves.toBe(true);
    expect(prisma.opsJobLock.updateMany).toHaveBeenCalledWith({
      where: {
        lockKey: 'provider_fx_ingest',
        ownerId: 'owner-1',
        releasedAt: null,
      },
      data: {
        releasedAt: now,
      },
    });
  });

  it('extends only the current unexpired owner lock', async () => {
    const { prisma, service } = createService();
    prisma.opsJobLock.updateMany.mockResolvedValueOnce({ count: 1 });
    await expect(
      service.extendLock({
        lockKey: 'market_candle_retention:5m',
        ownerId: 'owner-1',
        ttlSeconds: 600,
        now,
      }),
    ).resolves.toBe(true);
    expect(prisma.opsJobLock.updateMany).toHaveBeenCalledWith({
      where: {
        lockKey: 'market_candle_retention:5m',
        ownerId: 'owner-1',
        releasedAt: null,
        expiresAt: { gt: now },
      },
      data: { expiresAt: new Date('2026-06-08T00:10:00.000Z') },
    });
  });
});
