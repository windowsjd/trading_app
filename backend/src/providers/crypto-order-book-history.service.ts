import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  databaseFailureKind,
  type DatabaseFailureKind,
} from '../common/database-failure';
import type { OrderBookLevel } from './order-book.types';
import { cryptoOrderBookHistoryConfig } from './crypto-order-book-history.config';

export type OrderBookHistoryMarket = 'spot' | 'futures';

/** A book the display path already accepted (parser, ordering, sequence). */
export type OrderBookHistoryBook = {
  sequence: string;
  bids: readonly OrderBookLevel[];
  asks: readonly OrderBookLevel[];
};

type Candidate = OrderBookHistoryBook & {
  market: OrderBookHistoryMarket;
  /** Spot asset id or USDⓈ-M instrument id, never interchangeable. */
  productId: string;
  bucket: number;
  receivedAt: number;
  /** Provider transaction time (USDⓈ-M only; Spot partial books have none). */
  effectiveAt: number | null;
};

export type CryptoOrderBookHistoryStatus = {
  enabled: boolean;
  trackedProducts: { spot: number; futures: number };
  /** Closed minutes waiting for their write (at most one per product). */
  pendingRows: number;
  writeInFlight: boolean;
  counts: {
    /** Books refused for history: empty side, crossed, zero quantity,
     * delayed or clock-skewed provider time. The realtime fanout is unchanged. */
    invalid: number;
    /** Books for a minute this process has already closed (clock step back). */
    late: number;
    closedMinutes: number;
    /** Closed minutes whose newest book was older than maxBookAgeMs at the
     * minute's end (a silent or stale stream): nothing is stored. */
    staleMinutes: number;
    inserted: number;
    /** Minutes another writer (instance, restart) had already stored. */
    duplicates: number;
    /** Unwritten minutes replaced by the next minute of the same product
     * while the database was failing: never queued without bound. */
    superseded: number;
    /** Rows the database refused individually (never retried). */
    rejected: number;
  };
  lastInsertedAt: string | null;
  consecutiveWriteFailures: number;
  lastWriteFailure: { kind: DatabaseFailureKind; at: string } | null;
};

const INT64_MAX = 9_223_372_036_854_775_807n;
const ALERT_INTERVAL_MS = 60_000;
const MAX_BACKOFF_MS = 60_000;

/**
 * 60 s history of the Spot and USDⓈ-M 10-level books (display only).
 *
 * The existing WebSocket owners hand every book they accept to `offerSpot` /
 * `offerFutures` — an in-memory O(1) step, never awaited and never a reason
 * to drop or delay the realtime publish. Per product and UTC minute only the
 * newest valid book is kept; when the minute ends it is queued if it was
 * still current (≤ maxBookAgeMs old) at that moment, else nothing is stored.
 * A 1 s timer writes the queue with one bounded INSERT ... ON CONFLICT DO
 * NOTHING per table: the (minute, product) primary key makes a restart,
 * reconnect or second instance unable to add a second row. No REST call, no
 * new socket and no fabricated book or provider time.
 */
