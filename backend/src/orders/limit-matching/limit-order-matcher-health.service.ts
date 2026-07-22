import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  OpsJobName,
  OpsJobRunStatus,
  OpsJobTrigger,
  Prisma,
} from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { readLimitOrderMatchingConfig } from './limit-order-matching.config';

type HealthClient = Pick<Prisma.TransactionClient, 'opsJobRun'>;

/**
 * Heartbeat payload persisted on the running matcher OpsJobRun. Every field is
 * an operational measurement — never a credential, never a raw provider
 * payload — and the API health gate reads exactly these values.
 */
export type LimitOrderMatcherHeartbeat = {
  activeLeaderInstance: string;
  /** When THIS leader took over; the ACK-age reference before the first ACK. */
  leaderStartedAt: string | null;
  lastRedisRead: string | null;
  lastSuccessfulEvent: string | null;
  lastAcknowledgedEvent: string | null;
  lastAcknowledgedAt: string | null;
  pendingCount: number;
  oldestPendingAgeMs: number | null;
  consumerLag: number | null;
  streamFirstId: string | null;
  streamLastId: string | null;
  streamLength: number | null;
  retentionHeadroomRatio: number | null;
  processedEvents: LimitOrderProcessedEventStats | null;
};

export type LimitOrderProcessedEventStats = {
  /**
   * APPROXIMATE by default (planner statistics, `pg_stat_user_tables`), because
   * an exact COUNT(*) is a full scan of an append-only table that grows without
   * bound and was previously executed every 60 seconds. `approximate` says
   * which kind of number this is, so an operator never reads an estimate as a
   * ledger figure.
   */
  rowCount: number;
  approximate: boolean;
  oldestProcessedAt: string | null;
  newestProcessedAt: string | null;
  lastHourCount: number;
  lastDayCount: number;
  tableBytes: number | null;
  indexBytes: number | null;
  /** When the sample was taken; a stats interval is minutes, not seconds. */
  sampledAt: string;
};

export type LimitOrderMatcherGateFailure = {
  code: string;
  reason: string;
};

@Injectable()
export class LimitOrderMatcherHealthService {
  private readonly config = readLimitOrderMatchingConfig();

  constructor(private readonly prisma: PrismaService) {}

  async startLeader(input: {
    consumerName: string;
    startedAt: Date;
  }): Promise<string> {
    const run = await this.prisma.opsJobRun.create({
      data: {
        jobName: OpsJobName.limit_order_matcher,
        status: OpsJobRunStatus.running,
        trigger: OpsJobTrigger.worker,
        requestedBy: input.consumerName,
        startedAt: input.startedAt,
        lockKey: 'limit-order-matcher:leader:v1',
        metadataJson: {
          consumerName: input.consumerName,
          lastHeartbeat: input.startedAt.toISOString(),
          degradedReason: null,
        },
      },
      select: { id: true },
    });
    return run.id;
  }

  async heartbeat(
    runId: string,
    metadata: LimitOrderMatcherHeartbeat,
  ): Promise<void> {
    const updated = await this.prisma.opsJobRun.updateMany({
      where: { id: runId, status: OpsJobRunStatus.running },
      data: {
        metadataJson: {
          ...(metadata as unknown as Prisma.InputJsonObject),
          lastHeartbeat: new Date().toISOString(),
          degradedReason: null,
        } as Prisma.InputJsonObject,
      },
    });
    if (updated.count !== 1) {
      throw new Error(
        'Limit-order matcher Ops heartbeat row is no longer active.',
      );
    }
  }

  async degradeActiveLeader(code: string, message: string): Promise<void> {
    const run = await this.prisma.opsJobRun.findFirst({
      where: {
        jobName: OpsJobName.limit_order_matcher,
        status: OpsJobRunStatus.running,
      },
      orderBy: { startedAt: 'desc' },
      select: { id: true },
    });
    if (!run) return;
    await this.fail(run.id, code, message);
  }

