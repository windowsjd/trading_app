import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  AssetPriceSourceType,
  AssetType,
  CurrencyCode,
  FxRateSourceType,
  ParticipantStatus,
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
  selectFreshProviderSnapshot,
  selectFreshProviderSnapshotBySourcePriority,
  type SourceDecision,
} from '../providers/source-eligibility.policy';
import {
  presentSourceDecision,
  type PublicSourceMetadata,
} from '../providers/source-metadata.presenter';
import { buildPagination, type Pagination } from '../common/pagination';

export type PositionsQuery = {
  seasonId?: string;
  includeClosed?: string;
  limit?: string;
  offset?: string;
  assetType?: string;
  currencyCode?: string;
  assetId?: string;
};

type PositionsState = 'available' | 'not_joined' | 'unavailable';

type PositionsSeason = {
  id: string;
  name: string;
  status: SeasonStatus;
  startAt: Date;
  endAt: Date;
};

type PositionsParticipant = {
  id: string;
  participantStatus: ParticipantStatus;
  joinedAt: Date;
};

type ParsedPositionsQuery = {
  seasonId?: string;
  includeClosed: boolean;
  limit: number;
  offset: number;
  assetType?: AssetType;
  currencyCode?: CurrencyCode;
  assetId?: string;
};

type PositionRecord = {
  id: string;
  assetId: string;
  quantity: Prisma.Decimal;
  averageCost: Prisma.Decimal;
  currencyCode: CurrencyCode;
  realizedPnl: Prisma.Decimal;
  realizedPnlKrw: Prisma.Decimal;
  currentPriceLocal: Prisma.Decimal | null;
  currentPriceKrw: Prisma.Decimal | null;
  marketValueLocal: Prisma.Decimal | null;
  marketValueKrw: Prisma.Decimal | null;
  unrealizedPnlLocal: Prisma.Decimal | null;
  unrealizedPnlKrw: Prisma.Decimal | null;
  asset: {
    id: string;
    symbol: string;
    name: string;
    market: string;
    assetType: AssetType;
    currencyCode: CurrencyCode;
    priceCurrency: CurrencyCode;
    settlementCurrency: CurrencyCode;
  };
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

type PositionValuation =
  | {
      state: 'available';
      sortValueKrw: Prisma.Decimal;
      payload: {
        state: 'available';
        currentPrice: string;
        priceCurrency: CurrencyCode;
        assetPriceSnapshotId: string;
        priceEffectiveAt: string;
        priceCapturedAt: string;
        priceSource: PublicSourceMetadata | null;
        fxRateSource?: PublicSourceMetadata | null;
        positionValue: string;
        positionValueKrw: string;
        unrealizedPnl: string;
        unrealizedPnlKrw: string;
        returnRate: string;
      };
    }
  | {
      state: 'unavailable';
      sortValueKrw: null;
      error: {
        code:
          | 'ASSET_PRICE_UNAVAILABLE'
          | 'FX_RATE_UNAVAILABLE'
          | 'FX_RATE_STALE';
        message: string;
      };
      payload: {
        state: 'unavailable';
        reason: string;
        message: string;
        fxRateSource?: PublicSourceMetadata | null;
      };
    };

type PositionItemWithSort = {
  positionId: string;
  assetId: string;
  symbol: string;
  name: string;
  market: string;
  assetType: AssetType;
  currencyCode: CurrencyCode;
  quantity: string;
  averageCost: string;
  realizedPnl: string;
  realizedPnlKrw: string;
  quantitySortValue: Prisma.Decimal;
  valuation: PositionValuation;
};

type PositionsResponse = {
  success: true;
  data: {
    state: PositionsState;
    season: ReturnType<PositionsService['formatSeason']> | null;
    participant: ReturnType<PositionsService['formatParticipant']> | null;
    filters: ReturnType<PositionsService['formatFilters']>;
    pagination: Pagination;
    positions: Array<
      Omit<PositionItemWithSort, 'quantitySortValue' | 'valuation'> & {
        valuation: PositionValuation['payload'];
      }
    >;
    summary: {
      openPositionsCount: number;
      totalPositionsCount: number;
      valuedPositionsCount: number;
      unavailableValuationsCount: number;
      totalPositionValueKrw: string;
    };
    valuationErrors: Array<{
      positionId: string;
      assetId: string;
      code: string;
      message: string;
    }>;
    reason?: string;
    message?: string;
  };
};

class PositionValuationError extends Error {
  constructor(
    readonly code:
      | 'ASSET_PRICE_UNAVAILABLE'
      | 'FX_RATE_UNAVAILABLE'
      | 'FX_RATE_STALE',
    message: string,
    readonly sourceDecision?: SourceDecision,
  ) {
    super(message);
  }
}

const CURRENT_SEASON_STATUS_PRIORITY: readonly SeasonStatus[] = [
  SeasonStatus.active,
  SeasonStatus.upcoming,
  SeasonStatus.ended,
  SeasonStatus.settled,
];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

@Injectable()
export class PositionsService {
  constructor(private readonly prisma: PrismaService) {}

  async getPositions(
    userId: string | undefined,
    query: PositionsQuery = {},
  ): Promise<PositionsResponse> {
    if (!userId) {
      this.throwApiError(
        HttpStatus.UNAUTHORIZED,
        'UNAUTHORIZED',
        'Unauthorized',
      );
    }

    const parsedQuery = this.parseQuery(query);
    const season = parsedQuery.seasonId
      ? await this.findSeasonById(parsedQuery.seasonId)
      : await this.findCurrentSeason();

    if (!season) {
      return this.emptyResponse({
        state: 'unavailable',
        season: null,
        participant: null,
        query: parsedQuery,
        reason: parsedQuery.seasonId
          ? 'SEASON_NOT_FOUND'
          : 'CURRENT_SEASON_NOT_FOUND',
        message: parsedQuery.seasonId
          ? 'Season not found.'
          : 'Current season is not configured.',
      });
    }

    const participant = await this.findParticipant(season.id, userId);
    if (!participant) {
      return this.emptyResponse({
        state: 'not_joined',
        season,
        participant: null,
        query: parsedQuery,
        reason: 'SEASON_NOT_JOINED',
        message: 'Positions are available after joining the season.',
      });
    }

    const valuationAt = new Date();
    const positions = await this.findPositions(participant.id, parsedQuery);
    const usdKrwSelection = await this.findUsdKrwSelectionIfNeeded(
      positions,
      valuationAt,
    );
    const items = await Promise.all(
      positions.map((position) =>
        this.buildPositionItem(position, valuationAt, usdKrwSelection),
      ),
    );
    const sortedItems = items.sort((left, right) =>
      this.comparePositionItems(left, right),
    );
    const paginatedItems = sortedItems.slice(
      parsedQuery.offset,
      parsedQuery.offset + parsedQuery.limit,
    );

    return {
      success: true,
      data: {
        state: 'available',
        season: this.formatSeason(season),
        participant: this.formatParticipant(participant),
        filters: this.formatFilters(parsedQuery),
        pagination: this.pagination(
          parsedQuery,
          sortedItems.length,
          paginatedItems.length,
        ),
        positions: paginatedItems.map((item) => this.formatPositionItem(item)),
        summary: this.buildSummary(sortedItems),
        valuationErrors: this.buildValuationErrors(sortedItems),
      },
    };
  }

  private async buildPositionItem(
    position: PositionRecord,
    valuationAt: Date,
    usdKrwSelection: UsdKrwSelection | null,
  ): Promise<PositionItemWithSort> {
    const valuation = await this.buildValuation(
      position,
      valuationAt,
      usdKrwSelection,
    );

    return {
      positionId: position.id,
      assetId: position.assetId,
      symbol: position.asset.symbol,
      name: position.asset.name,
      market: position.asset.market,
      assetType: position.asset.assetType,
      currencyCode: position.currencyCode,
      quantity: this.formatDecimal(position.quantity, 8),
      averageCost: this.formatDecimal(position.averageCost, 8),
      realizedPnl: this.formatDecimal(position.realizedPnl, 8),
      realizedPnlKrw: this.formatDecimal(position.realizedPnlKrw, 8),
      quantitySortValue: position.quantity,
      valuation,
    };
  }

  private async buildValuation(
    position: PositionRecord,
    valuationAt: Date,
    usdKrwSelection: UsdKrwSelection | null,
  ): Promise<PositionValuation> {
    try {
      if (
        this.getAssetSettlementCurrency(position.asset) !==
        position.currencyCode
      ) {
        throw new PositionValuationError(
          'ASSET_PRICE_UNAVAILABLE',
          `Position currency mismatch for asset ${position.assetId}.`,
        );
      }

      const priceSnapshot = await this.findLatestEligibleAssetPriceSnapshot(
        position.asset,
        this.getAssetPriceCurrency(position.asset),
        valuationAt,
      );

      if (
        position.currencyCode === CurrencyCode.USD &&
        usdKrwSelection?.state === 'unavailable'
      ) {
        throw new PositionValuationError(
          usdKrwSelection.code,
          usdKrwSelection.message,
          usdKrwSelection.sourceDecision,
        );
      }

      const quantity = position.quantity;
      const averageCost = position.averageCost;
      const currentPrice = priceSnapshot.price;
      const positionValue = quantity.mul(currentPrice);
      const positionValueKrw = priceSnapshot.priceKrw
        ? quantity.mul(priceSnapshot.priceKrw)
        : this.convertToKrw(
            positionValue,
            position.currencyCode,
            usdKrwSelection,
          );
      const unrealizedPnl = currentPrice.sub(averageCost).mul(quantity);
      const unrealizedPnlKrw = this.convertToKrw(
        unrealizedPnl,
        position.currencyCode,
        usdKrwSelection,
      );
      const returnRate = averageCost.eq(0)
        ? new Prisma.Decimal(0)
        : currentPrice.sub(averageCost).div(averageCost).mul(100);

      return {
        state: 'available',
        sortValueKrw: positionValueKrw,
        payload: {
          state: 'available',
          currentPrice: this.formatDecimal(currentPrice, 8),
          priceCurrency: priceSnapshot.currencyCode,
          assetPriceSnapshotId: priceSnapshot.id,
          priceEffectiveAt: priceSnapshot.effectiveAt.toISOString(),
          priceCapturedAt: priceSnapshot.capturedAt.toISOString(),
          priceSource: presentSourceDecision(priceSnapshot.sourceDecision),
          ...(position.currencyCode === CurrencyCode.USD &&
          usdKrwSelection?.state === 'available'
            ? {
                fxRateSource: presentSourceDecision(
                  usdKrwSelection.sourceDecision,
                ),
              }
            : {}),
          positionValue: this.formatDecimal(positionValue, 8),
          positionValueKrw: this.formatDecimal(positionValueKrw, 8),
          unrealizedPnl: this.formatDecimal(unrealizedPnl, 8),
          unrealizedPnlKrw: this.formatDecimal(unrealizedPnlKrw, 8),
          returnRate: this.formatDecimal(returnRate, 8),
        },
      };
    } catch (error) {
      const valuationError =
        error instanceof PositionValuationError
          ? error
          : new PositionValuationError(
              'ASSET_PRICE_UNAVAILABLE',
              'Position valuation is unavailable.',
            );
      const cachedValuation = this.buildCachedValuation(position);
      if (cachedValuation) {
        return cachedValuation;
      }

      return {
        state: 'unavailable',
        sortValueKrw: null,
        error: {
          code: valuationError.code,
          message: valuationError.message,
        },
        payload: {
          state: 'unavailable',
          reason: valuationError.code,
          message: valuationError.message,
          ...(valuationError.sourceDecision
            ? {
                fxRateSource: presentSourceDecision(
                  valuationError.sourceDecision,
                ),
              }
            : {}),
        },
      };
    }
  }

  private buildCachedValuation(
    position: PositionRecord,
  ): PositionValuation | null {
    if (
      !position.currentPriceLocal ||
      !position.currentPriceKrw ||
      !position.marketValueLocal ||
      !position.marketValueKrw ||
      !position.unrealizedPnlLocal ||
      !position.unrealizedPnlKrw
    ) {
      return null;
    }

    const returnRate = position.averageCost.eq(0)
      ? new Prisma.Decimal(0)
      : position.currentPriceLocal
          .sub(position.averageCost)
          .div(position.averageCost)
          .mul(100);

    return {
      state: 'available',
      sortValueKrw: position.marketValueKrw,
      payload: {
        state: 'available',
        currentPrice: this.formatDecimal(position.currentPriceLocal, 8),
        priceCurrency: this.getAssetPriceCurrency(position.asset),
        assetPriceSnapshotId: '',
        priceEffectiveAt: '',
        priceCapturedAt: '',
        priceSource: null,
        positionValue: this.formatDecimal(position.marketValueLocal, 8),
        positionValueKrw: this.formatDecimal(position.marketValueKrw, 8),
        unrealizedPnl: this.formatDecimal(position.unrealizedPnlLocal, 8),
        unrealizedPnlKrw: this.formatDecimal(position.unrealizedPnlKrw, 8),
        returnRate: this.formatDecimal(returnRate, 8),
      },
    };
  }

  private async findLatestEligibleAssetPriceSnapshot(
    asset: PositionRecord['asset'],
    currencyCode: CurrencyCode,
    valuationAt: Date,
  ): Promise<AssetPriceSnapshotRecord> {
    const providerEligibility = resolveAssetProviderEligibility({
      workflow: 'positions_live_valuation',
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
            currencyCode,
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
      ? selectFreshProviderSnapshot({
          candidates: providerCandidates,
          expectedSourceName: providerEligibility.sourceName,
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

    const snapshot = await this.prisma.assetPriceSnapshot.findFirst({
      where: {
        assetId: asset.id,
        currencyCode,
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

    if (!snapshot) {
      throw new PositionValuationError(
        'ASSET_PRICE_UNAVAILABLE',
        `Asset price snapshot is unavailable for asset ${asset.id}.`,
      );
    }

    const sourceDecision = buildAdminManualFallbackDecision({
      selectedSnapshotId: snapshot.id,
      selectedSourceName: snapshot.sourceName,
      selectedEffectiveAt: snapshot.effectiveAt,
      selectedCapturedAt: snapshot.capturedAt,
      providerDecision: providerSelection.decision,
    });

    return {
      ...snapshot,
      sourceDecision,
    };
  }

  private async findUsdKrwSelectionIfNeeded(
    positions: readonly PositionRecord[],
    valuationAt: Date,
  ): Promise<UsdKrwSelection | null> {
    const needsUsdKrw = positions.some(
      (position) => position.currencyCode === CurrencyCode.USD,
    );
    if (!needsUsdKrw) {
      return null;
    }

    const providerEligibility = resolveFxProviderEligibility({
      workflow: 'positions_live_valuation',
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
            approvedByUserId: true,
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

  private convertToKrw(
    amount: Prisma.Decimal,
    currencyCode: CurrencyCode,
    usdKrwSelection: UsdKrwSelection | null,
  ): Prisma.Decimal {
    if (currencyCode === CurrencyCode.KRW) {
      return amount;
    }

    if (usdKrwSelection?.state !== 'available') {
      throw new PositionValuationError(
        'FX_RATE_UNAVAILABLE',
        'USD/KRW FX rate snapshot is required for USD conversion.',
      );
    }

    return amount.mul(usdKrwSelection.rate);
  }

  private comparePositionItems(
    left: PositionItemWithSort,
    right: PositionItemWithSort,
  ) {
    if (
      left.valuation.state === 'available' &&
      right.valuation.state !== 'available'
    ) {
      return -1;
    }

    if (
      left.valuation.state !== 'available' &&
      right.valuation.state === 'available'
    ) {
      return 1;
    }

    if (
      left.valuation.state === 'available' &&
      right.valuation.state === 'available'
    ) {
      if (right.valuation.sortValueKrw.gt(left.valuation.sortValueKrw)) {
        return 1;
      }

      if (right.valuation.sortValueKrw.lt(left.valuation.sortValueKrw)) {
        return -1;
      }
    }

    const symbolComparison = left.symbol.localeCompare(right.symbol);
    if (symbolComparison !== 0) {
      return symbolComparison;
    }

    return left.positionId.localeCompare(right.positionId);
  }

  private buildSummary(items: readonly PositionItemWithSort[]) {
    const totalPositionValueKrw = items.reduce((sum, item) => {
      if (item.valuation.state !== 'available') {
        return sum;
      }

      return sum.add(item.valuation.sortValueKrw);
    }, new Prisma.Decimal(0));

    return {
      openPositionsCount: items.filter((item) => !item.quantitySortValue.eq(0))
        .length,
      totalPositionsCount: items.length,
      valuedPositionsCount: items.filter(
        (item) => item.valuation.state === 'available',
      ).length,
      unavailableValuationsCount: items.filter(
        (item) => item.valuation.state === 'unavailable',
      ).length,
      totalPositionValueKrw: this.formatDecimal(totalPositionValueKrw, 8),
    };
  }

  private buildValuationErrors(items: readonly PositionItemWithSort[]) {
    return items
      .filter(
        (
          item,
        ): item is PositionItemWithSort & {
          valuation: Extract<PositionValuation, { state: 'unavailable' }>;
        } => item.valuation.state === 'unavailable',
      )
      .map((item) => ({
        positionId: item.positionId,
        assetId: item.assetId,
        code: item.valuation.error.code,
        message: item.valuation.error.message,
      }));
  }

  private formatPositionItem(item: PositionItemWithSort) {
    return {
      positionId: item.positionId,
      assetId: item.assetId,
      symbol: item.symbol,
      name: item.name,
      market: item.market,
      assetType: item.assetType,
      currencyCode: item.currencyCode,
      quantity: item.quantity,
      averageCost: item.averageCost,
      realizedPnl: item.realizedPnl,
      realizedPnlKrw: item.realizedPnlKrw,
      valuation: item.valuation.payload,
    };
  }

  private async findPositions(
    seasonParticipantId: string,
    query: ParsedPositionsQuery,
  ): Promise<PositionRecord[]> {
    const where: Prisma.PositionWhereInput = {
      seasonParticipantId,
      ...(query.includeClosed
        ? {}
        : {
            quantity: {
              gt: 0,
            },
          }),
      ...(query.currencyCode ? { currencyCode: query.currencyCode } : {}),
      ...(query.assetId ? { assetId: query.assetId } : {}),
      ...(query.assetType
        ? {
            asset: {
              is: {
                assetType: query.assetType,
              },
            },
          }
        : {}),
    };

    return this.prisma.position.findMany({
      where,
      select: {
        id: true,
        assetId: true,
        quantity: true,
        averageCost: true,
        currencyCode: true,
        realizedPnl: true,
        realizedPnlKrw: true,
        currentPriceLocal: true,
        currentPriceKrw: true,
        marketValueLocal: true,
        marketValueKrw: true,
        unrealizedPnlLocal: true,
        unrealizedPnlKrw: true,
        asset: {
          select: {
            id: true,
            symbol: true,
            name: true,
            market: true,
            assetType: true,
            currencyCode: true,
            priceCurrency: true,
            settlementCurrency: true,
          },
        },
      },
    });
  }

  private parseQuery(query: PositionsQuery): ParsedPositionsQuery {
    return {
      seasonId: this.parseOptionalText(query.seasonId),
      includeClosed: this.parseIncludeClosed(query.includeClosed),
      limit: this.parseLimit(query.limit),
      offset: this.parseOffset(query.offset),
      assetType: this.parseAssetType(query.assetType),
      currencyCode: this.parseCurrencyCode(query.currencyCode),
      assetId: this.parseOptionalText(query.assetId),
    };
  }

  private parseIncludeClosed(value: string | undefined): boolean {
    const text = this.parseOptionalText(value);
    if (!text) {
      return false;
    }

    if (text === 'true') {
      return true;
    }

    if (text === 'false') {
      return false;
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'INVALID_INCLUDE_CLOSED',
      'includeClosed must be true or false.',
    );
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

  private parseOptionalText(value: string | undefined): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }

  private async findCurrentSeason(): Promise<PositionsSeason | null> {
    for (const status of CURRENT_SEASON_STATUS_PRIORITY) {
      const season = await this.prisma.season.findFirst({
        where: {
          status,
        },
        select: {
          id: true,
          name: true,
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

  private async findSeasonById(
    seasonId: string,
  ): Promise<PositionsSeason | null> {
    return this.prisma.season.findUnique({
      where: {
        id: seasonId,
      },
      select: {
        id: true,
        name: true,
        status: true,
        startAt: true,
        endAt: true,
      },
    });
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

  private async findParticipant(
    seasonId: string,
    userId: string,
  ): Promise<PositionsParticipant | null> {
    return this.prisma.seasonParticipant.findUnique({
      where: {
        seasonId_userId: {
          seasonId,
          userId,
        },
      },
      select: {
        id: true,
        participantStatus: true,
        joinedAt: true,
      },
    });
  }

  private emptyResponse(input: {
    state: 'not_joined' | 'unavailable';
    season: PositionsSeason | null;
    participant: PositionsParticipant | null;
    query: ParsedPositionsQuery;
    reason: string;
    message: string;
  }): PositionsResponse {
    return {
      success: true,
      data: {
        state: input.state,
        season: input.season ? this.formatSeason(input.season) : null,
        participant: input.participant
          ? this.formatParticipant(input.participant)
          : null,
        filters: this.formatFilters(input.query),
        pagination: this.pagination(input.query, 0, 0),
        positions: [],
        summary: this.emptySummary(),
        valuationErrors: [],
        reason: input.reason,
        message: input.message,
      },
    };
  }

  private emptySummary() {
    return {
      openPositionsCount: 0,
      totalPositionsCount: 0,
      valuedPositionsCount: 0,
      unavailableValuationsCount: 0,
      totalPositionValueKrw: '0.00000000',
    };
  }

  private pagination(
    query: ParsedPositionsQuery,
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

  private formatSeason(season: PositionsSeason) {
    return {
      id: season.id,
      name: season.name,
      status: season.status,
      startAt: season.startAt.toISOString(),
      endAt: season.endAt.toISOString(),
    };
  }

  private formatParticipant(participant: PositionsParticipant) {
    return {
      id: participant.id,
      status: participant.participantStatus,
      joinedAt: participant.joinedAt.toISOString(),
    };
  }

  private formatFilters(query: ParsedPositionsQuery) {
    return {
      includeClosed: query.includeClosed,
      assetType: query.assetType ?? null,
      currencyCode: query.currencyCode ?? null,
      assetId: query.assetId ?? null,
    };
  }

  private getAssetPriceCurrency(
    asset: Pick<PositionRecord['asset'], 'currencyCode'> & {
      priceCurrency?: CurrencyCode | null;
    },
  ): CurrencyCode {
    return asset.priceCurrency ?? asset.currencyCode;
  }

  private getAssetSettlementCurrency(
    asset: Pick<PositionRecord['asset'], 'currencyCode'> & {
      settlementCurrency?: CurrencyCode | null;
    },
  ): CurrencyCode {
    return asset.settlementCurrency ?? asset.currencyCode;
  }

  private formatDecimal(value: Prisma.Decimal, scale: number) {
    return value.toFixed(scale);
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
