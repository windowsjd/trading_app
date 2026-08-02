import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  CurrencyCode,
  ParticipantStatus,
  Prisma,
  SeasonStatus,
  SnapshotReason,
  TradingAccountMode,
  TradingAccountStatus,
  UserStatus,
  WalletTransactionDirection,
  WalletTransactionReferenceType,
  WalletTransactionType,
} from '../generated/prisma/client';
import { buildPagination, type Pagination } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertSeasonJoinable,
  getEffectiveSeasonMode,
  SeasonLifecycleError,
  type SeasonLifecycleMode,
  type SeasonLifecycleSeason,
} from './season-lifecycle.policy';
import {
  ensureSeasonTradingAccountLink,
  SeasonTradingAccountLinkIntegrityError,
} from './season-trading-account-link';

type CurrentSeasonResponse = {
  success: true;
  data: {
    id: string;
    name: string;
    status: SeasonStatus;
    effectiveStatus: SeasonStatus;
    effectiveMode: SeasonLifecycleMode;
    startAt: string;
    endAt: string;
    initialCapitalKrw: string;
    tradeFeeRate: string;
    fxFeeRate: string;
    joined: boolean;
    joinedAt: string | null;
  };
};

export type SeasonsListQuery = {
  status?: string;
  limit?: string;
  offset?: string;
};

type ParsedSeasonsListQuery = {
  status?: SeasonStatus;
  limit: number;
  offset: number;
};

