import { AssetType, Prisma } from '../generated/prisma/client';

export const DEFAULT_QUOTE_TTL_SECONDS = 10;

export const REALTIME_EXECUTION_ERROR_CODES = {
  QUOTE_EXPIRED: 'QUOTE_EXPIRED',
  PRICE_CHANGED_REQUOTE_REQUIRED: 'PRICE_CHANGED_REQUOTE_REQUIRED',
  ORDER_LIMIT_NOT_MARKETABLE: 'ORDER_LIMIT_NOT_MARKETABLE',
  EXECUTION_PROVIDER_REQUIRED: 'EXECUTION_PROVIDER_REQUIRED',
} as const;

export type RealtimeExecutionErrorCode =
  (typeof REALTIME_EXECUTION_ERROR_CODES)[keyof typeof REALTIME_EXECUTION_ERROR_CODES];

export type RealtimeExecutionValidationResult =
  | {
      ok: true;
      changeBps?: Prisma.Decimal;
    }
  | {
      ok: false;
      errorCode: RealtimeExecutionErrorCode;
      changeBps?: Prisma.Decimal;
    };

export type RealtimeExecutionSide = 'buy' | 'sell';

export type RealtimeExecutionPolicySubject =
  | {
      quoteType: 'fx';
      baseCurrency: 'USD';
      quoteCurrency: 'KRW';
    }
  | {
      quoteType: 'order';
      assetType: AssetType | `${AssetType}`;
      market: string;
    };

export class RealtimeExecutionPolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function calculateChangeBps(
  quotedValue: Prisma.Decimal | string,
  executionValue: Prisma.Decimal | string,
): Prisma.Decimal {
  const quoted = toDecimal(quotedValue, 'quotedValue');
  const execution = toDecimal(executionValue, 'executionValue');

  if (quoted.lte(0)) {
    throw new RealtimeExecutionPolicyError(
      'INVALID_QUOTED_VALUE',
      'quotedValue must be greater than 0.',
    );
  }

  return execution.sub(quoted).abs().div(quoted).mul(10_000);
}

export function isWithinMaxChangeBps(
  quotedValue: Prisma.Decimal | string,
  executionValue: Prisma.Decimal | string,
  maxBps: Prisma.Decimal | string | number,
): boolean {
  const changeBps = calculateChangeBps(quotedValue, executionValue);
  const max = toDecimal(maxBps, 'maxBps');

  if (max.lt(0)) {
    throw new RealtimeExecutionPolicyError(
      'INVALID_MAX_BPS',
      'maxBps must be greater than or equal to 0.',
    );
  }

  return changeBps.lte(max);
}

export function resolveDefaultMaxChangeBps(
  subject: RealtimeExecutionPolicySubject,
): number {
  if (subject.quoteType === 'fx') {
    assertUsdKrwFx(subject);
    return 30;
  }

  const market = normalizeMarket(subject.market);

  if (
    subject.assetType === AssetType.domestic_stock &&
    isKrxMarketFamily(market)
  ) {
    return 30;
  }

  if (subject.assetType === AssetType.us_stock && isUsNasNysMarket(market)) {
    return 30;
  }

  if (subject.assetType === AssetType.crypto && market === 'BINANCE') {
    return 30;
  }

  throw new RealtimeExecutionPolicyError(
    'EXECUTION_SOURCE_INELIGIBLE',
    'No default max change bps is defined for this subject.',
  );
}

export function resolveExecuteFreshnessThresholdSeconds(
  subject: RealtimeExecutionPolicySubject,
): number {
  if (subject.quoteType === 'fx') {
    assertUsdKrwFx(subject);
    return 60;
  }

  const market = normalizeMarket(subject.market);

  if (
    subject.assetType === AssetType.domestic_stock &&
    isKrxMarketFamily(market)
  ) {
    return 10;
  }

  if (subject.assetType === AssetType.us_stock && isUsNasNysMarket(market)) {
    return 10;
  }

  if (subject.assetType === AssetType.crypto && market === 'BINANCE') {
    return 10;
  }

  throw new RealtimeExecutionPolicyError(
    'EXECUTION_SOURCE_INELIGIBLE',
    'No execute freshness threshold is defined for this subject.',
  );
}

