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
  };
});

import { HttpException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { TradingAccountAccessService } from './trading-account-access.service';
import { TradingAccountsService } from './trading-accounts.service';

const NOW = new Date('2026-08-01T00:00:00.000Z');

const seasonAccountRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'ta-season-1',
  userId: 'user-1',
  mode: 'season',
  status: 'active',
  initialCapitalKrw: new Prisma.Decimal('10000000.00000000'),
  openedAt: new Date('2026-07-01T00:00:00.000Z'),
  closedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  seasonParticipant: {
    id: 'sp-1',
    userId: 'user-1',
    participantStatus: 'active',
    joinedAt: new Date('2026-07-01T00:00:00.000Z'),
    season: {
      id: 'season-1',
      name: 'Season 1',
      status: 'active',
      startAt: new Date('2026-06-01T00:00:00.000Z'),
      endAt: new Date('2026-09-01T00:00:00.000Z'),
    },
  },
  ...overrides,
});

const generalAccountRow = (overrides: Record<string, unknown> = {}) => ({
  ...seasonAccountRow(),
  id: 'ta-general-1',
  mode: 'general',
  seasonParticipant: null,
  ...overrides,
});

const createServices = () => {
  const prisma = {
    tradingAccount: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
  };
  const accessService = new TradingAccountAccessService(prisma as never);
  const service = new TradingAccountsService(accessService);

  return { prisma, accessService, service };
};

const expectStatusAndCode = async (
  work: Promise<unknown>,
  status: number,
  code: string,
) => {
  let caught: unknown;
  try {
    await work;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HttpException);
  expect((caught as HttpException).getStatus()).toBe(status);
  expect(
    ((caught as HttpException).getResponse() as { error: { code: string } })
      .error.code,
  ).toBe(code);
};

describe('TradingAccountsService.listTradingAccounts', () => {
  it('rejects a missing user id with 401 before any query', async () => {
    const { prisma, service } = createServices();

    await expectStatusAndCode(
      service.listTradingAccounts(undefined),
      401,
      'UNAUTHORIZED',
    );
    expect(prisma.tradingAccount.findMany).not.toHaveBeenCalled();
  });

  it('queries only the owner and serializes amounts/dates deterministically', async () => {
    const { prisma, service } = createServices();
    prisma.tradingAccount.findMany.mockResolvedValueOnce([
      seasonAccountRow({ status: 'suspended' }),
      generalAccountRow({ status: 'closed', closedAt: NOW }),
    ]);

    const response = await service.listTradingAccounts('user-1');

    expect(prisma.tradingAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1' },
        orderBy: [{ openedAt: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
      }),
    );
    expect(response).toEqual({
      success: true,
      data: {
        accounts: [
          {
            id: 'ta-season-1',
            mode: 'season',
            status: 'suspended',
            initialCapitalKrw: '10000000.00000000',
            openedAt: '2026-07-01T00:00:00.000Z',
            closedAt: null,
            createdAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
            season: {
              seasonId: 'season-1',
              seasonName: 'Season 1',
              seasonStatus: 'active',
              startAt: '2026-06-01T00:00:00.000Z',
              endAt: '2026-09-01T00:00:00.000Z',
              seasonParticipantId: 'sp-1',
              participantStatus: 'active',
              joinedAt: '2026-07-01T00:00:00.000Z',
            },
          },
          {
            id: 'ta-general-1',
            mode: 'general',
            status: 'closed',
            initialCapitalKrw: '10000000.00000000',
            openedAt: '2026-07-01T00:00:00.000Z',
            closedAt: NOW.toISOString(),
            createdAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
            season: null,
          },
        ],
      },
    });
  });

  it('returns an empty list without fabricating a placeholder general account', async () => {
    const { prisma, service } = createServices();
    prisma.tradingAccount.findMany.mockResolvedValueOnce([]);

    const response = await service.listTradingAccounts('user-1');

    expect(response.data.accounts).toEqual([]);
  });

  it('fails closed when a season account has no participant attached', async () => {
    const { prisma, service } = createServices();
    prisma.tradingAccount.findMany.mockResolvedValueOnce([
      seasonAccountRow({ seasonParticipant: null }),
    ]);

    await expectStatusAndCode(
      service.listTradingAccounts('user-1'),
      500,
      'TRADING_ACCOUNT_INTEGRITY',
    );
  });
});

describe('TradingAccountsService.getTradingAccount', () => {
  it('rejects a missing user id with 401', async () => {
    const { prisma, service } = createServices();

    await expectStatusAndCode(
      service.getTradingAccount(undefined, 'ta-season-1'),
      401,
      'UNAUTHORIZED',
    );
    expect(prisma.tradingAccount.findFirst).not.toHaveBeenCalled();
  });

  it('includes ownership in the query and returns the serialized account', async () => {
    const { prisma, service } = createServices();
    prisma.tradingAccount.findFirst.mockResolvedValueOnce(seasonAccountRow());

    const response = await service.getTradingAccount('user-1', ' ta-season-1 ');

    expect(prisma.tradingAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ta-season-1', userId: 'user-1' },
      }),
    );
    expect(response.data).toMatchObject({
      id: 'ta-season-1',
      mode: 'season',
      season: expect.objectContaining({ seasonParticipantId: 'sp-1' }),
    });
  });

  it('answers 404 TRADING_ACCOUNT_NOT_FOUND for missing and foreign accounts alike', async () => {
    const { prisma, service } = createServices();
    // Whether the row does not exist or belongs to another user, the
    // ownership-scoped query returns null — the responses are identical.
    prisma.tradingAccount.findFirst.mockResolvedValue(null);

    await expectStatusAndCode(
      service.getTradingAccount('user-1', 'ta-unknown'),
      404,
      'TRADING_ACCOUNT_NOT_FOUND',
    );
    await expectStatusAndCode(
      service.getTradingAccount('user-1', 'ta-owned-by-other-user'),
      404,
      'TRADING_ACCOUNT_NOT_FOUND',
    );
  });

  it('allows the owner to read suspended and closed accounts', async () => {
    const { prisma, service } = createServices();
    prisma.tradingAccount.findFirst
      .mockResolvedValueOnce(seasonAccountRow({ status: 'suspended' }))
      .mockResolvedValueOnce(
        generalAccountRow({ status: 'closed', closedAt: NOW }),
      );

    const suspended = await service.getTradingAccount('user-1', 'ta-season-1');
    const closed = await service.getTradingAccount('user-1', 'ta-general-1');

    expect(suspended.data.status).toBe('suspended');
    expect(closed.data.status).toBe('closed');
  });

  it('fails closed when a general account has a participant attached', async () => {
    const { prisma, service } = createServices();
    prisma.tradingAccount.findFirst.mockResolvedValueOnce(
      generalAccountRow({
        seasonParticipant: seasonAccountRow().seasonParticipant,
      }),
    );

    await expectStatusAndCode(
      service.getTradingAccount('user-1', 'ta-general-1'),
      500,
      'TRADING_ACCOUNT_INTEGRITY',
    );
  });

  it('fails closed when the participant belongs to a different user', async () => {
    const { prisma, service } = createServices();
    const row = seasonAccountRow();
    (row.seasonParticipant as { userId: string }).userId = 'user-other';
    prisma.tradingAccount.findFirst.mockResolvedValueOnce(row);

    await expectStatusAndCode(
      service.getTradingAccount('user-1', 'ta-season-1'),
      500,
      'TRADING_ACCOUNT_INTEGRITY',
    );
  });
});
