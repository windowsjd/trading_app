import {
  HttpException,
  HttpStatus,
  Injectable,
  Optional,
} from '@nestjs/common';
import {
  CurrencyCode,
  FxExecuteRequestStatus,
  FxRateSourceType,
  ParticipantStatus,
  Prisma,
  QuoteStatus,
  QuoteType,
  SeasonStatus,
  SnapshotReason,
  TradingAccountMode,
  TradingAccountStatus,
  WalletTransactionDirection,
  WalletTransactionReferenceType,
  WalletTransactionType,
} from '../generated/prisma/client';
import { buildPagination, type Pagination } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { TradingAccountAccessService } from '../trading-accounts/trading-account-access.service';
import { assertSeasonAccountFinancialScopeIntegrity } from '../trading-accounts/trading-account-financial-integrity';
import { debitAvailableCash } from '../wallets/cash-wallet-atomic';
import { assertCashWalletTradingAccountScope } from '../wallets/cash-wallet-scope';
import {
  buildFxExecuteErrorEnvelope,
  fxExecuteErrorCodes,
  fxExecuteErrorMetadata,
  type FxExecuteErrorCode,
  type FxExecuteErrorEnvelope,
} from './fx-execute-error-policy';
import type { FxExecuteCommandCandidate } from './fx-execute-idempotency-decision-policy';
import {
  orchestrateFxExecutePreMutation,
  type FxExecuteOrchestrationDecision,
  type FxExecuteOrchestrationInput,
} from './fx-execute-orchestration-policy';
import type {
  FxExecutePlan,
  FxExecuteSnapshotWithId,
  FxExecuteWalletCandidate,
} from './fx-execute-plan-policy';
import {
  preflightFxExecuteRequest,
  type NormalizedFxExecuteRequest,
  type FxExecuteRequestBodyLike,
} from './fx-execute-request-policy';
import {
  FX_USD_KRW_PROVIDER_SOURCE_PRIORITY,
  PROVIDER_FRESHNESS_THRESHOLDS_SECONDS,
  buildAdminManualFallbackDecision,
  isPositiveDecimal,
  resolveFxProviderEligibility,
  selectFreshProviderSnapshot,
  selectFreshProviderSnapshotBySourcePriority,
  type SourceDecision,
} from '../providers/source-eligibility.policy';
import {
  presentSourceDecision,
  type PublicSourceMetadata,
} from '../providers/source-metadata.presenter';
import {
  buildQuoteExpiresAt,
  computeFxQuoteRequestHash,
} from '../providers/durable-quote.policy';
import {
  calculateChangeBps,
  resolveDefaultMaxChangeBps,
} from '../providers/realtime-execution-policy';
import {
  assertSeasonExchangeable,
  SeasonLifecycleError,
} from '../seasons/season-lifecycle.policy';
import {
  calculateMaxDrawdown,
  RankingRefreshService,
} from '../ranking/ranking-refresh.service';
import { KoreaEximExchangeIngestionService } from '../providers/korea-exim/korea-exim-exchange.ingestion.service';
import { KOREA_EXIM_EXCHANGE_SOURCE_NAME } from '../providers/korea-exim/korea-exim-exchange.types';
import {
  ProviderConfigError,
  ProviderHttpError,
} from '../providers/provider.types';

export type FxQuoteRequestBody = {
  fromCurrency?: unknown;
  toCurrency?: unknown;
  sourceAmount?: unknown;
};

export type FxExecuteRequestBody = FxExecuteRequestBodyLike;

export type FxCurrentRateQuery = {
  baseCurrency?: unknown;
  quoteCurrency?: unknown;
  refresh?: unknown;
};

export type FxExchangesQuery = {
  limit?: string;
  offset?: string;
};

export type FxExecuteSkeletonResponse = unknown;

export type FxExecuteSuccessResponse = {
  success: true;
  data: {
    exchangeId: string;
    executedAt: string;
    fromCurrency: CurrencyCode;
    toCurrency: CurrencyCode;
    sourceAmount: string;
    grossTargetAmount: string;
    feeRate: string;
    feeAmount: string;
    feeCurrency: CurrencyCode;
    appliedRate: string;
    quoteId: string;
    quotedRate: string;
    executeRate: string;
    rateChangeBps: string;
    rateSource: PublicSourceMetadata | null;
    idempotencyKey: string;
    netTargetAmount: string;
    sourceWalletId: string;
    targetWalletId: string;
    sourceWalletBalanceAfter: string;
    targetWalletBalanceAfter: string;
    wallets: {
      KRW: string;
      USD: string;
    };
    fxRateSnapshotId: string;
    rateCapturedAt: string;
    rateEffectiveAt: string;
  };
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
    quoteId: string | null;
    fromCurrency: CurrencyCode;
    toCurrency: CurrencyCode;
    sourceAmount: string;
    appliedRate: string;
    grossTargetAmount: string;
    feeRate: string;
    feeAmount: string;
    feeCurrency: CurrencyCode;
    netTargetAmount: string;
    expiresAt: string | null;
    maxChangeBps: string | null;
    rateCapturedAt: string;
    rateEffectiveAt: string;
    rateSource: PublicSourceMetadata | null;
  };
};

type FxCurrentRateResponse = {
  success: true;
  data: {
    state: 'available';
    pair: 'USD/KRW';
    baseCurrency: CurrencyCode;
    quoteCurrency: CurrencyCode;
    rate: string;
    sourceType: FxRateSourceType;
    sourceName: string | null;
    effectiveAt: string;
    capturedAt: string;
    freshnessAgeSeconds: number;
    providerPriority: number | null;
    fallbackUsed: boolean;
  };
};

type ParsedFxExchangesQuery = {
  limit: number;
  offset: number;
};

type FxExchangesResponse = {
  success: true;
  data: {
    state: 'available' | 'not_joined' | 'unavailable';
    season: ReturnType<FxService['formatSeason']> | null;
    participant: ReturnType<FxService['formatParticipant']> | null;
    exchanges: Array<{
      exchangeId: string;
      fromCurrency: CurrencyCode;
      toCurrency: CurrencyCode;
      sourceAmount: string;
      grossTargetAmount: string;
      feeRate: string;
      feeAmount: string;
      feeCurrency: CurrencyCode;
      appliedRate: string;
      netTargetAmount: string;
      executedAt: string;
      rateSource: PublicSourceMetadata | null;
    }>;
    pagination: Pagination;
    reason?: string;
    message?: string;
  };
};

type ActiveSeasonRecord = {
  id: string;
  name: string;
  status: SeasonStatus;
  startAt: Date;
  endAt: Date;
  fxFeeRate: Prisma.Decimal;
};

type FxParticipantRecord = {
  id: string;
  participantStatus: ParticipantStatus;
  joinedAt: Date;
};

type FxQuoteRateSnapshot = {
  id: string;
  rate: Prisma.Decimal;
  sourceType: FxRateSourceType;
  sourceName: string | null;
  capturedAt: Date;
  effectiveAt: Date;
  sourceDecision: SourceDecision;
};

type FxExecuteRateSnapshot = {
  id: string;
  rate: Prisma.Decimal;
  sourceType: FxRateSourceType;
  sourceName: string | null;
  capturedAt: Date;
  effectiveAt: Date;
  sourceDecision: SourceDecision;
};

type FxProviderRateSnapshot = {
  id: string;
  rate: Prisma.Decimal;
  sourceType: FxRateSourceType;
  sourceName: string | null;
  capturedAt: Date;
  effectiveAt: Date;
};

const CURRENT_SEASON_STATUS_PRIORITY: readonly SeasonStatus[] = [
  SeasonStatus.active,
  SeasonStatus.upcoming,
  SeasonStatus.ended,
  SeasonStatus.settled,
];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const FX_RATE_STALE_THRESHOLD_MS = 60_000;
const EXECUTE_SKELETON_PARTICIPANT_CONTEXT =
  'execute-skeleton-participant-context-not-loaded';
const FX_EXECUTE_SNAPSHOT_CANDIDATE_LIMIT = 5;

type FxExecuteTransactionClient = Prisma.TransactionClient;

type FxExecutePostUpdateWallet = {
  id: string;
  seasonParticipantId: string;
  currencyCode: CurrencyCode;
  balanceAmount: Prisma.Decimal;
};

type ProviderFxExecutePlan = FxExecutePlan & {
  quoteId: string;
  quotedRate: string;
  executeRate: string;
  rateChangeBps: string;
  rateSource: PublicSourceMetadata | null;
  quoteRequestHash: string;
};

type FxExecuteQuoteRecord = {
  id: string;
  seasonParticipantId: string | null;
  tradingAccountId: string | null;
  status: QuoteStatus;
  fromCurrency: CurrencyCode | null;
  toCurrency: CurrencyCode | null;
  sourceAmount: Prisma.Decimal | null;
  quotedRate: Prisma.Decimal | null;
  maxChangeBps: Prisma.Decimal;
  expiresAt: Date;
  requestHash: string;
};

export function mapFxExecuteOrchestrationDecisionToSkeletonResponse(
  decision: FxExecuteOrchestrationDecision,
): FxExecuteSkeletonResponse {
  switch (decision.action) {
    case 'return_error':
      return buildFxExecuteErrorEnvelope(decision.errorCode);
    case 'replay_succeeded':
      return decision.responsePayloadJson;
    case 'create_pending_and_execute':
      return buildFxExecuteErrorEnvelope(
        fxExecuteErrorCodes.EXECUTE_WRITE_PATH_NOT_IMPLEMENTED,
      );
  }
}

