import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import {
  resolveStockMarketSessionState,
  type MarketSessionWindow,
} from '../../orders/market-calendar.policy';
import { MarketPriceEventService } from '../market-price-event.service';
import {
  getProviderFreshnessThresholdsSeconds,
  selectMarketAwareAssetPriceSnapshotBySourcePriority,
  type SourceDecision,
} from '../source-eligibility.policy';
import {
  TiingoAssetMapService,
  type TiingoAssetIdentity,
  type TiingoAssetTarget,
} from './tiingo-asset-map.service';
import {
  TIINGO_REFERENCE_PRICE_SOURCE,
  TiingoConfigService,
} from './tiingo.config';
import { tiingoFailureCode } from './tiingo.errors';
import {
  TiingoMarketDataStore,
  type TiingoLiquidityObservation,
  type TiingoReferenceObservation,
} from './tiingo-market-data.store';
import {
  parseTiingoDailyBars,
  parseTiingoIntradayBars,
  parseTiingoSnapshotResponse,
} from './tiingo.parser';
import { TiingoRestClient } from './tiingo-rest.client';
import { TiingoStreamService } from './tiingo-stream.service';

export type TiingoDisplayUnavailableCode =
  | 'TIINGO_CALENDAR_UNAVAILABLE'
  | 'TIINGO_REFERENCE_PRICE_MISSING'
  | 'TIINGO_REFERENCE_PRICE_STALE'
  | 'TIINGO_REFERENCE_PRICE_OUTSIDE_SESSION'
  | 'TIINGO_SESSION_CLOSE_MISSING'
  | 'TIINGO_LAST_SESSION_UNAVAILABLE';

export type TiingoDisplayPrice =
  | {
      state: 'available';
      price: string;
      effectiveAt: Date;
      capturedAt: Date;
      sourceName: typeof TIINGO_REFERENCE_PRICE_SOURCE;
      decision: SourceDecision;
      origin: TiingoReferenceObservation['origin'];
    }
  | {
      state: 'unavailable';
      code: TiingoDisplayUnavailableCode;
      failureStage: 'tiingo_reference_price' | 'tiingo_session_close';
      evidence: Record<string, string | number | boolean | null>;
    };

/** App-facing estimated top-of-book. Statistical estimate, not an order book. */
export type TiingoEstimatedQuote = {
  assetId: string;
  bidPrice: string | null;
  bidSize: string | null;
  askPrice: string | null;
  askSize: string | null;
  spread: string | null;
  referencePrice: string | null;
  effectiveAt: Date;
  capturedAt: Date;
};

export type TiingoQuoteStatus = {
  displayAvailable: number;
  displayUnavailable: number;
  lastUnavailableCode: string | null;
  lastUnavailableAt: string | null;
  publishedPriceEvents: number;
  publishedQuoteEvents: number;
  lastSnapshotRefreshAt: string | null;
  lastSnapshotErrorCode: string | null;
  lastSessionClose: {
    localDate: string;
    basis: 'eod_official_close' | 'stream_last_regular' | 'intraday_last_bar';
    resolvedAt: string;
  } | null;
  lastSessionCloseErrorCode: string | null;
};

/** REST snapshot is a fallback for a missing/unhealthy stream, never a poller. */
const SNAPSHOT_MIN_INTERVAL_MS = 10_000;
const SNAPSHOT_REFRESH_AFTER_MS = 30_000;
const CLOSE_RETRY_INTERVAL_MS = 30_000;
const OFFICIAL_CLOSE_TTL_MS = 6 * 60 * 60_000;
const PROVISIONAL_CLOSE_TTL_MS = 5 * 60_000;
const FIVE_MINUTES_MS = 5 * 60_000;
/** Estimated quotes older than this are not delivered as current. */
export const TIINGO_ESTIMATED_QUOTE_MAX_AGE_MS = 60_000;

/**
 * Display-only Tiingo pricing for allow-listed US equities (trial mode).
 *
 * Open session: the newest consolidated reference price, selected with the
 * same market-aware freshness/session policy as stored snapshots. Closed:
 * the latest completed session's close (official EOD close, else the last
 * regular-session stream value, else the last regular-session 5m bar).
 * There is NO fallback to KIS or admin_manual prices for these assets: an
 * unavailable Tiingo price is reported as unavailable.
 *
 * Orders, valuation, ranking and settlement never call this service.
 */
