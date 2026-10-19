import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { createApiError } from '../common/api-error';
import type { BinanceCandleIngestionService } from '../providers/binance/binance-candle.ingestion.service';
import type { CanonicalBinanceCandle } from '../providers/binance/binance-candle.types';
import { BINANCE_USDM_CANDLE_INGESTION } from '../providers/binance/binance-kline-usdm.client';
import { ProviderHttpError } from '../providers/provider.types';
import {
  FUTURES_CHART_WINDOWS,
  futuresProviderWindow,
  isProviderReadCurrent,
  type FuturesChartInterval,
  type FuturesChartWindow,
} from './market-candle-futures-windows';

/**
 * On-demand USDⓈ-M contract klines for the chart intervals that are not
 * stored (5m, 15m, 30m, 1h, 1d — see market-candle-futures-windows.ts).
 *
 * Viewers never multiply provider calls:
 *  - ONE cached read per (contract, interval) serves every viewer until it
 *    stops being current (interval freshness or the next bucket boundary);
 *  - concurrent viewers of a stale key share ONE in-flight provider call;
 *  - provider calls run ONE AT A TIME, at least 150 ms apart (the 4h upkeep's
 *    rule), so chart reads never hold more than one of the shared Binance REST
 *    coordinator's two slots and Futures Last/Mark recovery keeps the other; a
 *    viewer that already has a cached copy waits at most 2 s for its refresh,
 *    then gets the copy marked stale while the refresh finishes for the next
 *    poll;
 *  - a refresh re-reads only the tail (from the bucket before the last cached
 *    one, so the bucket that closed last is read again after its close; under
 *    100 rows = Binance weight 1); the whole window is read when nothing usable
 *    is cached, and once when the cached copy has a missing bucket;
 *  - provider calls are capped per minute per process
 *    (FUTURES_CANDLE_PROVIDER_MAX_CALLS_PER_MINUTE), on top of the shared
 *    Binance REST coordinator's weight budget and 418/429 cooldown;
 *  - a failed key is not retried for a while; a 418/429 pauses every
 *    on-demand read (≥ 30 s or Retry-After), and the coordinator's own refusal
 *    (its shared minute budget spent, a recovery probe running) pauses them
 *    until it admits again — an outage cannot become a retry storm;
 *  - a series nobody has read for 10 minutes is dropped from memory.
 *
 * When a refresh cannot run or fails, the last good read is served marked
 * `stale` (its time is in the response); with nothing cached the read is a
 * 503 the app shows as a retryable chart error. Candles are never padded,
 * interpolated or taken from Mark, Index or Spot klines.
 */

export type FuturesProviderInterval = Exclude<FuturesChartInterval, '4h'>;

/** One contract kline as served: decimal strings, UTC open/close. */
export type FuturesProviderCandle = {
  openMs: number;
  /** Exclusive end of the bucket (open + interval). */
  closeMs: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  amount: string;
  /** Binance's own close time had passed when the kline was received. */
  isClosed: boolean;
};

export type FuturesProviderRead = {
  candles: readonly FuturesProviderCandle[];
  /** When the served klines were received from Binance. */
  fetchedAt: Date;
  /** True when a refresh was due but could not run or failed. */
  stale: boolean;
};

type Entry = {
  candles: FuturesProviderCandle[] | null;
  /** The clock of the provider call the candles came from. */
  fetchedAtMs: number | null;
  /** No provider call for this key before this instant. */
  retryAfterMs: number;
  /** A missing bucket the whole window was already re-read for once. */
  gapRereadOpenMs: number | null;
  /** Wall clock of the last read; idle series are dropped. */
  lastReadAtMs: number;
};

export type FuturesCandleProviderConfig = {
  maxCallsPerMinute: number;
  /** Tests only: the gap between provider calls (default 150 ms). */
  callSpacingMs?: number;
  /** Tests only: how long a viewer with a cached copy waits (default 2 s). */
  warmWaitMs?: number;
  /** Tests only: how long a viewer with nothing cached waits (default 8 s). */
  coldWaitMs?: number;
  /** Tests only: the longest one call keeps its turn (default 15 s). */
  turnMaxHoldMs?: number;
};

const DEFAULT_MAX_CALLS_PER_MINUTE = 60;
const MAX_CACHED_SERIES = 200;
/** Below 100 rows Binance prices `/fapi/v1/klines` at weight 1. */
const TAIL_ROWS_MAX = 99;
const KEY_FAILURE_BACKOFF_MS = 15_000;
const BUSY_BACKOFF_MS = 3_000;
const RATE_LIMIT_BACKOFF_MS = 30_000;
const COORDINATOR_PAUSE_MIN_MS = 1_000;
const COORDINATOR_PAUSE_MAX_MS = 60_000;
const CALL_SPACING_MS = 150;
/** Longest one call keeps its turn (HTTP timeout 5 s + admission ≤ 1 s). */
const TURN_MAX_HOLD_MS = 15_000;
const WARM_WAIT_MS = 2_000;
const COLD_WAIT_MS = 8_000;
const IDLE_EXPIRY_MS = 10 * 60_000;
const TIMED_OUT = Symbol('timed-out');
export const FUTURES_CANDLES_UNAVAILABLE_MESSAGE =
  'Futures chart data is temporarily unavailable. Try again shortly.';

