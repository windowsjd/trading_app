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

const now = new Date('2026-05-01T00:01:00.000Z');
const capturedAt = new Date('2026-05-01T00:00:30.000Z');
const freshEffectiveAt = new Date('2026-05-01T00:00:30.000Z');
const thresholdEffectiveAt = new Date('2026-05-01T00:00:00.000Z');
const staleEffectiveAt = new Date('2026-04-30T23:59:59.999Z');
const stalePendingRequestedAt = new Date('2026-04-30T23:58:59.999Z');
const createdAt = new Date('2026-05-01T00:00:20.000Z');

describe('FxService', () => {
  const createPrisma = () => ({
    $transaction: jest.fn(),
    season: {
      findFirst: jest.fn(),
    },
    seasonParticipant: {
      findUnique: jest.fn(),
    },
    cashWallet: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    fxRateSnapshot: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
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
    equitySnapshot: {
      create: jest.fn(),
    },
  });

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
    expect(prisma.exchangeTransaction.create).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(prisma.fxExecuteRequest.create).not.toHaveBeenCalled();
    expect(prisma.fxExecuteRequest.update).not.toHaveBeenCalled();
    expect(prisma.equitySnapshot.create).not.toHaveBeenCalled();
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
      rate: new Prisma.Decimal('1350.00000000'),
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

    expect(prisma.fxRateSnapshot.findFirst).toHaveBeenCalledWith({
      where: {
        baseCurrency: CurrencyCode.USD,
        quoteCurrency: CurrencyCode.KRW,
        effectiveAt: {
          lte: expect.any(Date),
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
    expect(
      prisma.fxRateSnapshot.findFirst.mock.calls[0][0].where.effectiveAt.lte,
    ).toEqual(now);
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
        quoteId: null,
        fromCurrency: CurrencyCode.KRW,
        toCurrency: CurrencyCode.USD,
        sourceAmount: '135000.00000000',
        appliedRate: '1350.00000000',
        grossTargetAmount: '100.00000000',
        feeRate: '0.001000',
        feeAmount: '0.10000000',
        feeCurrency: CurrencyCode.USD,
        netTargetAmount: '99.90000000',
        expiresAt: null,
        rateCapturedAt: capturedAt.toISOString(),
        rateEffectiveAt: freshEffectiveAt.toISOString(),
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
    };
    const executeSnapshot = {
      id: 'fx-snapshot-1',
      baseCurrency: CurrencyCode.USD,
      quoteCurrency: CurrencyCode.KRW,
      sourceType: FxRateSourceType.admin_manual,
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

    const mockExecuteReadCandidates = (
      prisma: ReturnType<typeof createPrisma>,
      overrides: {
        existingCommand?: unknown;
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
      prisma.season.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
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
      expectNoExecuteWrites(prisma);
    });

    it('returns stored responsePayloadJson unchanged for an existing succeeded same-hash command', async () => {
      const { prisma, service } = createService();
      mockActiveSeason(prisma);
      mockJoinedParticipant(prisma);
      mockExecuteReadCandidates(prisma, {
        existingCommand: buildExistingCommand(FxExecuteRequestStatus.succeeded, {
          completedAt: capturedAt,
          responsePayloadJson: storedSucceededPayload,
          exchangeTransactionId: 'exchange-1',
        }),
      });

      await expect(
        service.execute('user-1', validExecuteBody),
      ).resolves.toBe(storedSucceededPayload);
      expectNoExecuteWrites(prisma);
    });

    it('returns INTERNAL_ERROR for an existing succeeded command missing responsePayloadJson', async () => {
      const { prisma, service } = createService();
      mockActiveSeason(prisma);
      mockJoinedParticipant(prisma);
      mockExecuteReadCandidates(prisma, {
        existingCommand: buildExistingCommand(FxExecuteRequestStatus.succeeded, {
          completedAt: capturedAt,
          exchangeTransactionId: 'exchange-1',
        }),
      });

      await expectExecuteErrorCode(
        service.execute('user-1', validExecuteBody),
        'INTERNAL_ERROR',
      );
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
      expectNoExecuteWrites(prisma);
    });

    it('returns FX_RATE_UNAVAILABLE when there is no eligible admin_manual snapshot', async () => {
      const { prisma, service } = createService();
      mockActiveSeason(prisma);
      mockJoinedParticipant(prisma);
      mockExecuteReadCandidates(prisma, {
        snapshots: [],
      });

      await expectExecuteErrorCode(
        service.execute('user-1', validExecuteBody),
        'FX_RATE_UNAVAILABLE',
      );
      expectNoExecuteWrites(prisma);
    });

    it('returns FX_RATE_STALE when the selected admin_manual snapshot is stale', async () => {
      const { prisma, service } = createService();
      mockActiveSeason(prisma);
      mockJoinedParticipant(prisma);
      mockExecuteReadCandidates(prisma, {
        snapshots: [
          {
            ...executeSnapshot,
            effectiveAt: staleEffectiveAt,
          },
        ],
      });

      await expectExecuteErrorCode(
        service.execute('user-1', validExecuteBody),
        'FX_RATE_STALE',
      );
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
      expectNoExecuteWrites(prisma);
    });

    it('returns EXECUTE_WRITE_PATH_NOT_IMPLEMENTED for a valid request', async () => {
      const { prisma, service } = createService();
      mockActiveSeason(prisma);
      mockJoinedParticipant(prisma);
      mockExecuteReadCandidates(prisma);

      await expectExecuteErrorCode(
        service.execute('user-1', validExecuteBody),
        'EXECUTE_WRITE_PATH_NOT_IMPLEMENTED',
      );
      expectNoExecuteWrites(prisma);
    });

    it('uses normalized idempotency key, currencies, and execute snapshot filters for read candidates', async () => {
      const { prisma, service } = createService();
      const body = {
        fromCurrency: ' krw ',
        toCurrency: ' usd ',
        sourceAmount: '1000.0',
        idempotencyKey: '  idempotency-key-1  ',
      };
      mockActiveSeason(prisma);
      mockJoinedParticipant(prisma);
      mockExecuteReadCandidates(prisma);

      await expectExecuteErrorCode(
        service.execute('user-1', body),
        'EXECUTE_WRITE_PATH_NOT_IMPLEMENTED',
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
          sourceType: FxRateSourceType.admin_manual,
          effectiveAt: {
            lte: now,
          },
        },
        orderBy: [
          { effectiveAt: 'desc' },
          { capturedAt: 'desc' },
          { createdAt: 'desc' },
        ],
        take: 5,
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
      expectNoExecuteWrites(prisma);
    });

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