@Injectable()
export class TiingoQuoteService implements OnModuleInit, OnModuleDestroy {
  private readonly unsubscribers: (() => void)[] = [];
  private readonly snapshotInFlight = new Map<string, Promise<void>>();
  private readonly lastSnapshotAttemptMs = new Map<string, number>();
  private readonly closeInFlight = new Map<
    string,
    Promise<TiingoReferenceObservation | null>
  >();
  private readonly lastCloseAttemptMs = new Map<string, number>();
  private readonly quoteListeners = new Set<
    (quote: TiingoEstimatedQuote) => void
  >();
  private readonly counters: TiingoQuoteStatus = {
    displayAvailable: 0,
    displayUnavailable: 0,
    lastUnavailableCode: null,
    lastUnavailableAt: null,
    publishedPriceEvents: 0,
    publishedQuoteEvents: 0,
    lastSnapshotRefreshAt: null,
    lastSnapshotErrorCode: null,
    lastSessionClose: null,
    lastSessionCloseErrorCode: null,
  };

  constructor(
    private readonly configService: TiingoConfigService,
    private readonly assetMap: TiingoAssetMapService,
    private readonly rest: TiingoRestClient,
    private readonly store: TiingoMarketDataStore,
    private readonly events: MarketPriceEventService,
    @Optional() private readonly stream?: TiingoStreamService,
  ) {}

  onModuleInit(): void {
    this.unsubscribers.push(
      this.store.onReference((observation) => this.publishPrice(observation)),
      this.store.onLiquidity((observation) => this.publishQuote(observation)),
    );
  }

  onModuleDestroy(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.quoteListeners.clear();
  }

  isEnabled(): boolean {
    return this.configService.getConfig().enabled;
  }

  targetForAsset(
    asset: TiingoAssetIdentity,
  ): Promise<TiingoAssetTarget | null> {
    return this.assetMap.targetForAsset(asset);
  }

  async targetForAssetId(assetId: string): Promise<TiingoAssetTarget | null> {
    if (!this.isEnabled()) return null;
    const mapping = await this.assetMap.getMapping();
    return mapping.targets.find((target) => target.assetId === assetId) ?? null;
  }

  /** Null when the asset is not Tiingo-managed (the stored path applies). */
  async resolveDisplayPrice(
    asset: TiingoAssetIdentity,
    now: Date,
  ): Promise<TiingoDisplayPrice | null> {
    const target = await this.assetMap.targetForAsset(asset);
    if (!target) return null;
    const result = await this.resolveForTarget(asset, target, now);
    if (result.state === 'available') {
      this.counters.displayAvailable += 1;
    } else {
      this.counters.displayUnavailable += 1;
      this.counters.lastUnavailableCode = result.code;
      this.counters.lastUnavailableAt = now.toISOString();
    }
    return result;
  }

  /**
   * The latest estimated quote inside the current regular session, or null.
   * Outside the session the app shows no estimate (regular-session policy).
   */
  async getEstimatedQuote(
    asset: TiingoAssetIdentity,
    now: Date,
  ): Promise<TiingoEstimatedQuote | null> {
    const target = await this.assetMap.targetForAsset(asset);
    if (!target) return null;
    const session = resolveStockMarketSessionState(asset, now);
    if (session?.state !== 'open') return null;
    let observation = this.store.latestLiquidity(target.symbol);
    if (
      !this.isQuoteCurrent(observation, session.currentSession, now) &&
      !this.streamDelivering('liquidity', now)
    ) {
      await this.refreshSnapshot(target.symbol);
      observation = this.store.latestLiquidity(target.symbol);
    }
    return this.isQuoteCurrent(observation, session.currentSession, now)
      ? toEstimatedQuote(target.assetId, observation)
      : null;
  }

  onEstimatedQuote(listener: (quote: TiingoEstimatedQuote) => void) {
    this.quoteListeners.add(listener);
    return () => {
      this.quoteListeners.delete(listener);
    };
  }

  getStatus(): TiingoQuoteStatus {
    return {
      ...this.counters,
      lastSessionClose: this.counters.lastSessionClose
        ? { ...this.counters.lastSessionClose }
        : null,
    };
  }

