import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { createApiError } from '../common/api-error';
import type { ImportantNotice, Prisma } from '../generated/prisma/client';
import type { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { OperatorAuditService } from '../operator/operator-audit.service';

export type NoticeSection = { heading: string; paragraphs: string[] };

export type OperatorRequestContext = {
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,100}$/;
const SECTIONS_MAX_CHARS = 30_000;
/** Path parameter shape of a notice id (uuid); anything else is not found. */
const NOTICE_ID = /^[A-Za-z0-9-]{1,64}$/;
/** Unconfirmed popup notices one read returns, newest first. */
export const POPUP_NOTICE_LIMIT = 5;

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

/** The app's notice shape: 1–20 sections of a heading and 1–30 paragraphs. */
export function parseNoticeSections(value: unknown): NoticeSection[] | null {
  if (!Array.isArray(value) || !value.length || value.length > 20) return null;
  const sections: NoticeSection[] = [];
  for (const item of value) {
    const heading = text((item as { heading?: unknown } | null)?.heading, 100);
    const raw = (item as { paragraphs?: unknown } | null)?.paragraphs;
    if (!heading || !Array.isArray(raw) || !raw.length || raw.length > 30)
      return null;
    const paragraphs = raw.map((paragraph) => text(paragraph, 2_000));
    if (paragraphs.some((paragraph) => paragraph === null)) return null;
    sections.push({ heading, paragraphs: paragraphs as string[] });
  }
  return JSON.stringify(sections).length <= SECTIONS_MAX_CHARS
    ? sections
    : null;
}

export function noticeSourceKey(noticeId: string): string {
  return `notice:${noticeId}`;
}

function present(row: ImportantNotice) {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    sections: row.sections as NoticeSection[],
    publishedAt: row.publishedAt?.toISOString() ?? null,
  };
}

/**
 * Important notices (docs/push-notifications-contract.md §4): the minimal
 * server record that makes "an operator explicitly published this as an
 * important notice" checkable. A static notice in the app bundle or an app
 * update never creates one. Create → review → publish (explicit
 * `confirm: true`, once) → optional withdraw; each step is audited in the
 * same transaction. The push fan-out reads only `published` rows.
 */
@Injectable()
export class ImportantNoticesService {
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

  /** App read: published notices, newest first. */
  async listPublished() {
    const rows = await this.prisma.importantNotice.findMany({
      where: { status: 'published' },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take: 50,
    });
    return { success: true, data: { notices: rows.map(present) } };
  }

  /**
   * App read for the entry popup (2026-11-13): published notices marked
   * `showPopup` that THIS member has not confirmed, newest first. Withdrawn
   * notices and drafts never appear; push preferences play no part.
   */
  async listPopupFor(user: AuthenticatedUser | undefined) {
    const actor = this.actor(user);
    const rows = await this.prisma.importantNotice.findMany({
      where: {
        status: 'published',
        showPopup: true,
        acknowledgements: { none: { userId: actor.userId } },
      },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take: POPUP_NOTICE_LIMIT,
      select: { id: true, title: true, summary: true, publishedAt: true },
    });
    return {
      success: true,
      data: {
        notices: rows.map((row) => ({
          id: row.id,
          title: row.title,
          summary: row.summary,
          publishedAt: row.publishedAt?.toISOString() ?? null,
        })),
      },
    };
  }

  /**
   * The member confirmed (or closed) a notice's popup. Idempotent: the first
   * confirmation is the one kept (ON CONFLICT DO NOTHING), so a retry after a
   * lost response or two devices at once never add a second row. Only for the
   * signed-in member and a notice that was published (a withdrawn one is still
   * accepted — it may have been on screen when it was withdrawn).
   */
  async acknowledge(user: AuthenticatedUser | undefined, noticeId: string) {
    const actor = this.actor(user);
    const notice = NOTICE_ID.test(noticeId)
      ? await this.prisma.importantNotice.findUnique({
          where: { id: noticeId },
          select: { status: true },
        })
      : null;
    if (!notice || notice.status === 'draft')
      this.fail(HttpStatus.NOT_FOUND, 'NOTICE_NOT_FOUND', 'Notice not found.');
    await this.prisma.importantNoticeAcknowledgement.createMany({
      data: [{ userId: actor.userId, noticeId }],
      skipDuplicates: true,
    });
    const row =
      await this.prisma.importantNoticeAcknowledgement.findUniqueOrThrow({
        where: { userId_noticeId: { userId: actor.userId, noticeId } },
        select: { acknowledgedAt: true },
      });
    return {
      success: true,
      data: { noticeId, acknowledgedAt: row.acknowledgedAt.toISOString() },
    };
  }

