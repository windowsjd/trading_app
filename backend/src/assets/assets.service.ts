import {
  SPOT_ASSET_WHERE,
  isFuturesOnlyAsset,
} from '../providers/binance/binance-product-catalog';
import { fxExecuteSnapshotFreshnessThresholdMs } from '../fx/fx-execute-snapshot-policy';
import {
  buildSelectionFailureEvidence,
  describeManualFallback,
} from '../providers/source-selection-diagnostics';
import {
  closedMarketPriceScope,
  findMarketAwareAssetPriceCandidates,
} from '../providers/asset-price-snapshot-query';
import {
  HttpException,
  HttpStatus,
  Injectable,
  Optional,
} from '@nestjs/common';
import {
  AssetPriceSourceType,
  AssetType,
  CurrencyCode,
  FxRateSourceType,
  Prisma,
} from '../generated/prisma/client';
import { isFxSnapshotStaleForPortfolioValuation } from '../portfolio/portfolio-valuation.policy';
import { PrismaService } from '../prisma/prisma.service';
import {
  adminManualAssetPriceScope,
  buildAdminManualFallbackDecision,
  isPositiveDecimal,
  resolveAssetProviderEligibility,
  resolveFxProviderEligibility,
  selectFreshProviderSnapshotBySourcePriority,
  selectMarketAwareAssetPriceSnapshotBySourcePriority,
  type SourceDecision,
} from '../providers/source-eligibility.policy';
import {
  presentSourceDecision,
  type PublicSourceMetadata,
} from '../providers/source-metadata.presenter';
import { BinanceSymbolMetadataService } from '../providers/binance/binance-symbol-metadata.service';
import {
  MarketDisplayPriceService,
  type EphemeralDisplayPrice,
} from '../providers/market-display-price.service';
import { buildPagination, type Pagination } from '../common/pagination';
import { resolveStockMarketSessionState } from '../orders/market-calendar.policy';
import { findUsdKrwProviderSnapshotCandidates } from '../providers/fx-rate-snapshot-query';
import { DailyChangeRateService } from './daily-change-rate.service';
import { TIINGO_EOD_CANDLE_SOURCE } from '../providers/tiingo/tiingo.config';
import { KOSCOM_HISTORY_SOURCE } from '../providers/koscom/koscom.config';
import { createHash, randomUUID } from 'node:crypto';
import { RedisService } from '../redis/redis.service';
import {
  compareAssetListMetric,
  readAssetListTurnover,
  latestSessionTurnover,
  type AssetListTurnover,
} from './asset-list-turnover';
import {
  type AdminDiagnostic,
  type DiagnosticContextUpdate,
  buildAdminPartialFailureDiagnostic,
  isAdminDiagnosticRequest,
  recordAdminDiagnosticEvent,
  withoutAdminDiagnosticContext,
} from '../common/admin-diagnostics';
import {
  ASSET_SORT_CACHE_PREFIX,
  ASSET_SORT_MAX_SNAPSHOTS,
  ASSET_SORT_REUSE_SECONDS,
  ASSET_SORT_TTL_SECONDS,
  STORE_ASSET_SORT_SNAPSHOT,
} from './asset-sort-snapshot-cache';

export type AssetsQuery = {
  assetType?: string;
  currencyCode?: string;
  market?: string;
  search?: string;
  includeInactive?: string;
  withPrice?: string;
  limit?: string;
  offset?: string;
  sortBy?: string;
  sortOrder?: string;
  sortSnapshot?: string;
  sortRefresh?: string;
};

type ParsedAssetsQuery = {
  assetType?: AssetType;
  currencyCode?: CurrencyCode;
  market?: string;
  search?: string;
  includeInactive: boolean;
  withPrice: boolean;
  limit: number;
  offset: number;
  sortBy?: 'turnover' | 'changeRate';
  sortOrder: 'asc' | 'desc';
  sortSnapshot?: string;
  sortRefresh: boolean;
};

type AssetRecord = {
  id: string;
  symbol: string;
  name: string;
  market: string;
  assetType: AssetType;
  currencyCode: CurrencyCode;
  priceCurrency: CurrencyCode;
  settlementCurrency: CurrencyCode;
  isActive: boolean;
};

type AssetPriceSnapshotRecord = {
  /** Null for an ephemeral (memory-only) display price: no stored row exists. */
  id: string | null;
  price: Prisma.Decimal;
  priceKrw: Prisma.Decimal | null;
  currencyCode: CurrencyCode;
  sourceType: AssetPriceSourceType;
  sourceName: string | null;
  effectiveAt: Date;
  capturedAt: Date;
  sourceDecision: SourceDecision;
};

type AssetPriceError = {
  assetId: string;
  code: 'ASSET_PRICE_UNAVAILABLE' | 'FX_RATE_UNAVAILABLE' | 'FX_RATE_STALE';
  message: string;
  diagnostic?: AdminDiagnostic;
};

type MarketStatus = 'open' | 'closed' | 'always_open' | 'unknown';

type TradeBlockedReason =
  | 'ASSET_INACTIVE'
  | 'MARKET_CLOSED'
  | 'PRICE_UNAVAILABLE'
  | 'PRICE_STALE'
  // Legacy response compatibility only; new asset UX never emits these.
  | 'SEASON_NOT_ACTIVE'
  | 'SEASON_NOT_JOINED'
  | 'UNKNOWN';

type AssetTradingUx = {
  id: string;
  changeRate: string | null;
  marketStatus: MarketStatus;
  tradable: boolean;
  tradeBlockedReason: TradeBlockedReason | null;
};

type UsdKrwSelection =
  | {
      state: 'available';
      rate: Prisma.Decimal;
      sourceDecision: SourceDecision;
    }
  | {
      state: 'unavailable';
      code: 'FX_RATE_UNAVAILABLE' | 'FX_RATE_STALE';
      message: string;
      sourceDecision?: SourceDecision;
      failureEvidence?: Record<string, unknown>;
    };

export type AssetPricePayload =
  | {
      state: 'available';
      currentPrice: string;
      changeRate: string | null;
      priceCurrency: CurrencyCode;
      priceKrwState: 'available';
      priceKrw: string;
      assetPriceSnapshotId: string | null;
      priceEffectiveAt: string;
      priceCapturedAt: string;
      priceSource: PublicSourceMetadata | null;
      fxRateSource?: PublicSourceMetadata | null;
    }
  | {
      state: 'available';
      currentPrice: string;
      changeRate: string | null;
      priceCurrency: CurrencyCode;
      priceKrwState: 'unavailable';
      priceKrwReason: 'FX_RATE_UNAVAILABLE' | 'FX_RATE_STALE';
      priceKrwMessage: string;
      assetPriceSnapshotId: string | null;
      priceEffectiveAt: string;
      priceCapturedAt: string;
      priceSource: PublicSourceMetadata | null;
      fxRateSource?: PublicSourceMetadata | null;
    }
  | {
      state: 'unavailable';
      reason: 'ASSET_PRICE_UNAVAILABLE';
      message: string;
    };

export type AssetTickerPriceSelection = {
  asset: {
    tradable: boolean;
    tradeBlockedReason: string | null;
    id: string;
    symbol: string;
    name: string;
    assetType: AssetType;
    market: string;
    priceCurrency: CurrencyCode;
    displayPriceDecimals: number | null;
  };
  price: AssetPricePayload;
};

/**
 * KRW conversion for a realtime local price that is NEWER than any stored
 * snapshot. Realtime fanout must never pair a fresh local price with the KRW
 * value of an older snapshot, so the gateway recomputes it here from the
 * currently eligible USD/KRW snapshot (same source-eligibility policy as REST)
 * or reports it unavailable.
 */
export type RealtimePriceKrwConversion =
  | {
      state: 'available';
      priceKrw: string;
      fxRateSource: PublicSourceMetadata | null;
    }
  | {
      state: 'unavailable';
      reason: 'FX_RATE_UNAVAILABLE' | 'FX_RATE_STALE';
      message: string;
      fxRateSource: PublicSourceMetadata | null;
    };

type AssetListItem = ReturnType<AssetsService['formatAssetMetadata']> & {
  price?: AssetPricePayload;
} & Partial<AssetListTurnover>;

type CachedFailureObservation = { sortSnapshot: string; observedAt: Date };

