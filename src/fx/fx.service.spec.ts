jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    CurrencyCode: {
      KRW: 'KRW',
      USD: 'USD',
    },
    FxRateSourceType: {
      official_batch: 'official_batch',
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
    },
    FxExecuteRequestStatus: {
      pending: 'pending',
      succeeded: 'succeeded',
      failed: 'failed',
    },
    QuoteStatus: {
      active: 'active',
      consumed: 'consumed',
      expired: 'expired',
      canceled: 'canceled',
    },
    QuoteType: {
      fx: 'fx',
      order: 'order',
    },
    WalletTransactionDirection: {
      credit: 'credit',
      debit: 'debit',
    },
    WalletTransactionReferenceType: {
      season_join: 'season_join',
      exchange_transaction: 'exchange_transaction',
      order: 'order',
      manual_adjustment: 'manual_adjustment',
      settlement: 'settlement',
    },
    WalletTransactionType: {
      initial_grant: 'initial_grant',
      exchange_source: 'exchange_source',
      exchange_target: 'exchange_target',
      order_buy: 'order_buy',
      order_sell: 'order_sell',
      fee: 'fee',
      adjustment: 'adjustment',
      settlement: 'settlement',
    },
    Prisma: {
      Decimal,
    },
    PrismaClient: class PrismaClient {},
    SeasonStatus: {
      active: 'active',
      upcoming: 'upcoming',
      ended: 'ended',
      settled: 'settled',
    },
  };
});

import { HttpException } from '@nestjs/common';
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
import {
  FxService,
  mapFxExecuteOrchestrationDecisionToSkeletonResponse,
} from './fx.service';
import { fxExecuteErrorMetadata } from './fx-execute-error-policy';
import type { FxExecuteOrchestrationDecision } from './fx-execute-orchestration-policy';
import {
  preflightFxExecuteRequest,
  type FxExecuteRequestBodyLike,
} from './fx-execute-request-policy';
import { computeFxQuoteRequestHash } from '../providers/durable-quote.policy';

const now = new Date('2026-05-01T00:01:00.000Z');
const capturedAt = new Date('2026-05-01T00:00:30.000Z');
const freshEffectiveAt = new Date('2026-05-01T00:00:30.000Z');
const thresholdEffectiveAt = new Date('2026-05-01T00:00:00.000Z');
const staleEffectiveAt = new Date('2026-04-30T23:59:59.999Z');
const stalePendingRequestedAt = new Date('2026-04-30T23:58:59.999Z');
const createdAt = new Date('2026-05-01T00:00:20.000Z');

