import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import {
  ParticipantStatus,
  Prisma,
  SeasonRankingType,
  SeasonStatus,
  UserRole,
} from '../generated/prisma/client';
import type { AuthenticatedUser } from '../auth/auth.types';
import { LimitOrderCancelService } from '../orders/limit-order-cancel.service';
import { LIMIT_ORDER_CANCEL_REASONS } from '../orders/limit-order-policy';
import { PrismaService } from '../prisma/prisma.service';
import { OperatorAuditService } from './operator-audit.service';
import type { OperatorRequestContext } from './operator-account-management.service';
import { hasOperatorRole } from './operator.guard';

export type SeasonParticipantExcludeBody = {
  reason?: unknown;
  note?: unknown;
};

export type SeasonParticipantRankingVisibilityBody = {
  hidden?: unknown;
  reason?: unknown;
  note?: unknown;
};

export type SeasonParticipantFinalResultBody = {
  finalRank?: unknown;
  finalTier?: unknown;
  reason?: unknown;
  note?: unknown;
};

const MODERATED_PARTICIPANT_SELECT = {
  id: true,
  seasonId: true,
  userId: true,
  participantStatus: true,
  totalAssetKrw: true,
  totalReturnRate: true,
  maxDrawdown: true,
  totalFillCount: true,
  currentRank: true,
  finalRank: true,
  finalTier: true,
  excludedAt: true,
  excludedReason: true,
  excludedByUserId: true,
  rankingHiddenAt: true,
  rankingHiddenReason: true,
  rankingHiddenByUserId: true,
  resultCorrectedAt: true,
  resultCorrectedReason: true,
  resultCorrectedByUserId: true,
  updatedAt: true,
  season: {
    select: {
      id: true,
      status: true,
      endAt: true,
    },
  },
} satisfies Prisma.SeasonParticipantSelect;

type ModeratedParticipant = Prisma.SeasonParticipantGetPayload<{
  select: typeof MODERATED_PARTICIPANT_SELECT;
}>;

type ModerationTransactionClient = Pick<
  Prisma.TransactionClient,
  'operatorAuditLog' | 'seasonParticipant' | 'seasonRanking'
>;

type FinalRankingRow = {
  id: string;
  rank: number;
  rankingDate: Date;
  capturedAt: Date;
};

