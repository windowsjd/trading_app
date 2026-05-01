import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  CurrencyCode,
  Prisma,
  SeasonStatus,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type FxQuoteRequestBody = {
  fromCurrency?: unknown;
  toCurrency?: unknown;
  sourceAmount?: unknown;
};

type ErrorBody = {
  success: false;
  error: {
    code: string;
    message: string;
  };
};

type FxQuoteResponse = {
  success: true;
  data: {
    quoteId: null;
    fromCurrency: CurrencyCode;
    toCurrency: CurrencyCode;
    sourceAmount: string;
    appliedRate: string;
    grossTargetAmount: string;
    feeRate: string;
    feeAmount: string;
    feeCurrency: CurrencyCode;
    netTargetAmount: string;
    expiresAt: null;
    rateCapturedAt: string;
    rateEffectiveAt: string;
  };
};

type ActiveSeasonRecord = {
  id: string;
  status: SeasonStatus;
  fxFeeRate: Prisma.Decimal;
};

const CURRENT_SEASON_STATUS_PRIORITY: readonly SeasonStatus[] = [
  SeasonStatus.active,
  SeasonStatus.upcoming,
  SeasonStatus.ended,
  SeasonStatus.settled,
];

@Injectable()
export class FxService {
  constructor(private readonly prisma: PrismaService) {}

  async quote(
    userId: string | undefined,
    body: FxQuoteRequestBody,
  ): Promise<FxQuoteResponse> {
    try {
      if (!userId) {
        this.throwApiError(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', 'Unauthorized');
      }

      const request = this.validateQuoteRequest(body);
      const season = await this.findCurrentSeason();

      if (season.status !== SeasonStatus.active) {
        this.throwApiError(
          HttpStatus.CONFLICT,
          'SEASON_NOT_ACTIVE',
          'Season is not active',
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
        },
      });

      if (!participant) {
        this.throwApiError(
          HttpStatus.FORBIDDEN,
          'SEASON_NOT_JOINED',
          'Season is not joined',
        );
      }

      const rateSnapshot = await this.prisma.fxRateSnapshot.findFirst({
        where: {
          baseCurrency: CurrencyCode.USD,
          quoteCurrency: CurrencyCode.KRW,
          effectiveAt: {
            lte: new Date(),
          },
        },
        orderBy: [
          { effectiveAt: 'desc' },
          { capturedAt: 'desc' },
          { createdAt: 'desc' },
        ],
        select: {
          rate: true,
          capturedAt: true,
          effectiveAt: true,
        },
      });

      if (!rateSnapshot) {
        this.throwApiError(
          HttpStatus.SERVICE_UNAVAILABLE,
          'FX_RATE_UNAVAILABLE',
          'FX rate is unavailable',
        );
      }

      const appliedRate = rateSnapshot.rate;
      const grossTargetAmount =
        request.fromCurrency === CurrencyCode.KRW
          ? request.sourceAmount.div(appliedRate)
          : request.sourceAmount.mul(appliedRate);
      const feeAmount = grossTargetAmount.mul(season.fxFeeRate);
      const netTargetAmount = grossTargetAmount.sub(feeAmount);
      const feeCurrency =
        request.fromCurrency === CurrencyCode.KRW
          ? CurrencyCode.USD
          : CurrencyCode.KRW;

      return {
        success: true,
        data: {
          quoteId: null,
          fromCurrency: request.fromCurrency,
          toCurrency: request.toCurrency,
          sourceAmount: this.formatDecimal(request.sourceAmount, 8),
          appliedRate: this.formatDecimal(appliedRate, 8),
          grossTargetAmount: this.formatDecimal(grossTargetAmount, 8),
          feeRate: this.formatDecimal(season.fxFeeRate, 6),
          feeAmount: this.formatDecimal(feeAmount, 8),
          feeCurrency,
          netTargetAmount: this.formatDecimal(netTargetAmount, 8),
          expiresAt: null,
          rateCapturedAt: rateSnapshot.capturedAt.toISOString(),
          rateEffectiveAt: rateSnapshot.effectiveAt.toISOString(),
        },
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      this.throwApiError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'INTERNAL_ERROR',
        'Internal server error',
      );
    }
  }

  private async findCurrentSeason(): Promise<ActiveSeasonRecord> {
    for (const status of CURRENT_SEASON_STATUS_PRIORITY) {
      const season = await this.prisma.season.findFirst({
        where: {
          status,
        },
        select: {
          id: true,
          status: true,
          fxFeeRate: true,
        },
        orderBy: this.getOrderBy(status),
      });

      if (season) {
        return season;
      }
    }

    this.throwApiError(
      HttpStatus.NOT_FOUND,
      'SEASON_NOT_FOUND',
      'Season not found',
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

  private validateQuoteRequest(body: FxQuoteRequestBody) {
    const fromCurrency = this.parseCurrency(body.fromCurrency);
    const toCurrency = this.parseCurrency(body.toCurrency);

    if (!fromCurrency || !toCurrency || fromCurrency === toCurrency) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_CURRENCY_PAIR',
        'Invalid currency pair',
      );
    }

    const sourceAmount = this.parsePositiveDecimal(body.sourceAmount);

    return {
      fromCurrency,
      toCurrency,
      sourceAmount,
    };
  }

  private parseCurrency(value: unknown): CurrencyCode | null {
    if (value === CurrencyCode.KRW || value === CurrencyCode.USD) {
      return value;
    }

    return null;
  }

  private parsePositiveDecimal(value: unknown): Prisma.Decimal {
    if (typeof value !== 'string' || value.trim() === '') {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_AMOUNT',
        'Invalid amount',
      );
    }

    try {
      const decimal = new Prisma.Decimal(value);

      if (!decimal.isFinite() || decimal.lte(0)) {
        this.throwApiError(
          HttpStatus.BAD_REQUEST,
          'INVALID_AMOUNT',
          'Invalid amount',
        );
      }

      return decimal;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_AMOUNT',
        'Invalid amount',
      );
    }
  }

  private formatDecimal(value: Prisma.Decimal, scale: number) {
    return value.toFixed(scale);
  }

  private createErrorBody(code: string, message: string): ErrorBody {
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
