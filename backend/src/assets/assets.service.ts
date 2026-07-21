import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  AssetPriceSourceType,
  AssetType,
  CurrencyCode,
  FxRateSourceType,
  Prisma,
  SeasonStatus,
} from '../generated/prisma/client';
import { isFxSnapshotStaleForPortfolioValuation } from '../portfolio/portfolio-valuation.policy';
import { PrismaService } from '../prisma/prisma.service';
import {
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
import { buildPagination, type Pagination } from '../common/pagination';
import { isSeasonCurrentlyActive } from '../seasons/season-lifecycle.policy';
import { resolveStockMarketSessionState } from '../orders/market-calendar.policy';

export type AssetsQuery = {
  assetType?: string;
  currencyCode?: string;
  market?: string;
  search?: string;
  includeInactive?: string;
  withPrice?: string;
  limit?: string;
  offset?: string;
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

type AssetSeason = {
  id: string;
  status: SeasonStatus;
  startAt: Date;
  endAt: Date;
};

type AssetPriceSnapshotRecord = {
  id: string;
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
};

type MarketStatus = 'open' | 'closed' | 'always_open' | 'unknown';

type TradeBlockedReason =
  | 'ASSET_INACTIVE'
  | 'MARKET_CLOSED'
  | 'PRICE_UNAVAILABLE'
  | 'PRICE_STALE'
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

type AssetTradingContext = {
  now: Date;
  season: AssetSeason | null;
  joined: boolean;
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
    };

export type AssetPricePayload =
  | {
      state: 'available';
      currentPrice: string;
      changeRate: string | null;
      priceCurrency: CurrencyCode;
      priceKrwState: 'available';
      priceKrw: string;
      assetPriceSnapshotId: string;
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
      assetPriceSnapshotId: string;
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
    id: string;
    symbol: string;
    name: string;
    assetType: AssetType;
    market: string;
    priceCurrency: CurrencyCode;
  };
  price: AssetPricePayload;
};

type AssetListItem = ReturnType<AssetsService['formatAssetMetadata']> & {
  price?: AssetPricePayload;
};

type AssetsListResponse = {
  success: true;
  data: {
    state: 'available';
    filters: ReturnType<AssetsService['formatFilters']>;
    pagination: Pagination;
    assets: AssetListItem[];
    priceErrors: AssetPriceError[];
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
        priceKrwState: 'available' | 'unavailable';
        priceKrw: string | null;
        priceKrwReason?: 'FX_RATE_UNAVAILABLE' | 'FX_RATE_STALE';
        priceKrwMessage?: string;
        changeRate: string | null;
        assetPriceSnapshotId: string;
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
      };
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const CURRENT_SEASON_STATUS_PRIORITY: readonly SeasonStatus[] = [
  SeasonStatus.active,
  SeasonStatus.upcoming,
  SeasonStatus.ended,
  SeasonStatus.settled,
];

@Injectable()
export class AssetsService {
  constructor(private readonly prisma: PrismaService) {}

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
    const tradingContext =
      assets.length > 0
        ? await this.buildAssetTradingContext(userId, new Date())
        : null;
    const pricedAssets = parsedQuery.withPrice
      ? await this.buildAssetsWithPrices(assets, tradingContext)
      : {
          assets: assets.map((asset) =>
            this.formatAssetMetadata(
              asset,
              this.buildTradingUx(asset, undefined, tradingContext),
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

    if (!asset) {
      this.throwApiError(
        HttpStatus.NOT_FOUND,
        'ASSET_NOT_FOUND',
        'Asset not found.',
      );
    }

    const tradingContext = await this.buildAssetTradingContext(
      userId,
      new Date(),
    );
    const pricedAssets = await this.buildAssetsWithPrices(
      [asset],
      tradingContext,
    );
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

    if (!asset) {
      this.throwApiError(
        HttpStatus.NOT_FOUND,
        'ASSET_NOT_FOUND',
        'Asset not found.',
      );
    }

    const pricedAssets = await this.buildAssetsWithPrices([asset], null);
    const price = pricedAssets.assets[0]?.price;
    if (!price || price.state === 'unavailable') {
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
        isActive: true,
      },
      select: this.assetSelect(),
    });

    if (!asset) {
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
        id: asset.id,
        symbol: asset.symbol,
        name: asset.name,
        assetType: asset.assetType,
        market: asset.market,
        priceCurrency: this.getAssetPriceCurrency(asset),
      },
      price: price.payload,
    };
  }

  private async buildAssetsWithPrices(
    assets: readonly AssetRecord[],
    tradingContext: AssetTradingContext | null,
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

    const valuationAt = new Date();
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
        );

        return {
          asset: {
            ...this.formatAssetMetadata(
              asset,
              this.buildTradingUx(asset, price.payload, tradingContext),
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

  private async buildAssetTradingContext(
    userId: string,
    now: Date,
  ): Promise<AssetTradingContext> {
    const season = await this.findCurrentSeason();
    const participant = season
      ? await this.prisma.seasonParticipant.findUnique({
          where: {
            seasonId_userId: {
              seasonId: season.id,
              userId,
            },
          },
          select: {
            id: true,
          },
        })
      : null;

    return {
      now,
      season,
      joined: Boolean(participant),
    };
  }

  private async findCurrentSeason(): Promise<AssetSeason | null> {
    for (const status of CURRENT_SEASON_STATUS_PRIORITY) {
      const season = await this.prisma.season.findFirst({
        where: {
          status,
        },
        select: {
          id: true,
          status: true,
          startAt: true,
          endAt: true,
        },
        orderBy: this.getSeasonOrderBy(status),
      });

      if (season) {
        return season;
      }
    }

    return null;
  }

  private getSeasonOrderBy(
    status: SeasonStatus,
  ): Prisma.SeasonFindFirstArgs['orderBy'] {
    switch (status) {
      case SeasonStatus.upcoming:
        return [{ startAt: 'asc' }, { createdAt: 'asc' }];
      case SeasonStatus.ended:
      case SeasonStatus.settled:
        return [{ endAt: 'desc' }, { createdAt: 'desc' }];
      case SeasonStatus.active:
      default:
        return [{ startAt: 'desc' }, { createdAt: 'desc' }];
    }
  }

  private async buildAssetPrice(
    asset: AssetRecord,
    valuationAt: Date,
    usdKrwSelection: UsdKrwSelection | null,
  ): Promise<{
    payload: AssetPricePayload;
    error?: AssetPriceError;
  }> {
    const snapshot = await this.findLatestEligibleAssetPriceSnapshot(
      asset,
      valuationAt,
    );

    if (!snapshot) {
      const message = `Asset price snapshot is unavailable for asset ${asset.id}.`;

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
        },
      };
    }

    const basePayload = {
      state: 'available' as const,
      currentPrice: this.formatDecimal(snapshot.price, 8),
      changeRate: await this.calculateChangeRate(asset, snapshot),
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
      },
    };
  }

  private async calculateChangeRate(
    asset: AssetRecord,
    snapshot: AssetPriceSnapshotRecord,
  ): Promise<string | null> {
    void asset;
    void snapshot;
    return null;
  }

  private async findLatestEligibleAssetPriceSnapshot(
    asset: AssetRecord,
    valuationAt: Date,
  ): Promise<AssetPriceSnapshotRecord | null> {
    const providerEligibility = resolveAssetProviderEligibility({
      workflow: 'assets_with_price',
      asset: {
        id: asset.id,
        assetType: asset.assetType,
        market: asset.market,
        currencyCode: this.getAssetPriceCurrency(asset),
      },
    });
    const providerCandidates = providerEligibility.eligible
      ? ((await this.prisma.assetPriceSnapshot.findMany({
          where: {
            assetId: asset.id,
            currencyCode: this.getAssetPriceCurrency(asset),
            sourceType: AssetPriceSourceType.provider_api,
          },
          orderBy: [
            { effectiveAt: 'desc' },
            { capturedAt: 'desc' },
            { createdAt: 'desc' },
          ],
          take: 10,
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
        })) ?? [])
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
        ...providerSelection.snapshot,
        sourceDecision: providerSelection.decision,
      };
    }

    const fallbackSnapshot = await this.prisma.assetPriceSnapshot.findFirst({
      where: {
        assetId: asset.id,
        currencyCode: this.getAssetPriceCurrency(asset),
        sourceType: AssetPriceSourceType.admin_manual,
        effectiveAt: {
          lte: valuationAt,
        },
        price: {
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
      return null;
    }

    return {
      ...fallbackSnapshot,
      sourceDecision: buildAdminManualFallbackDecision({
        selectedSnapshotId: fallbackSnapshot.id,
        selectedSourceName: fallbackSnapshot.sourceName,
        selectedEffectiveAt: fallbackSnapshot.effectiveAt,
        selectedCapturedAt: fallbackSnapshot.capturedAt,
        providerDecision: providerSelection.decision,
      }),
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
      ? ((await this.prisma.fxRateSnapshot.findMany({
          where: {
            baseCurrency: CurrencyCode.USD,
            quoteCurrency: CurrencyCode.KRW,
            sourceType: FxRateSourceType.provider_api,
          },
          orderBy: [
            { effectiveAt: 'desc' },
            { capturedAt: 'desc' },
            { createdAt: 'desc' },
          ],
          take: 10,
          select: {
            id: true,
            rate: true,
            sourceType: true,
            sourceName: true,
            effectiveAt: true,
            capturedAt: true,
          },
        })) ?? [])
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

    if (!snapshot) {
      return {
        state: 'unavailable',
        code: 'FX_RATE_UNAVAILABLE',
        message: 'USD/KRW FX rate snapshot is unavailable.',
        sourceDecision: providerSelection.decision,
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
    return {
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
    };
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
    context: AssetTradingContext | null,
  ): AssetTradingUx {
    const marketStatus = this.resolveMarketStatus(asset, context?.now);
    const blockedReason = this.resolveTradeBlockedReason(
      asset,
      price,
      marketStatus,
      context,
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
    context: AssetTradingContext | null,
  ): TradeBlockedReason | null {
    if (!asset.isActive) {
      return 'ASSET_INACTIVE';
    }

    if (
      !context?.season ||
      !isSeasonCurrentlyActive(context.season, context.now)
    ) {
      return 'SEASON_NOT_ACTIVE';
    }

    if (!context.joined) {
      return 'SEASON_NOT_JOINED';
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
    throw new HttpException(this.createErrorBody(code, message), status);
  }
}