/** Strict: an invalid value refuses to boot rather than silently changing load. */
export function readFuturesCandleProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
): FuturesCandleProviderConfig {
  const raw = env.FUTURES_CANDLE_PROVIDER_MAX_CALLS_PER_MINUTE?.trim();
  if (raw === undefined || raw === '') {
    return { maxCallsPerMinute: DEFAULT_MAX_CALLS_PER_MINUTE };
  }
  const value = /^\d+$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1 || value > 600) {
    // @diagnosticSurface internal: Boot-time configuration guard; the process refuses to start and no HTTP response exists yet.
    throw new Error(
      'FUTURES_CANDLE_PROVIDER_MAX_CALLS_PER_MINUTE must be an integer between 1 and 600.',
    );
  }
  return { maxCallsPerMinute: value };
}

@Injectable()
export class FuturesCandleProviderService {
  private readonly logger = new Logger(FuturesCandleProviderService.name);
  private readonly entries = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<Entry>>();
  private readonly callTimes: number[] = [];
  private globalRetryAfterMs = 0;
  private readonly config: FuturesCandleProviderConfig;
  private readonly callSpacingMs: number;
  private readonly warmWaitMs: number;
  private readonly coldWaitMs: number;
  private readonly turnMaxHoldMs: number;
  /** Provider calls queue here: one at a time (see the class comment). */
  private gate: Promise<void> = Promise.resolve();
  private lastCallEndedAtMs = 0;

  // Registered through a factory in AssetsModule (the config is read at boot);
  // a bare class registration could not resolve `config`.
  constructor(
    @Inject(BINANCE_USDM_CANDLE_INGESTION)
    private readonly ingestion: Pick<
      BinanceCandleIngestionService,
      'fetchKlinesPage'
    >,
    config?: FuturesCandleProviderConfig,
  ) {
    this.config = config ?? readFuturesCandleProviderConfig();
    this.callSpacingMs = this.config.callSpacingMs ?? CALL_SPACING_MS;
    this.warmWaitMs = this.config.warmWaitMs ?? WARM_WAIT_MS;
    this.coldWaitMs = this.config.coldWaitMs ?? COLD_WAIT_MS;
    this.turnMaxHoldMs = this.config.turnMaxHoldMs ?? TURN_MAX_HOLD_MS;
  }

  async read(input: {
    instrumentId: string;
    symbol: string;
    interval: FuturesProviderInterval;
    now: Date;
  }): Promise<FuturesProviderRead> {
    const window = FUTURES_CHART_WINDOWS[input.interval];
    const key = `${input.instrumentId}|${input.interval}`;
    const nowMs = input.now.getTime();
    const entry = this.touch(key);
    if (
      entry?.candles &&
      entry.fetchedAtMs !== null &&
      isProviderReadCurrent(window, entry.fetchedAtMs, nowMs)
    ) {
      return this.view(entry, false);
    }

    let pending = this.inFlight.get(key);
    if (!pending) {
      if (!this.mayCall(entry, nowMs)) {
        return this.fallback(key, entry);
      }
      pending = this.refresh(key, input, window, entry).finally(() =>
        this.inFlight.delete(key),
      );
      // Viewers await it, or stop waiting; either way it never goes unhandled.
      pending.catch(() => undefined);
      this.inFlight.set(key, pending);
    }

    try {
      // Behind other contracts' calls: a viewer with a copy gets it (stale)
      // soon; one with nothing gets the retryable 503 rather than hanging. The
      // refresh itself goes on and serves the next poll or retry.
      const next = await within(
        pending,
        entry?.candles ? this.warmWaitMs : this.coldWaitMs,
      );
      if (next === TIMED_OUT) return this.fallback(key, entry);
      // A refresh taken before this request's bucket began lacks that bucket.
      const current =
        next.fetchedAtMs !== null &&
        isProviderReadCurrent(window, next.fetchedAtMs, nowMs);
      return this.view(next, !current);
    } catch {
      return this.fallback(key, entry);
    }
  }

  private refresh(
    key: string,
    input: { symbol: string; interval: FuturesProviderInterval; now: Date },
    window: FuturesChartWindow,
    entry: Entry | undefined,
  ): Promise<Entry> {
    const queuedAtMs = Date.now();
    return this.exclusive(() =>
      this.fetchInto(key, input, window, entry, queuedAtMs),
    );
  }

