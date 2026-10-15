import { randomUUID } from 'node:crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { projectOpsFailure } from '../../ops/ops-failure';
import {
  AssetPriceSourceType,
  AssetType,
  CurrencyCode,
  Prisma,
} from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisLockService } from '../../redis/redis-lock.service';
import { RedisService } from '../../redis/redis.service';
import { resolveStockMarketSessionState } from '../../orders/market-calendar.policy';
import { buildProviderRawPayloadJson } from '../provider-raw-payload';
import { PROVIDER_PRICE_PUBSUB_CHANNEL } from '../fx-rate-update-event';
import {
  MarketPriceEventService,
  type MarketPriceEvent,
} from '../market-price-event.service';
import { KoscomCallBudgetService } from './koscom-call-budget.service';
import {
  KoscomClient,
  koscomBatches,
  koscomPriceLaneKey,
  type KoscomTarget,
} from './koscom.client';
import {
  KOSCOM_PRICE_SOURCE,
  KOSCOM_BOOK_SOURCE,
  KoscomConfigService,
  KoscomError,
  koscomFailure,
  type KoscomConfig,
} from './koscom.config';
import { KoscomMarketMapService } from './koscom-market-map.service';
import {
  normalizeKoscomOrderbook,
  normalizeKoscomPrice,
} from './koscom-normalizer';
import { ohlcv } from './koscom-candle.adapter';
import { MarketSnapshotHealthService } from '../market-snapshot-health.service';
import {
  KoscomPriceCycleStats,
  koscomPollEffectiveSeconds,
  type KoscomCycleRequest,
} from './koscom-price-cycle-stats';

/**
 * Raw fields a slim KOSCOM price row keeps (design v2.1 §8.4): the price,
 * trade clock and business date, the previous-day change that derives the
 * change rate, the session turnover the asset-list sort reads
 * (`payload.row.accTrdval`, see asset-list-turnover.ts) and the top of book.
 */
export const KOSCOM_PRICE_SLIM_ROW_FIELDS = [
  'trdDd',
  'trdTm',
  'trdPrc',
  'cmpprevddPrc',
  'cmpprevddTpCd',
  'accTrdvol',
  'accTrdval',
  'bidordPrc_1',
  'askordPrc_1',
] as const;

type SnapshotSummary = {
  assetId: string | null;
  symbol: string | null;
  kind: string;
  state: 'created' | 'would_create' | 'skipped' | 'failed';
  reason?: string;
};
export type KoscomIngestionOptions = {
  dryRun?: boolean;
  symbols?: readonly string[];
  maxSnapshots?: number;
  now?: Date;
  onPrice?: (event: MarketPriceEvent) => void | Promise<void>;
};

/** Cycle lock lease: legacy 60 s / 15 s, slot mode 3T / T (design v2.1 §7.5). */
type CycleLease = { ttlMs: number; renewMs: number };
const LEGACY_LEASE: CycleLease = { ttlMs: 60000, renewMs: 15000 };
// 2c: pauses after 3, 4 and 5+ consecutive fully failed price cycles.
const PRICE_BACKOFF_MS = [15_000, 30_000, 60_000] as const;
const PRICE_FAILURE_STREAK_TTL_SECONDS = 600;
const CLOSE_ATTEMPTS_TTL_SECONDS = 2 * 24 * 60 * 60;

