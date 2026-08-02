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
import { repairMissingTradingAccountLinks } from './repair-trading-account-links';

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
  it('selects only participants with a null link', async () => {
    const prisma = createPrisma();

    const summary = await repairMissingTradingAccountLinks(prisma as never, {
      apply: false,
    });

    expect(prisma.seasonParticipant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tradingAccountId: null },
      }),
    );
    expect(summary).toEqual({
      mode: 'dry-run',
      nullLinkCount: 0,
      outcomes: [],
      failures: [],
      remainingNullLinkCount: null,
    });
  });

  it('dry-run plans repairs without any write', async () => {
    const prisma = createPrisma();
    prisma.seasonParticipant.findMany.mockResolvedValueOnce([
      nullParticipant('sp-a', 'user-a'),
      nullParticipant('sp-b', 'user-b'),
    ]);

    const summary = await repairMissingTradingAccountLinks(prisma as never, {
      apply: false,
    });

    expect(summary.mode).toBe('dry-run');
    expect(summary.nullLinkCount).toBe(2);
    expect(summary.outcomes).toEqual([
      expect.objectContaining({
        seasonParticipantId: 'sp-a',
        tradingAccountId: deriveSeasonTradingAccountId('sp-a'),
        action: 'would-create-and-link',
      }),
      expect.objectContaining({
        seasonParticipantId: 'sp-b',
        action: 'would-create-and-link',
      }),
    ]);
    expect(summary.remainingNullLinkCount).toBeNull();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.seasonParticipant.updateMany).not.toHaveBeenCalled();
  });

  it('apply repairs each participant in its own transaction and re-verifies null count', async () => {
    const prisma = createPrisma();
    prisma.seasonParticipant.findMany.mockResolvedValueOnce([
      nullParticipant('sp-a', 'user-a'),
    ]);

    const summary = await repairMissingTradingAccountLinks(prisma as never, {
      apply: true,
    });

    expect(summary.mode).toBe('apply');
    expect(summary.outcomes).toEqual([
      expect.objectContaining({
        seasonParticipantId: 'sp-a',
        tradingAccountId: deriveSeasonTradingAccountId('sp-a'),
        action: 'created-and-linked',
      }),
    ]);
    expect(summary.failures).toEqual([]);
    expect(summary.remainingNullLinkCount).toBe(0);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.seasonParticipant.count).toHaveBeenCalledWith({
      where: { tradingAccountId: null },
    });
  });

  it('reports per-participant failures without stopping the remaining repairs', async () => {
    const prisma = createPrisma();
    prisma.seasonParticipant.findMany.mockResolvedValueOnce([
      nullParticipant('sp-bad', 'user-bad'),
      nullParticipant('sp-good', 'user-good'),
    ]);
    // sp-bad's deterministic account exists but belongs to someone else.
    prisma.tradingAccount.findUnique.mockResolvedValueOnce({
      id: deriveSeasonTradingAccountId('sp-bad'),
      userId: 'user-other',
      mode: 'season',
      status: 'active',
      initialCapitalKrw: new Prisma.Decimal(CAPITAL),
      openedAt: new Date('2026-06-01T00:00:00.000Z'),
      seasonParticipant: null,
    });
    prisma.seasonParticipant.count.mockResolvedValueOnce(1);

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