  private async resolveForTarget(
    asset: TiingoAssetIdentity,
    target: TiingoAssetTarget,
    now: Date,
  ): Promise<TiingoDisplayPrice> {
    const session = resolveStockMarketSessionState(asset, now);
    if (!session || session.state === 'calendar_unavailable')
      return unavailable(
        'TIINGO_CALENDAR_UNAVAILABLE',
        'tiingo_reference_price',
        {
          marketState: session?.state ?? null,
        },
      );
    const freshnessSeconds =
      getProviderFreshnessThresholdsSeconds().assetPriceDisplay;

    if (session.state === 'open') {
      let observation = this.store.latestReference(target.symbol);
      if (
        this.needsSnapshotRefresh(
          observation,
          session.currentSession,
          now,
          freshnessSeconds,
        )
      ) {
        await this.refreshSnapshot(target.symbol);
        observation = this.store.latestReference(target.symbol);
      }
      const selection = select(asset, observation, now, freshnessSeconds);
      if (selection.state === 'selected' && observation)
        return available(observation, selection.decision);
      const reason = selection.decision.rejectedProviderReason;
      return unavailable(
        reason === 'captured_at_stale'
          ? 'TIINGO_REFERENCE_PRICE_STALE'
          : reason === 'effective_at_outside_current_session'
            ? 'TIINGO_REFERENCE_PRICE_OUTSIDE_SESSION'
            : 'TIINGO_REFERENCE_PRICE_MISSING',
        'tiingo_reference_price',
        {
          marketState: 'open',
          rejectedReason: reason,
          lastReferenceAt: observation?.effectiveAt.toISOString() ?? null,
          lastReferenceCapturedAt:
            observation?.capturedAt.toISOString() ?? null,
          lastSnapshotErrorCode: this.counters.lastSnapshotErrorCode,
          referenceStreamState:
            this.stream?.getStatus().reference.state ?? null,
          fallback: 'none',
        },
      );
    }

    const completed = session.latestCompletedSession;
    if (!completed)
      return unavailable(
        'TIINGO_LAST_SESSION_UNAVAILABLE',
        'tiingo_session_close',
        { marketState: 'closed' },
      );
    const close = await this.resolveSessionClose(target, completed, now);
    const selection = select(asset, close, now, freshnessSeconds);
    if (selection.state === 'selected' && close)
      return available(close, selection.decision);
    return unavailable('TIINGO_SESSION_CLOSE_MISSING', 'tiingo_session_close', {
      marketState: 'closed',
      sessionDate: completed.localDate,
      rejectedReason: selection.decision.rejectedProviderReason,
      lastSessionCloseErrorCode: this.counters.lastSessionCloseErrorCode,
      fallback: 'none',
    });
  }

  private needsSnapshotRefresh(
    observation: TiingoReferenceObservation | null,
    session: MarketSessionWindow,
    now: Date,
    freshnessSeconds: number,
  ): boolean {
    if (!observation) return true;
    if (observation.effectiveAt.getTime() < session.openTime.getTime())
      return true;
    const ageMs = now.getTime() - observation.capturedAt.getTime();
    if (ageMs > freshnessSeconds * 1000) return true;
    return (
      ageMs > SNAPSHOT_REFRESH_AFTER_MS &&
      !this.streamDelivering('reference', now)
    );
  }

  /** Subscribed and recently delivering data (not just heartbeats). */
  private streamDelivering(
    channel: 'reference' | 'liquidity',
    now: Date,
  ): boolean {
    const status = this.stream?.getStatus()[channel];
    if (status?.state !== 'subscribed' || !status.lastDataAt) return false;
    return (
      now.getTime() - Date.parse(status.lastDataAt) <= SNAPSHOT_REFRESH_AFTER_MS
    );
  }

  /** One shared, rate-limited snapshot read updates price and liquidity. */
  private refreshSnapshot(symbol: string): Promise<void> {
    const pending = this.snapshotInFlight.get(symbol);
    if (pending) return pending;
    const nowMs = Date.now();
    if (
      nowMs - (this.lastSnapshotAttemptMs.get(symbol) ?? 0) <
      SNAPSHOT_MIN_INTERVAL_MS
    )
      return Promise.resolve();
    this.lastSnapshotAttemptMs.set(symbol, nowMs);
    const work = (async () => {
      try {
        const result = await this.rest.getSnapshot(symbol);
        const snapshot = parseTiingoSnapshotResponse(result.json, symbol);
        if (snapshot.referencePrice)
          this.store.acceptReference({
            symbol,
            price: snapshot.referencePrice,
            timestamp: snapshot.timestamp,
            capturedAt: result.receivedAt,
            origin: 'rest_snapshot',
          });
        this.store.acceptLiquidity({
          symbol,
          fields: snapshot.liquidity,
          timestamp: snapshot.timestamp,
          capturedAt: result.receivedAt,
          origin: 'rest_snapshot',
        });
        this.counters.lastSnapshotRefreshAt = result.receivedAt.toISOString();
        this.counters.lastSnapshotErrorCode = null;
      } catch (error) {
        this.counters.lastSnapshotErrorCode = tiingoFailureCode(error);
      }
    })().finally(() => this.snapshotInFlight.delete(symbol));
    this.snapshotInFlight.set(symbol, work);
    return work;
  }

