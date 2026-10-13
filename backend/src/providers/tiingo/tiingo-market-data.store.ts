import { Injectable, OnModuleDestroy } from '@nestjs/common';
import {
  compareTiingoTimestamps,
  type TiingoLiquidityFields,
  type TiingoTimestamp,
} from './tiingo.parser';
import {
  US_EQUITY_SESSION_SEGMENTS,
  classifyUsEquitySegment,
  type UsEquitySessionSegment,
} from './tiingo-session';

export type TiingoObservationOrigin = 'ws' | 'rest_snapshot' | 'rest_close';

export type TiingoReferenceObservation = {
  symbol: string;
  price: string;
  /** Provider time of the price (Tiingo timestamp). */
  effectiveAt: Date;
  effectiveAtNanos: number;
  /** Server receive time. */
  capturedAt: Date;
  origin: TiingoObservationOrigin;
  segment: UsEquitySessionSegment;
};

export type TiingoLiquidityObservation = TiingoLiquidityFields & {
  symbol: string;
  effectiveAt: Date;
  effectiveAtNanos: number;
  capturedAt: Date;
  origin: Exclude<TiingoObservationOrigin, 'rest_close'>;
  segment: UsEquitySessionSegment;
};

export type TiingoAcceptResult = 'accepted' | 'duplicate' | 'out_of_order';

type SegmentCounts = Record<UsEquitySessionSegment, number>;

/** Counts and timestamps only — safe for the public readiness surface. */
export type TiingoSymbolDataStats = {
  symbol: string;
  reference: {
    accepted: number;
    duplicates: number;
    outOfOrder: number;
    bySegment: SegmentCounts;
    lastEffectiveAt: string | null;
    lastCapturedAt: string | null;
    lastOrigin: TiingoObservationOrigin | null;
    lastSegment: UsEquitySessionSegment | null;
    lastRegularEffectiveAt: string | null;
  };
  liquidity: {
    accepted: number;
    duplicates: number;
    outOfOrder: number;
    bySegment: SegmentCounts;
    lastEffectiveAt: string | null;
    lastCapturedAt: string | null;
    lastSegment: UsEquitySessionSegment | null;
  };
};

type MutableStats = {
  reference: { accepted: number; duplicates: number; outOfOrder: number };
  liquidity: { accepted: number; duplicates: number; outOfOrder: number };
  referenceBySegment: SegmentCounts;
  liquidityBySegment: SegmentCounts;
};

const MAX_SESSION_CLOSES = 64;

/**
 * Process-local, non-persistent Tiingo observations (trial storage policy).
 * Holds only the latest value per symbol (bounded by the allowed-symbol
 * list); nothing is written to PostgreSQL, Redis, files or logs, and
 * everything is dropped on shutdown.
 *
 * Ordering is by Tiingo's own nanosecond timestamp: an equal timestamp is a
 * duplicate and an older one is out of order — neither replaces the latest
 * value, so a late REST snapshot can never roll back a newer stream tick.
 */
@Injectable()
export class TiingoMarketDataStore implements OnModuleDestroy {
  private readonly references = new Map<string, TiingoReferenceObservation>();
  private readonly regularReferences = new Map<
    string,
    TiingoReferenceObservation
  >();
  private readonly liquidity = new Map<string, TiingoLiquidityObservation>();
  private readonly closes = new Map<
    string,
    { observation: TiingoReferenceObservation; expiresAt: number }
  >();
  private readonly stats = new Map<string, MutableStats>();
  private readonly referenceListeners = new Set<
    (observation: TiingoReferenceObservation) => void
  >();
  private readonly liquidityListeners = new Set<
    (observation: TiingoLiquidityObservation) => void
  >();

  onModuleDestroy(): void {
    this.clear();
    this.referenceListeners.clear();
    this.liquidityListeners.clear();
  }

  acceptReference(input: {
    symbol: string;
    price: string;
    timestamp: TiingoTimestamp;
    capturedAt: Date;
    origin: Exclude<TiingoObservationOrigin, 'rest_close'>;
  }): TiingoAcceptResult {
    const symbol = input.symbol.toUpperCase();
    const stats = this.statsFor(symbol);
    const previous = this.references.get(symbol);
    if (previous) {
      const order = compareTiingoTimestamps(input.timestamp, {
        epochMs: previous.effectiveAt.getTime(),
        nanos: previous.effectiveAtNanos,
      });
      if (order === 0) {
        stats.reference.duplicates += 1;
        return 'duplicate';
      }
      if (order < 0) {
        stats.reference.outOfOrder += 1;
        return 'out_of_order';
      }
    }
    const effectiveAt = new Date(input.timestamp.epochMs);
    const observation: TiingoReferenceObservation = {
      symbol,
      price: input.price,
      effectiveAt,
      effectiveAtNanos: input.timestamp.nanos,
      capturedAt: input.capturedAt,
      origin: input.origin,
      segment: classifyUsEquitySegment(effectiveAt),
    };
    this.references.set(symbol, observation);
    if (observation.segment === 'regular')
      this.regularReferences.set(symbol, observation);
    stats.reference.accepted += 1;
    stats.referenceBySegment[observation.segment] += 1;
    for (const listener of this.referenceListeners)
      notify(listener, observation);
    return 'accepted';
  }