  async recordEventFailure(input: {
    consumerName: string;
    streamId: string;
    eventId: string | null;
    code: string;
    message: string;
  }): Promise<void> {
    const now = new Date();
    await this.prisma.opsJobRun.create({
      data: {
        jobName: OpsJobName.limit_order_matcher,
        status: OpsJobRunStatus.failed,
        trigger: OpsJobTrigger.worker,
        requestedBy: input.consumerName,
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        errorCode: input.code,
        errorMessage: input.message.slice(0, 1000),
        metadataJson: {
          streamId: input.streamId,
          eventId: input.eventId,
          dlq: true,
        },
      },
    });
  }

  async fail(runId: string, code: string, message: string): Promise<void> {
    const current = await this.prisma.opsJobRun.findUnique({
      where: { id: runId },
      select: { metadataJson: true },
    });
    const previousMetadata =
      current?.metadataJson &&
      typeof current.metadataJson === 'object' &&
      !Array.isArray(current.metadataJson)
        ? (current.metadataJson as Prisma.InputJsonObject)
        : {};
    await this.prisma.opsJobRun.updateMany({
      where: { id: runId, status: OpsJobRunStatus.running },
      data: {
        status: OpsJobRunStatus.failed,
        finishedAt: new Date(),
        errorCode: code,
        errorMessage: message.slice(0, 1000),
        metadataJson: { ...previousMetadata, degradedReason: code },
      },
    });
  }

  async finish(runId: string): Promise<void> {
    await this.prisma.opsJobRun.updateMany({
      where: { id: runId, status: OpsJobRunStatus.running },
      data: { status: OpsJobRunStatus.succeeded, finishedAt: new Date() },
    });
  }

  /**
   * Growth/ageing measurements for the durable dedupe table.
   *
   * No retention deletion is performed: a processed event id that was deleted
   * could be re-delivered and fill a LATER order, and that cannot be ruled out
   * from provider trade-id reuse alone. Capacity is therefore observed,
   * reported, and planned for — never silently trimmed. See
   * docs/limit-order-live-matching-operations.md for the capacity model and
   * the partition-migration plan.
   *
   * OBSERVATION COST
   * ----------------
   * The previous implementation ran `COUNT(*)` plus two filtered counts over
   * the WHOLE table every 60 seconds. On an append-only table that grows
   * monotonically that is a sequential scan whose cost rises forever, paid by
   * the matcher's own event loop, purely to print a number that changes on a
   * scale of hours.
   *
   * The default sample is therefore APPROXIMATE:
   *   - row count from `pg_stat_user_tables.n_live_tup` (planner statistics);
   *   - min/max `processed_at` from the ordered index, not from an aggregate
   *     over the heap;
   *   - the last-hour / last-day counters from bounded index range scans;
   *   - table/index size from the cheap `pg_*_size` catalog functions.
   *
   * `collectExactProcessedEventStats()` remains available for a manual
   * diagnostic run when an exact figure is genuinely needed.
   */
  async collectProcessedEventStats(): Promise<LimitOrderProcessedEventStats> {
    const now = new Date();
    const hourAgo = new Date(now.getTime() - 3_600_000);
    const dayAgo = new Date(now.getTime() - 86_400_000);
    const rows = await this.prisma.$queryRaw<
      Array<{
        rowCount: bigint | null;
        oldest: Date | null;
        newest: Date | null;
        lastHour: bigint;
        lastDay: bigint;
        tableBytes: bigint | null;
        indexBytes: bigint | null;
      }>
    >`
      SELECT
        (
          SELECT s."n_live_tup"::bigint
          FROM "pg_stat_user_tables" s
          WHERE s."relname" = 'limit_order_processed_events'
          LIMIT 1
        ) AS "rowCount",
        (
          SELECT MIN(p."processed_at") FROM "limit_order_processed_events" p
        ) AS "oldest",
        (
          SELECT MAX(p."processed_at") FROM "limit_order_processed_events" p
        ) AS "newest",
        (
          SELECT COUNT(*)::bigint FROM "limit_order_processed_events" p
          WHERE p."processed_at" >= ${hourAgo}
        ) AS "lastHour",
        (
          SELECT COUNT(*)::bigint FROM "limit_order_processed_events" p
          WHERE p."processed_at" >= ${dayAgo}
        ) AS "lastDay",
        pg_table_size('limit_order_processed_events')::bigint AS "tableBytes",
        pg_indexes_size('limit_order_processed_events')::bigint AS "indexBytes"
    `;
    const row = rows[0];
    return {
      rowCount: Number(row?.rowCount ?? 0),
      approximate: true,
      oldestProcessedAt: row?.oldest ? row.oldest.toISOString() : null,
      newestProcessedAt: row?.newest ? row.newest.toISOString() : null,
      lastHourCount: Number(row?.lastHour ?? 0),
      lastDayCount: Number(row?.lastDay ?? 0),
      tableBytes:
        row?.tableBytes === null ? null : Number(row?.tableBytes ?? 0),
      indexBytes:
        row?.indexBytes === null ? null : Number(row?.indexBytes ?? 0),
      sampledAt: now.toISOString(),
    };
  }

