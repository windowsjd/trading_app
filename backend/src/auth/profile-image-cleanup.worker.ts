import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { OpsJobLockService } from '../ops/ops-job-lock.service';
import { OpsJobRunService } from '../ops/ops-job-run.service';
import { ProfileImageCleanupService } from './profile-image-cleanup.service';
import { ProfileImageStorageService } from './profile-image-storage.service';

const LOCK_KEY = 'account_deletion_cleanup:current';
const LOCK_TTL_SECONDS = 120;
const INTERVAL_MS = 60_000;

/**
 * Retries managed profile image removals (docs/account-deletion-contract.md
 * §6): photos of deleted accounts, replaced/deleted photos and abandoned
 * uploads. Every minute one instance (Ops lease) processes due rows with
 * backoff; an idle tick only reads. It runs only when profile image storage
 * is configured — without it no managed object can exist or be removed, and
 * queued rows wait. A run is recorded only when there was work: `failed` if
 * a storage delete failed or a deletion is past its 7-day target. No object
 * key, user id or provider message is logged.
 */
@Injectable()
export class ProfileImageCleanupWorker
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ProfileImageCleanupWorker.name);
  private phase?: NodeJS.Timeout;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly storage: ProfileImageStorageService,
    private readonly cleanups: ProfileImageCleanupService,
    private readonly locks: OpsJobLockService,
    private readonly runs: OpsJobRunService,
  ) {}

  onModuleInit() {
    if (!this.storage.isConfigured()) return;
    const tick = () =>
      void this.tick().catch(() =>
        this.logger.error('PROFILE_IMAGE_CLEANUP_TICK_FAILED'),
      );
    // Off the second of the other workers' starts.
    this.phase = setTimeout(() => {
      tick();
      this.timer = setInterval(tick, INTERVAL_MS);
      this.timer.unref?.();
    }, 23_000);
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
        jobName: 'account_deletion_cleanup',
        lockKey: LOCK_KEY,
        ttlSeconds: LOCK_TTL_SECONDS,
      });
      if (!lock.acquired) return;
      ownerId = lock.ownerId;
      const run = await this.runs.createRunning({
        jobName: 'account_deletion_cleanup',
        trigger: 'scheduler',
        lockKey: LOCK_KEY,
      });
      const result = await this.cleanups.runDue();
      if (result.overdue > 0)
        this.logger.warn(
          JSON.stringify({
            event: 'account_deletion_cleanup_overdue',
            overdue: result.overdue,
          }),
        );
      if (result.failed > 0 || result.overdue > 0)
        await this.runs.recordFailed(run, {
          errorCode:
            result.overdue > 0
              ? 'ACCOUNT_DELETION_CLEANUP_OVERDUE'
              : 'PROFILE_IMAGE_CLEANUP_FAILED',
          errorMessage:
            'A profile image removal is still pending; the next tick retries it.',
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
