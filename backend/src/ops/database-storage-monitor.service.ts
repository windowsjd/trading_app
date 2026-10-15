import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { databaseFailureKind } from '../common/database-failure';
import { readDatabaseStorageMonitorConfig } from './database-storage-monitor.config';

export type DatabaseStorageLevel =
  | 'unknown'
  | 'ok'
  | 'warning'
  | 'action_required'
  | 'critical';

/** Usage thresholds of the provisioned disk, highest first. */
export const DATABASE_STORAGE_LEVELS: ReadonlyArray<
  [DatabaseStorageLevel, number]
> = [
  ['critical', 0.9],
  ['action_required', 0.8],
  ['warning', 0.6],
];
/** Remaining days before 80 % at the measured growth that raise an alert. */
export const DATABASE_STORAGE_RUNWAY_ALERT_DAYS = 14;
const HISTORY_MS = 25 * 3600000;
const GROWTH_MIN_WINDOW_MS = 3600000;
const RUNWAY_MIN_WINDOW_MS = 6 * 3600000;
const REPEAT_MS: Record<DatabaseStorageLevel, number> = {
  unknown: Infinity,
  ok: Infinity,
  warning: 6 * 3600000,
  action_required: 3600000,
  critical: 0,
};

/** Samples pg_database_size (a file stat per relation, no table reads) every
 * five minutes. Growth is measured from this process's own samples (up to the
 * last 24 h), so it is unknown for the first hour after a restart. Render's disk
 * metric remains the authoritative usage including WAL; see the ops runbook. */
@Injectable()
export class DatabaseStorageMonitorService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(DatabaseStorageMonitorService.name);
  private first?: NodeJS.Timeout;
  private timer?: NodeJS.Timeout;
  private sampling = false;
  private samples: Array<{ at: number; bytes: number }> = [];
  private level: DatabaseStorageLevel = 'unknown';
  private readonly lastAlert = new Map<string, number>();
  private lastSampleFailure: { kind: string; at: number } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    const config = readDatabaseStorageMonitorConfig();
    if (!config.enabled) return;
    this.first = setTimeout(
      () => void this.sample(),
      config.firstSampleDelayMs,
    );
    this.timer = setInterval(() => void this.sample(), config.intervalMs);
  }

  onModuleDestroy() {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
  }

  async sample(now = Date.now()) {
    if (this.sampling) return;
    this.sampling = true;
    try {
      const [row] = await this.prisma.$queryRaw<Array<{ bytes: bigint }>>`
        SELECT pg_database_size(current_database())::bigint AS bytes`;
      this.samples.push({ at: now, bytes: Number(row.bytes) });
      this.samples = this.samples.filter((s) => now - s.at <= HISTORY_MS);
      this.lastSampleFailure = null;
      this.evaluate(now);
    } catch (error) {
      this.lastSampleFailure = { kind: databaseFailureKind(error), at: now };
      this.alert('sample_failed', now, 3600000, () =>
        this.logger.warn(
          JSON.stringify({
            event: 'db_storage_sample_failed',
            kind: this.lastSampleFailure?.kind,
          }),
        ),
      );
    } finally {
      this.sampling = false;
    }
  }

  getStatus(now = Date.now()) {
    const { enabled, capacityBytes } = readDatabaseStorageMonitorConfig();
    const latest = this.samples.at(-1) ?? null;
    const usedRatio =
      latest && capacityBytes ? latest.bytes / capacityBytes : null;
    const level: DatabaseStorageLevel =
      usedRatio === null
        ? 'unknown'
        : (DATABASE_STORAGE_LEVELS.find(([, at]) => usedRatio >= at)?.[0] ??
          'ok');
    const window = this.growthWindow(now);
    const growthBytesPerDay =
      latest && window
        ? Math.round(
            ((latest.bytes - window.bytes) / (latest.at - window.at)) *
              86400000,
          )
        : null;
    const runway = (ratio: number) =>
      latest &&
      capacityBytes &&
      window &&
      latest.at - window.at >= RUNWAY_MIN_WINDOW_MS &&
      growthBytesPerDay !== null &&
      growthBytesPerDay > 0
        ? Math.max(
            0,
            +(
              (capacityBytes * ratio - latest.bytes) /
              growthBytesPerDay
            ).toFixed(1),
          )
        : null;
    return {
      enabled,
      capacityConfigured: capacityBytes !== null,
      databaseBytes: latest?.bytes ?? null,
      sampledAt: latest ? new Date(latest.at).toISOString() : null,
      usedPercent: usedRatio === null ? null : +(usedRatio * 100).toFixed(1),
      level,
      growthBytesPerDay,
      growthWindowHours: window
        ? +(((latest?.at ?? now) - window.at) / 3600000).toFixed(1)
        : null,
      daysUntil80Percent: runway(0.8),
      daysUntilFull: runway(1),
      lastSampleFailureKind: this.lastSampleFailure?.kind ?? null,
    };
  }

  /** Oldest sample within the last 24 h, if it spans at least an hour. */
  private growthWindow(now: number) {
    const latest = this.samples.at(-1);
    const oldest = this.samples.find((s) => now - s.at <= 24 * 3600000);
    return latest && oldest && latest.at - oldest.at >= GROWTH_MIN_WINDOW_MS
      ? oldest
      : null;
  }

  private evaluate(now: number) {
    const status = this.getStatus(now);
    const summary = {
      level: status.level,
      usedPercent: status.usedPercent,
      databaseBytes: status.databaseBytes,
      growthBytesPerDay: status.growthBytesPerDay,
      daysUntil80Percent: status.daysUntil80Percent,
    };
    if (status.level !== this.level) {
      const event = JSON.stringify({ event: 'db_storage_level', ...summary });
      if (status.level === 'critical' || status.level === 'action_required')
        this.logger.error(event);
      else if (status.level === 'warning') this.logger.warn(event);
      else this.logger.log(event);
      this.level = status.level;
      this.lastAlert.set('level', now);
    } else
      this.alert('level', now, REPEAT_MS[status.level], () => {
        const event = JSON.stringify({ event: 'db_storage_level', ...summary });
        if (status.level === 'warning') this.logger.warn(event);
        else this.logger.error(event);
      });
    if (
      status.daysUntil80Percent !== null &&
      status.daysUntil80Percent < DATABASE_STORAGE_RUNWAY_ALERT_DAYS
    )
      this.alert('runway', now, 6 * 3600000, () =>
        this.logger.warn(
          JSON.stringify({ event: 'db_storage_runway_short', ...summary }),
        ),
      );
  }

  private alert(key: string, now: number, repeatMs: number, emit: () => void) {
    const last = this.lastAlert.get(key);
    if (last !== undefined && now - last < repeatMs) return;
    this.lastAlert.set(key, now);
    emit();
  }
}
