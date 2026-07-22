import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Client } from 'pg';
import { Prisma } from '../../generated/prisma/client';

/**
 * Authoritative event-boundary mutex shared by limit-order Create, the path-A
 * live-trade poller, and the path-B closed-candle worker.
 *
 * WHY IT EXISTS
 * -------------
 * Create publishes nothing; it only records "every stream entry after ID X
 * activates this order". Without a mutex this interleaving loses an event
 * permanently:
 *
 *   1. Create reads Redis tail = A
 *   2. price event B is XADDed
 *   3. the poller reads B and finds no candidates (the order is uncommitted)
 *   4. the poller records B as processed and ACKs it
 *   5. Create commits the order with activationStreamId = A
 *
 * B is strictly after activation, so it should have filled the order, but it
 * is already durably processed and will never be re-delivered.
 *
 * The mutex makes the two operations mutually exclusive, so only two orderings
 * remain and both are correct:
 *   - Create first: the poller cannot observe B until the order row is
 *     committed and visible to its candidate query.
 *   - Poller first: B is fully processed before Create reads the tail, so
 *     Create's cursor already includes B and B can never fill the new order.
 *
 * LOCK MODE
 * ---------
 * Create takes a TRANSACTION-scoped lock (pg_advisory_xact_lock) as the very
 * FIRST statement of its transaction, so it is released exactly at commit and
 * can never be held past the point where the order row becomes visible.
 *
 * The poller and the candle worker take a SESSION-scoped lock on a DEDICATED
 * PostgreSQL connection (never a Prisma pool connection). If the worker
 * process dies, PostgreSQL tears the session down and releases the lock
 * server-side — no lease, no TTL, no Redis.
 *
 * LOCK ORDER
 * ----------
 * Every participant takes this lock BEFORE any row lock, which is what keeps
 * the graph acyclic:
 *   Create : boundary -> Quote -> SeasonParticipant -> Season -> Wallet
 *   Poller : boundary -> SeasonParticipant -> Season -> Order -> Wallet
 *   CandleB: boundary -> SeasonParticipant -> Season -> Order -> Wallet
 * A boundary holder can wait on a row lock, but nothing that holds a row lock
 * ever waits on the boundary, so no cycle can form. Acquiring the boundary
 * after a row lock would be a real (and undetectable, because the session lock
 * lives on a different connection) deadlock — do not reorder these.
 */

/** Distinct from the matcher LEADER advisory key (namespace 1244660901, key 1). */
export const LIMIT_ORDER_MATCH_BOUNDARY_NAMESPACE = 1_244_660_901;
export const LIMIT_ORDER_MATCH_BOUNDARY_KEY = 2;

export type LimitOrderBoundaryLease = {
  release(): Promise<void>;
};

@Injectable()
export class LimitOrderMatchBoundaryService implements OnModuleDestroy {
  private client: Client | null = null;
  private held = false;

  /**
   * Transaction-scoped acquisition for Create. MUST be the first statement in
   * the transaction (before Quote/Participant/Season row locks).
   */
  async lockInTransaction(tx: Prisma.TransactionClient): Promise<void> {
    await tx.$queryRaw`
      SELECT pg_advisory_xact_lock(
        ${LIMIT_ORDER_MATCH_BOUNDARY_NAMESPACE}::int,
        ${LIMIT_ORDER_MATCH_BOUNDARY_KEY}::int
      )
    `;
  }

  /**
   * Session-scoped acquisition for the poller / candle worker. The returned
   * lease must be released after the durable dedupe row is committed and
   * BEFORE the Redis ACK.
   */
  async acquireSession(): Promise<LimitOrderBoundaryLease> {
    if (this.held) {
      throw new Error(
        'Limit-order match boundary is already held by this process.',
      );
    }
    const client = await this.connect();
    await client.query('SELECT pg_advisory_lock($1, $2)', [
      LIMIT_ORDER_MATCH_BOUNDARY_NAMESPACE,
      LIMIT_ORDER_MATCH_BOUNDARY_KEY,
    ]);
    this.held = true;
    return {
      release: async () => {
        if (!this.held) return;
        this.held = false;
        // A dropped session already released the lock server-side; treat an
        // unlock failure as released rather than blocking the caller forever.
        try {
          await client.query('SELECT pg_advisory_unlock($1, $2)', [
            LIMIT_ORDER_MATCH_BOUNDARY_NAMESPACE,
            LIMIT_ORDER_MATCH_BOUNDARY_KEY,
          ]);
        } catch {
          this.dropClient(client);
        }
      },
    };
  }

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const lease = await this.acquireSession();
    try {
      return await operation();
    } finally {
      await lease.release();
    }
  }

  isHeld(): boolean {
    return this.held;
  }

  async onModuleDestroy(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.held = false;
    if (!client) return;
    await client.end().catch(() => undefined);
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not configured.');
    const client = new Client({ connectionString });
    client.on('error', () => this.dropClient(client));
    await client.connect();
    this.client = client;
    return client;
  }

  private dropClient(client: Client): void {
    if (this.client === client) this.client = null;
    this.held = false;
    void client.end().catch(() => undefined);
  }
}
