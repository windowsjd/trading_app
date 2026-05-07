import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  CurrencyCode,
  ParticipantStatus,
  Prisma,
  SeasonStatus,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type WalletsState = 'available' | 'not_joined' | 'unavailable';

type WalletsSeason = {
  id: string;
  name: string;
  status: SeasonStatus;
  startAt: Date;
  endAt: Date;
};

type WalletsParticipant = {
  id: string;
  participantStatus: ParticipantStatus;
  joinedAt: Date;
};

type WalletsResponse = {
  success: true;
  data: {
    state: WalletsState;
    season: ReturnType<WalletsService['formatSeason']> | null;
    participant: ReturnType<WalletsService['formatParticipant']> | null;
    wallets: Array<{
      currencyCode: CurrencyCode;
      balanceAmount: string;
      updatedAt: string;
    }>;
    summary: {
      totalWallets: number;
      hasKrwWallet: boolean;
      hasUsdWallet: boolean;
    };
    reason?: string;
    message?: string;
  };
};

const CURRENT_SEASON_STATUS_PRIORITY: readonly SeasonStatus[] = [
  SeasonStatus.active,
  SeasonStatus.upcoming,
  SeasonStatus.ended,
  SeasonStatus.settled,
];

@Injectable()
export class WalletsService {
  constructor(private readonly prisma: PrismaService) {}

  async getWallets(userId?: string): Promise<WalletsResponse> {
    if (!userId) {
      this.throwApiError(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', 'Unauthorized');
    }

    const season = await this.findCurrentSeason();
    if (!season) {
      return this.unavailableResponse(
        null,
        'CURRENT_SEASON_NOT_FOUND',
        'Current season is not configured.',
      );
    }

    const participant = await this.prisma.seasonParticipant.findUnique({
      where: {
        seasonId_userId: {
          seasonId: season.id,
          userId,
        },
      },
      select: {
        id: true,
        participantStatus: true,
        joinedAt: true,
      },
    });

    if (!participant) {
      return {
        success: true,
        data: {
          state: 'not_joined',
          season: this.formatSeason(season),
          participant: null,
          wallets: [],
          summary: this.emptySummary(),
          reason: 'SEASON_NOT_JOINED',
          message: 'Wallets are available after joining the season.',
        },
      };
    }

    const wallets = await this.prisma.cashWallet.findMany({
      where: {
        seasonParticipantId: participant.id,
      },
      orderBy: {
        currencyCode: 'asc',
      },
      select: {
        currencyCode: true,
        balanceAmount: true,
        updatedAt: true,
      },
    });

    return {
      success: true,
      data: {
        state: 'available',
        season: this.formatSeason(season),
        participant: this.formatParticipant(participant),
        wallets: wallets.map((wallet) => ({
          currencyCode: wallet.currencyCode,
          balanceAmount: this.formatDecimal(wallet.balanceAmount, 8),
          updatedAt: wallet.updatedAt.toISOString(),
        })),
        summary: {
          totalWallets: wallets.length,
          hasKrwWallet: wallets.some(
            (wallet) => wallet.currencyCode === CurrencyCode.KRW,
          ),
          hasUsdWallet: wallets.some(
            (wallet) => wallet.currencyCode === CurrencyCode.USD,
          ),
        },
      },
    };
  }

  private unavailableResponse(
    season: WalletsSeason | null,
    reason: string,
    message: string,
  ): WalletsResponse {
    return {
      success: true,
      data: {
        state: 'unavailable',
        season: season ? this.formatSeason(season) : null,
        participant: null,
        wallets: [],
        summary: this.emptySummary(),
        reason,
        message,
      },
    };
  }

  private emptySummary() {
    return {
      totalWallets: 0,
      hasKrwWallet: false,
      hasUsdWallet: false,
    };
  }

  private async findCurrentSeason(): Promise<WalletsSeason | null> {
    for (const status of CURRENT_SEASON_STATUS_PRIORITY) {
      const season = await this.prisma.season.findFirst({
        where: {
          status,
        },
        select: {
          id: true,
          name: true,
          status: true,
          startAt: true,
          endAt: true,
        },
        orderBy: this.getSeasonOrderBy(status),
      });

      if (season) {
        return season;
      }
    }

    return null;
  }

  private getSeasonOrderBy(
    status: SeasonStatus,
  ): Prisma.SeasonFindFirstArgs['orderBy'] {
    switch (status) {
      case SeasonStatus.upcoming:
        return [{ startAt: 'asc' }, { createdAt: 'asc' }];
      case SeasonStatus.ended:
      case SeasonStatus.settled:
        return [{ endAt: 'desc' }, { createdAt: 'desc' }];
      case SeasonStatus.active:
      default:
        return [{ startAt: 'desc' }, { createdAt: 'desc' }];
    }
  }

  private formatSeason(season: WalletsSeason) {
    return {
      id: season.id,
      name: season.name,
      status: season.status,
      startAt: season.startAt.toISOString(),
      endAt: season.endAt.toISOString(),
    };
  }

  private formatParticipant(participant: WalletsParticipant) {
    return {
      id: participant.id,
      status: participant.participantStatus,
      joinedAt: participant.joinedAt.toISOString(),
    };
  }

  private formatDecimal(value: Prisma.Decimal, scale: number) {
    return value.toFixed(scale);
  }

  private createErrorBody(code: string, message: string) {
    return {
      success: false,
      error: {
        code,
        message,
      },
    };
  }

  private throwApiError(status: HttpStatus, code: string, message: string): never {
    throw new HttpException(this.createErrorBody(code, message), status);
  }
}
