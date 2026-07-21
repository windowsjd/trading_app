import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import {
  MarketCalendarMarket,
  MarketSessionOverrideType,
  Prisma,
} from '../generated/prisma/client';
import type { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { hasCalendarYear } from '../orders/market-calendar/market-calendar.registry';
import { MarketSessionOverrideLoaderService } from '../orders/market-calendar/market-session-override.loader.service';
import { OperatorAuditService } from './operator-audit.service';
import type { OperatorRequestContext } from './operator-account-management.service';
import { hasOperatorRole } from './operator.guard';

export type MarketSessionOverrideUpsertBody = {
  market?: unknown;
  localDate?: unknown;
  overrideType?: unknown;
  openTime?: unknown;
  closeTime?: unknown;
  reason?: unknown;
  source?: unknown;
};

export type MarketSessionOverrideUpdateBody = {
  overrideType?: unknown;
  openTime?: unknown;
  closeTime?: unknown;
  reason?: unknown;
  source?: unknown;
};

export type MarketSessionOverrideStatusBody = {
  note?: unknown;
};

export type MarketSessionOverrideListQuery = {
  market?: unknown;
  from?: unknown;
  to?: unknown;
  includeInactive?: unknown;
};

const OVERRIDE_SELECT = {
  id: true,
  market: true,
  localDate: true,
  overrideType: true,
  openTime: true,
  closeTime: true,
  reason: true,
  source: true,
  isActive: true,
  createdByUserId: true,
  updatedByUserId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.MarketSessionOverrideSelect;

type OverrideRecord = Prisma.MarketSessionOverrideGetPayload<{
  select: typeof OVERRIDE_SELECT;
}>;

type ParsedOverrideInput = {
  market: MarketCalendarMarket;
  localDate: string;
  overrideType: MarketSessionOverrideType;
  openTime: string | null; // canonical HHmmss
  closeTime: string | null;
  reason: string;
  source: string | null;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
// Operator convenience: HH:mm or HH:mm:ss. Canonical storage form is the
// static datasets' compact HHmmss.
const TIME_INPUT_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/u;
const MAX_REASON_LENGTH = 200;
const MAX_SOURCE_LENGTH = 500;
const MAX_NOTE_LENGTH = 1_000;
const MAX_LIST_ROWS = 1_000;

@Injectable()
export class OperatorMarketSessionOverrideService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: OperatorAuditService,
    private readonly overrideLoader: MarketSessionOverrideLoaderService,
  ) {}

  async listOverrides(
    actor: AuthenticatedUser | undefined,
    query: MarketSessionOverrideListQuery = {},
  ) {
    this.assertOperator(actor);
    const market = this.parseOptionalMarket(query.market);
    const from = this.parseOptionalDate(query.from, 'from');
    const to = this.parseOptionalDate(query.to, 'to');
    if (from && to && from > to) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_OVERRIDE_QUERY',
        'from must not be after to.',
      );
    }
    const includeInactive = this.parseOptionalBoolean(
      query.includeInactive,
      'includeInactive',
    );

    const overrides = await this.prisma.marketSessionOverride.findMany({
      where: {
        ...(market ? { market } : {}),
        ...(from || to
          ? {
              localDate: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {}),
        ...(includeInactive ? {} : { isActive: true }),
      },
      orderBy: [{ localDate: 'asc' }, { market: 'asc' }],
      take: MAX_LIST_ROWS,
      select: OVERRIDE_SELECT,
    });

    return {
      success: true,
      data: {
        overrides: overrides.map((row) => this.toResponseOverride(row)),
      },
    };
  }

  async getOverride(actor: AuthenticatedUser | undefined, overrideId: string) {
    this.assertOperator(actor);
    const id = this.parseRequiredPathText(overrideId, 'overrideId');
    const override = await this.prisma.marketSessionOverride.findUnique({
      where: { id },
      select: OVERRIDE_SELECT,
    });
    if (!override) {
      this.throwApiError(
        HttpStatus.NOT_FOUND,
        'MARKET_SESSION_OVERRIDE_NOT_FOUND',
        'Market session override not found.',
      );
    }
    return {
      success: true,
      data: { override: this.toResponseOverride(override) },
    };
  }

  /**
   * Creates the override for market+localDate, or replaces the existing row's
   * schedule fields (an inactive row is reactivated). The unique(market,
   * localDate) constraint backs concurrent upserts.
   */
  async upsertOverride(
    actor: AuthenticatedUser | undefined,
    body: MarketSessionOverrideUpsertBody = {},
    context: OperatorRequestContext = {},
  ) {
    this.assertOperator(actor);
    const input = this.parseOverrideInput(body);

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const existing = await tx.marketSessionOverride.findUnique({
          where: {
            market_localDate: {
              market: input.market,
              localDate: input.localDate,
            },
          },
          select: OVERRIDE_SELECT,
        });

        const data = {
          overrideType: input.overrideType,
          openTime: input.openTime,
          closeTime: input.closeTime,
          reason: input.reason,
          source: input.source,
          isActive: true,
          updatedByUserId: actor.userId,
        };
        const saved = existing
          ? await tx.marketSessionOverride.update({
              where: { id: existing.id },
              data,
              select: OVERRIDE_SELECT,
            })
          : await tx.marketSessionOverride.create({
              data: {
                ...data,
                market: input.market,
                localDate: input.localDate,
                createdByUserId: actor.userId,
              },
              select: OVERRIDE_SELECT,
            });

        await this.auditService.recordSuccess(
          {
            actorUserId: actor.userId,
            actorRole: actor.role,
            action: 'operator.market_session_override.upsert',
            targetType: 'market_session_override',
            targetId: saved.id,
            requestId: context.requestId,
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            metadataJson: {
              actorUserId: actor.userId,
              market: saved.market,
              localDate: saved.localDate,
              created: existing === null,
              before: existing ? this.toAuditOverride(existing) : null,
              after: this.toAuditOverride(saved),
              reason: input.reason,
              requestId: context.requestId ?? null,
            },
          },
          tx as Pick<PrismaService, 'operatorAuditLog'>,
        );

        return { saved, created: existing === null };
      });

      const runtimeApplied = await this.refreshRuntime();
      return {
        success: true,
        data: {
          override: this.toResponseOverride(result.saved),
          created: result.created,
          runtimeApplied,
        },
      };
    } catch (error) {
      await this.recordFailureIfNeeded({
        actor,
        action: 'operator.market_session_override.upsert.failed',
        targetId: `${input.market}:${input.localDate}`,
        metadata: {
          market: input.market,
          localDate: input.localDate,
          overrideType: input.overrideType,
          reason: input.reason,
        },
        context,
        error,
      });
      throw this.normalizeError(
        error,
        'MARKET_SESSION_OVERRIDE_UPSERT_FAILED',
        'Market session override upsert failed.',
      );
    }
  }

  async updateOverride(
    actor: AuthenticatedUser | undefined,
    overrideId: string,
    body: MarketSessionOverrideUpdateBody = {},
    context: OperatorRequestContext = {},
  ) {
    this.assertOperator(actor);
    const id = this.parseRequiredPathText(overrideId, 'overrideId');

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const existing = await this.findOverrideOrThrow(tx, id);
        const merged = this.parseOverrideUpdate(existing, body);

        const saved = await tx.marketSessionOverride.update({
          where: { id: existing.id },
          data: {
            overrideType: merged.overrideType,
            openTime: merged.openTime,
            closeTime: merged.closeTime,
            reason: merged.reason,
            source: merged.source,
            updatedByUserId: actor.userId,
          },
          select: OVERRIDE_SELECT,
        });

        await this.auditService.recordSuccess(
          {
            actorUserId: actor.userId,
            actorRole: actor.role,
            action: 'operator.market_session_override.update',
            targetType: 'market_session_override',
            targetId: saved.id,
            requestId: context.requestId,
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            metadataJson: {
              actorUserId: actor.userId,
              market: saved.market,
              localDate: saved.localDate,
              before: this.toAuditOverride(existing),
              after: this.toAuditOverride(saved),
              reason: saved.reason,
              requestId: context.requestId ?? null,
            },
          },
          tx as Pick<PrismaService, 'operatorAuditLog'>,
        );

        return saved;
      });

      const runtimeApplied = await this.refreshRuntime();
      return {
        success: true,
        data: {
          override: this.toResponseOverride(result),
          runtimeApplied,
        },
      };
    } catch (error) {
      await this.recordFailureIfNeeded({
        actor,
        action: 'operator.market_session_override.update.failed',
        targetId: id,
        metadata: { overrideId: id },
        context,
        error,
      });
      throw this.normalizeError(
        error,
        'MARKET_SESSION_OVERRIDE_UPDATE_FAILED',
        'Market session override update failed.',
      );
    }
  }

  async deactivateOverride(
    actor: AuthenticatedUser | undefined,
    overrideId: string,
    body: MarketSessionOverrideStatusBody = {},
    context: OperatorRequestContext = {},
  ) {
    return this.setOverrideActive(actor, overrideId, false, body, context);
  }

  async reactivateOverride(
    actor: AuthenticatedUser | undefined,
    overrideId: string,
    body: MarketSessionOverrideStatusBody = {},
    context: OperatorRequestContext = {},
  ) {
    return this.setOverrideActive(actor, overrideId, true, body, context);
  }

  private async setOverrideActive(
    actor: AuthenticatedUser | undefined,
    overrideId: string,
    isActive: boolean,
    body: MarketSessionOverrideStatusBody,
    context: OperatorRequestContext,
  ) {
    this.assertOperator(actor);
    const id = this.parseRequiredPathText(overrideId, 'overrideId');
    const note = this.parseOptionalText(body.note, MAX_NOTE_LENGTH, 'note');
    const action = isActive
      ? 'operator.market_session_override.reactivate'
      : 'operator.market_session_override.deactivate';

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const existing = await this.findOverrideOrThrow(tx, id);
        if (existing.isActive === isActive) {
          this.throwApiError(
            HttpStatus.CONFLICT,
            isActive
              ? 'MARKET_SESSION_OVERRIDE_ALREADY_ACTIVE'
              : 'MARKET_SESSION_OVERRIDE_ALREADY_INACTIVE',
            isActive
              ? 'Market session override is already active.'
              : 'Market session override is already inactive.',
          );
        }

        const saved = await tx.marketSessionOverride.update({
          where: { id: existing.id },
          data: {
            isActive,
            updatedByUserId: actor.userId,
          },
          select: OVERRIDE_SELECT,
        });

        await this.auditService.recordSuccess(
          {
            actorUserId: actor.userId,
            actorRole: actor.role,
            action,
            targetType: 'market_session_override',
            targetId: saved.id,
            requestId: context.requestId,
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            metadataJson: {
              actorUserId: actor.userId,
              market: saved.market,
              localDate: saved.localDate,
              before: this.toAuditOverride(existing),
              after: this.toAuditOverride(saved),
              reason: saved.reason,
              note,
              requestId: context.requestId ?? null,
            },
          },
          tx as Pick<PrismaService, 'operatorAuditLog'>,
        );

        return saved;
      });

      const runtimeApplied = await this.refreshRuntime();
      return {
        success: true,
        data: {
          override: this.toResponseOverride(result),
          runtimeApplied,
        },
      };
    } catch (error) {
      await this.recordFailureIfNeeded({
        actor,
        action: `${action}.failed`,
        targetId: id,
        metadata: { overrideId: id, note },
        context,
        error,
      });
      throw this.normalizeError(
        error,
        'MARKET_SESSION_OVERRIDE_STATUS_CHANGE_FAILED',
        'Market session override status change failed.',
      );
    }
  }

  private async refreshRuntime(): Promise<boolean> {
    // The mutation is committed; a refresh failure here is recovered by the
    // loader's bounded polling. Surface the outcome so operators can see
    // whether this instance already applied the change.
    try {
      return await this.overrideLoader.refreshNow('operator_mutation');
    } catch {
      return false;
    }
  }

  private async findOverrideOrThrow(
    client: Pick<Prisma.TransactionClient, 'marketSessionOverride'>,
    id: string,
  ): Promise<OverrideRecord> {
    const override = await client.marketSessionOverride.findUnique({
      where: { id },
      select: OVERRIDE_SELECT,
    });
    if (!override) {
      this.throwApiError(
        HttpStatus.NOT_FOUND,
        'MARKET_SESSION_OVERRIDE_NOT_FOUND',
        'Market session override not found.',
      );
    }
    return override;
  }

  private parseOverrideInput(
    body: MarketSessionOverrideUpsertBody,
  ): ParsedOverrideInput {
    const market = this.parseMarket(body.market);
    const localDate = this.parseLocalDate(body.localDate);
    const overrideType = this.parseOverrideType(body.overrideType);
    const openTime = this.parseOptionalTime(body.openTime, 'openTime');
    const closeTime = this.parseOptionalTime(body.closeTime, 'closeTime');
    const reason = this.parseReason(body.reason);
    const source = this.parseOptionalText(
      body.source,
      MAX_SOURCE_LENGTH,
      'source',
    );
    return this.validateOverrideShape({
      market,
      localDate,
      overrideType,
      openTime,
      closeTime,
      reason,
      source,
    });
  }

  private parseOverrideUpdate(
    existing: OverrideRecord,
    body: MarketSessionOverrideUpdateBody,
  ): ParsedOverrideInput {
    const has = (key: keyof MarketSessionOverrideUpdateBody) => key in body;
    const overrideType = has('overrideType')
      ? this.parseOverrideType(body.overrideType)
      : existing.overrideType;
    // When the type changes to regular/closed, stale stored times must not
    // survive the merge; explicit keys always win.
    const changingToTimeless =
      overrideType !== MarketSessionOverrideType.custom;
    const openTime = has('openTime')
      ? this.parseOptionalTime(body.openTime, 'openTime')
      : changingToTimeless
        ? null
        : existing.openTime;
    const closeTime = has('closeTime')
      ? this.parseOptionalTime(body.closeTime, 'closeTime')
      : changingToTimeless
        ? null
        : existing.closeTime;
    const reason = has('reason')
      ? this.parseReason(body.reason)
      : existing.reason;
    const source = has('source')
      ? this.parseOptionalText(body.source, MAX_SOURCE_LENGTH, 'source')
      : existing.source;
    return this.validateOverrideShape({
      market: existing.market,
      localDate: existing.localDate,
      overrideType,
      openTime,
      closeTime,
      reason,
      source,
    });
  }

  private validateOverrideShape(
    input: ParsedOverrideInput,
  ): ParsedOverrideInput {
    if (input.overrideType === MarketSessionOverrideType.custom) {
      if (!input.openTime || !input.closeTime) {
        this.throwApiError(
          HttpStatus.BAD_REQUEST,
          'OVERRIDE_TIME_REQUIRED',
          'custom overrides require both openTime and closeTime.',
        );
      }
      if (input.openTime >= input.closeTime) {
        this.throwApiError(
          HttpStatus.BAD_REQUEST,
          'OVERRIDE_TIME_ORDER_INVALID',
          'openTime must be earlier than closeTime.',
        );
      }
    } else if (input.openTime !== null || input.closeTime !== null) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'OVERRIDE_TIME_NOT_ALLOWED',
        'regular and closed overrides must not include session times.',
      );
    }

    // The session policy never opens weekends (weekday short-circuit), so a
    // regular/custom override on Sat/Sun would be silently ineffective —
    // reject it instead of storing a no-op. closed on a weekend is harmless.
    if (
      input.overrideType !== MarketSessionOverrideType.closed &&
      this.isWeekend(input.localDate)
    ) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'MARKET_SESSION_OVERRIDE_WEEKEND_UNSUPPORTED',
        'regular and custom overrides are not supported on weekends.',
      );
    }
    return input;
  }

  private parseMarket(value: unknown): MarketCalendarMarket {
    if (
      value === MarketCalendarMarket.KRX ||
      value === MarketCalendarMarket.US
    ) {
      return value;
    }
    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'INVALID_MARKET',
      'market must be KRX or US.',
    );
  }

  private parseOptionalMarket(value: unknown): MarketCalendarMarket | null {
    if (value === undefined || value === null || value === '') return null;
    return this.parseMarket(value);
  }

  private parseLocalDate(value: unknown): string {
    if (typeof value === 'string' && DATE_PATTERN.test(value)) {
      const year = Number(value.slice(0, 4));
      const month = Number(value.slice(5, 7));
      const day = Number(value.slice(8, 10));
      const check = new Date(Date.UTC(year, month - 1, day));
      if (
        year >= 2000 &&
        year <= 2100 &&
        check.getUTCFullYear() === year &&
        check.getUTCMonth() === month - 1 &&
        check.getUTCDate() === day
      ) {
        return value;
      }
    }
    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'INVALID_LOCAL_DATE',
      'localDate must be a valid YYYY-MM-DD calendar date.',
    );
  }

  private parseOptionalDate(value: unknown, fieldName: string): string | null {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'string' && DATE_PATTERN.test(value)) return value;
    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'INVALID_OVERRIDE_QUERY',
      `${fieldName} must be a YYYY-MM-DD date.`,
    );
  }

  private parseOverrideType(value: unknown): MarketSessionOverrideType {
    if (
      value === MarketSessionOverrideType.regular ||
      value === MarketSessionOverrideType.closed ||
      value === MarketSessionOverrideType.custom
    ) {
      return value;
    }
    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'INVALID_OVERRIDE_TYPE',
      'overrideType must be regular, closed, or custom.',
    );
  }

  private parseOptionalTime(value: unknown, fieldName: string): string | null {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'string') {
      const match = TIME_INPUT_PATTERN.exec(value.trim());
      if (match) {
        return `${match[1]}${match[2]}${match[3] ?? '00'}`;
      }
    }
    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'INVALID_OVERRIDE_TIME',
      `${fieldName} must be HH:mm or HH:mm:ss.`,
    );
  }

  private parseReason(value: unknown): string {
    if (typeof value === 'string') {
      const text = value.trim();
      if (text.length > 0 && text.length <= MAX_REASON_LENGTH) {
        return text;
      }
    }
    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'INVALID_OVERRIDE_REASON',
      `reason is required (1-${MAX_REASON_LENGTH} characters).`,
    );
  }

  private parseOptionalText(
    value: unknown,
    maxLength: number,
    fieldName: string,
  ): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value === 'string') {
      const text = value.trim();
      if (text.length === 0) return null;
      if (text.length <= maxLength) return text;
    }
    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'INVALID_OVERRIDE_TEXT',
      `${fieldName} must be a string of at most ${maxLength} characters.`,
    );
  }

  private parseOptionalBoolean(value: unknown, fieldName: string): boolean {
    if (value === undefined || value === null || value === '') return false;
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'INVALID_OVERRIDE_QUERY',
      `${fieldName} must be true or false.`,
    );
  }

  private parseRequiredPathText(value: string, fieldName: string): string {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_OVERRIDE_ID',
        `${fieldName} is required.`,
      );
    }
    return text;
  }

  private isWeekend(localDate: string): boolean {
    const weekday = new Date(`${localDate}T00:00:00.000Z`).getUTCDay();
    return weekday === 0 || weekday === 6;
  }

  private toResponseOverride(override: OverrideRecord) {
    return {
      id: override.id,
      market: override.market,
      localDate: override.localDate,
      overrideType: override.overrideType,
      openTime: this.formatTime(override.openTime),
      closeTime: this.formatTime(override.closeTime),
      reason: override.reason,
      source: override.source,
      isActive: override.isActive,
      calendarYearCovered: hasCalendarYear(
        override.market as 'KRX' | 'US',
        Number(override.localDate.slice(0, 4)),
      ),
      createdByUserId: override.createdByUserId,
      updatedByUserId: override.updatedByUserId,
      createdAt: override.createdAt.toISOString(),
      updatedAt: override.updatedAt.toISOString(),
    };
  }

  private toAuditOverride(override: OverrideRecord) {
    return {
      overrideType: override.overrideType,
      openTime: override.openTime,
      closeTime: override.closeTime,
      reason: override.reason,
      source: override.source,
      isActive: override.isActive,
    };
  }

  private formatTime(value: string | null): string | null {
    if (!value) return null;
    return `${value.slice(0, 2)}:${value.slice(2, 4)}:${value.slice(4, 6)}`;
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
    targetId: string;
    metadata: Record<string, unknown>;
    context: OperatorRequestContext;
    error: unknown;
  }) {
    try {
      const errorCode = this.isUniqueConstraintError(input.error)
        ? 'MARKET_SESSION_OVERRIDE_CONFLICT'
        : input.error instanceof HttpException
          ? this.extractErrorCode(input.error)
          : 'MARKET_SESSION_OVERRIDE_MUTATION_FAILED';

      await this.auditService.recordFailure({
        actorUserId: input.actor.userId,
        actorRole: input.actor.role,
        action: input.action,
        targetType: 'market_session_override',
        targetId: input.targetId,
        requestId: input.context.requestId,
        ipAddress: input.context.ipAddress,
        userAgent: input.context.userAgent,
        metadataJson: {
          actorUserId: input.actor.userId,
          ...input.metadata,
          failureCode: errorCode,
          requestId: input.context.requestId ?? null,
        },
        errorCode,
      });
    } catch {
      return;
    }
  }

  private normalizeError(
    error: unknown,
    fallbackCode: string,
    fallbackMessage: string,
  ) {
    if (error instanceof HttpException) {
      return error;
    }
    if (this.isUniqueConstraintError(error)) {
      return new HttpException(
        this.errorBody(
          'MARKET_SESSION_OVERRIDE_CONFLICT',
          'An override for this market and date already exists.',
        ),
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
    return 'MARKET_SESSION_OVERRIDE_MUTATION_FAILED';
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (error as { code?: unknown } | null)?.code === 'P2002';
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
