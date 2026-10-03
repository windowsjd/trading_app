import { Prisma } from '../generated/prisma/client';
import { setAdminDiagnosticContext } from '../common/admin-diagnostics';

/** Safe projection of already-read quantities. Never return financial values. */
export function positionAvailabilityEvidence(
  position: {
    quantity: Prisma.Decimal;
    reservedQuantity?: Prisma.Decimal | null;
  } | null,
  required: Prisma.Decimal,
) {
  if (!position)
    return { positionFound: false, failureReason: 'position_not_found' };
  const reserved = position.reservedQuantity ?? new Prisma.Decimal(0);
  const totalQuantitySufficient = position.quantity.gte(required);
  const availableQuantitySufficient = position.quantity
    .sub(reserved)
    .gte(required);
  return {
    positionFound: true,
    totalQuantitySufficient,
    availableQuantitySufficient,
    reservedQuantityPresent: reserved.gt(0),
    failureReason: !totalQuantitySufficient
      ? 'insufficient_quantity'
      : !availableQuantitySufficient
        ? 'insufficient_available_quantity'
        : 'conflict',
  };
}

/**
 * One read, only after a rejected mutation. No locks, retries or repair.
 * BY ID exposes scope changes without copying another account's identifiers.
 * Returned reasons are diagnostic classification; callers keep their public codes.
 */
export async function diagnosePositionMutationFailure(
  tx: Pick<Prisma.TransactionClient, 'position'>,
  input: {
    positionId: string;
    tradingAccountId: string;
    assetId: string;
    currencyCode?: string;
    quantity: Prisma.Decimal;
    guard: 'available_position_quantity' | 'reserved_position_quantity';
    financialOperation: string;
    failureStage: string;
    mutationAffected: number;
  },
) {
  const position = await tx.position.findUnique({
    where: { id: input.positionId },
    select: {
      tradingAccountId: true,
      assetId: true,
      currencyCode: true,
      quantity: true,
      reservedQuantity: true,
    },
  });
  const scopeValid = position
    ? position.tradingAccountId === input.tradingAccountId
    : undefined;
  const assetMatched = position
    ? position.assetId === input.assetId
    : undefined;
  const currencyMatched =
    position && input.currencyCode !== undefined
      ? position.currencyCode === input.currencyCode
      : undefined;
  const validPosition =
    position && scopeValid && assetMatched && currencyMatched !== false
      ? position
      : null;
  const availability = positionAvailabilityEvidence(
    validPosition,
    input.quantity,
  );
  const reservedSufficient = validPosition
    ? (validPosition.reservedQuantity ?? new Prisma.Decimal(0)).gte(
        input.quantity,
      )
    : undefined;
  const failureReason = !position
    ? 'position_not_found'
    : !scopeValid
      ? position.tradingAccountId == null
        ? 'null_scope'
        : 'account_scope_mismatch'
      : !assetMatched
        ? 'asset_mismatch'
        : currencyMatched === false
          ? 'currency_mismatch'
          : input.guard === 'reserved_position_quantity'
            ? reservedSufficient
              ? 'conflict'
              : 'insufficient_reserved_quantity'
            : availability.failureReason;
  const evidence = {
    financialOperation: input.financialOperation,
    guardName: input.guard,
    mutationResult: 'rejected',
    mutationAffected: input.mutationAffected,
    observation: 'failure_read',
    ...(input.guard === 'available_position_quantity' && validPosition
      ? availability
      : {}),
    positionFound: !!position,
    scopeValid,
    assetMatched,
    currencyMatched,
    ...(input.guard === 'reserved_position_quantity'
      ? { reservedSufficient }
      : {}),
    failureReason,
  };
  setAdminDiagnosticContext({
    failureStage: input.failureStage,
    evidence: { financialGuard: evidence },
  });
  // The market caller's historical public mapping also checks owned quantity
  // when currency changed. Keep that bit local; invalid-scope financial
  // predicates above are deliberately excluded from the admin projection.
  return {
    ...evidence,
    totalQuantitySufficient: position
      ? position.quantity.gte(input.quantity)
      : undefined,
  };
}
