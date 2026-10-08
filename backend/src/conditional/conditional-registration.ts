import { createApiError } from '../common/api-error';
import { setAdminDiagnosticContext } from '../common/admin-diagnostics';
import { Prisma } from '../generated/prisma/client';
import { assertOrderInputPolicy } from '../orders/order-input-policy';
import {
  assertConditionalEnabled,
  assertTriggerDirections,
  conditionalTradable,
  type ProtectionLegInput,
} from './conditional-policy';
import { isLimitOrderEnabled } from '../orders/limit-order.config';
import { readLimitOrderMatchingConfig } from '../orders/limit-order-matching.config';
import { conditionalPrice } from './conditional-price';
import { liveProtection } from './conditional-state';

/** Caller owns the existing account/lifecycle fence. Registration never reserves. */
export async function createProtectionInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    accountId: string;
    domain: 'spot' | 'futures';
    assetId: string;
    positionId?: string;
    parentOrderId?: string;
    parentQuantity?: Prisma.Decimal;
    legs: ProtectionLegInput[];
    now: Date;
  },
) {
  assertConditionalEnabled(input.domain);
  if (
    input.domain === 'spot' &&
    (input.parentOrderId ||
      input.legs.some((leg) => leg.childOrderType === 'limit')) &&
    (!isLimitOrderEnabled() || !readLimitOrderMatchingConfig().matchingEnabled)
  )
    throw createApiError(
      'CONDITIONAL_LIMIT_UNAVAILABLE',
      'Spot Limit registration and matching must be available.',
      409,
    );
  const asset = await tx.asset.findUniqueOrThrow({
    where: { id: input.assetId },
  });
  const existing = await tx.protectionGroup.findFirst({
    where: {
      tradingAccountId: input.accountId,
      assetId: asset.id,
      domain: input.domain,
      ...liveProtection,
    },
  });
  if (existing)
    throw createApiError(
      'PROTECTION_CONFLICT',
      'This position already has active protection.',
      409,
    );
  let direction: 'long' | 'short' = 'long';
  let positionId: string | undefined;
  let futuresPositionId: string | undefined;
  let quantity = input.parentQuantity;
  if (input.domain === 'spot') {
    await tx.$queryRaw`SELECT id FROM positions WHERE trading_account_id = ${input.accountId} AND asset_id = ${asset.id} FOR UPDATE`;
    const position = await tx.position.findUnique({
      where: {
        tradingAccountId_assetId: {
          tradingAccountId: input.accountId,
          assetId: asset.id,
        },
      },
    });
    if (input.parentOrderId) {
      const competing = await tx.order.count({
        where: {
          tradingAccountId: input.accountId,
          assetId: asset.id,
          side: 'buy',
          status: 'submitted',
          id: { not: input.parentOrderId },
        },
      });
      if (position?.quantity.gt(0) || competing)
        throw createApiError(
          'ATTACHED_ENTRY_CONFLICT',
          'Attached entry requires a flat position and no competing entry.',
          409,
        );
    } else {
      if (
        !position ||
        position.quantity.lte(0) ||
        (input.positionId && input.positionId !== position.id)
      )
        throw createApiError(
          'PROTECTION_POSITION_UNAVAILABLE',
          'An open position is required.',
          409,
        );
      if (position.reservedQuantity.gt(0))
        throw createApiError(
          'PROTECTION_RESERVATION_CONFLICT',
          'Cancel existing sell reservations before protecting the whole position.',
          409,
        );
      positionId = position.id;
      quantity = position.quantity;
    }
    if (input.legs.some((leg) => leg.childOrderType === 'limit'))
      assertOrderInputPolicy(
        {
          assetType: asset.assetType,
          side: 'sell',
          orderType: 'limit',
          quantity: quantity ?? null,
          amount: null,
        },
        { positionBoundExit: true },
      );
  } else {
    if (input.parentOrderId)
      throw createApiError(
        'INVALID_PROTECTION',
        'Futures Limit entry is not supported.',
        400,
      );
    await tx.$queryRaw`SELECT id FROM cash_wallets WHERE trading_account_id = ${input.accountId} AND wallet_scope = 'crypto_futures' AND currency_code = 'USD' FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM futures_positions WHERE id = ${input.positionId ?? ''} AND trading_account_id = ${input.accountId} FOR UPDATE`;
    const position = await tx.futuresPosition.findFirst({
      where: {
        id: input.positionId,
        tradingAccountId: input.accountId,
        status: 'open',
        instrument: { underlyingAssetId: asset.id },
      },
    });
    if (!input.positionId || !position)
      throw createApiError(
        'PROTECTION_POSITION_UNAVAILABLE',
        'An open Futures lifetime is required.',
        409,
      );
    direction = position.direction;
    futuresPositionId = position.id;
  }
  // Refresh DB time after reservation-owner locks; callers already hold lifecycle locks.
  const [clock] = await tx.$queryRaw<
    Array<{ now: Date }>
  >`SELECT clock_timestamp() AS now`;
  const now = clock.now;
  const account = await tx.tradingAccount.findUniqueOrThrow({
    where: { id: input.accountId },
    include: { seasonParticipant: { include: { season: true } } },
  });
  if (!conditionalTradable(account, now))
    throw createApiError(
      'CONDITIONAL_ACCOUNT_NOT_TRADABLE',
      'The account trading window ended.',
      409,
    );
  const price = await conditionalPrice(tx, asset, input.domain, now);
  if (!price) {
    setAdminDiagnosticContext({
      domain: 'CONDITIONAL',
      operation: 'CONDITIONAL_PROTECTION_CREATE',
      failureStage: 'conditional_registration_price_selection',
      entities: { tradingAccountId: input.accountId, assetId: asset.id },
      evidence: {
        evaluationState: 'reference_unavailable',
        priceEvidenceAvailable: false,
      },
    });
    throw createApiError(
      'CONDITIONAL_PRICE_UNAVAILABLE',
      'A fresh eligible reference price is required.',
      409,
    );
  }
  assertTriggerDirections(input.legs, direction, price.price);
  return tx.protectionGroup.create({
    data: {
      tradingAccountId: input.accountId,
      assetId: asset.id,
      domain: input.domain,
      direction,
      positionId,
      futuresPositionId,
      parentOrderId: input.parentOrderId,
      status: input.parentOrderId ? 'holding' : 'active',
      activatedAt: input.parentOrderId ? null : now,
      createdAt: now,
      legs: {
        create: input.legs.map((leg) => ({
          ...leg,
          childLimitPrice: leg.childLimitPrice ?? null,
        })),
      },
    },
    include: { legs: true },
  });
}
