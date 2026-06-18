import { Injectable } from '@nestjs/common';
import {
  AssetPriceSourceType,
  AssetType,
  CurrencyCode,
  FxRateSourceType,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  calculatePortfolioValuation,
  PortfolioAssetPriceSnapshotInput,
  PortfolioValuationError,
  PortfolioValuationResult,
} from './portfolio-valuation.policy';
import {
  buildAdminManualFallbackDecision,
  isPositiveDecimal,
  isProviderWorkflowAllowed,
  resolveAssetProviderEligibility,
  resolveFxProviderEligibility,
  selectFreshProviderSnapshot,
  type ProviderWorkflow,
} from '../providers/source-eligibility.policy';

type PortfolioSourceWorkflow = ProviderWorkflow;

type PositionAssetForSourceSelection = {
  id: string;
  assetType: AssetType;
  market: string;
  currencyCode: CurrencyCode;
};

@Injectable()
export class PortfolioValuationService {
  constructor(private readonly prisma: PrismaService) {}

  async calculateSeasonParticipantValuation(
    seasonParticipantId: string,
    valuationAt = new Date(),
    sourceEligibilityWorkflow: PortfolioSourceWorkflow = 'daily_portfolio_snapshot',
  ): Promise<PortfolioValuationResult> {
    const participant = await this.prisma.seasonParticipant.findUnique({
      where: {
        id: seasonParticipantId,
      },
      select: {
        id: true,
        initialCapitalKrw: true,
        cashWallets: {
          select: {
            currencyCode: true,
            balanceAmount: true,
          },
        },
        positions: {
          select: {
            assetId: true,
            quantity: true,
            averageCost: true,
            currencyCode: true,
            realizedPnl: true,
            realizedPnlKrw: true,
            asset: {
              select: {
                id: true,
                assetType: true,
                market: true,
                currencyCode: true,
              },
            },
          },
        },
      },
    });

    if (!participant) {
      throw new PortfolioValuationError(
        'SEASON_PARTICIPANT_NOT_FOUND',
        'Season participant not found.',
      );
    }

    const positions = await Promise.all(
      participant.positions.map(async (position) => ({
        assetId: position.assetId,
        assetType: position.asset.assetType,
        quantity: position.quantity,
        averageCost: position.averageCost,
        currencyCode: position.currencyCode,
        realizedPnl: position.realizedPnl,
        realizedPnlKrw: position.realizedPnlKrw,
        latestPriceSnapshot: await this.findLatestEligibleAssetPriceSnapshot(
          position.asset,
          valuationAt,
          sourceEligibilityWorkflow,
        ),
      })),
    );

    const needsUsdConversion =
      participant.cashWallets.some(
        (wallet) =>
          wallet.currencyCode === CurrencyCode.USD &&
          !wallet.balanceAmount.eq(0),
      ) ||
      participant.positions.some(
        (position) =>
          position.currencyCode === CurrencyCode.USD &&
          !position.quantity.eq(0),
      );

    const usdKrwSnapshot = needsUsdConversion
      ? await this.findLatestEligibleUsdKrwSnapshot(
          valuationAt,
          sourceEligibilityWorkflow,
        )
      : null;

    return calculatePortfolioValuation({
      seasonParticipantId: participant.id,
      initialCapitalKrw: participant.initialCapitalKrw,
      cashWallets: participant.cashWallets,
      positions,
      usdKrwSnapshot,
      valuationAt,
      sourceEligibilityWorkflow: isProviderWorkflowAllowed(
        sourceEligibilityWorkflow,
      )
        ? sourceEligibilityWorkflow
        : undefined,
    });
  }

  private async findLatestEligibleAssetPriceSnapshot(
    asset: PositionAssetForSourceSelection,
    valuationAt: Date,
    sourceEligibilityWorkflow: PortfolioSourceWorkflow,
  ): Promise<PortfolioAssetPriceSnapshotInput | null> {
    const providerEligibility = resolveAssetProviderEligibility({
      workflow: sourceEligibilityWorkflow,
      asset,
    });
    const providerCandidates = providerEligibility.eligible
      ? ((await this.prisma.assetPriceSnapshot.findMany({
          where: {
            assetId: asset.id,
            currencyCode: asset.currencyCode,
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
            assetId: true,
            price: true,
            currencyCode: true,
            sourceType: true,
            sourceName: true,
            effectiveAt: true,
            capturedAt: true,
            createdAt: true,
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

    const fallbackSnapshot = await this.prisma.assetPriceSnapshot.findFirst({
      where: {
        assetId: asset.id,
        currencyCode: asset.currencyCode,
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
        assetId: true,
        id: true,
        price: true,
        currencyCode: true,
        sourceType: true,
        sourceName: true,
        effectiveAt: true,
        capturedAt: true,
        createdAt: true,
      },
    });

    if (!fallbackSnapshot) {
      return null;
    }

    const sourceDecision = buildAdminManualFallbackDecision({
      selectedSnapshotId: fallbackSnapshot.id,
      selectedSourceName: fallbackSnapshot.sourceName,
      selectedEffectiveAt: fallbackSnapshot.effectiveAt,
      selectedCapturedAt: fallbackSnapshot.capturedAt,
      providerDecision: providerSelection.decision,
    });

    return {
      ...fallbackSnapshot,
      sourceDecision,
    };
  }

  private async findLatestEligibleUsdKrwSnapshot(
    valuationAt: Date,
    sourceEligibilityWorkflow: PortfolioSourceWorkflow,
  ) {
    const providerEligibility = resolveFxProviderEligibility({
      workflow: sourceEligibilityWorkflow,
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
            baseCurrency: true,
            quoteCurrency: true,
            rate: true,
            sourceType: true,
            sourceName: true,
            effectiveAt: true,
            capturedAt: true,
            createdAt: true,
            approvedByUserId: true,
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
        ...providerSelection.snapshot,
        sourceDecision: providerSelection.decision,
      };
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
          lte: valuationAt,
        },
      },
      orderBy: [
        { effectiveAt: 'desc' },
        { capturedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      select: {
        id: true,
        baseCurrency: true,
        quoteCurrency: true,
        rate: true,
        sourceType: true,
        sourceName: true,
        effectiveAt: true,
        capturedAt: true,
        createdAt: true,
        approvedByUserId: true,
      },
    });

    if (fallbackSnapshot) {
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

    return fallbackSnapshot;
  }
}