  private async resolveSessionClose(
    target: TiingoAssetTarget,
    session: MarketSessionWindow,
    now: Date,
  ): Promise<TiingoReferenceObservation | null> {
    const cached = this.store.sessionClose(
      target.symbol,
      session.localDate,
      now.getTime(),
    );
    if (cached) return cached;
    const key = `${target.symbol}|${session.localDate}`;
    const pending = this.closeInFlight.get(key);
    if (pending) return pending;
    const nowMs = Date.now();
    if (
      nowMs - (this.lastCloseAttemptMs.get(key) ?? 0) <
      CLOSE_RETRY_INTERVAL_MS
    )
      return null;
    this.lastCloseAttemptMs.set(key, nowMs);
    const work = this.loadSessionClose(target, session).finally(() =>
      this.closeInFlight.delete(key),
    );
    this.closeInFlight.set(key, work);
    return work;
  }

  private async loadSessionClose(
    target: TiingoAssetTarget,
    session: MarketSessionWindow,
  ): Promise<TiingoReferenceObservation | null> {
    const remember = (
      observation: TiingoReferenceObservation,
      basis: NonNullable<TiingoQuoteStatus['lastSessionClose']>['basis'],
      ttlMs: number,
    ) => {
      this.store.rememberSessionClose(
        target.symbol,
        session.localDate,
        observation,
        ttlMs,
        Date.now(),
      );
      this.counters.lastSessionClose = {
        localDate: session.localDate,
        basis,
        resolvedAt: new Date().toISOString(),
      };
      this.counters.lastSessionCloseErrorCode = null;
      return observation;
    };
    try {
      // 1) Official close (EOD publishes ~17:30 ET). Display uses the raw close.
      const daily = await this.rest.getDailyPrices(target.symbol, {
        startDate: session.localDate,
        endDate: session.localDate,
      });
      const bar = parseTiingoDailyBars(daily.json).bars.find(
        (row) => row.date === session.localDate,
      );
      if (bar)
        return remember(
          closeObservation(
            target.symbol,
            bar.close,
            session.closeTime,
            daily.receivedAt,
          ),
          'eod_official_close',
          OFFICIAL_CLOSE_TTL_MS,
        );
      // 2) The last regular-session value this process received.
      const streamed = this.store.latestRegularReference(target.symbol);
      if (
        streamed &&
        streamed.effectiveAt.getTime() >= session.openTime.getTime() &&
        streamed.effectiveAt.getTime() <= session.closeTime.getTime()
      )
        return remember(
          streamed,
          'stream_last_regular',
          PROVISIONAL_CLOSE_TTL_MS,
        );
      // 3) The last regular-session 5-minute bar of that date.
      const intraday = await this.rest.getIntradayPrices(target.symbol, {
        startDate: session.localDate,
        endDate: session.localDate,
      });
      const inSession = parseTiingoIntradayBars(intraday.json).bars.filter(
        (row) =>
          row.openTime.getTime() >= session.openTime.getTime() &&
          row.openTime.getTime() < session.closeTime.getTime(),
      );
      const last = inSession.at(-1);
      if (!last) {
        this.counters.lastSessionCloseErrorCode = 'TIINGO_EMPTY_RESPONSE';
        return null;
      }
      return remember(
        closeObservation(
          target.symbol,
          last.close,
          new Date(
            Math.min(
              last.openTime.getTime() + FIVE_MINUTES_MS,
              session.closeTime.getTime(),
            ),
          ),
          intraday.receivedAt,
        ),
        'intraday_last_bar',
        PROVISIONAL_CLOSE_TTL_MS,
      );
    } catch (error) {
      this.counters.lastSessionCloseErrorCode = tiingoFailureCode(error);
      return null;
    }
  }

