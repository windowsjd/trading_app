jest.mock('../../src/generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');

  return {
    CurrencyCode: {
      KRW: 'KRW',
      USD: 'USD',
    },
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
    SeasonStatus: {
      upcoming: 'upcoming',
      active: 'active',
      ended: 'ended',
      settled: 'settled',
    },
    TradingAccountMode: {
      season: 'season',
      general: 'general',
    },
    TradingAccountStatus: {
      active: 'active',
      suspended: 'suspended',
      closed: 'closed',
    },
    UserStatus: {
      active: 'active',
      suspended: 'suspended',
      deleted: 'deleted',
    },
    WalletTransactionDirection: {
      credit: 'credit',
      debit: 'debit',
    },
    WalletTransactionReferenceType: {
      season_join: 'season_join',
    },
    WalletTransactionType: {
      initial_grant: 'initial_grant',
    },
  };
});

import { Prisma } from '../../src/generated/prisma/client';
import { deriveSeasonTradingAccountId } from '../../src/seasons/season-trading-account-link';
import {
  DEV_SEASON_PARTICIPANT_ID,
  DEV_USER_ID,
  ensureDevBaselineParticipant,
} from './dev-baseline';

const CAPITAL = '10000000.00000000';

const createPrisma = () => {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({ id: DEV_USER_ID }),
      create: jest.fn(),
    },
    seasonParticipant: {
      findUnique: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    tradingAccount: {
      create: jest.fn(),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
    cashWallet: {
      create: jest.fn(),
    },
    walletTransaction: {
      create: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((callback: (tx: unknown) => unknown) =>
    callback(prisma),
  );

  return prisma;
};

const devParticipant = (tradingAccountId: string | null) => ({
  id: DEV_SEASON_PARTICIPANT_ID,
  userId: DEV_USER_ID,
  joinedAt: new Date('2026-03-30T00:00:00.000Z'),
  participantStatus: 'active',
  initialCapitalKrw: new Prisma.Decimal(CAPITAL),
  tradingAccountId,
});

describe('ensureDevBaselineParticipant trading-account link repair', () => {
  it('leaves an already-linked participant completely untouched', async () => {
    const prisma = createPrisma();
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(
      devParticipant('ta_dev_001'),
    );

    const result = await ensureDevBaselineParticipant({
      prisma: prisma as never,
      apply: true,
    });

    expect(result.participantAction).toBe('exists');
    expect(result.accountLinkRepaired).toBe(false);
    expect(result.walletsCreated).toBe(0);
    expect(result.grantCreated).toBe(false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.tradingAccount.create).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.cashWallet.create).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
  });

  it('dry-run reports a pending link repair without writing anything', async () => {
    const prisma = createPrisma();
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(
      devParticipant(null),
    );

    const result = await ensureDevBaselineParticipant({
      prisma: prisma as never,
      apply: false,
    });

    expect(result.participantAction).toBe('exists');
    expect(result.accountLinkRepaired).toBe(false);
    expect(
      result.notes.some((note) =>
        note.includes('apply would repair the link only'),
      ),
    ).toBe(true);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.seasonParticipant.updateMany).not.toHaveBeenCalled();
  });

  it('apply repairs only the trading account link, never wallets or the grant', async () => {
    const prisma = createPrisma();
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(
      devParticipant(null),
    );
    prisma.tradingAccount.findUnique
      .mockResolvedValueOnce(null)
      // Post-insert re-read validation of the stored deterministic row.
      .mockResolvedValueOnce({
        id: deriveSeasonTradingAccountId(DEV_SEASON_PARTICIPANT_ID),
        userId: DEV_USER_ID,
        mode: 'season',
        status: 'active',
        initialCapitalKrw: new Prisma.Decimal(CAPITAL),
        openedAt: new Date('2026-03-30T00:00:00.000Z'),
        seasonParticipant: null,
      });

    const result = await ensureDevBaselineParticipant({
      prisma: prisma as never,
      apply: true,
    });

    const deterministicId = deriveSeasonTradingAccountId(
      DEV_SEASON_PARTICIPANT_ID,
    );
    expect(result.participantAction).toBe('exists');
    expect(result.accountLinkRepaired).toBe(true);
    expect(result.walletsCreated).toBe(0);
    expect(result.grantCreated).toBe(false);
    expect(result.notes.some((note) => note.includes(deterministicId))).toBe(
      true,
    );
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    // The jest mock's `.mock` surface is untyped by construction; asserting on
    // the recorded arguments is the point of this test.
    /* eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
    expect(prisma.$executeRaw.mock.calls[0].slice(1)).toEqual([
      deterministicId,
      DEV_USER_ID,
      'season',
      'active',
      CAPITAL,
      new Date('2026-03-30T00:00:00.000Z'),
    ]);
    expect(prisma.seasonParticipant.updateMany).toHaveBeenCalledWith({
      where: { id: DEV_SEASON_PARTICIPANT_ID, tradingAccountId: null },
      data: { tradingAccountId: deterministicId },
    });
    // Financial rows are never touched by the repair.
    expect(prisma.cashWallet.create).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(prisma.seasonParticipant.create).not.toHaveBeenCalled();
    expect(prisma.tradingAccount.create).not.toHaveBeenCalled();
  });

  it('replay after a successful repair creates nothing new', async () => {
    const prisma = createPrisma();
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(
      devParticipant(deriveSeasonTradingAccountId(DEV_SEASON_PARTICIPANT_ID)),
    );

    const result = await ensureDevBaselineParticipant({
      prisma: prisma as never,
      apply: true,
    });

    expect(result.accountLinkRepaired).toBe(false);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.seasonParticipant.updateMany).not.toHaveBeenCalled();
  });
});
