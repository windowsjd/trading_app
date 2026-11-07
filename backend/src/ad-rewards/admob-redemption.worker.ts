import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { OpsJobLockService } from '../ops/ops-job-lock.service';
import { OpsJobRunService } from '../ops/ops-job-run.service';
import { readAdRewardConfig } from './ad-reward.config';
import { ADMOB_PROVIDER } from './admob.config';
import {
  AdMobRewardSessionService,
  type AdMobRedemptionSweep,
} from './admob-reward-session.service';

const LOCK_KEY = 'ad_reward_redemption:current';
const LOCK_TTL_SECONDS = 120;
const INTERVAL_MS = 60_000;

/**
 * Server recovery of confirmed AdMob rewards (2026-11-08,
 * docs/general-account-and-ad-rewards-api-contract.md "Server recovery"):
 * an ad session whose Google-signed event is recorded but whose command did
 * not commit for a server reason is redeemed here through the SAME claim /
 * reset command — after Google's retries are over and whether or not the app
 * is running. Once a minute one instance (Ops lease) runs the due sessions;
 * an idle tick is one indexed read, and a run is recorded only when there
 * was work (`failed` while a server failure keeps one pending).
 *
 * Runs only while ads are switched on with AdMob: switched off, every new
 * command is refused anyway, so pending sessions wait (their attempts are not
 * spent) and resume, or end with their 24 h window, once ads are back on.
 */
@Injectable()
export class AdMobRedemptionWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AdMobRedemptionWorker.name);
  private phase?: NodeJS.Timeout;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly sessions: AdMobRewardSessionService,
    private readonly locks: OpsJobLockService,
    private readonly runs: OpsJobRunService,
  ) {}

  onModuleInit() {
    const tick = () =>
      void this.tick().catch(() =>
        this.logger.error('AD_REWARD_REDEMPTION_TICK_FAILED'),
      );
    // Off the second of the other workers' starts.
    this.phase = setTimeout(() => {
      tick();
      this.timer = setInterval(tick, INTERVAL_MS);
      this.timer.unref?.();
    }, 29_000);
    this.phase.unref?.();
  }

  onModuleDestroy() {
    if (this.phase) clearTimeout(this.phase);
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    if (this.running || !adMobRewardsSwitchedOn()) return;
    this.running = true;
    let ownerId: string | undefined;
    try {
      if (!(await this.sessions.hasDueRedemption())) return;
      const lock = await this.locks.acquireLock({
        jobName: 'ad_reward_redemption',
        lockKey: LOCK_KEY,
        ttlSeconds: LOCK_TTL_SECONDS,
      });
      if (!lock.acquired) return;
      ownerId = lock.ownerId;
      const run = await this.runs.createRunning({
        jobName: 'ad_reward_redemption',
        trigger: 'scheduler',
        lockKey: LOCK_KEY,
      });
      let sweep: AdMobRedemptionSweep;
      try {
        sweep = await this.sessions.redeemDueSessions();
      } catch (caught) {
        await this.runs.recordFailed(run, {
          errorCode: 'AD_REWARD_REDEMPTION_FAILED',
          errorMessage:
            'The ad reward recovery pass stopped on a server failure; the next tick retries.',
        });
        throw caught;
      }
      if (sweep.retrying + sweep.exhausted > 0)
        await this.runs.recordFailed(run, {
          errorCode: 'AD_REWARD_REDEMPTION_RETRYING',
          errorMessage:
            'A confirmed ad reward is still unredeemed after a server failure (retried later, or its window ended).',
          resultJson: sweep,
        });
      else await this.runs.recordSucceeded(run, { resultJson: sweep });
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

/** AD_REWARD_ENABLED with AD_REWARD_PROVIDER=admob (validated at boot). */
function adMobRewardsSwitchedOn(): boolean {
  try {
    const config = readAdRewardConfig();
    return config.enabled && config.provider === ADMOB_PROVIDER;
  } catch {
    return false;
  }
}
