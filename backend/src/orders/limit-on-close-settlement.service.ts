import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UsdKrwRefreshService } from '../providers/usd-krw-refresh.service';
import { RankingRefreshService } from '../ranking/ranking-refresh.service';
import { apiErrorCode } from '../common/api-error-code';
import {
  readLimitOnCloseConfig,
  type LimitOnCloseConfig,
} from './limit-on-close.config';
import {
  decideLimitOnClose,
  LOC_DECISION_REASONS,
  limitOnCloseDeadlinePassed,
  limitOnCloseObservationPolicy,
  resolveBoundLimitOnCloseSession,
  sessionDateText,
} from './limit-on-close.policy';
import {
  LimitOnCloseEvidenceService,
  SESSION_CLOSE_PROVIDERS,
  SessionCloseSources,
  sessionCloseFailure,
  type SessionCloseEvidenceRow,
  type SessionCloseSource,
  type SessionCloseTarget,
} from './limit-on-close-evidence.service';
import { LimitOrderExecutionService } from './limit-order-execution.service';
import { LimitOrderCancelService } from './limit-order-cancel.service';
import { resolveStockMarketSessionState } from './market-calendar.policy';
import type { LimitOrderCancelReason } from './limit-order-policy';

const DEFAULT_BATCH_SIZE = 200;
/** US close audit: one more Tiingo read this long after finalization… */
const POST_FINAL_AUDIT_AFTER_MS = 6 * 60 * 60_000;
/** …while the evidence is at most this old (restart/outage slack). */
const POST_FINAL_AUDIT_WINDOW_MS = 72 * 60 * 60_000;
const POST_FINAL_AUDIT_BATCH = 25;
/** Audit reads share the settlement cycle: they never hold it up longer. */
const POST_FINAL_AUDIT_BUDGET_MS = 10_000;

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
  /** US final evidence re-read after finalization (ids; restart-safe audit marks). */
  postFinalAudited: string[];
  /** A later Tiingo value that differs from the final close: diagnosis only. */
  postFinalCorrections: Array<{
    evidenceId: string;
    assetId: string;
    sessionDate: string;
    finalClose: string;
    observedClose: string;
  }>;
  postFinalAuditFailures: Record<string, number>;
};

/**
 * One bounded LOC settlement cycle. PostgreSQL pending rows are the work
 * queue; no per-order timer, Redis state or provider stream. Close evidence
 * is fetched OUTSIDE every financial transaction, once per asset/session and
 * confirmation interval, from that market's own provider (KRX: KOSCOM; US:
 * Tiingo end-of-day, not before the configured New York time). Fills reuse
 * the limit fill transaction (lifecycle locks, pinned fee, reservation
 * settle, ledger, position, equity snapshot); every no-fill outcome releases
 * through the ordinary cancel core.
 */
