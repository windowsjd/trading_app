import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  CurrencyCode,
  FxExecuteRequestStatus,
  FxRateSourceType,
  Prisma,
  SeasonStatus,
  WalletTransactionDirection,
  WalletTransactionReferenceType,
  WalletTransactionType,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
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

export type FxQuoteRequestBody = {
  fromCurrency?: unknown;
  toCurrency?: unknown;
  sourceAmount?: unknown;
};

export type FxExecuteRequestBody = FxExecuteRequestBodyLike;

export type FxExecuteSkeletonResponse = FxExecuteErrorEnvelope | unknown;

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
    netTargetAmount: string;
    sourceWalletId: string;
    targetWalletId: string;
    sourceWalletBalanceAfter: string;
    targetWalletBalanceAfter: string;
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
  constructor(private readonly prisma: PrismaService) {}

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

      const now = new Date();
      const rateSnapshot = await this.prisma.fxRateSnapshot.findFirst({
        where: {
          baseCurrency: CurrencyCode.USD,
          quoteCurrency: CurrencyCode.KRW,
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

      if (
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

      if (season.status !== SeasonStatus.active) {
        this.throwFxExecuteError(fxExecuteErrorCodes.SEASON_NOT_ACTIVE);
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
        this.throwFxExecuteError(fxExecuteErrorCodes.SEASON_NOT_JOINED);
      }

      const preflightResult = preflightFxExecuteRequest(body, {
        userId,
        seasonParticipantId: participant.id,
      });

      if (!preflightResult.ok) {
        this.throwFxExecuteError(preflightResult.errorCode);
      }

      const normalizedRequest = preflightResult.value;
      const executeNow = new Date();
      const existingCommand = await this.findFxExecuteCommandCandidate(
        userId,
        normalizedRequest.idempotencyKey,
      );

      if (existingCommand) {
        const response = mapFxExecuteOrchestrationDecisionToSkeletonResponse(
          orchestrateFxExecutePreMutation({
            body,
            context: {
              userId,
              seasonParticipantId: participant.id,
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

      const [sourceWallet, targetWallet, snapshots] = await Promise.all([
        this.findFxExecuteWalletCandidate(
          participant.id,
          normalizedRequest.fromCurrency,
        ),
        this.findFxExecuteWalletCandidate(
          participant.id,
          normalizedRequest.toCurrency,
        ),
        this.findFxExecuteSnapshotCandidates(executeNow),
      ]);

      const decision = orchestrateFxExecutePreMutation({
        body,
        context: {
          userId,
          seasonParticipantId: participant.id,
        },
        existingCommand,
        sourceWallet,
        targetWallet,
        snapshots,
        fxFeeRate: this.formatDecimal(season.fxFeeRate, 6),
        executeNow,
      });

      if (decision.action !== 'create_pending_and_execute') {
        return this.returnFxExecuteSkeletonResponseOrThrow(
          mapFxExecuteOrchestrationDecisionToSkeletonResponse(decision),
        );
      }

      return await this.executeFxWritePath({
        body,
        normalizedRequest,
        plan: decision.plan,
        executeNow,
      });
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      this.throwFxExecuteError(fxExecuteErrorCodes.INTERNAL_ERROR);
    }
  }

  executePreMutationSkeleton(
    input: FxExecuteOrchestrationInput,
  ): FxExecuteSkeletonResponse {
    return mapFxExecuteOrchestrationDecisionToSkeletonResponse(
      orchestrateFxExecutePreMutation(input),
    );
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

  private async findFxExecuteCommandCandidate(
    userId: string,
    idempotencyKey: string,
  ): Promise<FxExecuteCommandCandidate | null> {
    const command = await this.prisma.fxExecuteRequest.findUnique({
      where: {
        userId_idempotencyKey: {
          userId,
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

  private toFxExecuteCommandStatus(
    status: FxExecuteRequestStatus | string,
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

  private async findFxExecuteWalletCandidate(
    seasonParticipantId: string,
    currencyCode: FxExecuteWalletCandidate['currencyCode'],
  ): Promise<FxExecuteWalletCandidate | null> {
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
        currencyCode: true,
        balanceAmount: true,
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
    plan: FxExecutePlan;
    executeNow: Date;
  }): Promise<FxExecuteSuccessResponse> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        return this.executeFxWritePathInTransaction(tx, input);
      });
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      if (this.isUniqueConstraintError(error)) {
        const existingCommand = await this.findFxExecuteCommandCandidate(
          input.normalizedRequest.userId,
          input.normalizedRequest.idempotencyKey,
        );

        if (existingCommand) {
          const response = mapFxExecuteOrchestrationDecisionToSkeletonResponse(
            orchestrateFxExecutePreMutation({
              body: input.body,
              context: {
                userId: input.normalizedRequest.userId,
                seasonParticipantId: input.normalizedRequest.seasonParticipantId,
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
      plan: FxExecutePlan;
      executeNow: Date;
    },
  ): Promise<FxExecuteSuccessResponse> {
    const { normalizedRequest, plan, executeNow } = input;

    const command = await tx.fxExecuteRequest.create({
      data: {
        userId: normalizedRequest.userId,
        seasonParticipantId: normalizedRequest.seasonParticipantId,
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

    const sourceWallet = await this.debitSourceWalletOrThrow(tx, plan);
    const targetWallet = await this.creditTargetWalletOrThrow(tx, plan);

    const exchangeTransaction = await tx.exchangeTransaction.create({
      data: {
        seasonParticipantId: plan.seasonParticipantId,
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

  private async debitSourceWalletOrThrow(
    tx: FxExecuteTransactionClient,
    plan: FxExecutePlan,
  ): Promise<FxExecutePostUpdateWallet> {
    const debitResult = await tx.cashWallet.updateMany({
      where: {
        id: plan.sourceWalletId,
        seasonParticipantId: plan.seasonParticipantId,
        currencyCode: plan.fromCurrency,
        balanceAmount: {
          gte: plan.sourceDebitAmount,
        },
      },
      data: {
        balanceAmount: {
          decrement: plan.sourceDebitAmount,
        },
      },
    });

    if (debitResult.count !== 1) {
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
  ): Promise<FxExecutePostUpdateWallet> {
    const creditResult = await tx.cashWallet.updateMany({
      where: {
        id: plan.targetWalletId,
        seasonParticipantId: plan.seasonParticipantId,
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
      },
    });

    if (!sourceWallet) {
      this.throwFxExecuteError(fxExecuteErrorCodes.SOURCE_WALLET_NOT_FOUND);
    }

    if (
      this.toDecimal(sourceWallet.balanceAmount).lt(
        this.toDecimal(plan.sourceDebitAmount),
      )
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
    plan: FxExecutePlan;
    sourceWallet: FxExecutePostUpdateWallet;
    targetWallet: FxExecutePostUpdateWallet;
  }): FxExecuteSuccessResponse {
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
        netTargetAmount: input.plan.netTargetAmount,
        sourceWalletId: input.plan.sourceWalletId,
        targetWalletId: input.plan.targetWalletId,
        sourceWalletBalanceAfter: this.formatDecimal(
          input.sourceWallet.balanceAmount,
          8,
        ),
        targetWalletBalanceAfter: this.formatDecimal(
          input.targetWallet.balanceAmount,
          8,
        ),
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
}
