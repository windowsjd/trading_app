import { Logger } from '@nestjs/common';
import type { DatabaseFailureKind } from '../common/database-failure';

/** Consecutive failed runs (one per minute) before a retention job is failing. */
export const RETENTION_FAILING_AFTER = 3;
/** Consecutive runs that hit the per-run batch cap before it is a backlog. */
export const RETENTION_BACKLOG_AFTER = 10;
const REPEAT_ALERT_MS = 300000;

export type RetentionFailureKind = DatabaseFailureKind | 'lease_lost';

export type RetentionHealthStatus = {
  consecutiveFailures: number;
  failing: boolean;
  saturatedRuns: number;
  backlog: boolean;
  lastSucceededAt: string | null;
  lastFailedAt: string | null;
  lastFailureKind: RetentionFailureKind | null;
};

/** In-process run history of one bounded retention worker, for structured
 * alert logs and /readiness. Durable per-run evidence stays in ops_job_runs. */
export class RetentionHealth {
  private consecutiveFailures = 0;
  private saturatedRuns = 0;
  private lastSucceededAt: number | null = null;
  private lastFailed: { kind: RetentionFailureKind; at: number } | null = null;
  private readonly lastAlert = new Map<string, number>();

  constructor(
    private readonly job: string,
    private readonly logger: Logger,
  ) {}

  succeeded(batchLimitReached: boolean, now = Date.now()) {
    if (this.consecutiveFailures >= RETENTION_FAILING_AFTER)
      this.logger.log(
        JSON.stringify({
          event: 'futures_retention_recovered',
          job: this.job,
          failedRuns: this.consecutiveFailures,
        }),
      );
    this.consecutiveFailures = 0;
    this.lastAlert.delete('failing');
    this.lastSucceededAt = now;
    this.saturatedRuns = batchLimitReached ? this.saturatedRuns + 1 : 0;
    if (this.saturatedRuns >= RETENTION_BACKLOG_AFTER)
      this.alert('backlog', now, () =>
        this.logger.warn(
          JSON.stringify({
            event: 'futures_retention_backlog',
            job: this.job,
            saturatedRuns: this.saturatedRuns,
          }),
        ),
      );
    else this.lastAlert.delete('backlog');
  }

  failed(kind: RetentionFailureKind, now = Date.now()) {
    this.consecutiveFailures++;
    this.lastFailed = { kind, at: now };
    if (kind === 'disk_full')
      this.alert('disk_full', now, () =>
        this.logger.error(
          JSON.stringify({ event: 'db_disk_full', source: this.job }),
        ),
      );
    if (this.consecutiveFailures >= RETENTION_FAILING_AFTER)
      this.alert('failing', now, () =>
        this.logger.error(
          JSON.stringify({
            event: 'futures_retention_failing',
            job: this.job,
            consecutiveFailures: this.consecutiveFailures,
            kind,
          }),
        ),
      );
  }

  status(): RetentionHealthStatus {
    return {
      consecutiveFailures: this.consecutiveFailures,
      failing: this.consecutiveFailures >= RETENTION_FAILING_AFTER,
      saturatedRuns: this.saturatedRuns,
      backlog: this.saturatedRuns >= RETENTION_BACKLOG_AFTER,
      lastSucceededAt:
        this.lastSucceededAt === null
          ? null
          : new Date(this.lastSucceededAt).toISOString(),
      lastFailedAt: this.lastFailed
        ? new Date(this.lastFailed.at).toISOString()
        : null,
      lastFailureKind: this.lastFailed?.kind ?? null,
    };
  }

  private alert(key: string, now: number, emit: () => void) {
    const last = this.lastAlert.get(key);
    if (last !== undefined && now - last < REPEAT_ALERT_MS) return;
    this.lastAlert.set(key, now);
    emit();
  }
}