  async create(
    user: AuthenticatedUser | undefined,
    body: unknown,
    context: OperatorRequestContext,
  ) {
    const actor = this.actor(user);
    try {
      return await this.createNotice(actor, body, context);
    } catch (error) {
      await this.auditFailure(
        actor,
        'operator.notice.create',
        null,
        context,
        error,
      );
      throw error;
    }
  }

  private async createNotice(
    actor: AuthenticatedUser,
    body: unknown,
    context: OperatorRequestContext,
  ) {
    const input = body as Record<string, unknown> | null;
    const title = text(input?.title, 100);
    const summary = text(input?.summary, 200);
    const sections = parseNoticeSections(input?.sections);
    const idempotencyKey =
      typeof input?.idempotencyKey === 'string' &&
      IDEMPOTENCY_KEY.test(input.idempotencyKey)
        ? input.idempotencyKey
        : null;
    // Optional, strictly boolean (2026-11-13); absent = no popup, as before.
    const showPopup =
      input?.showPopup === undefined
        ? false
        : typeof input.showPopup === 'boolean'
          ? input.showPopup
          : null;
    if (
      !title ||
      !summary ||
      !sections ||
      !idempotencyKey ||
      showPopup === null
    )
      this.fail(
        HttpStatus.BAD_REQUEST,
        'INVALID_NOTICE',
        'A title, a summary, sections and an idempotency key are required.',
      );
    const where = {
      createdByUserId_idempotencyKey: {
        createdByUserId: actor.userId,
        idempotencyKey,
      },
    };
    const replay = (row: ImportantNotice) => {
      if (
        row.title !== title ||
        row.summary !== summary ||
        row.showPopup !== showPopup ||
        JSON.stringify(row.sections) !== JSON.stringify(sections)
      )
        this.fail(
          HttpStatus.CONFLICT,
          'NOTICE_IDEMPOTENCY_CONFLICT',
          'This idempotency key was already used for different content.',
        );
      return { success: true, data: { notice: this.operatorView(row) } };
    };
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.importantNotice.findUnique({ where });
        if (existing) return replay(existing);
        const row = await tx.importantNotice.create({
          data: {
            title,
            summary,
            sections: sections as Prisma.InputJsonValue,
            idempotencyKey,
            createdByUserId: actor.userId,
            showPopup,
          },
        });
        await this.audit.recordSuccess(
          {
            actorUserId: actor.userId,
            actorRole: actor.role,
            action: 'operator.notice.create',
            targetType: 'important_notice',
            targetId: row.id,
            ...context,
            metadataJson: { sectionCount: sections.length, showPopup },
          },
          tx,
        );
        return { success: true, data: { notice: this.operatorView(row) } };
      });
    } catch (error) {
      const existing =
        (error as { code?: unknown } | null)?.code === 'P2002'
          ? await this.prisma.importantNotice.findUnique({ where })
          : null;
      if (existing) return replay(existing);
      throw error;
    }
  }

  async listForOperator(user: AuthenticatedUser | undefined) {
    this.actor(user);
    const rows = await this.prisma.importantNotice.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
    });
    const counts = rows.length
      ? await this.prisma.pushNotification.groupBy({
          by: ['sourceKey', 'status'],
          where: {
            type: 'important_notice',
            sourceKey: { in: rows.map((row) => noticeSourceKey(row.id)) },
          },
          _count: { _all: true },
        })
      : [];
    return {
      success: true,
      data: {
        notices: rows.map((row) => ({
          ...this.operatorView(row),
          delivery: Object.fromEntries(
            counts
              .filter((count) => count.sourceKey === noticeSourceKey(row.id))
              .map((count) => [count.status, count._count._all]),
          ),
        })),
      },
    };
  }

  async publish(
    user: AuthenticatedUser | undefined,
    noticeId: string,
    body: unknown,
    context: OperatorRequestContext,
  ) {
    const actor = this.actor(user);
    if ((body as { confirm?: unknown } | null)?.confirm !== true)
      this.fail(
        HttpStatus.BAD_REQUEST,
        'NOTICE_PUBLISH_CONFIRMATION_REQUIRED',
        'Confirm publishing: it pushes the notice to users.',
      );
    return this.transition(
      actor,
      noticeId,
      context,
      'publish',
      async (tx, now) =>
        tx.importantNotice.updateMany({
          where: { id: noticeId, status: 'draft' },
          data: {
            status: 'published',
            publishedAt: now,
            publishedByUserId: actor.userId,
          },
        }),
    );
  }

  async withdraw(
    user: AuthenticatedUser | undefined,
    noticeId: string,
    context: OperatorRequestContext,
  ) {
    const actor = this.actor(user);
    return this.transition(
      actor,
      noticeId,
      context,
      'withdraw',
      async (tx, now) => {
        const updated = await tx.importantNotice.updateMany({
          where: { id: noticeId, status: 'published' },
          data: {
            status: 'withdrawn',
            withdrawnAt: now,
            withdrawnByUserId: actor.userId,
          },
        });
        if (updated.count)
          // Unsent pushes stop; a send already in flight is re-checked by the
          // dispatcher before it goes out.
          await tx.pushNotification.updateMany({
            where: {
              type: 'important_notice',
              sourceKey: noticeSourceKey(noticeId),
              status: 'pending',
            },
            data: { status: 'skipped', skipReason: 'source_withdrawn' },
          });
        return updated;
      },
    );
  }

  private async transition(
    actor: AuthenticatedUser,
    noticeId: string,
    context: OperatorRequestContext,
    verb: 'publish' | 'withdraw',
    write: (
      tx: Prisma.TransactionClient,
      now: Date,
    ) => Promise<{ count: number }>,
  ) {
    const action = `operator.notice.${verb}`;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        const updated = await write(tx, now);
        if (!updated.count) {
          const row = await tx.importantNotice.findUnique({
            where: { id: noticeId },
            select: { status: true },
          });
          if (!row)
            this.fail(
              HttpStatus.NOT_FOUND,
              'NOTICE_NOT_FOUND',
              'Notice not found.',
            );
          if (row.status === 'withdrawn')
            this.fail(
              HttpStatus.CONFLICT,
              'NOTICE_WITHDRAWN',
              'The notice was withdrawn.',
            );
          this.fail(
            HttpStatus.CONFLICT,
            verb === 'publish'
              ? 'NOTICE_ALREADY_PUBLISHED'
              : 'NOTICE_NOT_PUBLISHED',
            verb === 'publish'
              ? 'The notice is already published.'
              : 'The notice is not published.',
          );
        }
        await this.audit.recordSuccess(
          {
            actorUserId: actor.userId,
            actorRole: actor.role,
            action,
            targetType: 'important_notice',
            targetId: noticeId,
            ...context,
          },
          tx,
        );
        const row = await tx.importantNotice.findUniqueOrThrow({
          where: { id: noticeId },
        });
        return { success: true, data: { notice: this.operatorView(row) } };
      });
    } catch (error) {
      await this.auditFailure(actor, action, noticeId, context, error);
      throw error;
    }
  }

  /** Best effort: a failed attempt is audited outside its rolled-back
   * transaction with its error code only. */
  private async auditFailure(
    actor: AuthenticatedUser,
    action: string,
    targetId: string | null,
    context: OperatorRequestContext,
    error: unknown,
  ) {
    const code =
      error instanceof HttpException
        ? ((error.getResponse() as { error?: { code?: string } })?.error
            ?.code ?? 'NOTICE_OPERATION_FAILED')
        : 'NOTICE_OPERATION_FAILED';
    await this.audit
      .recordFailure({
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: `${action}.failed`,
        targetType: 'important_notice',
        targetId,
        ...context,
        errorCode: code,
      })
      .catch(() => undefined);
  }

  private operatorView(row: ImportantNotice) {
    return {
      ...present(row),
      showPopup: row.showPopup,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      createdByUserId: row.createdByUserId,
      publishedByUserId: row.publishedByUserId,
      withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
      withdrawnByUserId: row.withdrawnByUserId,
      fanoutCompletedAt: row.fanoutCompletedAt?.toISOString() ?? null,
    };
  }
}
