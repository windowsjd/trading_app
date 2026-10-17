import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OpsJobLockService } from '../ops/ops-job-lock.service';
import { OpsJobRunService } from '../ops/ops-job-run.service';
import { PushNotificationScanner } from './push-notification-scanner.service';
import { PushDispatcher } from './push-dispatcher.service';
import { pushNotificationsConfig } from './push-notifications.config';

const LOCK_KEY = 'push_notifications:current';
const LOCK_TTL_SECONDS = 120;
const REPORT_INTERVAL_MS = 60_000;
const RECEIPT_INTERVAL_MS = 60_000;
const PRUNE_INTERVAL_MS = 3_600_000;

type Totals = {
  created: Record<string, number>;
  sent: number;
  retried: number;
  failed: number;
  skipped: Record<string, number>;
  tickets: { ok: number; error: number };
  receipts: { ok: number; error: number; missing: number };
  devicesRemoved: number;
  pruned: number;
  failures: Record<string, number>;
};

function emptyTotals(): Totals {
  return {
    created: {},
    sent: 0,
    retried: 0,
    failed: 0,
    skipped: {},
    tickets: { ok: 0, error: 0 },
    receipts: { ok: 0, error: 0, missing: 0 },
    devicesRemoved: 0,
    pruned: 0,
    failures: {},
  };
}

function addCounts(
  target: Record<string, number>,
  source: Record<string, number>,
) {
  for (const [key, value] of Object.entries(source))
    target[key] = (target[key] ?? 0) + value;
}

/**
 * Push notification worker (docs/push-notifications-contract.md §5).
 *
 * Every interval one instance (Ops lease `push_notifications:current`)
 * derives outbox rows from committed source rows, sends due rows to Expo,
 * resolves receipts and prunes old rows. It runs outside every financial
 * transaction and only reads financial tables, so a push outage can delay a
 * notification but never an order, a liquidation or a settlement. Counts are
 * recorded as one Ops run a minute (failed if any step failed in it); a
 * failing step is also logged at once. No token, copy or payload is logged.
 */
@Injectable()
export class PushNotificationWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PushNotificationWorker.name);
  private phase?: NodeJS.Timeout;
  private timer?: NodeJS.Timeout;
  private running = false;
  private reportedAt = 0;
  private receiptsAt = 0;
  private prunedAt = 0;
  private totals = emptyTotals();

  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: OpsJobLockService,
    private readonly runs: OpsJobRunService,
    private readonly scanner: PushNotificationScanner,
    private readonly dispatcher: PushDispatcher,
  ) {}

  onModuleInit() {
    const { enabled, intervalMs } = pushNotificationsConfig();
    if (!enabled) return;
    const tick = () =>
      void this.tick().catch(() =>
        this.logger.error('PUSH_NOTIFICATIONS_TICK_FAILED'),
      );
    // Off the second of the other workers' starts.
    this.phase = setTimeout(() => {
      tick();
      this.timer = setInterval(tick, intervalMs);
    }, 7_000);
  }

  onModuleDestroy() {
    if (this.phase) clearTimeout(this.phase);
    if (this.timer) clearInterval(this.timer);
  }

  private async dbNow(): Promise<Date> {
    const rows = await this.prisma.$queryRaw<
      Array<{ now: Date }>
    >`SELECT clock_timestamp() AS now`;
    return rows[0].now;
  }

  async tick() {
    const config = pushNotificationsConfig();
    if (!config.enabled || this.running) return;
    this.running = true;
    let ownerId: string | undefined;
    const failures: Record<string, number> = {};
    try {
      const lock = await this.locks.acquireLock({
        jobName: 'push_notifications',
        lockKey: LOCK_KEY,
        ttlSeconds: LOCK_TTL_SECONDS,
      });
      // Another instance holds the lease this tick: nothing to record.
      if (!lock.acquired) return;
      ownerId = lock.ownerId;
      const owned = () =>
        this.locks.extendLock({
          lockKey: LOCK_KEY,
          ownerId: ownerId!,
          ttlSeconds: LOCK_TTL_SECONDS,
        });

      const scan = await this.scanner.scan(await this.dbNow(), config);
      addCounts(this.totals.created, scan.created);
      for (const source of scan.failedSources)
        failures[`scan:${source}`] = (failures[`scan:${source}`] ?? 0) + 1;

      if (await owned()) {
        try {
          const dispatch = await this.dispatcher.dispatch(
            await this.dbNow(),
            config,
          );
          this.totals.sent += dispatch.sent;
          this.totals.retried += dispatch.retried;
          this.totals.failed += dispatch.failed;
          addCounts(this.totals.skipped, dispatch.skipped);
          this.totals.tickets.ok += dispatch.tickets.ok;
          this.totals.tickets.error += dispatch.tickets.error;
          this.totals.devicesRemoved += dispatch.devicesRemoved;
        } catch {
          failures.dispatch = 1;
        }
      }

      if (
        !config.dryRun &&
        Date.now() - this.receiptsAt >= RECEIPT_INTERVAL_MS &&
        (await owned())
      ) {
        this.receiptsAt = Date.now();
        try {
          const receipts = await this.dispatcher.checkReceipts(
            await this.dbNow(),
            config,
          );
          this.totals.receipts.ok += receipts.ok;
          this.totals.receipts.error += receipts.error;
          this.totals.receipts.missing += receipts.missing;
          this.totals.devicesRemoved += receipts.devicesRemoved;
          if (receipts.failure) failures[`receipts:${receipts.failure}`] = 1;
        } catch {
          failures.receipts = 1;
        }
      }

      if (Date.now() - this.prunedAt >= PRUNE_INTERVAL_MS && (await owned())) {
        this.prunedAt = Date.now();
        try {
          this.totals.pruned += await this.dispatcher.prune(
            await this.dbNow(),
            config,
          );
        } catch {
          failures.prune = 1;
        }
      }
    } catch {
      // Database clock/lease failures: recorded below, retried next tick.
      failures.tick = 1;
    } finally {
      try {
        if (ownerId)
          await this.locks.releaseLock({ lockKey: LOCK_KEY, ownerId });
      } finally {
        this.running = false;
      }
    }
    addCounts(this.totals.failures, failures);
    if (Object.keys(failures).length)
      this.logger.warn(
        JSON.stringify({
          event: 'push_notifications_step_failed',
          steps: Object.keys(failures),
        }),
      );
    // One Ops run a minute at most; it is `failed` if any step failed in it.
    if (Date.now() - this.reportedAt >= REPORT_INTERVAL_MS)
      await this.report(config.dryRun);
  }

  private async report(dryRun: boolean) {
    const totals = this.totals;
    this.totals = emptyTotals();
    this.reportedAt = Date.now();
    const run = await this.runs.createRunning({
      jobName: 'push_notifications',
      trigger: 'scheduler',
      lockKey: LOCK_KEY,
      dryRun,
    });
    const failed = Object.keys(totals.failures).length > 0;
    if (failed)
      await this.runs.recordFailed(run, {
        errorCode: 'PUSH_NOTIFICATIONS_STEP_FAILED',
        errorMessage:
          'A push notification step failed; the next tick retries it.',
        resultJson: totals,
      });
    else await this.runs.recordSucceeded(run, { resultJson: totals });
  }
}
