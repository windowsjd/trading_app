import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  CurrencyCode,
  ParticipantStatus,
  Prisma,
  SeasonStatus,
  WalletTransactionType,
} from '../generated/prisma/client';
import { buildPagination, type Pagination } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';

export type WalletTransactionsQuery = {
  currency?: string;
  direction?: string;
  txType?: string;
  limit?: string;
  offset?: string;
};

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
      /** Total owned cash (valuation input; unchanged by reservations). */
      balanceAmount: string;
      /** Cash locked by submitted limit-buy orders. */
      reservedAmount: string;
      /** balanceAmount - reservedAmount: spendable for new orders/FX. */
      availableAmount: string;
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

type ParsedWalletTransactionsQuery = {
  currency?: CurrencyCode;
  direction?: 'credit' | 'debit';
  txType?: string;
  limit: number;
  offset: number;
};

type WalletTransactionsResponse = {
  success: true;
  data: {
    state: WalletsState;
    season: ReturnType<WalletsService['formatSeason']> | null;
    participant: ReturnType<WalletsService['formatParticipant']> | null;
    filters: {
      currency: CurrencyCode | null;
      direction: 'credit' | 'debit' | null;
      txType: string | null;
    };
    transactions: Array<{
      id: string;
      currencyCode: CurrencyCode;
      direction: string;
      txType: string;
      referenceType: string;
      referenceId: string | null;
      amount: string;
      balanceAfter: string;
      occurredAt: string;
      createdAt: string;
    }>;
    pagination: Pagination;
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
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

@Injectable()
export class WalletsService {
  constructor(private readonly prisma: PrismaService) {}

  async getWalletTransactions(
    userId: string | undefined,
    query: WalletTransactionsQuery = {},
  ): Promise<WalletTransactionsResponse> {
    if (!userId) {
      this.throwApiError(
        HttpStatus.UNAUTHORIZED,
        'UNAUTHORIZED',
        'Unauthorized',
      );
    }

    const parsedQuery = this.parseWalletTransactionsQuery(query);
    const season = await this.findCurrentSeason();
    if (!season) {
      return this.emptyTransactionsResponse({
        state: 'unavailable',
        season: null,
        participant: null,
        query: parsedQuery,
        reason: 'CURRENT_SEASON_NOT_FOUND',
        message: 'Current season is not configured.',
      });
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
      return this.emptyTransactionsResponse({
        state: 'not_joined',
        season,
        participant: null,
        query: parsedQuery,
        reason: 'SEASON_NOT_JOINED',
        message: 'Wallet transactions are available after joining the season.',
      });
    }

    const where = {
      seasonParticipantId: participant.id,
      ...(parsedQuery.currency ? { currencyCode: parsedQuery.currency } : {}),
      ...(parsedQuery.direction ? { direction: parsedQuery.direction } : {}),
      ...this.walletTransactionTxTypeWhere(parsedQuery.txType),
    };
    const [total, transactions] = await Promise.all([
      this.prisma.walletTransaction.count({ where }),
      this.prisma.walletTransaction.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
        skip: parsedQuery.offset,
        take: parsedQuery.limit,
        select: {
          id: true,
          currencyCode: true,
          direction: true,
          txType: true,
          referenceType: true,
          referenceId: true,
          amount: true,
          balanceAfter: true,
          occurredAt: true,
          createdAt: true,
        },
      }),
    ]);

    return {
      success: true,
      data: {
        state: 'available',
        season: this.formatSeason(season),
        participant: this.formatParticipant(participant),
        filters: this.walletTransactionFilters(parsedQuery),
        transactions: transactions.map((transaction) => ({
          id: transaction.id,
          currencyCode: transaction.currencyCode,
          direction: transaction.direction,
          txType: transaction.txType,
          referenceType: transaction.referenceType,
          referenceId: transaction.referenceId,
          amount: this.formatDecimal(transaction.amount, 8),
          balanceAfter: this.formatDecimal(transaction.balanceAfter, 8),
          occurredAt: transaction.occurredAt.toISOString(),
          createdAt: transaction.createdAt.toISOString(),
        })),
        pagination: this.pagination(parsedQuery, total, transactions.length),
      },
    };
  }

  async getWallets(userId?: string): Promise<WalletsResponse> {
    if (!userId) {
      this.throwApiError(
        HttpStatus.UNAUTHORIZED,
        'UNAUTHORIZED',
        'Unauthorized',
      );
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
        reservedAmount: true,
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
          reservedAmount: this.formatDecimal(wallet.reservedAmount, 8),
          // Derived server-side with Prisma Decimal; never stored in DB.
          availableAmount: this.formatDecimal(
            wallet.balanceAmount.sub(wallet.reservedAmount),
            8,
          ),
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

  private emptyTransactionsResponse(input: {
    state: WalletsState;
    season: WalletsSeason | null;
    participant: WalletsParticipant | null;
    query: ParsedWalletTransactionsQuery;
    reason: string;
    message: string;
  }): WalletTransactionsResponse {
    return {
      success: true,
      data: {
        state: input.state,
        season: input.season ? this.formatSeason(input.season) : null,
        participant: input.participant
          ? this.formatParticipant(input.participant)
          : null,
        filters: this.walletTransactionFilters(input.query),
        transactions: [],
        pagination: this.pagination(input.query, 0, 0),
        reason: input.reason,
        message: input.message,
      },
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

  private parseWalletTransactionsQuery(
    query: WalletTransactionsQuery,
  ): ParsedWalletTransactionsQuery {
    return {
      currency: this.parseCurrency(query.currency),
      direction: this.parseDirection(query.direction),
      txType: this.parseTxType(query.txType),
      limit: this.parseLimit(query.limit),
      offset: this.parseOffset(query.offset),
    };
  }

  private parseCurrency(value: string | undefined): CurrencyCode | undefined {
    const text = this.parseOptionalText(value);
    if (!text) {
      return undefined;
    }

    if (text === CurrencyCode.KRW || text === CurrencyCode.USD) {
      return text;
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'INVALID_CURRENCY',
      'Invalid currency.',
    );
  }

  private parseDirection(
    value: string | undefined,
  ): 'credit' | 'debit' | undefined {
    const text = this.parseOptionalText(value);
    if (!text) {
      return undefined;
    }

    if (text === 'credit' || text === 'debit') {
      return text;
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'INVALID_DIRECTION',
      'Invalid direction.',
    );
  }

  private parseTxType(value: string | undefined): string | undefined {
    const text = this.parseOptionalText(value);
    if (!text) {
      return undefined;
    }

    if (text.length > 64) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_TX_TYPE',
        'Invalid txType.',
      );
    }

    return text;
  }

  private walletTransactionFilters(query: ParsedWalletTransactionsQuery) {
    return {
      currency: query.currency ?? null,
      direction: query.direction ?? null,
      txType: query.txType ?? null,
    };
  }

  private walletTransactionTxTypeWhere(
    txType: string | undefined,
  ): Prisma.WalletTransactionWhereInput {
    if (!txType) {
      return {};
    }

    switch (txType) {
      case 'season_join':
        return { txType: WalletTransactionType.initial_grant };
      case 'fx_execute':
      case 'exchange':
        return {
          txType: {
            in: [
              WalletTransactionType.exchange_source,
              WalletTransactionType.exchange_target,
            ],
          },
        };
      case 'order':
      case 'order_fill':
        return {
          txType: {
            in: [WalletTransactionType.order_buy, WalletTransactionType.order_sell],
          },
        };
      default:
        return { txType: txType as WalletTransactionType };
    }
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

  private pagination(
    query: ParsedWalletTransactionsQuery,
    total: number,
    returned: number,
  ) {
    return buildPagination({
      limit: query.limit,
      offset: query.offset,
      total,
      returned,
    });
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