type SortedAssetSnapshot = {
  token: string;
  key: string;
  valuationAt: number;
  createdAt: number;
  expiresAt: number;
  assets: AssetListItem[];
  priceErrors: Omit<AssetPriceError, 'diagnostic'>[];
};

type AssetsListResponse = {
  success: true;
  data: {
    state: 'available';
    filters: ReturnType<AssetsService['formatFilters']>;
    pagination: Pagination;
    assets: AssetListItem[];
    priceErrors: AssetPriceError[];
    sortSnapshot?: string;
  };
};

type AssetDetailResponse = {
  success: true;
  data: {
    state: 'available';
    asset: AssetListItem & {
      price: AssetPricePayload;
      tradingNote: ReturnType<AssetsService['buildTradingNote']>;
    };
    priceErrors: AssetPriceError[];
  };
};

type AssetPriceResponse = {
  success: true;
  data:
    | {
        state: 'available';
        assetId: string;
        symbol: string;
        name: string;
        assetType: AssetType;
        market: string;
        currentPrice: string;
        priceCurrency: CurrencyCode;
        displayPriceDecimals: number | null;
        priceKrwState: 'available' | 'unavailable';
        priceKrw: string | null;
        priceKrwReason?: 'FX_RATE_UNAVAILABLE' | 'FX_RATE_STALE';
        priceKrwMessage?: string;
        changeRate: string | null;
        assetPriceSnapshotId: string | null;
        priceEffectiveAt: string;
        priceCapturedAt: string;
        freshnessAgeSeconds: number;
        priceSource: PublicSourceMetadata | null;
        fxRateSource?: PublicSourceMetadata | null;
      }
    | {
        state: 'unavailable';
        assetId: string;
        symbol: string;
        name: string;
        assetType: AssetType;
        market: string;
        priceCurrency: CurrencyCode;
        displayPriceDecimals: number | null;
        currentPrice: null;
        priceKrwState: 'unavailable';
        priceKrw: null;
        changeRate: null;
        assetPriceSnapshotId: null;
        priceEffectiveAt: null;
        priceCapturedAt: null;
        freshnessAgeSeconds: null;
        priceSource: null;
        reason: 'ASSET_PRICE_UNAVAILABLE';
        message: string;
        diagnostic?: AdminDiagnostic;
      };
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
/**
 * `priceSource.fallbackReason` of a closed US market's display price: the
 * latest completed session's confirmed end-of-day close (no stored snapshot,
 * never executable). The app labels it "종가" (no session date since
 * 2026-10-18; priceEffectiveAt still carries the session close).
 */
export const LAST_SESSION_CLOSE_FALLBACK_REASON = 'market_closed_last_close';
/**
 * The same display-only shape for a closed KRX market: the latest completed
 * session's KOSCOM daily close (`koscom_history`), shown ahead of that
 * session's snapshots (2026-10-18). A reason of its own on purpose: the app
 * labels only the US reason ("종가", no date), and domestic prices show no
 * close label (2026-10-18 product rule).
 */
export const KRX_LAST_SESSION_CLOSE_FALLBACK_REASON =
  'market_closed_krx_last_close';
/**
 * Realtime-fanout-only USD/KRW selection cache TTL. Short on purpose: display
 * conversion may lag a brand-new FX row by at most this long, while realtime
 * ticker bursts stop re-reading fx_rate_snapshots per event.
 */
const REALTIME_FX_CACHE_TTL_MS = 2_000;
@Injectable()
export class AssetsService {
  private readonly sortedSnapshots = new Map<string, SortedAssetSnapshot>();
  private readonly sortedSnapshotInFlight = new Map<
    string,
    Promise<SortedAssetSnapshot>
  >();
  private realtimeUsdKrwCache: {
    selection: UsdKrwSelection;
    expiresAt: number;
  } | null = null;
  private realtimeUsdKrwInFlight: Promise<UsdKrwSelection> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    // Optional so unit specs (and any consumer without ProvidersModule) can
    // construct the service; a missing provider simply yields
    // `displayPriceDecimals: null`, which keeps the previous display policy.
    @Optional()
    private readonly binanceSymbolMetadata?: BinanceSymbolMetadataService,
    @Optional()
    private readonly dailyChangeRate?: DailyChangeRateService,
    @Optional() private readonly redis?: RedisService,
    // Display-only routing for ephemeral (memory-only) provider prices such
    // as the Tiingo trial. Absent or not managing an asset = stored policy.
    @Optional() private readonly displayPrices?: MarketDisplayPriceService,
  ) {}

  async getAssets(
    userId: string | undefined,
    query: AssetsQuery = {},
  ): Promise<AssetsListResponse> {
    if (!userId) {
      this.throwApiError(
        HttpStatus.UNAUTHORIZED,
        'UNAUTHORIZED',
        'Unauthorized',
      );
    }

    const parsedQuery = this.parseQuery(query);
    if (parsedQuery.sortBy) return this.getSortedAssets(parsedQuery);
    const where = this.buildAssetWhere(parsedQuery);
    const [total, assets] = await Promise.all([
      this.prisma.asset.count({ where }),
      this.prisma.asset.findMany({
        where,
        orderBy: [{ symbol: 'asc' }, { id: 'asc' }],
        skip: parsedQuery.offset,
        take: parsedQuery.limit,
        select: this.assetSelect(),
      }),
    ]);
    const now = new Date();
    const pricedAssets = parsedQuery.withPrice
      ? await this.buildAssetsWithPrices(assets, now)
      : {
          assets: assets.map((asset) =>
            this.formatAssetMetadata(
              asset,
              this.buildTradingUx(asset, undefined, now),
            ),
          ),
          priceErrors: [],
        };

    return {
      success: true,
      data: {
        state: 'available',
        filters: this.formatFilters(parsedQuery),
        pagination: this.pagination(parsedQuery, total, assets.length),
        assets: pricedAssets.assets,
        priceErrors: pricedAssets.priceErrors,
      },
    };
  }

  private async getSortedAssets(
    query: ParsedAssetsQuery,
  ): Promise<AssetsListResponse> {
    const key = JSON.stringify(this.formatFilters(query));
    this.pruneSortedSnapshots();
    let snapshot: SortedAssetSnapshot | undefined;
    if (query.sortSnapshot) {
      snapshot =
        this.sortedSnapshots.get(query.sortSnapshot) ??
        (await this.readRedisSortedSnapshot(query.sortSnapshot));
      if (!snapshot || snapshot.expiresAt <= Date.now()) {
        this.throwApiError(
          HttpStatus.CONFLICT,
          'ASSET_SORT_SNAPSHOT_EXPIRED',
          'Refresh the list from the first page.',
        );
      }
      if (snapshot.key !== key) {
        this.throwApiError(
          HttpStatus.BAD_REQUEST,
          'INVALID_SORT_SNAPSHOT',
          'Sort snapshot does not match the requested filters.',
        );
      }
      this.rememberSortedSnapshot(snapshot);
    } else {
      if (query.offset !== 0) {
        this.throwApiError(
          HttpStatus.BAD_REQUEST,
          'INVALID_SORT_SNAPSHOT',
          'Sorted pagination requires sortSnapshot.',
        );
      }
      const pendingKey = JSON.stringify([key, query.sortRefresh]);
      let pending = this.sortedSnapshotInFlight.get(pendingKey);
      if (!pending) {
        pending = withoutAdminDiagnosticContext(() =>
          this.loadOrBuildSortedSnapshot(key, query),
        ).finally(() => this.sortedSnapshotInFlight.delete(pendingKey));
        this.sortedSnapshotInFlight.set(pendingKey, pending);
      }
      snapshot = await pending;
    }
    const assets = snapshot.assets.slice(
      query.offset,
      query.offset + query.limit,
    );
    return {
      success: true,
      data: {
        state: 'available',
        filters: this.formatFilters(query),
        sortSnapshot: snapshot.token,
        pagination: this.pagination(
          query,
          snapshot.assets.length,
          assets.length,
        ),
        assets,
        priceErrors: await this.presentSortedPriceErrors(snapshot, assets),
      },
    };
  }

  private async loadOrBuildSortedSnapshot(
    key: string,
    query: ParsedAssetsQuery,
  ): Promise<SortedAssetSnapshot> {
    if (!query.sortRefresh) {
      const local = [...this.sortedSnapshots.values()]
        .reverse()
        .find(
          (value) => value.key === key && this.canReuseSortedSnapshot(value),
        );
      if (local) return local;
      if (this.redis && process.env.REDIS_URL) {
        try {
          const token = await this.redis.get(this.sortedLatestKey(key));
          const stored = token
            ? await this.readRedisSortedSnapshot(token)
            : undefined;
          if (stored?.key === key && this.canReuseSortedSnapshot(stored)) {
            this.rememberSortedSnapshot(stored);
            return stored;
          }
        } catch {
          /* Cache miss: compute public data from the existing selectors. */
        }
      }
    }
    const valuationAt = Date.now();
    const candidates = await this.prisma.asset.findMany({
      where: this.buildAssetWhere(query),
      orderBy: [{ symbol: 'asc' }, { id: 'asc' }],
      select: this.assetSelect(),
    });
    const priced = await this.buildAssetsWithPrices(
      candidates,
      new Date(valuationAt),
    );
    const ids = priced.assets.flatMap((asset) =>
      asset.price?.state === 'available' && asset.price.assetPriceSnapshotId
        ? [asset.price.assetPriceSnapshotId]
        : [],
    );
    const evidence = ids.length
      ? await this.prisma.assetPriceSnapshot.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            sourceType: true,
            sourceName: true,
            rawPayloadJson: true,
          },
        })
      : [];
    const byId = new Map(evidence.map((row) => [row.id, row]));
    // Rows without stored evidence take their latest completed session's
    // daily value, read once per market: US stocks on Tiingo (no notional in
    // their price evidence) and closed KRX stocks shown at that session's
    // KOSCOM daily close (no stored snapshot). A failed read leaves it null.
    const sessionTurnovers =
      (await this.dailyChangeRate
        ?.findLatestSessionTurnovers(
          priced.assets
            .filter((asset) => asset.price?.state === 'available')
            .map((asset) => ({
              id: asset.assetId,
              assetType: asset.assetType,
              market: asset.market,
            })),
          new Date(valuationAt),
        )
        .catch(() => null)) ?? new Map<string, Prisma.Decimal>();
    const assets = priced.assets.map((asset) => {
      const available = asset.price?.state === 'available';
      const turnover = readAssetListTurnover(
        asset.price?.state === 'available' && asset.price.assetPriceSnapshotId
          ? byId.get(asset.price.assetPriceSnapshotId)
          : undefined,
      );
      return {
        ...asset,
        ...(turnover.turnover === null && available
          ? latestSessionTurnover(sessionTurnovers.get(asset.assetId))
          : turnover),
      };
    });
    assets.sort((a, b) =>
      compareAssetListMetric(a, b, query.sortBy!, query.sortOrder),
    );
    const createdAt = Date.now();
    const snapshot: SortedAssetSnapshot = {
      token: randomUUID(),
      key,
      valuationAt,
      createdAt,
      expiresAt: createdAt + ASSET_SORT_TTL_SECONDS * 1000,
      assets,
      // Explicit allowlist even though the computation has no request context.
      priceErrors: priced.priceErrors.map(({ assetId, code, message }) => ({
        assetId,
        code,
        message,
      })),
    };
    this.rememberSortedSnapshot(snapshot);
    // Ephemeral provider prices (Tiingo trial) must never be written to Redis
    // keys: such a snapshot stays process-local only.
    const containsEphemeralPrice = assets.some(
      (asset) =>
        asset.price?.state === 'available' &&
        this.displayPrices?.isEphemeralSourceName(
          asset.price.priceSource?.sourceName,
        ),
    );
    if (this.redis && process.env.REDIS_URL && !containsEphemeralPrice) {
      try {
        await this.redis.eval(
          STORE_ASSET_SORT_SNAPSHOT,
          [
            ASSET_SORT_CACHE_PREFIX + snapshot.token,
            this.sortedLatestKey(key),
            ASSET_SORT_CACHE_PREFIX + 'index',
          ],
          [
            ASSET_SORT_CACHE_PREFIX,
            snapshot.token,
            JSON.stringify(snapshot),
            String(ASSET_SORT_TTL_SECONDS),
            String(ASSET_SORT_REUSE_SECONDS),
            String(ASSET_SORT_MAX_SNAPSHOTS),
            String(createdAt),
          ],
        );
      } catch {
        /* Local continuity works; other instances explicitly restart. */
      }
    }
    return snapshot;
  }

  private sortedLatestKey(key: string): string {
    return (
      ASSET_SORT_CACHE_PREFIX +
      'latest:' +
      createHash('sha1').update(key).digest('hex')
    );
  }

  private canReuseSortedSnapshot(snapshot: SortedAssetSnapshot): boolean {
    return (
      snapshot.createdAt + ASSET_SORT_REUSE_SECONDS * 1000 > Date.now() &&
      snapshot.expiresAt > Date.now()
    );
  }

  private pruneSortedSnapshots(): void {
    for (const [token, value] of this.sortedSnapshots) {
      if (value.expiresAt <= Date.now()) this.sortedSnapshots.delete(token);
    }
  }

  private rememberSortedSnapshot(snapshot: SortedAssetSnapshot): void {
    this.pruneSortedSnapshots();
    if (this.sortedSnapshots.has(snapshot.token)) return;
    while (this.sortedSnapshots.size >= ASSET_SORT_MAX_SNAPSHOTS) {
      const oldest = [...this.sortedSnapshots.values()].reduce((a, b) =>
        a.createdAt <= b.createdAt ? a : b,
      );
      this.sortedSnapshots.delete(oldest.token);
    }
    this.sortedSnapshots.set(snapshot.token, snapshot);
  }

  private async readRedisSortedSnapshot(
    token: string,
  ): Promise<SortedAssetSnapshot | undefined> {
    if (!this.redis || !process.env.REDIS_URL) return undefined;
    try {
      const raw = await this.redis.get(ASSET_SORT_CACHE_PREFIX + token);
      if (!raw) return undefined;
      const snapshot = JSON.parse(raw) as SortedAssetSnapshot;
      if (
        snapshot.token !== token ||
        typeof snapshot.key !== 'string' ||
        !Number.isFinite(snapshot.valuationAt) ||
        !Number.isFinite(snapshot.createdAt) ||
        !Number.isFinite(snapshot.expiresAt) ||
        !Array.isArray(snapshot.assets) ||
        !Array.isArray(snapshot.priceErrors)
      )
        return undefined;
      return {
        ...snapshot,
        priceErrors: snapshot.priceErrors.map(({ assetId, code, message }) => ({
          assetId,
          code,
          message,
        })),
      };
    } catch {
      return undefined;
    }
  }

  private async presentSortedPriceErrors(
    snapshot: SortedAssetSnapshot,
    assets: AssetListItem[],
  ): Promise<AssetPriceError[]> {
    const pageIds = new Set(assets.map((asset) => asset.id));
    const errors = snapshot.priceErrors.filter((error) =>
      pageIds.has(error.assetId),
    );
    if (!isAdminDiagnosticRequest() || !errors.length) return errors;
    // Only failed rows on this page need request-specific diagnostic evidence.
    const failedIds = new Set(errors.map((error) => error.assetId));
    const diagnosticAssets = assets.filter((asset) => failedIds.has(asset.id));
    const current = await this.buildAssetsWithPrices(
      diagnosticAssets,
      new Date(snapshot.valuationAt),
      { sortSnapshot: snapshot.token, observedAt: new Date() },
    );
    return errors.map((error) => {
      const asset = diagnosticAssets.find(
        (asset) => asset.id === error.assetId,
      )!;
      const reproduced = current.priceErrors.find(
        (value) => value.assetId === error.assetId && value.code === error.code,
      );
      const diagnostic =
        reproduced?.diagnostic ??
        buildAdminPartialFailureDiagnostic(
          new Error(error.message),
          error.code,
          {
            domain: 'MARKET_DATA',
            operation:
              error.code === 'ASSET_PRICE_UNAVAILABLE'
                ? 'ASSET_PRICE_READ'
                : 'ASSET_PRICE_KRW_CONVERSION',
            failureStage:
              error.code === 'ASSET_PRICE_UNAVAILABLE'
                ? 'asset_price_selection'
                : 'fx_rate_selection',
            entities: { assetId: asset.id, symbol: asset.symbol },
            evidence: {
              sortSnapshot: snapshot.token,
              valuationAt: new Date(snapshot.valuationAt),
              cachedPriceState: asset.price?.state,
              originalSelectionEvidence: 'not_retained_in_shared_cache',
              reproductionResult: 'original_failure_not_reproduced',
              selectionResult: 'SNAPSHOT_PARTIAL_FAILURE',
            },
            nextInvestigation: [
              'backend/src/assets/assets.service.ts',
              'backend/src/providers/source-eligibility.policy.ts',
            ],
          },
        );
      return { ...error, ...(diagnostic ? { diagnostic } : {}) };
    });
  }

  async getAsset(
    userId: string | undefined,
    assetId: string | undefined,
  ): Promise<AssetDetailResponse> {
    if (!userId) {
      this.throwApiError(
        HttpStatus.UNAUTHORIZED,
        'UNAUTHORIZED',
        'Unauthorized',
      );
    }

    const parsedAssetId = this.parseAssetId(assetId);
    const asset = await this.prisma.asset.findUnique({
      where: {
        id: parsedAssetId,
      },
      select: this.assetSelect(),
    });

    if (!asset || isFuturesOnlyAsset(asset)) {
      this.throwApiError(
        HttpStatus.NOT_FOUND,
        'ASSET_NOT_FOUND',
        'Asset not found.',
      );
    }

    const pricedAssets = await this.buildAssetsWithPrices([asset]);
    const pricedAsset = pricedAssets.assets[0];

    if (!pricedAsset?.price) {
      this.throwApiError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'ASSET_PRICE_STATE_ERROR',
        'Asset price state could not be built.',
      );
    }

    return {
      success: true,
      data: {
        state: 'available',
        asset: {
          ...pricedAsset,
          price: pricedAsset.price,
          tradingNote: this.buildTradingNote(asset),
        },
        priceErrors: pricedAssets.priceErrors,
      },
    };
  }

  async getAssetPrice(
    userId: string | undefined,
    assetId: string | undefined,
  ): Promise<AssetPriceResponse> {
    if (!userId) {
      this.throwApiError(
        HttpStatus.UNAUTHORIZED,
        'UNAUTHORIZED',
        'Unauthorized',
      );
    }

    const parsedAssetId = this.parseAssetId(assetId);
    const asset = await this.prisma.asset.findUnique({
      where: {
        id: parsedAssetId,
      },
      select: this.assetSelect(),
    });

    if (!asset || isFuturesOnlyAsset(asset)) {
      this.throwApiError(
        HttpStatus.NOT_FOUND,
        'ASSET_NOT_FOUND',
        'Asset not found.',
      );
    }

    const pricedAssets = await this.buildAssetsWithPrices([asset]);
    const price = pricedAssets.assets[0]?.price;
    if (!price || price.state === 'unavailable') {
      const priceError = pricedAssets.priceErrors[0];
      return {
        success: true,
        data: {
          state: 'unavailable',
          assetId: asset.id,
          symbol: asset.symbol,
          name: asset.name,
          assetType: asset.assetType,
          market: asset.market,
          priceCurrency: this.getAssetPriceCurrency(asset),
          displayPriceDecimals: this.getDisplayPriceDecimals(asset),
          currentPrice: null,
          priceKrwState: 'unavailable',
          priceKrw: null,
          changeRate: null,
          assetPriceSnapshotId: null,
          priceEffectiveAt: null,
          priceCapturedAt: null,
          freshnessAgeSeconds: null,
          priceSource: null,
          reason: price?.reason ?? 'ASSET_PRICE_UNAVAILABLE',
          message:
            price?.message ??
            `Asset price snapshot is unavailable for asset ${asset.id}.`,
          ...(priceError?.diagnostic
            ? { diagnostic: priceError.diagnostic }
            : {}),
        },
      };
    }

    const priceKrwAvailable = price.priceKrwState === 'available';

    return {
      success: true,
      data: {
        state: 'available',
        assetId: asset.id,
        symbol: asset.symbol,
        name: asset.name,
        assetType: asset.assetType,
        market: asset.market,
        currentPrice: price.currentPrice,
        priceCurrency: price.priceCurrency,
        displayPriceDecimals: this.getDisplayPriceDecimals(asset),
        priceKrwState: price.priceKrwState,
        priceKrw: priceKrwAvailable ? price.priceKrw : null,
        ...(priceKrwAvailable
          ? {}
          : {
              priceKrwReason: price.priceKrwReason,
              priceKrwMessage: price.priceKrwMessage,
            }),
        changeRate: price.changeRate,
        assetPriceSnapshotId: price.assetPriceSnapshotId,
        priceEffectiveAt: price.priceEffectiveAt,
        priceCapturedAt: price.priceCapturedAt,
        freshnessAgeSeconds: this.calculateFreshnessAgeSeconds(
          price.priceCapturedAt,
        ),
        priceSource: price.priceSource,
        ...(price.fxRateSource ? { fxRateSource: price.fxRateSource } : {}),
      },
    };
  }

  async getAssetPriceForTicker(
    assetId: string,
    valuationAt = new Date(),
  ): Promise<AssetTickerPriceSelection | null> {
    const parsedAssetId = this.parseAssetId(assetId);
    const asset = await this.prisma.asset.findFirst({
      where: {
        id: parsedAssetId,
        ...SPOT_ASSET_WHERE,
        isActive: true,
      },
      select: this.assetSelect(),
    });

    if (!asset || isFuturesOnlyAsset(asset)) {
      return null;
    }

    const usdKrwSelection =
      this.getAssetPriceCurrency(asset) === CurrencyCode.USD
        ? await this.findUsdKrwSelection(valuationAt)
        : null;
    const price = await this.buildAssetPrice(
      asset,
      valuationAt,
      usdKrwSelection,
    );

    return {
      asset: {
        ...this.buildTradingUx(asset, price.payload, valuationAt),
        id: asset.id,
        symbol: asset.symbol,
        name: asset.name,
        assetType: asset.assetType,
        market: asset.market,
        priceCurrency: this.getAssetPriceCurrency(asset),
        displayPriceDecimals: this.getDisplayPriceDecimals(asset),
      },
      price: price.payload,
    };
  }

  /**
   * Converts a realtime local price to KRW with the currently eligible USD/KRW
   * snapshot. KRW-priced assets are already KRW, so their local price is
   * returned unchanged. Returns `unavailable` (never a stale mix) when no
   * eligible FX row exists.
   *
   * The eligible-selection result (available OR unavailable) is cached for a
   * couple of seconds: realtime tickers arrive many times per second across
   * assets, and the eligible USD/KRW row does not change at that cadence, so
   * one event does at most one FX read and most events do none. REST paths are
   * untouched — they keep their per-request `findUsdKrwSelection`.
   */
  async convertRealtimePriceToKrw(input: {
    priceLocal: string;
    priceCurrency: CurrencyCode;
    valuationAt?: Date;
  }): Promise<RealtimePriceKrwConversion> {
    if (input.priceCurrency === CurrencyCode.KRW) {
      return {
        state: 'available',
        priceKrw: this.formatDecimal(new Prisma.Decimal(input.priceLocal), 8),
        fxRateSource: null,
      };
    }

    const selection = await this.getRealtimeUsdKrwSelection(
      input.valuationAt ?? new Date(),
    );
    if (selection.state === 'available') {
      return {
        state: 'available',
        priceKrw: this.formatDecimal(
          new Prisma.Decimal(input.priceLocal).mul(selection.rate),
          8,
        ),
        fxRateSource: presentSourceDecision(selection.sourceDecision),
      };
    }

    return {
      state: 'unavailable',
      reason: selection.code,
      message: selection.message,
      fxRateSource: selection.sourceDecision
        ? presentSourceDecision(selection.sourceDecision)
        : null,
    };
  }

  private async getRealtimeUsdKrwSelection(
    valuationAt: Date,
  ): Promise<UsdKrwSelection> {
    const now = Date.now();
    const cached = this.realtimeUsdKrwCache;
    if (cached && now < cached.expiresAt) return cached.selection;

    // Coalesce a burst of concurrent misses into one DB read.
    if (!this.realtimeUsdKrwInFlight) {
      this.realtimeUsdKrwInFlight = this.findUsdKrwSelection(valuationAt)
        .then((selection) => {
          this.realtimeUsdKrwCache = {
            selection,
            expiresAt: Date.now() + REALTIME_FX_CACHE_TTL_MS,
          };
          return selection;
        })
        .finally(() => {
          this.realtimeUsdKrwInFlight = null;
        });
    }

    return this.realtimeUsdKrwInFlight;
  }

  private async buildAssetsWithPrices(
    assets: readonly AssetRecord[],
    valuationAt = new Date(),
    cachedFailureObservation?: CachedFailureObservation,
  ): Promise<{
    assets: AssetListItem[];
    priceErrors: AssetPriceError[];
  }> {
    if (assets.length === 0) {
      return {
        assets: [],
        priceErrors: [],
      };
    }

    const usdKrwSelection = assets.some(
      (asset) => this.getAssetPriceCurrency(asset) === CurrencyCode.USD,
    )
      ? await this.findUsdKrwSelection(valuationAt)
      : null;
    const results = await Promise.all(
      assets.map(async (asset) => {
        const price = await this.buildAssetPrice(
          asset,
          valuationAt,
          usdKrwSelection,
          cachedFailureObservation,
        );

        return {
          asset: {
            ...this.formatAssetMetadata(
              asset,
              this.buildTradingUx(asset, price.payload, valuationAt),
            ),
            price: price.payload,
          },
          error: price.error,
        };
      }),
    );

    return {
      assets: results.map((result) => result.asset),
      priceErrors: results
        .map((result) => result.error)
        .filter((error): error is AssetPriceError => Boolean(error)),
    };
  }

  private async buildAssetPrice(
    asset: AssetRecord,
    valuationAt: Date,
    usdKrwSelection: UsdKrwSelection | null,
    cachedFailureObservation?: CachedFailureObservation,
  ): Promise<{
    payload: AssetPricePayload;
    error?: AssetPriceError;
  }> {
    const { snapshot, failureContext } =
      await this.findLatestEligibleAssetPriceSnapshot(asset, valuationAt);

    if (!snapshot) {
      const message = `Asset price snapshot is unavailable for asset ${asset.id}.`;
      const diagnostic = buildAdminPartialFailureDiagnostic(
        new Error(message),
        'ASSET_PRICE_UNAVAILABLE',
        {
          ...failureContext,
          evidence: {
            ...failureContext?.evidence,
            ...(cachedFailureObservation ? { cachedFailureObservation } : {}),
          },
          domain: 'MARKET_DATA',
          operation: 'ASSET_PRICE_READ',
          failureStage: failureContext?.failureStage ?? 'asset_price_selection',
          entities: {
            ...failureContext?.entities,
            assetId: asset.id,
            symbol: asset.symbol,
          },
          nextInvestigation: [
            ...(failureContext?.nextInvestigation ?? []),
            'backend/src/assets/assets.service.ts',
            'backend/src/providers/source-eligibility.policy.ts',
          ],
        },
      );

      return {
        payload: {
          state: 'unavailable',
          reason: 'ASSET_PRICE_UNAVAILABLE',
          message,
        },
        error: {
          assetId: asset.id,
          code: 'ASSET_PRICE_UNAVAILABLE',
          message,
          ...(diagnostic ? { diagnostic } : {}),
        },
      };
    }

    const basePayload = {
      state: 'available' as const,
      currentPrice: this.formatDecimal(snapshot.price, 8),
      changeRate: await this.calculateChangeRate(asset, snapshot, valuationAt),
      priceCurrency: snapshot.currencyCode,
      assetPriceSnapshotId: snapshot.id,
      priceEffectiveAt: snapshot.effectiveAt.toISOString(),
      priceCapturedAt: snapshot.capturedAt.toISOString(),
      priceSource: presentSourceDecision(snapshot.sourceDecision),
    };

    if (this.getAssetPriceCurrency(asset) === CurrencyCode.KRW) {
      return {
        payload: {
          ...basePayload,
          priceKrwState: 'available',
          priceKrw: this.formatDecimal(snapshot.priceKrw ?? snapshot.price, 8),
        },
      };
    }

    if (snapshot.priceKrw) {
      return {
        payload: {
          ...basePayload,
          priceKrwState: 'available',
          priceKrw: this.formatDecimal(snapshot.priceKrw, 8),
        },
      };
    }

    if (usdKrwSelection?.state === 'available') {
      return {
        payload: {
          ...basePayload,
          priceKrwState: 'available',
          priceKrw: this.formatDecimal(
            snapshot.price.mul(usdKrwSelection.rate),
            8,
          ),
          fxRateSource: presentSourceDecision(usdKrwSelection.sourceDecision),
        },
      };
    }

    const error = usdKrwSelection ?? {
      state: 'unavailable' as const,
      code: 'FX_RATE_UNAVAILABLE' as const,
      message: 'USD/KRW FX rate snapshot is unavailable.',
    };
    const fxRateSource =
      'sourceDecision' in error
        ? presentSourceDecision(error.sourceDecision)
        : null;
    const diagnostic = buildAdminPartialFailureDiagnostic(
      new Error(error.message),
      error.code,
      {
        domain: 'MARKET_DATA',
        operation: 'ASSET_PRICE_KRW_CONVERSION',
        failureStage: 'fx_rate_selection',
        entities: {
          assetId: asset.id,
          symbol: asset.symbol,
          snapshotId: snapshot.id,
        },
        evidence: {
          priceCurrency: snapshot.currencyCode,
          ...('failureEvidence' in error ? error.failureEvidence : {}),
          ...(cachedFailureObservation ? { cachedFailureObservation } : {}),
          priceSnapshotCapturedAt: snapshot.capturedAt,
          valuationAt,
          selectionResult: 'REJECTED',
        },
        nextInvestigation: [
          'backend/src/assets/assets.service.ts',
          'backend/src/providers/source-eligibility.policy.ts',
        ],
      },
    );

    return {
      payload: {
        ...basePayload,
        priceKrwState: 'unavailable',
        priceKrwReason: error.code,
        priceKrwMessage: error.message,
        fxRateSource,
      },
      error: {
        assetId: asset.id,
        code: error.code,
        message: error.message,
        ...(diagnostic ? { diagnostic } : {}),
      },
    };
  }

  async calculateChangeRate(
    asset: Pick<AssetRecord, 'id' | 'assetType' | 'market'>,
    snapshot: { price: Prisma.Decimal | string; effectiveAt: Date },
    now = new Date(),
  ): Promise<string | null> {
    return this.dailyChangeRate?.calculate({ asset, ...snapshot, now }) ?? null;
  }

  private async findLatestEligibleAssetPriceSnapshot(
    asset: AssetRecord,
    valuationAt: Date,
  ): Promise<{
    snapshot: AssetPriceSnapshotRecord | null;
    failureContext?: DiagnosticContextUpdate;
  }> {
    const ephemeral = await this.displayPrices?.resolve(
      {
        id: asset.id,
        symbol: asset.symbol,
        market: asset.market,
        assetType: asset.assetType,
        priceCurrency: this.getAssetPriceCurrency(asset),
      },
      valuationAt,
    );
    if (ephemeral) return this.ephemeralSnapshot(asset, ephemeral);

    const providerEligibility = resolveAssetProviderEligibility({
      workflow: 'assets_with_price',
      asset: {
        id: asset.id,
        assetType: asset.assetType,
        market: asset.market,
        currencyCode: this.getAssetPriceCurrency(asset),
      },
    });
    const priceRead = {
      asset: { ...asset, currencyCode: this.getAssetPriceCurrency(asset) },
      workflow: 'assets_with_price' as const,
      now: valuationAt,
    };
    const closedScope = closedMarketPriceScope(priceRead);
    // A closed KRX market shows its latest completed session's KOSCOM daily
    // close ahead of that session's stored snapshots (2026-10-18 product
    // rule: every domestic stock on one close basis). Without a valid daily
    // the existing selection below applies unchanged.
    const krxClosed =
      closedScope !== null && asset.assetType === AssetType.domestic_stock;
    const dailyClose = krxClosed
      ? await this.findLatestSessionCloseSnapshot(asset, valuationAt, null)
      : null;
    if (dailyClose) return { snapshot: dailyClose };
    const providerCandidates = providerEligibility.eligible
      ? await findMarketAwareAssetPriceCandidates(this.prisma, {
          ...priceRead,
          sourceNames: providerEligibility.sourceNames,
        })
      : [];
    const providerSelection = providerEligibility.eligible
      ? selectMarketAwareAssetPriceSnapshotBySourcePriority({
          asset,
          workflow: 'assets_with_price',
          candidates: providerCandidates,
          expectedSourceNames: providerEligibility.sourceNames,
          now: valuationAt,
          freshnessThresholdSeconds:
            providerEligibility.freshnessThresholdSeconds,
          isPositiveValue: (candidate) => isPositiveDecimal(candidate.price),
        })
      : {
          state: 'not_selected' as const,
          decision: {
            selectedSourceType: null,
            selectedSourceName: null,
            selectedSnapshotId: null,
            selectedEffectiveAt: null,
            selectedCapturedAt: null,
            fallbackUsed: true,
            fallbackReason: providerEligibility.reason,
            rejectedProviderReason: null,
            freshnessAgeSeconds: null,
          },
        };

    if (providerSelection.state === 'selected') {
      return {
        snapshot: {
          ...providerSelection.snapshot,
          sourceDecision: providerSelection.decision,
        },
      };
    }

    const providerFailureEvidence = buildSelectionFailureEvidence({
      workflow: 'assets_with_price',
      evaluationAt: valuationAt,
      eligibility: providerEligibility,
      candidates: providerCandidates,
      selection: providerSelection,
      asset,
      isPositiveValue: (candidate) => isPositiveDecimal(candidate.price),
    });

    const fallbackSnapshot = await this.prisma.assetPriceSnapshot.findFirst({
      where: {
        assetId: asset.id,
        currencyCode: this.getAssetPriceCurrency(asset),
        sourceType: AssetPriceSourceType.admin_manual,
        ...adminManualAssetPriceScope(asset),
        effectiveAt: {
          lte: valuationAt,
        },
        price: {
          gt: 0,
        },
        ...closedScope?.where,
      },
      orderBy: [
        { effectiveAt: 'desc' },
        { capturedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      select: {
        id: true,
        price: true,
        priceKrw: true,
        currencyCode: true,
        sourceType: true,
        sourceName: true,
        effectiveAt: true,
        capturedAt: true,
      },
    });

    if (!fallbackSnapshot) {
      // A closed KRX market already tried its daily close above.
      const lastClose =
        closedScope && !krxClosed
          ? await this.findLatestSessionCloseSnapshot(
              asset,
              valuationAt,
              providerSelection.decision,
            )
          : null;
      if (lastClose) return { snapshot: lastClose };
      const latestCandidate = providerCandidates[0];
      const failureContext: DiagnosticContextUpdate = {
        failureStage: 'asset_price_selection',
        entities: {
          assetId: asset.id,
          symbol: asset.symbol,
          snapshotId: latestCandidate?.id,
        },
        evidence: {
          ...providerFailureEvidence,
          manualFallback: describeManualFallback({
            snapshot: null,
            evaluationAt: valuationAt,
            queryChecks: [
              'source_type_admin_manual',
              'positive_value',
              'effective_at_lte_evaluation',
              ...(closedScope ? ['last_completed_session'] : []),
            ],
          }),
          ...(closedScope ? { lastSessionClose: 'unavailable' } : {}),
        },
      };
      recordAdminDiagnosticEvent(
        'warn',
        'ASSET_PRICE_SELECTION_REJECTED',
        `No eligible price snapshot was selected for asset ${asset.id}.`,
        { rejectedReason: providerSelection.decision.rejectedProviderReason },
      );
      return { snapshot: null, failureContext };
    }

    return {
      snapshot: {
        ...fallbackSnapshot,
        sourceDecision: buildAdminManualFallbackDecision({
          selectedSnapshotId: fallbackSnapshot.id,
          selectedSourceName: fallbackSnapshot.sourceName,
          selectedEffectiveAt: fallbackSnapshot.effectiveAt,
          selectedCapturedAt: fallbackSnapshot.capturedAt,
          providerDecision: providerSelection.decision,
        }),
      },
    };
  }

  /**
   * The latest completed session's daily close, DISPLAY only, for the asset
   * read paths (list, search, detail, price, snapshot ticker): a closed US
   * market without an eligible stored price shows the confirmed Tiingo
   * end-of-day close; a closed KRX market shows KOSCOM's daily close first
   * (`DailyChangeRateService.findLatestSessionClose`). It has no stored row
   * (`id: null`) and is never written: orders, valuation, ranking and
   * settlement select `asset_price_snapshots` under their own freshness
   * policies and never call this, so it cannot become an executable price.
   * The market is closed, so the asset stays MARKET_CLOSED / not tradable.
   */
  private async findLatestSessionCloseSnapshot(
    asset: AssetRecord,
    valuationAt: Date,
    providerDecision: SourceDecision | null,
  ): Promise<AssetPriceSnapshotRecord | null> {
    const currency = this.getAssetPriceCurrency(asset);
    const krx =
      asset.assetType === AssetType.domestic_stock &&
      currency === CurrencyCode.KRW;
    if (currency !== CurrencyCode.USD && !krx) return null;
    const close = await this.dailyChangeRate?.findLatestSessionClose(
      asset,
      valuationAt,
    );
    if (!close) return null;
    const sourceName = krx ? KOSCOM_HISTORY_SOURCE : TIINGO_EOD_CANDLE_SOURCE;
    return {
      id: null,
      price: close.close,
      priceKrw: krx ? close.close : null,
      currencyCode: currency,
      sourceType: AssetPriceSourceType.provider_api,
      sourceName,
      effectiveAt: close.sessionCloseAt,
      capturedAt: close.receivedAt,
      sourceDecision: {
        selectedSourceType: 'provider_api',
        selectedSourceName: sourceName,
        selectedSnapshotId: null,
        selectedEffectiveAt: close.sessionCloseAt,
        selectedCapturedAt: close.receivedAt,
        fallbackUsed: true,
        fallbackReason: krx
          ? KRX_LAST_SESSION_CLOSE_FALLBACK_REASON
          : LAST_SESSION_CLOSE_FALLBACK_REASON,
        rejectedProviderReason:
          providerDecision?.rejectedProviderReason ?? null,
        freshnessAgeSeconds: null,
      },
    };
  }

  /**
   * Ephemeral display price (Tiingo trial). There is deliberately NO stored
   * provider or admin_manual fallback for these assets: an unavailable trial
   * price is reported as unavailable, never replaced by another source.
   */
  private ephemeralSnapshot(
    asset: AssetRecord,
    ephemeral: EphemeralDisplayPrice,
  ): {
    snapshot: AssetPriceSnapshotRecord | null;
    failureContext?: DiagnosticContextUpdate;
  } {
    if (ephemeral.state === 'available') {
      return {
        snapshot: {
          id: null,
          price: new Prisma.Decimal(ephemeral.price),
          priceKrw: null,
          currencyCode: CurrencyCode.USD,
          sourceType: AssetPriceSourceType.provider_api,
          sourceName: ephemeral.sourceName,
          effectiveAt: ephemeral.effectiveAt,
          capturedAt: ephemeral.capturedAt,
          sourceDecision: ephemeral.decision,
        },
      };
    }
    recordAdminDiagnosticEvent(
      'warn',
      'ASSET_PRICE_SELECTION_REJECTED',
      `No ephemeral display price was available for asset ${asset.id}.`,
      { rejectedReason: ephemeral.code },
    );
    return {
      snapshot: null,
      failureContext: {
        failureStage: ephemeral.failureStage,
        entities: { assetId: asset.id, symbol: asset.symbol },
        evidence: { ...ephemeral.evidence, unavailableCode: ephemeral.code },
        nextInvestigation: [
          'backend/src/providers/tiingo/tiingo-quote.service.ts',
          'GET /readiness → data.tiingo',
        ],
      },
    };
  }

  private async findUsdKrwSelection(
    valuationAt: Date,
  ): Promise<UsdKrwSelection> {
    const providerEligibility = resolveFxProviderEligibility({
      workflow: 'assets_with_price',
      baseCurrency: CurrencyCode.USD,
      quoteCurrency: CurrencyCode.KRW,
    });
    const providerCandidates = providerEligibility.eligible
      ? await findUsdKrwProviderSnapshotCandidates(this.prisma, {
          sourceNames: providerEligibility.sourceNames,
          take: 10,
        })
      : [];
    const providerSelection = providerEligibility.eligible
      ? selectFreshProviderSnapshotBySourcePriority({
          candidates: providerCandidates,
          expectedSourceNames: providerEligibility.sourceNames,
          now: valuationAt,
          freshnessThresholdSeconds:
            providerEligibility.freshnessThresholdSeconds,
          isPositiveValue: (candidate) => isPositiveDecimal(candidate.rate),
        })
      : {
          state: 'not_selected' as const,
          decision: {
            selectedSourceType: null,
            selectedSourceName: null,
            selectedSnapshotId: null,
            selectedEffectiveAt: null,
            selectedCapturedAt: null,
            fallbackUsed: true,
            fallbackReason: providerEligibility.reason,
            rejectedProviderReason: null,
            freshnessAgeSeconds: null,
          },
        };

    if (providerSelection.state === 'selected') {
      return {
        state: 'available',
        rate: providerSelection.snapshot.rate,
        sourceDecision: providerSelection.decision,
      };
    }

    const providerFailureEvidence = buildSelectionFailureEvidence({
      workflow: 'assets_with_price',
      evaluationAt: valuationAt,
      eligibility: providerEligibility,
      candidates: providerCandidates,
      selection: providerSelection,
      isPositiveValue: (candidate) => isPositiveDecimal(candidate.rate),
    });

    const snapshot = await this.prisma.fxRateSnapshot.findFirst({
      where: {
        baseCurrency: CurrencyCode.USD,
        quoteCurrency: CurrencyCode.KRW,
        sourceType: FxRateSourceType.admin_manual,
        approvedByUserId: {
          not: null,
        },
        effectiveAt: {
          lte: valuationAt,
        },
        rate: {
          gt: 0,
        },
      },
      orderBy: [
        { effectiveAt: 'desc' },
        { capturedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      select: {
        id: true,
        rate: true,
        sourceType: true,
        sourceName: true,
        effectiveAt: true,
        capturedAt: true,
        approvedByUserId: true,
      },
    });

    const failureEvidence = (reason?: string) => ({
      ...providerFailureEvidence,
      manualFallback: describeManualFallback({
        snapshot,
        evaluationAt: valuationAt,
        reason,
        queryChecks: [
          'source_type_admin_manual',
          'approved',
          'positive_value',
          'effective_at_lte_evaluation',
        ],
        freshnessThresholdSeconds: fxExecuteSnapshotFreshnessThresholdMs / 1000,
        positiveValue: snapshot ? isPositiveDecimal(snapshot.rate) : undefined,
      }),
    });

    if (!snapshot) {
      return {
        state: 'unavailable',
        code: 'FX_RATE_UNAVAILABLE',
        message: 'USD/KRW FX rate snapshot is unavailable.',
        sourceDecision: providerSelection.decision,
        failureEvidence: failureEvidence(),
      };
    }

    const sourceDecision = buildAdminManualFallbackDecision({
      selectedSnapshotId: snapshot.id,
      selectedSourceName: snapshot.sourceName,
      selectedEffectiveAt: snapshot.effectiveAt,
      selectedCapturedAt: snapshot.capturedAt,
      providerDecision: providerSelection.decision,
    });

    if (
      snapshot.sourceType !== FxRateSourceType.admin_manual ||
      !snapshot.approvedByUserId
    ) {
      return {
        state: 'unavailable',
        code: 'FX_RATE_UNAVAILABLE',
        message:
          'No approved admin_manual USD/KRW FX rate snapshot is available.',
        sourceDecision,
        failureEvidence: failureEvidence(
          'manual_source_or_approval_ineligible',
        ),
      };
    }

    if (
      isFxSnapshotStaleForPortfolioValuation(snapshot.effectiveAt, valuationAt)
    ) {
      return {
        state: 'unavailable',
        code: 'FX_RATE_STALE',
        message: 'USD/KRW FX rate snapshot is stale.',
        sourceDecision,
        failureEvidence: failureEvidence('effective_at_stale'),
      };
    }

    return {
      state: 'available',
      rate: snapshot.rate,
      sourceDecision,
    };
  }

  private buildAssetWhere(query: ParsedAssetsQuery): Prisma.AssetWhereInput {
    return {
      ...SPOT_ASSET_WHERE,
      ...(query.includeInactive ? {} : { isActive: true }),
      ...(query.assetType ? { assetType: query.assetType } : {}),
      ...(query.currencyCode ? { currencyCode: query.currencyCode } : {}),
      ...(query.market ? { market: query.market } : {}),
      ...(query.search
        ? {
            OR: [
              {
                symbol: {
                  contains: query.search,
                  mode: 'insensitive',
                },
              },
              {
                name: {
                  contains: query.search,
                  mode: 'insensitive',
                },
              },
            ],
          }
        : {}),
    };
  }

  private parseQuery(query: AssetsQuery): ParsedAssetsQuery {
    const sortBy = this.parseOptionalText(query.sortBy);
    const sortOrder =
      this.parseOptionalText(query.sortOrder) ?? (sortBy ? 'desc' : 'asc');
    const sortSnapshot = this.parseOptionalText(query.sortSnapshot);
    const sortRefresh = this.parseBoolean(
      query.sortRefresh,
      false,
      'INVALID_ASSET_SORT',
      'sortRefresh',
    );
    if (
      (sortBy && sortBy !== 'turnover' && sortBy !== 'changeRate') ||
      (sortOrder !== 'asc' && sortOrder !== 'desc') ||
      (!sortBy && (query.sortOrder !== undefined || sortSnapshot)) ||
      (sortSnapshot && !/^[0-9a-f-]{36}$/.test(sortSnapshot)) ||
      (sortRefresh &&
        (!sortBy || sortSnapshot || this.parseOffset(query.offset) !== 0))
    ) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_ASSET_SORT',
        'Invalid asset sort parameters.',
      );
    }
    if (sortBy && this.parseOptionalText(query.withPrice) === 'false') {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_ASSET_SORT',
        'Sorting requires withPrice=true.',
      );
    }
    return {
      sortBy: sortBy as ParsedAssetsQuery['sortBy'],
      sortOrder,
      sortSnapshot,
      sortRefresh,
      assetType: this.parseAssetType(query.assetType),
      currencyCode: this.parseCurrencyCode(query.currencyCode),
      market: this.parseOptionalText(query.market),
      search: this.parseOptionalText(query.search),
      includeInactive: this.parseBoolean(
        query.includeInactive,
        false,
        'INVALID_INCLUDE_INACTIVE',
        'includeInactive',
      ),
      withPrice: this.parseBoolean(
        query.withPrice,
        true,
        'INVALID_WITH_PRICE',
        'withPrice',
      ),
      limit: this.parseLimit(query.limit),
      offset: this.parseOffset(query.offset),
    };
  }

  private parseAssetType(value: string | undefined): AssetType | undefined {
    const text = this.parseOptionalText(value);
    if (!text) {
      return undefined;
    }

    if (
      text === AssetType.domestic_stock ||
      text === AssetType.us_stock ||
      text === AssetType.crypto
    ) {
      return text;
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'INVALID_ASSET_TYPE',
      'Invalid assetType.',
    );
  }

  private parseCurrencyCode(
    value: string | undefined,
  ): CurrencyCode | undefined {
    const text = this.parseOptionalText(value);
    if (!text) {
      return undefined;
    }

    if (text === CurrencyCode.KRW || text === CurrencyCode.USD) {
      return text;
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'INVALID_CURRENCY_CODE',
      'Invalid currencyCode.',
    );
  }

  private parseBoolean(
    value: string | undefined,
    defaultValue: boolean,
    code: string,
    fieldName: string,
  ): boolean {
    const text = this.parseOptionalText(value);
    if (!text) {
      return defaultValue;
    }

    if (text === 'true') {
      return true;
    }

    if (text === 'false') {
      return false;
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      code,
      `${fieldName} must be true or false.`,
    );
  }

  private parseLimit(value: string | undefined): number {
    if (value === undefined) {
      return DEFAULT_LIMIT;
    }

    const limit = this.parseNonNegativeInteger(value, 'INVALID_LIMIT', 'limit');
    if (limit < 1) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_LIMIT',
        'limit must be greater than 0.',
      );
    }

    return Math.min(limit, MAX_LIMIT);
  }

  private parseOffset(value: string | undefined): number {
    if (value === undefined) {
      return 0;
    }

    return this.parseNonNegativeInteger(value, 'INVALID_OFFSET', 'offset');
  }

  private parseNonNegativeInteger(
    value: string,
    code: string,
    fieldName: string,
  ): number {
    if (!/^\d+$/.test(value.trim())) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        code,
        `${fieldName} must be a non-negative integer.`,
      );
    }

    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        code,
        `${fieldName} must be a safe integer.`,
      );
    }

    return parsed;
  }

  private parseAssetId(value: string | undefined): string {
    const text = this.parseOptionalText(value);
    if (!text) {
      this.throwApiError(
        HttpStatus.NOT_FOUND,
        'ASSET_NOT_FOUND',
        'Asset not found.',
      );
    }

    return text;
  }

  private parseOptionalText(value: string | undefined): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }

  private assetSelect() {
    return {
      id: true,
      symbol: true,
      name: true,
      market: true,
      assetType: true,
      currencyCode: true,
      priceCurrency: true,
      settlementCurrency: true,
      isActive: true,
    } as const;
  }

  private pagination(
    query: ParsedAssetsQuery,
    total: number,
    returned: number,
  ) {
    return buildPagination({
      limit: query.limit,
      offset: query.offset,
      total,
      returned,
    });
  }

  private formatFilters(query: ParsedAssetsQuery) {
    return {
      assetType: query.assetType ?? null,
      currencyCode: query.currencyCode ?? null,
      market: query.market ?? null,
      search: query.search ?? null,
      includeInactive: query.includeInactive,
      withPrice: query.withPrice,
      ...(query.sortBy
        ? { sortBy: query.sortBy, sortOrder: query.sortOrder }
        : {}),
    };
  }

  /**
   * Per-asset unit-price display decimals, or null when the app has no
   * provider-declared precision for that asset (all non-Binance assets today).
   * Money totals are unaffected — this is a unit-price display hint only.
   */
  private getDisplayPriceDecimals(asset: {
    market: string;
    symbol: string;
  }): number | null {
    return (
      this.binanceSymbolMetadata?.getDisplayPriceDecimals({
        market: asset.market,
        symbol: asset.symbol,
      }) ?? null
    );
  }

  private formatAssetMetadata(asset: AssetRecord, tradingUx: AssetTradingUx) {
    return {
      assetId: asset.id,
      id: tradingUx.id,
      symbol: asset.symbol,
      name: asset.name,
      market: asset.market,
      assetType: asset.assetType,
      currencyCode: asset.currencyCode,
      priceCurrency: this.getAssetPriceCurrency(asset),
      settlementCurrency: this.getAssetSettlementCurrency(asset),
      // Additive, nullable display hint (Binance PRICE_FILTER.tickSize based).
      // Clients that ignore it keep their previous formatting.
      displayPriceDecimals: this.getDisplayPriceDecimals(asset),
      isActive: asset.isActive,
      changeRate: tradingUx.changeRate,
      marketStatus: tradingUx.marketStatus,
      tradable: tradingUx.tradable,
      tradeBlockedReason: tradingUx.tradeBlockedReason,
    };
  }

  private buildTradingUx(
    asset: AssetRecord,
    price: AssetPricePayload | undefined,
    now: Date,
  ): AssetTradingUx {
    const marketStatus = this.resolveMarketStatus(asset, now);
    const blockedReason = this.resolveTradeBlockedReason(
      asset,
      price,
      marketStatus,
    );

    return {
      id: asset.id,
      changeRate: price?.state === 'available' ? price.changeRate : null,
      marketStatus,
      tradable: blockedReason === null,
      tradeBlockedReason: blockedReason,
    };
  }

  private resolveTradeBlockedReason(
    asset: AssetRecord,
    price: AssetPricePayload | undefined,
    marketStatus: MarketStatus,
  ): TradeBlockedReason | null {
    if (!asset.isActive) {
      return 'ASSET_INACTIVE';
    }

    if (marketStatus === 'closed') {
      return 'MARKET_CLOSED';
    }

    if (marketStatus === 'unknown') {
      return 'UNKNOWN';
    }

    return this.resolvePriceBlockedReason(price);
  }

  private resolvePriceBlockedReason(
    price: AssetPricePayload | undefined,
  ): TradeBlockedReason | null {
    if (!price) {
      return null;
    }

    if (price.state === 'unavailable') {
      return 'PRICE_UNAVAILABLE';
    }

    if (price.priceSource?.rejectedProviderReason === 'captured_at_stale') {
      return 'PRICE_STALE';
    }

    if (price.priceKrwState === 'unavailable') {
      return price.priceKrwReason === 'FX_RATE_STALE'
        ? 'PRICE_STALE'
        : 'PRICE_UNAVAILABLE';
    }

    return null;
  }

  private resolveMarketStatus(
    asset: AssetRecord,
    now: Date | undefined,
  ): MarketStatus {
    if (asset.assetType === AssetType.crypto) {
      return 'always_open';
    }

    if (!now) {
      return 'unknown';
    }

    // Tri-state stock session mapping: 'closed' is reserved for a CONFIRMED
    // non-trading instant (before open, after close, weekend, holiday, or an
    // operator closure override). A date whose calendar coverage is missing
    // (calendar_unavailable) maps to 'unknown' — the UI must show a neutral
    // "price preparing" state there, never a false "market closed".
    const sessionState = resolveStockMarketSessionState(asset, now);
    if (!sessionState || sessionState.state === 'calendar_unavailable') {
      return 'unknown';
    }

    return sessionState.state === 'open' ? 'open' : 'closed';
  }

  private buildTradingNote(asset: AssetRecord) {
    if (asset.assetType === AssetType.domestic_stock) {
      return {
        walletCurrency: this.getAssetSettlementCurrency(asset),
        settlementCurrency: this.getAssetSettlementCurrency(asset),
        message: 'Domestic stock orders use the KRW wallet.',
      };
    }

    if (asset.assetType === AssetType.crypto) {
      return {
        walletCurrency: this.getAssetSettlementCurrency(asset),
        settlementCurrency: this.getAssetSettlementCurrency(asset),
        message:
          'Crypto is USD-settled and uses the USD wallet under the current MVP policy.',
      };
    }

    return {
      walletCurrency: this.getAssetSettlementCurrency(asset),
      settlementCurrency: this.getAssetSettlementCurrency(asset),
      message: 'US stock orders use the USD wallet.',
    };
  }

  private getAssetPriceCurrency(
    asset: Pick<AssetRecord, 'currencyCode'> & {
      priceCurrency?: CurrencyCode | null;
    },
  ): CurrencyCode {
    return asset.priceCurrency ?? asset.currencyCode;
  }

  private getAssetSettlementCurrency(
    asset: Pick<AssetRecord, 'currencyCode'> & {
      settlementCurrency?: CurrencyCode | null;
    },
  ): CurrencyCode {
    return asset.settlementCurrency ?? asset.currencyCode;
  }

  private formatDecimal(value: Prisma.Decimal, scale: number) {
    return value.toFixed(scale);
  }

  private calculateFreshnessAgeSeconds(capturedAt: string): number {
    const capturedAtTime = Date.parse(capturedAt);
    if (Number.isNaN(capturedAtTime)) {
      return 0;
    }

    return Math.max(0, Math.floor((Date.now() - capturedAtTime) / 1000));
  }

  private createErrorBody(code: string, message: string) {
    return {
      success: false,
      error: {
        code,
        message,
      },
    };
  }

  private throwApiError(
    status: HttpStatus,
    code: string,
    message: string,
  ): never {
    recordAdminDiagnosticEvent(
      status >= HttpStatus.INTERNAL_SERVER_ERROR ? 'error' : 'warn',
      'MARKET_DATA_ERROR_THROWN',
      `${code}: ${message}`,
      { httpStatus: status },
    );
    throw new HttpException(this.createErrorBody(code, message), status);
  }
}
