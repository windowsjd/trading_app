import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ProfileImageStorageService } from '../auth/profile-image-storage.service';
import { OpsJobLockService } from '../ops/ops-job-lock.service';
import { OpsJobRunService } from '../ops/ops-job-run.service';
import { CommunityPhotoCleanupService } from './community-photo-cleanup.service';

const LOCK_KEY = 'community_photo_cleanup:current';
const LOCK_TTL_SECONDS = 120;
const INTERVAL_MS = 60_000;

/**
 * Retries community photo removals (docs/community-api-contract.md §10.5):
 * removed posts' photos, deleted accounts' photos and abandoned uploads. Once
 * a minute one instance (Ops lease) processes due rows; an idle tick only
 * reads. Runs only when the shared photo storage is configured. A run is
 * recorded only when there was work, `failed` if a storage delete failed.
 */
@Injectable()
export class CommunityPhotoCleanupWorker
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(CommunityPhotoCleanupWorker.name);
  private phase?: NodeJS.Timeout;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly storage: ProfileImageStorageService,
    private readonly cleanups: CommunityPhotoCleanupService,
    private readonly locks: OpsJobLockService,
    private readonly runs: OpsJobRunService,
  ) {}

  onModuleInit() {
    const tick = () =>
      void this.tick().catch(() =>
        this.logger.error('COMMUNITY_PHOTO_CLEANUP_TICK_FAILED'),
      );
    // Off the second of the other workers' starts.
    this.phase = setTimeout(() => {
      tick();
      this.timer = setInterval(tick, INTERVAL_MS);
      this.timer.unref?.();
    }, 37_000);
    this.phase.unref?.();
  }

  onModuleDestroy() {
    if (this.phase) clearTimeout(this.phase);
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    if (this.running || !this.storage.isConfigured()) return;
    this.running = true;
    let ownerId: string | undefined;
    try {
      if (!(await this.cleanups.hasWork())) return;
      const lock = await this.locks.acquireLock({
        jobName: 'community_photo_cleanup',
        lockKey: LOCK_KEY,
        ttlSeconds: LOCK_TTL_SECONDS,
      });
      if (!lock.acquired) return;
      ownerId = lock.ownerId;
      const run = await this.runs.createRunning({
        jobName: 'community_photo_cleanup',
        trigger: 'scheduler',
        lockKey: LOCK_KEY,
      });
      const result = await this.cleanups.runDue();
      if (result.failed > 0)
        await this.runs.recordFailed(run, {
          errorCode: 'COMMUNITY_PHOTO_CLEANUP_FAILED',
          errorMessage:
            'A community photo removal is still pending; the next tick retries it.',
          resultJson: result,
        });
      else await this.runs.recordSucceeded(run, { resultJson: result });
    } finally {
      try {
        if (ownerId)
          await this.locks.releaseLock({ lockKey: LOCK_KEY, ownerId });
      } finally {
        this.running = false;
      }
    }
  }
}