@Injectable()
export class KoscomIngestionService {
  private readonly logger = new Logger(KoscomIngestionService.name);
  private readonly cycleStats = new KoscomPriceCycleStats();
  // Identifies this process as a slot owner (observability only).
  private readonly instanceToken = randomUUID();
  private pending: Promise<ReturnType<typeof summary>> | null = null;
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: KoscomConfigService,
    private readonly client: KoscomClient,
    private readonly markets: KoscomMarketMapService,
    private readonly locks: RedisLockService,
    private readonly redis: RedisService,
    private readonly events: MarketPriceEventService,
    private readonly health: MarketSnapshotHealthService,
    @Optional() private readonly budget?: KoscomCallBudgetService,
  ) {}

  collect(options: KoscomIngestionOptions = {}) {
    return this.start(options, () => this.run(options, LEGACY_LEASE));
  }

  /**
   * Slot mode (2b): at most one price cycle per fixed slot
   * `floor(epochMs / T)` across every instance. The slot key is claimed
   * first (SET NX, TTL 3T), then the shared cycle lock (TTL 3T, renewed every
   * T). A slot whose cycle lock is still held — the previous cycle overran,
   * or a crashed owner's lease has not expired — is skipped, never retried:
   * the next slot is the retry. A slot nobody could run leaves prices aging
   * into the existing fail-closed freshness checks.
   */
  collectSlot(input: { slot: number; periodMs: number; now?: Date }) {
    return this.start({ now: input.now }, async () => {
      const config = this.config.getConfig();
      if (!config.enabled) return summary(false, [], 'KOSCOM_DISABLED');
      // Closed hours write no slot keys; only collection or close recovery do.
      const idle = this.resolveCycle(input.now ?? new Date());
      if (idle.kind === 'idle') return summary(false, [], idle.code);
      if (idle.kind === 'collect' && (await this.priceBackoffActive(config)))
        return summary(false, [], 'KOSCOM_PRICE_BACKOFF');
      // 3c: above the hard cap price cycles are paced to the budget left.
      if (
        idle.kind === 'collect' &&
        config.budgetEnforcementEnabled &&
        this.budget &&
        !(await this.budget.priceSlotPermitted({
          namespace: config.namespace,
          caps: {
            dailyCap: config.budgetDailyLimit,
            monthlyCap: config.budgetMonthlyLimit,
          },
          slot: input.slot,
          periodMs: input.periodMs,
          now: input.now,
        }))
      )
        return summary(false, [], 'KOSCOM_BUDGET_PACING');
      let claimed: boolean;
      try {
        claimed = await this.redis.setNxPx(
          `koscom:${config.namespace}:price-slot:${input.slot}`,
          this.instanceToken,
          input.periodMs * 3,
        );
      } catch {
        this.cycleStats.recordSkip(Date.now(), 'unavailable');
        return summary(false, [], 'KOSCOM_COORDINATION_UNAVAILABLE');
      }
      if (!claimed) return summary(false, [], 'KOSCOM_SLOT_TAKEN');
      return this.run(
        { now: input.now },
        { ttlMs: input.periodMs * 3, renewMs: input.periodMs },
      );
    });
  }

  /** Waits (bounded) for an in-flight cycle so it can release its lock (F27). */
  async drain(timeoutMs: number): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      pending.then(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  private start(
    options: KoscomIngestionOptions,
    work: () => Promise<ReturnType<typeof summary>>,
  ) {
    this.flushCycleSummary();
    // Manual and scheduler work share the same lease; never join different dryRun commands.
    if (this.pending) {
      this.cycleStats.recordSkip(Date.now(), 'busy');
      return Promise.resolve(
        summary(Boolean(options.dryRun), [], 'KOSCOM_COLLECTION_BUSY'),
      );
    }
    this.pending = work()
      .catch((error) =>
        summary(Boolean(options.dryRun), [], koscomFailure(error)),
      )
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  /** What a cycle at `now` would do, without any Redis or provider call. */
  private resolveCycle(now: Date):
    | { kind: 'collect' }
    | {
        kind: 'recover_close';
        session: { localDate: string; openTime: Date; closeTime: Date };
      }
    | { kind: 'idle'; code: string } {
    const state = resolveStockMarketSessionState(
      { assetType: AssetType.domestic_stock, market: 'KRX' },
      now,
    );
    if (state?.state === 'closed') {
      const session = state.currentSession;
      if (
        session &&
        state.latestCompletedSession?.localDate === session.localDate &&
        session.closeTime <= now
      )
        return { kind: 'recover_close', session };
      return { kind: 'idle', code: 'MARKET_CLOSED_EXPECTED_NO_DATA' };
    }
    if (state?.state !== 'open')
      return { kind: 'idle', code: 'MARKET_CALENDAR_COVERAGE_MISSING' };
    return { kind: 'collect' };
  }

  private async run(options: KoscomIngestionOptions, lease: CycleLease) {
    const dryRun = Boolean(options.dryRun);
    const config = this.config.getConfig();
    if (!config.enabled) return summary(dryRun, [], 'KOSCOM_DISABLED');
    const now = options.now ?? new Date();
    const cycle = this.resolveCycle(now);
    if (cycle.kind === 'recover_close')
      return this.recoverClose(options, cycle.session);
    if (cycle.kind === 'idle') return summary(dryRun, [], cycle.code);
    if (await this.priceBackoffActive(config))
      return summary(dryRun, [], 'KOSCOM_PRICE_BACKOFF');
    const acquired = await this.locks.acquire(
      `koscom:${config.namespace}:ingestion`,
      lease.ttlMs,
    );
    if (acquired.status !== 'acquired') {
      this.cycleStats.recordSkip(
        Date.now(),
        acquired.status === 'busy' ? 'busy' : 'unavailable',
      );
      return summary(
        dryRun,
        [],
        acquired.status === 'busy'
          ? 'KOSCOM_COLLECTION_BUSY'
          : 'KOSCOM_COORDINATION_UNAVAILABLE',
      );
    }
    const cycleStartedAtMs = Date.now();
    const requests: KoscomCycleRequest[] = [];
    let owned = true;
    let laneHeld = false;
    const timer = setInterval(() => {
      void this.locks
        .extend(acquired.lock)
        .then((ok) => {
          if (!ok) owned = false;
        })
        .catch(() => {
          owned = false;
        });
    }, lease.renewMs);
    timer.unref?.();
    const snapshots: SnapshotSummary[] = [];
    try {
      const assets = await this.prisma.asset.findMany({
        where: {
          assetType: AssetType.domestic_stock,
          currencyCode: CurrencyCode.KRW,
          isActive: true,
          ...(options.symbols ? { symbol: { in: [...options.symbols] } } : {}),
        },
        select: { id: true, symbol: true, market: true },
      });
      const targets: KoscomTarget[] = [];
      for (const asset of assets) {
        try {
          if (assets.filter((a) => a.symbol === asset.symbol).length !== 1)
            throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
              'KOSCOM_ASSET_AMBIGUOUS',
            );
          targets.push({
            assetId: asset.id,
            symbol: asset.symbol,
            market: await this.markets.resolve(asset.symbol, asset.market),
          });
        } catch (error) {
          snapshots.push({
            assetId: asset.id,
            symbol: asset.symbol,
            kind: 'mapping',
            state: 'failed',
            reason: koscomFailure(error),
          });
        }
      }
      const kinds: readonly ('price' | 'orderbook')[] =
        config.orderbookCollectionEnabled ? ['price', 'orderbook'] : ['price'];
      const batches = koscomBatches(targets);
      // With the 3c lane, every price batch is queued before any order-book
      // batch and the lane is released as soon as the last price batch ends.
      const work = config.priceLaneEnabled
        ? kinds.flatMap((kind) =>
            batches.map((batch, index) => ({ batch, kind, index })),
          )
        : batches.flatMap((batch, index) =>
            kinds.map((kind) => ({ batch, kind, index })),
          );
      // Only a full cycle describes the price plan (a manual symbol subset
      // would understate the day's price reservation).
      if (
        (config.callMetricsEnabled || config.budgetEnforcementEnabled) &&
        !dryRun &&
        !options.symbols
      )
        void this.budget?.publishPricePlan(config.namespace, {
          batches: batches.length,
          periodMs: config.pollIntervalMs,
          assets: targets.length,
        });
      let pricePending = work.filter((item) => item.kind === 'price').length;
      if (config.priceLaneEnabled && pricePending > 0)
        laneHeld = await this.redis
          .setNxPx(
            koscomPriceLaneKey(config.namespace),
            this.instanceToken,
            Math.min(config.pollIntervalMs, 10_000),
          )
          .catch(() => false);
      const priceDone = () => {
        pricePending -= 1;
        if (pricePending === 0 && laneHeld) {
          laneHeld = false;
          void this.redis
            .delete(koscomPriceLaneKey(config.namespace))
            .catch(() => undefined);
        }
      };
      let next = 0;
      let accepted = 0;
      await Promise.all(
        Array.from(
          { length: Math.min(config.concurrency, work.length) },
          async () => {
            while (next < work.length && owned) {
              const { batch, kind, index } = work[next++];
              const requestedAtMs = Date.now();
              try {
                // 2c: the next cycle (≤ T away) is the price retry; a retry
                // inside the cycle would overrun it and double-bill the slot.
                const response = await this.client
                  .batch(
                    batch,
                    kind,
                    undefined,
                    config.priceRetryCapsEnabled && kind === 'price'
                      ? { retries: 0 }
                      : {},
                  )
                  .finally(() => {
                    if (kind === 'price') priceDone();
                  });
                requests.push({
                  kind,
                  latencyMs: Date.now() - requestedAtMs,
                  ok: true,
                });
                if (config.pollLogEnabled && kind === 'price')
                  this.logPoll({
                    periodMs: config.pollIntervalMs,
                    cycleStartedAtMs,
                    requestedAtMs,
                    batch,
                    index,
                    receivedAt: response.receivedAt,
                    rows: response.rows,
                  });
                for (const target of batch.targets) {
                  if (!owned)
                    throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
                      'KOSCOM_LOCK_LOST',
                    );
                  const matches = response.rows.filter(
                    (r) => r.isuSrtCd === target.symbol,
                  );
                  if (matches.length !== 1) {
                    snapshots.push({
                      ...target,
                      kind,
                      state: 'failed',
                      reason: matches.length
                        ? 'KOSCOM_DUPLICATE_SYMBOL'
                        : 'KOSCOM_MISSING_SYMBOL',
                    });
                    continue;
                  }
                  if (
                    options.maxSnapshots !== undefined &&
                    accepted >= options.maxSnapshots
                  ) {
                    snapshots.push({
                      ...target,
                      kind,
                      state: 'skipped',
                      reason: 'MAX_SNAPSHOTS_REACHED',
                    });
                    continue;
                  }
                  // Reserve before await so parallel batches cannot exceed the cap.
                  accepted++;
                  try {
                    const result = await this.persist(
                      target,
                      kind,
                      matches[0],
                      response.receivedAt,
                      dryRun,
                      async () => {
                        if (!owned) return false;
                        if (!(await this.locks.extend(acquired.lock)))
                          owned = false;
                        return owned;
                      },
                      options.onPrice,
                    );
                    snapshots.push({ ...target, kind, ...result });
                  } catch (error) {
                    snapshots.push({
                      ...target,
                      kind,
                      state: 'failed',
                      reason: koscomFailure(error),
                    });
                  }
                }
              } catch (error) {
                const code = koscomFailure(error);
                requests.push({
                  kind,
                  latencyMs: Date.now() - requestedAtMs,
                  ok: false,
                });
                if (config.pollLogEnabled && kind === 'price')
                  this.logPoll({
                    periodMs: config.pollIntervalMs,
                    cycleStartedAtMs,
                    requestedAtMs,
                    batch,
                    index,
                    receivedAt: null,
                    rows: [],
                    errorCode: code,
                  });
                snapshots.push(
                  ...batch.targets.map((t) => ({
                    ...t,
                    kind,
                    state: 'failed' as const,
                    reason: code,
                  })),
                );
              }
            }
          },
        ),
      );
      if (!owned) return summary(dryRun, snapshots, 'KOSCOM_LOCK_LOST');
      return summary(dryRun, snapshots);
    } catch (error) {
      return summary(dryRun, snapshots, koscomFailure(error));
    } finally {
      clearInterval(timer);
      if (laneHeld)
        await this.redis
          .delete(koscomPriceLaneKey(config.namespace))
          .catch(() => undefined);
      await this.locks.release(acquired.lock);
      if (!dryRun) await this.recordPriceCycleOutcome(config, requests);
      if (config.cycleMetricsEnabled)
        this.cycleStats.recordCycle({
          startedAtMs: cycleStartedAtMs,
          durationMs: Date.now() - cycleStartedAtMs,
          periodMs: config.pollIntervalMs,
          outcome: !owned
            ? 'failed'
            : requests.length > 0 && requests.every((r) => !r.ok)
              ? 'failed'
              : snapshots.some((s) => s.state === 'failed')
                ? 'partial'
                : 'completed',
          requests,
        });
    }
  }

  /** 2c: whether a cluster-wide price pause is in force (fail-open on Redis). */
  private async priceBackoffActive(config: KoscomConfig): Promise<boolean> {
    if (!config.priceRetryCapsEnabled) return false;
    const until = await this.redis
      .get(`koscom:${config.namespace}:price-backoff-until`)
      .catch(() => null);
    return until !== null && Number(until) > Date.now();
  }

  /**
   * 2c: three consecutive cycles whose every price request failed start a
   * cluster-wide pause (15 s, then 30 s, then 60 s); any successful price
   * request ends the streak. Counter failures never block collection.
   */
  private async recordPriceCycleOutcome(
    config: KoscomConfig,
    requests: readonly KoscomCycleRequest[],
  ): Promise<void> {
    if (!config.priceRetryCapsEnabled) return;
    const prices = requests.filter((request) => request.kind === 'price');
    if (prices.length === 0) return;
    const streakKey = `koscom:${config.namespace}:price-fail-streak`;
    try {
      if (prices.some((request) => request.ok)) {
        await this.redis.delete(streakKey);
        return;
      }
      const streak = await this.redis.increment(streakKey);
      await this.redis.expire(streakKey, PRICE_FAILURE_STREAK_TTL_SECONDS);
      if (streak < 3) return;
      const backoffMs =
        PRICE_BACKOFF_MS[Math.min(streak - 3, PRICE_BACKOFF_MS.length - 1)];
      await this.redis.setWithTtl(
        `koscom:${config.namespace}:price-backoff-until`,
        String(Date.now() + backoffMs),
        Math.ceil(backoffMs / 1000),
      );
      this.logger.warn(
        JSON.stringify({
          event: 'koscom_price_backoff',
          consecutiveFailedCycles: streak,
          backoffMs,
        }),
      );
    } catch {
      // Observation of the streak is best effort; collection continues.
    }
  }

  private flushCycleSummary(): void {
    const due = this.cycleStats.takeSummaryIfDue(Date.now());
    if (due && this.config.getConfig().cycleMetricsEnabled)
      this.logger.log(JSON.stringify(due));
  }

  /**
   * Stage-1 poll log (design v2.1 Q2‴): one line per price batch request with
   * every quoted symbol's provider trade time, stored or not, so 6-second
   * replays can tell "no new trade" from "failed poll". Off by default; never
   * written to the database and never carries a raw provider payload.
   */
  private logPoll(input: {
    periodMs: number;
    cycleStartedAtMs: number;
    requestedAtMs: number;
    batch: { market: string; targets: readonly KoscomTarget[] };
    index: number;
    receivedAt: Date | null;
    rows: readonly Record<string, unknown>[];
    errorCode?: string;
  }): void {
    const quotes = input.batch.targets.map((target) => {
      const row = input.rows.find((r) => r.isuSrtCd === target.symbol);
      return [
        target.symbol,
        row && input.receivedAt
          ? koscomPollEffectiveSeconds(row, input.receivedAt)
          : null,
      ] as const;
    });
    this.logger.log(
      JSON.stringify({
        event: 'koscom_poll',
        slot: Math.floor(input.cycleStartedAtMs / input.periodMs),
        market: input.batch.market,
        batch: input.index,
        requestedAt: new Date(input.requestedAtMs).toISOString(),
        receivedAt: input.receivedAt?.toISOString() ?? null,
        ok: input.receivedAt !== null,
        errorCode: input.errorCode ?? null,
        quotes,
      }),
    );
  }

  private async persist(
    target: KoscomTarget,
    kind: 'price' | 'orderbook',
    row: Record<string, unknown>,
    receivedAt: Date,
    dryRun: boolean,
    owned: () => Promise<boolean>,
    onPrice?: KoscomIngestionOptions['onPrice'],
  ): Promise<Pick<SnapshotSummary, 'state' | 'reason'>> {
    if (kind === 'price') {
      const slim = this.config.getConfig().priceRawSlimEnabled;
      const price = normalizeKoscomPrice(row, receivedAt);
      const latest = await this.prisma.assetPriceSnapshot.findFirst({
        where: {
          assetId: target.assetId,
          sourceType: AssetPriceSourceType.provider_api,
          sourceName: KOSCOM_PRICE_SOURCE,
        },
        orderBy: [{ effectiveAt: 'desc' }, { capturedAt: 'desc' }],
        select: { effectiveAt: true },
      });
      if (latest && latest.effectiveAt >= price.effectiveAt)
        return { state: 'skipped', reason: 'KOSCOM_DUPLICATE_OR_OLDER_PRICE' };
      if (dryRun) return { state: 'would_create' };
      if (!(await owned()))
        throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
          'KOSCOM_LOCK_LOST',
        );
      await this.prisma.assetPriceSnapshot.create({
        data: {
          assetId: target.assetId,
          price: price.price,
          priceKrw: price.price,
          currencyCode: CurrencyCode.KRW,
          sourceType: AssetPriceSourceType.provider_api,
          sourceName: KOSCOM_PRICE_SOURCE,
          sourceTimestamp: price.effectiveAt,
          effectiveAt: price.effectiveAt,
          capturedAt: receivedAt,
          rawPayloadJson: this.raw({
            messageType: 'rest_current_price',
            // Marks an intentionally slimmed row for later audits.
            ...(slim ? { payloadProfile: 'koscom_price_slim_v1' } : {}),
            row: slim ? pickSlimRow(row) : row,
            market: target.market,
            dateBasis: row.trdDd ? 'provider' : 'receipt_session',
            changeRate: price.changeRate,
          }),
        },
      });
      if (!(await owned())) return { state: 'created' };
      const event: MarketPriceEvent = {
        type: 'market_price',
        assetId: target.assetId,
        price: {
          price: price.price,
          currencyCode: 'KRW',
          sourceName: KOSCOM_PRICE_SOURCE,
          effectiveAt: price.effectiveAt.toISOString(),
          capturedAt: receivedAt.toISOString(),
        },
        delayed: false,
        snapshotState: 'created',
        ...(price.topOfBook ? { topOfBook: price.topOfBook } : {}),
      };
      // Redis is the app's existing multi-instance channel. Local fallback is
      // only for a publish failure; successful publication is not sent twice.
      try {
        await this.redis.publish(
          PROVIDER_PRICE_PUBSUB_CHANNEL,
          JSON.stringify(event),
        );
      } catch {
        this.events.publish(event);
      }
      try {
        await onPrice?.(event);
      } catch {
        // Optional local observers cannot undo a durable price snapshot.
      }
      return { state: 'created' };
    }
    const state = resolveStockMarketSessionState(
      { assetType: AssetType.domestic_stock, market: 'KRX' },
      receivedAt,
    );
    if (state?.state !== 'open')
      throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
        'KOSCOM_OUTSIDE_SESSION',
      );
    const book = normalizeKoscomOrderbook(row);
    // v3 orderbook has no documented provider clock: receipt is not a trade timestamp.
    if (dryRun) return { state: 'would_create' };
    if (!(await owned()))
      throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
        'KOSCOM_LOCK_LOST',
      );
    await this.prisma.assetOrderbookSnapshot.create({
      data: {
        assetId: target.assetId,
        sourceType: AssetPriceSourceType.provider_api,
        sourceName: KOSCOM_BOOK_SOURCE,
        bidPrice: book.bids[0].price,
        bidQuantity: book.bids[0].quantity,
        askPrice: book.asks[0].price,
        askQuantity: book.asks[0].quantity,
        spreadBps: book.spreadBps,
        currencyCode: CurrencyCode.KRW,
        effectiveAt: receivedAt,
        capturedAt: receivedAt,
        rawPayloadJson: this.raw({
          messageType: 'rest_hoga',
          row,
          book,
          market: target.market,
          timestampBasis: 'receipt',
        }),
      },
    });
    return { state: 'created' };
  }

  /**
   * 2c: counts this close-recovery attempt for (asset, KST date) and reports
   * whether the configured cap is already exhausted. The first refusal logs a
   * structured alert: no path gives up silently. Fail-open on Redis errors.
   */
  private async closeRecoveryCapped(
    config: KoscomConfig,
    date: string,
    assetId: string,
  ): Promise<boolean> {
    const max = config.closeRecoveryMaxAttempts;
    if (max <= 0) return false;
    const key = `koscom:${config.namespace}:close-attempts:${date}:${assetId}`;
    let attempts: number;
    try {
      attempts = await this.redis.increment(key);
      await this.redis.expire(key, CLOSE_ATTEMPTS_TTL_SECONDS);
    } catch {
      return false;
    }
    if (attempts <= max) return false;
    if (attempts === max + 1)
      this.logger.warn(
        JSON.stringify({
          event: 'koscom_close_recovery_capped',
          assetId,
          sessionDate: date,
          maxAttempts: max,
        }),
      );
    return true;
  }

  private raw(payload: Record<string, unknown>): Prisma.InputJsonValue {
    return buildProviderRawPayloadJson({
      payload: { provider: 'koscom', ...payload },
      maxBytes: 32000,
      secrets: [this.config.getConfig().apiKey],
    }) as Prisma.InputJsonValue;
  }

  private async recoverClose(
    options: KoscomIngestionOptions,
    session: { localDate: string; openTime: Date; closeTime: Date },
  ) {
    const config = this.config.getConfig(),
      dryRun = Boolean(options.dryRun);
    const key = `koscom:${config.namespace}:close:${session.localDate}`;
    if (!dryRun && (await this.redis.get(key).catch(() => null)))
      return summary(dryRun, [], 'KOSCOM_CLOSE_ALREADY_CHECKED');
    const acquired = await this.locks.acquire(
      `koscom:${config.namespace}:ingestion`,
      60000,
    );
    if (acquired.status !== 'acquired')
      return summary(dryRun, [], 'KOSCOM_COLLECTION_BUSY');
    const snapshots: SnapshotSummary[] = [];
    try {
      const now = options.now ?? new Date();
      const before = await this.health.checkActiveAssetCoverage({ now });
      const missing = before.assets.filter(
        (a) =>
          a.assetType === 'domestic_stock' &&
          a.state === 'unavailable' &&
          (!options.symbols || options.symbols.includes(a.symbol)),
      );
      const date = session.localDate.replaceAll('-', '');
      const capped = new Set<string>();
      for (const asset of missing.slice(0, options.maxSnapshots ?? 100)) {
        if (
          !dryRun &&
          (await this.closeRecoveryCapped(config, date, asset.assetId))
        ) {
          capped.add(asset.assetId);
          snapshots.push({
            assetId: asset.assetId,
            symbol: asset.symbol,
            kind: 'session_close',
            state: 'skipped',
            reason: 'KOSCOM_CLOSE_RECOVERY_CAPPED',
          });
          continue;
        }
        try {
          if (!(await this.locks.extend(acquired.lock)))
            throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
              'KOSCOM_LOCK_LOST',
            );
          const market = await this.markets.resolve(asset.symbol, asset.market);
          // closeprice has no documented business date. Dated history is the
          // closing evidence; do not stamp a timestamp-less quote as today's close.
          const response = await this.client.get(
            `/v3/market/closed/${market}/${asset.symbol}/history`,
            {
              trnsmCycleTpCd: 'D',
              inqStrtDd: date,
              inqEndDd: date,
              reqCnt: '1',
            },
            undefined,
            { category: 'recover_close' },
          );
          const rows = response.result.hisLists;
          if (
            response.result.isuSrtCd !== asset.symbol ||
            !Array.isArray(rows) ||
            rows.length !== 1 ||
            response.receivedAt < session.closeTime
          )
            throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
              'KOSCOM_CLOSE_EVIDENCE_MISSING',
            );
          const row = rows[0] as Record<string, unknown>;
          if (row.trdDd !== date)
            throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
              'KOSCOM_CLOSE_DATE_MISMATCH',
            );
          const values = ohlcv(row, false);
          if (!dryRun) {
            if (!(await this.locks.extend(acquired.lock)))
              throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
                'KOSCOM_LOCK_LOST',
              );
            await this.prisma.assetPriceSnapshot.create({
              data: {
                assetId: asset.assetId,
                price: values.close,
                priceKrw: values.close,
                currencyCode: CurrencyCode.KRW,
                sourceType: AssetPriceSourceType.provider_api,
                sourceName: KOSCOM_PRICE_SOURCE,
                sourceTimestamp: null,
                effectiveAt: session.closeTime,
                capturedAt: response.receivedAt,
                rawPayloadJson: this.raw({
                  messageType: 'rest_session_close',
                  market,
                  row,
                  dateBasis: 'provider_history',
                }),
              },
            });
          }
          snapshots.push({
            assetId: asset.assetId,
            symbol: asset.symbol,
            kind: 'session_close',
            state: dryRun ? 'would_create' : 'created',
          });
        } catch (error) {
          snapshots.push({
            assetId: asset.assetId,
            symbol: asset.symbol,
            kind: 'session_close',
            state: 'failed',
            reason: koscomFailure(error),
          });
        }
      }
      if (!dryRun) {
        const after = await this.health.checkActiveAssetCoverage({ now });
        // A capped asset is not retried today; its alert was logged once.
        const incomplete = missing.some(
          (a) =>
            !capped.has(a.assetId) &&
            !after.assets.some(
              (b) => b.assetId === a.assetId && b.state === 'available',
            ),
        );
        await this.redis.setWithTtl(key, '1', incomplete ? 60 : 21600);
        if (incomplete)
          return summary(dryRun, snapshots, 'KOSCOM_CLOSE_RECOVERY_INCOMPLETE');
      }
      return summary(dryRun, snapshots);
    } catch (error) {
      return summary(dryRun, snapshots, koscomFailure(error));
    } finally {
      await this.locks.release(acquired.lock);
    }
  }
}

function pickSlimRow(row: Record<string, unknown>): Record<string, unknown> {
  const slim: Record<string, unknown> = {};
  for (const field of KOSCOM_PRICE_SLIM_ROW_FIELDS)
    if (row[field] !== undefined) slim[field] = row[field];
  return slim;
}

function summary(
  dryRun: boolean,
  snapshots: SnapshotSummary[],
  errorCode?: string,
) {
  const failed = snapshots.filter((s) => s.state === 'failed').length;
  const failure = projectOpsFailure({ message: errorCode }, errorCode);
  return {
    provider: 'koscom' as const,
    dryRun,
    success: !errorCode && failed === 0,
    received: snapshots.length,
    created: snapshots.filter((s) => s.state === 'created').length,
    wouldCreate: snapshots.filter((s) => s.state === 'would_create').length,
    skipped: snapshots.filter((s) => s.state === 'skipped').length,
    failed,
    snapshots,
    ...(errorCode
      ? { errorCode: failure.code, errorMessage: failure.message }
      : {}),
  };
}
