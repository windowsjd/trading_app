import { Injectable } from '@nestjs/common';
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
  buildAdminManualFallbackDecision,
  FX_USD_KRW_PROVIDER_SOURCE_PRIORITY,
  isPositiveDecimal,
  resolveAssetProviderEligibility,
  resolveFxProviderEligibility,
  selectFreshProviderSnapshotBySourcePriority,
  type SourceDecision,
} from './source-eligibility.policy';
import {
  ProviderTargetResolverService,
  type ProviderTargetSource,
  type ProviderTargets,
} from './provider-target-resolver.service';

export type MarketSnapshotHealthReason =
  | 'NO_PROVIDER_TARGET'
  | 'PROVIDER_MISSING'
  | 'SOURCE_NAME_MISMATCH'
  | 'CAPTURED_AT_STALE'
  | 'EFFECTIVE_AT_IN_FUTURE'
  | 'CAPTURED_AT_IN_FUTURE'
  | 'NON_POSITIVE_VALUE'
  | 'FX_RATE_UNAVAILABLE'
  | 'FX_RATE_STALE'
  | 'ASSET_PRICE_UNAVAILABLE'
  | 'ASSET_MAPPING_NOT_FOUND'
  | 'ASSET_MAPPING_AMBIGUOUS'
  | 'PROVIDER_RUN_FAILED';

export type MarketSnapshotAssetHealth = {
  assetId: string;
  symbol: string;
  assetType: AssetType;
  market: string;
  priceCurrency: CurrencyCode;
  state: 'available' | 'unavailable';
  reason: MarketSnapshotHealthReason | null;
  message: string | null;
  sourceType: string | null;
  sourceName: string | null;
  snapshotId: string | null;
  capturedAt: string | null;
  freshnessAgeSeconds: number | null;
  priceKrwState: 'available' | 'unavailable' | 'not_required';
};

export type MarketSnapshotFxHealth =
  | {
      state: 'available';
      required: boolean;
      sourceType: string | null;
      sourceName: string | null;
      snapshotId: string | null;
      capturedAt: string | null;
      freshnessAgeSeconds: number | null;
      reason: null;
    }
  | {
      state: 'unavailable' | 'not_required';
      required: boolean;
      sourceType: string | null;
      sourceName: string | null;
      snapshotId: string | null;
      capturedAt: string | null;
      freshnessAgeSeconds: number | null;
      reason: MarketSnapshotHealthReason | null;
    };

export type MarketSnapshotHealthResult = {
  status: 'pass' | 'fail';
  checkedAt: string;
  targetSummary: {
    targetSource: ProviderTargetSource;
    activeAssetCount: number;
    binanceSymbolCount: number;
    kisDomesticSymbolCount: number;
    kisUsSymbolCount: number;
    unsupportedAssets: ProviderTargets['unsupportedAssets'];
  };
  snapshotCounts: {
    assetPriceSnapshotsTotal: number;
    fxRateSnapshotsTotal: number;
  };
  coverage: {
    activeAssets: number;
    priceAvailable: number;
    priceUnavailable: number;
  };
  fxUsdKrw: MarketSnapshotFxHealth;
  assets: MarketSnapshotAssetHealth[];
  unavailableAssets: MarketSnapshotAssetHealth[];
};

type HealthAssetRecord = {
  id: string;
  symbol: string;
  assetType: AssetType;
  market: string;
  currencyCode: CurrencyCode;
  priceCurrency: CurrencyCode | null;
};

type AssetPriceCandidate = {
  id: string;
  price: Prisma.Decimal;
  priceKrw: Prisma.Decimal | null;
  currencyCode: CurrencyCode;
  sourceType: AssetPriceSourceType;
  sourceName: string | null;
  effectiveAt: Date;
  capturedAt: Date;
};

type FxRateCandidate = {
  id: string;
  rate: Prisma.Decimal;
  sourceType: FxRateSourceType;
  sourceName: string | null;
  effectiveAt: Date;
  capturedAt: Date;
  approvedByUserId?: string | null;
};

