jest.mock('../generated/prisma/client', () => {
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

import {
  ParticipantStatus,
  Prisma,
  TradingAccountStatus,
} from '../generated/prisma/client';
import {
  deriveSeasonTradingAccountId,
  ensureSeasonTradingAccountLink,
  mapParticipantStatusToTradingAccountStatus,
  previewSeasonTradingAccountLink,
  SeasonTradingAccountLinkIntegrityError,
} from './season-trading-account-link';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const CAPITAL = '10000000.00000000';
const JOINED_AT = new Date('2026-05-01T01:02:03.000Z');

const participant = (
  overrides: Partial<{
    id: string;
    userId: string;
    joinedAt: Date;
    participantStatus: ParticipantStatus;
    initialCapitalKrw: InstanceType<typeof Prisma.Decimal> | string;
    tradingAccountId: string | null;
  }> = {},
) => ({
  id: 'sp-legacy-1',
  userId: 'user-1',
  joinedAt: JOINED_AT,
  participantStatus: ParticipantStatus.active,
  initialCapitalKrw: new Prisma.Decimal(CAPITAL),
  tradingAccountId: null,
  ...overrides,
});

const DETERMINISTIC_ID = deriveSeasonTradingAccountId('sp-legacy-1');

const matchingAccount = (overrides: Record<string, unknown> = {}) => ({
  id: DETERMINISTIC_ID,
  userId: 'user-1',
  mode: 'season',
  status: 'active',
  initialCapitalKrw: new Prisma.Decimal(CAPITAL),
  openedAt: JOINED_AT,
  seasonParticipant: null,
  ...overrides,
});

const createTx = () => ({
  tradingAccount: {
    findUnique: jest.fn(),
  },
  seasonParticipant: {
    findUnique: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  // Tagged-template raw INSERT ... ON CONFLICT DO NOTHING used by the repair.
  $executeRaw: jest.fn().mockResolvedValue(1),
});

// Positional parameters of the raw insert (everything after the template
// strings array): id, userId, mode, status, initialCapitalKrw, openedAt.
const rawInsertParams = (tx: ReturnType<typeof createTx>) =>
  tx.$executeRaw.mock.calls[0].slice(1);

describe('deriveSeasonTradingAccountId', () => {
  it('matches the migration md5→uuid formula for known vectors', () => {
    // printf 'trading-account:season-participant:sp_dev_001' | md5sum
    expect(deriveSeasonTradingAccountId('sp_dev_001')).toBe(
      '4eff2045-e39c-08fd-b31e-88e6b1186440',
    );
    // printf 'trading-account:season-participant:sp-legacy-1' | md5sum
    expect(deriveSeasonTradingAccountId('sp-legacy-1')).toBe(
      '717d2942-0484-9ceb-65a0-7bc903b3814e',
    );
  });

  it('is deterministic for the same participant id', () => {
    expect(deriveSeasonTradingAccountId('sp-1')).toBe(
      deriveSeasonTradingAccountId('sp-1'),
    );
  });

  it('differs for different participant ids', () => {
    expect(deriveSeasonTradingAccountId('sp-1')).not.toBe(
      deriveSeasonTradingAccountId('sp-2'),
    );
  });

  it('produces a lowercase 8-4-4-4-12 uuid shape', () => {
    expect(deriveSeasonTradingAccountId('sp-anything')).toMatch(UUID_PATTERN);
  });
});

describe('mapParticipantStatusToTradingAccountStatus', () => {
  it.each([
    [ParticipantStatus.registered, TradingAccountStatus.active],
    [ParticipantStatus.active, TradingAccountStatus.active],
    [ParticipantStatus.excluded, TradingAccountStatus.suspended],
    [ParticipantStatus.finished, TradingAccountStatus.closed],
    [ParticipantStatus.rewarded, TradingAccountStatus.closed],
  ])('maps %s to %s like the migration backfill', (from, to) => {
    expect(mapParticipantStatusToTradingAccountStatus(from)).toBe(to);
  });
});

describe('ensureSeasonTradingAccountLink', () => {
  it('returns the linked account without creating anything when already linked', async () => {
    const tx = createTx();
    tx.tradingAccount.findUnique.mockResolvedValueOnce(
      matchingAccount({ id: 'ta-1', seasonParticipant: { id: 'sp-legacy-1' } }),
    );

    const result = await ensureSeasonTradingAccountLink(
      tx as never,
      participant({ tradingAccountId: 'ta-1' }),
    );

    expect(result).toEqual({
      tradingAccountId: 'ta-1',
      action: 'already-linked',
    });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.seasonParticipant.updateMany).not.toHaveBeenCalled();
  });

  it('fails closed when the linked account belongs to another user', async () => {
    const tx = createTx();
    tx.tradingAccount.findUnique.mockResolvedValueOnce(
      matchingAccount({ id: 'ta-1', userId: 'user-other' }),
    );

    await expect(
      ensureSeasonTradingAccountLink(
        tx as never,
        participant({ tradingAccountId: 'ta-1' }),
      ),
    ).rejects.toBeInstanceOf(SeasonTradingAccountLinkIntegrityError);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.seasonParticipant.updateMany).not.toHaveBeenCalled();
  });

  it('creates the deterministic season account and links a null participant', async () => {
    const tx = createTx();
    tx.tradingAccount.findUnique.mockResolvedValueOnce(null);

    const result = await ensureSeasonTradingAccountLink(
      tx as never,
      participant({ participantStatus: ParticipantStatus.excluded }),
    );

    expect(result).toEqual({
      tradingAccountId: DETERMINISTIC_ID,
      action: 'created-and-linked',
    });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(rawInsertParams(tx)).toEqual([
      DETERMINISTIC_ID,
      'user-1',
      'season',
      'suspended',
      CAPITAL,
      JOINED_AT,
    ]);
    expect(tx.seasonParticipant.updateMany).toHaveBeenCalledWith({
      where: { id: 'sp-legacy-1', tradingAccountId: null },
      data: { tradingAccountId: DETERMINISTIC_ID },
    });
  });

  it('links an existing deterministic account without recreating it', async () => {
    const tx = createTx();
    tx.tradingAccount.findUnique.mockResolvedValueOnce(matchingAccount());

    const result = await ensureSeasonTradingAccountLink(
      tx as never,
      participant(),
    );

    expect(result).toEqual({
      tradingAccountId: DETERMINISTIC_ID,
      action: 'linked-existing-account',
    });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('treats a concurrent identical link as already linked', async () => {
    const tx = createTx();
    tx.tradingAccount.findUnique.mockResolvedValueOnce(null);
    tx.seasonParticipant.updateMany.mockResolvedValueOnce({ count: 0 });
    tx.seasonParticipant.findUnique.mockResolvedValueOnce({
      tradingAccountId: DETERMINISTIC_ID,
    });

    const result = await ensureSeasonTradingAccountLink(
      tx as never,
      participant(),
    );

    expect(result).toEqual({
      tradingAccountId: DETERMINISTIC_ID,
      action: 'already-linked',
    });
  });

  it('fails closed when the participant was linked to a different account concurrently', async () => {
    const tx = createTx();
    tx.tradingAccount.findUnique.mockResolvedValueOnce(null);
    tx.seasonParticipant.updateMany.mockResolvedValueOnce({ count: 0 });
    tx.seasonParticipant.findUnique.mockResolvedValueOnce({
      tradingAccountId: 'ta-unexpected',
    });

    await expect(
      ensureSeasonTradingAccountLink(tx as never, participant()),
    ).rejects.toBeInstanceOf(SeasonTradingAccountLinkIntegrityError);
  });

  it.each([
    ['different user', { userId: 'user-other' }],
    ['general mode', { mode: 'general' }],
    [
      'different initial capital',
      { initialCapitalKrw: new Prisma.Decimal('1.00000000') },
    ],
    ['different openedAt', { openedAt: new Date('2020-01-01T00:00:00.000Z') }],
    [
      'attached to another participant',
      { seasonParticipant: { id: 'sp-other' } },
    ],
  ])(
    'fails closed when the deterministic account has %s',
    async (_label, overrides) => {
      const tx = createTx();
      tx.tradingAccount.findUnique.mockResolvedValueOnce(
        matchingAccount(overrides as Record<string, unknown>),
      );

      await expect(
        ensureSeasonTradingAccountLink(tx as never, participant()),
      ).rejects.toBeInstanceOf(SeasonTradingAccountLinkIntegrityError);
      expect(tx.$executeRaw).not.toHaveBeenCalled();
      expect(tx.seasonParticipant.updateMany).not.toHaveBeenCalled();
    },
  );

  it('translates a unique violation on linking into an integrity error', async () => {
    const tx = createTx();
    tx.tradingAccount.findUnique.mockResolvedValueOnce(null);
    tx.seasonParticipant.updateMany.mockRejectedValueOnce(
      Object.assign(new Error('unique violation'), { code: 'P2002' }),
    );

    await expect(
      ensureSeasonTradingAccountLink(tx as never, participant()),
    ).rejects.toBeInstanceOf(SeasonTradingAccountLinkIntegrityError);
  });
});

describe('previewSeasonTradingAccountLink', () => {
  it('never writes and reports would-create for a missing account', async () => {
    const tx = createTx();
    tx.tradingAccount.findUnique.mockResolvedValueOnce(null);

    const result = await previewSeasonTradingAccountLink(
      tx as never,
      participant(),
    );

    expect(result).toEqual({
      tradingAccountId: DETERMINISTIC_ID,
      action: 'would-create-and-link',
    });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.seasonParticipant.updateMany).not.toHaveBeenCalled();
  });

  it('reports would-link when the deterministic account already exists and matches', async () => {
    const tx = createTx();
    tx.tradingAccount.findUnique.mockResolvedValueOnce(matchingAccount());

    const result = await previewSeasonTradingAccountLink(
      tx as never,
      participant(),
    );

    expect(result).toEqual({
      tradingAccountId: DETERMINISTIC_ID,
      action: 'would-link-existing-account',
    });
  });

  it('fails closed on a mismatching deterministic account without writing', async () => {
    const tx = createTx();
    tx.tradingAccount.findUnique.mockResolvedValueOnce(
      matchingAccount({ mode: 'general' }),
    );

    await expect(
      previewSeasonTradingAccountLink(tx as never, participant()),
    ).rejects.toBeInstanceOf(SeasonTradingAccountLinkIntegrityError);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
});
