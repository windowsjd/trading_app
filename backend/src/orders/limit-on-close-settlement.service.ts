import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RankingRefreshService } from '../ranking/ranking-refresh.service';
import { apiErrorCode } from '../common/api-error-code';
import {
  readLimitOnCloseConfig,
  type LimitOnCloseConfig,
} from './limit-on-close.config';
import {
  decideLimitOnClose,
  LOC_DECISION_REASONS,
  resolveBoundLimitOnCloseSession,
  sessionDateText,
} from './limit-on-close.policy';
import {
  KoscomSessionCloseSource,
  LimitOnCloseEvidenceService,
  sessionCloseFailure,
  type SessionCloseEvidenceRow,
  type SessionCloseTarget,
} from './limit-on-close-evidence.service';
import { LimitOrderExecutionService } from './limit-order-execution.service';
import { LimitOrderCancelService } from './limit-order-cancel.service';
import { resolveStockMarketSessionState } from './market-calendar.policy';
import type { LimitOrderCancelReason } from './limit-order-policy';

const DEFAULT_BATCH_SIZE = 200;

const PENDING_INCLUDE = {
  order: {
    select: {
      side: true,
      limitPrice: true,
      submittedAt: true,
    },
  },
  asset: {
    select: {
      id: true,
      symbol: true,
      market: true,
      assetType: true,
    },
  },
} as const;

type PendingLimitOnClose = Prisma.LimitOnCloseOrderGetPayload<{
  include: typeof PENDING_INCLUDE;
}>;

export type LimitOnCloseCycleSummary = {
  candidates: number;
  groups: number;
  observations: number;
  observationFailures: Record<string, number>;
  filled: number;
  unfilled: number;
  expired: Record<string, number>;
  skipped: Record<string, number>;
  waiting: number;
  errors: Record<string, number>;
};

/**
 * One bounded LOC settlement cycle. PostgreSQL pending rows are the work
 * queue; no per-order timer, Redis state or provider stream. Close evidence
 * is fetched OUTSIDE every financial transaction, once per asset/session and
 * confirmation interval. Fills reuse the limit fill transaction (lifecycle
 * locks, pinned fee, reservation settle, ledger, position, equity snapshot);
 * every no-fill outcome releases through the ordinary cancel core.
 */
@Injectable()
export class LimitOnCloseSettlementService {
  private readonly logger = new Logger(LimitOnCloseSettlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly evidence: LimitOnCloseEvidenceService,
    private readonly source: KoscomSessionCloseSource,
    private readonly execution: LimitOrderExecutionService,
    private readonly cancel: LimitOrderCancelService,
    @Optional()
    private readonly rankingRefresh?: RankingRefreshService,
  ) {}

  /** Cheap idle probe: a pending LOC whose stored session close has passed. */
  async hasDueWork(): Promise<boolean> {
    const now = await this.dbNow();
    const row = await this.prisma.limitOnCloseOrder.findFirst({
      where: { status: 'pending', sessionCloseAt: { lte: now } },
      select: { orderId: true },
    });
    return row !== null;
  }

