jest.mock('../../src/generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    ParticipantStatus: {
      registered: 'registered',
      active: 'active',
      excluded: 'excluded',
      finished: 'finished',
      rewarded: 'rewarded',
    },
    Prisma: {
      Decimal,
    },
    PrismaClient: class PrismaClient {},
    TradingAccountMode: {
      season: 'season',
      general: 'general',
    },
    TradingAccountStatus: {
      active: 'active',
      suspended: 'suspended',
      closed: 'closed',
    },
  };
});

import { Prisma } from '../../src/generated/prisma/client';
import { deriveSeasonTradingAccountId } from '../../src/seasons/season-trading-account-link';
import {
  repairMissingTradingAccountLinks,
  resolveRepairLinksExitCode,
  type RepairLinksSummary,
} from './repair-trading-account-links';

const CAPITAL = '10000000.00000000';

const nullParticipant = (id: string, userId: string) => ({
  id,
  seasonId: 'season-1',
  userId,
  joinedAt: new Date('2026-06-01T00:00:00.000Z'),
  participantStatus: 'active',
  initialCapitalKrw: new Prisma.Decimal(CAPITAL),
  tradingAccountId: null,
});

const excludedActiveRow = (
  id: string,
  userId: string,
  accountOverrides: Record<string, unknown> = {},
) => ({
  id,
  seasonId: 'season-1',
  userId,
  tradingAccountId: `ta-${id}`,
  tradingAccount: {
    id: `ta-${id}`,
    userId,
    mode: 'season',
    status: 'active',
    ...accountOverrides,
  },
});

const createPrisma = () => {
  const prisma = {
    seasonParticipant: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(0),
    },
    tradingAccount: {
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((callback: (tx: unknown) => unknown) =>
    callback(prisma),
  );

  return prisma;
};

describe('repairMissingTradingAccountLinks', () => {
  it('selects null-link participants and excluded-active mismatches', async () => {
    const prisma = createPrisma();

    const summary = await repairMissingTradingAccountLinks(prisma as never, {
      apply: false,
    });

    expect(prisma.seasonParticipant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tradingAccountId: null },
      }),
    );
    expect(prisma.seasonParticipant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          participantStatus: 'excluded',
          tradingAccount: expect.objectContaining({
            mode: 'season',
            status: 'active',
          }),
        }),
      }),
    );
    expect(summary).toEqual({
      mode: 'dry-run',
      nullLinkCount: 0,
      outcomes: [],
      excludedActiveMismatchCount: 0,
      excludedActiveOutcomes: [],
      failures: [],
      remainingNullLinkCount: null,
      remainingExcludedActiveMismatchCount: null,
    });
  });

  it('dry-run plans both repair kinds without any write', async () => {
    const prisma = createPrisma();
    prisma.seasonParticipant.findMany
      .mockResolvedValueOnce([nullParticipant('sp-a', 'user-a')])
      .mockResolvedValueOnce([excludedActiveRow('sp-x', 'user-x')]);

    const summary = await repairMissingTradingAccountLinks(prisma as never, {
      apply: false,
    });

    expect(summary.outcomes).toEqual([
      expect.objectContaining({
        seasonParticipantId: 'sp-a',
        tradingAccountId: deriveSeasonTradingAccountId('sp-a'),
        action: 'would-create-and-link',
      }),
    ]);
    expect(summary.excludedActiveMismatchCount).toBe(1);
    expect(summary.excludedActiveOutcomes).toEqual([
      expect.objectContaining({
        seasonParticipantId: 'sp-x',
        tradingAccountId: 'ta-sp-x',
        action: 'would-suspend',
      }),
    ]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.seasonParticipant.updateMany).not.toHaveBeenCalled();
    expect(prisma.tradingAccount.updateMany).not.toHaveBeenCalled();
  });

  it('apply repairs null links and re-verifies both remaining counts', async () => {
    const prisma = createPrisma();
    prisma.seasonParticipant.findMany
      .mockResolvedValueOnce([nullParticipant('sp-a', 'user-a')])
      .mockResolvedValueOnce([]);
    // Post-insert re-read validation fetches the stored deterministic row.
    prisma.tradingAccount.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: deriveSeasonTradingAccountId('sp-a'),
        userId: 'user-a',
        mode: 'season',
        status: 'active',
        initialCapitalKrw: new Prisma.Decimal(CAPITAL),
        openedAt: new Date('2026-06-01T00:00:00.000Z'),
        seasonParticipant: null,
      });

    const summary = await repairMissingTradingAccountLinks(prisma as never, {
      apply: true,
    });

    expect(summary.outcomes).toEqual([
      expect.objectContaining({
        seasonParticipantId: 'sp-a',
        action: 'created-and-linked',
      }),
    ]);
    expect(summary.failures).toEqual([]);
    expect(summary.remainingNullLinkCount).toBe(0);
    expect(summary.remainingExcludedActiveMismatchCount).toBe(0);
    expect(prisma.seasonParticipant.count).toHaveBeenCalledTimes(2);
  });

  it('apply suspends the active account of an already-excluded participant (guarded)', async () => {
    const prisma = createPrisma();
    prisma.seasonParticipant.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([excludedActiveRow('sp-x', 'user-x')]);

    const summary = await repairMissingTradingAccountLinks(prisma as never, {
      apply: true,
    });

    expect(prisma.tradingAccount.updateMany).toHaveBeenCalledWith({
      where: { id: 'ta-sp-x', status: 'active' },
      data: { status: 'suspended' },
    });
    expect(summary.excludedActiveOutcomes).toEqual([
      expect.objectContaining({
        seasonParticipantId: 'sp-x',
        action: 'suspended',
      }),
    ]);
  });

  it('reports a concurrent status change as already-consistent instead of forcing it', async () => {
    const prisma = createPrisma();
    prisma.seasonParticipant.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([excludedActiveRow('sp-x', 'user-x')]);
    prisma.tradingAccount.updateMany.mockResolvedValueOnce({ count: 0 });

    const summary = await repairMissingTradingAccountLinks(prisma as never, {
      apply: true,
    });

    expect(summary.excludedActiveOutcomes).toEqual([
      expect.objectContaining({ action: 'already-consistent' }),
    ]);
  });

  it('fails closed on a foreign-user account instead of suspending it', async () => {
    const prisma = createPrisma();
    prisma.seasonParticipant.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        excludedActiveRow('sp-x', 'user-x', { userId: 'user-other' }),
      ]);

    const summary = await repairMissingTradingAccountLinks(prisma as never, {
      apply: true,
    });

    expect(prisma.tradingAccount.updateMany).not.toHaveBeenCalled();
    expect(summary.failures).toEqual([
      expect.objectContaining({
        seasonParticipantId: 'sp-x',
        code: 'TRADING_ACCOUNT_LINK_INTEGRITY',
      }),
    ]);
  });

  it('reports per-participant failures without stopping the remaining repairs', async () => {
    const prisma = createPrisma();
    prisma.seasonParticipant.findMany
      .mockResolvedValueOnce([
        nullParticipant('sp-bad', 'user-bad'),
        nullParticipant('sp-good', 'user-good'),
      ])
      .mockResolvedValueOnce([]);
    // sp-bad's deterministic account exists but belongs to someone else.
    prisma.tradingAccount.findUnique
      .mockResolvedValueOnce({
        id: deriveSeasonTradingAccountId('sp-bad'),
        userId: 'user-other',
        mode: 'season',
        status: 'active',
        initialCapitalKrw: new Prisma.Decimal(CAPITAL),
        openedAt: new Date('2026-06-01T00:00:00.000Z'),
        seasonParticipant: null,
      })
      // sp-good: no pre-existing row, then post-insert re-read returns the
      // freshly inserted deterministic row.
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: deriveSeasonTradingAccountId('sp-good'),
        userId: 'user-good',
        mode: 'season',
        status: 'active',
        initialCapitalKrw: new Prisma.Decimal(CAPITAL),
        openedAt: new Date('2026-06-01T00:00:00.000Z'),
        seasonParticipant: null,
      });
    prisma.seasonParticipant.count
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);

    const summary = await repairMissingTradingAccountLinks(prisma as never, {
      apply: true,
    });

    expect(summary.failures).toEqual([
      expect.objectContaining({
        seasonParticipantId: 'sp-bad',
        code: 'TRADING_ACCOUNT_LINK_INTEGRITY',
      }),
    ]);
    expect(summary.outcomes).toEqual([
      expect.objectContaining({
        seasonParticipantId: 'sp-good',
        action: 'created-and-linked',
      }),
    ]);
    expect(summary.remainingNullLinkCount).toBe(1);
  });
});

