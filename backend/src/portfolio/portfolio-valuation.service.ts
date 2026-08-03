import { Injectable } from '@nestjs/common';
import {
  AssetPriceSourceType,
  AssetType,
  CurrencyCode,
  FxRateSourceType,
  Prisma,
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
  selectFreshProviderSnapshotBySourcePriority,
  selectMarketAwareAssetPriceSnapshotBySourcePriority,
  selectProviderSnapshotAtOrBeforeBySourcePriority,
  type ProviderWorkflow,
} from '../providers/source-eligibility.policy';

type PortfolioSourceWorkflow = ProviderWorkflow;

type PositionAssetForSourceSelection = {
  id: string;
  assetType: AssetType;
  market: string;
  currencyCode: CurrencyCode;
  priceCurrency: CurrencyCode;
};

@Injectable()
export class PortfolioValuationService {
  constructor(private readonly prisma: PrismaService) {}

  async calculateSeasonParticipantValuation(
    seasonParticipantId: string,
    valuationAt = new Date(),
    sourceEligibilityWorkflow: PortfolioSourceWorkflow = 'daily_portfolio_snapshot',
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<PortfolioValuationResult> {
    const useSettlementPricePolicy =
      sourceEligibilityWorkflow === 'season_settlement';
    const participant = await client.seasonParticipant.findUnique({
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
                priceCurrency: true,
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

    return this.calculateValuationForHoldings({
      subject: { seasonParticipantId: participant.id, tradingAccountId: null },
      initialCapitalKrw: participant.initialCapitalKrw,
      cashWallets: participant.cashWallets,
      positions: participant.positions,
      valuationAt,
      sourceEligibilityWorkflow,
      useSettlementPricePolicy,
      client,
    });
  }

  /**
   * Account-scoped valuation (작업 7). Same holdings → same numbers as the
   * season path: both funnel into calculateValuationForHoldings and the
   * unchanged pure `calculatePortfolioValuation`. Only the LOOKUP differs —
   * wallets and positions are selected by their own `tradingAccountId`
   * instead of through a participant.
   *
   * The returned `returnRate` is the simple initial-capital ratio and is NOT
   * the headline number for general accounts; GeneralAccountPerformanceService
   * replaces it with the time-weighted return.
   */
  async calculateTradingAccountValuation(
    tradingAccountId: string,
    valuationAt = new Date(),
    sourceEligibilityWorkflow: PortfolioSourceWorkflow = 'home_live_valuation',
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<PortfolioValuationResult> {
    const useSettlementPricePolicy =
      sourceEligibilityWorkflow === 'season_settlement';
    const account = await client.tradingAccount.findUnique({
      where: { id: tradingAccountId },
      select: {
        id: true,
        initialCapitalKrw: true,
        cashWallets: {
          select: { currencyCode: true, balanceAmount: true },
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
                priceCurrency: true,
              },
            },
          },
        },
      },
    });

    if (!account) {
      throw new PortfolioValuationError(
        'TRADING_ACCOUNT_NOT_FOUND',
        'Trading account not found.',
      );
    }

    return this.calculateValuationForHoldings({
      subject: { seasonParticipantId: null, tradingAccountId: account.id },
      initialCapitalKrw: account.initialCapitalKrw,
      cashWallets: account.cashWallets,
      positions: account.positions,
      valuationAt,
      sourceEligibilityWorkflow,
      useSettlementPricePolicy,
      client,
    });
  }

  /**
   * The shared core: price/FX source selection + the pure valuation policy.
   * Extracted so the season and account paths cannot drift apart — a change
   * to freshness, market-awareness, admin_manual fallback, or USD conversion
   * applies to both by construction.
   */
  private async calculateValuationForHoldings(input: {
    subject: {
      seasonParticipantId: string | null;
      tradingAccountId: string | null;
    };
    initialCapitalKrw: Prisma.Decimal;
    cashWallets: readonly {
      currencyCode: CurrencyCode;
      balanceAmount: Prisma.Decimal;
    }[];
    positions: readonly {
      assetId: string;
      quantity: Prisma.Decimal;
      averageCost: Prisma.Decimal;
      currencyCode: CurrencyCode;
      realizedPnl: Prisma.Decimal;
      realizedPnlKrw: Prisma.Decimal;
      asset: PositionAssetForSourceSelection;
    }[];
    valuationAt: Date;
    sourceEligibilityWorkflow: PortfolioSourceWorkflow;
    useSettlementPricePolicy: boolean;
    client: Prisma.TransactionClient | PrismaService;
  }): Promise<PortfolioValuationResult> {
    const positions = await Promise.all(
      input.positions.map(async (position) => ({
        assetId: position.assetId,
        assetType: position.asset.assetType,
        quantity: position.quantity,
        averageCost: position.averageCost,
        currencyCode: position.currencyCode,
        realizedPnl: position.realizedPnl,
        realizedPnlKrw: position.realizedPnlKrw,
        latestPriceSnapshot: await this.findLatestEligibleAssetPriceSnapshot(
          position.asset,
          input.valuationAt,
          input.sourceEligibilityWorkflow,
          input.useSettlementPricePolicy,
          input.client,
        ),
      })),
    );

    // No USD cash and no USD position → no FX snapshot is needed at all, so a
    // KRW-only general account never fails on a missing/stale USD rate.
    const needsUsdConversion =
      input.cashWallets.some(
        (wallet) =>
          wallet.currencyCode === CurrencyCode.USD &&
          !wallet.balanceAmount.eq(0),
      ) ||
      input.positions.some(
        (position) =>
          position.currencyCode === CurrencyCode.USD &&
          !position.quantity.eq(0),
      );

    const usdKrwSnapshot = needsUsdConversion
      ? await this.findLatestEligibleUsdKrwSnapshot(
          input.valuationAt,
          input.sourceEligibilityWorkflow,
          input.useSettlementPricePolicy,
          input.client,
        )
      : null;

    return calculatePortfolioValuation({
      seasonParticipantId: input.subject.seasonParticipantId,
      tradingAccountId: input.subject.tradingAccountId,
      initialCapitalKrw: input.initialCapitalKrw,
      cashWallets: input.cashWallets,
      positions,
      usdKrwSnapshot,
      valuationAt: input.valuationAt,
      sourceEligibilityWorkflow: isProviderWorkflowAllowed(
        input.sourceEligibilityWorkflow,
      )
        ? input.sourceEligibilityWorkflow
        : undefined,
      enforceAdminManualFxFreshness: !input.useSettlementPricePolicy,
    });
  }

  private async findLatestEligibleAssetPriceSnapshot(
    asset: PositionAssetForSourceSelection,
    valuationAt: Date,
    sourceEligibilityWorkflow: PortfolioSourceWorkflow,
    useSettlementPricePolicy: boolean,
    client: Prisma.TransactionClient | PrismaService,
  ): Promise<PortfolioAssetPriceSnapshotInput | null> {
    const providerEligibility = resolveAssetProviderEligibility({
      workflow: sourceEligibilityWorkflow,
      asset: {
        id: asset.id,
        assetType: asset.assetType,
        market: asset.market,
        currencyCode: this.getAssetPriceCurrency(asset),
      },
    });
    const providerCandidates = providerEligibility.eligible
      ? ((await client.assetPriceSnapshot.findMany({
          where: {
            assetId: asset.id,
            currencyCode: this.getAssetPriceCurrency(asset),
            sourceType: AssetPriceSourceType.provider_api,
            ...(useSettlementPricePolicy
              ? {
                  sourceName: {
                    in: [...providerEligibility.sourceNames],
                  },
                  effectiveAt: {
                    lte: valuationAt,
                  },
                  price: {
                    gt: 0,
                  },
                }
              : {}),
          },
          orderBy: [
            { effectiveAt: 'desc' },
            { capturedAt: 'desc' },
            { createdAt: 'desc' },
          ],
          take: useSettlementPricePolicy
            ? providerEligibility.sourceNames.length * 10
            : 10,
          select: {
            id: true,
            assetId: true,
            price: true,
            priceKrw: true,
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
      ? useSettlementPricePolicy
        ? selectProviderSnapshotAtOrBeforeBySourcePriority({
            candidates: providerCandidates,
            expectedSourceNames: providerEligibility.sourceNames,
            valuationAt,
            isPositiveValue: (candidate) => isPositiveDecimal(candidate.price),
          })
        : selectMarketAwareAssetPriceSnapshotBySourcePriority({
            asset,
            workflow: sourceEligibilityWorkflow,
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

    const fallbackSnapshot = await client.assetPriceSnapshot.findFirst({
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
        assetId: true,
        id: true,
        price: true,
        priceKrw: true,
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
    useSettlementPricePolicy: boolean,
    client: Prisma.TransactionClient | PrismaService,
  ) {
    const providerEligibility = resolveFxProviderEligibility({
      workflow: sourceEligibilityWorkflow,
      baseCurrency: CurrencyCode.USD,
      quoteCurrency: CurrencyCode.KRW,
    });
    const providerCandidates = providerEligibility.eligible
      ? ((await client.fxRateSnapshot.findMany({
          where: {
            baseCurrency: CurrencyCode.USD,
            quoteCurrency: CurrencyCode.KRW,
            sourceType: FxRateSourceType.provider_api,
            ...(useSettlementPricePolicy
              ? {
                  sourceName: {
                    in: [...providerEligibility.sourceNames],
                  },
                  effectiveAt: {
                    lte: valuationAt,
                  },
                  rate: {
                    gt: 0,
                  },
                }
              : {}),
          },
          orderBy: [
            { effectiveAt: 'desc' },
            { capturedAt: 'desc' },
            { createdAt: 'desc' },
          ],
          take: useSettlementPricePolicy
            ? providerEligibility.sourceNames.length * 10
            : 10,
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
      ? useSettlementPricePolicy
        ? selectProviderSnapshotAtOrBeforeBySourcePriority({
            candidates: providerCandidates,
            expectedSourceNames: providerEligibility.sourceNames,
            valuationAt,
            isPositiveValue: (candidate) => isPositiveDecimal(candidate.rate),
          })
        : selectFreshProviderSnapshotBySourcePriority({
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
        ...providerSelection.snapshot,
        sourceDecision: providerSelection.decision,
      };
    }

    const fallbackSnapshot = await client.fxRateSnapshot.findFirst({
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
        ...(useSettlementPricePolicy
          ? {
              rate: {
                gt: 0,
              },
            }
          : {}),
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

  private getAssetPriceCurrency(
    asset: Pick<PositionAssetForSourceSelection, 'currencyCode'> & {
      priceCurrency?: CurrencyCode | null;
    },
  ): CurrencyCode {
    return asset.priceCurrency ?? asset.currencyCode;
  }
}