type SeasonsListResponse = {
  success: true;
  data: {
    state: 'available';
    seasons: Array<{
      id: string;
      name: string;
      status: SeasonStatus;
      effectiveStatus: SeasonStatus;
      effectiveMode: SeasonLifecycleMode;
      startAt: string;
      endAt: string;
      initialCapitalKrw: string;
      tradeFeeRate: string;
      fxFeeRate: string;
    }>;
    pagination: Pagination;
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

// The already-joined outcome is returned (not thrown) from the join
// transaction so a legacy null-link repair performed inside it commits before
// the API-contract 409 is raised.
type JoinSeasonTransactionResult =
  | { kind: 'already-joined' }
  | { kind: 'joined'; response: JoinSeasonResponse };

const CURRENT_SEASON_STATUS_PRIORITY: readonly SeasonStatus[] = [
  SeasonStatus.active,
  SeasonStatus.upcoming,
  SeasonStatus.ended,
  SeasonStatus.settled,
];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const ZERO_AMOUNT = '0.00000000';

@Injectable()
export class SeasonsService {
  constructor(private readonly prisma: PrismaService) {}

  async getSeasons(query: SeasonsListQuery = {}): Promise<SeasonsListResponse> {
    const parsedQuery = this.parseSeasonsListQuery(query);
    const where: Prisma.SeasonWhereInput = parsedQuery.status
      ? {
          status: parsedQuery.status,
        }
      : {};
    const [total, seasons] = await Promise.all([
      this.prisma.season.count({ where }),
      this.prisma.season.findMany({
        where,
        orderBy: [{ startAt: 'desc' }, { createdAt: 'desc' }],
        skip: parsedQuery.offset,
        take: parsedQuery.limit,
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
      }),
    ]);
    const now = new Date();

    return {
      success: true,
      data: {
        state: 'available',
        seasons: seasons.map((season) => {
          const effectiveMode = getEffectiveSeasonMode(season, now);

          return {
            id: season.id,
            name: season.name,
            status: season.status,
            effectiveStatus: this.toSeasonStatus(effectiveMode),
            effectiveMode,
            startAt: season.startAt.toISOString(),
            endAt: season.endAt.toISOString(),
            initialCapitalKrw: this.formatDecimal(season.initialCapitalKrw, 8),
            tradeFeeRate: this.formatDecimal(season.tradeFeeRate, 6),
            fxFeeRate: this.formatDecimal(season.fxFeeRate, 6),
          };
        }),
        pagination: buildPagination({
          limit: parsedQuery.limit,
          offset: parsedQuery.offset,
          total,
          returned: seasons.length,
        }),
      },
    };
  }

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
    const effectiveMode = getEffectiveSeasonMode(season, new Date());

    return {
      success: true,
      data: {
        id: season.id,
        name: season.name,
        status: season.status,
        effectiveStatus: this.toSeasonStatus(effectiveMode),
        effectiveMode,
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
      this.throwApiError(
        HttpStatus.UNAUTHORIZED,
        'UNAUTHORIZED',
        'Unauthorized',
      );
    }

    let result: JoinSeasonTransactionResult;

    try {
      result = await this.prisma.$transaction(async (tx) => {
        const season = await tx.season.findUnique({
          where: {
            id: seasonId,
          },
          select: {
            id: true,
            status: true,
            startAt: true,
            endAt: true,
            initialCapitalKrw: true,
          },
        });

        if (!season) {
          this.throwApiError(
            HttpStatus.NOT_FOUND,
            'SEASON_NOT_FOUND',
            'Season not found',
          );
        }

        this.assertSeasonJoinable(season, new Date());

        const user = await tx.user.findUnique({
          where: {
            id: userId,
          },
          select: {
            status: true,
          },
        });

        if (user && user.status !== UserStatus.active) {
          this.throwApiError(
            HttpStatus.FORBIDDEN,
            'USER_NOT_ACTIVE',
            'User is not active',
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
            userId: true,
            joinedAt: true,
            participantStatus: true,
            initialCapitalKrw: true,
            tradingAccountId: true,
          },
        });

        if (existingParticipant) {
          if (!existingParticipant.tradingAccountId) {
            // Deploy-boundary legacy row: an old-version writer created this
            // participant without a trading account. Repair ONLY the account
            // link (never wallets/ledger/snapshots) before returning the
            // unchanged 409 contract.
            await ensureSeasonTradingAccountLink(tx, existingParticipant);
          }

          return { kind: 'already-joined' } as const;
        }

        const joinedAt = new Date();
        const initialCapitalKrw = this.formatDecimal(
          season.initialCapitalKrw,
          8,
        );

        // The season-scoped trading account is created in the SAME transaction
        // as the participant, wallets, and initial grant, so a failure in any
        // later step rolls the account back too and a replayed join can never
        // leave a duplicate or orphan account.
        const tradingAccount = await tx.tradingAccount.create({
          data: {
            userId,
            mode: TradingAccountMode.season,
            status: TradingAccountStatus.active,
            initialCapitalKrw,
            openedAt: joinedAt,
          },
          select: {
            id: true,
          },
        });

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
            tradingAccountId: tradingAccount.id,
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

        await tx.equitySnapshot.create({
          data: {
            seasonParticipantId: participant.id,
            totalAssetKrw: initialCapitalKrw,
            returnRate: ZERO_AMOUNT,
            krwCash: initialCapitalKrw,
            usdCashKrw: ZERO_AMOUNT,
            domesticStockValueKrw: ZERO_AMOUNT,
            usStockValueKrw: ZERO_AMOUNT,
            cryptoValueKrw: ZERO_AMOUNT,
            snapshotReason: SnapshotReason.season_join,
            capturedAt: joinedAt,
          },
        });

        return {
          kind: 'joined',
          response: {
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
          },
        } as const;
      });
    } catch (error) {
      if (error instanceof SeasonTradingAccountLinkIntegrityError) {
        // A failed link repair is a server-side data problem; never disguise
        // it as the ordinary SEASON_ALREADY_JOINED conflict.
        this.throwApiError(
          HttpStatus.INTERNAL_SERVER_ERROR,
          error.code,
          error.message,
        );
      }

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

    if (result.kind === 'already-joined') {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'SEASON_ALREADY_JOINED',
        'Season already joined',
      );
    }

    return result.response;
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
      this.createErrorBody('SEASON_NOT_FOUND', 'Current season not found'),
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

  private parseSeasonsListQuery(
    query: SeasonsListQuery,
  ): ParsedSeasonsListQuery {
    return {
      status: this.parseSeasonStatus(query.status),
      limit: this.parseLimit(query.limit),
      offset: this.parseOffset(query.offset),
    };
  }

  private parseSeasonStatus(
    value: string | undefined,
  ): SeasonStatus | undefined {
    const text = this.parseOptionalText(value);
    if (!text) {
      return undefined;
    }

    if (
      text === SeasonStatus.upcoming ||
      text === SeasonStatus.active ||
      text === SeasonStatus.ended ||
      text === SeasonStatus.settled
    ) {
      return text;
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'INVALID_SEASON_STATUS',
      'Invalid season status.',
    );
  }

  private parseLimit(value: string | undefined): number {
    if (value === undefined) {
      return DEFAULT_LIMIT;
    }

    const limit = this.parseNonNegativeInteger(value, 'INVALID_LIMIT', 'limit');
    if (limit < 1) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_LIMIT',
        'limit must be greater than 0.',
      );
    }

    return Math.min(limit, MAX_LIMIT);
  }

  private parseOffset(value: string | undefined): number {
    if (value === undefined) {
      return 0;
    }

    return this.parseNonNegativeInteger(value, 'INVALID_OFFSET', 'offset');
  }

  private parseNonNegativeInteger(
    value: string,
    code: string,
    fieldName: string,
  ): number {
    if (!/^\d+$/.test(value.trim())) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        code,
        `${fieldName} must be a non-negative integer.`,
      );
    }

    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        code,
        `${fieldName} must be a safe integer.`,
      );
    }

    return parsed;
  }

  private parseOptionalText(value: string | undefined): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }

  private toSeasonStatus(mode: SeasonLifecycleMode): SeasonStatus {
    switch (mode) {
      case 'active':
        return SeasonStatus.active;
      case 'ended':
        return SeasonStatus.ended;
      case 'settled':
        return SeasonStatus.settled;
      case 'upcoming':
      default:
        return SeasonStatus.upcoming;
    }
  }

  private assertSeasonJoinable(season: SeasonLifecycleSeason, now: Date) {
    try {
      assertSeasonJoinable(season, now);
    } catch (error) {
      if (error instanceof SeasonLifecycleError) {
        this.throwApiError(HttpStatus.CONFLICT, error.code, error.message);
      }

      throw error;
    }
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

  private throwApiError(
    status: HttpStatus,
    code: string,
    message: string,
  ): never {
    throw new HttpException(this.createErrorBody(code, message), status);
  }
}