@Injectable()
export class CryptoOrderBookHistoryService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(CryptoOrderBookHistoryService.name);
  private readonly config = cryptoOrderBookHistoryConfig();
  /** Newest valid book of each product's open minute. */
  private readonly open = new Map<string, Candidate>();
  /** Last minute each product closed; earlier books are late. */
  private readonly closed = new Map<string, number>();
  private readonly queue = new Map<string, Candidate>();
  private timer?: NodeJS.Timeout;
  private writing?: Promise<void>;
  private stopping = false;
  private nextAttemptAt = 0;
  private failures = 0;
  private lastFailure: { kind: DatabaseFailureKind; at: number } | null = null;
  private lastInsertedAt: number | null = null;
  private readonly lastAlert = new Map<string, number>();
  private readonly counts: CryptoOrderBookHistoryStatus['counts'] = {
    invalid: 0,
    late: 0,
    closedMinutes: 0,
    staleMinutes: 0,
    inserted: 0,
    duplicates: 0,
    superseded: 0,
    rejected: 0,
  };

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    if (!this.config.enabled) return;
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref?.();
  }

  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.writing;
    // Closed minutes still queued get one last bounded attempt; open minutes
    // are not complete and are left to the next owner of the stream.
    if (this.config.enabled && this.queue.size) await this.flush(Date.now());
  }

  offerSpot(assetId: string, book: OrderBookHistoryBook, receivedAt: Date) {
    this.offer('spot', assetId, book, receivedAt, null);
  }

  offerFutures(
    instrumentId: string,
    book: OrderBookHistoryBook & { effectiveAt: string | null },
    receivedAt: Date,
  ) {
    this.offer(
      'futures',
      instrumentId,
      book,
      receivedAt,
      book.effectiveAt === null ? Number.NaN : Date.parse(book.effectiveAt),
    );
  }

  /** Closes minutes that ended without a newer book and starts a write. */
  tick(now = Date.now()) {
    if (!this.config.enabled || this.stopping) return;
    for (const candidate of [...this.open.values()])
      if (now >= candidate.bucket + this.config.bucketMs) this.close(candidate);
    if (this.queue.size && !this.writing && now >= this.nextAttemptAt)
      this.writing = this.flush(now).finally(() => {
        this.writing = undefined;
      });
  }

  /** Resolves when the current write (if any) has finished; for tests. */
  async settled() {
    await this.writing;
  }

  getStatus(): CryptoOrderBookHistoryStatus {
    const keys = new Set([...this.open.keys(), ...this.closed.keys()]);
    let spot = 0;
    for (const key of keys) if (key.startsWith('spot:')) spot++;
    return {
      enabled: this.config.enabled,
      trackedProducts: { spot, futures: keys.size - spot },
      pendingRows: this.queue.size,
      writeInFlight: this.writing !== undefined,
      counts: { ...this.counts },
      lastInsertedAt:
        this.lastInsertedAt === null
          ? null
          : new Date(this.lastInsertedAt).toISOString(),
      consecutiveWriteFailures: this.failures,
      lastWriteFailure: this.lastFailure && {
        kind: this.lastFailure.kind,
        at: new Date(this.lastFailure.at).toISOString(),
      },
    };
  }

  private offer(
    market: OrderBookHistoryMarket,
    productId: string,
    book: OrderBookHistoryBook,
    receivedAt: Date,
    effectiveAt: number | null,
  ) {
    if (!this.config.enabled || this.stopping) return;
    try {
      const at = receivedAt.getTime();
      if (!this.valid(book, at, effectiveAt)) {
        this.counts.invalid++;
        return;
      }
      const key = `${market}:${productId}`;
      const bucket = at - (at % this.config.bucketMs);
      const closed = this.closed.get(key);
      const current = this.open.get(key);
      if (
        (closed !== undefined && bucket <= closed) ||
        (current && bucket < current.bucket)
      ) {
        this.counts.late++;
        return;
      }
      if (current && current.bucket < bucket) this.close(current);
      this.open.set(key, {
        market,
        productId,
        bucket,
        receivedAt: at,
        effectiveAt,
        sequence: book.sequence,
        bids: book.bids,
        asks: book.asks,
      });
    } catch {
      // History is best effort: a malformed value is counted, never thrown
      // into the WebSocket frame path.
      this.counts.invalid++;
    }
  }

  private valid(
    book: OrderBookHistoryBook,
    receivedAt: number,
    effectiveAt: number | null,
  ) {
    const { bids, asks, sequence } = book;
    if (
      !bids.length ||
      !asks.length ||
      bids.length > 10 ||
      asks.length > 10 ||
      !/^\d{1,19}$/u.test(sequence) ||
      BigInt(sequence) > INT64_MAX ||
      [...bids, ...asks].some((level) => !/[1-9]/u.test(level.quantity)) ||
      !new Prisma.Decimal(bids[0].price).lt(asks[0].price)
    )
      return false;
    if (effectiveAt === null) return true;
    return (
      Number.isFinite(effectiveAt) &&
      Math.abs(receivedAt - effectiveAt) <= this.config.maxBookAgeMs
    );
  }

  private close(candidate: Candidate) {
    const key = `${candidate.market}:${candidate.productId}`;
    if (this.open.get(key) === candidate) this.open.delete(key);
    this.closed.set(key, candidate.bucket);
    this.counts.closedMinutes++;
    if (
      candidate.bucket + this.config.bucketMs - candidate.receivedAt >
      this.config.maxBookAgeMs
    ) {
      this.counts.staleMinutes++;
      return;
    }
    if (this.queue.has(key)) this.counts.superseded++;
    this.queue.set(key, candidate);
  }

  private async flush(now: number) {
    const rows = [...this.queue.values()];
    this.queue.clear();
    const retry: Candidate[] = [];
    let failure: unknown;
    for (const market of ['spot', 'futures'] as const) {
      const batch = rows.filter((row) => row.market === market);
      if (!batch.length) continue;
      try {
        this.inserted(batch.length, await this.insert(market, batch), now);
      } catch (error) {
        if (databaseFailureKind(error) !== 'data_rejected') {
          retry.push(...batch);
          failure = error;
          continue;
        }
        // One refused row never blocks the rest of the minute.
        for (const row of batch)
          try {
            this.inserted(1, await this.insert(market, [row]), now);
          } catch (rowError) {
            if (databaseFailureKind(rowError) === 'data_rejected')
              this.counts.rejected++;
            else {
              retry.push(row);
              failure = rowError;
            }
          }
      }
    }
    if (failure === undefined) {
      this.failures = 0;
      this.nextAttemptAt = 0;
      return;
    }
    // Unwritten minutes wait for the next attempt unless the same product
    // has meanwhile closed a newer one: memory stays one row per product.
    for (const row of retry) {
      const key = `${row.market}:${row.productId}`;
      if (this.queue.has(key)) this.counts.superseded++;
      else this.queue.set(key, row);
    }
    this.failed(databaseFailureKind(failure), now);
  }

  private insert(market: OrderBookHistoryMarket, rows: Candidate[]) {
    const levels = (side: readonly OrderBookLevel[]) =>
      side.map((level) => [level.price, level.quantity]);
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
        const common = (row: Candidate) => ({
          bucketStartAt: new Date(row.bucket),
          capturedAt: new Date(row.receivedAt),
          sequence: BigInt(row.sequence),
          bids: levels(row.bids),
          asks: levels(row.asks),
        });
        const { count } =
          market === 'spot'
            ? await tx.cryptoSpotOrderBookSnapshot.createMany({
                data: rows.map((row) => ({
                  ...common(row),
                  assetId: row.productId,
                })),
                skipDuplicates: true,
              })
            : await tx.futuresOrderBookSnapshot.createMany({
                data: rows.map((row) => ({
                  ...common(row),
                  instrumentId: row.productId,
                  effectiveAt: new Date(row.effectiveAt!),
                })),
                skipDuplicates: true,
              });
        return count;
      },
      { timeout: 10_000 },
    );
  }

  private inserted(offered: number, inserted: number, now: number) {
    this.counts.inserted += inserted;
    this.counts.duplicates += offered - inserted;
    if (inserted > 0) this.lastInsertedAt = now;
  }

  private failed(kind: DatabaseFailureKind, now: number) {
    this.failures++;
    this.lastFailure = { kind, at: now };
    this.nextAttemptAt =
      now + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this.failures, 6));
    const fields = {
      event:
        kind === 'disk_full'
          ? 'db_disk_full'
          : 'crypto_order_book_history_persist_failed',
      source: 'crypto_order_book_history',
      kind,
      consecutive: this.failures,
      pendingRows: this.queue.size,
    };
    const last = this.lastAlert.get(kind);
    if (last !== undefined && now - last < ALERT_INTERVAL_MS) return;
    this.lastAlert.set(kind, now);
    if (kind === 'disk_full') this.logger.error(JSON.stringify(fields));
    else this.logger.warn(JSON.stringify(fields));
  }
}
