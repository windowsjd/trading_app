jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    OperatorAuditResult: {
      success: 'success',
      failure: 'failure',
    },
    ParticipantStatus: {
      registered: 'registered',
      active: 'active',
      finished: 'finished',
      rewarded: 'rewarded',
      excluded: 'excluded',
    },
    Prisma: {
      Decimal,
    },
    PrismaClient: class PrismaClient {},
    SeasonRankingType: {
      daily: 'daily',
      final: 'final',
    },
    SeasonStatus: {
      upcoming: 'upcoming',
      active: 'active',
      ended: 'ended',
      settled: 'settled',
    },
    TradingAccountMode: {
      season: 'season',
      general: 'general',
    },
    TradingAccountStatus: {
      active: 'active',
      suspended: 'suspended',
      closed: 'closed',
    },
    UserRole: {
      user: 'user',
      operator: 'operator',
      admin: 'admin',
    },
  };
});

import { HttpException } from '@nestjs/common';
import {
  OperatorAuditResult,
  ParticipantStatus,
  Prisma,
  SeasonStatus,
  UserRole,
} from '../generated/prisma/client';
import { deriveSeasonTradingAccountId } from '../seasons/season-trading-account-link';
import { OperatorAuditService } from './operator-audit.service';
import { OperatorSeasonModerationService } from './operator-season-moderation.service';

