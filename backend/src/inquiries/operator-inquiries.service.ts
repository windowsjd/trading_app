import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import type { AuthenticatedUser } from '../auth/auth.types';
import { createApiError } from '../common/api-error';
import { buildPagination } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { OperatorAuditService } from '../operator/operator-audit.service';
import type { OperatorRequestContext } from '../operator/operator-account-management.service';
import { hasControlCharacter, type InquiryStatus } from './inquiries.service';

/** Same upper bound as the inquiry body: one screen of text in the app. */
export const INQUIRY_ANSWER_LIMITS = { min: 2, max: 2000 } as const;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,100}$/;
const INQUIRY_STATUSES: readonly InquiryStatus[] = ['pending', 'answered'];

export type OperatorInquiriesQuery = {
  status?: string;
  limit?: string;
  offset?: string;
};

const SELECT = {
  id: true,
  category: true,
  title: true,
  content: true,
  createdAt: true,
  user: { select: { id: true, nickname: true, status: true } },
  answer: {
    select: {
      content: true,
      answeredAt: true,
      answeredByUserId: true,
      // Read to recognise a retry; never presented.
      idempotencyKey: true,
    },
  },
} satisfies Prisma.InquirySelect;

type Row = Prisma.InquiryGetPayload<{ select: typeof SELECT }>;

function present({ answer, ...row }: Row) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    status: (answer ? 'answered' : 'pending') as InquiryStatus,
    answer: answer
      ? {
          content: answer.content,
          answeredAt: answer.answeredAt.toISOString(),
          answeredByUserId: answer.answeredByUserId,
        }
      : null,
  };
}

/**
 * Operator/admin side of support inquiries (docs/inquiries-contract.md §3).
 * Reads are audited like the admin user reads (personal content). An answer
 * is one `inquiry_answers` row per inquiry: the unique `inquiry_id` makes a
 * second answer — another operator's, or a concurrent one — fail instead of
 * overwriting, and the inquiry row itself is never written. The answer and
 * its success audit commit in one transaction. The same operator retrying
 * with the same idempotency key and text gets the stored answer back.
 */
