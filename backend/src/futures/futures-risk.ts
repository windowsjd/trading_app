import { isStandaloneAccountMode } from '../trading-accounts/account-mode-policy';
import {
  Prisma,
  type FuturesPosition,
  type CashWallet,
} from '../generated/prisma/client';
import {
  futuresDecimal as d,
  futuresPnl,
  futuresMoney,
  marginCeil,
  assertFuturesMoney,
} from './futures-math';
import { readFuturesMark } from './futures-mark';
import { futuresError } from './futures-error';
import { readGeneralTradeFeeRate } from '../orders/general-trading.config';
import { setAdminDiagnosticContext } from '../common/admin-diagnostics';

export const FUTURES_MMR = '0.005';
export function riskStrings<T extends Record<string, Prisma.Decimal>>(risk: T) {
  return Object.fromEntries(
    Object.entries(risk).map(([key, value]) => [key, value.toFixed(8)]),
  ) as { [K in keyof T]: string };
}
export const sumRisk = (values: Prisma.Decimal[]) =>
  values.reduce((a, b) => assertFuturesMoney(a.add(b)), d('0'));
export function positionRisk(
  p: Pick<
    FuturesPosition,
    | 'quantity'
    | 'averageEntryPrice'
    | 'direction'
    | 'leverage'
    | 'isolatedMargin'
    | 'marginMode'
  >,
  mark: Prisma.Decimal,
  fee: Prisma.Decimal,
) {
  const raw = d(p.quantity).mul(mark);
  const markNotional = assertFuturesMoney(futuresMoney(raw));
  const unrealizedPnl = futuresPnl(
    p.direction,
    p.averageEntryPrice,
    mark,
    p.quantity,
  );
  const initialRequirement = assertFuturesMoney(
    marginCeil(raw.div(p.leverage)),
  );
  const maintenanceMargin = assertFuturesMoney(
    marginCeil(raw.mul(FUTURES_MMR)),
  );
  const estimatedCloseFee = assertFuturesMoney(
    futuresMoney(d(markNotional).mul(fee)),
  );
  const liquidationRequirement = maintenanceMargin.add(estimatedCloseFee);
  const equity = d(p.isolatedMargin).add(unrealizedPnl);
  return {
    markNotional,
    unrealizedPnl,
    initialRequirement,
    maintenanceMargin,
    estimatedCloseFee,
    liquidationRequirement,
    equity,
    liquidationBuffer: equity.sub(liquidationRequirement),
  };
}
export function isolatedLiquidationPrice(
  p: Pick<
    FuturesPosition,
    'quantity' | 'averageEntryPrice' | 'direction' | 'isolatedMargin'
  >,
  fee: Prisma.Decimal,
) {
  const q = d(p.quantity),
    entry = q.mul(p.averageEntryPrice),
    rate = d(FUTURES_MMR).add(fee);
  const numerator =
    p.direction === 'long'
      ? entry.sub(p.isolatedMargin)
      : entry.add(p.isolatedMargin);
  const denominator = q.mul(
    p.direction === 'long' ? d('1').sub(rate) : d('1').add(rate),
  );
  if (numerator.lte(0) || denominator.lte(0)) return null;
  return assertFuturesMoney(
    numerator
      .div(denominator)
      .toDecimalPlaces(
        8,
        p.direction === 'long'
          ? Prisma.Decimal.ROUND_CEIL
          : Prisma.Decimal.ROUND_FLOOR,
      ),
  );
}
export function presentPositionRisk(
  position: FuturesPosition,
  risk: ReturnType<typeof positionRisk>,
  fee: Prisma.Decimal,
) {
  const { equity, liquidationBuffer, ...metrics } = risk;
  return {
    ...riskStrings(metrics),
    ...(position.marginMode === 'isolated'
      ? {
          equity: equity.toFixed(8),
          liquidationBuffer: liquidationBuffer.toFixed(8),
        }
      : {}),
    liquidationPrice:
      position.marginMode === 'isolated'
        ? (isolatedLiquidationPrice(position, fee)?.toFixed(8) ?? null)
        : null,
  };
}
export function crossRisk(
  wallet: Pick<CashWallet, 'balanceAmount' | 'reservedAmount'>,
  isolated: Prisma.Decimal,
  risks: ReturnType<typeof positionRisk>[],
) {
  const crossBaseCollateral = d(wallet.balanceAmount)
    .sub(wallet.reservedAmount)
    .sub(isolated);
  const crossUnrealizedPnl = sumRisk(risks.map((r) => r.unrealizedPnl));
  const crossEquity = crossBaseCollateral.add(crossUnrealizedPnl);
  const crossInitialMarginRequirement = sumRisk(
    risks.map((r) => r.initialRequirement),
  );
  const crossMaintenanceRequirement = sumRisk(
    risks.map((r) => r.liquidationRequirement),
  );
  return {
    crossBaseCollateral,
    crossUnrealizedPnl,
    crossEquity,
    crossInitialMarginRequirement,
    crossMaintenanceRequirement,
    crossFreeCollateral: crossEquity.sub(crossInitialMarginRequirement),
    liquidationBuffer: crossEquity.sub(crossMaintenanceRequirement),
  };
}
export async function accountFuturesFee(
  tx: Pick<Prisma.TransactionClient, 'tradingAccount'>,
  accountId: string,
) {
  const account = await tx.tradingAccount.findUniqueOrThrow({
    where: { id: accountId },
    include: { seasonParticipant: { include: { season: true } } },
  });
  const fee = isStandaloneAccountMode(account.mode)
    ? readGeneralTradeFeeRate()
    : account.seasonParticipant?.season.tradeFeeRate;
  if (
    !fee ||
    !fee.isFinite() ||
    fee.lt(0) ||
    fee.gt(1) ||
    fee.decimalPlaces() > 6
  )
    futuresError(
      'FUTURES_FEE_POLICY_INVALID',
      'Trading fees could not be verified. Please try again.',
    );
  return fee;
}
export async function loadCrossRisk(
  tx: Prisma.TransactionClient,
  wallet: CashWallet,
  now: Date,
  isolated: Prisma.Decimal,
  fee: Prisma.Decimal,
  required = true,
) {
  const positions = await tx.futuresPosition.findMany({
    where: {
      tradingAccountId: wallet.tradingAccountId,
      status: 'open',
      marginMode: 'cross',
    },
    include: { instrument: { include: { underlyingAsset: true } } },
    orderBy: { id: 'asc' },
  });
  const rows = await Promise.all(
    positions.map(async (p) => {
      const mark = await readFuturesMark(tx, p.instrument, now, required);
      return {
        position: p,
        mark,
        risk: mark ? positionRisk(p, mark.price, fee) : null,
      };
    }),
  );
  const risk = rows.every((r) => r.risk !== null)
    ? crossRisk(
        wallet,
        isolated,
        rows.map((r) => r.risk!),
      )
    : null;
  return { rows, risk };
}
export function assertCrossSafe(
  risk: ReturnType<typeof crossRisk>,
  hasCross: boolean,
) {
  if (
    risk.crossBaseCollateral.lt(0) ||
    risk.crossFreeCollateral.lt(0) ||
    (hasCross && risk.liquidationBuffer.lte(0))
  ) {
    // Project the already-calculated predicates, never riskStrings(risk).
    setAdminDiagnosticContext({
      evidence: {
        financialGuard: {
          guardName: 'futures_collateral',
          observation: 'mutation_plan',
          mutationResult: 'rejected',
          walletScope: 'crypto_futures',
          currencyCode: 'USD',
          crossPositionsPresent: hasCross,
          isolatedAllocationSufficient: risk.crossBaseCollateral.gte(0),
          collateralSufficient: risk.crossFreeCollateral.gte(0),
          ...(hasCross
            ? { maintenanceSufficient: risk.liquidationBuffer.gt(0) }
            : {}),
          failureReason: risk.crossBaseCollateral.lt(0)
            ? 'isolated_allocation_underfunded'
            : risk.crossFreeCollateral.lt(0)
              ? 'insufficient_free_collateral'
              : 'maintenance_unsafe',
        },
      },
      nextInvestigation: ['backend/src/futures/futures-risk.ts'],
    });
    futuresError(
      'INSUFFICIENT_FUTURES_FREE_COLLATERAL',
      'Available Futures collateral is insufficient for the required margin and maintenance.',
    );
  }
}