describe('resolveRepairLinksExitCode', () => {
  const base: RepairLinksSummary = {
    mode: 'apply',
    nullLinkCount: 0,
    outcomes: [],
    excludedActiveMismatchCount: 0,
    excludedActiveOutcomes: [],
    failures: [],
    remainingNullLinkCount: 0,
    remainingExcludedActiveMismatchCount: 0,
  };

  it('exits 0 when apply converged with zero remaining inconsistencies', () => {
    expect(resolveRepairLinksExitCode(base)).toEqual({
      exitCode: 0,
      problems: [],
    });
  });

  it('exits 1 when any participant repair failed', () => {
    const result = resolveRepairLinksExitCode({
      ...base,
      failures: [
        {
          seasonParticipantId: 'sp-1',
          seasonId: 's-1',
          userId: 'u-1',
          code: 'REPAIR_FAILED',
          message: 'boom',
        },
      ],
    });
    expect(result.exitCode).toBe(1);
  });

  it('exits 1 when null links remain after apply', () => {
    expect(
      resolveRepairLinksExitCode({ ...base, remainingNullLinkCount: 2 })
        .exitCode,
    ).toBe(1);
  });

  it('exits 1 when excluded-active mismatches remain after apply', () => {
    expect(
      resolveRepairLinksExitCode({
        ...base,
        remainingExcludedActiveMismatchCount: 1,
      }).exitCode,
    ).toBe(1);
  });

  it('exits 1 when the post-apply verification could not be read', () => {
    expect(
      resolveRepairLinksExitCode({ ...base, remainingNullLinkCount: null })
        .exitCode,
    ).toBe(1);
  });

  it('dry-run exits 0 even when pending repairs were found', () => {
    expect(
      resolveRepairLinksExitCode({
        ...base,
        mode: 'dry-run',
        nullLinkCount: 3,
        remainingNullLinkCount: null,
        remainingExcludedActiveMismatchCount: null,
      }).exitCode,
    ).toBe(0);
  });
});
