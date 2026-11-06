import { Injectable, Optional } from '@nestjs/common';
import { createApiError } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';
import { BinanceSymbolMetadataService } from '../providers/binance/binance-symbol-metadata.service';
import { TradingAccountAccessService } from '../trading-accounts/trading-account-access.service';
import { readOwnCompletedTrades } from './own-completed-trades';

/**
 * 수익 공유: the owner's completed trades on one of their accounts
 * (docs/completed-trades-share-contract.md). Read only, status-blind like
 * every owner record read: an ended or settled season account still lists
 * its own trades. Nothing is written, cached or rendered on the server.
 */
@Injectable()
export class CompletedTradesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TradingAccountAccessService,
    @Optional() private readonly symbols?: BinanceSymbolMetadataService,
  ) {}

  async list(userId: string | undefined, accountId: string) {
    if (!userId) throw createApiError('UNAUTHORIZED', 'Unauthorized', 401);
    const account = await this.access.getOwnedAccountOrThrow(userId, accountId);
    const result = await this.prisma.$transaction(
      async (tx) => {
        // A general reset re-bases Spot realized PnL to 0: the trades before
        // it are the ended epoch's and no longer part of any position.
        const reset = await tx.generalAccountReset.findFirst({
          where: { tradingAccountId: account.id },
          orderBy: { sequence: 'desc' },
          select: { resetAt: true },
        });
        return readOwnCompletedTrades(tx, account.id, {
          spotSince: reset?.resetAt ?? null,
          spotDisplayDecimals: (asset) =>
            this.symbols?.getDisplayPriceDecimals(asset) ?? null,
        });
      },
      { isolationLevel: 'RepeatableRead' },
    );
    return {
      success: true as const,
      data: { tradingAccountId: account.id, ...result },
    };
  }
}