  /**
   * Exact figures. NOT on any timer: a full COUNT(*) over an unbounded
   * append-only table belongs in a manual diagnostic run or a very
   * low-frequency capacity report, never on the matcher heartbeat path.
   */
  async collectExactProcessedEventStats(): Promise<LimitOrderProcessedEventStats> {
    const now = new Date();
    const hourAgo = new Date(now.getTime() - 3_600_000);
    const dayAgo = new Date(now.getTime() - 86_400_000);
    const rows = await this.prisma.$queryRaw<
      Array<{
        rowCount: bigint;
        oldest: Date | null;
        newest: Date | null;
        lastHour: bigint;
        lastDay: bigint;
        tableBytes: bigint | null;
        indexBytes: bigint | null;
      }>
    >`
      SELECT
        COUNT(*)::bigint AS "rowCount",
        MIN("processed_at") AS "oldest",
        MAX("processed_at") AS "newest",
        COUNT(*) FILTER (WHERE "processed_at" >= ${hourAgo})::bigint AS "lastHour",
        COUNT(*) FILTER (WHERE "processed_at" >= ${dayAgo})::bigint AS "lastDay",
        pg_table_size('limit_order_processed_events')::bigint AS "tableBytes",
        pg_indexes_size('limit_order_processed_events')::bigint AS "indexBytes"
      FROM "limit_order_processed_events"
    `;
    const row = rows[0];
    return {
      rowCount: Number(row?.rowCount ?? 0),
      approximate: false,
      oldestProcessedAt: row?.oldest ? row.oldest.toISOString() : null,
      newestProcessedAt: row?.newest ? row.newest.toISOString() : null,
      lastHourCount: Number(row?.lastHour ?? 0),
      lastDayCount: Number(row?.lastDay ?? 0),
      tableBytes:
        row?.tableBytes === null ? null : Number(row?.tableBytes ?? 0),
      indexBytes:
        row?.indexBytes === null ? null : Number(row?.indexBytes ?? 0),
      sampledAt: now.toISOString(),
    };
  }