  private isQuoteCurrent(
    observation: TiingoLiquidityObservation | null,
    session: MarketSessionWindow,
    now: Date,
  ): observation is TiingoLiquidityObservation {
    return Boolean(
      observation &&
      observation.effectiveAt.getTime() >= session.openTime.getTime() &&
      observation.effectiveAt.getTime() <= now.getTime() &&
      now.getTime() - observation.capturedAt.getTime() <=
        TIINGO_ESTIMATED_QUOTE_MAX_AGE_MS,
    );
  }

  /** In-process only: trial prices never enter the Redis fan-out channel. */
  private publishPrice(observation: TiingoReferenceObservation): void {
    if (observation.origin === 'rest_close') return;
    const target = this.assetMap.cachedTargetForSymbol(observation.symbol);
    if (!target) return;
    this.events.publish({
      type: 'market_price',
      assetId: target.assetId,
      price: {
        price: observation.price,
        currencyCode: 'USD',
        sourceName: TIINGO_REFERENCE_PRICE_SOURCE,
        effectiveAt: observation.effectiveAt.toISOString(),
        capturedAt: observation.capturedAt.toISOString(),
      },
      delayed: false,
      // No stored snapshot exists for ephemeral trial data.
      snapshotState: null,
    });
    this.counters.publishedPriceEvents += 1;
  }

  private publishQuote(observation: TiingoLiquidityObservation): void {
    const target = this.assetMap.cachedTargetForSymbol(observation.symbol);
    if (!target || this.quoteListeners.size === 0) return;
    const quote = toEstimatedQuote(target.assetId, observation);
    for (const listener of this.quoteListeners) {
      try {
        listener(quote);
      } catch {
        // A failing consumer cannot stop delivery to the others.
      }
    }
    this.counters.publishedQuoteEvents += 1;
  }
}

function select(
  asset: TiingoAssetIdentity,
  observation: TiingoReferenceObservation | null,
  now: Date,
  freshnessThresholdSeconds: number,
) {
  return selectMarketAwareAssetPriceSnapshotBySourcePriority({
    asset: { assetType: asset.assetType, market: asset.market },
    workflow: 'assets_with_price',
    candidates: observation
      ? [
          {
            id: '',
            sourceType: 'provider_api',
            sourceName: TIINGO_REFERENCE_PRICE_SOURCE,
            effectiveAt: observation.effectiveAt,
            capturedAt: observation.capturedAt,
          },
        ]
      : [],
    expectedSourceNames: [TIINGO_REFERENCE_PRICE_SOURCE],
    now,
    freshnessThresholdSeconds,
    isPositiveValue: () => true,
  });
}

function available(
  observation: TiingoReferenceObservation,
  decision: SourceDecision,
): TiingoDisplayPrice {
  return {
    state: 'available',
    price: observation.price,
    effectiveAt: observation.effectiveAt,
    capturedAt: observation.capturedAt,
    sourceName: TIINGO_REFERENCE_PRICE_SOURCE,
    decision: { ...decision, selectedSnapshotId: null },
    origin: observation.origin,
  };
}

function unavailable(
  code: TiingoDisplayUnavailableCode,
  failureStage: 'tiingo_reference_price' | 'tiingo_session_close',
  evidence: Record<string, string | number | boolean | null>,
): TiingoDisplayPrice {
  return {
    state: 'unavailable',
    code,
    failureStage,
    evidence: { provider: 'tiingo', ...evidence },
  };
}

function closeObservation(
  symbol: string,
  price: string,
  effectiveAt: Date,
  capturedAt: Date,
): TiingoReferenceObservation {
  return {
    symbol,
    price,
    effectiveAt,
    effectiveAtNanos: 0,
    capturedAt,
    origin: 'rest_close',
    segment: 'regular',
  };
}

function toEstimatedQuote(
  assetId: string,
  observation: TiingoLiquidityObservation,
): TiingoEstimatedQuote {
  return {
    assetId,
    bidPrice: observation.bidPrice,
    bidSize: observation.bidSize,
    askPrice: observation.askPrice,
    askSize: observation.askSize,
    spread: observation.spread,
    referencePrice: observation.referencePrice,
    effectiveAt: observation.effectiveAt,
    capturedAt: observation.capturedAt,
  };
}
