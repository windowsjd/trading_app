import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export const EMAIL_AUTH_CLEANUP_BATCH = 500;
const INTERVAL_MS = 3_600_000;

/** Invoked by the existing Auth maintenance timer; never on the request path. */
@Injectable()
export class EmailAuthCleanupService {
  private readonly logger = new Logger(EmailAuthCleanupService.name);
  private running = false;
  private nextRunAt = 0;

  constructor(private readonly prisma: PrismaService) {}

  async runIfDue() {
    if (this.running || Date.now() < this.nextRunAt) return;
    this.running = true;
    try {
      const result = await this.deleteBatch();
      this.nextRunAt = Date.now() + INTERVAL_MS;
      if (result)
        this.diagnostic({ event: 'auth_email_cleanup_completed', ...result });
    } catch {
      // Fixed diagnostics only. The next existing minute tick retries failure.
      this.diagnostic({ event: 'auth_email_cleanup_failed' });
    } finally {
      this.running = false;
    }
  }

  async deleteBatch() {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '100ms'`;
        await tx.$executeRaw`SET LOCAL statement_timeout = '2s'`;
        const [lock] = await tx.$queryRaw<{ acquired: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtextextended('email-auth-retention', 0)) AS acquired`;
        if (!lock.acquired) return null;
        // UTC TIMESTAMP columns. Freeze the cutoff for both tables in this pass.
        // Separate fixed SQL statements avoid dynamic table names or user inputs.
        // Check proof expiry as well: successful verification can extend its life.
        const challenges = await tx.$executeRaw`
        WITH candidates AS (
          SELECT id FROM email_auth_challenges
          WHERE expires_at < timezone('UTC', transaction_timestamp()) - interval '24 hours'
            AND (proof_expires_at IS NULL OR proof_expires_at < timezone('UTC', transaction_timestamp()) - interval '24 hours')
          ORDER BY expires_at, id LIMIT ${EMAIL_AUTH_CLEANUP_BATCH}
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM email_auth_challenges c USING candidates d
        WHERE c.id = d.id
          AND c.expires_at < timezone('UTC', transaction_timestamp()) - interval '24 hours'
          AND (c.proof_expires_at IS NULL OR c.proof_expires_at < timezone('UTC', transaction_timestamp()) - interval '24 hours')`;
        const buckets = await tx.$executeRaw`
        WITH candidates AS (
          SELECT key FROM email_auth_rate_buckets
          WHERE expires_at < timezone('UTC', transaction_timestamp()) - interval '24 hours'
          ORDER BY expires_at, key LIMIT ${EMAIL_AUTH_CLEANUP_BATCH}
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM email_auth_rate_buckets b USING candidates d
        WHERE b.key = d.key
          AND b.expires_at < timezone('UTC', transaction_timestamp()) - interval '24 hours'`;
        return { challenges, buckets };
      },
      { maxWait: 500, timeout: 5_000 },
    );
  }

  private diagnostic(message: {
    event: string;
    challenges?: number;
    buckets?: number;
  }) {
    try {
      if (message.event === 'auth_email_cleanup_failed')
        this.logger.warn(JSON.stringify(message));
      else this.logger.log(JSON.stringify(message));
    } catch {
      /* Logging cannot break maintenance or authentication. */
    }
  }
}
