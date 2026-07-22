import { AssetType, CurrencyCode, Prisma } from '../../generated/prisma/client';
import type { LimitOrderPriceEvent } from './limit-order-price-event.types';

export class LimitOrderEventValidationError extends Error {
  readonly code = 'LIMIT_ORDER_EVENT_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'LimitOrderEventValidationError';
  }
}

export function parseLimitOrderPriceEvent(value: string): LimitOrderPriceEvent {
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
  for (const field of ['providerEventAt', 'receivedAt', 'publishedAt']) {
    const value = event[field] as string;
    const timestamp = new Date(value);
    if (
      Number.isNaN(timestamp.getTime()) ||
      timestamp.toISOString() !== value
    ) {
      invalid(field);
    }
  }
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