export function validateMarketOrderExecutionPrice(input: {
  quotedPrice: Prisma.Decimal | string;
  executionPrice: Prisma.Decimal | string;
  maxChangeBps: Prisma.Decimal | string | number;
}): RealtimeExecutionValidationResult {
  const changeBps = calculateChangeBps(input.quotedPrice, input.executionPrice);
  const maxBps = toDecimal(input.maxChangeBps, 'maxChangeBps');

  if (changeBps.lte(maxBps)) {
    return {
      ok: true,
      changeBps,
    };
  }

  return {
    ok: false,
    errorCode: REALTIME_EXECUTION_ERROR_CODES.PRICE_CHANGED_REQUOTE_REQUIRED,
    changeBps,
  };
}

export function validateLimitOrderExecutionPrice(input: {
  side: RealtimeExecutionSide;
  limitPrice: Prisma.Decimal | string;
  executionPrice: Prisma.Decimal | string;
}): RealtimeExecutionValidationResult {
  const limitPrice = toDecimal(input.limitPrice, 'limitPrice');
  const executionPrice = toDecimal(input.executionPrice, 'executionPrice');
  const marketable =
    input.side === 'buy'
      ? executionPrice.lte(limitPrice)
      : executionPrice.gte(limitPrice);

  if (marketable) {
    return {
      ok: true,
    };
  }

  return {
    ok: false,
    errorCode: REALTIME_EXECUTION_ERROR_CODES.ORDER_LIMIT_NOT_MARKETABLE,
  };
}

export function validateQuoteExpiry(input: {
  now: Date;
  expiresAt: Date;
}): RealtimeExecutionValidationResult {
  if (input.now.getTime() <= input.expiresAt.getTime()) {
    return {
      ok: true,
    };
  }

  return {
    ok: false,
    errorCode: REALTIME_EXECUTION_ERROR_CODES.QUOTE_EXPIRED,
  };
}

export function validateExecutionProviderSource(input: {
  sourceType: 'provider_api' | 'admin_manual' | 'official_batch' | string | null;
}): RealtimeExecutionValidationResult {
  if (input.sourceType === 'provider_api') {
    return {
      ok: true,
    };
  }

  return {
    ok: false,
    errorCode: REALTIME_EXECUTION_ERROR_CODES.EXECUTION_PROVIDER_REQUIRED,
  };
}

function assertUsdKrwFx(subject: {
  baseCurrency: string;
  quoteCurrency: string;
}) {
  if (subject.baseCurrency === 'USD' && subject.quoteCurrency === 'KRW') {
    return;
  }

  throw new RealtimeExecutionPolicyError(
    'EXECUTION_SOURCE_INELIGIBLE',
    'Only USD/KRW FX has default realtime execution policy values.',
  );
}

function toDecimal(
  value: Prisma.Decimal | string | number,
  fieldName: string,
): Prisma.Decimal {
  try {
    const decimal =
      value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);

    if (!decimal.isFinite()) {
      throw new Error();
    }

    return decimal;
  } catch {
    throw new RealtimeExecutionPolicyError(
      'INVALID_DECIMAL',
      `${fieldName} must be a finite decimal.`,
    );
  }
}

function normalizeMarket(market: string): string {
  return market.trim().toUpperCase();
}

function isKrxMarketFamily(market: string): boolean {
  return (
    market === 'KRX' ||
    market === 'KOSPI' ||
    market === 'KOSDAQ' ||
    market === 'KONEX'
  );
}

function isUsNasNysMarket(market: string): boolean {
  return (
    market === 'NAS' ||
    market === 'NASDAQ' ||
    market === 'NYS' ||
    market === 'NYSE'
  );
}
