jest.mock('../generated/prisma/client', () => ({
  CurrencyCode: {
    KRW: 'KRW',
    USD: 'USD',
  },
  ParticipantStatus: {
    active: 'active',
    registered: 'registered',
    finished: 'finished',
    rewarded: 'rewarded',
    excluded: 'excluded',
  },
  Prisma: {
    PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {},
  },
  PrismaClient: class PrismaClient {},
  SeasonStatus: {
    active: 'active',
    ended: 'ended',
    settled: 'settled',
    upcoming: 'upcoming',
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
}));

import { IS_OPTIONAL_AUTH_ROUTE_KEY } from '../auth/auth.decorators';
import { SeasonsController } from './seasons.controller';

describe('SeasonsController', () => {
  const createController = () => {
    const seasonsService = {
      getCurrentSeason: jest.fn().mockReturnValue({
        success: true,
        data: {
          joined: false,
        },
      }),
      joinSeason: jest.fn().mockReturnValue({
        success: true,
        data: {
          seasonId: 'season-1',
        },
      }),
    };
    const controller = new SeasonsController(seasonsService as never);

    return { controller, seasonsService };
  };

  it('marks current season as optional auth', () => {
    expect(
      Reflect.getMetadata(
        IS_OPTIONAL_AUTH_ROUTE_KEY,
        SeasonsController.prototype.getCurrentSeason,
      ),
    ).toBe(true);
  });

  it('passes optional authenticated user id to current season service', () => {
    const { controller, seasonsService } = createController();

    controller.getCurrentSeason({
      user: {
        userId: 'user-1',
      },
    } as never);

    expect(seasonsService.getCurrentSeason).toHaveBeenCalledWith('user-1');
  });

  it('does not use x-user-id as join identity', () => {
    const { controller, seasonsService } = createController();

    controller.joinSeason('season-1', {
      headers: {
        'x-user-id': 'user-1',
      },
    } as never);

    expect(seasonsService.joinSeason).toHaveBeenCalledWith(
      'season-1',
      undefined,
    );
  });
});
