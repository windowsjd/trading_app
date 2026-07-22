import { AssetType, CurrencyCode, Prisma } from '../../generated/prisma/client';
import type { LimitOrderPriceEvent } from './limit-order-price-event.types';

export class LimitOrderEventValidationError extends Error {
  readonly code = 'LIMIT_ORDER_EVENT_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'LimitOrderEventValidationError';
  }
}

/**
 * Absolute sanity bound for provider/publisher timestamps. This is NOT a
 * clock-skew tolerance used to decide order eligibility — ordering is decided
 * purely by Redis Stream IDs. It only rejects timestamps that are obviously
 * broken (a feed stamping events hours into the future), which would otherwise
 * corrupt audit records and session checks.
 */
export const LIMIT_ORDER_EVENT_MAX_FUTURE_SKEW_MS = 60_000;

export function parseLimitOrderPriceEvent(
  value: string,
  now: Date = new Date(),
): LimitOrderPriceEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new LimitOrderEventValidationError(
      'Event payload is not valid JSON.',
    );
  }
  if (!raw || typeof raw !== 'object') {
    throw new LimitOrderEventValidationError(
      'Event payload must be an object.',
    );
  }
  const event = raw as Record<string, unknown>;
  requireEqual(event.schemaVersion, 1, 'schemaVersion');
  requireEqual(event.eventType, 'trade', 'eventType');
  if (event.provider !== 'kis' && event.provider !== 'binance') {
    invalid('provider');
  }
  for (const field of [
    'eventId',
    'assetId',
    'symbol',
    'market',
    'price',
    'providerEventAt',
    'receivedAt',
    'publishedAt',
    'sourceName',
  ]) {
    requireText(event[field], field);
  }
  if (!Object.values(AssetType).includes(event.assetType as AssetType)) {
    invalid('assetType');
  }
  if (
    !Object.values(CurrencyCode).includes(event.currencyCode as CurrencyCode)
  ) {
    invalid('currencyCode');
  }
  if (
    !(event.eventId as string).startsWith(
      `${event.provider as string}:${event.assetId as string}:`,
    )
  ) {
    invalid('eventId');
  }
  const timestamps: Record<string, number> = {};
  for (const field of ['providerEventAt', 'receivedAt', 'publishedAt']) {
    const value = event[field] as string;
    const timestamp = new Date(value);
    if (
      Number.isNaN(timestamp.getTime()) ||
      timestamp.toISOString() !== value
    ) {
      invalid(field);
    }
    timestamps[field] = timestamp.getTime();
  }
  // Obvious-invariant checks only. They never widen or narrow which orders an
  // event may fill — that is decided by the stream ID alone.
  const limit = now.getTime() + LIMIT_ORDER_EVENT_MAX_FUTURE_SKEW_MS;
  if (timestamps.providerEventAt > limit) invalid('providerEventAt');
  if (timestamps.receivedAt > limit) invalid('receivedAt');
  if (timestamps.publishedAt > limit) invalid('publishedAt');
  // The publisher stamps publishedAt after the source stamped receivedAt, on
  // the same process clock, so an inversion means a corrupted payload.
  if (timestamps.publishedAt < timestamps.receivedAt) invalid('publishedAt');
  try {
    const price = new Prisma.Decimal(event.price as string);
    if (!price.isFinite() || price.lte(0) || price.toFixed(8) !== event.price) {
      invalid('price');
    }
  } catch {
    invalid('price');
  }
  for (const field of [
    'providerConnectionId',
    'providerSequence',
    'marketSessionCode',
  ]) {
    if (event[field] !== null && typeof event[field] !== 'string')
      invalid(field);
  }
  return event as unknown as LimitOrderPriceEvent;
}

function requireEqual(actual: unknown, expected: unknown, field: string): void {
  if (actual !== expected) invalid(field);
}

function requireText(value: unknown, field: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 500)
    invalid(field);
}

function invalid(field: string): never {
  throw new LimitOrderEventValidationError(`Invalid ${field}.`);
}