@Injectable()
export class LimitOnCloseSettlementService {
  private readonly logger = new Logger(LimitOnCloseSettlementService.name);
  /** Evidence ids already audited (loaded once from recent run summaries). */
  private audited: Set<string> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly evidence: LimitOnCloseEvidenceService,
    @Inject(SessionCloseSources)
    private readonly source: SessionCloseSource,
    private readonly execution: LimitOrderExecutionService,
    private readonly cancel: LimitOrderCancelService,
    @Optional()
    private readonly rankingRefresh?: RankingRefreshService,
    @Optional()
    private readonly usdKrwRefresh?: UsdKrwRefreshService,
  ) {}

  /** Cheap idle probe: a pending LOC whose stored session close has passed,
   * or US final close evidence due for its post-final audit. */
  async hasDueWork(): Promise<boolean> {
    const now = await this.dbNow();
    const row = await this.prisma.limitOnCloseOrder.findFirst({
      where: { status: 'pending', sessionCloseAt: { lte: now } },
      select: { orderId: true },
    });
    if (row) return true;
    const audited = await this.auditedEvidenceIds(now);
    return (await this.dueUsCloseAudits(now, audited)).length > 0;
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
      postFinalAudited: [],
      postFinalCorrections: [],
      postFinalAuditFailures: {},
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
    if (!input.isLockOwned || input.isLockOwned())
      await this.auditFinalUsCloses(now, summary, input.isLockOwned);
    return summary;
  }

  /**
   * Tiingo may correct an end-of-day close after our finality window (its
   * documentation: corrections until 20:00 EST). Each US final close is read
   * once more, 6–72 h after finalization. A different value is recorded for
   * operations (`LOC_US_CLOSE_CORRECTED_AFTER_FINAL`, the run summary) — the
   * final evidence row, fills and ledger are never rewritten.
   */
  private async auditFinalUsCloses(
    now: Date,
    summary: LimitOnCloseCycleSummary,
    isLockOwned?: () => boolean,
  ) {
    const audited = await this.auditedEvidenceIds(now);
    // Diagnostics only, inside the same single-flight cycle as KRX and US
    // settlement (US audits come due during the KRX LOC window): a slow or
    // failing Tiingo stops the audit, never delays the next settlement.
    const startedMs = Date.now();
    for (const evidence of await this.dueUsCloseAudits(now, audited)) {
      if (summary.postFinalAudited.length >= POST_FINAL_AUDIT_BATCH) break;
      if (Date.now() - startedMs >= POST_FINAL_AUDIT_BUDGET_MS) break;
      if (isLockOwned && !isLockOwned()) break;
      audited.add(evidence.id);
      summary.postFinalAudited.push(evidence.id);
      try {
        const observation = await this.source.observe({
          assetId: evidence.assetId,
          symbol: evidence.asset.symbol,
          assetMarket: evidence.asset.market,
          market: 'US',
          sessionDate: evidence.sessionDate,
          sessionCloseAt: evidence.sessionCloseAt,
        });
        if (observation.closePrice.eq(evidence.closePrice)) continue;
        const correction = {
          evidenceId: evidence.id,
          assetId: evidence.assetId,
          sessionDate: sessionDateText(evidence.sessionDate),
          finalClose: evidence.closePrice.toFixed(),
          observedClose: observation.closePrice.toFixed(),
        };
        summary.postFinalCorrections.push(correction);
        this.logger.warn(
          JSON.stringify({
            event: 'LOC_US_CLOSE_CORRECTED_AFTER_FINAL',
            ...correction,
          }),
        );
      } catch (error) {
        count(summary.postFinalAuditFailures, sessionCloseFailure(error));
      }
    }
  }

  /** Due audits not yet done (excluded in the query, so already audited
   * rows never crowd out newer ones). */
  private dueUsCloseAudits(now: Date, audited: ReadonlySet<string>) {
    return this.prisma.sessionClosePriceEvidence.findMany({
      where: {
        market: 'US',
        provider: SESSION_CLOSE_PROVIDERS.US,
        status: 'final',
        finalizedAt: {
          gte: new Date(now.getTime() - POST_FINAL_AUDIT_WINDOW_MS),
          lte: new Date(now.getTime() - POST_FINAL_AUDIT_AFTER_MS),
        },
        ...(audited.size > 0 ? { id: { notIn: [...audited] } } : {}),
      },
      orderBy: [{ finalizedAt: 'asc' }, { id: 'asc' }],
      take: POST_FINAL_AUDIT_BATCH,
      select: {
        id: true,
        assetId: true,
        sessionDate: true,
        sessionCloseAt: true,
        closePrice: true,
        asset: { select: { symbol: true, market: true } },
      },
    });
  }

  /** Audit marks survive restarts: they are the ids in recent run summaries. */
  private async auditedEvidenceIds(now: Date): Promise<Set<string>> {
    if (this.audited) return this.audited;
    const runs = await this.prisma.opsJobRun.findMany({
      where: {
        jobName: 'limit_on_close_settlement',
        startedAt: {
          gte: new Date(
            now.getTime() - POST_FINAL_AUDIT_WINDOW_MS - 24 * 60 * 60_000,
          ),
        },
      },
      select: { resultJson: true },
    });
    const ids = new Set<string>();
    for (const run of runs) {
      const audited = (run.resultJson as { postFinalAudited?: unknown } | null)
        ?.postFinalAudited;
      if (Array.isArray(audited))
        for (const id of audited) if (typeof id === 'string') ids.add(id);
    }
    this.audited = ids;
    return ids;
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
    // KRX: close + delay. US: the New York wall time of the session date
    // (null only for an impossible date: never observed, released at the deadline).
    const window = limitOnCloseObservationPolicy(
      first.market,
      { localDate: sessionDateText(first.sessionDate), closeTime },
      config,
    );
    // One provider request per asset/session per confirmation interval,
    // successful or not.
    const lastAttempt = Math.max(
      evidence?.lastObservedAt.getTime() ?? 0,
      ...bound.map(({ row }) => row.lastCheckedAt?.getTime() ?? 0),
    );
    if (
      evidence?.status !== 'final' &&
      window.earliestAt !== null &&
      now.getTime() >= window.earliestAt.getTime() &&
      now.getTime() < deadline &&
      now.getTime() - lastAttempt >= window.confirmMs
    ) {
      try {
        const observation = await this.source.observe(target);
        evidence = await this.evidence.recordObservation(
          target,
          observation,
          window.confirmMs,
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
    // A USD fill needs fill-time USD/KRW evidence ≤ 60 s old (selected inside
    // the fill transaction); prepare it once per group, outside every
    // transaction. Without it the fill skips and retries until the deadline.
    if (evidence?.status === 'final' && first.market === 'US')
      await this.prepareUsdKrw();
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
    // Cheap pre-check; the fill re-checks the deadline at its post-lock DB clock.
    if (
      limitOnCloseDeadlinePassed(await this.dbNow(), row.evidenceDeadlineAt)
    ) {
      await this.release(
        row,
        'expired',
        LOC_DECISION_REASONS.fillNotPermitted,
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

  private async prepareUsdKrw() {
    try {
      await this.usdKrwRefresh?.prepare('orders_execute');
    } catch {
      // The fill re-selects committed FX evidence at its own DB clock.
    }
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