@Injectable()
export class OperatorInquiriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: OperatorAuditService,
  ) {}

  private fail(status: HttpStatus, code: string, message: string): never {
    throw createApiError(code, message, status);
  }

  private actor(user: AuthenticatedUser | undefined): AuthenticatedUser {
    if (!user)
      this.fail(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', 'Unauthorized');
    return user;
  }

  private integer(
    value: string | undefined,
    fallback: number,
    min: number,
    max: number,
  ) {
    if (value === undefined || value === '') return fallback;
    const parsed = /^\d+$/.test(value) ? Number(value) : NaN;
    if (!(parsed >= min && parsed <= max))
      this.fail(
        HttpStatus.BAD_REQUEST,
        'INVALID_PAGINATION',
        'Invalid pagination.',
      );
    return parsed;
  }

  /** `pending` lists the oldest waiting first (a queue); `answered` the
   * latest answers first; no filter lists the newest inquiries first. */
  async list(
    user: AuthenticatedUser | undefined,
    query: OperatorInquiriesQuery = {},
    context: OperatorRequestContext = {},
  ) {
    const actor = this.actor(user);
    const status = query.status || undefined;
    if (status !== undefined && !INQUIRY_STATUSES.includes(status as never))
      this.fail(
        HttpStatus.BAD_REQUEST,
        'INVALID_INQUIRY_STATUS',
        'Status must be pending or answered.',
      );
    const limit = this.integer(query.limit, 20, 1, 50);
    const offset = this.integer(query.offset, 0, 0, 10_000);
    const where: Prisma.InquiryWhereInput =
      status === 'pending'
        ? { answer: { is: null } }
        : status === 'answered'
          ? { answer: { isNot: null } }
          : {};
    const orderBy: Prisma.InquiryOrderByWithRelationInput[] =
      status === 'pending'
        ? [{ createdAt: 'asc' }, { id: 'asc' }]
        : status === 'answered'
          ? [{ answer: { answeredAt: 'desc' } }, { id: 'desc' }]
          : [{ createdAt: 'desc' }, { id: 'desc' }];
    const [rows, total] = await Promise.all([
      this.prisma.inquiry.findMany({
        where,
        orderBy,
        take: limit,
        skip: offset,
        select: SELECT,
      }),
      this.prisma.inquiry.count({ where }),
    ]);
    await this.recordRead(actor, 'operator.inquiries.list', null, context, {
      status: status ?? null,
      limit,
      offset,
      resultCount: rows.length,
    });
    return {
      success: true as const,
      data: {
        inquiries: rows.map(present),
        pagination: buildPagination({
          limit,
          offset,
          total,
          returned: rows.length,
        }),
      },
    };
  }

  async get(
    user: AuthenticatedUser | undefined,
    inquiryId: string,
    context: OperatorRequestContext = {},
  ) {
    const actor = this.actor(user);
    const row = await this.find(this.prisma, inquiryId);
    await this.recordRead(actor, 'operator.inquiry.get', row.id, context);
    return { success: true as const, data: { inquiry: present(row) } };
  }

  async answer(
    user: AuthenticatedUser | undefined,
    inquiryId: string,
    body: unknown,
    context: OperatorRequestContext = {},
  ) {
    const actor = this.actor(user);
    try {
      return await this.writeAnswer(actor, inquiryId, body, context);
    } catch (error) {
      await this.recordFailure(actor, inquiryId, context, error);
      throw error;
    }
  }

  private parseAnswer(body: unknown) {
    const input = (
      body && typeof body === 'object' && !Array.isArray(body) ? body : {}
    ) as Record<string, unknown>;
    const raw = typeof input.content === 'string' ? input.content.trim() : null;
    const length = raw === null ? 0 : [...raw].length;
    const idempotencyKey =
      typeof input.idempotencyKey === 'string' &&
      IDEMPOTENCY_KEY.test(input.idempotencyKey)
        ? input.idempotencyKey
        : null;
    if (
      raw === null ||
      length < INQUIRY_ANSWER_LIMITS.min ||
      length > INQUIRY_ANSWER_LIMITS.max ||
      hasControlCharacter(raw) ||
      !idempotencyKey
    )
      this.fail(
        HttpStatus.BAD_REQUEST,
        'INVALID_INQUIRY_ANSWER',
        'An answer of 2-2000 characters and an idempotency key are required.',
      );
    return { content: raw, idempotencyKey };
  }

  private async writeAnswer(
    actor: AuthenticatedUser,
    inquiryId: string,
    body: unknown,
    context: OperatorRequestContext,
  ) {
    const input = this.parseAnswer(body);
    let result: { inquiry: ReturnType<typeof present>; replayed: boolean };
    try {
      result = await this.prisma.$transaction(async (tx) => {
        const current = await this.find(tx, inquiryId);
        if (current.answer) return this.settle(actor, current, input);
        await tx.inquiryAnswer.create({
          data: {
            inquiryId: current.id,
            answeredByUserId: actor.userId,
            idempotencyKey: input.idempotencyKey,
            content: input.content,
          },
        });
        await this.audit.recordSuccess(
          {
            actorUserId: actor.userId,
            actorRole: actor.role,
            action: 'operator.inquiry.answer',
            targetType: 'inquiry',
            targetId: current.id,
            ...context,
            // Length only: neither the inquiry nor the answer text is logged.
            metadataJson: { answerLength: [...input.content].length },
          },
          tx,
        );
        const row = await this.find(tx, current.id);
        return { inquiry: present(row), replayed: false };
      });
    } catch (error) {
      // Another answer committed first (a concurrent operator or a retry).
      if ((error as { code?: unknown } | null)?.code !== 'P2002') throw error;
      const row = await this.find(this.prisma, inquiryId);
      if (!row.answer) throw error;
      result = this.settle(actor, row, input);
    }
    // After the transaction: a replay changed nothing, its audit is best effort.
    if (result.replayed)
      await this.audit
        .recordSuccess({
          actorUserId: actor.userId,
          actorRole: actor.role,
          action: 'operator.inquiry.answer.replay',
          targetType: 'inquiry',
          targetId: result.inquiry.id,
          ...context,
        })
        .catch(() => undefined);
    return { success: true as const, data: result };
  }

  /** An inquiry that already has its answer: the same operator's retry of
   * the same request replays it, anything else is a conflict. */
  private settle(
    actor: AuthenticatedUser,
    row: Row,
    input: { content: string; idempotencyKey: string },
  ) {
    const existing = row.answer!;
    const sameRequest =
      existing.answeredByUserId === actor.userId &&
      existing.idempotencyKey === input.idempotencyKey;
    if (sameRequest && existing.content !== input.content)
      this.fail(
        HttpStatus.CONFLICT,
        'INQUIRY_ANSWER_IDEMPOTENCY_CONFLICT',
        'This idempotency key was already used for a different answer.',
      );
    if (!sameRequest)
      this.fail(
        HttpStatus.CONFLICT,
        'INQUIRY_ALREADY_ANSWERED',
        'The inquiry has already been answered.',
      );
    return { inquiry: present(row), replayed: true };
  }

  private async find(
    client: Pick<PrismaService, 'inquiry'>,
    inquiryId: string,
  ): Promise<Row> {
    const row =
      typeof inquiryId === 'string' && inquiryId && inquiryId.length <= 100
        ? await client.inquiry.findUnique({
            where: { id: inquiryId },
            select: SELECT,
          })
        : null;
    if (!row)
      this.fail(
        HttpStatus.NOT_FOUND,
        'INQUIRY_NOT_FOUND',
        'Inquiry not found.',
      );
    return row;
  }

  private async recordRead(
    actor: AuthenticatedUser,
    action: string,
    targetId: string | null,
    context: OperatorRequestContext,
    metadataJson?: Record<string, unknown>,
  ) {
    await this.audit
      .recordSuccess({
        actorUserId: actor.userId,
        actorRole: actor.role,
        action,
        targetType: targetId ? 'inquiry' : null,
        targetId,
        ...context,
        metadataJson,
      })
      .catch(() => undefined);
  }

  /** Best effort, outside the rolled-back transaction, error code only. */
  private async recordFailure(
    actor: AuthenticatedUser,
    inquiryId: string,
    context: OperatorRequestContext,
    error: unknown,
  ) {
    const code =
      error instanceof HttpException
        ? ((error.getResponse() as { error?: { code?: string } })?.error
            ?.code ?? 'INQUIRY_ANSWER_FAILED')
        : 'INQUIRY_ANSWER_FAILED';
    await this.audit
      .recordFailure({
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: 'operator.inquiry.answer.failed',
        targetType: 'inquiry',
        targetId:
          typeof inquiryId === 'string' && inquiryId.length <= 100
            ? inquiryId
            : null,
        ...context,
        errorCode: code,
      })
      .catch(() => undefined);
  }
}
