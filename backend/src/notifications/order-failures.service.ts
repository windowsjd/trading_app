import { HttpStatus, Injectable } from '@nestjs/common';
import { createApiError } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';
import { ORDER_FAILURE_KINDS, type OrderFailureKind } from './push-copy';

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** One failure row as the app shows it after an `order_failure` tap. */
export type OrderFailureView = {
  kind: OrderFailureKind;
  id: string;
  tradingAccountId: string;
  market: 'spot' | 'futures';
  /** The row's stored status, as is. */
  status: string;
  /** True only for the stored final outcome this kind announces (§2.3):
   * LOC `unfilled`/`expired`, everything else `failed`. A watching,
   * triggered or retrying row is never final. */
  final: boolean;
  /** Spot: the asset; Futures: the contract's underlying symbol. */
  instrument: { name: string | null; symbol: string };
  side: 'buy' | 'sell' | null;
  direction: 'long' | 'short' | null;
  protection: 'condition' | 'stop_loss' | 'take_profit' | null;
  /** LOC `decisionReason`, otherwise `terminalReason`. */
  reasonCode: string | null;
  failureCode: string | null;
  /** LOC `decidedAt`, otherwise `endedAt`. */
  endedAt: string | null;
  createdAt: string;
};

const asset = { select: { name: true, symbol: true } } as const;
const underlying = {
  select: { underlyingAsset: { select: { symbol: true } } },
} as const;
const iso = (value: Date | null) => value?.toISOString() ?? null;

/**
 * Read-only lookup behind an `order_failure` push tap
 * (docs/push-notifications-contract.md §2.3). It reads exactly the row the
 * push names, only inside the caller's own account, and reports its stored
 * state — it never executes, retries, cancels or repairs anything. A row of
 * another user or account is the same 404 as a missing one.
 */
@Injectable()
export class OrderFailuresService {
  constructor(private readonly prisma: PrismaService) {}

  async get(
    userId: string | undefined,
    accountId: string,
    kind: string,
    id: string,
  ) {
    if (!userId) throw createApiError('UNAUTHORIZED', 'Unauthorized', 401);
    const failure =
      ORDER_FAILURE_KINDS.includes(kind as OrderFailureKind) &&
      ID.test(id) &&
      ID.test(accountId)
        ? await this.read(kind as OrderFailureKind, id, {
            tradingAccountId: accountId,
            tradingAccount: { userId },
          })
        : null;
    if (!failure)
      throw createApiError(
        'ORDER_FAILURE_NOT_FOUND',
        'The order result was not found.',
        HttpStatus.NOT_FOUND,
      );
    return { success: true as const, data: { failure } };
  }

  private async read(
    kind: OrderFailureKind,
    id: string,
    owned: { tradingAccountId: string; tradingAccount: { userId: string } },
  ): Promise<OrderFailureView | null> {
    const base = { kind, id, protection: null, side: null, direction: null };
    switch (kind) {
      case 'loc': {
        const row = await this.prisma.limitOnCloseOrder.findFirst({
          where: { orderId: id, ...owned },
          select: {
            tradingAccountId: true,
            status: true,
            decisionReason: true,
            decidedAt: true,
            createdAt: true,
            asset,
            order: { select: { side: true } },
          },
        });
        return row
          ? {
              ...base,
              tradingAccountId: row.tradingAccountId,
              market: 'spot',
              status: row.status,
              final: row.status === 'unfilled' || row.status === 'expired',
              instrument: row.asset,
              side: row.order.side,
              reasonCode: row.decisionReason,
              failureCode: null,
              endedAt: iso(row.decidedAt),
              createdAt: row.createdAt.toISOString(),
            }
          : null;
      }
      case 'conditional_buy':
      case 'conditional_sell': {
        const select = {
          tradingAccountId: true,
          status: true,
          failureCode: true,
          terminalReason: true,
          endedAt: true,
          createdAt: true,
          asset,
        } as const;
        const row =
          kind === 'conditional_buy'
            ? await this.prisma.conditionalBuyOrder
                .findFirst({ where: { id, ...owned }, select })
                .then((buy) => buy && { ...buy, kind: null })
            : await this.prisma.conditionalSellOrder.findFirst({
                where: { id, ...owned },
                select: { ...select, kind: true },
              });
        return row
          ? {
              ...base,
              tradingAccountId: row.tradingAccountId,
              market: 'spot',
              status: row.status,
              final: row.status === 'failed',
              instrument: row.asset,
              side: kind === 'conditional_buy' ? 'buy' : 'sell',
              protection: row.kind,
              reasonCode: row.terminalReason,
              failureCode: row.failureCode,
              endedAt: iso(row.endedAt),
              createdAt: row.createdAt.toISOString(),
            }
          : null;
      }
      case 'futures_conditional_entry':
      case 'futures_tp_sl': {
        const select = {
          tradingAccountId: true,
          status: true,
          direction: true,
          failureCode: true,
          terminalReason: true,
          endedAt: true,
          createdAt: true,
          instrument: underlying,
        } as const;
        const row =
          kind === 'futures_conditional_entry'
            ? await this.prisma.futuresConditionalEntry
                .findFirst({ where: { id, ...owned }, select })
                .then((entry) => entry && { ...entry, kind: null })
            : await this.prisma.futuresTpSlSetting.findFirst({
                where: { id, ...owned },
                select: { ...select, kind: true },
              });
        return row
          ? {
              ...base,
              tradingAccountId: row.tradingAccountId,
              market: 'futures',
              status: row.status,
              final: row.status === 'failed',
              instrument: {
                name: null,
                symbol: row.instrument.underlyingAsset.symbol,
              },
              direction: row.direction,
              protection: row.kind,
              reasonCode: row.terminalReason,
              failureCode: row.failureCode,
              endedAt: iso(row.endedAt),
              createdAt: row.createdAt.toISOString(),
            }
          : null;
      }
      case 'entry_tp_sl_plan': {
        const row = await this.prisma.entryTpSlPlan.findFirst({
          where: { id, ...owned },
          select: {
            tradingAccountId: true,
            domain: true,
            kind: true,
            status: true,
            failureCode: true,
            terminalReason: true,
            endedAt: true,
            createdAt: true,
            asset,
          },
        });
        return row
          ? {
              ...base,
              tradingAccountId: row.tradingAccountId,
              market: row.domain,
              status: row.status,
              final: row.status === 'failed',
              // A Futures plan's asset is the contract's underlying asset.
              instrument:
                row.domain === 'futures'
                  ? { name: null, symbol: row.asset.symbol }
                  : row.asset,
              protection: row.kind,
              reasonCode: row.terminalReason,
              failureCode: row.failureCode,
              endedAt: iso(row.endedAt),
              createdAt: row.createdAt.toISOString(),
            }
          : null;
      }
    }
  }
}
