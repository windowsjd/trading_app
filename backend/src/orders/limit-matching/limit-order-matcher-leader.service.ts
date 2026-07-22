import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Client } from 'pg';

const ADVISORY_LOCK_NAMESPACE = 1_244_660_901;
const ADVISORY_LOCK_KEY = 1;

@Injectable()
export class LimitOrderMatcherLeaderService implements OnModuleDestroy {
  private client: Client | null = null;

  async tryAcquire(): Promise<boolean> {
    if (this.client) return true;
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not configured.');
    const client = new Client({ connectionString });
    client.on('error', () => {
      if (this.client === client) this.client = null;
    });
    await client.connect();
    const result = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS acquired',
      [ADVISORY_LOCK_NAMESPACE, ADVISORY_LOCK_KEY],
    );
    if (result.rows[0]?.acquired !== true) {
      await client.end();
      return false;
    }
    this.client = client;
    return true;
  }

  /**
   * Proves that the dedicated PostgreSQL session which owns the advisory lock
   * is still alive. A dropped session releases the lock server-side; without
   * this check the old process could otherwise keep consuming Redis while a
   * standby has already become leader.
   */
  async assertHeld(): Promise<void> {
    const client = this.client;
    if (!client) {
      throw new Error('Limit-order matcher leader lock is not held.');
    }
    await client.query('SELECT 1');
    if (this.client !== client) {
      throw new Error('Limit-order matcher leader session was lost.');
    }
  }

  async release(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [
        ADVISORY_LOCK_NAMESPACE,
        ADVISORY_LOCK_KEY,
      ]);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  onModuleDestroy(): Promise<void> {
    return this.release();
  }
}