describe('FxService', () => {
  const createPrisma = () => {
    const prisma = {
      $transaction: jest.fn(),
      season: {
        findFirst: jest.fn(),
      },
      seasonParticipant: {
        findUnique: jest.fn(),
      },
      cashWallet: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      fxRateSnapshot: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      exchangeTransaction: {
        create: jest.fn(),
      },
      walletTransaction: {
        create: jest.fn(),
      },
      fxExecuteRequest: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      quote: {
        create: jest.fn().mockResolvedValue({ id: 'quote-fx-1' }),
        findFirst: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      equitySnapshot: {
        create: jest.fn(),
      },
    };

    prisma.$transaction.mockImplementation(async (callback) =>
      callback(prisma),
    );

    return prisma;
  };

  const getErrorCode = (error: unknown) => {
    const response = (error as HttpException).getResponse() as {
      error: { code: string };
    };

    return response.error.code;
  };

  const getErrorResponse = (error: unknown) =>
    (error as HttpException).getResponse() as {
      success: false;
      error: { code: string; message: string };
    };

  const expectErrorCode = async (promise: Promise<unknown>, code: string) => {
    await expect(promise).rejects.toBeInstanceOf(HttpException);

    try {
      await promise;
    } catch (error) {
      expect(getErrorCode(error)).toBe(code);
    }
  };

  const expectExecuteErrorCode = async (
    promise: Promise<unknown>,
    code: string,
  ) => {
    await expect(promise).rejects.toBeInstanceOf(HttpException);

    try {
      await promise;
    } catch (error) {
      expect(getErrorResponse(error)).toEqual({
        success: false,
        error: {
          code,
          message:
            fxExecuteErrorMetadata[code as keyof typeof fxExecuteErrorMetadata]
              .defaultMessage,
        },
      });
      expect((error as HttpException).getStatus()).toBe(
        fxExecuteErrorMetadata[code as keyof typeof fxExecuteErrorMetadata]
          .httpStatus,
      );
    }
  };

  const expectNoExecuteWrites = (prisma: ReturnType<typeof createPrisma>) => {
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.cashWallet.update).not.toHaveBeenCalled();
    expect(prisma.cashWallet.updateMany).not.toHaveBeenCalled();
    expect(prisma.exchangeTransaction.create).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(prisma.fxExecuteRequest.create).not.toHaveBeenCalled();
    expect(prisma.fxExecuteRequest.update).not.toHaveBeenCalled();
    expect(prisma.quote.updateMany).not.toHaveBeenCalled();
    expect(prisma.equitySnapshot.create).not.toHaveBeenCalled();
  };

  const expectNoExecutePlanReads = (
    prisma: ReturnType<typeof createPrisma>,
  ) => {
    expect(prisma.quote.findFirst).not.toHaveBeenCalled();
    expect(prisma.cashWallet.findUnique).not.toHaveBeenCalled();
    expect(prisma.fxRateSnapshot.findMany).not.toHaveBeenCalled();
  };

  const expectExecutePlanReads = (prisma: ReturnType<typeof createPrisma>) => {
    expect(prisma.fxExecuteRequest.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.quote.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.cashWallet.findUnique).toHaveBeenCalledTimes(2);
    expect(prisma.fxRateSnapshot.findMany).toHaveBeenCalledTimes(1);
  };

  const createService = () => {
    const prisma = createPrisma();
    const service = new FxService(prisma as never);

    return { prisma, service };
  };

  const mockActiveSeason = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.season.findFirst.mockResolvedValueOnce({
      id: 'season-1',
      status: SeasonStatus.active,
      fxFeeRate: new Prisma.Decimal('0.001000'),
    });
  };

  const mockJoinedParticipant = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce({
      id: 'participant-1',
    });
  };

  const getExecuteRequestHash = (
    body: FxExecuteRequestBodyLike,
    seasonParticipantId = 'participant-1',
  ) => {
    const result = preflightFxExecuteRequest(body, {
      userId: 'user-1',
      seasonParticipantId,
    });

    if (!result.ok) {
      throw new Error(`invalid execute fixture: ${result.errorCode}`);
    }

    return result.value.requestHash;
  };

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const mockApprovedRateSnapshot = (
    prisma: ReturnType<typeof createPrisma>,
    effectiveAt = freshEffectiveAt,
  ) => {
    prisma.fxRateSnapshot.findFirst.mockResolvedValueOnce({
      id: 'fx-admin-1',
      rate: new Prisma.Decimal('1350.00000000'),
      sourceType: FxRateSourceType.admin_manual,
      sourceName: 'manual-approved',
      capturedAt,
      effectiveAt,
    });
  };

  it('rejects invalid currency pair', async () => {
    const { prisma, service } = createService();

    await expectErrorCode(
      service.quote('user-1', {
        fromCurrency: 'KRW',
        toCurrency: 'KRW',
        sourceAmount: '1000',
      }),
      'INVALID_CURRENCY_PAIR',
    );
    expect(prisma.season.findFirst).not.toHaveBeenCalled();
  });

  it('rejects invalid amount', async () => {
    const { prisma, service } = createService();

    await expectErrorCode(
      service.quote('user-1', {
        fromCurrency: 'KRW',
        toCurrency: 'USD',
        sourceAmount: '0',
      }),
      'INVALID_AMOUNT',
    );
    expect(prisma.season.findFirst).not.toHaveBeenCalled();
  });

  it('rejects when there is no season', async () => {
    const { prisma, service } = createService();
    prisma.season.findFirst.mockResolvedValue(null);

    await expectErrorCode(
      service.quote('user-1', {
        fromCurrency: 'KRW',
        toCurrency: 'USD',
        sourceAmount: '1000',
      }),
      'SEASON_NOT_FOUND',
    );
  });

  it('rejects when current season is not active', async () => {
    const { prisma, service } = createService();
    prisma.season.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'season-1',
      status: SeasonStatus.upcoming,
      fxFeeRate: new Prisma.Decimal('0.001000'),
    });

    await expectErrorCode(
      service.quote('user-1', {
        fromCurrency: 'KRW',
        toCurrency: 'USD',
        sourceAmount: '1000',
      }),
      'SEASON_NOT_ACTIVE',
    );
  });

  it('rejects when user has not joined the active season', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(null);

    await expectErrorCode(
      service.quote('user-1', {
        fromCurrency: 'KRW',
        toCurrency: 'USD',
        sourceAmount: '1000',
      }),
      'SEASON_NOT_JOINED',
    );
  });

  it('rejects when no approved rate snapshot is available', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoinedParticipant(prisma);
    prisma.fxRateSnapshot.findFirst.mockResolvedValueOnce(null);

    await expectErrorCode(
      service.quote('user-1', {
        fromCurrency: 'KRW',
        toCurrency: 'USD',
        sourceAmount: '1000',
      }),
      'FX_RATE_UNAVAILABLE',
    );
  });

  it('selects the latest eligible USD/KRW rate snapshot', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoinedParticipant(prisma);
    mockApprovedRateSnapshot(prisma);

    await service.quote('user-1', {
      fromCurrency: 'KRW',
      toCurrency: 'USD',
      sourceAmount: '135000',
    });

    expect(prisma.fxRateSnapshot.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          baseCurrency: CurrencyCode.USD,
          quoteCurrency: CurrencyCode.KRW,
          sourceType: FxRateSourceType.admin_manual,
          effectiveAt: {
            lte: now,
          },
        }),
        orderBy: [
          { effectiveAt: 'desc' },
          { capturedAt: 'desc' },
          { createdAt: 'desc' },
        ],
        select: expect.objectContaining({
          rate: true,
          capturedAt: true,
          effectiveAt: true,
        }),
      }),
    );
    expect(
      prisma.fxRateSnapshot.findFirst.mock.calls[0][0].where.effectiveAt.lte,
    ).toEqual(now);
    expect(prisma.quote.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          quoteType: 'fx',
          status: 'active',
          userId: 'user-1',
          seasonParticipantId: 'participant-1',
          fromCurrency: CurrencyCode.KRW,
          toCurrency: CurrencyCode.USD,
          sourceAmount: '135000.00000000',
          targetAmount: '99.90000000',
          quotedRate: '1350.00000000',
          fxRateSnapshotId: 'fx-admin-1',
          maxChangeBps: '30.0000',
          expiresAt: new Date('2026-05-01T00:01:10.000Z'),
          requestHash: expect.any(String),
          fxRateSourceJson: expect.objectContaining({
            sourceType: 'admin_manual',
            sourceName: 'manual-approved',
            snapshotId: 'fx-admin-1',
          }),
        }),
      }),
    );
  });

  it('uses fresh provider_api exchange_rate_api for quote before admin_manual fallback', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoinedParticipant(prisma);
    prisma.fxRateSnapshot.findMany.mockResolvedValueOnce([
      {
        id: 'provider-fx-1',
        rate: new Prisma.Decimal('1400.00000000'),
        sourceType: FxRateSourceType.provider_api,
        sourceName: 'exchange_rate_api',
        capturedAt,
        effectiveAt: staleEffectiveAt,
      },
    ]);

    await expect(
      service.quote('user-1', {
        fromCurrency: 'KRW',
        toCurrency: 'USD',
        sourceAmount: '140000',
      }),
    ).resolves.toMatchObject({
      success: true,
      data: {
        appliedRate: '1400.00000000',
        rateEffectiveAt: staleEffectiveAt.toISOString(),
        rateSource: {
          sourceType: 'provider_api',
          sourceName: 'exchange_rate_api',
          snapshotId: 'provider-fx-1',
          fallbackUsed: false,
          fallbackReason: null,
          rejectedProviderReason: null,
        },
      },
    });
    expect(prisma.fxRateSnapshot.findFirst).not.toHaveBeenCalled();
  });

  it('returns admin_manual fallback metadata when quote provider is stale', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoinedParticipant(prisma);
    prisma.fxRateSnapshot.findMany.mockResolvedValueOnce([
      {
        id: 'provider-fx-stale',
        rate: new Prisma.Decimal('1400.00000000'),
        sourceType: FxRateSourceType.provider_api,
        sourceName: 'exchange_rate_api',
        capturedAt: new Date('2026-04-30T23:55:59.000Z'),
        effectiveAt: new Date('2026-04-30T23:55:59.000Z'),
      },
    ]);
    mockApprovedRateSnapshot(prisma);

    await expect(
      service.quote('user-1', {
        fromCurrency: 'KRW',
        toCurrency: 'USD',
        sourceAmount: '135000',
      }),
    ).resolves.toMatchObject({
      success: true,
      data: {
        appliedRate: '1350.00000000',
        rateSource: {
          sourceType: 'admin_manual',
          sourceName: 'manual-approved',
          snapshotId: 'fx-admin-1',
          fallbackUsed: true,
          fallbackReason: 'provider_rejected',
          rejectedProviderReason: 'captured_at_stale',
          freshnessAgeSeconds: 301,
        },
      },
    });
  });

  it('returns admin_manual fallback metadata when quote provider is missing', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoinedParticipant(prisma);
    mockApprovedRateSnapshot(prisma);

    await expect(
      service.quote('user-1', {
        fromCurrency: 'KRW',
        toCurrency: 'USD',
        sourceAmount: '135000',
      }),
    ).resolves.toMatchObject({
      success: true,
      data: {
        rateSource: {
          sourceType: 'admin_manual',
          fallbackUsed: true,
          fallbackReason: 'provider_missing',
          rejectedProviderReason: null,
        },
      },
    });
  });

  it('returns wrong-source fallback metadata when quote provider sourceName is rejected', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoinedParticipant(prisma);
    prisma.fxRateSnapshot.findMany.mockResolvedValueOnce([
      {
        id: 'provider-fx-wrong-source',
        rate: new Prisma.Decimal('1400.00000000'),
        sourceType: FxRateSourceType.provider_api,
        sourceName: 'unexpected_provider',
        capturedAt,
        effectiveAt: freshEffectiveAt,
      },
    ]);
    mockApprovedRateSnapshot(prisma);

    await expect(
      service.quote('user-1', {
        fromCurrency: 'KRW',
        toCurrency: 'USD',
        sourceAmount: '135000',
      }),
    ).resolves.toMatchObject({
      success: true,
      data: {
        rateSource: {
          sourceType: 'admin_manual',
          fallbackUsed: true,
          fallbackReason: 'provider_rejected',
          rejectedProviderReason: 'source_name_mismatch',
        },
      },
    });
  });

  it('rejects quote when provider_api is rejected and no admin_manual fallback exists', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoinedParticipant(prisma);
    prisma.fxRateSnapshot.findMany.mockResolvedValueOnce([
      {
        id: 'provider-fx-invalid',
        rate: new Prisma.Decimal('1400.00000000'),
        sourceType: FxRateSourceType.provider_api,
        sourceName: 'unexpected_provider',
        capturedAt,
        effectiveAt: freshEffectiveAt,
      },
    ]);
    prisma.fxRateSnapshot.findFirst.mockImplementationOnce(async (args) => {
      expect(args.where.sourceType).toBe(FxRateSourceType.admin_manual);
      return null;
    });

    await expectErrorCode(
      service.quote('user-1', {
        fromCurrency: 'KRW',
        toCurrency: 'USD',
        sourceAmount: '1000',
      }),
      'FX_RATE_UNAVAILABLE',
    );
  });

  it('rejects when selected rate snapshot is stale', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoinedParticipant(prisma);
    mockApprovedRateSnapshot(prisma, staleEffectiveAt);

    await expectErrorCode(
      service.quote('user-1', {
        fromCurrency: 'KRW',
        toCurrency: 'USD',
        sourceAmount: '135000',
      }),
      'FX_RATE_STALE',
    );
    expect(prisma.exchangeTransaction.create).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(prisma.fxExecuteRequest.create).not.toHaveBeenCalled();
    expect(prisma.equitySnapshot.create).not.toHaveBeenCalled();
  });

  it('accepts a rate snapshot exactly at the 60 second threshold', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoinedParticipant(prisma);
    mockApprovedRateSnapshot(prisma, thresholdEffectiveAt);

    await expect(
      service.quote('user-1', {
        fromCurrency: 'KRW',
        toCurrency: 'USD',
        sourceAmount: '135000',
      }),
    ).resolves.toMatchObject({
      success: true,
      data: {
        rateEffectiveAt: thresholdEffectiveAt.toISOString(),
      },
    });
  });

  it('calculates KRW to USD quote', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoinedParticipant(prisma);
    mockApprovedRateSnapshot(prisma);

    await expect(
      service.quote('user-1', {
        fromCurrency: 'KRW',
        toCurrency: 'USD',
        sourceAmount: '135000',
      }),
    ).resolves.toEqual({
      success: true,
      data: {
        quoteId: 'quote-fx-1',
        fromCurrency: CurrencyCode.KRW,
        toCurrency: CurrencyCode.USD,
        sourceAmount: '135000.00000000',
        appliedRate: '1350.00000000',
        grossTargetAmount: '100.00000000',
        feeRate: '0.001000',
        feeAmount: '0.10000000',
        feeCurrency: CurrencyCode.USD,
        netTargetAmount: '99.90000000',
        expiresAt: '2026-05-01T00:01:10.000Z',
        maxChangeBps: '30.0000',
        rateCapturedAt: capturedAt.toISOString(),
        rateEffectiveAt: freshEffectiveAt.toISOString(),
        rateSource: {
          sourceType: 'admin_manual',
          sourceName: 'manual-approved',
          snapshotId: 'fx-admin-1',
          effectiveAt: freshEffectiveAt.toISOString(),
          capturedAt: capturedAt.toISOString(),
          fallbackUsed: true,
          fallbackReason: 'provider_missing',
          rejectedProviderReason: null,
          freshnessAgeSeconds: null,
        },
      },
    });
  });

  it('calculates USD to KRW quote', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoinedParticipant(prisma);
    mockApprovedRateSnapshot(prisma);

    await expect(
      service.quote('user-1', {
        fromCurrency: 'USD',
        toCurrency: 'KRW',
        sourceAmount: '100',
      }),
    ).resolves.toMatchObject({
      success: true,
      data: {
        fromCurrency: CurrencyCode.USD,
        toCurrency: CurrencyCode.KRW,
        sourceAmount: '100.00000000',
        appliedRate: '1350.00000000',
        grossTargetAmount: '135000.00000000',
        feeRate: '0.001000',
        feeAmount: '135.00000000',
        feeCurrency: CurrencyCode.KRW,
        netTargetAmount: '134865.00000000',
        rateCapturedAt: capturedAt.toISOString(),
        rateEffectiveAt: freshEffectiveAt.toISOString(),
      },
    });
  });

  describe('execute skeleton', () => {
    const validExecuteBody = {
      fromCurrency: 'KRW',
      toCurrency: 'USD',
      sourceAmount: '1000',
      idempotencyKey: 'idempotency-key-1',
      quoteId: 'quote-fx-1',
    };
    const executeSnapshot = {
      id: 'fx-snapshot-1',
      baseCurrency: CurrencyCode.USD,
      quoteCurrency: CurrencyCode.KRW,
      sourceType: FxRateSourceType.provider_api,
      sourceName: 'exchange_rate_api',
      rate: new Prisma.Decimal('1350.00000000'),
      effectiveAt: freshEffectiveAt,
      capturedAt,
      createdAt,
    };
    const sourceWallet = {
      id: 'source-wallet-1',
      seasonParticipantId: 'participant-1',
      currencyCode: CurrencyCode.KRW,
      balanceAmount: new Prisma.Decimal('1000.00000000'),
    };
    const targetWallet = {
      id: 'target-wallet-1',
      seasonParticipantId: 'participant-1',
      currencyCode: CurrencyCode.USD,
      balanceAmount: new Prisma.Decimal('0.00000000'),
    };
    const storedSucceededPayload = {
      success: true,
      data: {
        exchangeId: 'exchange-1',
        rate: '1350.00000000',
      },
    };
    const sourceWalletAfterDebit = {
      ...sourceWallet,
      balanceAmount: new Prisma.Decimal('0.00000000'),
    };
    const targetWalletAfterCredit = {
      ...targetWallet,
      balanceAmount: new Prisma.Decimal('0.74000000'),
    };
    const activeFxQuote = {
      id: 'quote-fx-1',
      seasonParticipantId: 'participant-1',
      status: 'active',
      fromCurrency: CurrencyCode.KRW,
      toCurrency: CurrencyCode.USD,
      sourceAmount: new Prisma.Decimal('1000.00000000'),
      quotedRate: new Prisma.Decimal('1350.00000000'),
      maxChangeBps: new Prisma.Decimal('30.0000'),
      expiresAt: new Date('2026-05-01T00:01:10.000Z'),
      requestHash: computeFxQuoteRequestHash({
        userId: 'user-1',
        seasonParticipantId: 'participant-1',
        fromCurrency: CurrencyCode.KRW,
        toCurrency: CurrencyCode.USD,
        sourceAmount: '1000.00000000',
      }),
    };

    const mockExecuteReadCandidates = (
      prisma: ReturnType<typeof createPrisma>,
      overrides: {
        existingCommand?: unknown;
        quote?: unknown;
        sourceWallet?: unknown;
        targetWallet?: unknown;
        snapshots?: unknown[];
      } = {},
    ) => {
      const hasOverride = (key: keyof typeof overrides) =>
        Object.prototype.hasOwnProperty.call(overrides, key);

      prisma.fxExecuteRequest.findUnique.mockResolvedValueOnce(
        hasOverride('existingCommand') ? overrides.existingCommand : null,
      );
      prisma.quote.findFirst.mockResolvedValueOnce(
        hasOverride('quote') ? overrides.quote : activeFxQuote,
      );
      prisma.cashWallet.findUnique
        .mockResolvedValueOnce(
          hasOverride('sourceWallet') ? overrides.sourceWallet : sourceWallet,
        )
        .mockResolvedValueOnce(
          hasOverride('targetWallet') ? overrides.targetWallet : targetWallet,
        );
      prisma.fxRateSnapshot.findMany.mockResolvedValueOnce(
        hasOverride('snapshots') ? overrides.snapshots : [executeSnapshot],
      );
    };

    const buildExistingCommand = (
      status: string,
      overrides: Record<string, unknown> = {},
    ) => ({
      id: 'command-1',
      idempotencyKey: validExecuteBody.idempotencyKey,
      requestHash: getExecuteRequestHash(validExecuteBody),
      status,
      requestedAt: capturedAt,
      completedAt: null,
      responsePayloadJson: null,
      errorCode: null,
      errorMessage: null,
      exchangeTransactionId: null,
      ...overrides,
    });

    const mockSuccessfulWritePath = (
      prisma: ReturnType<typeof createPrisma>,
    ) => {
      prisma.fxExecuteRequest.create.mockResolvedValueOnce({
        id: 'command-1',
      });
      prisma.quote.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.cashWallet.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 });
      prisma.cashWallet.findFirst
        .mockResolvedValueOnce(sourceWalletAfterDebit)
        .mockResolvedValueOnce(targetWalletAfterCredit);
      prisma.exchangeTransaction.create.mockResolvedValueOnce({
        id: 'exchange-1',
      });
      prisma.walletTransaction.create
        .mockResolvedValueOnce({ id: 'wallet-tx-source' })
        .mockResolvedValueOnce({ id: 'wallet-tx-target' });
      prisma.fxExecuteRequest.update.mockResolvedValueOnce({
        id: 'command-1',
      });
    };

    type AtomicFailureStep =
      | 'source-debit'
      | 'target-credit'
      | 'exchange'
      | 'source-ledger'
      | 'target-ledger'
      | 'finalization';

    const mockAtomicWritePathFailure = (
      prisma: ReturnType<typeof createPrisma>,
      failAt: AtomicFailureStep,
    ) => {
      const committedWrites: string[] = [];
      const rolledBackWrites: string[][] = [];

      prisma.$transaction.mockImplementationOnce(async (callback) => {
        const stagedWrites: string[] = [];
        let walletUpdateCallCount = 0;
        let walletFindCallCount = 0;
        let ledgerCreateCallCount = 0;

        const stage = (writeName: string) => {
          stagedWrites.push(writeName);
        };

        const failIf = (step: AtomicFailureStep) => {
          if (failAt === step) {
            throw new Error(`${step} failed`);
          }
        };

        const tx = {
          ...prisma,
          fxExecuteRequest: {
            ...prisma.fxExecuteRequest,
            create: jest.fn(async () => {
              stage('fxExecuteRequest.create:pending');
              return { id: 'command-1' };
            }),
            update: jest.fn(async () => {
              failIf('finalization');
              stage('fxExecuteRequest.update:succeeded');
              return { id: 'command-1' };
            }),
          },
          quote: {
            ...prisma.quote,
            updateMany: jest.fn(async () => {
              stage('quote.updateMany:consume');
              return { count: 1 };
            }),
          },
          cashWallet: {
            ...prisma.cashWallet,
            updateMany: jest.fn(async () => {
              walletUpdateCallCount += 1;

              if (walletUpdateCallCount === 1) {
                if (failAt === 'source-debit') {
                  return { count: 0 };
                }

                stage('cashWallet.updateMany:source-debit');
                return { count: 1 };
              }

              failIf('target-credit');
              stage('cashWallet.updateMany:target-credit');
              return { count: 1 };
            }),
            findFirst: jest.fn(async () => {
              walletFindCallCount += 1;

              if (failAt === 'source-debit') {
                return {
                  balanceAmount: new Prisma.Decimal('999.99999999'),
                };
              }

              return walletFindCallCount === 1
                ? sourceWalletAfterDebit
                : targetWalletAfterCredit;
            }),
          },
          exchangeTransaction: {
            ...prisma.exchangeTransaction,
            create: jest.fn(async () => {
              failIf('exchange');
              stage('exchangeTransaction.create');
              return { id: 'exchange-1' };
            }),
          },
          walletTransaction: {
            ...prisma.walletTransaction,
            create: jest.fn(async () => {
              ledgerCreateCallCount += 1;

              if (ledgerCreateCallCount === 1) {
                failIf('source-ledger');
                stage('walletTransaction.create:source');
                return { id: 'wallet-tx-source' };
              }

              failIf('target-ledger');
              stage('walletTransaction.create:target');
              return { id: 'wallet-tx-target' };
            }),
          },
        };

        try {
          const result = await callback(tx);
          committedWrites.push(...stagedWrites);
          return result;
        } catch (error) {
          rolledBackWrites.push([...stagedWrites]);
          throw error;
        }
      });

      return { committedWrites, rolledBackWrites };
    };

    const expectWritePathBeforeSuccessFinalization = (
      prisma: ReturnType<typeof createPrisma>,
    ) => {
      expect(prisma.fxExecuteRequest.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          seasonParticipantId: 'participant-1',
          idempotencyKey: 'idempotency-key-1',
          requestHash: getExecuteRequestHash(validExecuteBody),
          fromCurrency: CurrencyCode.KRW,
          toCurrency: CurrencyCode.USD,
          sourceAmount: '1000.00000000',
          status: FxExecuteRequestStatus.pending,
          requestedAt: now,
        },
        select: {
          id: true,
        },
      });
      expect(prisma.quote.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'quote-fx-1',
          status: 'active',
        },
        data: {
          status: 'consumed',
          consumedAt: now,
        },
      });
      expect(prisma.cashWallet.updateMany).toHaveBeenNthCalledWith(1, {
        where: {
          id: 'source-wallet-1',
          seasonParticipantId: 'participant-1',
          currencyCode: CurrencyCode.KRW,
          balanceAmount: {
            gte: '1000.00000000',
          },
        },
        data: {
          balanceAmount: {
            decrement: '1000.00000000',
          },
        },
      });
      expect(prisma.cashWallet.updateMany).toHaveBeenNthCalledWith(2, {
        where: {
          id: 'target-wallet-1',
          seasonParticipantId: 'participant-1',
          currencyCode: CurrencyCode.USD,
        },
        data: {
          balanceAmount: {
            increment: '0.74000000',
          },
        },
      });
      expect(prisma.exchangeTransaction.create).toHaveBeenCalledWith({
        data: {
          seasonParticipantId: 'participant-1',
          fxRateSnapshotId: 'fx-snapshot-1',
          fromCurrency: CurrencyCode.KRW,
          toCurrency: CurrencyCode.USD,
          sourceAmount: '1000.00000000',
          grossTargetAmount: '0.74074074',
          feeRate: '0.001000',
          feeAmount: '0.00074074',
          feeCurrency: CurrencyCode.USD,
          appliedRate: '1350.00000000',
          netTargetAmount: '0.74000000',
          executedAt: now,
        },
        select: {
          id: true,
        },
      });
    };

    const expectNoCommittedSuccess = (
      prisma: ReturnType<typeof createPrisma>,
    ) => {
      expect(prisma.fxExecuteRequest.update).not.toHaveBeenCalled();
      expect(prisma.equitySnapshot.create).not.toHaveBeenCalled();
    };

    it('returns UNAUTHORIZED for missing userId', async () => {
      const { prisma, service } = createService();

      await expectExecuteErrorCode(
        service.execute(undefined, validExecuteBody),
        'UNAUTHORIZED',
      );
      expectNoExecuteWrites(prisma);
      expect(prisma.season.findFirst).not.toHaveBeenCalled();
      expect(prisma.seasonParticipant.findUnique).not.toHaveBeenCalled();
      expect(prisma.fxExecuteRequest.findUnique).not.toHaveBeenCalled();
      expect(prisma.cashWallet.findUnique).not.toHaveBeenCalled();
      expect(prisma.fxRateSnapshot.findMany).not.toHaveBeenCalled();
    });

    it('returns IDEMPOTENCY_REQUIRED for missing idempotencyKey', async () => {
      const { prisma, service } = createService();

      await expectExecuteErrorCode(
        service.execute('user-1', {
          ...validExecuteBody,
          idempotencyKey: undefined,
        }),
        'IDEMPOTENCY_REQUIRED',
      );
      expectNoExecuteWrites(prisma);
      expect(prisma.season.findFirst).not.toHaveBeenCalled();
      expect(prisma.seasonParticipant.findUnique).not.toHaveBeenCalled();
      expect(prisma.fxExecuteRequest.findUnique).not.toHaveBeenCalled();
      expect(prisma.cashWallet.findUnique).not.toHaveBeenCalled();
      expect(prisma.fxRateSnapshot.findFirst).not.toHaveBeenCalled();
      expect(prisma.fxRateSnapshot.findMany).not.toHaveBeenCalled();
    });

    it('returns INVALID_CURRENCY_PAIR for invalid pair', async () => {
      const { prisma, service } = createService();

      await expectExecuteErrorCode(
        service.execute('user-1', {
          ...validExecuteBody,
          toCurrency: 'KRW',
        }),
        'INVALID_CURRENCY_PAIR',
      );
      expectNoExecuteWrites(prisma);
      expect(prisma.season.findFirst).not.toHaveBeenCalled();
      expect(prisma.seasonParticipant.findUnique).not.toHaveBeenCalled();
      expect(prisma.fxExecuteRequest.findUnique).not.toHaveBeenCalled();
      expect(prisma.cashWallet.findUnique).not.toHaveBeenCalled();
      expect(prisma.fxRateSnapshot.findFirst).not.toHaveBeenCalled();
      expect(prisma.fxRateSnapshot.findMany).not.toHaveBeenCalled();
    });

    it('returns INVALID_AMOUNT for invalid amount', async () => {
      const { prisma, service } = createService();

      await expectExecuteErrorCode(
        service.execute('user-1', {
          ...validExecuteBody,
          sourceAmount: '0',
        }),
        'INVALID_AMOUNT',
      );
      expectNoExecuteWrites(prisma);
      expect(prisma.season.findFirst).not.toHaveBeenCalled();
      expect(prisma.seasonParticipant.findUnique).not.toHaveBeenCalled();
      expect(prisma.fxExecuteRequest.findUnique).not.toHaveBeenCalled();
      expect(prisma.cashWallet.findUnique).not.toHaveBeenCalled();
      expect(prisma.fxRateSnapshot.findFirst).not.toHaveBeenCalled();
      expect(prisma.fxRateSnapshot.findMany).not.toHaveBeenCalled();
    });

    it('returns SEASON_NOT_FOUND when there is no current season', async () => {
      const { prisma, service } = createService();
      prisma.season.findFirst.mockResolvedValue(null);

      await expectExecuteErrorCode(
        service.execute('user-1', validExecuteBody),
        'SEASON_NOT_FOUND',
      );
      expectNoExecuteWrites(prisma);
      expect(prisma.seasonParticipant.findUnique).not.toHaveBeenCalled();
      expect(prisma.fxExecuteRequest.findUnique).not.toHaveBeenCalled();
      expect(prisma.cashWallet.findUnique).not.toHaveBeenCalled();
      expect(prisma.fxRateSnapshot.findMany).not.toHaveBeenCalled();
    });

    it('returns SEASON_NOT_ACTIVE when current season is not active', async () => {
      const { prisma, service } = createService();
      prisma.season.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'season-1',
          status: SeasonStatus.upcoming,
          fxFeeRate: new Prisma.Decimal('0.001000'),
        });

      await expectExecuteErrorCode(
        service.execute('user-1', validExecuteBody),
        'SEASON_NOT_ACTIVE',
      );
      expectNoExecuteWrites(prisma);
      expect(prisma.seasonParticipant.findUnique).not.toHaveBeenCalled();
      expect(prisma.fxExecuteRequest.findUnique).not.toHaveBeenCalled();
      expect(prisma.cashWallet.findUnique).not.toHaveBeenCalled();
      expect(prisma.fxRateSnapshot.findMany).not.toHaveBeenCalled();
    });

    it('returns SEASON_NOT_JOINED when active season participant is missing', async () => {
      const { prisma, service } = createService();
      mockActiveSeason(prisma);
      prisma.seasonParticipant.findUnique.mockResolvedValueOnce(null);

      await expectExecuteErrorCode(
        service.execute('user-1', validExecuteBody),
        'SEASON_NOT_JOINED',
      );
      expectNoExecuteWrites(prisma);
      expect(prisma.fxExecuteRequest.findUnique).not.toHaveBeenCalled();
      expect(prisma.cashWallet.findUnique).not.toHaveBeenCalled();
      expect(prisma.fxRateSnapshot.findMany).not.toHaveBeenCalled();
    });

    it('returns IDEMPOTENCY_PENDING for an existing fresh pending same-hash command', async () => {
      const { prisma, service } = createService();
      mockActiveSeason(prisma);
      mockJoinedParticipant(prisma);
      mockExecuteReadCandidates(prisma, {
        existingCommand: buildExistingCommand(FxExecuteRequestStatus.pending),
      });

      await expectExecuteErrorCode(
        service.execute('user-1', validExecuteBody),
        'IDEMPOTENCY_PENDING',
      );
      expect(prisma.fxExecuteRequest.findUnique).toHaveBeenCalledTimes(1);
      expectNoExecutePlanReads(prisma);
      expectNoExecuteWrites(prisma);
    });

    it('returns IDEMPOTENCY_PENDING_STALE for an existing stale pending same-hash command', async () => {
      const { prisma, service } = createService();
      mockActiveSeason(prisma);
      mockJoinedParticipant(prisma);
      mockExecuteReadCandidates(prisma, {
        existingCommand: buildExistingCommand(FxExecuteRequestStatus.pending, {
          requestedAt: stalePendingRequestedAt,
        }),
      });

      await expectExecuteErrorCode(
        service.execute('user-1', validExecuteBody),
        'IDEMPOTENCY_PENDING_STALE',
      );
      expect(prisma.fxExecuteRequest.findUnique).toHaveBeenCalledTimes(1);
      expectNoExecutePlanReads(prisma);
      expectNoExecuteWrites(prisma);
    });

    it('returns IDEMPOTENCY_CONFLICT for an existing different-hash command', async () => {
      const { prisma, service } = createService();
      mockActiveSeason(prisma);
      mockJoinedParticipant(prisma);
      mockExecuteReadCandidates(prisma, {
        existingCommand: buildExistingCommand(FxExecuteRequestStatus.pending, {
          requestHash: 'different-request-hash',
        }),
      });

      await expectExecuteErrorCode(
        service.execute('user-1', validExecuteBody),
        'IDEMPOTENCY_CONFLICT',
      );
      expect(prisma.fxExecuteRequest.findUnique).toHaveBeenCalledTimes(1);
      expectNoExecutePlanReads(prisma);
      expectNoExecuteWrites(prisma);
    });

    it('returns IDEMPOTENCY_FAILED for an existing failed same-hash command', async () => {
      const { prisma, service } = createService();
      mockActiveSeason(prisma);
      mockJoinedParticipant(prisma);
      mockExecuteReadCandidates(prisma, {
        existingCommand: buildExistingCommand(FxExecuteRequestStatus.failed, {
          completedAt: capturedAt,
          errorCode: 'INSUFFICIENT_BALANCE',
          errorMessage: 'Insufficient balance',
        }),
      });

      await expectExecuteErrorCode(
        service.execute('user-1', validExecuteBody),
        'IDEMPOTENCY_FAILED',
      );
      expect(prisma.fxExecuteRequest.findUnique).toHaveBeenCalledTimes(1);
      expectNoExecutePlanReads(prisma);
      expectNoExecuteWrites(prisma);
    });

    it('returns stored responsePayloadJson unchanged for an existing succeeded same-hash command', async () => {
      const { prisma, service } = createService();
      mockActiveSeason(prisma);
      mockJoinedParticipant(prisma);
      mockExecuteReadCandidates(prisma, {
        existingCommand: buildExistingCommand(
          FxExecuteRequestStatus.succeeded,
          {
            completedAt: capturedAt,
            responsePayloadJson: storedSucceededPayload,
            exchangeTransactionId: 'exchange-1',
          },
        ),
      });

      await expect(service.execute('user-1', validExecuteBody)).resolves.toBe(
        storedSucceededPayload,
      );
      expect(prisma.fxExecuteRequest.findUnique).toHaveBeenCalledTimes(1);
      expectNoExecutePlanReads(prisma);
      expectNoExecuteWrites(prisma);
    });

    it('returns INTERNAL_ERROR for an existing succeeded command missing responsePayloadJson', async () => {
      const { prisma, service } = createService();
      mockActiveSeason(prisma);
      mockJoinedParticipant(prisma);
      mockExecuteReadCandidates(prisma, {
        existingCommand: buildExistingCommand(
          FxExecuteRequestStatus.succeeded,
          {
            completedAt: capturedAt,
            exchangeTransactionId: 'exchange-1',
          },
        ),
      });

      await expectExecuteErrorCode(
        service.execute('user-1', validExecuteBody),
        'INTERNAL_ERROR',
      );
      expect(prisma.fxExecuteRequest.findUnique).toHaveBeenCalledTimes(1);
      expectNoExecutePlanReads(prisma);
      expectNoExecuteWrites(prisma);
    });

    it('returns INTERNAL_ERROR for an existing command with unknown status', async () => {
      const { prisma, service } = createService();
      mockActiveSeason(prisma);
      mockJoinedParticipant(prisma);
      mockExecuteReadCandidates(prisma, {
        existingCommand: buildExistingCommand('unknown_status'),
      });

      await expectExecuteErrorCode(
        service.execute('user-1', validExecuteBody),
        'INTERNAL_ERROR',
      );
      expect(prisma.fxExecuteRequest.findUnique).toHaveBeenCalledTimes(1);
      expectNoExecutePlanReads(prisma);
      expectNoExecuteWrites(prisma);
    });

    it('returns SOURCE_WALLET_NOT_FOUND when the source wallet candidate is missing', async () => {
      const { prisma, service } = createService();
      mockActiveSeason(prisma);
      mockJoinedParticipant(prisma);
      mockExecuteReadCandidates(prisma, {
        sourceWallet: null,
      });

      await expectExecuteErrorCode(
        service.execute('user-1', validExecuteBody),
        'SOURCE_WALLET_NOT_FOUND',
      );
      expectExecutePlanReads(prisma);
      expectNoExecuteWrites(prisma);
    });

    it('returns TARGET_WALLET_NOT_FOUND when the target wallet candidate is missing', async () => {
      const { prisma, service } = createService();
      mockActiveSeason(prisma);
      mockJoinedParticipant(prisma);
      mockExecuteReadCandidates(prisma, {
        targetWallet: null,
      });

      await expectExecuteErrorCode(
        service.execute('user-1', validExecuteBody),
        'TARGET_WALLET_NOT_FOUND',
      );
      expectExecutePlanReads(prisma);
      expectNoExecuteWrites(prisma);
    });

    it('returns PROVIDER_RATE_UNAVAILABLE when there is no eligible provider snapshot', async () => {
      const { prisma, service } = createService();
      mockActiveSeason(prisma);
      mockJoinedParticipant(prisma);
      mockExecuteReadCandidates(prisma, {
        snapshots: [],
      });

      await expectExecuteErrorCode(
        service.execute('user-1', validExecuteBody),
        'PROVIDER_RATE_UNAVAILABLE',
      );
      expectExecutePlanReads(prisma);
      expectNoExecuteWrites(prisma);
    });

    it('returns PROVIDER_RATE_STALE when the selected provider snapshot is stale', async () => {
      const { prisma, service } = createService();
      mockActiveSeason(prisma);
      mockJoinedParticipant(prisma);
      mockExecuteReadCandidates(prisma, {
        snapshots: [
          {
            ...executeSnapshot,
            effectiveAt: staleEffectiveAt,
            capturedAt: new Date('2026-04-30T23:59:59.000Z'),
          },
        ],
      });

      await expectExecuteErrorCode(
        service.execute('user-1', validExecuteBody),
        'PROVIDER_RATE_STALE',
      );
      expectExecutePlanReads(prisma);
      expectNoExecuteWrites(prisma);
    });

    it('returns INSUFFICIENT_BALANCE when source wallet balance is below sourceAmount', async () => {
      const { prisma, service } = createService();
      mockActiveSeason(prisma);
      mockJoinedParticipant(prisma);
      mockExecuteReadCandidates(prisma, {
        sourceWallet: {
          ...sourceWallet,
          balanceAmount: new Prisma.Decimal('999.99999999'),
        },
      });

      await expectExecuteErrorCode(
        service.execute('user-1', validExecuteBody),
        'INSUFFICIENT_BALANCE',
      );
      expectExecutePlanReads(prisma);
      expectNoExecuteWrites(prisma);
    });

    it('executes a valid new request and stores the exact responsePayloadJson', async () => {
      const { prisma, service } = createService();
      mockActiveSeason(prisma);
      mockJoinedParticipant(prisma);
      mockExecuteReadCandidates(prisma);
      mockSuccessfulWritePath(prisma);

      const response = await service.execute('user-1', validExecuteBody);

      expect(response).toEqual({
        success: true,
        data: {
          exchangeId: 'exchange-1',
          executedAt: now.toISOString(),
          fromCurrency: CurrencyCode.KRW,
          toCurrency: CurrencyCode.USD,
          sourceAmount: '1000.00000000',
          grossTargetAmount: '0.74074074',
          feeRate: '0.001000',
          feeAmount: '0.00074074',
          feeCurrency: CurrencyCode.USD,
          appliedRate: '1350.00000000',
          quoteId: 'quote-fx-1',
          quotedRate: '1350.00000000',
          executeRate: '1350.00000000',
          rateChangeBps: '0.0000',
          rateSource: {
            sourceType: 'provider_api',
            sourceName: 'exchange_rate_api',
            snapshotId: 'fx-snapshot-1',
            effectiveAt: freshEffectiveAt.toISOString(),
            capturedAt: capturedAt.toISOString(),
            fallbackUsed: false,
            fallbackReason: null,
            rejectedProviderReason: null,
            freshnessAgeSeconds: 30,
          },
          idempotencyKey: 'idempotency-key-1',
          netTargetAmount: '0.74000000',
          sourceWalletId: 'source-wallet-1',
          targetWalletId: 'target-wallet-1',
          sourceWalletBalanceAfter: '0.00000000',
          targetWalletBalanceAfter: '0.74000000',
          fxRateSnapshotId: 'fx-snapshot-1',
          rateCapturedAt: capturedAt.toISOString(),
          rateEffectiveAt: freshEffectiveAt.toISOString(),
        },
      });
      expectExecutePlanReads(prisma);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expectWritePathBeforeSuccessFinalization(prisma);
      expect(prisma.walletTransaction.create).toHaveBeenCalledTimes(2);
      expect(prisma.walletTransaction.create).toHaveBeenNthCalledWith(1, {
        data: {
          seasonParticipantId: 'participant-1',
          walletId: 'source-wallet-1',
          currencyCode: CurrencyCode.KRW,
          direction: WalletTransactionDirection.debit,
          txType: WalletTransactionType.exchange_source,
          referenceType: WalletTransactionReferenceType.exchange_transaction,
          referenceId: 'exchange-1',
          amount: '1000.00000000',
          balanceAfter: '0.00000000',
          occurredAt: now,
        },
        select: {
          id: true,
        },
      });
      expect(prisma.walletTransaction.create).toHaveBeenNthCalledWith(2, {
        data: {
          seasonParticipantId: 'participant-1',
          walletId: 'target-wallet-1',
          currencyCode: CurrencyCode.USD,
          direction: WalletTransactionDirection.credit,
          txType: WalletTransactionType.exchange_target,
          referenceType: WalletTransactionReferenceType.exchange_transaction,
          referenceId: 'exchange-1',
          amount: '0.74000000',
          balanceAfter: '0.74000000',
          occurredAt: now,
        },
        select: {
          id: true,
        },
      });
      expect(prisma.walletTransaction.create).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            txType: WalletTransactionType.fee,
          }),
        }),
      );
      expect(prisma.fxExecuteRequest.update).toHaveBeenCalledTimes(1);
      expect(prisma.fxExecuteRequest.update).toHaveBeenCalledWith({
        where: {
          id: 'command-1',
        },
        data: {
          status: FxExecuteRequestStatus.succeeded,
          exchangeTransactionId: 'exchange-1',
          responsePayloadJson: response,
          completedAt: now,
        },
        select: {
          id: true,
        },
      });
      expect(prisma.equitySnapshot.create).not.toHaveBeenCalled();
    });

    it('replays a command created by a unique-race without wallet mutation', async () => {
      const { prisma, service } = createService();
      mockActiveSeason(prisma);
      mockJoinedParticipant(prisma);
      mockExecuteReadCandidates(prisma);
      prisma.fxExecuteRequest.create.mockRejectedValueOnce({ code: 'P2002' });
      prisma.fxExecuteRequest.findUnique.mockResolvedValueOnce(
        buildExistingCommand(FxExecuteRequestStatus.succeeded, {
          completedAt: capturedAt,
          responsePayloadJson: storedSucceededPayload,
          exchangeTransactionId: 'exchange-1',
        }),
      );

      await expect(service.execute('user-1', validExecuteBody)).resolves.toBe(
        storedSucceededPayload,
      );
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.cashWallet.updateMany).not.toHaveBeenCalled();
      expect(prisma.exchangeTransaction.create).not.toHaveBeenCalled();
      expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
      expect(prisma.fxExecuteRequest.update).not.toHaveBeenCalled();
      expect(prisma.equitySnapshot.create).not.toHaveBeenCalled();
    });

    it('classifies guarded source debit failure when the source wallet disappeared', async () => {
      const { prisma, service } = createService();
      mockActiveSeason(prisma);
      mockJoinedParticipant(prisma);
      mockExecuteReadCandidates(prisma);
      prisma.fxExecuteRequest.create.mockResolvedValueOnce({ id: 'command-1' });
      prisma.cashWallet.updateMany.mockResolvedValueOnce({ count: 0 });
      prisma.cashWallet.findFirst.mockResolvedValueOnce(null);

      await expectExecuteErrorCode(
        service.execute('user-1', validExecuteBody),
        'SOURCE_WALLET_NOT_FOUND',
      );
      expectExecutePlanReads(prisma);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.cashWallet.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.exchangeTransaction.create).not.toHaveBeenCalled();
      expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
      expectNoCommittedSuccess(prisma);
    });

    it('classifies guarded source debit failure when balance is insufficient at mutation time', async () => {
      const { prisma, service } = createService();
      mockActiveSeason(prisma);
      mockJoinedParticipant(prisma);
      mockExecuteReadCandidates(prisma);
      prisma.fxExecuteRequest.create.mockResolvedValueOnce({ id: 'command-1' });
      prisma.cashWallet.updateMany.mockResolvedValueOnce({ count: 0 });
      prisma.cashWallet.findFirst.mockResolvedValueOnce({
        balanceAmount: new Prisma.Decimal('999.99999999'),
      });

      await expectExecuteErrorCode(
        service.execute('user-1', validExecuteBody),
        'INSUFFICIENT_BALANCE',
      );
      expect(prisma.cashWallet.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.exchangeTransaction.create).not.toHaveBeenCalled();
      expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
      expectNoCommittedSuccess(prisma);
    });

    it('classifies guarded source debit failure as a concurrent wallet update when reread is sufficient', async () => {
      const { prisma, service } = createService();
      mockActiveSeason(prisma);
      mockJoinedParticipant(prisma);
      mockExecuteReadCandidates(prisma);
      prisma.fxExecuteRequest.create.mockResolvedValueOnce({ id: 'command-1' });
      prisma.cashWallet.updateMany.mockResolvedValueOnce({ count: 0 });
      prisma.cashWallet.findFirst.mockResolvedValueOnce({
        balanceAmount: new Prisma.Decimal('1000.00000000'),
      });

      await expectExecuteErrorCode(
        service.execute('user-1', validExecuteBody),
        'CONCURRENT_WALLET_UPDATE',
      );
      expect(prisma.cashWallet.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.exchangeTransaction.create).not.toHaveBeenCalled();
      expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
      expectNoCommittedSuccess(prisma);
    });

    it('returns EXECUTE_TRANSACTION_FAILED when target credit fails after source debit', async () => {
      const { prisma, service } = createService();
      mockActiveSeason(prisma);
      mockJoinedParticipant(prisma);
      mockExecuteReadCandidates(prisma);
      prisma.fxExecuteRequest.create.mockResolvedValueOnce({ id: 'command-1' });
      prisma.cashWallet.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockRejectedValueOnce(new Error('target credit failed'));
      prisma.cashWallet.findFirst.mockResolvedValueOnce(sourceWalletAfterDebit);

      await expectExecuteErrorCode(
        service.execute('user-1', validExecuteBody),
        'EXECUTE_TRANSACTION_FAILED',
      );
      expect(prisma.exchangeTransaction.create).not.toHaveBeenCalled();
      expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
      expectNoCommittedSuccess(prisma);
    });

    it('returns EXECUTE_TRANSACTION_FAILED when exchange row creation fails', async () => {
      const { prisma, service } = createService();
      mockActiveSeason(prisma);
      mockJoinedParticipant(prisma);
      mockExecuteReadCandidates(prisma);
      prisma.fxExecuteRequest.create.mockResolvedValueOnce({ id: 'command-1' });
      prisma.cashWallet.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 });
      prisma.cashWallet.findFirst
        .mockResolvedValueOnce(sourceWalletAfterDebit)
        .mockResolvedValueOnce(targetWalletAfterCredit);
      prisma.exchangeTransaction.create.mockRejectedValueOnce(
        new Error('exchange failed'),
      );

      await expectExecuteErrorCode(
        service.execute('user-1', validExecuteBody),
        'EXECUTE_TRANSACTION_FAILED',
      );
      expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
      expectNoCommittedSuccess(prisma);
    });

    it('returns EXECUTE_TRANSACTION_FAILED when source ledger row creation fails', async () => {
      const { prisma, service } = createService();
      mockActiveSeason(prisma);
      mockJoinedParticipant(prisma);
      mockExecuteReadCandidates(prisma);
      prisma.fxExecuteRequest.create.mockResolvedValueOnce({ id: 'command-1' });
      prisma.cashWallet.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 });
      prisma.cashWallet.findFirst
        .mockResolvedValueOnce(sourceWalletAfterDebit)
        .mockResolvedValueOnce(targetWalletAfterCredit);
      prisma.exchangeTransaction.create.mockResolvedValueOnce({
        id: 'exchange-1',
      });
      prisma.walletTransaction.create.mockRejectedValueOnce(
        new Error('source ledger failed'),
      );

      await expectExecuteErrorCode(
        service.execute('user-1', validExecuteBody),
        'EXECUTE_TRANSACTION_FAILED',
      );
      expect(prisma.walletTransaction.create).toHaveBeenCalledTimes(1);
      expectNoCommittedSuccess(prisma);
    });

    it('returns EXECUTE_TRANSACTION_FAILED when target ledger row creation fails', async () => {
      const { prisma, service } = createService();
      mockActiveSeason(prisma);
      mockJoinedParticipant(prisma);
      mockExecuteReadCandidates(prisma);
      prisma.fxExecuteRequest.create.mockResolvedValueOnce({ id: 'command-1' });
      prisma.cashWallet.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 });
      prisma.cashWallet.findFirst
        .mockResolvedValueOnce(sourceWalletAfterDebit)
        .mockResolvedValueOnce(targetWalletAfterCredit);
      prisma.exchangeTransaction.create.mockResolvedValueOnce({
        id: 'exchange-1',
      });
      prisma.walletTransaction.create
        .mockResolvedValueOnce({ id: 'wallet-tx-source' })
        .mockRejectedValueOnce(new Error('target ledger failed'));

      await expectExecuteErrorCode(
        service.execute('user-1', validExecuteBody),
        'EXECUTE_TRANSACTION_FAILED',
      );
      expect(prisma.walletTransaction.create).toHaveBeenCalledTimes(2);
      expectNoCommittedSuccess(prisma);
    });

    it('returns EXECUTE_TRANSACTION_FAILED when succeeded finalization fails', async () => {
      const { prisma, service } = createService();
      mockActiveSeason(prisma);
      mockJoinedParticipant(prisma);
      mockExecuteReadCandidates(prisma);
      mockSuccessfulWritePath(prisma);
      prisma.fxExecuteRequest.update.mockReset();
      prisma.fxExecuteRequest.update.mockRejectedValueOnce(
        new Error('finalization failed'),
      );

      await expectExecuteErrorCode(
        service.execute('user-1', validExecuteBody),
        'EXECUTE_TRANSACTION_FAILED',
      );
      expect(prisma.fxExecuteRequest.update).toHaveBeenCalledTimes(1);
      expect(prisma.equitySnapshot.create).not.toHaveBeenCalled();
    });

    it.each<[string, AtomicFailureStep, string, string[]]>([
      [
        'source debit classification fails',
        'source-debit',
        'INSUFFICIENT_BALANCE',
        ['fxExecuteRequest.create:pending', 'quote.updateMany:consume'],
      ],
      [
        'target credit fails after source debit',
        'target-credit',
        'EXECUTE_TRANSACTION_FAILED',
        [
          'fxExecuteRequest.create:pending',
          'quote.updateMany:consume',
          'cashWallet.updateMany:source-debit',
        ],
      ],
      [
        'exchange row creation fails after wallet updates',
        'exchange',
        'EXECUTE_TRANSACTION_FAILED',
        [
          'fxExecuteRequest.create:pending',
          'quote.updateMany:consume',
          'cashWallet.updateMany:source-debit',
          'cashWallet.updateMany:target-credit',
        ],
      ],
      [
        'source ledger creation fails after exchange row',
        'source-ledger',
        'EXECUTE_TRANSACTION_FAILED',
        [
          'fxExecuteRequest.create:pending',
          'quote.updateMany:consume',
          'cashWallet.updateMany:source-debit',
          'cashWallet.updateMany:target-credit',
          'exchangeTransaction.create',
        ],
      ],
      [
        'target ledger creation fails after source ledger',
        'target-ledger',
        'EXECUTE_TRANSACTION_FAILED',
        [
          'fxExecuteRequest.create:pending',
          'quote.updateMany:consume',
          'cashWallet.updateMany:source-debit',
          'cashWallet.updateMany:target-credit',
          'exchangeTransaction.create',
          'walletTransaction.create:source',
        ],
      ],
      [
        'succeeded finalization and responsePayloadJson storage fail',
        'finalization',
        'EXECUTE_TRANSACTION_FAILED',
        [
          'fxExecuteRequest.create:pending',
          'quote.updateMany:consume',
          'cashWallet.updateMany:source-debit',
          'cashWallet.updateMany:target-credit',
          'exchangeTransaction.create',
          'walletTransaction.create:source',
          'walletTransaction.create:target',
        ],
      ],
    ])(
      'rolls back staged writes when %s',
      async (_label, failAt, expectedCode, expectedRolledBackWrites) => {
        const { prisma, service } = createService();
        mockActiveSeason(prisma);
        mockJoinedParticipant(prisma);
        mockExecuteReadCandidates(prisma);
        const transactionState = mockAtomicWritePathFailure(prisma, failAt);

        await expectExecuteErrorCode(
          service.execute('user-1', validExecuteBody),
          expectedCode,
        );

        expect(transactionState.rolledBackWrites).toEqual([
          expectedRolledBackWrites,
        ]);
        expect(transactionState.committedWrites).toEqual([]);
        expect(prisma.equitySnapshot.create).not.toHaveBeenCalled();
      },
    );

    it('uses normalized idempotency key, currencies, and execute snapshot filters for read candidates', async () => {
      const { prisma, service } = createService();
      const body = {
        fromCurrency: ' krw ',
        toCurrency: ' usd ',
        sourceAmount: '1000.0',
        idempotencyKey: '  idempotency-key-1  ',
        quoteId: ' quote-fx-1 ',
      };
      mockActiveSeason(prisma);
      mockJoinedParticipant(prisma);
      mockExecuteReadCandidates(prisma, {
        snapshots: [],
      });

      await expectExecuteErrorCode(
        service.execute('user-1', body),
        'PROVIDER_RATE_UNAVAILABLE',
      );

      expect(prisma.fxExecuteRequest.findUnique).toHaveBeenCalledWith({
        where: {
          userId_idempotencyKey: {
            userId: 'user-1',
            idempotencyKey: 'idempotency-key-1',
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
      expect(prisma.cashWallet.findUnique).toHaveBeenNthCalledWith(1, {
        where: {
          seasonParticipantId_currencyCode: {
            seasonParticipantId: 'participant-1',
            currencyCode: CurrencyCode.KRW,
          },
        },
        select: {
          id: true,
          seasonParticipantId: true,
          currencyCode: true,
          balanceAmount: true,
        },
      });
      expect(prisma.cashWallet.findUnique).toHaveBeenNthCalledWith(2, {
        where: {
          seasonParticipantId_currencyCode: {
            seasonParticipantId: 'participant-1',
            currencyCode: CurrencyCode.USD,
          },
        },
        select: {
          id: true,
          seasonParticipantId: true,
          currencyCode: true,
          balanceAmount: true,
        },
      });
      expect(prisma.fxRateSnapshot.findMany).toHaveBeenCalledWith({
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
        take: 5,
        select: {
          id: true,
          sourceType: true,
          sourceName: true,
          rate: true,
          effectiveAt: true,
          capturedAt: true,
        },
      });
      expectNoExecuteWrites(prisma);
    });

    /*
     * Execute write path atomic transaction scaffold/checklist for the next task:
     * - creates pending fxExecuteRequest before guarded write path
     * - guarded conditional source debit prevents overspend
     * - source debit affected row count 0 classification
     * - target credit occurs only after source debit success
     * - exchangeTransaction row is created with plan values
     * - source walletTransaction row is created with actual post-update balanceAfter
     * - target walletTransaction row is created with actual post-update balanceAfter
     * - fxExecuteRequest finalized to succeeded with exchangeTransactionId and responsePayloadJson
     * - target credit failure rolls back source debit
     * - exchange row failure rolls back wallet changes
     * - ledger row failure rolls back wallet/exchange changes
     * - responsePayloadJson storage failure does not commit success
     * - duplicate retry after response loss does not create second wallet mutation
     * - no equitySnapshot row is created
     * - no fee walletTransaction row is created
     */

    it('defines EXECUTE_WRITE_PATH_NOT_IMPLEMENTED as a 501 skeleton code', () => {
      expect(
        fxExecuteErrorMetadata.EXECUTE_WRITE_PATH_NOT_IMPLEMENTED,
      ).toMatchObject({
        httpStatus: 501,
        retryability: 'non_retryable',
        walletMutationAllowed: 'no',
        defaultMessage: '/fx execute write path is not implemented yet.',
      });
    });
  });

  describe('execute orchestration decision mapper', () => {
    const mapDecision = (decision: FxExecuteOrchestrationDecision) =>
      mapFxExecuteOrchestrationDecisionToSkeletonResponse(decision);

    it('maps request_preflight error decision to an error envelope', () => {
      expect(
        mapDecision({
          action: 'return_error',
          source: 'request_preflight',
          errorCode: 'INVALID_AMOUNT',
        }),
      ).toEqual({
        success: false,
        error: {
          code: 'INVALID_AMOUNT',
          message: 'Invalid amount',
        },
      });
    });

    it('maps idempotency error decision to an error envelope', () => {
      expect(
        mapDecision({
          action: 'return_error',
          source: 'idempotency',
          errorCode: 'IDEMPOTENCY_PENDING',
          commandId: 'command-1',
        }),
      ).toEqual({
        success: false,
        error: {
          code: 'IDEMPOTENCY_PENDING',
          message: 'Idempotent request is still pending',
        },
      });
    });

    it('maps idempotency_recovery decision to an INTERNAL_ERROR envelope', () => {
      expect(
        mapDecision({
          action: 'return_error',
          source: 'idempotency_recovery',
          errorCode: 'INTERNAL_ERROR',
          commandId: 'command-1',
          reason: 'succeeded command is missing responsePayloadJson',
        }),
      ).toEqual({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error',
        },
      });
    });

    it('maps plan error decision to an error envelope', () => {
      expect(
        mapDecision({
          action: 'return_error',
          source: 'plan',
          errorCode: 'SOURCE_WALLET_NOT_FOUND',
        }),
      ).toEqual({
        success: false,
        error: {
          code: 'SOURCE_WALLET_NOT_FOUND',
          message: 'Source wallet not found',
        },
      });
    });

    it('returns replay_succeeded stored responsePayloadJson unchanged', () => {
      const responsePayloadJson = {
        success: true,
        data: {
          exchangeId: 'exchange-1',
          rate: 'stored-rate',
        },
      };

      const response = mapDecision({
        action: 'replay_succeeded',
        commandId: 'command-1',
        responsePayloadJson,
      });

      expect(response).toBe(responsePayloadJson);
    });

    it('maps create_pending_and_execute to write path not implemented', () => {
      expect(
        mapDecision({
          action: 'create_pending_and_execute',
          normalizedRequest: {} as never,
          plan: {} as never,
        }),
      ).toEqual({
        success: false,
        error: {
          code: 'EXECUTE_WRITE_PATH_NOT_IMPLEMENTED',
          message: '/fx execute write path is not implemented yet.',
        },
      });
    });

    it('service pre-mutation skeleton calls orchestration and maps its decision', () => {
      const { prisma, service } = createService();

      expect(
        service.executePreMutationSkeleton({
          body: {
            quoteId: 'quote-fx-1',
            fromCurrency: 'KRW',
            toCurrency: 'USD',
            sourceAmount: '1000',
            idempotencyKey: 'idempotency-key-1',
          },
          context: {
            userId: 'user-1',
            seasonParticipantId: 'participant-1',
          },
          existingCommand: null,
          sourceWallet: null,
          targetWallet: null,
          snapshots: [],
          fxFeeRate: '0.001000',
          executeNow: now,
        }),
      ).toEqual({
        success: false,
        error: {
          code: 'SOURCE_WALLET_NOT_FOUND',
          message: 'Source wallet not found',
        },
      });
      expectNoExecuteWrites(prisma);
    });
  });
});
