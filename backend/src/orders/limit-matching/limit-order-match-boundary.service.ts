import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
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
 * ONE SESSION PER LEASE
 * ---------------------
 * The poller and the path-B candle worker live in the SAME Nest provider
 * instance and can call `acquireSession()` concurrently. A single shared
 * connection guarded by a boolean was not safe: PostgreSQL session advisory
 * locks are RE-ENTRANT within one session, so two concurrent acquisitions on
 * the same connection would BOTH succeed, both callers would believe they own
 * the boundary, and the lock counter (2) would only ever be decremented once —
 * leaking the advisory lock for the lifetime of the connection and blocking
 * every future Create, poll, and sweep.
 *
 * Each `acquireSession()` therefore checks out its OWN PoolClient from a
 * dedicated `pg.Pool` and takes `pg_advisory_lock` on that private session.
 * Mutual exclusion is then enforced by PostgreSQL itself across sessions,
 * which is the same guarantee Create already relies on. The lease owns exactly
 * one session; `release()` unlocks on that same session exactly once and then
 * returns the client to the pool. A failed unlock or a broken connection
 * destroys the client instead of returning it, because a session that may
 * still hold the lock must never be handed to the next caller.
 *
 * The pool is capped so a runaway caller cannot exhaust PostgreSQL
 * connections: waiters queue in the pool (and, once connected, inside
 * PostgreSQL) rather than opening unbounded sessions.
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

/**
 * Session ceiling for boundary workers. Only the path-A poller and the path-B
 * candle worker acquire session leases, so 4 leaves headroom for a shutdown
 * overlap without ever competing with the Prisma pool for connections.
 */
export const LIMIT_ORDER_MATCH_BOUNDARY_MAX_SESSIONS = 4;

export type LimitOrderBoundaryLease = {
  release(): Promise<void>;
};

@Injectable()
export class LimitOrderMatchBoundaryService implements OnModuleDestroy {
  private pool: Pool | null = null;
  private closed = false;
  /** Leases handed out and not yet released; observability + shutdown only. */
  private activeLeases = 0;

  /**
   * Transaction-scoped acquisition for Create. MUST be the first statement in
   * the transaction (before Quote/Participant/Season row locks).
   *
   * `$executeRaw`, NOT `$queryRaw`: `pg_advisory_xact_lock` returns `void`, and
   * the Prisma 7 pg driver adapter cannot decode a `void` column — a
   * `$queryRaw` here fails at runtime with P2010 / UnsupportedNativeDataType,
   * which would make EVERY limit-order create fail on its very first statement
   * once automatic matching is enabled. The lock is a statement with no result
   * to read, so `$executeRaw` is also the honest expression of intent.
   */
  async lockInTransaction(tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`
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
   *
   * Every call gets its own PostgreSQL session, so two concurrent callers
   * inside this same process serialize on the server-side advisory lock
   * exactly like two separate processes would.
   */
  async acquireSession(): Promise<LimitOrderBoundaryLease> {
    if (this.closed) {
      throw new Error('Limit-order match boundary pool is shut down.');
    }
    const pool = this.ensurePool();
    const client = await pool.connect();
    if (this.closed) {
      // Shutdown raced the checkout; never take the lock on a session the
      // shutdown path is no longer tracking.
      client.release(true);
      throw new Error('Limit-order match boundary pool is shut down.');
    }
    try {
      await client.query('SELECT pg_advisory_lock($1, $2)', [
        LIMIT_ORDER_MATCH_BOUNDARY_NAMESPACE,
        LIMIT_ORDER_MATCH_BOUNDARY_KEY,
      ]);
    } catch (error) {
      // The lock may or may not have been granted before the failure, so the
      // session is destroyed rather than reused. PostgreSQL releases any
      // session lock it held when the backend goes away.
      client.release(true);
      throw error;
    }
    this.activeLeases += 1;
    return this.createLease(client);
  }

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const lease = await this.acquireSession();
    try {
      return await operation();
    } finally {
      await lease.release();
    }
  }

  /** True while at least one session lease handed out by this process is open. */
  isHeld(): boolean {
    return this.activeLeases > 0;
  }

  /** Diagnostics only: how many session leases this process currently owns. */
  activeSessionCount(): number {
    return this.activeLeases;
  }

  async onModuleDestroy(): Promise<void> {
    this.closed = true;
    const pool = this.pool;
    this.pool = null;
    if (!pool) return;
    // `end()` waits for checked-out clients to be returned and then closes
    // every idle connection. Any session still holding the advisory lock is
    // torn down by PostgreSQL when its backend exits.
    await pool.end().catch(() => undefined);
  }

  /**
   * Builds the lease. `release()` is idempotent: only the first call unlocks
   * and returns the session, so a `finally` that runs twice (or a caller that
   * releases defensively) can never unlock a lock it no longer owns.
   */
  private createLease(client: PoolClient): LimitOrderBoundaryLease {
    let released = false;
    return {
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        this.activeLeases -= 1;
        try {
          await client.query('SELECT pg_advisory_unlock($1, $2)', [
            LIMIT_ORDER_MATCH_BOUNDARY_NAMESPACE,
            LIMIT_ORDER_MATCH_BOUNDARY_KEY,
          ]);
        } catch {
          // A dropped session already released the lock server-side. Destroy
          // the client instead of returning it: a connection whose unlock
          // status is unknown must never serve the next acquisition.
          client.release(true);
          return;
        }
        client.release();
      },
    };
  }

  private ensurePool(): Pool {
    if (this.pool) return this.pool;
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not configured.');
    const pool = new Pool({
      connectionString,
      max: LIMIT_ORDER_MATCH_BOUNDARY_MAX_SESSIONS,
      // A boundary session is held only for the duration of one event or one
      // candle, so an idle session is genuinely idle and can be reclaimed.
      idleTimeoutMillis: 30_000,
      allowExitOnIdle: true,
    });
    // Without a listener an idle-connection error is an unhandled 'error'
    // event and crashes the process. pg removes the broken client from the
    // pool itself; the next acquisition simply opens a fresh session.
    pool.on('error', () => undefined);
    this.pool = pool;
    return pool;
  }
}