@Injectable()
export class OperatorSeasonModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: OperatorAuditService,
    private readonly limitOrderCancelService?: LimitOrderCancelService,
  ) {}

  async excludeParticipant(
    actor: AuthenticatedUser | undefined,
    seasonId: string,
    seasonParticipantId: string,
    body: SeasonParticipantExcludeBody = {},
    context: OperatorRequestContext = {},
  ) {
    const target = this.parseTarget(seasonId, seasonParticipantId);
    const reason = this.parseOptionalText(body.reason, 120);
    const note = this.parseOptionalText(body.note, 1_000);
    this.assertOperator(actor);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const participant = await this.findParticipantOrThrow(tx, target);
        this.assertExcludeAllowed(participant);

        const now = new Date();
        const updated = await tx.seasonParticipant.update({
          where: {
            id: participant.id,
          },
          data: {
            participantStatus: ParticipantStatus.excluded,
            excludedAt: participant.excludedAt ?? now,
            excludedReason: reason,
            excludedByUserId: actor.userId,
            currentRank: null,
          },
          select: MODERATED_PARTICIPANT_SELECT,
        });

        // Same transaction as the exclusion: cancel the participant's
        // submitted limit-buy orders and release their cash reservations so
        // no reserved cash outlives the exclusion. New orders are already
        // blocked by the excluded participant status.
        const limitCleanup = this.limitOrderCancelService
          ? await this.limitOrderCancelService.cancelOpenLimitBuysForParticipantInTransaction(
              tx,
              {
                seasonParticipantId: participant.id,
                reason: LIMIT_ORDER_CANCEL_REASONS.participantExcluded,
                canceledAt: now,
              },
            )
          : { canceledOrderCount: 0, releasedReservationCount: 0 };

        await this.auditService.recordSuccess(
          {
            actorUserId: actor.userId,
            actorRole: actor.role,
            action: 'operator.season_participant.exclude',
            targetType: 'season_participant',
            targetId: participant.id,
            requestId: context.requestId,
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            metadataJson: {
              actorUserId: actor.userId,
              seasonId: participant.seasonId,
              seasonParticipantId: participant.id,
              participantUserId: participant.userId,
              beforeStatus: participant.participantStatus,
              afterStatus: updated.participantStatus,
              excludedAt: updated.excludedAt?.toISOString() ?? null,
              canceledLimitOrderCount: limitCleanup.canceledOrderCount,
              reason,
              note,
              requestId: context.requestId ?? null,
            },
          },
          tx as Pick<PrismaService, 'operatorAuditLog'>,
        );

        return {
          success: true,
          data: {
            seasonId: updated.seasonId,
            seasonParticipantId: updated.id,
            status: updated.participantStatus,
            excludedAt: updated.excludedAt?.toISOString() ?? null,
            reason: updated.excludedReason,
          },
        };
      });
    } catch (error) {
      await this.recordFailureIfNeeded({
        actor,
        action: 'operator.season_participant.exclude.failed',
        target,
        reason,
        note,
        context,
        error,
      });
      throw this.normalizeModerationError(
        error,
        'PARTICIPANT_EXCLUDE_FAILED',
        'Season participant exclusion failed.',
      );
    }
  }

  async setRankingVisibility(
    actor: AuthenticatedUser | undefined,
    seasonId: string,
    seasonParticipantId: string,
    body: SeasonParticipantRankingVisibilityBody = {},
    context: OperatorRequestContext = {},
  ) {
    const target = this.parseTarget(seasonId, seasonParticipantId);
    const hidden = this.parseHidden(body.hidden);
    const reason = this.parseOptionalText(body.reason, 120);
    const note = this.parseOptionalText(body.note, 1_000);
    this.assertOperator(actor);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const participant = await this.findParticipantOrThrow(tx, target);
        const now = new Date();
        const updated = await tx.seasonParticipant.update({
          where: {
            id: participant.id,
          },
          data: hidden
            ? {
                rankingHiddenAt: participant.rankingHiddenAt ?? now,
                rankingHiddenReason: reason,
                rankingHiddenByUserId: actor.userId,
              }
            : {
                rankingHiddenAt: null,
                rankingHiddenReason: null,
                rankingHiddenByUserId: null,
              },
          select: MODERATED_PARTICIPANT_SELECT,
        });

        await this.auditService.recordSuccess(
          {
            actorUserId: actor.userId,
            actorRole: actor.role,
            action: hidden
              ? 'operator.season_participant.ranking_hide'
              : 'operator.season_participant.ranking_unhide',
            targetType: 'season_participant',
            targetId: participant.id,
            requestId: context.requestId,
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            metadataJson: {
              actorUserId: actor.userId,
              seasonId: participant.seasonId,
              seasonParticipantId: participant.id,
              participantUserId: participant.userId,
              beforeRankingHidden: participant.rankingHiddenAt !== null,
              afterRankingHidden: updated.rankingHiddenAt !== null,
              beforeRankingHiddenAt:
                participant.rankingHiddenAt?.toISOString() ?? null,
              afterRankingHiddenAt:
                updated.rankingHiddenAt?.toISOString() ?? null,
              reason,
              note,
              requestId: context.requestId ?? null,
            },
          },
          tx as Pick<PrismaService, 'operatorAuditLog'>,
        );

        return {
          success: true,
          data: {
            seasonId: updated.seasonId,
            seasonParticipantId: updated.id,
            rankingHidden: updated.rankingHiddenAt !== null,
            rankingHiddenAt: updated.rankingHiddenAt?.toISOString() ?? null,
            reason: updated.rankingHiddenReason,
          },
        };
      });
    } catch (error) {
      await this.recordFailureIfNeeded({
        actor,
        action: 'operator.season_participant.ranking_visibility.failed',
        target,
        reason,
        note,
        context,
        error,
      });
      throw this.normalizeModerationError(
        error,
        'RANKING_VISIBILITY_UPDATE_FAILED',
        'Season participant ranking visibility update failed.',
      );
    }
  }

  async correctFinalResult(
    actor: AuthenticatedUser | undefined,
    seasonId: string,
    seasonParticipantId: string,
    body: SeasonParticipantFinalResultBody = {},
    context: OperatorRequestContext = {},
  ) {
    const target = this.parseTarget(seasonId, seasonParticipantId);
    const finalRank = this.parseOptionalFinalRank(body.finalRank);
    const finalTier = this.parseOptionalFinalTier(body, 'finalTier');
    const reason = this.parseOptionalText(body.reason, 120);
    const note = this.parseOptionalText(body.note, 1_000);
    this.assertOperator(actor);

    if (finalRank === undefined && finalTier === undefined) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'FINAL_RESULT_CHANGE_REQUIRED',
        'finalRank or finalTier is required.',
      );
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const participant = await this.findParticipantOrThrow(tx, target);
        this.assertFinalResultCorrectionAllowed(participant);

        const rankingBefore = await this.findLatestFinalRankingForParticipant(
          tx,
          participant.seasonId,
          participant.id,
        );
        let finalRankingChange:
          | {
              action: 'none' | 'created' | 'updated';
              id: string | null;
              beforeRank: number | null;
              afterRank: number | null;
              rankingDate: string | null;
            }
          | undefined;

        if (finalRank !== undefined) {
          finalRankingChange = await this.upsertFinalRankingRank(tx, {
            participant,
            requestedRank: finalRank,
            existingRanking: rankingBefore,
          });
        }

        const now = new Date();
        const updated = await tx.seasonParticipant.update({
          where: {
            id: participant.id,
          },
          data: {
            ...(finalRank !== undefined
              ? {
                  finalRank,
                  currentRank: finalRank,
                }
              : {}),
            ...(finalTier !== undefined ? { finalTier } : {}),
            resultCorrectedAt: now,
            resultCorrectedReason: reason,
            resultCorrectedByUserId: actor.userId,
          },
          select: MODERATED_PARTICIPANT_SELECT,
        });

        await this.auditService.recordSuccess(
          {
            actorUserId: actor.userId,
            actorRole: actor.role,
            action: 'operator.season_participant.final_result.correct',
            targetType: 'season_participant',
            targetId: participant.id,
            requestId: context.requestId,
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            metadataJson: {
              actorUserId: actor.userId,
              seasonId: participant.seasonId,
              seasonParticipantId: participant.id,
              participantUserId: participant.userId,
              oldValues: {
                finalRank: participant.finalRank,
                finalTier: participant.finalTier,
                currentRank: participant.currentRank,
              },
              newValues: {
                finalRank: updated.finalRank,
                finalTier: updated.finalTier,
                currentRank: updated.currentRank,
              },
              finalRankingChange: finalRankingChange ?? {
                action: 'none',
                id: rankingBefore?.id ?? null,
                beforeRank: rankingBefore?.rank ?? null,
                afterRank: rankingBefore?.rank ?? null,
                rankingDate: rankingBefore
                  ? this.formatDateOnly(rankingBefore.rankingDate)
                  : null,
              },
              reason,
              note,
              requestId: context.requestId ?? null,
            },
          },
          tx as Pick<PrismaService, 'operatorAuditLog'>,
        );

        return {
          success: true,
          data: {
            seasonId: updated.seasonId,
            seasonParticipantId: updated.id,
            finalRank: updated.finalRank,
            finalTier: updated.finalTier,
            updatedAt: updated.updatedAt.toISOString(),
          },
        };
      });
    } catch (error) {
      await this.recordFailureIfNeeded({
        actor,
        action: 'operator.season_participant.final_result.correct.failed',
        target,
        reason,
        note,
        context,
        error,
      });
      throw this.normalizeModerationError(
        error,
        this.isUniqueConstraintError(error)
          ? 'FINAL_RANK_CONFLICT'
          : 'FINAL_RESULT_CORRECTION_FAILED',
        this.isUniqueConstraintError(error)
          ? 'Final rank conflicts with another participant.'
          : 'Season participant final result correction failed.',
      );
    }
  }

  private async findParticipantOrThrow(
    client: Pick<Prisma.TransactionClient, 'seasonParticipant'>,
    input: { seasonId: string; seasonParticipantId: string },
  ): Promise<ModeratedParticipant> {
    const participant = await client.seasonParticipant.findFirst({
      where: {
        id: input.seasonParticipantId,
        seasonId: input.seasonId,
      },
      select: MODERATED_PARTICIPANT_SELECT,
    });

    if (!participant) {
      this.throwApiError(
        HttpStatus.NOT_FOUND,
        'SEASON_PARTICIPANT_NOT_FOUND',
        'Season participant not found.',
      );
    }

    return participant;
  }

  private assertExcludeAllowed(participant: ModeratedParticipant) {
    if (participant.participantStatus === ParticipantStatus.excluded) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'PARTICIPANT_ALREADY_EXCLUDED',
        'Season participant is already excluded.',
      );
    }

    if (
      participant.season.status === SeasonStatus.active ||
      participant.season.status === SeasonStatus.ended
    ) {
      return;
    }

    this.throwApiError(
      HttpStatus.CONFLICT,
      'PARTICIPANT_EXCLUDE_NOT_ALLOWED',
      'Season participant exclusion is allowed only for active or ended seasons.',
    );
  }

  private assertFinalResultCorrectionAllowed(
    participant: ModeratedParticipant,
  ) {
    if (
      participant.season.status === SeasonStatus.ended ||
      participant.season.status === SeasonStatus.settled
    ) {
      return;
    }

    this.throwApiError(
      HttpStatus.CONFLICT,
      'FINAL_RESULT_CORRECTION_NOT_ALLOWED',
      'Final result correction is allowed only for ended or settled seasons.',
    );
  }

  private async upsertFinalRankingRank(
    client: ModerationTransactionClient,
    input: {
      participant: ModeratedParticipant;
      requestedRank: number;
      existingRanking: FinalRankingRow | null;
    },
  ) {
    const rankingMetadata =
      input.existingRanking ??
      (await this.findLatestFinalRankingMetadata(
        client,
        input.participant.seasonId,
      ));
    const rankingDate =
      rankingMetadata?.rankingDate ??
      this.toDateOnly(input.participant.season.endAt);
    const capturedAt = rankingMetadata?.capturedAt ?? new Date();

    const conflict = await client.seasonRanking.findFirst({
      where: {
        seasonId: input.participant.seasonId,
        rankType: SeasonRankingType.final,
        rankingDate,
        rank: input.requestedRank,
        NOT: {
          seasonParticipantId: input.participant.id,
        },
      },
      select: {
        id: true,
        seasonParticipantId: true,
      },
    });

    if (conflict) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'FINAL_RANK_CONFLICT',
        'Final rank conflicts with another participant.',
      );
    }

    if (input.existingRanking) {
      if (input.existingRanking.rank === input.requestedRank) {
        return {
          action: 'none' as const,
          id: input.existingRanking.id,
          beforeRank: input.existingRanking.rank,
          afterRank: input.requestedRank,
          rankingDate: this.formatDateOnly(input.existingRanking.rankingDate),
        };
      }

      await client.seasonRanking.update({
        where: {
          id: input.existingRanking.id,
        },
        data: {
          rank: input.requestedRank,
        },
        select: {
          id: true,
        },
      });

      return {
        action: 'updated' as const,
        id: input.existingRanking.id,
        beforeRank: input.existingRanking.rank,
        afterRank: input.requestedRank,
        rankingDate: this.formatDateOnly(input.existingRanking.rankingDate),
      };
    }

    const created = await client.seasonRanking.create({
      data: {
        seasonId: input.participant.seasonId,
        seasonParticipantId: input.participant.id,
        rankType: SeasonRankingType.final,
        rank: input.requestedRank,
        totalAssetKrw: input.participant.totalAssetKrw,
        returnRate: input.participant.totalReturnRate,
        maxDrawdown: input.participant.maxDrawdown,
        totalFillCount: input.participant.totalFillCount,
        reachedReturnAt: null,
        rankingDate,
        capturedAt,
      },
      select: {
        id: true,
      },
    });

    return {
      action: 'created' as const,
      id: created.id,
      beforeRank: null,
      afterRank: input.requestedRank,
      rankingDate: this.formatDateOnly(rankingDate),
    };
  }

  private async findLatestFinalRankingForParticipant(
    client: Pick<Prisma.TransactionClient, 'seasonRanking'>,
    seasonId: string,
    seasonParticipantId: string,
  ): Promise<FinalRankingRow | null> {
    return client.seasonRanking.findFirst({
      where: {
        seasonId,
        seasonParticipantId,
        rankType: SeasonRankingType.final,
      },
      orderBy: [
        { rankingDate: 'desc' },
        { capturedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      select: {
        id: true,
        rank: true,
        rankingDate: true,
        capturedAt: true,
      },
    });
  }

  private async findLatestFinalRankingMetadata(
    client: Pick<Prisma.TransactionClient, 'seasonRanking'>,
    seasonId: string,
  ) {
    return client.seasonRanking.findFirst({
      where: {
        seasonId,
        rankType: SeasonRankingType.final,
      },
      orderBy: [
        { rankingDate: 'desc' },
        { capturedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      select: {
        rankingDate: true,
        capturedAt: true,
      },
    });
  }

  private parseTarget(seasonId: string, seasonParticipantId: string) {
    return {
      seasonId: this.parseRequiredPathText(
        seasonId,
        'INVALID_SEASON_ID',
        'seasonId',
      ),
      seasonParticipantId: this.parseRequiredPathText(
        seasonParticipantId,
        'INVALID_SEASON_PARTICIPANT_ID',
        'seasonParticipantId',
      ),
    };
  }

  private parseHidden(value: unknown): boolean {
    if (typeof value === 'boolean') {
      return value;
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'INVALID_RANKING_HIDDEN',
      'hidden must be a boolean.',
    );
  }

  private parseOptionalFinalRank(value: unknown): number | undefined {
    if (value === undefined) {
      return undefined;
    }

    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && /^\d+$/.test(value.trim())
          ? Number(value.trim())
          : Number.NaN;

    if (
      Number.isSafeInteger(parsed) &&
      parsed > 0 &&
      parsed <= 1_000_000
    ) {
      return parsed;
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'INVALID_FINAL_RANK',
      'finalRank must be a positive safe integer.',
    );
  }

  private parseOptionalFinalTier(
    body: SeasonParticipantFinalResultBody,
    key: 'finalTier',
  ): string | null | undefined {
    if (!Object.prototype.hasOwnProperty.call(body, key)) {
      return undefined;
    }

    if (body.finalTier === null) {
      return null;
    }

    if (typeof body.finalTier === 'string') {
      const text = body.finalTier.trim();
      if (text.length > 0 && text.length <= 100) {
        return text;
      }
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'INVALID_FINAL_TIER',
      'finalTier must be a non-empty string or null.',
    );
  }

  private parseOptionalText(value: unknown, maxLength: number): string | null {
    if (value === undefined || value === null) {
      return null;
    }

    if (typeof value !== 'string') {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_MODERATION_TEXT',
        'Moderation text fields must be strings.',
      );
    }

    const text = value.trim();
    return text.length === 0 ? null : text.slice(0, maxLength);
  }

  private parseRequiredPathText(value: string, code: string, fieldName: string) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        code,
        `${fieldName} is required.`,
      );
    }

    return text;
  }

  private assertOperator(
    actor: AuthenticatedUser | undefined,
  ): asserts actor is AuthenticatedUser {
    if (!actor || !hasOperatorRole(actor.role)) {
      throw new ForbiddenException(
        this.errorBody('OPERATOR_REQUIRED', 'Operator role is required.'),
      );
    }
  }

  private async recordFailureIfNeeded(input: {
    actor: AuthenticatedUser;
    action: string;
    target: { seasonId: string; seasonParticipantId: string };
    reason: string | null;
    note: string | null;
    context: OperatorRequestContext;
    error: unknown;
  }) {
    try {
      const errorCode =
        this.isUniqueConstraintError(input.error)
          ? 'FINAL_RANK_CONFLICT'
          : input.error instanceof HttpException
            ? this.extractErrorCode(input.error)
            : 'OPERATOR_SEASON_MODERATION_FAILED';

      await this.auditService.recordFailure({
        actorUserId: input.actor.userId,
        actorRole: input.actor.role,
        action: input.action,
        targetType: 'season_participant',
        targetId: input.target.seasonParticipantId,
        requestId: input.context.requestId,
        ipAddress: input.context.ipAddress,
        userAgent: input.context.userAgent,
        metadataJson: {
          actorUserId: input.actor.userId,
          seasonId: input.target.seasonId,
          seasonParticipantId: input.target.seasonParticipantId,
          reason: input.reason,
          note: input.note,
          failureCode: errorCode,
          requestId: input.context.requestId ?? null,
        },
        errorCode,
      });
    } catch {
      return;
    }
  }

  private normalizeModerationError(
    error: unknown,
    fallbackCode: string,
    fallbackMessage: string,
  ) {
    if (error instanceof HttpException) {
      return error;
    }

    if (this.isUniqueConstraintError(error)) {
      return new HttpException(
        this.errorBody('FINAL_RANK_CONFLICT', 'Final rank conflict.'),
        HttpStatus.CONFLICT,
      );
    }

    return new InternalServerErrorException(
      this.errorBody(fallbackCode, fallbackMessage),
    );
  }

  private extractErrorCode(error: HttpException) {
    const response = error.getResponse();
    if (
      typeof response === 'object' &&
      response !== null &&
      'error' in response &&
      typeof response.error === 'object' &&
      response.error !== null &&
      'code' in response.error &&
      typeof response.error.code === 'string'
    ) {
      return response.error.code;
    }

    return 'OPERATOR_SEASON_MODERATION_FAILED';
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (error as { code?: unknown }).code === 'P2002';
  }

  private toDateOnly(date: Date) {
    return new Date(`${date.toISOString().slice(0, 10)}T00:00:00.000Z`);
  }

  private formatDateOnly(date: Date) {
    return date.toISOString().slice(0, 10);
  }

  private throwApiError(
    status: HttpStatus,
    code: string,
    message: string,
  ): never {
    throw new HttpException(this.errorBody(code, message), status);
  }

  private errorBody(code: string, message: string) {
    return {
      success: false,
      error: {
        code,
        message,
      },
    };
  }
}