@Injectable()
export class MarketSnapshotHealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly providerTargetResolver: ProviderTargetResolverService,
  ) {}

  async checkActiveAssetCoverage(
    input: {
      now?: Date;
      targetSource?: ProviderTargetSource;
    } = {},
  ): Promise<MarketSnapshotHealthResult> {
    const now = input.now ?? new Date();
    const [targets, assets, snapshotCounts] = await Promise.all([
      this.providerTargetResolver.resolveProviderTargets({
        targetSource: input.targetSource,
      }),
      this.findActiveAssets(),
      this.readSnapshotCounts(),
    ]);
    const needsUsdKrw = assets.some(
      (asset) => getAssetPriceCurrency(asset) === CurrencyCode.USD,
    );
    const fxUsdKrw = await this.evaluateUsdKrwHealth(now, needsUsdKrw);
    const assetHealth = await Promise.all(
      assets.map((asset) => this.evaluateAssetHealth(asset, now, fxUsdKrw)),
    );
    const unavailableAssets = assetHealth.filter(
      (asset) => asset.state === 'unavailable',
    );
    const status =
      unavailableAssets.length > 0 ||
      (fxUsdKrw.required && fxUsdKrw.state !== 'available')
        ? 'fail'
        : 'pass';

    return {
      status,
      checkedAt: now.toISOString(),
      targetSummary: {
        targetSource: targets.targetSource,
        activeAssetCount: targets.activeAssetCount,
        binanceSymbolCount: targets.binanceSymbols.length,
        kisDomesticSymbolCount: targets.kisDomesticSymbols.length,
        kisUsSymbolCount: targets.kisUsSymbols.length,
        unsupportedAssets: targets.unsupportedAssets,
      },
      snapshotCounts,
      coverage: {
        activeAssets: assets.length,
        priceAvailable: assetHealth.length - unavailableAssets.length,
        priceUnavailable: unavailableAssets.length,
      },
      fxUsdKrw,
      assets: assetHealth,
      unavailableAssets,
    };
  }

  private findActiveAssets() {
    return this.prisma.asset.findMany({
      where: {
        isActive: true,
      },
      orderBy: [{ symbol: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        symbol: true,
        assetType: true,
        market: true,
        currencyCode: true,
        priceCurrency: true,
      },
    });
  }

  private async readSnapshotCounts() {
    const [assetPriceSnapshotsTotal, fxRateSnapshotsTotal] = await Promise.all([
      this.prisma.assetPriceSnapshot.count(),
      this.prisma.fxRateSnapshot.count(),
    ]);

    return {
      assetPriceSnapshotsTotal,
      fxRateSnapshotsTotal,
    };
  }

  private async evaluateAssetHealth(
    asset: HealthAssetRecord,
    now: Date,
    fxUsdKrw: MarketSnapshotFxHealth,
  ): Promise<MarketSnapshotAssetHealth> {
    const priceCurrency = getAssetPriceCurrency(asset);
    const providerEligibility = resolveAssetProviderEligibility({
      workflow: 'assets_with_price',
      asset: {
        id: asset.id,
        assetType: asset.assetType,
        market: asset.market,
        currencyCode: priceCurrency,
      },
    });
    const providerCandidates = providerEligibility.eligible
      ? await this.prisma.assetPriceSnapshot.findMany({
          where: {
            assetId: asset.id,
            currencyCode: priceCurrency,
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
        })
      : [];
    const providerSelection = providerEligibility.eligible
      ? selectFreshProviderSnapshotBySourcePriority({
          candidates: providerCandidates,
          expectedSourceNames: providerEligibility.sourceNames,
          now,
          freshnessThresholdSeconds:
            providerEligibility.freshnessThresholdSeconds,
          isPositiveValue: (candidate) => isPositiveDecimal(candidate.price),
        })
      : {
          state: 'not_selected' as const,
          decision: emptyDecision(
            providerEligibility.reason === 'asset_ineligible'
              ? 'asset_ineligible'
              : providerEligibility.reason,
          ),
        };

    if (providerSelection.state === 'selected') {
      return this.availableAssetHealth({
        asset,
        snapshot: providerSelection.snapshot,
        decision: providerSelection.decision,
        fxUsdKrw,
      });
    }

    const fallbackSnapshot = await this.prisma.assetPriceSnapshot.findFirst({
      where: {
        assetId: asset.id,
        currencyCode: priceCurrency,
        sourceType: AssetPriceSourceType.admin_manual,
        effectiveAt: {
          lte: now,
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

    if (fallbackSnapshot) {
      return this.availableAssetHealth({
        asset,
        snapshot: fallbackSnapshot,
        decision: buildAdminManualFallbackDecision({
          selectedSnapshotId: fallbackSnapshot.id,
          selectedSourceName: fallbackSnapshot.sourceName,
          selectedEffectiveAt: fallbackSnapshot.effectiveAt,
          selectedCapturedAt: fallbackSnapshot.capturedAt,
          providerDecision: providerSelection.decision,
        }),
        fxUsdKrw,
      });
    }

    const reason = reasonFromSourceDecision(providerSelection.decision);
    return {
      assetId: asset.id,
      symbol: asset.symbol,
      assetType: asset.assetType,
      market: asset.market,
      priceCurrency,
      state: 'unavailable',
      reason,
      message: `Asset price snapshot is unavailable for active asset ${asset.id}.`,
      sourceType: null,
      sourceName: null,
      snapshotId: null,
      capturedAt: null,
      freshnessAgeSeconds: providerSelection.decision.freshnessAgeSeconds,
      priceKrwState:
        priceCurrency === CurrencyCode.USD ? 'unavailable' : 'not_required',
    };
  }

  private availableAssetHealth(input: {
    asset: HealthAssetRecord;
    snapshot: AssetPriceCandidate;
    decision: SourceDecision;
    fxUsdKrw: MarketSnapshotFxHealth;
  }): MarketSnapshotAssetHealth {
    const priceCurrency = getAssetPriceCurrency(input.asset);
    const priceKrwState =
      priceCurrency === CurrencyCode.KRW || input.snapshot.priceKrw
        ? 'available'
        : input.fxUsdKrw.state === 'available'
          ? 'available'
          : 'unavailable';

    return {
      assetId: input.asset.id,
      symbol: input.asset.symbol,
      assetType: input.asset.assetType,
      market: input.asset.market,
      priceCurrency,
      state: 'available',
      reason: null,
      message: null,
      sourceType: input.snapshot.sourceType,
      sourceName: input.snapshot.sourceName,
      snapshotId: input.snapshot.id,
      capturedAt: input.snapshot.capturedAt.toISOString(),
      freshnessAgeSeconds: input.decision.freshnessAgeSeconds,
      priceKrwState,
    };
  }

  private async evaluateUsdKrwHealth(
    now: Date,
    required: boolean,
  ): Promise<MarketSnapshotFxHealth> {
    if (!required) {
      return {
        state: 'not_required',
        required,
        sourceType: null,
        sourceName: null,
        snapshotId: null,
        capturedAt: null,
        freshnessAgeSeconds: null,
        reason: null,
      };
    }

    const providerEligibility = resolveFxProviderEligibility({
      workflow: 'assets_with_price',
      baseCurrency: CurrencyCode.USD,
      quoteCurrency: CurrencyCode.KRW,
    });
    const providerCandidates = providerEligibility.eligible
      ? await this.prisma.fxRateSnapshot.findMany({
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
        })
      : [];
    const providerSelection = providerEligibility.eligible
      ? selectFreshProviderSnapshotBySourcePriority({
          candidates: providerCandidates,
          expectedSourceNames: FX_USD_KRW_PROVIDER_SOURCE_PRIORITY,
          now,
          freshnessThresholdSeconds:
            providerEligibility.freshnessThresholdSeconds,
          isPositiveValue: (candidate) => isPositiveDecimal(candidate.rate),
        })
      : {
          state: 'not_selected' as const,
          decision: emptyDecision(providerEligibility.reason),
        };

    if (providerSelection.state === 'selected') {
      return availableFxHealth(providerSelection.snapshot, {
        required,
        freshnessAgeSeconds: providerSelection.decision.freshnessAgeSeconds,
      });
    }

    const fallbackSnapshot = await this.prisma.fxRateSnapshot.findFirst({
      where: {
        baseCurrency: CurrencyCode.USD,
        quoteCurrency: CurrencyCode.KRW,
        sourceType: FxRateSourceType.admin_manual,
        approvedByUserId: {
          not: null,
        },
        effectiveAt: {
          lte: now,
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

    if (!fallbackSnapshot) {
      return unavailableFxHealth({
        required,
        reason: reasonFromSourceDecision(providerSelection.decision),
        decision: providerSelection.decision,
      });
    }

    if (
      fallbackSnapshot.sourceType !== FxRateSourceType.admin_manual ||
      !fallbackSnapshot.approvedByUserId
    ) {
      return unavailableFxHealth({
        required,
        reason: 'FX_RATE_UNAVAILABLE',
        snapshot: fallbackSnapshot,
      });
    }

    if (
      isFxSnapshotStaleForPortfolioValuation(fallbackSnapshot.effectiveAt, now)
    ) {
      return unavailableFxHealth({
        required,
        reason: 'FX_RATE_STALE',
        snapshot: fallbackSnapshot,
      });
    }

    return availableFxHealth(fallbackSnapshot, {
      required,
      freshnessAgeSeconds: null,
    });
  }
}

function availableFxHealth(
  snapshot: FxRateCandidate,
  input: {
    required: boolean;
    freshnessAgeSeconds: number | null;
  },
): MarketSnapshotFxHealth {
  return {
    state: 'available',
    required: input.required,
    sourceType: snapshot.sourceType,
    sourceName: snapshot.sourceName,
    snapshotId: snapshot.id,
    capturedAt: snapshot.capturedAt.toISOString(),
    freshnessAgeSeconds: input.freshnessAgeSeconds,
    reason: null,
  };
}

function unavailableFxHealth(input: {
  required: boolean;
  reason: MarketSnapshotHealthReason;
  decision?: SourceDecision;
  snapshot?: FxRateCandidate;
}): MarketSnapshotFxHealth {
  return {
    state: 'unavailable',
    required: input.required,
    sourceType: input.snapshot?.sourceType ?? null,
    sourceName: input.snapshot?.sourceName ?? null,
    snapshotId: input.snapshot?.id ?? null,
    capturedAt: input.snapshot?.capturedAt.toISOString() ?? null,
    freshnessAgeSeconds: input.decision?.freshnessAgeSeconds ?? null,
    reason: input.reason,
  };
}

function getAssetPriceCurrency(asset: HealthAssetRecord): CurrencyCode {
  return asset.priceCurrency ?? asset.currencyCode;
}

function reasonFromSourceDecision(
  decision: SourceDecision,
): MarketSnapshotHealthReason {
  const reason = decision.rejectedProviderReason ?? decision.fallbackReason;
  switch (reason) {
    case 'asset_ineligible':
    case 'workflow_ineligible':
      return 'NO_PROVIDER_TARGET';
    case 'provider_missing':
      return 'PROVIDER_MISSING';
    case 'source_name_mismatch':
      return 'SOURCE_NAME_MISMATCH';
    case 'captured_at_stale':
      return 'CAPTURED_AT_STALE';
    case 'effective_at_in_future':
      return 'EFFECTIVE_AT_IN_FUTURE';
    case 'captured_at_in_future':
      return 'CAPTURED_AT_IN_FUTURE';
    case 'non_positive_value':
      return 'NON_POSITIVE_VALUE';
    case 'ASSET_MAPPING_NOT_FOUND':
      return 'ASSET_MAPPING_NOT_FOUND';
    case 'ASSET_MAPPING_AMBIGUOUS':
      return 'ASSET_MAPPING_AMBIGUOUS';
    case 'PROVIDER_RUN_FAILED':
      return 'PROVIDER_RUN_FAILED';
    default:
      return 'ASSET_PRICE_UNAVAILABLE';
  }
}

function emptyDecision(reason: string): SourceDecision {
  return {
    selectedSourceType: null,
    selectedSourceName: null,
    selectedSnapshotId: null,
    selectedEffectiveAt: null,
    selectedCapturedAt: null,
    fallbackUsed: true,
    fallbackReason: reason,
    rejectedProviderReason: null,
    freshnessAgeSeconds: null,
  };
}
