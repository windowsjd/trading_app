import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma, TradingAccountMode } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Ownership-checked TradingAccount lookup shared by the trading-accounts API
 * today and by future accountId-based wallet/order/position/portfolio APIs.
 *
 * Policy:
 *  - Ownership is part of the query WHERE, so "does not exist" and "owned by
 *    another user" are indistinguishable to the caller: both are the same
 *    404 TRADING_ACCOUNT_NOT_FOUND (no account-existence oracle).
 *  - Status never gates reads: an owner can read active, suspended, and
 *    closed accounts alike. Asset-mutation gating stays with the existing
 *    season order/fx policies and is NOT decided here.
 *  - The server keeps no "currently selected account" state anywhere; every
 *    request must name its accountId and is re-checked here.
 */

const OWNED_ACCOUNT_SELECT = {
  id: true,
  userId: true,
  mode: true,
  status: true,
  initialCapitalKrw: true,
  openedAt: true,
  closedAt: true,
  createdAt: true,
  updatedAt: true,
  seasonParticipant: {
    select: {
      id: true,
      userId: true,
      participantStatus: true,
      joinedAt: true,
      season: {
        select: {
          id: true,
          name: true,
          status: true,
          startAt: true,
          endAt: true,
        },
      },
    },
  },
} satisfies Prisma.TradingAccountSelect;

export type OwnedTradingAccount = Prisma.TradingAccountGetPayload<{
  select: typeof OWNED_ACCOUNT_SELECT;
}>;

@Injectable()
export class TradingAccountAccessService {
  private readonly logger = new Logger(TradingAccountAccessService.name);

  constructor(private readonly prisma: PrismaService) {}

  async listOwnedAccounts(userId: string): Promise<OwnedTradingAccount[]> {
    const accounts = await this.prisma.tradingAccount.findMany({
      where: { userId },
      orderBy: [{ openedAt: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
      select: OWNED_ACCOUNT_SELECT,
    });

    for (const account of accounts) {
      this.validateAccountShape(account);
    }

    return accounts;
  }

  async getOwnedAccountOrThrow(
    userId: string,
    accountId: string,
  ): Promise<OwnedTradingAccount> {
    const account = await this.prisma.tradingAccount.findFirst({
      where: {
        id: accountId,
        userId,
      },
      select: OWNED_ACCOUNT_SELECT,
    });

    if (!account) {
      throw new HttpException(
        this.errorBody(
          'TRADING_ACCOUNT_NOT_FOUND',
          'Trading account not found',
        ),
        HttpStatus.NOT_FOUND,
      );
    }

    this.validateAccountShape(account);

    return account;
  }

  /**
   * season accounts must have exactly their owner's participant attached;
   * general accounts must have none. A violation is server-side data
   * corruption: log it and fail closed with a structured 500 instead of
   * hiding it behind a 404.
   */
  private validateAccountShape(account: OwnedTradingAccount) {
    if (account.mode === TradingAccountMode.season) {
      if (!account.seasonParticipant) {
        this.throwIntegrity(account.id, 'season account has no participant');
      }

      if (account.seasonParticipant.userId !== account.userId) {
        this.throwIntegrity(
          account.id,
          'season account participant belongs to a different user',
        );
      }

      return;
    }

    if (account.seasonParticipant) {
      this.throwIntegrity(
        account.id,
        'general account has a season participant attached',
      );
    }
  }

  private throwIntegrity(accountId: string, reason: string): never {
    this.logger.error(
      `Trading account integrity violation (account=${accountId}): ${reason}`,
    );

    throw new HttpException(
      this.errorBody(
        'TRADING_ACCOUNT_INTEGRITY',
        'Trading account data is inconsistent.',
      ),
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  private errorBody(code: string, message: string) {
    return {
      success: false,
      error: {
        code,
        message,
      },
    };
  }
}
