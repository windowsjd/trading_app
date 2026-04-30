import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  CurrencyCode,
  ParticipantStatus,
  Prisma,
  SeasonStatus,
  WalletTransactionDirection,
  WalletTransactionReferenceType,
  WalletTransactionType,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type CurrentSeasonResponse = {
  success: true;
  data: {
    id: string;
    name: string;
    status: SeasonStatus;
    startAt: string;
    endAt: string;
    initialCapitalKrw: string;
    tradeFeeRate: string;
    fxFeeRate: string;
    joined: boolean;
    joinedAt: string | null;
  };
};

type CurrentSeasonRecord = {
  id: string;
  name: string;
  status: SeasonStatus;
  startAt: Date;
  endAt: Date;
  initialCapitalKrw: Prisma.Decimal;
  tradeFeeRate: Prisma.Decimal;
  fxFeeRate: Prisma.Decimal;
};

type JoinSeasonResponse = {
  success: true;
  data: {
    seasonParticipantId: string;
    seasonId: string;
    joinedAt: string;
    wallets: {
      KRW: string;
      USD: string;
    };
  };
};

const CURRENT_SEASON_STATUS_PRIORITY: readonly SeasonStatus[] = [
  SeasonStatus.active,
  SeasonStatus.upcoming,
  SeasonStatus.ended,
  SeasonStatus.settled,
];
const ZERO_AMOUNT = '0.00000000';

@Injectable()
export class SeasonsService {
  constructor(private readonly prisma: PrismaService) {}

  async getCurrentSeason(userId?: string): Promise<CurrentSeasonResponse> {
    const season = await this.findCurrentSeason();
    const participant = userId
      ? await this.prisma.seasonParticipant.findUnique({
          where: {
            seasonId_userId: {
              seasonId: season.id,
              userId,
            },
          },
          select: {
            joinedAt: true,
          },
        })
      : null;

    return {
      success: true,
      data: {
        id: season.id,
        name: season.name,
        status: season.status,
        startAt: season.startAt.toISOString(),
        endAt: season.endAt.toISOString(),
        initialCapitalKrw: this.formatDecimal(season.initialCapitalKrw, 8),
        tradeFeeRate: this.formatDecimal(season.tradeFeeRate, 6),
        fxFeeRate: this.formatDecimal(season.fxFeeRate, 6),
        joined: participant !== null,
        joinedAt: participant?.joinedAt.toISOString() ?? null,
      },
    };
  }

  async joinSeason(
    seasonId: string,
    userId?: string,
  ): Promise<JoinSeasonResponse> {
    if (!userId) {
      this.throwApiError(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', 'Unauthorized');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const season = await tx.season.findUnique({
          where: {
            id: seasonId,
          },
          select: {
            id: true,
            status: true,
            initialCapitalKrw: true,
          },
        });

        if (!season) {
          this.throwApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Season not found');
        }

        if (season.status !== SeasonStatus.active) {
          this.throwApiError(
            HttpStatus.CONFLICT,
            'SEASON_NOT_ACTIVE',
            'Season is not active',
          );
        }

        const existingParticipant = await tx.seasonParticipant.findUnique({
          where: {
            seasonId_userId: {
              seasonId: season.id,
              userId,
            },
          },
          select: {
            id: true,
          },
        });

        if (existingParticipant) {
          this.throwApiError(
            HttpStatus.CONFLICT,
            'SEASON_ALREADY_JOINED',
            'Season already joined',
          );
        }

        const joinedAt = new Date();
        const initialCapitalKrw = this.formatDecimal(season.initialCapitalKrw, 8);

        const participant = await tx.seasonParticipant.create({
          data: {
            seasonId: season.id,
            userId,
            joinedAt,
            participantStatus: ParticipantStatus.active,
            initialCapitalKrw,
            totalAssetKrw: initialCapitalKrw,
            totalReturnRate: ZERO_AMOUNT,
            maxDrawdown: ZERO_AMOUNT,
          },
          select: {
            id: true,
          },
        });

        const krwWallet = await tx.cashWallet.create({
          data: {
            seasonParticipantId: participant.id,
            currencyCode: CurrencyCode.KRW,
            balanceAmount: initialCapitalKrw,
          },
        });

        await tx.cashWallet.create({
          data: {
            seasonParticipantId: participant.id,
            currencyCode: CurrencyCode.USD,
            balanceAmount: ZERO_AMOUNT,
          },
        });

        await tx.walletTransaction.create({
          data: {
            seasonParticipantId: participant.id,
            walletId: krwWallet.id,
            currencyCode: CurrencyCode.KRW,
            direction: WalletTransactionDirection.credit,
            txType: WalletTransactionType.initial_grant,
            referenceType: WalletTransactionReferenceType.season_join,
            referenceId: participant.id,
            amount: initialCapitalKrw,
            balanceAfter: initialCapitalKrw,
            occurredAt: joinedAt,
          },
        });

        return {
          success: true,
          data: {
            seasonParticipantId: participant.id,
            seasonId: season.id,
            joinedAt: joinedAt.toISOString(),
            wallets: {
              KRW: initialCapitalKrw,
              USD: ZERO_AMOUNT,
            },
          },
        };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        this.throwApiError(
          HttpStatus.CONFLICT,
          'SEASON_ALREADY_JOINED',
          'Season already joined',
        );
      }

      throw error;
    }
  }

  private async findCurrentSeason(): Promise<CurrentSeasonRecord> {
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
          initialCapitalKrw: true,
          tradeFeeRate: true,
          fxFeeRate: true,
        },
        orderBy: this.getOrderBy(status),
      });

      if (season) {
        return season;
      }
    }

    throw new HttpException(
      this.createErrorBody('NOT_FOUND', 'Current season not found'),
      HttpStatus.NOT_FOUND,
    );
  }

  private getOrderBy(
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