@Injectable()
export class FxService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    private readonly koreaEximExchangeIngestionService?: KoreaEximExchangeIngestionService,
    @Optional()
    private readonly rankingRefreshService?: RankingRefreshService,
    @Optional()
    private readonly tradingAccountAccessService?: TradingAccountAccessService,
  ) {}

  async currentRate(
    query: FxCurrentRateQuery = {},
  ): Promise<FxCurrentRateResponse> {
    const request = this.validateCurrentRateQuery(query);
    const now = new Date();

    if (request.refresh) {
      await this.tryEnsureFreshKoreaEximUsdKrwSnapshot({
        now,
        maxAgeSeconds: PROVIDER_FRESHNESS_THRESHOLDS_SECONDS.fxUsdKrwQuote,
      });
    }

    const snapshot = await this.findCurrentUsdKrwRateSnapshot(now);
    if (!snapshot) {
      this.throwApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'FX_RATE_UNAVAILABLE',
        'FX rate is unavailable',
      );
    }

    const providerPriority = this.resolveProviderPriority(snapshot.sourceName);

    return {
      success: true,
      data: {
        state: 'available',
        pair: 'USD/KRW',
        baseCurrency: request.baseCurrency,
        quoteCurrency: request.quoteCurrency,
        rate: this.formatDecimal(snapshot.rate, 8),
        sourceType: snapshot.sourceType,
        sourceName: snapshot.sourceName,
        effectiveAt: snapshot.effectiveAt.toISOString(),
        capturedAt: snapshot.capturedAt.toISOString(),
        freshnessAgeSeconds: Math.max(
          0,
          Math.floor((now.getTime() - snapshot.capturedAt.getTime()) / 1000),
        ),
        providerPriority,
        fallbackUsed:
          snapshot.sourceType !== FxRateSourceType.provider_api ||
          providerPriority !== 1,
      },
    };
  }

  async getExchanges(
    userId: string | undefined,
    query: FxExchangesQuery = {},
  ): Promise<FxExchangesResponse> {
    if (!userId) {
      this.throwApiError(
        HttpStatus.UNAUTHORIZED,
        'UNAUTHORIZED',
        'Unauthorized',
      );
    }

    const parsedQuery = this.parseFxExchangesQuery(query);
    const season = await this.findCurrentSeasonOrNull();
    if (!season) {
      return this.emptyExchangesResponse({
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
      return this.emptyExchangesResponse({
        state: 'not_joined',
        season,
        participant: null,
        query: parsedQuery,
        reason: 'SEASON_NOT_JOINED',
        message: 'Exchange history is available after joining the season.',
      });
    }

    const where = {
      seasonParticipantId: participant.id,
    };
    const [total, exchanges] = await Promise.all([
      this.prisma.exchangeTransaction.count({ where }),
      this.prisma.exchangeTransaction.findMany({
        where,
        orderBy: [{ executedAt: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
        skip: parsedQuery.offset,
        take: parsedQuery.limit,
        select: {
          id: true,
          fromCurrency: true,
          toCurrency: true,
          sourceAmount: true,
          grossTargetAmount: true,
          feeRate: true,
          feeAmount: true,
          feeCurrency: true,
          appliedRate: true,
          netTargetAmount: true,
          executedAt: true,
          fxRateSnapshot: {
            select: {
              id: true,
              sourceType: true,
              sourceName: true,
              effectiveAt: true,
              capturedAt: true,
            },
          },
        },
      }),
    ]);

    return {
      success: true,
      data: {
        state: 'available',
        season: this.formatSeason(season),
        participant: this.formatParticipant(participant),
        exchanges: exchanges.map((exchange) =>
          this.formatExchangeItem(exchange),
        ),
        pagination: this.pagination(parsedQuery, total, exchanges.length),
      },
    };
  }

  /**
   * Account-scoped exchange history: identical row shape and ordering as the
   * legacy /fx/exchanges response, but scoped by tradingAccountId (never by
   * client-provided participant ids). Read-only — active, suspended, and
   * closed accounts are all readable by their owner.
   */
  async getExchangesForTradingAccount(
    userId: string | undefined,
    tradingAccountId: string,
    query: FxExchangesQuery = {},
  ) {
    if (!userId) {
      this.throwApiError(
        HttpStatus.UNAUTHORIZED,
        'UNAUTHORIZED',
        'Unauthorized',
      );
    }

    if (!this.tradingAccountAccessService) {
      this.throwApiError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'INTERNAL_ERROR',
        'Trading account access service unavailable',
      );
    }

    const parsedQuery = this.parseFxExchangesQuery(query);
    const account =
      await this.tradingAccountAccessService.getOwnedAccountOrThrow(
        userId,
        typeof tradingAccountId === 'string'
          ? tradingAccountId.trim()
          : tradingAccountId,
      );

    // A season account whose participant still owns unscoped/mis-scoped
    // financial rows must NOT look like a normally-empty account: fail
    // closed (repair required) instead of silently omitting history.
    await assertSeasonAccountFinancialScopeIntegrity(this.prisma, {
      tradingAccountId: account.id,
      seasonParticipantId: account.seasonParticipant?.id ?? null,
    });

    const where = {
      tradingAccountId: account.id,
    };
    const [total, exchanges] = await Promise.all([
      this.prisma.exchangeTransaction.count({ where }),
      this.prisma.exchangeTransaction.findMany({
        where,
        orderBy: [{ executedAt: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
        skip: parsedQuery.offset,
        take: parsedQuery.limit,
        select: {
          id: true,
          fromCurrency: true,
          toCurrency: true,
          sourceAmount: true,
          grossTargetAmount: true,
          feeRate: true,
          feeAmount: true,
          feeCurrency: true,
          appliedRate: true,
          netTargetAmount: true,
          executedAt: true,
          fxRateSnapshot: {
            select: {
              id: true,
              sourceType: true,
              sourceName: true,
              effectiveAt: true,
              capturedAt: true,
            },
          },
        },
      }),
    ]);

    return {
      success: true as const,
      data: {
        state: 'available' as const,
        tradingAccountId: account.id,
        exchanges: exchanges.map((exchange) =>
          this.formatExchangeItem(exchange),
        ),
        pagination: this.pagination(parsedQuery, total, exchanges.length),
      },
    };
  }

  private formatExchangeItem(exchange: {
    id: string;
    fromCurrency: CurrencyCode;
    toCurrency: CurrencyCode;
    sourceAmount: Prisma.Decimal;
    grossTargetAmount: Prisma.Decimal;
    feeRate: Prisma.Decimal;
    feeAmount: Prisma.Decimal;
    feeCurrency: CurrencyCode;
    appliedRate: Prisma.Decimal;
    netTargetAmount: Prisma.Decimal;
    executedAt: Date;
    fxRateSnapshot: Parameters<FxService['formatSnapshotSource']>[0];
  }) {
    return {
      exchangeId: exchange.id,
      fromCurrency: exchange.fromCurrency,
      toCurrency: exchange.toCurrency,
      sourceAmount: this.formatDecimal(exchange.sourceAmount, 8),
      grossTargetAmount: this.formatDecimal(exchange.grossTargetAmount, 8),
      feeRate: this.formatDecimal(exchange.feeRate, 6),
      feeAmount: this.formatDecimal(exchange.feeAmount, 8),
      feeCurrency: exchange.feeCurrency,
      appliedRate: this.formatDecimal(exchange.appliedRate, 8),
      netTargetAmount: this.formatDecimal(exchange.netTargetAmount, 8),
      executedAt: exchange.executedAt.toISOString(),
      rateSource: this.formatSnapshotSource(exchange.fxRateSnapshot),
    };
  }

  async quote(
    userId: string | undefined,
    body: FxQuoteRequestBody,
  ): Promise<FxQuoteResponse> {
    try {
      if (!userId) {
        this.throwApiError(
          HttpStatus.UNAUTHORIZED,
          'UNAUTHORIZED',
          'Unauthorized',
        );
      }

      const request = this.validateQuoteRequest(body);
      const season = await this.findCurrentSeason();
      const now = new Date();
      this.assertSeasonExchangeableForQuote(season, now);

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
          tradingAccountId: true,
        },
      });

      if (!participant) {
        this.throwApiError(
          HttpStatus.FORBIDDEN,
          'SEASON_NOT_JOINED',
          'Season is not joined',
        );
      }
      this.assertParticipantExchangeableForQuote(participant);

      return await this.createFxQuote({
        userId,
        request,
        season,
        participant,
        now,
      });
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

  /**
   * Account-scoped FX quote: identical policy/calculation as the legacy
   * season quote, but the participant is resolved from an owned trading
   * account named in the path instead of the implicit current season.
   */
  async quoteForTradingAccount(
    userId: string | undefined,
    tradingAccountId: string,
    body: FxQuoteRequestBody,
  ): Promise<FxQuoteResponse> {
    try {
      if (!userId) {
        this.throwApiError(
          HttpStatus.UNAUTHORIZED,
          'UNAUTHORIZED',
          'Unauthorized',
        );
      }

      const request = this.validateQuoteRequest(body);
      const context = await this.resolveTradingAccountFxContext(
        userId,
        tradingAccountId,
      );
      this.assertTradingAccountExchangeable(context.account);
      const now = new Date();
      this.assertSeasonExchangeableForQuote(context.season, now);
      this.assertParticipantExchangeableForQuote(context.participant);

      return await this.createFxQuote({
        userId,
        request,
        season: context.season,
        participant: context.participant,
        now,
      });
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

  private async createFxQuote(input: {
    userId: string;
    request: ReturnType<FxService['validateQuoteRequest']>;
    season: ActiveSeasonRecord;
    participant: { id: string; tradingAccountId: string | null };
    now: Date;
  }): Promise<FxQuoteResponse> {
    const { userId, request, season, participant, now } = input;

    {
      // Dual-write guard: a quote grants later execution authority, so it
      // must never be minted for a participant whose account link is
      // missing (deploy-boundary state; repair-links fixes it).
      if (!participant.tradingAccountId) {
        this.throwApiError(
          HttpStatus.INTERNAL_SERVER_ERROR,
          'TRADING_ACCOUNT_LINK_INTEGRITY',
          'Participant has no trading account link; run trading-accounts:repair-links.',
        );
      }
      const tradingAccountId = participant.tradingAccountId;

      await this.assertQuoteSourceWalletBalance({
        seasonParticipantId: participant.id,
        tradingAccountId,
        fromCurrency: request.fromCurrency,
        sourceAmount: request.sourceAmount,
      });

      const rateSnapshot = await this.findFxQuoteRateSnapshot(now);

      if (!rateSnapshot) {
        this.throwApiError(
          HttpStatus.SERVICE_UNAVAILABLE,
          'FX_RATE_UNAVAILABLE',
          'FX rate is unavailable',
        );
      }

      if (
        rateSnapshot.sourceType !== FxRateSourceType.provider_api &&
        now.getTime() - rateSnapshot.effectiveAt.getTime() >
          FX_RATE_STALE_THRESHOLD_MS
      ) {
        this.throwApiError(
          HttpStatus.SERVICE_UNAVAILABLE,
          'FX_RATE_STALE',
          'FX rate is stale',
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
      const expiresAt = buildQuoteExpiresAt(now);
      const maxChangeBps = resolveDefaultMaxChangeBps({
        quoteType: 'fx',
        baseCurrency: CurrencyCode.USD,
        quoteCurrency: CurrencyCode.KRW,
      });
      const rateSource = presentSourceDecision(rateSnapshot.sourceDecision);
      const requestHash = computeFxQuoteRequestHash({
        userId,
        seasonParticipantId: participant.id,
        fromCurrency: request.fromCurrency,
        toCurrency: request.toCurrency,
        sourceAmount: request.sourceAmount,
      });
      const durableQuote = await this.prisma.quote.create({
        data: {
          userId,
          seasonParticipantId: participant.id,
          tradingAccountId,
          quoteType: QuoteType.fx,
          status: QuoteStatus.active,
          fromCurrency: request.fromCurrency,
          toCurrency: request.toCurrency,
          sourceAmount: this.formatDecimal(request.sourceAmount, 8),
          targetAmount: this.formatDecimal(netTargetAmount, 8),
          quotedRate: this.formatDecimal(appliedRate, 8),
          fxRateSnapshotId: rateSnapshot.id,
          fxRateSourceJson: rateSource as unknown as Prisma.InputJsonValue,
          maxChangeBps: maxChangeBps.toFixed(4),
          expiresAt,
          requestHash,
        },
        select: {
          id: true,
        },
      });

      return {
        success: true,
        data: {
          quoteId: durableQuote.id,
          fromCurrency: request.fromCurrency,
          toCurrency: request.toCurrency,
          sourceAmount: this.formatDecimal(request.sourceAmount, 8),
          appliedRate: this.formatDecimal(appliedRate, 8),
          grossTargetAmount: this.formatDecimal(grossTargetAmount, 8),
          feeRate: this.formatDecimal(season.fxFeeRate, 6),
          feeAmount: this.formatDecimal(feeAmount, 8),
          feeCurrency,
          netTargetAmount: this.formatDecimal(netTargetAmount, 8),
          expiresAt: expiresAt.toISOString(),
          maxChangeBps: maxChangeBps.toFixed(4),
          rateCapturedAt: rateSnapshot.capturedAt.toISOString(),
          rateEffectiveAt: rateSnapshot.effectiveAt.toISOString(),
          rateSource,
        },
      };
    }
  }

  async execute(
    userId: string | undefined,
    body: FxExecuteRequestBody,
  ): Promise<FxExecuteSkeletonResponse> {
    try {
      if (!userId) {
        this.throwFxExecuteError(fxExecuteErrorCodes.UNAUTHORIZED);
      }

      const basicPreflightResult = preflightFxExecuteRequest(body, {
        userId,
        seasonParticipantId: EXECUTE_SKELETON_PARTICIPANT_CONTEXT,
      });

      if (!basicPreflightResult.ok) {
        this.throwFxExecuteError(basicPreflightResult.errorCode);
      }

      const season = await this.findCurrentSeason();
      const executeNow = new Date();
      this.assertSeasonExchangeableForExecute(season, executeNow);

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
          tradingAccountId: true,
        },
      });

      if (!participant) {
        this.throwFxExecuteError(fxExecuteErrorCodes.SEASON_NOT_JOINED);
      }
      this.assertParticipantExchangeableForExecute(participant);

      return await this.executeFxForContext({
        userId,
        body,
        season,
        executeNow,
        participantId: participant.id,
        // Dual-write guard: a missing account link must never spread onto
        // new financial rows (fail-closed inside executeFxForContext).
        tradingAccountId: participant.tradingAccountId,
      });
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      this.throwFxExecuteError(fxExecuteErrorCodes.INTERNAL_ERROR);
    }
  }

  /**
   * Account-scoped FX execute: same policy chain, fees, ledger writes,
   * idempotency semantics, and transaction atomicity as the legacy execute —
   * the account named in the path only replaces how the participant is
   * resolved, and idempotency is looked up per trading account.
   */
  async executeForTradingAccount(
    userId: string | undefined,
    tradingAccountId: string,
    body: FxExecuteRequestBody,
  ): Promise<FxExecuteSkeletonResponse> {
    try {
      if (!userId) {
        this.throwFxExecuteError(fxExecuteErrorCodes.UNAUTHORIZED);
      }

      const basicPreflightResult = preflightFxExecuteRequest(body, {
        userId,
        seasonParticipantId: EXECUTE_SKELETON_PARTICIPANT_CONTEXT,
      });

      if (!basicPreflightResult.ok) {
        this.throwFxExecuteError(basicPreflightResult.errorCode);
      }

      const context = await this.resolveTradingAccountFxContext(
        userId,
        tradingAccountId,
      );
      this.assertTradingAccountExchangeable(context.account);
      const executeNow = new Date();
      this.assertSeasonExchangeableForExecute(context.season, executeNow);
      this.assertParticipantExchangeableForExecute(context.participant);

      return await this.executeFxForContext({
        userId,
        body,
        season: context.season,
        executeNow,
        participantId: context.participant.id,
        tradingAccountId: context.account.id,
      });
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      this.throwFxExecuteError(fxExecuteErrorCodes.INTERNAL_ERROR);
    }
  }

  private async executeFxForContext(input: {
    userId: string;
    body: FxExecuteRequestBody;
    season: ActiveSeasonRecord;
    executeNow: Date;
    participantId: string;
    tradingAccountId: string | null;
  }): Promise<FxExecuteSkeletonResponse> {
    const { userId, body, season, executeNow, participantId } = input;

    if (!input.tradingAccountId) {
      this.throwApiError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'TRADING_ACCOUNT_LINK_INTEGRITY',
        'Participant has no trading account link; run trading-accounts:repair-links.',
      );
    }
    const tradingAccountId = input.tradingAccountId;

    const preflightResult = preflightFxExecuteRequest(body, {
      userId,
      seasonParticipantId: participantId,
    });

    if (!preflightResult.ok) {
      this.throwFxExecuteError(preflightResult.errorCode);
    }

    const normalizedRequest = preflightResult.value;
    // Idempotency is ACCOUNT-scoped for every new request (legacy and
    // account endpoints both resolve a verified account first). Legacy
    // null-scope rows written before the transition are still replayable,
    // but ONLY for the same user + same participant — never another
    // participant's (or another season's) row.
    const existingCommand = await this.findFxExecuteCommandForIdempotency({
      tradingAccountId,
      userId,
      seasonParticipantId: participantId,
      idempotencyKey: normalizedRequest.idempotencyKey,
    });

    if (existingCommand) {
      const response = mapFxExecuteOrchestrationDecisionToSkeletonResponse(
        orchestrateFxExecutePreMutation({
          body,
          context: {
            userId,
            seasonParticipantId: participantId,
          },
          existingCommand,
          sourceWallet: null,
          targetWallet: null,
          snapshots: [],
          fxFeeRate: this.formatDecimal(season.fxFeeRate, 6),
          executeNow,
        }),
      );

      return this.returnFxExecuteSkeletonResponseOrThrow(response);
    }

    const quoteId = this.parseQuoteId(body.quoteId);
    const quote = await this.findActiveFxQuoteOrThrow({
      quoteId,
      userId,
      seasonParticipantId: participantId,
      tradingAccountId,
      normalizedRequest,
      executeNow,
    });

    const [sourceWallet, targetWallet, providerSnapshot] = await Promise.all([
      this.findFxExecuteWalletCandidate(
        participantId,
        normalizedRequest.fromCurrency,
      ),
      this.findFxExecuteWalletCandidate(
        participantId,
        normalizedRequest.toCurrency,
      ),
      this.findProviderFxExecuteSnapshot(executeNow),
    ]);

    // Both wallets must be scoped to the SAME verified trading account as
    // the participant. A null scope is a repair-required deploy-boundary
    // state and a mismatch is data corruption — both fail closed with a
    // structured 500 BEFORE any balance math (never an in-request backfill).
    for (const wallet of [sourceWallet, targetWallet]) {
      if (wallet) {
        assertCashWalletTradingAccountScope(wallet, {
          seasonParticipantId: participantId,
          tradingAccountId,
        });
      }
    }

    const plan = this.buildProviderFxExecutePlan({
      normalizedRequest,
      quote,
      sourceWallet,
      targetWallet,
      fxFeeRate: this.formatDecimal(season.fxFeeRate, 6),
      providerSnapshot,
      executeNow,
    });

    return await this.executeFxWritePath({
      body,
      normalizedRequest,
      plan,
      executeNow,
      seasonId: season.id,
      tradingAccountId,
    });
  }

  executePreMutationSkeleton(
    input: FxExecuteOrchestrationInput,
  ): FxExecuteSkeletonResponse {
    return mapFxExecuteOrchestrationDecisionToSkeletonResponse(
      orchestrateFxExecutePreMutation(input),
    );
  }

  private async findCurrentSeason(): Promise<ActiveSeasonRecord> {
    const season = await this.findCurrentSeasonOrNull();
    if (season) {
      return season;
    }

    this.throwApiError(
      HttpStatus.NOT_FOUND,
      'SEASON_NOT_FOUND',
      'Season not found',
    );
  }

  private async findCurrentSeasonOrNull(): Promise<ActiveSeasonRecord | null> {
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
          fxFeeRate: true,
        },
        orderBy: this.getOrderBy(status),
      });

      if (season) {
        return season;
      }
    }

    return null;
  }

  private async findFxQuoteRateSnapshot(
    quoteAt: Date,
  ): Promise<FxQuoteRateSnapshot> {
    const providerEligibility = resolveFxProviderEligibility({
      workflow: 'fx_quote',
      baseCurrency: CurrencyCode.USD,
      quoteCurrency: CurrencyCode.KRW,
    });
    const providerSelection = providerEligibility.eligible
      ? await this.selectFreshProviderUsdKrwSnapshot({
          now: quoteAt,
          freshnessThresholdSeconds:
            providerEligibility.freshnessThresholdSeconds,
          expectedSourceNames: providerEligibility.sourceNames,
          take: 10,
        })
      : {
          state: 'not_selected' as const,
          decision: {
            selectedSourceType: null,
            selectedSourceName: null,
            selectedSnapshotId: null,
            selectedEffectiveAt: null,
            selectedCapturedAt: null,
            fallbackUsed: true,
            fallbackReason: providerEligibility.reason,
            rejectedProviderReason: null,
            freshnessAgeSeconds: null,
          },
        };

    if (providerSelection.state === 'selected') {
      return {
        ...providerSelection.snapshot,
        sourceDecision: providerSelection.decision,
      };
    }

    const fallbackSnapshot = await this.prisma.fxRateSnapshot.findFirst({
      where: {
        baseCurrency: CurrencyCode.USD,
        quoteCurrency: CurrencyCode.KRW,
        sourceType: FxRateSourceType.admin_manual,
        approvedByUserId: {
          not: null,
        },
        effectiveAt: {
          lte: quoteAt,
        },
      },
      orderBy: [
        { effectiveAt: 'desc' },
        { capturedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      select: {
        id: true,
        rate: true,
        sourceType: true,
        sourceName: true,
        capturedAt: true,
        effectiveAt: true,
      },
    });

    if (!fallbackSnapshot) {
      this.throwApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'FX_RATE_UNAVAILABLE',
        'FX rate is unavailable',
      );
    }

    return {
      ...fallbackSnapshot,
      sourceDecision: buildAdminManualFallbackDecision({
        selectedSnapshotId: fallbackSnapshot.id,
        selectedSourceName: fallbackSnapshot.sourceName,
        selectedEffectiveAt: fallbackSnapshot.effectiveAt,
        selectedCapturedAt: fallbackSnapshot.capturedAt,
        providerDecision: providerSelection.decision,
      }),
    };
  }

  private async findActiveFxQuoteOrThrow(input: {
    quoteId: string;
    userId: string;
    seasonParticipantId: string;
    tradingAccountId: string;
    normalizedRequest: NormalizedFxExecuteRequest;
    executeNow: Date;
  }): Promise<FxExecuteQuoteRecord> {
    const quote = await this.prisma.quote.findFirst({
      where: {
        id: input.quoteId,
        userId: input.userId,
        quoteType: QuoteType.fx,
      },
      select: {
        id: true,
        seasonParticipantId: true,
        tradingAccountId: true,
        status: true,
        fromCurrency: true,
        toCurrency: true,
        sourceAmount: true,
        quotedRate: true,
        maxChangeBps: true,
        expiresAt: true,
        requestHash: true,
      },
    });

    if (!quote) {
      this.throwFxExecuteError(fxExecuteErrorCodes.QUOTE_NOT_FOUND);
    }

    // Account isolation: a quote minted for a different trading account is
    // never executable here, even for the same user. Only NULL legacy quotes
    // (pre-transition rows) pass through, and those are still pinned to the
    // same participant + request hash below.
    if (
      quote.tradingAccountId !== null &&
      quote.tradingAccountId !== input.tradingAccountId
    ) {
      this.throwFxExecuteError(fxExecuteErrorCodes.QUOTE_MISMATCH);
    }

    if (quote.status !== QuoteStatus.active) {
      this.throwFxExecuteError(fxExecuteErrorCodes.QUOTE_NOT_ACTIVE);
    }

    if (input.executeNow.getTime() > quote.expiresAt.getTime()) {
      await this.prisma.quote.updateMany({
        where: {
          id: quote.id,
          status: QuoteStatus.active,
        },
        data: {
          status: QuoteStatus.expired,
        },
      });
      this.throwFxExecuteError(fxExecuteErrorCodes.QUOTE_EXPIRED);
    }

    const requestHash = computeFxQuoteRequestHash({
      userId: input.userId,
      seasonParticipantId: input.seasonParticipantId,
      fromCurrency: input.normalizedRequest.fromCurrency,
      toCurrency: input.normalizedRequest.toCurrency,
      sourceAmount: input.normalizedRequest.sourceAmount,
    });

    if (
      quote.seasonParticipantId !== input.seasonParticipantId ||
      quote.fromCurrency !== input.normalizedRequest.fromCurrency ||
      quote.toCurrency !== input.normalizedRequest.toCurrency ||
      !quote.sourceAmount ||
      this.formatDecimal(quote.sourceAmount, 8) !==
        input.normalizedRequest.sourceAmount ||
      quote.requestHash !== requestHash ||
      !quote.quotedRate
    ) {
      this.throwFxExecuteError(fxExecuteErrorCodes.QUOTE_MISMATCH);
    }

    return quote;
  }

  private async assertQuoteSourceWalletBalance(input: {
    seasonParticipantId: string;
    tradingAccountId: string;
    fromCurrency: CurrencyCode;
    sourceAmount: Prisma.Decimal;
  }): Promise<void> {
    const wallet = await this.prisma.cashWallet.findUnique({
      where: {
        seasonParticipantId_currencyCode: {
          seasonParticipantId: input.seasonParticipantId,
          currencyCode: input.fromCurrency,
        },
      },
      select: {
        id: true,
        seasonParticipantId: true,
        tradingAccountId: true,
        balanceAmount: true,
        reservedAmount: true,
      },
    });

    // Scope before balance: an unscoped/mis-scoped wallet must never be the
    // balance basis of a quote (500 repair-required/mismatch, not 409).
    if (wallet) {
      assertCashWalletTradingAccountScope(wallet, {
        seasonParticipantId: input.seasonParticipantId,
        tradingAccountId: input.tradingAccountId,
      });
    }

    if (
      !wallet ||
      this.toDecimal(wallet.balanceAmount)
        .sub(this.toDecimal(wallet.reservedAmount ?? '0'))
        .lt(input.sourceAmount)
    ) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'INSUFFICIENT_BALANCE',
        'Cash wallet balance is insufficient.',
      );
    }
  }

  private async findProviderFxExecuteSnapshot(
    executeNow: Date,
  ): Promise<FxExecuteRateSnapshot> {
    const selection = await this.selectFreshProviderUsdKrwSnapshot({
      now: executeNow,
      freshnessThresholdSeconds: 60,
      expectedSourceNames: FX_USD_KRW_PROVIDER_SOURCE_PRIORITY,
      take: FX_EXECUTE_SNAPSHOT_CANDIDATE_LIMIT,
    });

    if (selection.state === 'selected') {
      return {
        ...selection.snapshot,
        sourceDecision: selection.decision,
      };
    }

    if (selection.decision.rejectedProviderReason === 'captured_at_stale') {
      this.throwFxExecuteError(fxExecuteErrorCodes.PROVIDER_RATE_STALE);
    }

    this.throwFxExecuteError(fxExecuteErrorCodes.PROVIDER_RATE_UNAVAILABLE);
  }

  private async selectFreshProviderUsdKrwSnapshot(input: {
    now: Date;
    freshnessThresholdSeconds: number;
    expectedSourceNames: readonly string[];
    take: number;
  }) {
    let candidates = await this.findProviderUsdKrwSnapshotCandidates(
      input.take,
    );
    const primarySelection = selectFreshProviderSnapshot({
      candidates,
      expectedSourceName: KOREA_EXIM_EXCHANGE_SOURCE_NAME,
      now: input.now,
      freshnessThresholdSeconds: input.freshnessThresholdSeconds,
      isPositiveValue: (candidate) => isPositiveDecimal(candidate.rate),
    });

    if (primarySelection.state !== 'selected') {
      const refreshed = await this.tryEnsureFreshKoreaEximUsdKrwSnapshot({
        now: input.now,
        maxAgeSeconds: input.freshnessThresholdSeconds,
      });

      if (refreshed) {
        candidates = await this.findProviderUsdKrwSnapshotCandidates(
          input.take,
        );
      }
    }

    return selectFreshProviderSnapshotBySourcePriority({
      candidates,
      expectedSourceNames: input.expectedSourceNames,
      now: input.now,
      freshnessThresholdSeconds: input.freshnessThresholdSeconds,
      isPositiveValue: (candidate) => isPositiveDecimal(candidate.rate),
    });
  }

  private findProviderUsdKrwSnapshotCandidates(take: number) {
    return this.prisma.fxRateSnapshot.findMany({
      where: {
        baseCurrency: CurrencyCode.USD,
        quoteCurrency: CurrencyCode.KRW,
        sourceType: FxRateSourceType.provider_api,
      },
      orderBy: [
        { effectiveAt: 'desc' },
        { capturedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      take,
      select: {
        id: true,
        rate: true,
        sourceType: true,
        sourceName: true,
        effectiveAt: true,
        capturedAt: true,
      },
    });
  }

  private async tryEnsureFreshKoreaEximUsdKrwSnapshot(input: {
    now: Date;
    maxAgeSeconds: number;
  }): Promise<boolean> {
    if (!this.koreaEximExchangeIngestionService) {
      return false;
    }

    try {
      await this.koreaEximExchangeIngestionService.ensureFreshUsdKrwSnapshot({
        now: input.now,
        maxAgeSeconds: input.maxAgeSeconds,
      });
      return true;
    } catch (error) {
      if (
        error instanceof ProviderConfigError ||
        error instanceof ProviderHttpError
      ) {
        return false;
      }

      throw error;
    }
  }

  private async findCurrentUsdKrwRateSnapshot(
    now: Date,
  ): Promise<FxProviderRateSnapshot | null> {
    const providerCandidates =
      await this.findProviderUsdKrwSnapshotCandidates(20);
    const providerSelection = selectFreshProviderSnapshotBySourcePriority({
      candidates: providerCandidates,
      expectedSourceNames: FX_USD_KRW_PROVIDER_SOURCE_PRIORITY,
      now,
      freshnessThresholdSeconds:
        PROVIDER_FRESHNESS_THRESHOLDS_SECONDS.fxUsdKrwQuote,
      isPositiveValue: (candidate) => isPositiveDecimal(candidate.rate),
    });

    if (providerSelection.state === 'selected') {
      return providerSelection.snapshot;
    }

    return this.prisma.fxRateSnapshot.findFirst({
      where: {
        baseCurrency: CurrencyCode.USD,
        quoteCurrency: CurrencyCode.KRW,
        sourceType: FxRateSourceType.admin_manual,
        approvedByUserId: {
          not: null,
        },
        effectiveAt: {
          lte: now,
        },
      },
      orderBy: [
        { effectiveAt: 'desc' },
        { capturedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      select: {
        id: true,
        rate: true,
        sourceType: true,
        sourceName: true,
        effectiveAt: true,
        capturedAt: true,
      },
    });
  }

  private resolveProviderPriority(sourceName: string | null): number | null {
    const priorityIndex = FX_USD_KRW_PROVIDER_SOURCE_PRIORITY.findIndex(
      (item) => item === sourceName,
    );

    return priorityIndex === -1 ? null : priorityIndex + 1;
  }

  private buildProviderFxExecutePlan(input: {
    normalizedRequest: NormalizedFxExecuteRequest;
    quote: FxExecuteQuoteRecord;
    sourceWallet: FxExecuteWalletCandidate | null;
    targetWallet: FxExecuteWalletCandidate | null;
    fxFeeRate: string;
    providerSnapshot: FxExecuteRateSnapshot;
    executeNow: Date;
  }): ProviderFxExecutePlan {
    const {
      normalizedRequest,
      quote,
      sourceWallet,
      targetWallet,
      fxFeeRate,
      providerSnapshot,
    } = input;

    if (
      !sourceWallet ||
      sourceWallet.seasonParticipantId !==
        normalizedRequest.seasonParticipantId ||
      sourceWallet.currencyCode !== normalizedRequest.fromCurrency
    ) {
      this.throwFxExecuteError(fxExecuteErrorCodes.SOURCE_WALLET_NOT_FOUND);
    }

    if (
      !targetWallet ||
      targetWallet.seasonParticipantId !==
        normalizedRequest.seasonParticipantId ||
      targetWallet.currencyCode !== normalizedRequest.toCurrency
    ) {
      this.throwFxExecuteError(fxExecuteErrorCodes.TARGET_WALLET_NOT_FOUND);
    }

    if (providerSnapshot.sourceType !== FxRateSourceType.provider_api) {
      this.throwFxExecuteError(fxExecuteErrorCodes.EXECUTION_PROVIDER_REQUIRED);
    }

    const quotedRate = quote.quotedRate;
    if (!quotedRate) {
      this.throwFxExecuteError(fxExecuteErrorCodes.QUOTE_MISMATCH);
    }

    const executeRate = providerSnapshot.rate;
    const rateChangeBps = calculateChangeBps(quotedRate, executeRate);
    if (rateChangeBps.gt(quote.maxChangeBps)) {
      this.throwFxExecuteError(
        fxExecuteErrorCodes.RATE_CHANGED_REQUOTE_REQUIRED,
      );
    }

    const sourceAmount = new Prisma.Decimal(normalizedRequest.sourceAmount);
    // Spendable cash is the AVAILABLE balance: reserved cash belongs to
    // submitted limit-buy orders and must never fund an FX conversion.
    const sourceWalletAvailable = this.toDecimal(
      sourceWallet.balanceAmount,
    ).sub(this.toDecimal(sourceWallet.reservedAmount ?? '0'));
    if (sourceWalletAvailable.lt(sourceAmount)) {
      this.throwFxExecuteError(fxExecuteErrorCodes.INSUFFICIENT_BALANCE);
    }

    const grossTargetAmount =
      normalizedRequest.fromCurrency === CurrencyCode.KRW
        ? sourceAmount.div(executeRate)
        : sourceAmount.mul(executeRate);
    const feeRate = new Prisma.Decimal(fxFeeRate);
    const feeAmount = grossTargetAmount.mul(feeRate);
    const netTargetAmount = grossTargetAmount.sub(feeAmount);
    const feeCurrency = normalizedRequest.toCurrency;
    const rateSource = presentSourceDecision(providerSnapshot.sourceDecision);

    return {
      userId: normalizedRequest.userId,
      seasonParticipantId: normalizedRequest.seasonParticipantId,
      fromCurrency: normalizedRequest.fromCurrency,
      toCurrency: normalizedRequest.toCurrency,
      sourceWalletId: sourceWallet.id,
      targetWalletId: targetWallet.id,
      sourceAmount: this.formatDecimal(sourceAmount, 8),
      grossTargetAmount: this.formatDecimal(grossTargetAmount, 8),
      feeRate: this.formatDecimal(feeRate, 6),
      feeAmount: this.formatDecimal(feeAmount, 8),
      feeCurrency,
      appliedRate: this.formatDecimal(executeRate, 8),
      netTargetAmount: this.formatDecimal(netTargetAmount, 8),
      targetCreditAmount: this.formatDecimal(netTargetAmount, 8),
      sourceDebitAmount: this.formatDecimal(sourceAmount, 8),
      fxRateSnapshotId: providerSnapshot.id,
      rateCapturedAt: providerSnapshot.capturedAt,
      rateEffectiveAt: providerSnapshot.effectiveAt,
      requestHash: normalizedRequest.requestHash,
      idempotencyKey: normalizedRequest.idempotencyKey,
      quoteId: quote.id,
      quotedRate: this.formatDecimal(quotedRate, 8),
      executeRate: this.formatDecimal(executeRate, 8),
      rateChangeBps: this.formatDecimal(rateChangeBps, 4),
      rateSource,
      quoteRequestHash: quote.requestHash,
    };
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

  private validateCurrentRateQuery(query: FxCurrentRateQuery) {
    const baseCurrency = this.parseCurrentRateCurrency(
      query.baseCurrency,
      CurrencyCode.USD,
    );
    const quoteCurrency = this.parseCurrentRateCurrency(
      query.quoteCurrency,
      CurrencyCode.KRW,
    );

    if (
      baseCurrency !== CurrencyCode.USD ||
      quoteCurrency !== CurrencyCode.KRW
    ) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'UNSUPPORTED_FX_PAIR',
        'Only USD/KRW is supported.',
      );
    }

    return {
      baseCurrency,
      quoteCurrency,
      refresh: this.parseRefreshQuery(query.refresh),
    };
  }

  private parseCurrentRateCurrency(
    value: unknown,
    defaultValue: CurrencyCode,
  ): CurrencyCode | null {
    if (value === undefined || value === null || value === '') {
      return defaultValue;
    }

    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim().toUpperCase();
    if (normalized === CurrencyCode.USD) {
      return CurrencyCode.USD;
    }

    if (normalized === CurrencyCode.KRW) {
      return CurrencyCode.KRW;
    }

    return null;
  }

  private parseRefreshQuery(value: unknown): boolean {
    if (value === undefined || value === null || value === '') {
      return false;
    }

    if (value === true || value === 'true' || value === '1') {
      return true;
    }

    if (value === false || value === 'false' || value === '0') {
      return false;
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'INVALID_REFRESH',
      'refresh must be true or false',
    );
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

  private parseQuoteId(value: unknown): string {
    if (typeof value !== 'string' || value.trim() === '') {
      this.throwFxExecuteError(fxExecuteErrorCodes.QUOTE_REQUIRED);
    }

    return value.trim();
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

  private parseFxExchangesQuery(
    query: FxExchangesQuery,
  ): ParsedFxExchangesQuery {
    return {
      limit: this.parseLimit(query.limit),
      offset: this.parseOffset(query.offset),
    };
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

  private emptyExchangesResponse(input: {
    state: FxExchangesResponse['data']['state'];
    season: ActiveSeasonRecord | null;
    participant: FxParticipantRecord | null;
    query: ParsedFxExchangesQuery;
    reason: string;
    message: string;
  }): FxExchangesResponse {
    return {
      success: true,
      data: {
        state: input.state,
        season: input.season ? this.formatSeason(input.season) : null,
        participant: input.participant
          ? this.formatParticipant(input.participant)
          : null,
        exchanges: [],
        pagination: this.pagination(input.query, 0, 0),
        reason: input.reason,
        message: input.message,
      },
    };
  }

  private formatSeason(season: ActiveSeasonRecord) {
    return {
      id: season.id,
      name: season.name,
      status: season.status,
      startAt: season.startAt.toISOString(),
      endAt: season.endAt.toISOString(),
    };
  }

  private formatParticipant(participant: FxParticipantRecord) {
    return {
      id: participant.id,
      status: participant.participantStatus,
      joinedAt: participant.joinedAt.toISOString(),
    };
  }

  private pagination(
    query: ParsedFxExchangesQuery,
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

  private formatSnapshotSource(
    snapshot: {
      id: string;
      sourceType: FxRateSourceType;
      sourceName: string | null;
      effectiveAt: Date;
      capturedAt: Date;
    } | null,
  ): PublicSourceMetadata | null {
    if (!snapshot) {
      return null;
    }

    return {
      sourceType:
        snapshot.sourceType === FxRateSourceType.provider_api ||
        snapshot.sourceType === FxRateSourceType.admin_manual
          ? snapshot.sourceType
          : null,
      sourceName: snapshot.sourceName,
      snapshotId: snapshot.id,
      effectiveAt: snapshot.effectiveAt.toISOString(),
      capturedAt: snapshot.capturedAt.toISOString(),
      fallbackUsed: false,
      fallbackReason: null,
      rejectedProviderReason: null,
      freshnessAgeSeconds: null,
    };
  }

  private assertSeasonExchangeableForQuote(
    season: ActiveSeasonRecord,
    now: Date,
  ) {
    try {
      assertSeasonExchangeable(season, now);
    } catch (error) {
      if (error instanceof SeasonLifecycleError) {
        this.throwApiError(HttpStatus.CONFLICT, error.code, error.message);
      }

      throw error;
    }
  }

  private assertSeasonExchangeableForExecute(
    season: ActiveSeasonRecord,
    now: Date,
  ) {
    try {
      assertSeasonExchangeable(season, now);
    } catch (error) {
      if (error instanceof SeasonLifecycleError) {
        this.throwFxExecuteError(error.code as FxExecuteErrorCode);
      }

      throw error;
    }
  }

  private assertParticipantExchangeableForQuote(
    participant: Pick<FxParticipantRecord, 'participantStatus'>,
  ) {
    if (participant.participantStatus === ParticipantStatus.excluded) {
      this.throwApiError(
        HttpStatus.FORBIDDEN,
        'PARTICIPANT_EXCLUDED',
        'Season participant is excluded from FX.',
      );
    }

    if (participant.participantStatus !== ParticipantStatus.active) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'PARTICIPANT_NOT_ACTIVE',
        'Season participant is not active.',
      );
    }
  }

  private assertParticipantExchangeableForExecute(
    participant: Pick<FxParticipantRecord, 'participantStatus'>,
  ) {
    if (participant.participantStatus === ParticipantStatus.excluded) {
      this.throwFxExecuteError(fxExecuteErrorCodes.PARTICIPANT_EXCLUDED);
    }

    if (participant.participantStatus !== ParticipantStatus.active) {
      this.throwFxExecuteError(fxExecuteErrorCodes.PARTICIPANT_NOT_ACTIVE);
    }
  }

  /**
   * Unified idempotency lookup for NEW execute requests: the account row
   * wins; only when the account has none is a LEGACY null-scope row
   * considered — and that fallback is pinned to the same user AND the same
   * participant, so another participant's (or another season's) legacy row
   * can never be replayed. The former global (userId, idempotencyKey)
   * lookup is gone together with its unique index.
   */
  private async findFxExecuteCommandForIdempotency(input: {
    tradingAccountId: string;
    userId: string;
    seasonParticipantId: string;
    idempotencyKey: string;
  }): Promise<FxExecuteCommandCandidate | null> {
    const accountCommand = await this.findFxExecuteCommandCandidateByAccount(
      input.tradingAccountId,
      input.idempotencyKey,
    );

    if (accountCommand) {
      return accountCommand;
    }

    return this.findLegacyFxExecuteCommandCandidate(input);
  }

  /**
   * Legacy replay path: pre-transition rows carry tradingAccountId = null
   * and stay unique per (userId, idempotencyKey) via the partial unique
   * index. The participant condition keeps the fallback from ever selecting
   * a different season's row for the same user.
   */
  private async findLegacyFxExecuteCommandCandidate(input: {
    userId: string;
    seasonParticipantId: string;
    idempotencyKey: string;
  }): Promise<FxExecuteCommandCandidate | null> {
    const command = await this.prisma.fxExecuteRequest.findFirst({
      where: {
        userId: input.userId,
        seasonParticipantId: input.seasonParticipantId,
        idempotencyKey: input.idempotencyKey,
        tradingAccountId: null,
      },
      select: {
        id: true,
        idempotencyKey: true,
        requestHash: true,
        status: true,
        requestedAt: true,
        completedAt: true,
        responsePayloadJson: true,
        errorCode: true,
        errorMessage: true,
        exchangeTransactionId: true,
      },
    });

    if (!command) {
      return null;
    }

    return {
      ...command,
      status: this.toFxExecuteCommandStatus(command.status),
    };
  }

  private toFxExecuteCommandStatus(
    status: string,
  ): FxExecuteCommandCandidate['status'] {
    switch (status) {
      case FxExecuteRequestStatus.pending:
        return 'pending';
      case FxExecuteRequestStatus.succeeded:
        return 'succeeded';
      case FxExecuteRequestStatus.failed:
        return 'failed';
      default:
        return status as FxExecuteCommandCandidate['status'];
    }
  }

  private async findFxExecuteCommandCandidateByAccount(
    tradingAccountId: string,
    idempotencyKey: string,
  ): Promise<FxExecuteCommandCandidate | null> {
    const command = await this.prisma.fxExecuteRequest.findUnique({
      where: {
        tradingAccountId_idempotencyKey: {
          tradingAccountId,
          idempotencyKey,
        },
      },
      select: {
        id: true,
        idempotencyKey: true,
        requestHash: true,
        status: true,
        requestedAt: true,
        completedAt: true,
        responsePayloadJson: true,
        errorCode: true,
        errorMessage: true,
        exchangeTransactionId: true,
      },
    });

    if (!command) {
      return null;
    }

    return {
      ...command,
      status: this.toFxExecuteCommandStatus(command.status),
    };
  }

  /**
   * Resolve an owned season trading account into the FX context (account,
   * participant, season). Ownership uses the shared access layer, so a
   * nonexistent id and another user's id are the same 404.
   */
  private async resolveTradingAccountFxContext(
    userId: string,
    tradingAccountId: string,
  ): Promise<{
    account: {
      id: string;
      mode: TradingAccountMode;
      status: TradingAccountStatus;
    };
    participant: {
      id: string;
      participantStatus: ParticipantStatus;
      tradingAccountId: string;
    };
    season: ActiveSeasonRecord;
  }> {
    if (!this.tradingAccountAccessService) {
      this.throwApiError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'INTERNAL_ERROR',
        'Trading account access service unavailable',
      );
    }

    const account =
      await this.tradingAccountAccessService.getOwnedAccountOrThrow(
        userId,
        typeof tradingAccountId === 'string'
          ? tradingAccountId.trim()
          : tradingAccountId,
      );

    // General-mode FX is not implemented yet: no general wallets or funding
    // exist, so account-scoped FX is season-only for now.
    if (
      account.mode !== TradingAccountMode.season ||
      !account.seasonParticipant
    ) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'GENERAL_ACCOUNT_FX_NOT_IMPLEMENTED',
        'FX is not available for general accounts yet.',
      );
    }

    const season = await this.prisma.season.findUnique({
      where: { id: account.seasonParticipant.season.id },
      select: {
        id: true,
        name: true,
        status: true,
        startAt: true,
        endAt: true,
        fxFeeRate: true,
      },
    });

    if (!season) {
      this.throwApiError(
        HttpStatus.NOT_FOUND,
        'SEASON_NOT_FOUND',
        'Season not found',
      );
    }

    return {
      account: {
        id: account.id,
        mode: account.mode,
        status: account.status,
      },
      participant: {
        id: account.seasonParticipant.id,
        participantStatus: account.seasonParticipant.participantStatus,
        tradingAccountId: account.id,
      },
      season,
    };
  }

  /**
   * Asset-mutation gate for account-scoped quote/execute: suspended and
   * closed accounts stay readable but must never move cash. This is IN
   * ADDITION to (never instead of) the season/participant exchangeability
   * checks — TradingAccount.status alone never authorizes season trading.
   */
  private assertTradingAccountExchangeable(account: {
    status: TradingAccountStatus;
  }) {
    if (account.status !== TradingAccountStatus.active) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'TRADING_ACCOUNT_NOT_ACTIVE',
        'Trading account is not active',
      );
    }
  }

  private async findFxExecuteWalletCandidate(
    seasonParticipantId: string,
    currencyCode: FxExecuteWalletCandidate['currencyCode'],
  ): Promise<
    (FxExecuteWalletCandidate & { tradingAccountId: string | null }) | null
  > {
    return this.prisma.cashWallet.findUnique({
      where: {
        seasonParticipantId_currencyCode: {
          seasonParticipantId,
          currencyCode,
        },
      },
      select: {
        id: true,
        seasonParticipantId: true,
        tradingAccountId: true,
        currencyCode: true,
        balanceAmount: true,
        reservedAmount: true,
      },
    });
  }

  private async findFxExecuteSnapshotCandidates(
    executeNow: Date,
  ): Promise<FxExecuteSnapshotWithId[]> {
    return this.prisma.fxRateSnapshot.findMany({
      where: {
        baseCurrency: CurrencyCode.USD,
        quoteCurrency: CurrencyCode.KRW,
        sourceType: FxRateSourceType.admin_manual,
        effectiveAt: {
          lte: executeNow,
        },
      },
      orderBy: [
        { effectiveAt: 'desc' },
        { capturedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      take: FX_EXECUTE_SNAPSHOT_CANDIDATE_LIMIT,
      select: {
        id: true,
        baseCurrency: true,
        quoteCurrency: true,
        sourceType: true,
        rate: true,
        effectiveAt: true,
        capturedAt: true,
        createdAt: true,
      },
    });
  }

  private async executeFxWritePath(input: {
    body: FxExecuteRequestBody;
    normalizedRequest: NormalizedFxExecuteRequest;
    plan: ProviderFxExecutePlan;
    executeNow: Date;
    seasonId: string;
    tradingAccountId: string;
  }): Promise<FxExecuteSuccessResponse> {
    try {
      const response = await this.prisma.$transaction(async (tx) => {
        return this.executeFxWritePathInTransaction(tx, input);
      });

      this.refreshRankingAfterParticipantChange(
        input.seasonId,
        input.normalizedRequest.seasonParticipantId,
      );

      return response;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      if (this.isUniqueConstraintError(error)) {
        // Post-conflict requery uses the SAME scope rules as the original
        // lookup: the account row first, then the user+participant-pinned
        // legacy null row. Never a bare per-user query — that could replay
        // another account's command.
        const existingCommand = await this.findFxExecuteCommandForIdempotency({
          tradingAccountId: input.tradingAccountId,
          userId: input.normalizedRequest.userId,
          seasonParticipantId: input.normalizedRequest.seasonParticipantId,
          idempotencyKey: input.normalizedRequest.idempotencyKey,
        });

        if (existingCommand) {
          const response = mapFxExecuteOrchestrationDecisionToSkeletonResponse(
            orchestrateFxExecutePreMutation({
              body: input.body,
              context: {
                userId: input.normalizedRequest.userId,
                seasonParticipantId:
                  input.normalizedRequest.seasonParticipantId,
              },
              existingCommand,
              sourceWallet: null,
              targetWallet: null,
              snapshots: [],
              fxFeeRate: input.plan.feeRate,
              executeNow: input.executeNow,
            }),
          );

          return this.returnFxExecuteSkeletonResponseOrThrow(
            response,
          ) as FxExecuteSuccessResponse;
        }
      }

      this.throwFxExecuteError(fxExecuteErrorCodes.EXECUTE_TRANSACTION_FAILED);
    }
  }

  private async executeFxWritePathInTransaction(
    tx: FxExecuteTransactionClient,
    input: {
      normalizedRequest: NormalizedFxExecuteRequest;
      plan: ProviderFxExecutePlan;
      executeNow: Date;
      tradingAccountId: string;
    },
  ): Promise<FxExecuteSuccessResponse> {
    const { normalizedRequest, plan, executeNow, tradingAccountId } = input;

    // Transitional dual-write: every row below records BOTH the legacy
    // seasonParticipantId and the verified tradingAccountId.
    const command = await tx.fxExecuteRequest.create({
      data: {
        userId: normalizedRequest.userId,
        seasonParticipantId: normalizedRequest.seasonParticipantId,
        tradingAccountId,
        idempotencyKey: normalizedRequest.idempotencyKey,
        requestHash: normalizedRequest.requestHash,
        fromCurrency: normalizedRequest.fromCurrency,
        toCurrency: normalizedRequest.toCurrency,
        sourceAmount: normalizedRequest.sourceAmount,
        status: FxExecuteRequestStatus.pending,
        requestedAt: executeNow,
      },
      select: {
        id: true,
      },
    });

    // Account-conditioned consume: only THIS participant's quote flips, and
    // only when its account scope is the verified one (NULL legacy quotes
    // were already pinned to the participant + request hash upstream). A
    // quote of another account can never be consumed here.
    const quoteConsumeResult = await tx.quote.updateMany({
      where: {
        id: plan.quoteId,
        status: QuoteStatus.active,
        seasonParticipantId: plan.seasonParticipantId,
        OR: [{ tradingAccountId }, { tradingAccountId: null }],
      },
      data: {
        status: QuoteStatus.consumed,
        consumedAt: executeNow,
      },
    });

    if (quoteConsumeResult.count !== 1) {
      this.throwFxExecuteError(fxExecuteErrorCodes.QUOTE_NOT_ACTIVE);
    }

    const sourceWallet = await this.debitSourceWalletOrThrow(
      tx,
      plan,
      tradingAccountId,
    );
    const targetWallet = await this.creditTargetWalletOrThrow(
      tx,
      plan,
      tradingAccountId,
    );

    const exchangeTransaction = await tx.exchangeTransaction.create({
      data: {
        seasonParticipantId: plan.seasonParticipantId,
        tradingAccountId,
        fxRateSnapshotId: plan.fxRateSnapshotId,
        fromCurrency: plan.fromCurrency,
        toCurrency: plan.toCurrency,
        sourceAmount: plan.sourceAmount,
        grossTargetAmount: plan.grossTargetAmount,
        feeRate: plan.feeRate,
        feeAmount: plan.feeAmount,
        feeCurrency: plan.feeCurrency,
        appliedRate: plan.appliedRate,
        netTargetAmount: plan.netTargetAmount,
        executedAt: executeNow,
      },
      select: {
        id: true,
      },
    });

    await tx.walletTransaction.create({
      data: {
        seasonParticipantId: plan.seasonParticipantId,
        tradingAccountId,
        walletId: plan.sourceWalletId,
        currencyCode: plan.fromCurrency,
        direction: WalletTransactionDirection.debit,
        txType: WalletTransactionType.exchange_source,
        referenceType: WalletTransactionReferenceType.exchange_transaction,
        referenceId: exchangeTransaction.id,
        amount: plan.sourceDebitAmount,
        balanceAfter: this.formatDecimal(sourceWallet.balanceAmount, 8),
        occurredAt: executeNow,
      },
      select: {
        id: true,
      },
    });

    await tx.walletTransaction.create({
      data: {
        seasonParticipantId: plan.seasonParticipantId,
        tradingAccountId,
        walletId: plan.targetWalletId,
        currencyCode: plan.toCurrency,
        direction: WalletTransactionDirection.credit,
        txType: WalletTransactionType.exchange_target,
        referenceType: WalletTransactionReferenceType.exchange_transaction,
        referenceId: exchangeTransaction.id,
        amount: plan.targetCreditAmount,
        balanceAfter: this.formatDecimal(targetWallet.balanceAmount, 8),
        occurredAt: executeNow,
      },
      select: {
        id: true,
      },
    });

    await this.recordExchangeExecutedPortfolioSnapshot(tx, plan, executeNow);

    const responsePayloadJson = this.buildFxExecuteSuccessResponse({
      exchangeId: exchangeTransaction.id,
      executedAt: executeNow,
      plan,
      sourceWallet,
      targetWallet,
    });

    await tx.fxExecuteRequest.update({
      where: {
        id: command.id,
      },
      data: {
        status: FxExecuteRequestStatus.succeeded,
        exchangeTransactionId: exchangeTransaction.id,
        responsePayloadJson,
        completedAt: executeNow,
      },
      select: {
        id: true,
      },
    });

    return responsePayloadJson;
  }

  private async recordExchangeExecutedPortfolioSnapshot(
    tx: FxExecuteTransactionClient,
    plan: ProviderFxExecutePlan,
    capturedAt: Date,
  ): Promise<void> {
    const valuation = await this.calculateParticipantValuationInTransaction(
      tx,
      plan.seasonParticipantId,
      new Prisma.Decimal(plan.appliedRate),
      capturedAt,
    );

    await tx.equitySnapshot.create({
      data: {
        seasonParticipantId: plan.seasonParticipantId,
        totalAssetKrw: valuation.totalAssetKrw,
        returnRate: valuation.returnRate,
        krwCash: valuation.krwCash,
        usdCashKrw: valuation.usdCashKrw,
        domesticStockValueKrw: valuation.domesticStockValueKrw,
        usStockValueKrw: valuation.usStockValueKrw,
        cryptoValueKrw: valuation.cryptoValueKrw,
        snapshotReason: SnapshotReason.exchange_executed,
        capturedAt,
      },
      select: {
        id: true,
      },
    });

    const maxDrawdown =
      await this.calculateParticipantMaxDrawdownFromEquitySnapshots(
        tx,
        plan.seasonParticipantId,
      );

    await tx.seasonParticipant.update({
      where: {
        id: plan.seasonParticipantId,
      },
      data: {
        totalAssetKrw: valuation.totalAssetKrw,
        totalReturnRate: valuation.returnRate,
        maxDrawdown,
      },
      select: {
        id: true,
      },
    });
  }

  private async calculateParticipantValuationInTransaction(
    tx: FxExecuteTransactionClient,
    seasonParticipantId: string,
    usdKrwRate: Prisma.Decimal,
    valuationAt: Date,
  ): Promise<{
    totalAssetKrw: string;
    returnRate: string;
    krwCash: string;
    usdCashKrw: string;
    domesticStockValueKrw: string;
    usStockValueKrw: string;
    cryptoValueKrw: string;
  }> {
    const participant = await tx.seasonParticipant.findUnique({
      where: {
        id: seasonParticipantId,
      },
      select: {
        initialCapitalKrw: true,
        cashWallets: {
          select: {
            currencyCode: true,
            balanceAmount: true,
          },
        },
        positions: {
          where: {
            quantity: {
              gt: '0.00000000',
            },
          },
          select: {
            assetId: true,
            quantity: true,
            asset: {
              select: {
                assetType: true,
                priceCurrency: true,
              },
            },
          },
        },
      },
    });

    if (!participant) {
      throw new Error('Season participant not found.');
    }

    const krwCash = participant.cashWallets
      .filter((wallet) => wallet.currencyCode === CurrencyCode.KRW)
      .reduce(
        (sum, wallet) => sum.add(wallet.balanceAmount),
        new Prisma.Decimal(0),
      );
    const usdCash = participant.cashWallets
      .filter((wallet) => wallet.currencyCode === CurrencyCode.USD)
      .reduce(
        (sum, wallet) => sum.add(wallet.balanceAmount),
        new Prisma.Decimal(0),
      );
    const usdCashKrw = usdCash.mul(usdKrwRate);
    let domesticStockValueKrw = new Prisma.Decimal(0);
    let usStockValueKrw = new Prisma.Decimal(0);
    let cryptoValueKrw = new Prisma.Decimal(0);

    for (const position of participant.positions) {
      const latestPrice = await tx.assetPriceSnapshot.findFirst({
        where: {
          assetId: position.assetId,
          currencyCode: position.asset.priceCurrency,
          price: {
            gt: 0,
          },
          effectiveAt: {
            lte: valuationAt,
          },
        },
        orderBy: [
          { effectiveAt: 'desc' },
          { capturedAt: 'desc' },
          { createdAt: 'desc' },
        ],
        select: {
          price: true,
          priceKrw: true,
          currencyCode: true,
        },
      });

      if (!latestPrice) {
        throw new Error('Asset price unavailable.');
      }

      const priceKrw =
        latestPrice.priceKrw ??
        (latestPrice.currencyCode === CurrencyCode.KRW
          ? latestPrice.price
          : latestPrice.price.mul(usdKrwRate));
      const marketValueKrw = position.quantity.mul(priceKrw);

      switch (position.asset.assetType) {
        case 'domestic_stock':
          domesticStockValueKrw = domesticStockValueKrw.add(marketValueKrw);
          break;
        case 'us_stock':
          usStockValueKrw = usStockValueKrw.add(marketValueKrw);
          break;
        case 'crypto':
          cryptoValueKrw = cryptoValueKrw.add(marketValueKrw);
          break;
      }
    }

    const totalAssetKrw = krwCash
      .add(usdCashKrw)
      .add(domesticStockValueKrw)
      .add(usStockValueKrw)
      .add(cryptoValueKrw);
    const returnRate = totalAssetKrw
      .sub(participant.initialCapitalKrw)
      .div(participant.initialCapitalKrw)
      .mul(100);

    return {
      totalAssetKrw: this.formatDecimal(totalAssetKrw, 8),
      returnRate: this.formatDecimal(returnRate, 8),
      krwCash: this.formatDecimal(krwCash, 8),
      usdCashKrw: this.formatDecimal(usdCashKrw, 8),
      domesticStockValueKrw: this.formatDecimal(domesticStockValueKrw, 8),
      usStockValueKrw: this.formatDecimal(usStockValueKrw, 8),
      cryptoValueKrw: this.formatDecimal(cryptoValueKrw, 8),
    };
  }

  private async calculateParticipantMaxDrawdownFromEquitySnapshots(
    tx: FxExecuteTransactionClient,
    seasonParticipantId: string,
  ) {
    const snapshots = await tx.equitySnapshot.findMany({
      where: {
        seasonParticipantId,
      },
      orderBy: [{ capturedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: {
        totalAssetKrw: true,
        capturedAt: true,
      },
    });

    return this.formatDecimal(calculateMaxDrawdown(snapshots), 8);
  }

  private async debitSourceWalletOrThrow(
    tx: FxExecuteTransactionClient,
    plan: FxExecutePlan,
    tradingAccountId: string,
  ): Promise<FxExecutePostUpdateWallet> {
    // Atomic available-balance debit: reserved cash (submitted limit-buy
    // orders) can never be spent by FX, even under concurrent reservations.
    // The account id is part of the UPDATE's WHERE, so a wallet whose scope
    // changed (or was never set) after the pre-check matches 0 rows.
    const debitCount = await debitAvailableCash(tx, {
      walletId: plan.sourceWalletId,
      seasonParticipantId: plan.seasonParticipantId,
      tradingAccountId,
      currencyCode: plan.fromCurrency,
      amount: plan.sourceDebitAmount,
    });

    if (debitCount !== 1) {
      await this.throwSourceDebitFailure(tx, plan);
    }

    return this.findPostUpdateWalletOrThrow(tx, {
      walletId: plan.sourceWalletId,
      seasonParticipantId: plan.seasonParticipantId,
      currencyCode: plan.fromCurrency,
      missingErrorCode: fxExecuteErrorCodes.SOURCE_WALLET_NOT_FOUND,
    });
  }

  private async creditTargetWalletOrThrow(
    tx: FxExecuteTransactionClient,
    plan: FxExecutePlan,
    tradingAccountId: string,
  ): Promise<FxExecutePostUpdateWallet> {
    const creditResult = await tx.cashWallet.updateMany({
      where: {
        id: plan.targetWalletId,
        seasonParticipantId: plan.seasonParticipantId,
        tradingAccountId,
        currencyCode: plan.toCurrency,
      },
      data: {
        balanceAmount: {
          increment: plan.targetCreditAmount,
        },
      },
    });

    if (creditResult.count !== 1) {
      this.throwFxExecuteError(fxExecuteErrorCodes.TARGET_WALLET_NOT_FOUND);
    }

    return this.findPostUpdateWalletOrThrow(tx, {
      walletId: plan.targetWalletId,
      seasonParticipantId: plan.seasonParticipantId,
      currencyCode: plan.toCurrency,
      missingErrorCode: fxExecuteErrorCodes.TARGET_WALLET_NOT_FOUND,
    });
  }

  private async throwSourceDebitFailure(
    tx: FxExecuteTransactionClient,
    plan: FxExecutePlan,
  ): Promise<never> {
    const sourceWallet = await tx.cashWallet.findFirst({
      where: {
        id: plan.sourceWalletId,
        seasonParticipantId: plan.seasonParticipantId,
        currencyCode: plan.fromCurrency,
      },
      select: {
        balanceAmount: true,
        reservedAmount: true,
      },
    });

    if (!sourceWallet) {
      this.throwFxExecuteError(fxExecuteErrorCodes.SOURCE_WALLET_NOT_FOUND);
    }

    if (
      this.toDecimal(sourceWallet.balanceAmount)
        .sub(this.toDecimal(sourceWallet.reservedAmount ?? '0'))
        .lt(this.toDecimal(plan.sourceDebitAmount))
    ) {
      this.throwFxExecuteError(fxExecuteErrorCodes.INSUFFICIENT_BALANCE);
    }

    this.throwFxExecuteError(fxExecuteErrorCodes.CONCURRENT_WALLET_UPDATE);
  }

  private async findPostUpdateWalletOrThrow(
    tx: FxExecuteTransactionClient,
    input: {
      walletId: string;
      seasonParticipantId: string;
      currencyCode: CurrencyCode;
      missingErrorCode: FxExecuteErrorCode;
    },
  ): Promise<FxExecutePostUpdateWallet> {
    const wallet = await tx.cashWallet.findFirst({
      where: {
        id: input.walletId,
        seasonParticipantId: input.seasonParticipantId,
        currencyCode: input.currencyCode,
      },
      select: {
        id: true,
        seasonParticipantId: true,
        currencyCode: true,
        balanceAmount: true,
      },
    });

    if (!wallet) {
      this.throwFxExecuteError(input.missingErrorCode);
    }

    return wallet;
  }

  private buildFxExecuteSuccessResponse(input: {
    exchangeId: string;
    executedAt: Date;
    plan: ProviderFxExecutePlan;
    sourceWallet: FxExecutePostUpdateWallet;
    targetWallet: FxExecutePostUpdateWallet;
  }): FxExecuteSuccessResponse {
    const sourceWalletBalanceAfter = this.formatDecimal(
      input.sourceWallet.balanceAmount,
      8,
    );
    const targetWalletBalanceAfter = this.formatDecimal(
      input.targetWallet.balanceAmount,
      8,
    );
    const walletBalances = {
      [input.sourceWallet.currencyCode]: sourceWalletBalanceAfter,
      [input.targetWallet.currencyCode]: targetWalletBalanceAfter,
    } as Record<CurrencyCode, string>;

    return {
      success: true,
      data: {
        exchangeId: input.exchangeId,
        executedAt: input.executedAt.toISOString(),
        fromCurrency: input.plan.fromCurrency,
        toCurrency: input.plan.toCurrency,
        sourceAmount: input.plan.sourceAmount,
        grossTargetAmount: input.plan.grossTargetAmount,
        feeRate: input.plan.feeRate,
        feeAmount: input.plan.feeAmount,
        feeCurrency: input.plan.feeCurrency,
        appliedRate: input.plan.appliedRate,
        quoteId: input.plan.quoteId,
        quotedRate: input.plan.quotedRate,
        executeRate: input.plan.executeRate,
        rateChangeBps: input.plan.rateChangeBps,
        rateSource: input.plan.rateSource,
        idempotencyKey: input.plan.idempotencyKey,
        netTargetAmount: input.plan.netTargetAmount,
        sourceWalletId: input.plan.sourceWalletId,
        targetWalletId: input.plan.targetWalletId,
        sourceWalletBalanceAfter,
        targetWalletBalanceAfter,
        wallets: {
          KRW: walletBalances.KRW,
          USD: walletBalances.USD,
        },
        fxRateSnapshotId: input.plan.fxRateSnapshotId,
        rateCapturedAt: input.plan.rateCapturedAt.toISOString(),
        rateEffectiveAt: input.plan.rateEffectiveAt.toISOString(),
      },
    };
  }

  private toDecimal(value: Prisma.Decimal | string): Prisma.Decimal {
    return typeof value === 'string' ? new Prisma.Decimal(value) : value;
  }

  private isUniqueConstraintError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false;
    }

    return (error as { code?: unknown }).code === 'P2002';
  }

  private returnFxExecuteSkeletonResponseOrThrow(
    response: FxExecuteSkeletonResponse,
  ): FxExecuteSkeletonResponse {
    if (this.isFxExecuteErrorEnvelope(response)) {
      this.throwFxExecuteError(response.error.code);
    }

    if (response == null) {
      this.throwFxExecuteError(fxExecuteErrorCodes.INTERNAL_ERROR);
    }

    return response;
  }

  private isFxExecuteErrorEnvelope(
    value: FxExecuteSkeletonResponse,
  ): value is FxExecuteErrorEnvelope {
    if (typeof value !== 'object' || value === null) {
      return false;
    }

    const maybeEnvelope = value as Partial<FxExecuteErrorEnvelope>;

    return (
      maybeEnvelope.success === false &&
      typeof maybeEnvelope.error === 'object' &&
      maybeEnvelope.error !== null &&
      this.isFxExecuteErrorCode(maybeEnvelope.error.code)
    );
  }

  private isFxExecuteErrorCode(value: unknown): value is FxExecuteErrorCode {
    return (
      typeof value === 'string' &&
      fxExecuteErrorCodes[value as keyof typeof fxExecuteErrorCodes] === value
    );
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

  private throwApiError(
    status: HttpStatus,
    code: string,
    message: string,
  ): never {
    throw new HttpException(this.createErrorBody(code, message), status);
  }

  private throwFxExecuteError(code: FxExecuteErrorCode): never {
    const metadata = fxExecuteErrorMetadata[code];

    throw new HttpException(
      buildFxExecuteErrorEnvelope(code),
      metadata.httpStatus,
    );
  }

  private refreshRankingAfterParticipantChange(
    seasonId: string,
    seasonParticipantId: string,
  ) {
    if (!this.rankingRefreshService) {
      return;
    }

    void this.rankingRefreshService
      .refreshCurrentRankingAfterParticipantChange(
        seasonId,
        seasonParticipantId,
      )
      .catch((error) => {
        console.error(
          'Current ranking refresh after FX execution failed.',
          error,
        );
      });
  }
}
