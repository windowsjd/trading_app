import { isStandaloneAccountMode } from '../trading-accounts/account-mode-policy';
import { createApiError } from '../common/api-error';
import { createHash } from 'node:crypto';
import {
  Prisma,
  type FuturesDirection,
  type ProtectionKind,
} from '../generated/prisma/client';
import type { OwnedTradingAccount } from '../trading-accounts/trading-account-access.service';
import { futuresTradingMode } from '../futures/futures.config';
import { conditionalEnabled } from './conditional.config';
export { conditionalEnabled } from './conditional.config';

export function assertConditionalEnabled(domain: 'spot' | 'futures') {
  if (!conditionalEnabled())
    throw createApiError(
      'CONDITIONAL_DISABLED',
      'Conditional orders are currently disabled.',
      409,
    );
  if (domain === 'futures' && futuresTradingMode() === 'DISABLED')
    throw createApiError(
      'FUTURES_TRADING_DISABLED',
      'Futures user trading is disabled.',
      409,
    );
}
export function conditionalTradable(account: OwnedTradingAccount, now: Date) {
  if (account.status !== 'active') return false;
  if (isStandaloneAccountMode(account.mode)) return true;
  const p = account.seasonParticipant;
  return (
    !!p &&
    p.participantStatus === 'active' &&
    p.season.status === 'active' &&
    p.season.startAt <= now &&
    now < p.season.endAt
  );
}
export type ProtectionLegInput = {
  kind: ProtectionKind;
  triggerPrice: string;
  childOrderType: 'market' | 'limit';
  childLimitPrice?: string;
};
export function parseProtectionLegs(value: unknown): ProtectionLegInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2)
    throw createApiError(
      'INVALID_PROTECTION',
      'Provide one Stop Loss, Take Profit, or one of each.',
      400,
    );
  const seen = new Set<string>();
  return value
    .map((raw: unknown): ProtectionLegInput => {
      if (!raw || typeof raw !== 'object')
        throw createApiError(
          'INVALID_PROTECTION',
          'Invalid protection leg.',
          400,
        );
      const row = raw as Record<string, unknown>;
      if (
        (row.kind !== 'stop_loss' && row.kind !== 'take_profit') ||
        seen.has(row.kind)
      )
        throw createApiError(
          'INVALID_PROTECTION',
          'Duplicate or invalid protection kind.',
          400,
        );
      seen.add(row.kind);
      if (row.childOrderType !== 'market' && row.childOrderType !== 'limit')
        throw createApiError(
          'INVALID_PROTECTION',
          'Choose Market or Limit execution.',
          400,
        );
      if (row.childOrderType === 'market' && row.childLimitPrice != null)
        throw createApiError(
          'INVALID_PROTECTION',
          'Market child cannot have a limit price.',
          400,
        );
      return {
        kind: row.kind,
        triggerPrice: positivePrice(row.triggerPrice),
        childOrderType: row.childOrderType,
        ...(row.childOrderType === 'limit'
          ? { childLimitPrice: positivePrice(row.childLimitPrice) }
          : {}),
      };
    })
    .sort((a, b) => a.kind.localeCompare(b.kind));
}
function positivePrice(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^\d{1,16}(\.\d{1,8})?$/.test(value) ||
    new Prisma.Decimal(value).lte(0)
  )
    throw createApiError(
      'INVALID_PROTECTION_PRICE',
      'Price must be a positive decimal string with at most eight decimal places.',
      400,
    );
  return new Prisma.Decimal(value).toFixed(8);
}
export function conditionalKey(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{8,128}$/.test(value))
    throw createApiError(
      'INVALID_IDEMPOTENCY_KEY',
      'A valid idempotency key is required.',
      400,
    );
  return value;
}
export function conditionalHash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function isTriggered(
  direction: FuturesDirection,
  kind: ProtectionKind,
  price: Prisma.Decimal,
  trigger: Prisma.Decimal,
) {
  const below = (direction === 'long') === (kind === 'stop_loss');
  return below ? price.lte(trigger) : price.gte(trigger);
}
export function assertTriggerDirections(
  legs: ProtectionLegInput[],
  direction: FuturesDirection,
  price: Prisma.Decimal,
) {
  if (
    legs.some((leg) =>
      isTriggered(
        direction,
        leg.kind,
        price,
        new Prisma.Decimal(leg.triggerPrice),
      ),
    )
  )
    throw createApiError(
      'PROTECTION_ALREADY_TRIGGERED',
      'Trigger prices must be strictly beyond the current reference price.',
      409,
    );
}