  async runCycle(
    input: {
      config?: LimitOnCloseConfig;
      batchSize?: number;
      isLockOwned?: () => boolean;
    } = {},
  ): Promise<LimitOnCloseCycleSummary> {
    const config = input.config ?? readLimitOnCloseConfig();
    const now = await this.dbNow();
    const rows = await this.prisma.limitOnCloseOrder.findMany({
      where: { status: 'pending', sessionCloseAt: { lte: now } },
      orderBy: [{ sessionCloseAt: 'asc' }, { orderId: 'asc' }],
      take: input.batchSize ?? DEFAULT_BATCH_SIZE,
      include: PENDING_INCLUDE,
    });
    const summary: LimitOnCloseCycleSummary = {
      candidates: rows.length,
      groups: 0,
      observations: 0,
      observationFailures: {},
      filled: 0,
      unfilled: 0,
      expired: {},
      skipped: {},
      waiting: 0,
      errors: {},
    };
    const groups = new Map<string, PendingLimitOnClose[]>();
    for (const row of rows) {
      const key = `${row.assetId}|${row.market}|${sessionDateText(row.sessionDate)}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    for (const group of groups.values()) {
      if (input.isLockOwned && !input.isLockOwned()) break;
      summary.groups += 1;
      await this.settleGroup(group, config, summary);
    }
    return summary;
  }

  private async settleGroup(
    rows: PendingLimitOnClose[],
    config: LimitOnCloseConfig,
    summary: LimitOnCloseCycleSummary,
  ) {
    const first = rows[0];
    const now = await this.dbNow();
    const calendar = resolveStockMarketSessionState(first.asset, now);
    if (!calendar || calendar.state === 'calendar_unavailable') {
      // An unknown calendar never authorizes a fill; the deadline still releases.
      for (const row of rows)
        if (now >= row.evidenceDeadlineAt)
          await this.release(
            row,
            'expired',
            LOC_DECISION_REASONS.fillNotPermitted,
            null,
            summary,
          );
        else summary.waiting += 1;
      return;
    }
    const bound: Array<{ row: PendingLimitOnClose; closeTime: Date }> = [];
    for (const row of rows) {
      const session = resolveBoundLimitOnCloseSession(
        row.asset,
        row.order.submittedAt,
        row.sessionDate,
      );
      if (session) bound.push({ row, closeTime: session.closeTime });
      else
        await this.release(
          row,
          'expired',
          LOC_DECISION_REASONS.sessionInvalid,
          null,
          summary,
        );
    }
    if (!bound.length) return;
    const closeTime = bound[0].closeTime;
    if (now < closeTime) {
      summary.waiting += bound.length;
      return;
    }
    const target: SessionCloseTarget = {
      assetId: first.assetId,
      symbol: first.asset.symbol,
      assetMarket: first.asset.market,
      market: first.market,
      sessionDate: first.sessionDate,
      sessionCloseAt: closeTime,
    };
    let evidence = await this.evidence.find(target);
    const deadline = Math.min(
      ...bound.map(({ row }) => row.evidenceDeadlineAt.getTime()),
    );
    // One provider request per asset/session per confirmation interval,
    // successful or not.
    const lastAttempt = Math.max(
      evidence?.lastObservedAt.getTime() ?? 0,
      ...bound.map(({ row }) => row.lastCheckedAt?.getTime() ?? 0),
    );
    if (
      evidence?.status !== 'final' &&
      now.getTime() >= closeTime.getTime() + config.evidenceMinDelayMs &&
      now.getTime() < deadline &&
      now.getTime() - lastAttempt >= config.evidenceConfirmMs
    ) {
      try {
        const observation = await this.source.observe(target);
        evidence = await this.evidence.recordObservation(
          target,
          observation,
          config.evidenceConfirmMs,
        );
        summary.observations += 1;
        await this.recordCheck(
          bound,
          evidence?.status === 'final'
            ? 'SESSION_CLOSE_FINAL'
            : 'SESSION_CLOSE_OBSERVED',
        );
      } catch (error) {
        const code = sessionCloseFailure(error);
        count(summary.observationFailures, code);
        await this.recordCheck(bound, code);
      }
    }
    for (const { row } of bound) {
      if (evidence?.status === 'final')
        await this.settleRow(row, evidence, summary);
      else if (now >= row.evidenceDeadlineAt)
        await this.release(
          row,
          'expired',
          LOC_DECISION_REASONS.evidenceUnavailable,
          evidence,
          summary,
        );
      else summary.waiting += 1;
    }
  }

  private async settleRow(
    row: PendingLimitOnClose,
    evidence: NonNullable<SessionCloseEvidenceRow>,
    summary: LimitOnCloseCycleSummary,
  ) {
    if (
      !row.order.limitPrice ||
      decideLimitOnClose(
        row.order.side,
        row.order.limitPrice,
        evidence.closePrice,
      ) !== 'fill'
    ) {
      await this.release(
        row,
        'unfilled',
        LOC_DECISION_REASONS.closeNotReached,
        evidence,
        summary,
      );
      return;
    }
    try {
      const outcome = await this.execution.fillLimitOrder({
        orderId: row.orderId,
        plan: {
          path: 'session_close',
          executedPrice: evidence.closePrice,
          closeEvidenceId: evidence.id,
        },
      });
      if (outcome.state === 'filled') {
        summary.filled += 1;
        if (outcome.seasonId && outcome.seasonParticipantId)
          this.refreshRanking(outcome.seasonId, outcome.seasonParticipantId);
        return;
      }
      count(summary.skipped, outcome.reason);
      await this.recordCheck(
        [{ row }],
        `FILL_SKIPPED_${outcome.reason.toUpperCase()}`,
      );
    } catch (error) {
      const code = apiErrorCode(error, 'LOC_FILL_FAILED');
      count(summary.errors, code);
      await this.recordCheck([{ row }], code);
    }
    // A blocked fill (Season/participant/account/asset/calendar) never keeps
    // the reservation past the deadline.
    if ((await this.dbNow()) >= row.evidenceDeadlineAt)
      await this.release(
        row,
        'expired',
        LOC_DECISION_REASONS.fillNotPermitted,
        evidence,
        summary,
      );
  }

  private async release(
    row: PendingLimitOnClose,
    status: 'unfilled' | 'expired',
    reason: LimitOrderCancelReason,
    evidence: SessionCloseEvidenceRow | null,
    summary: LimitOnCloseCycleSummary,
  ) {
    try {
      const released = await this.prisma.$transaction(async (tx) => {
        const now = await this.dbNow(tx);
        return this.cancel.decideLimitOnCloseWithoutFillInTransaction(tx, {
          orderId: row.orderId,
          status,
          reason,
          now,
          evidence:
            evidence?.status === 'final'
              ? { id: evidence.id, closePrice: evidence.closePrice }
              : null,
        });
      });
      if (!released) return;
      if (status === 'unfilled') summary.unfilled += 1;
      else count(summary.expired, reason);
    } catch (error) {
      const code = apiErrorCode(error, 'LOC_RELEASE_FAILED');
      count(summary.errors, code);
      await this.recordCheck([{ row }], code);
    }
  }

  private async recordCheck(
    rows: Array<{ row: PendingLimitOnClose }>,
    code: string,
  ) {
    const now = await this.dbNow();
    await this.prisma.limitOnCloseOrder.updateMany({
      where: {
        orderId: { in: rows.map(({ row }) => row.orderId) },
        status: 'pending',
      },
      data: { lastCheckCode: code.slice(0, 100), lastCheckedAt: now },
    });
  }

  private refreshRanking(seasonId: string, seasonParticipantId: string) {
    if (!this.rankingRefresh) return;
    void this.rankingRefresh
      .refreshCurrentRankingAfterParticipantChange(
        seasonId,
        seasonParticipantId,
      )
      .catch(() =>
        this.logger.error(
          JSON.stringify({
            event: 'limit_on_close_fill_ranking_refresh_failed',
            seasonId,
            seasonParticipantId,
          }),
        ),
      );
  }

  private async dbNow(
    client: Pick<Prisma.TransactionClient, '$queryRaw'> = this.prisma,
  ) {
    const [row] = await client.$queryRaw<
      Array<{ now: Date }>
    >`SELECT clock_timestamp() AS "now"`;
    return row.now;
  }
}

function count(target: Record<string, number>, key: string) {
  target[key] = (target[key] ?? 0) + 1;
}