  private async fetchInto(
    key: string,
    input: { symbol: string; interval: FuturesProviderInterval; now: Date },
    window: FuturesChartWindow,
    entry: Entry | undefined,
    queuedAtMs: number,
  ): Promise<Entry> {
    // The call's own clock: time spent queued moves the request's "now" on.
    const nowMs = input.now.getTime() + Math.max(0, Date.now() - queuedAtMs);
    const now = new Date(nowMs);
    const bounds = futuresProviderWindow(window, nowMs);
    const previous = entry?.candles ?? null;
    // A missing bucket (a row the parser refused) is re-read once with the
    // whole window; a bucket Binance itself never had is not re-read again.
    const gapOpenMs = firstGapOpenMs(previous, window.intervalMs);
    const rereadGap =
      gapOpenMs !== null && gapOpenMs !== (entry?.gapRereadOpenMs ?? null);
    // From the bucket BEFORE the last cached one: the bucket that closed last
    // is read again after its close (late revisions) at the same weight.
    const anchor = previous?.at(previous.length >= 2 ? -2 : -1);
    const tailRows = anchor
      ? (bounds.currentStartMs - anchor.openMs) / window.intervalMs + 1
      : Number.POSITIVE_INFINITY;
    const tailStart =
      !rereadGap &&
      anchor &&
      anchor.openMs >= bounds.fromMs &&
      tailRows >= 1 &&
      tailRows <= TAIL_ROWS_MAX
        ? anchor.openMs
        : null;

    try {
      const page = await this.ingestion.fetchKlinesPage({
        symbol: input.symbol,
        interval: input.interval,
        from: new Date(tailStart ?? bounds.fromMs),
        to: new Date(bounds.toMs),
        now,
        limit: tailStart === null ? bounds.rows : tailRows,
      });
      if (
        page.stopReason === 'malformed_response' ||
        page.stopReason === 'cursor_not_advanced' ||
        (tailStart !== null && page.candles.length === 0)
      ) {
        // @diagnosticSurface internal: Caught just below; only its fixed category is logged and the reader gets stale klines or FUTURES_CANDLES_UNAVAILABLE.
        throw new ProviderHttpError(
          'binance',
          'PROVIDER_MALFORMED_RESPONSE',
          'binance klines page was not usable (PROVIDER_MALFORMED_RESPONSE).',
        );
      }
      const fresh = page.candles.map((candle) =>
        toProviderCandle(candle, window.intervalMs),
      );
      const merged =
        tailStart === null || !previous
          ? fresh
          : [
              ...previous.filter((candle) => candle.openMs < tailStart),
              ...fresh,
            ];
      const next: Entry = {
        candles: merged.filter(
          (candle) =>
            candle.openMs >= bounds.fromMs && candle.openMs < bounds.toMs,
        ),
        fetchedAtMs: nowMs,
        retryAfterMs: 0,
        gapRereadOpenMs: rereadGap
          ? gapOpenMs
          : (entry?.gapRereadOpenMs ?? null),
        lastReadAtMs: Date.now(),
      };
      this.store(key, next);
      return next;
    } catch (caught) {
      const outcome = providerFailureCode(caught);
      const backoffMs =
        outcome === 'PROVIDER_RATE_LIMITED'
          ? rateLimitPauseMs(caught)
          : outcome === 'BINANCE_REST_BUSY'
            ? BUSY_BACKOFF_MS
            : KEY_FAILURE_BACKOFF_MS;
      if (outcome === 'PROVIDER_RATE_LIMITED') {
        this.globalRetryAfterMs = Math.max(
          this.globalRetryAfterMs,
          nowMs + backoffMs,
        );
      }
      this.store(key, {
        candles: previous,
        fetchedAtMs: entry?.fetchedAtMs ?? null,
        retryAfterMs: nowMs + backoffMs,
        gapRereadOpenMs: entry?.gapRereadOpenMs ?? null,
        lastReadAtMs: Date.now(),
      });
      this.logger.warn(
        JSON.stringify({
          event: 'futures_candle_provider_read_failed',
          series: key,
          outcome,
          servedStale: previous !== null,
        }),
      );
      throw caught;
    }
  }