  /**
   * Fail-closed gate for NEW limit quotes/creates. It never blocks cancel,
   * lifecycle cleanup, market orders, or FX.
   *
   * Beyond "a leader heartbeat exists recently", it refuses when the matcher
   * is demonstrably behind: consumer lag, un-ACKed backlog, a stale last ACK
   * while a backlog exists, or a stream that has grown into its trim window
   * (where un-read entries can be dropped). A QUIET market is explicitly not a
   * failure: staleness is only judged when there is actually something to
   * process.
   */
  async assertAvailable(
    client: HealthClient = this.prisma,
    now = new Date(),
  ): Promise<void> {
    if (!this.config.enabled) return;
    const failure = await this.evaluate(client, now);
    if (!failure) return;
    throw new HttpException(
      {
        success: false,
        error: { code: failure.code, message: failure.reason },
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  async evaluate(
    client: HealthClient = this.prisma,
    now = new Date(),
  ): Promise<LimitOrderMatcherGateFailure | null> {
    if (!this.config.enabled) return null;
    const cutoff = new Date(now.getTime() - this.config.healthMaxAgeMs);
    const run = await client.opsJobRun.findFirst({
      where: {
        jobName: OpsJobName.limit_order_matcher,
        status: OpsJobRunStatus.running,
        updatedAt: { gte: cutoff },
      },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, metadataJson: true },
    });
    if (!run) {
      return {
        code: 'LIMIT_ORDER_MATCHER_UNAVAILABLE',
        reason: 'Limit-order automatic matching is not healthy.',
      };
    }
    return this.evaluateHeartbeat(readMetadata(run.metadataJson), now);
  }

  evaluateHeartbeat(
    metadata: Partial<LimitOrderMatcherHeartbeat> & {
      degradedReason?: unknown;
      lastHeartbeat?: unknown;
    },
    now = new Date(),
  ): LimitOrderMatcherGateFailure | null {
    if (typeof metadata.degradedReason === 'string') {
      return {
        code: 'LIMIT_ORDER_MATCHER_DEGRADED',
        reason: `The matcher reported a degraded state: ${metadata.degradedReason}.`,
      };
    }

    const lag = numberOrNull(metadata.consumerLag);
    if (lag !== null && lag > this.config.maxConsumerLag) {
      return {
        code: 'LIMIT_ORDER_MATCHER_LAG_EXCEEDED',
        reason: `Matcher consumer lag ${lag} exceeds the ${this.config.maxConsumerLag} limit.`,
      };
    }

    const pending = numberOrNull(metadata.pendingCount) ?? 0;
    if (pending > this.config.maxPendingCount) {
      return {
        code: 'LIMIT_ORDER_MATCHER_PENDING_EXCEEDED',
        reason: `Matcher pending backlog ${pending} exceeds the ${this.config.maxPendingCount} limit.`,
      };
    }

    const oldestPendingAgeMs = numberOrNull(metadata.oldestPendingAgeMs);
    if (
      pending > 0 &&
      oldestPendingAgeMs !== null &&
      oldestPendingAgeMs > this.config.maxOldestPendingAgeMs
    ) {
      return {
        code: 'LIMIT_ORDER_MATCHER_PENDING_STALE',
        reason: `The oldest un-acknowledged event is ${oldestPendingAgeMs}ms old.`,
      };
    }

    // A quiet market legitimately produces no ACKs. Only judge ACK staleness
    // when there is a backlog or measurable lag to work through.
    //
    // Before the first ACK of a newly elected leader the reference point is
    // its start time, not "never": a leader that took over 200ms ago into a
    // backlog is starting up, while one that has held the lock for minutes
    // without a single ACK is genuinely stuck.
    const hasBacklog = pending > 0 || (lag !== null && lag > 0);
    if (hasBacklog) {
      const ackAge =
        ageMs(metadata.lastAcknowledgedAt, now) ??
        ageMs(metadata.leaderStartedAt, now);
      if (ackAge === null || ackAge > this.config.maxAckAgeMs) {
        return {
          code: 'LIMIT_ORDER_MATCHER_ACK_STALE',
          reason:
            ackAge === null
              ? 'The matcher has a backlog and reports no acknowledgement or leader start time.'
              : `The matcher has a backlog and has not acknowledged an event for ${ackAge}ms.`,
        };
      }
    }

    const headroom = numberOrNull(metadata.retentionHeadroomRatio);
    if (
      headroom !== null &&
      headroom < this.config.eventRetentionHeadroomRatio
    ) {
      return {
        code: 'LIMIT_ORDER_EVENT_RETENTION_HEADROOM_LOW',
        reason: `Event stream retention headroom ${headroom.toFixed(4)} is below the ${this.config.eventRetentionHeadroomRatio} minimum.`,
      };
    }

    return null;
  }
}

function readMetadata(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function ageMs(value: unknown, now: Date): number | null {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;
  return Math.max(0, now.getTime() - timestamp);
}
