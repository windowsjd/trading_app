import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  ParticipantStatus,
  SeasonStatus,
  TradingAccountMode,
  TradingAccountStatus,
} from '../generated/prisma/client';
import {
  TradingAccountAccessService,
  type OwnedTradingAccount,
} from './trading-account-access.service';

/**
 * Read-only trading-account views for the logged-in owner. Returns only
 * accounts that actually exist — a user who has not entered general mode has
 * no general account and none is fabricated or auto-created here (GET must
 * never create accounts, wallets, or grants).
 */

type TradingAccountSeasonView = {
  seasonId: string;
  seasonName: string;
  seasonStatus: SeasonStatus;
  startAt: string;
  endAt: string;
  seasonParticipantId: string;
  participantStatus: ParticipantStatus;
  joinedAt: string;
};

type TradingAccountView = {
  id: string;
  mode: TradingAccountMode;
  status: TradingAccountStatus;
  initialCapitalKrw: string;
  openedAt: string;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  season: TradingAccountSeasonView | null;
};

type TradingAccountsListResponse = {
  success: true;
  data: {
    accounts: TradingAccountView[];
  };
};

type TradingAccountDetailResponse = {
  success: true;
  data: TradingAccountView;
};

@Injectable()
export class TradingAccountsService {
  constructor(private readonly accessService: TradingAccountAccessService) {}

  async listTradingAccounts(
    userId?: string,
  ): Promise<TradingAccountsListResponse> {
    const ownerId = this.requireUserId(userId);
    const accounts = await this.accessService.listOwnedAccounts(ownerId);

    return {
      success: true,
      data: {
        accounts: accounts.map((account) => this.toView(account)),
      },
    };
  }

  async getTradingAccount(
    userId: string | undefined,
    accountId: string,
  ): Promise<TradingAccountDetailResponse> {
    const ownerId = this.requireUserId(userId);
    const account = await this.accessService.getOwnedAccountOrThrow(
      ownerId,
      typeof accountId === 'string' ? accountId.trim() : accountId,
    );

    return {
      success: true,
      data: this.toView(account),
    };
  }

  private toView(account: OwnedTradingAccount): TradingAccountView {
    return {
      id: account.id,
      mode: account.mode,
      status: account.status,
      initialCapitalKrw: account.initialCapitalKrw.toFixed(8),
      openedAt: account.openedAt.toISOString(),
      closedAt: account.closedAt?.toISOString() ?? null,
      createdAt: account.createdAt.toISOString(),
      updatedAt: account.updatedAt.toISOString(),
      season: account.seasonParticipant
        ? {
            seasonId: account.seasonParticipant.season.id,
            seasonName: account.seasonParticipant.season.name,
            seasonStatus: account.seasonParticipant.season.status,
            startAt: account.seasonParticipant.season.startAt.toISOString(),
            endAt: account.seasonParticipant.season.endAt.toISOString(),
            seasonParticipantId: account.seasonParticipant.id,
            participantStatus: account.seasonParticipant.participantStatus,
            joinedAt: account.seasonParticipant.joinedAt.toISOString(),
          }
        : null,
    };
  }

  private requireUserId(userId: string | undefined): string {
    if (!userId) {
      throw new HttpException(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Unauthorized',
          },
        },
        HttpStatus.UNAUTHORIZED,
      );
    }

    return userId;
  }
}
