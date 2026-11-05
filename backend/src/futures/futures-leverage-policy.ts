import { HttpStatus } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { CashWallet, Prisma } from '../generated/prisma/client';
import { futuresError } from './futures-error';
import { assertFuturesLeverage } from './futures-input';
import { crossRisk, type positionRisk } from './futures-risk';

export type FuturesRisk = ReturnType<typeof positionRisk>;

export type FuturesLeverageChangeInput = {
  leverage: number;
  fromLeverage: number;
  idempotencyKey: string;
};

/** `{ leverage, fromLeverage, idempotencyKey }`: a real change from the
 * leverage the user saw on the position. */
export function parseFuturesLeverageChange(
  body: unknown,
): FuturesLeverageChangeInput {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some(
      (key) => !['leverage', 'fromLeverage', 'idempotencyKey'].includes(key),
    )
  )
    invalidChange();
  const row = body as Record<string, unknown>;
  assertFuturesLeverage(row.leverage);
  assertFuturesLeverage(row.fromLeverage);
  const idempotencyKey =
    typeof row.idempotencyKey === 'string' ? row.idempotencyKey.trim() : '';
  if (
    row.leverage === row.fromLeverage ||
    !idempotencyKey ||
    idempotencyKey.length > 200
  )
    invalidChange();
  return {
    leverage: row.leverage,
    fromLeverage: row.fromLeverage,
    idempotencyKey,
  };
}

export function futuresLeverageChangeHash(
  accountId: string,
  positionId: string,
  input: FuturesLeverageChangeInput,
) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: 'futures-leverage:v1',
        accountId,
        positionId,
        leverage: input.leverage,
        fromLeverage: input.fromLeverage,
      }),
    )
    .digest('hex');
}

/**
 * The open/increase exposure checks of the execution core as one pure
 * decision (shared by the leverage-only change and its preview): the
 * Isolated lifetime's own maintenance, then the whole account — Cross base
 * and free collateral never negative, Cross equity above maintenance while
 * any Cross lifetime is open, and nonnegative cash. Long and short
 * requirements are summed; nothing is netted or discounted.
 */
export function assessFuturesExposure(input: {
  wallet: Pick<CashWallet, 'balanceAmount' | 'reservedAmount'>;
  balanceAfter: Prisma.Decimal;
  usedAfter: Prisma.Decimal;
  marginMode: 'isolated' | 'cross';
  nextRisk: FuturesRisk;
  otherCrossRisks: FuturesRisk[];
}) {
  const risks = [
    ...input.otherCrossRisks,
    ...(input.marginMode === 'cross' ? [input.nextRisk] : []),
  ];
  const after = crossRisk(
    { ...input.wallet, balanceAmount: input.balanceAfter },
    input.usedAfter,
    risks,
  );
  const refusal =
    input.marginMode !== 'cross' && input.nextRisk.liquidationBuffer.lte(0)
      ? ('FUTURES_MAINTENANCE_UNSAFE' as const)
      : after.crossBaseCollateral.lt(0) ||
          after.crossFreeCollateral.lt(0) ||
          (risks.length > 0 && after.liquidationBuffer.lte(0)) ||
          input.balanceAfter.lt(0)
        ? ('INSUFFICIENT_FUTURES_FREE_COLLATERAL' as const)
        : null;
  return { after, refusal, hasCross: risks.length > 0 };
}

function invalidChange(): never {
  futuresError(
    'INVALID_FUTURES_LEVERAGE_CHANGE',
    "Check the new leverage, the position's current leverage and the request key.",
    HttpStatus.BAD_REQUEST,
  );
}
