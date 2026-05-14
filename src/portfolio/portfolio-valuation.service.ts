import { Injectable } from '@nestjs/common';
import {
  AssetPriceSourceType,
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

@Injectable()
export class PortfolioValuationService {
  constructor(private readonly prisma: PrismaService) {}

  async calculateSeasonParticipantValuation(
    seasonParticipantId: string,
    valuationAt = new Date(),
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
            asset: {
              select: {
                assetType: true,
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
        latestPriceSnapshot: await this.findLatestEligibleAssetPriceSnapshot(
          position.assetId,
          valuationAt,
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
          (!position.quantity.eq(0) || !position.realizedPnl.eq(0)),
      );

    const usdKrwSnapshot = needsUsdConversion
      ? await this.findLatestEligibleUsdKrwSnapshot(valuationAt)
      : null;

    return calculatePortfolioValuation({
      seasonParticipantId: participant.id,
      initialCapitalKrw: participant.initialCapitalKrw,
      cashWallets: participant.cashWallets,
      positions,
      usdKrwSnapshot,
      valuationAt,
    });
  }

  private async findLatestEligibleAssetPriceSnapshot(
    assetId: string,
    valuationAt: Date,
  ): Promise<PortfolioAssetPriceSnapshotInput | null> {
    return this.prisma.assetPriceSnapshot.findFirst({
      where: {
        assetId,
        sourceType: AssetPriceSourceType.admin_manual,
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
        assetId: true,
        price: true,
        currencyCode: true,
        sourceType: true,
        effectiveAt: true,
        capturedAt: true,
        createdAt: true,
      },
    });
  }

  private async findLatestEligibleUsdKrwSnapshot(valuationAt: Date) {
    return this.prisma.fxRateSnapshot.findFirst({
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
        baseCurrency: true,
        quoteCurrency: true,
        rate: true,
        sourceType: true,
        effectiveAt: true,
        capturedAt: true,
        createdAt: true,
        approvedByUserId: true,
      },
    });
  }
}
