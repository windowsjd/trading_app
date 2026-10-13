import { Injectable, Optional } from '@nestjs/common';
import { TiingoAssetMapService } from './tiingo-asset-map.service';
import { TiingoCandleService } from './tiingo-candle.service';
import { TiingoConfigService } from './tiingo.config';
import {
  TiingoMarketDataStore,
  type TiingoSymbolDataStats,
} from './tiingo-market-data.store';
import { TiingoQuoteService } from './tiingo-quote.service';
import { TiingoRestClient } from './tiingo-rest.client';
import {
  classifyUsEquitySegment,
  type UsEquitySessionSegment,
} from './tiingo-session';
import { TiingoStreamService } from './tiingo-stream.service';

/** Reference data newer than this counts as flowing. */
const DATA_FLOWING_MS = 60_000;

export type TiingoReferenceDataState =
  | 'flowing'
  /** Connected, inside Tiingo's 04:00–20:00 ET hours, but no recent price. */
  | 'quiet'
  /** No updates are expected now (overnight / non-trading day). */
  | 'expected_quiet'
  | 'unavailable';

export type TiingoSymbolDiagnostics = TiingoSymbolDataStats & {
  assetId: string;
  market: string;
  referenceAgeMs: number | null;
  liquidityAgeMs: number | null;
  referenceDataState: TiingoReferenceDataState;
};

/**
 * Operator view of the Tiingo trial, published through `/readiness`. Codes,
 * counters and timestamps only: never a price, payload, URL or the token.
 * It is informational and does not change readiness status.
 */
@Injectable()
export class TiingoDiagnosticsService {
  constructor(
    private readonly configService: TiingoConfigService,
    private readonly assetMap: TiingoAssetMapService,
    private readonly store: TiingoMarketDataStore,
    private readonly rest: TiingoRestClient,
    @Optional() private readonly stream?: TiingoStreamService,
    @Optional() private readonly quotes?: TiingoQuoteService,
    @Optional() private readonly candles?: TiingoCandleService,
  ) {}

  getStatus(now: Date = new Date()) {
    const config = this.configService.getConfig();
    const segment = classifyUsEquitySegment(now);
    const base = {
      provider: 'tiingo' as const,
      requested: config.requested,
      enabled: config.enabled,
      configError: config.configError,
      trialMode: config.trialMode,
      // Trial data is never stored: no PostgreSQL rows, Redis keys or files.
      persistence: 'disabled' as const,
      allowedSymbols: [...config.allowedSymbols],
      streamEnabled: config.streamEnabled,
      liquidityStreamEnabled: config.liquidityStreamEnabled,
      marketSegment: segment,
      checkedAt: now.toISOString(),
    };
    if (!config.requested) return { ...base, state: 'disabled' as const };

    const mapping = this.assetMap.cachedMapping();
    const stream = this.stream?.getStatus() ?? null;
    const rest = this.rest.getStatus();
    const quotes = this.quotes?.getStatus() ?? null;
    const candles = this.candles?.getStatus() ?? null;
    const symbols: TiingoSymbolDiagnostics[] = (mapping?.targets ?? []).map(
      (target) => {
        const stats = this.store.symbolStats(target.symbol);
        const age = (value: string | null) =>
          value ? Math.max(0, now.getTime() - Date.parse(value)) : null;
        const referenceAgeMs = age(stats.reference.lastCapturedAt);
        return {
          ...stats,
          assetId: target.assetId,
          market: target.market,
          referenceAgeMs,
          liquidityAgeMs: age(stats.liquidity.lastCapturedAt),
          referenceDataState: dataState(referenceAgeMs, segment),
        };
      },
    );
    const failures: {
      stage: string;
      at: string | null;
      code: string | null;
    }[] = [
      {
        stage: 'rest',
        at: rest.lastFailureAt,
        code: rest.lastErrorCode,
      },
      {
        stage: 'ws_reference',
        at: stream?.reference.lastErrorAt ?? null,
        code: stream?.reference.lastErrorCode ?? null,
      },
      {
        stage: 'ws_liquidity',
        at: stream?.liquidity.lastErrorAt ?? null,
        code: stream?.liquidity.lastErrorCode ?? null,
      },
      {
        stage: 'display_price',
        at: quotes?.lastUnavailableAt ?? null,
        code: quotes?.lastUnavailableCode ?? null,
      },
    ];
    const lastFailure =
      failures
        .filter((failure) => failure.at && failure.code)
        .sort((a, b) => Date.parse(b.at!) - Date.parse(a.at!))[0] ?? null;

    return {
      ...base,
      state: config.enabled ? ('enabled' as const) : ('config_error' as const),
      mapping: {
        targets: (mapping?.targets ?? []).map((target) => ({
          symbol: target.symbol,
          assetId: target.assetId,
          market: target.market,
        })),
        unmapped: mapping?.unmapped ?? [],
        loadedAt: mapping?.loadedAt ?? null,
        lastLoadFailed: mapping?.lastLoadFailed ?? false,
      },
      rest,
      stream,
      symbols,
      quotes,
      candles,
      // An invalid configuration is the root cause whenever it is present.
      lastFailure: config.configError
        ? { stage: 'config', code: config.configError, at: null }
        : lastFailure
          ? {
              stage: lastFailure.stage,
              code: lastFailure.code,
              at: lastFailure.at,
            }
          : null,
    };
  }
}

function dataState(
  ageMs: number | null,
  segment: UsEquitySessionSegment,
): TiingoReferenceDataState {
  if (ageMs !== null && ageMs <= DATA_FLOWING_MS) return 'flowing';
  if (segment === 'overnight' || segment === 'non_trading_day')
    return 'expected_quiet';
  return ageMs === null ? 'unavailable' : 'quiet';
}
