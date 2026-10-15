import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OpsJobLockService } from '../ops/ops-job-lock.service';
import { OpsJobRunService } from '../ops/ops-job-run.service';
import { databaseFailureKind } from '../common/database-failure';
import {
  RetentionHealth,
  type RetentionFailureKind,
} from '../futures/futures-retention-health';
import { assetPriceSnapshotRetentionConfig } from './asset-price-snapshot-retention.config';
import {
  AssetPriceSnapshotRetentionService,
  type PriceSnapshotRetentionCursor,
} from './asset-price-snapshot-retention.service';

const DAY_MS = 24 * 3600000;

/** Scheduled retention of asset_price_snapshots (opt-in, 14-day policy).
 * Every five minutes one instance (Ops lease) sweeps the assets round-robin in
 * bounded batches. Each batch commits on its own, so a failure, a lost lease
 * or a restart resumes from the database state. Financial evidence is kept by
 * the service's rules ①–⑦ and, finally, by the RESTRICT foreign keys. */
@Injectable()
export class AssetPriceSnapshotRetentionWorker
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(AssetPriceSnapshotRetentionWorker.name);
  private readonly health = new RetentionHealth(
    'asset_price_snapshot_retention',
    this.logger,
    'price_snapshot_retention',
  );
  private readonly retention: AssetPriceSnapshotRetentionService;
  private phase?: NodeJS.Timeout;
  private timer?: NodeJS.Timeout;
  private running = false;
  /** Per-asset resume points, so a row kept for a permanent reason is not
   * examined again every run. Cleared daily and on restart, which re-examines
   * rows kept for a temporary one (⑥, ⑦, a row locked by an in-flight
   * reference). */
  private readonly cursors = new Map<string, PriceSnapshotRetentionCursor>();
  private cursorsSince = Date.now();
  /** A capped run continues next time with the asset it stopped at. */
  private nextAssetId: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: OpsJobLockService,
    private readonly runs: OpsJobRunService,
  ) {
    this.retention = new AssetPriceSnapshotRetentionService(prisma);
  }

  onModuleInit() {
    const { enabled, intervalMs } = assetPriceSnapshotRetentionConfig();
    if (!enabled) return;
    const tick = () =>
      void this.run().catch(() =>
        this.logger.error('ASSET_PRICE_SNAPSHOT_RETENTION_FAILED'),
      );
    // 15 s off the futures retention ticks (Last at :00, Mark at :30 of the
    // process minute), so the DELETE bursts never share a second.
    this.phase = setTimeout(() => {
      tick();
      this.timer = setInterval(tick, intervalMs);
    }, 15000);
  }

  onModuleDestroy() {
    if (this.phase) clearTimeout(this.phase);
    if (this.timer) clearInterval(this.timer);
  }

  getStatus() {
    const { enabled, retentionDays } = assetPriceSnapshotRetentionConfig();
    return { enabled, retentionDays, ...this.health.status() };
  }

  async run() {
    const config = assetPriceSnapshotRetentionConfig();
    if (!config.enabled || this.running) return;
    this.running = true;
    const started = Date.now();
    const lockKey = 'asset_price_snapshot_retention:current';
    let ownerId: string | undefined;
    let run: Awaited<ReturnType<OpsJobRunService['createRunning']>> | undefined;
    let cutoff: Date | undefined;
    let deletedCount = 0;
    let scannedCount = 0;
    let batchCount = 0;
    let leaseLost = false;
    try {
      const lock = await this.locks.acquireLock({
        jobName: 'asset_price_snapshot_retention',
        lockKey,
        ttlSeconds: 60,
      });
      if (!lock.acquired) return;
      ownerId = lock.ownerId;
      const now = (
        await this.prisma.$queryRaw<
          Array<{ now: Date }>
        >`SELECT clock_timestamp() AS now`
      )[0].now;
      cutoff = new Date(+now - config.retentionDays * DAY_MS);
      run = await this.runs.createRunning({
        jobName: 'asset_price_snapshot_retention',
        trigger: 'scheduler',
        lockKey,
        dryRun: false,
      });
      if (Date.now() - this.cursorsSince >= DAY_MS) {
        this.cursors.clear();
        this.cursorsSince = Date.now();
      }
      const assets = await this.prisma.asset.findMany({
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      const start = Math.max(
        0,
        assets.findIndex((asset) => asset.id === this.nextAssetId),
      );
      let capped = false;
      let assetsSwept = 0;
      for (let k = 0; k < assets.length && !capped; k++) {
        const assetId = assets[(start + k) % assets.length].id;
        for (;;) {
          // The cap budgets rows examined, not batches: every asset ends its
          // sweep with one short batch, and counting those would cap every run
          // once there are more assets than MAX_BATCHES.
          if (
            scannedCount >= config.maxBatches * config.batchSize ||
            Date.now() - started >= config.maxRunMs
          ) {
            capped = true;
            this.nextAssetId = assetId;
            break;
          }
          if (
            !(await this.locks.extendLock({ lockKey, ownerId, ttlSeconds: 60 }))
          ) {
            leaseLost = true;
            // @diagnosticSurface internal: run catches this fixed lease error and records an Ops failure before stopping deletion.
            throw new Error('ASSET_PRICE_SNAPSHOT_RETENTION_LEASE_LOST');
          }
          const batch = await this.retention.deleteBatch({
            retentionDays: config.retentionDays,
            assetId,
            limit: config.batchSize,
            now,
            after: this.cursors.get(assetId) ?? null,
          });
          batchCount++;
          deletedCount += batch.deleted;
          scannedCount += batch.scanned;
          if (batch.next) this.cursors.set(assetId, batch.next);
          if (batch.scanned < config.batchSize) {
            assetsSwept++;
            break;
          }
        }
      }
      if (!capped) this.nextAssetId = null;
      const result = {
        cutoff: cutoff.toISOString(),
        deletedCount,
        scannedCount,
        batchCount,
        assetCount: assets.length,
        assetsSwept,
        batchLimitReached: capped,
      };
      await this.runs.recordSucceeded(run, { resultJson: result });
      this.health.succeeded(capped);
      return result;
    } catch (error) {
      const kind: RetentionFailureKind = leaseLost
        ? 'lease_lost'
        : databaseFailureKind(error);
      if (run)
        await this.runs.recordFailed(run, {
          errorCode: 'ASSET_PRICE_SNAPSHOT_RETENTION_FAILED',
          errorMessage: 'Asset price snapshot retention failed.',
          // Committed batches before the failure stay deleted; the next run resumes.
          resultJson: {
            cutoff: cutoff?.toISOString() ?? null,
            deletedCount,
            scannedCount,
            batchCount,
            failureKind: kind,
          },
        });
      this.health.failed(kind);
      throw error;
    } finally {
      try {
        if (ownerId) await this.locks.releaseLock({ lockKey, ownerId });
      } finally {
        this.running = false;
      }
    }
  }
}