  /**
   * One provider call at a time, at least `callSpacingMs` after the previous
   * one ended — whatever the contract or interval. A call that never settles
   * gives up its turn after TURN_MAX_HOLD_MS rather than stall every later one.
   */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    let release: () => void = () => undefined;
    const turnEnded = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = this.gate.then(async () => {
      const timer = setTimeout(() => release(), this.turnMaxHoldMs);
      timer.unref();
      try {
        const waitMs = this.lastCallEndedAtMs + this.callSpacingMs - Date.now();
        if (waitMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
        }
        try {
          return await task();
        } finally {
          this.lastCallEndedAtMs = Date.now();
        }
      } finally {
        clearTimeout(timer);
        release();
      }
    });
    this.gate = turnEnded;
    return run;
  }

  /** Per-key backoff, the global rate-limit pause, then the minute cap. */
  private mayCall(entry: Entry | undefined, nowMs: number): boolean {
    if (nowMs < this.globalRetryAfterMs) return false;
    if (entry && nowMs < entry.retryAfterMs) return false;
    while (this.callTimes.length > 0 && this.callTimes[0] <= nowMs - 60_000) {
      this.callTimes.shift();
    }
    if (this.callTimes.length >= this.config.maxCallsPerMinute) return false;
    this.callTimes.push(nowMs);
    return true;
  }

  private fallback(key: string, seen?: Entry): FuturesProviderRead {
    const entry = this.entries.get(key) ?? seen;
    if (entry?.candles && entry.fetchedAtMs !== null) {
      return this.view(entry, true);
    }
    throw createApiError(
      'FUTURES_CANDLES_UNAVAILABLE',
      FUTURES_CANDLES_UNAVAILABLE_MESSAGE,
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  private view(entry: Entry, stale: boolean): FuturesProviderRead {
    return {
      candles: entry.candles ?? [],
      fetchedAt: new Date(entry.fetchedAtMs ?? 0),
      stale,
    };
  }

  /**
   * Least-recently-read order keeps the cache bounded; series idle for
   * IDLE_EXPIRY_MS are dropped, so memory follows what is being viewed.
   */
  private touch(key: string): Entry | undefined {
    const wallMs = Date.now();
    for (const [other, entry] of this.entries) {
      if (entry.lastReadAtMs > wallMs - IDLE_EXPIRY_MS) break;
      if (!this.inFlight.has(other)) this.entries.delete(other);
    }
    const entry = this.entries.get(key);
    if (entry) {
      entry.lastReadAtMs = wallMs;
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }

  private store(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > MAX_CACHED_SERIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

/** Resolves with the promise, or TIMED_OUT once `ms` passes (no timer kept). */
async function within<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Open of the first bucket missing between two cached ones, or null. */
function firstGapOpenMs(
  candles: readonly FuturesProviderCandle[] | null,
  intervalMs: number,
): number | null {
  if (!candles) return null;
  for (let index = 1; index < candles.length; index += 1) {
    if (candles[index].openMs - candles[index - 1].openMs > intervalMs) {
      return candles[index - 1].openMs + intervalMs;
    }
  }
  return null;
}

function toProviderCandle(
  candle: CanonicalBinanceCandle,
  intervalMs: number,
): FuturesProviderCandle {
  const openMs = candle.openTime.getTime();
  return {
    openMs,
    closeMs: openMs + intervalMs,
    open: candle.open.toFixed(8),
    high: candle.high.toFixed(8),
    low: candle.low.toFixed(8),
    close: candle.close.toFixed(8),
    volume: candle.volume.toFixed(8),
    amount: candle.amount ? candle.amount.toFixed(8) : '0.00000000',
    isClosed: candle.isClosed,
  };
}

/** A fixed category only: provider bodies, URLs and messages are never logged. */
function providerFailureCode(caught: unknown): string {
  return caught instanceof ProviderHttpError &&
    /^[A-Z][A-Z0-9_]{0,63}$/u.test(caught.code)
    ? caught.code
    : 'FUTURES_CANDLE_PROVIDER_FAILED';
}

/**
 * A 418/429 from Binance (or the coordinator's cooldown after one) pauses every
 * on-demand read for at least 30 s or the provider's Retry-After. The
 * coordinator's own refusal — its shared minute budget spent, or a recovery
 * probe in flight (status 0) — pauses them only until it admits again.
 */
function rateLimitPauseMs(caught: unknown): number {
  const status =
    caught instanceof ProviderHttpError ? caught.rateLimit?.status : undefined;
  const retryAfterMs = rateLimitRetryAfterMs(caught);
  return status === 418 || status === 429
    ? Math.max(RATE_LIMIT_BACKOFF_MS, retryAfterMs)
    : Math.min(
        COORDINATOR_PAUSE_MAX_MS,
        Math.max(COORDINATOR_PAUSE_MIN_MS, retryAfterMs),
      );
}

function rateLimitRetryAfterMs(caught: unknown): number {
  return caught instanceof ProviderHttpError &&
    typeof caught.rateLimit?.retryAfterMs === 'number' &&
    Number.isFinite(caught.rateLimit.retryAfterMs)
    ? caught.rateLimit.retryAfterMs
    : 0;
}