  acceptLiquidity(input: {
    symbol: string;
    fields: TiingoLiquidityFields;
    timestamp: TiingoTimestamp;
    capturedAt: Date;
    origin: Exclude<TiingoObservationOrigin, 'rest_close'>;
  }): TiingoAcceptResult {
    const symbol = input.symbol.toUpperCase();
    const stats = this.statsFor(symbol);
    const previous = this.liquidity.get(symbol);
    if (previous) {
      const order = compareTiingoTimestamps(input.timestamp, {
        epochMs: previous.effectiveAt.getTime(),
        nanos: previous.effectiveAtNanos,
      });
      if (order === 0) {
        stats.liquidity.duplicates += 1;
        return 'duplicate';
      }
      if (order < 0) {
        stats.liquidity.outOfOrder += 1;
        return 'out_of_order';
      }
    }
    const effectiveAt = new Date(input.timestamp.epochMs);
    const observation: TiingoLiquidityObservation = {
      ...input.fields,
      symbol,
      effectiveAt,
      effectiveAtNanos: input.timestamp.nanos,
      capturedAt: input.capturedAt,
      origin: input.origin,
      segment: classifyUsEquitySegment(effectiveAt),
    };
    this.liquidity.set(symbol, observation);
    stats.liquidity.accepted += 1;
    stats.liquidityBySegment[observation.segment] += 1;
    for (const listener of this.liquidityListeners)
      notify(listener, observation);
    return 'accepted';
  }

  latestReference(symbol: string): TiingoReferenceObservation | null {
    return this.references.get(symbol.toUpperCase()) ?? null;
  }

  /** Latest observation whose provider time falls inside a regular session. */
  latestRegularReference(symbol: string): TiingoReferenceObservation | null {
    return this.regularReferences.get(symbol.toUpperCase()) ?? null;
  }

  latestLiquidity(symbol: string): TiingoLiquidityObservation | null {
    return this.liquidity.get(symbol.toUpperCase()) ?? null;
  }

  /** Completed-session close used while the market is closed (memory only). */
  rememberSessionClose(
    symbol: string,
    localDate: string,
    observation: TiingoReferenceObservation,
    ttlMs: number,
    nowMs: number,
  ): void {
    for (const [key, entry] of this.closes) {
      if (entry.expiresAt <= nowMs) this.closes.delete(key);
    }
    while (this.closes.size >= MAX_SESSION_CLOSES) {
      const oldest = this.closes.keys().next();
      if (oldest.done) break;
      this.closes.delete(oldest.value);
    }
    this.closes.set(`${symbol.toUpperCase()}|${localDate}`, {
      observation,
      expiresAt: nowMs + ttlMs,
    });
  }

  sessionClose(
    symbol: string,
    localDate: string,
    nowMs: number,
  ): TiingoReferenceObservation | null {
    const key = `${symbol.toUpperCase()}|${localDate}`;
    const entry = this.closes.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= nowMs) {
      this.closes.delete(key);
      return null;
    }
    return entry.observation;
  }

  onReference(
    listener: (observation: TiingoReferenceObservation) => void,
  ): () => void {
    this.referenceListeners.add(listener);
    return () => this.referenceListeners.delete(listener);
  }

  onLiquidity(
    listener: (observation: TiingoLiquidityObservation) => void,
  ): () => void {
    this.liquidityListeners.add(listener);
    return () => this.liquidityListeners.delete(listener);
  }

  symbolStats(symbol: string): TiingoSymbolDataStats {
    const key = symbol.toUpperCase();
    const stats = this.statsFor(key);
    const reference = this.references.get(key) ?? null;
    const regular = this.regularReferences.get(key) ?? null;
    const liquidity = this.liquidity.get(key) ?? null;
    return {
      symbol: key,
      reference: {
        ...stats.reference,
        bySegment: { ...stats.referenceBySegment },
        lastEffectiveAt: reference?.effectiveAt.toISOString() ?? null,
        lastCapturedAt: reference?.capturedAt.toISOString() ?? null,
        lastOrigin: reference?.origin ?? null,
        lastSegment: reference?.segment ?? null,
        lastRegularEffectiveAt: regular?.effectiveAt.toISOString() ?? null,
      },
      liquidity: {
        ...stats.liquidity,
        bySegment: { ...stats.liquidityBySegment },
        lastEffectiveAt: liquidity?.effectiveAt.toISOString() ?? null,
        lastCapturedAt: liquidity?.capturedAt.toISOString() ?? null,
        lastSegment: liquidity?.segment ?? null,
      },
    };
  }

  /** Drops every observation (shutdown, disable, or test reset). */
  clear(): void {
    this.references.clear();
    this.regularReferences.clear();
    this.liquidity.clear();
    this.closes.clear();
    this.stats.clear();
  }

  private statsFor(symbol: string): MutableStats {
    let stats = this.stats.get(symbol);
    if (!stats) {
      stats = {
        reference: { accepted: 0, duplicates: 0, outOfOrder: 0 },
        liquidity: { accepted: 0, duplicates: 0, outOfOrder: 0 },
        referenceBySegment: emptySegments(),
        liquidityBySegment: emptySegments(),
      };
      this.stats.set(symbol, stats);
    }
    return stats;
  }
}

/** A failing consumer never blocks the store or other consumers. */
function notify<T>(listener: (value: T) => void, value: T): void {
  try {
    listener(value);
  } catch {
    // Consumers own their own error handling and diagnostics.
  }
}

function emptySegments(): SegmentCounts {
  return Object.fromEntries(
    US_EQUITY_SESSION_SEGMENTS.map((segment) => [segment, 0]),
  ) as SegmentCounts;
}