describe('OperatorSeasonModerationService', () => {
  const actor = {
    userId: 'operator-1',
    role: UserRole.operator,
  };
  const now = new Date('2026-06-21T03:00:00.000Z');
  const rankingDate = new Date('2026-06-20T00:00:00.000Z');
  const capturedAt = new Date('2026-06-20T00:10:00.000Z');

  const createParticipant = (
    overrides: Partial<ReturnType<typeof baseParticipant>> = {},
  ) => ({
    ...baseParticipant(),
    ...overrides,
  });

  const baseParticipant = () => ({
    id: 'sp-1',
    seasonId: 'season-1',
    userId: 'user-1',
    joinedAt: new Date('2026-06-01T00:00:00.000Z'),
    participantStatus: ParticipantStatus.active,
    initialCapitalKrw: new Prisma.Decimal('10000000.00000000'),
    tradingAccountId: 'ta-1',
    totalAssetKrw: new Prisma.Decimal('10100000.00000000'),
    totalReturnRate: new Prisma.Decimal('1.00000000'),
    maxDrawdown: new Prisma.Decimal('0.50000000'),
    totalFillCount: 3,
    currentRank: 3,
    finalRank: 3,
    finalTier: 'silver',
    excludedAt: null,
    excludedReason: null,
    excludedByUserId: null,
    rankingHiddenAt: null,
    rankingHiddenReason: null,
    rankingHiddenByUserId: null,
    resultCorrectedAt: null,
    resultCorrectedReason: null,
    resultCorrectedByUserId: null,
    updatedAt: now,
    season: {
      id: 'season-1',
      status: SeasonStatus.active,
      endAt: new Date('2026-06-20T00:00:00.000Z'),
    },
  });

  const createPrisma = () => {
    const prisma = {
      $transaction: jest.fn(),
      operatorAuditLog: {
        create: jest.fn().mockResolvedValue({ id: 'audit-1', createdAt: now }),
      },
      seasonParticipant: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      seasonRanking: {
        findFirst: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
      },
      tradingAccount: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    prisma.$transaction.mockImplementation((callback) => callback(prisma));
    // Default: the participant's linked season account exists and is active.
    prisma.tradingAccount.findUnique.mockResolvedValue({
      id: 'ta-1',
      userId: 'user-1',
      mode: 'season',
      status: 'active',
    });
    prisma.tradingAccount.update.mockResolvedValue({ id: 'ta-1' });

    return prisma;
  };

  const createService = () => {
    const prisma = createPrisma();
    const auditService = new OperatorAuditService(prisma as never);
    const service = new OperatorSeasonModerationService(
      prisma as never,
      auditService,
    );

    return { auditService, prisma, service };
  };

  const getErrorCode = (error: unknown) => {
    const response = (error as HttpException).getResponse() as {
      error: { code: string };
    };

    return response.error.code;
  };

  const expectErrorCode = async (promise: Promise<unknown>, code: string) => {
    await expect(promise).rejects.toBeInstanceOf(HttpException);

    try {
      await promise;
    } catch (error) {
      expect(getErrorCode(error)).toBe(code);
    }
  };

  it('excludes an active season participant and records safe audit metadata', async () => {
    const { prisma, service } = createService();
    const participant = createParticipant();
    const excludedAt = new Date('2026-06-21T03:01:00.000Z');
    prisma.seasonParticipant.findFirst.mockResolvedValueOnce(participant);
    prisma.seasonParticipant.update.mockResolvedValueOnce({
      ...participant,
      participantStatus: ParticipantStatus.excluded,
      excludedAt,
      excludedReason: 'abuse_detected',
      excludedByUserId: actor.userId,
      currentRank: null,
      updatedAt: excludedAt,
    });

    const response = await service.excludeParticipant(
      actor,
      'season-1',
      'sp-1',
      {
        reason: 'abuse_detected',
        note: 'Detected automation abuse',
      },
      {
        requestId: 'request-1',
      },
    );

    expect(response).toEqual({
      success: true,
      data: {
        seasonId: 'season-1',
        seasonParticipantId: 'sp-1',
        status: ParticipantStatus.excluded,
        excludedAt: excludedAt.toISOString(),
        reason: 'abuse_detected',
      },
    });
    expect(prisma.seasonParticipant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sp-1' },
        data: expect.objectContaining({
          participantStatus: ParticipantStatus.excluded,
          excludedReason: 'abuse_detected',
          excludedByUserId: actor.userId,
          currentRank: null,
        }),
      }),
    );
    expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'operator.season_participant.exclude',
          actorRole: UserRole.operator,
          targetId: 'sp-1',
          result: OperatorAuditResult.success,
          metadataJson: expect.objectContaining({
            beforeStatus: ParticipantStatus.active,
            afterStatus: ParticipantStatus.excluded,
            reason: 'abuse_detected',
          }),
        }),
      }),
    );
    expect(
      JSON.stringify(prisma.operatorAuditLog.create.mock.calls),
    ).not.toMatch(/passwordHash|rawPayload|provider_payload|token|secret/i);
  });

  it('suspends the linked season trading account in the same transaction and audits before/after', async () => {
    const { prisma, service } = createService();
    const participant = createParticipant();
    prisma.seasonParticipant.findFirst.mockResolvedValueOnce(participant);
    prisma.seasonParticipant.update.mockResolvedValueOnce({
      ...participant,
      participantStatus: ParticipantStatus.excluded,
      excludedAt: now,
      currentRank: null,
    });

    await service.excludeParticipant(actor, 'season-1', 'sp-1', {
      reason: 'abuse_detected',
    });

    // Only the linked account is touched — never any other account.
    expect(prisma.tradingAccount.update).toHaveBeenCalledTimes(1);
    expect(prisma.tradingAccount.update).toHaveBeenCalledWith({
      where: { id: 'ta-1' },
      data: { status: 'suspended' },
      select: { id: true },
    });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadataJson: expect.objectContaining({
            tradingAccountId: 'ta-1',
            beforeTradingAccountStatus: 'active',
            afterTradingAccountStatus: 'suspended',
            tradingAccountLinkRepaired: false,
          }) as Record<string, unknown>,
        }) as Record<string, unknown>,
      }),
    );
  });

  it('keeps an already suspended trading account suspended (idempotent)', async () => {
    const { prisma, service } = createService();
    const participant = createParticipant();
    prisma.tradingAccount.findUnique.mockResolvedValue({
      id: 'ta-1',
      userId: 'user-1',
      mode: 'season',
      status: 'suspended',
    });
    prisma.seasonParticipant.findFirst.mockResolvedValueOnce(participant);
    prisma.seasonParticipant.update.mockResolvedValueOnce({
      ...participant,
      participantStatus: ParticipantStatus.excluded,
      excludedAt: now,
      currentRank: null,
    });

    await service.excludeParticipant(actor, 'season-1', 'sp-1', {});

    expect(prisma.tradingAccount.update).not.toHaveBeenCalled();
    expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadataJson: expect.objectContaining({
            beforeTradingAccountStatus: 'suspended',
            afterTradingAccountStatus: 'suspended',
          }) as Record<string, unknown>,
        }) as Record<string, unknown>,
      }),
    );
  });

  it('never reverts a closed trading account to suspended', async () => {
    const { prisma, service } = createService();
    const participant = createParticipant({
      participantStatus: ParticipantStatus.finished,
      season: {
        id: 'season-1',
        status: SeasonStatus.ended,
        endAt: new Date('2026-06-20T00:00:00.000Z'),
      },
    });
    prisma.tradingAccount.findUnique.mockResolvedValue({
      id: 'ta-1',
      userId: 'user-1',
      mode: 'season',
      status: 'closed',
    });
    prisma.seasonParticipant.findFirst.mockResolvedValueOnce(participant);
    prisma.seasonParticipant.update.mockResolvedValueOnce({
      ...participant,
      participantStatus: ParticipantStatus.excluded,
      excludedAt: now,
      currentRank: null,
    });

    await service.excludeParticipant(actor, 'season-1', 'sp-1', {});

    expect(prisma.tradingAccount.update).not.toHaveBeenCalled();
    expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadataJson: expect.objectContaining({
            beforeTradingAccountStatus: 'closed',
            afterTradingAccountStatus: 'closed',
          }) as Record<string, unknown>,
        }) as Record<string, unknown>,
      }),
    );
  });

  it('repairs a legacy null account link inside the exclusion transaction before suspending', async () => {
    const { prisma, service } = createService();
    const participant = createParticipant({ tradingAccountId: null });
    const deterministicId = deriveSeasonTradingAccountId('sp-1');
    prisma.seasonParticipant.findFirst.mockResolvedValueOnce(participant);
    // ensure(): deterministic account does not exist yet; the post-insert
    // re-read returns the freshly stored deterministic row.
    prisma.tradingAccount.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: deterministicId,
        userId: 'user-1',
        mode: 'season',
        status: 'active',
        initialCapitalKrw: new Prisma.Decimal('10000000.00000000'),
        openedAt: new Date('2026-06-01T00:00:00.000Z'),
        seasonParticipant: null,
      });
    prisma.seasonParticipant.updateMany.mockResolvedValueOnce({ count: 1 });
    // sync(): the repaired account is fetched for the status change.
    prisma.tradingAccount.findUnique.mockResolvedValueOnce({
      id: deterministicId,
      userId: 'user-1',
      mode: 'season',
      status: 'active',
    });
    prisma.seasonParticipant.update.mockResolvedValueOnce({
      ...participant,
      participantStatus: ParticipantStatus.excluded,
      excludedAt: now,
      currentRank: null,
    });

    await service.excludeParticipant(actor, 'season-1', 'sp-1', {});

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw.mock.calls[0].slice(1)).toEqual([
      deterministicId,
      'user-1',
      'season',
      'active',
      '10000000.00000000',
      new Date('2026-06-01T00:00:00.000Z'),
    ]);
    expect(prisma.seasonParticipant.updateMany).toHaveBeenCalledWith({
      where: { id: 'sp-1', tradingAccountId: null },
      data: { tradingAccountId: deterministicId },
    });
    expect(prisma.tradingAccount.update).toHaveBeenCalledWith({
      where: { id: deterministicId },
      data: { status: 'suspended' },
      select: { id: true },
    });
    expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadataJson: expect.objectContaining({
            tradingAccountId: deterministicId,
            tradingAccountLinkRepaired: true,
          }) as Record<string, unknown>,
        }) as Record<string, unknown>,
      }),
    );
  });

  it('fails closed with a structured 500 when the linked account does not match the participant', async () => {
    const { prisma, service } = createService();
    const participant = createParticipant();
    prisma.tradingAccount.findUnique.mockResolvedValue({
      id: 'ta-1',
      userId: 'user-other',
      mode: 'season',
      status: 'active',
    });
    prisma.seasonParticipant.findFirst.mockResolvedValueOnce(participant);

    await expectErrorCode(
      service.excludeParticipant(actor, 'season-1', 'sp-1', {}),
      'TRADING_ACCOUNT_LINK_INTEGRITY',
    );
    // The mismatch aborts before any state change in the transaction.
    expect(prisma.seasonParticipant.update).not.toHaveBeenCalled();
    expect(prisma.tradingAccount.update).not.toHaveBeenCalled();
  });

  it('cancels open limit buys and releases reservations inside the exclusion transaction', async () => {
    const { prisma } = createService();
    const limitOrderCancelService = {
      cancelOpenLimitBuysForParticipantInTransaction: jest.fn(() =>
        Promise.resolve({
          canceledOrderCount: 2,
          releasedReservationCount: 2,
        }),
      ),
    };
    const auditService = new OperatorAuditService(prisma as never);
    const service = new OperatorSeasonModerationService(
      prisma as never,
      auditService,
      limitOrderCancelService as never,
    );
    const participant = createParticipant();
    const excludedAt = new Date('2026-06-21T03:01:00.000Z');
    prisma.seasonParticipant.findFirst.mockResolvedValueOnce(participant);
    prisma.seasonParticipant.update.mockResolvedValueOnce({
      ...participant,
      participantStatus: ParticipantStatus.excluded,
      excludedAt,
      excludedReason: 'abuse_detected',
      excludedByUserId: actor.userId,
      currentRank: null,
      updatedAt: excludedAt,
    });

    await service.excludeParticipant(actor, 'season-1', 'sp-1', {
      reason: 'abuse_detected',
    });

    expect(
      limitOrderCancelService.cancelOpenLimitBuysForParticipantInTransaction,
    ).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        seasonParticipantId: 'sp-1',
        reason: 'participant_excluded',
      }),
    );
    // The cleanup result is surfaced in the success audit metadata.
    expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadataJson: expect.objectContaining({
            canceledLimitOrderCount: 2,
          }) as Record<string, unknown>,
        }) as Record<string, unknown>,
      }),
    );
  });

  it('rejects general exclusion for settled seasons and audits failure', async () => {
    const { prisma, service } = createService();
    prisma.seasonParticipant.findFirst.mockResolvedValueOnce(
      createParticipant({
        season: {
          id: 'season-1',
          status: SeasonStatus.settled,
          endAt: new Date('2026-06-20T00:00:00.000Z'),
        },
      }),
    );

    await expectErrorCode(
      service.excludeParticipant(actor, 'season-1', 'sp-1', {
        reason: 'late_review',
      }),
      'PARTICIPANT_EXCLUDE_NOT_ALLOWED',
    );
    expect(prisma.seasonParticipant.update).not.toHaveBeenCalled();
    expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'operator.season_participant.exclude.failed',
          result: OperatorAuditResult.failure,
          errorCode: 'PARTICIPANT_EXCLUDE_NOT_ALLOWED',
        }),
      }),
    );
  });

  it('hides and unhides ranking without deleting ranking rows', async () => {
    const { prisma, service } = createService();
    const participant = createParticipant();
    const hiddenAt = new Date('2026-06-21T03:02:00.000Z');
    prisma.seasonParticipant.findFirst
      .mockResolvedValueOnce(participant)
      .mockResolvedValueOnce({
        ...participant,
        rankingHiddenAt: hiddenAt,
        rankingHiddenReason: 'policy_violation',
        rankingHiddenByUserId: actor.userId,
      });
    prisma.seasonParticipant.update
      .mockResolvedValueOnce({
        ...participant,
        rankingHiddenAt: hiddenAt,
        rankingHiddenReason: 'policy_violation',
        rankingHiddenByUserId: actor.userId,
      })
      .mockResolvedValueOnce({
        ...participant,
        rankingHiddenAt: null,
        rankingHiddenReason: null,
        rankingHiddenByUserId: null,
      });

    const hidden = await service.setRankingVisibility(
      actor,
      'season-1',
      'sp-1',
      {
        hidden: true,
        reason: 'policy_violation',
      },
    );
    const visible = await service.setRankingVisibility(
      actor,
      'season-1',
      'sp-1',
      {
        hidden: false,
      },
    );

    expect(hidden.data).toMatchObject({
      rankingHidden: true,
      rankingHiddenAt: hiddenAt.toISOString(),
      reason: 'policy_violation',
    });
    expect(visible.data).toMatchObject({
      rankingHidden: false,
      rankingHiddenAt: null,
      reason: null,
    });
    expect(prisma.seasonRanking.update).not.toHaveBeenCalled();
    expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'operator.season_participant.ranking_hide',
          result: OperatorAuditResult.success,
        }),
      }),
    );
    expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'operator.season_participant.ranking_unhide',
          result: OperatorAuditResult.success,
        }),
      }),
    );
  });

  it('corrects final rank and tier for settled seasons and updates the final ranking row', async () => {
    const { prisma, service } = createService();
    const participant = createParticipant({
      season: {
        id: 'season-1',
        status: SeasonStatus.settled,
        endAt: new Date('2026-06-20T00:00:00.000Z'),
      },
    });
    prisma.seasonParticipant.findFirst.mockResolvedValueOnce(participant);
    prisma.seasonRanking.findFirst
      .mockResolvedValueOnce({
        id: 'ranking-1',
        rank: 3,
        rankingDate,
        capturedAt,
      })
      .mockResolvedValueOnce(null);
    prisma.seasonRanking.update.mockResolvedValueOnce({ id: 'ranking-1' });
    prisma.seasonParticipant.update.mockResolvedValueOnce({
      ...participant,
      currentRank: 2,
      finalRank: 2,
      finalTier: 'gold',
      resultCorrectedAt: now,
      resultCorrectedReason: 'manual_review_adjustment',
      resultCorrectedByUserId: actor.userId,
      updatedAt: now,
    });

    const response = await service.correctFinalResult(
      actor,
      'season-1',
      'sp-1',
      {
        finalRank: 2,
        finalTier: 'gold',
        reason: 'manual_review_adjustment',
      },
    );

    expect(response.data).toMatchObject({
      seasonId: 'season-1',
      seasonParticipantId: 'sp-1',
      finalRank: 2,
      finalTier: 'gold',
      updatedAt: now.toISOString(),
    });
    expect(prisma.seasonRanking.update).toHaveBeenCalledWith({
      where: { id: 'ranking-1' },
      data: { rank: 2 },
      select: { id: true },
    });
    expect(prisma.seasonParticipant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          finalRank: 2,
          currentRank: 2,
          finalTier: 'gold',
          resultCorrectedReason: 'manual_review_adjustment',
        }),
      }),
    );
    expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'operator.season_participant.final_result.correct',
          result: OperatorAuditResult.success,
          metadataJson: expect.objectContaining({
            oldValues: expect.objectContaining({
              finalRank: 3,
              finalTier: 'silver',
            }),
            newValues: expect.objectContaining({
              finalRank: 2,
              finalTier: 'gold',
            }),
          }),
        }),
      }),
    );
  });

  it('returns conflict when final rank is already occupied', async () => {
    const { prisma, service } = createService();
    const participant = createParticipant({
      season: {
        id: 'season-1',
        status: SeasonStatus.settled,
        endAt: new Date('2026-06-20T00:00:00.000Z'),
      },
    });
    prisma.seasonParticipant.findFirst.mockResolvedValueOnce(participant);
    prisma.seasonRanking.findFirst
      .mockResolvedValueOnce({
        id: 'ranking-1',
        rank: 3,
        rankingDate,
        capturedAt,
      })
      .mockResolvedValueOnce({
        id: 'ranking-2',
        seasonParticipantId: 'sp-2',
      });

    await expectErrorCode(
      service.correctFinalResult(actor, 'season-1', 'sp-1', {
        finalRank: 2,
        reason: 'manual_review_adjustment',
      }),
      'FINAL_RANK_CONFLICT',
    );
    expect(prisma.seasonRanking.update).not.toHaveBeenCalled();
    expect(prisma.seasonParticipant.update).not.toHaveBeenCalled();
    expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'operator.season_participant.final_result.correct.failed',
          result: OperatorAuditResult.failure,
          errorCode: 'FINAL_RANK_CONFLICT',
        }),
      }),
    );
  });
});
