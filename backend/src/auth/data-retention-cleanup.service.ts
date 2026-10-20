import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  dataRetentionConfig,
  type DataRetentionConfig,
} from './data-retention.config';

export const DATA_RETENTION_BATCH = 500;
export const DATA_RETENTION_MAX_BATCHES = 10;
const INTERVAL_MS = 3_600_000;
/** Next run while a backlog remains (e.g. the first deployment). */
const BACKLOG_INTERVAL_MS = 60_000;

export type DataRetentionBatch = {
  sessions: number;
  auditLogs: number;
  inquiries: number;
};

/**
 * Deletes refresh sessions, operator audit logs and support inquiries past
 * their retention (docs/data-retention.md). Invoked by the existing Auth
 * maintenance timer right after email retention; never on the request path.
 * Each batch is one transaction under a cluster-wide advisory lock; locked
 * rows are skipped and retried by a later run.
 */
@Injectable()
export class DataRetentionCleanupService {
  private readonly logger = new Logger(DataRetentionCleanupService.name);
  private running = false;
  private nextRunAt = 0;

  constructor(private readonly prisma: PrismaService) {}

  async runIfDue() {
    if (this.running || Date.now() < this.nextRunAt) return;
    this.running = true;
    try {
      const config = dataRetentionConfig();
      if (!config.enabled) return;
      const deleted: DataRetentionBatch = {
        sessions: 0,
        auditLogs: 0,
        inquiries: 0,
      };
      let ran = false;
      let backlog = false;
      for (let batch = 0; batch < DATA_RETENTION_MAX_BATCHES; batch++) {
        const result = await this.deleteBatch(config);
        // Another instance holds the lock and does this work.
        if (!result) break;
        ran = true;
        deleted.sessions += result.sessions;
        deleted.auditLogs += result.auditLogs;
        deleted.inquiries += result.inquiries;
        backlog = Object.values(result).some(
          (count) => count >= DATA_RETENTION_BATCH,
        );
        if (!backlog) break;
      }
      this.nextRunAt =
        Date.now() + (backlog ? BACKLOG_INTERVAL_MS : INTERVAL_MS);
      if (ran)
        this.diagnostic({ event: 'data_retention_completed', ...deleted });
    } catch {
      // Fixed diagnostics only. The next existing minute tick retries failure.
      this.diagnostic({ event: 'data_retention_failed' });
    } finally {
      this.running = false;
    }
  }

  /** One bounded pass over every table; null when another instance holds the lock. */
  async deleteBatch(
    config: DataRetentionConfig,
  ): Promise<DataRetentionBatch | null> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '100ms'`;
        await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
        const [lock] = await tx.$queryRaw<{ acquired: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtextextended('data-retention', 0)) AS acquired`;
        if (!lock.acquired) return null;
        // UTC TIMESTAMP columns; every cutoff uses this transaction's clock.
        // Fixed statements only: no dynamic table names or user input.
        // A session ends at its expiry, or at its revocation if earlier. A
        // valid session (unexpired, not revoked) never ends before now.
        const sessions = await tx.$executeRaw`
        WITH candidates AS (
          SELECT id FROM refresh_token_sessions
          WHERE expires_at < timezone('UTC', transaction_timestamp()) - make_interval(days => ${config.sessionDays}::int)
             OR (status = 'revoked' AND revoked_at < timezone('UTC', transaction_timestamp()) - make_interval(days => ${config.sessionDays}::int))
          LIMIT ${DATA_RETENTION_BATCH}
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM refresh_token_sessions s USING candidates d
        WHERE s.id = d.id
          AND (s.expires_at < timezone('UTC', transaction_timestamp()) - make_interval(days => ${config.sessionDays}::int)
            OR (s.status = 'revoked' AND s.revoked_at < timezone('UTC', transaction_timestamp()) - make_interval(days => ${config.sessionDays}::int)))`;
        const auditLogs = await tx.$executeRaw`
        WITH candidates AS (
          SELECT id FROM operator_audit_logs
          WHERE created_at < timezone('UTC', transaction_timestamp()) - make_interval(days => ${config.auditLogDays}::int)
          LIMIT ${DATA_RETENTION_BATCH}
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM operator_audit_logs l USING candidates d
        WHERE l.id = d.id
          AND l.created_at < timezone('UTC', transaction_timestamp()) - make_interval(days => ${config.auditLogDays}::int)`;
        // An inquiry is closed by its answer; an unanswered one counts from
        // filing. Both FKs are RESTRICT: answers go first, then inquiries.
        const inquiries = await tx.$queryRaw<{ id: string }[]>`
        SELECT i.id FROM inquiries i
        LEFT JOIN inquiry_answers a ON a.inquiry_id = i.id
        WHERE COALESCE(a.answered_at, i.created_at) < timezone('UTC', transaction_timestamp()) - make_interval(days => ${config.inquiryDays}::int)
        LIMIT ${DATA_RETENTION_BATCH}
        FOR UPDATE OF i SKIP LOCKED`;
        if (inquiries.length) {
          const ids = inquiries.map((row) => row.id);
          await tx.$executeRaw`
          DELETE FROM inquiry_answers WHERE inquiry_id = ANY(${ids}::text[])`;
          await tx.$executeRaw`
          DELETE FROM inquiries WHERE id = ANY(${ids}::text[])`;
        }
        return { sessions, auditLogs, inquiries: inquiries.length };
      },
      { maxWait: 500, timeout: 20_000 },
    );
  }

  private diagnostic(message: { event: string } & Partial<DataRetentionBatch>) {
    try {
      if (message.event === 'data_retention_failed')
        this.logger.warn(JSON.stringify(message));
      else this.logger.log(JSON.stringify(message));
    } catch {
      /* Logging cannot break maintenance or authentication. */
    }
  }
}
