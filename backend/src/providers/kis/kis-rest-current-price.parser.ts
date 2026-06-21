import { CurrencyCode, Prisma } from '../../generated/prisma/client';
import { ProviderHttpError } from '../provider.types';
import type { KisRestCurrentPriceQuote } from './kis-rest-current-price.types';
import { normalizeKisUsMarketCode } from './kis-websocket.subscription';

export function parseKisDomesticCurrentPriceResponse(
  response: unknown,
  receivedAt: Date,
  requestedSymbol: string,
): KisRestCurrentPriceQuote {
  assertKisRestSuccess(response);
  const output = readOutput(response);
  const symbol =
    readString(output, 'stck_shrn_iscd', 'STCK_SHRN_ISCD', 'mksc_shrn_iscd') ??
    requestedSymbol.trim().toUpperCase();
  const price = readPositiveDecimal(
    readString(output, 'stck_prpr', 'STCK_PRPR', 'price'),
    'stck_prpr',
  );
  const sourceTimestamp = parseKstTimestamp(
    readString(output, 'stck_bsop_date', 'STCK_BSOP_DATE', 'bsop_date'),
    readString(output, 'stck_cntg_hour', 'STCK_CNTG_HOUR', 'cntg_hour'),
  );

  if (!/^\d{6}$/u.test(symbol)) {
    throw new ProviderHttpError(
      'kis',
      'INVALID_KIS_DOMESTIC_SYMBOL',
      'KIS domestic current-price symbol must be a 6-digit stock code.',
    );
  }

  return {
    kind: 'domestic_krx_current_price',
    providerSymbol: symbol,
    symbol,
    marketCode: 'KRX',
    currencyCode: CurrencyCode.KRW,
    price,
    sourceTimestamp,
    effectiveAt: sourceTimestamp ?? receivedAt,
  };
}

export function parseKisUsCurrentPriceResponse(
  response: unknown,
  receivedAt: Date,
  requestedSymbol: string,
  requestedMarketCode: string,
): KisRestCurrentPriceQuote {
  assertKisRestSuccess(response);
  const output = readOutput(response);
  const symbol = (
    readString(output, 'symb', 'SYMB', 'rsym', 'RSYM') ?? requestedSymbol
  )
    .replace(/^D(?:NAS|NYS|AMS)/u, '')
    .trim()
    .toUpperCase();
  const marketCode =
    normalizeKisUsMarketCode(readString(output, 'mtyp', 'MTYP')) ??
    normalizeKisUsMarketCode(requestedMarketCode);
  const price = readPositiveDecimal(
    readString(output, 'last', 'LAST', 'price', 'close'),
    'last',
  );
  const sourceTimestamp =
    parseKstTimestamp(
      readString(output, 'kymd', 'KYMD'),
      readString(output, 'khms', 'KHMS'),
    ) ??
    parseKstTimestamp(
      readString(output, 'xymd', 'XYMD'),
      readString(output, 'xhms', 'XHMS'),
    );

  if (!symbol) {
    throw new ProviderHttpError(
      'kis',
      'INVALID_KIS_US_SYMBOL',
      'KIS US current-price symbol is missing.',
    );
  }

  if (!marketCode) {
    throw new ProviderHttpError(
      'kis',
      'US_MARKET_NOT_ALLOWED',
      'KIS US current-price market code is not allowed.',
    );
  }

  return {
    kind: 'us_current_price',
    providerSymbol: `${marketCode}:${symbol}`,
    symbol,
    marketCode,
    currencyCode: CurrencyCode.USD,
    price,
    sourceTimestamp,
    effectiveAt: sourceTimestamp ?? receivedAt,
  };
}

function assertKisRestSuccess(response: unknown): void {
  const body = asRecord(response);
  const code = readString(body, 'rt_cd', 'RT_CD');
  if (code !== null && code !== '0') {
    throw new ProviderHttpError(
      'kis',
      'KIS_RESPONSE_NOT_SUCCESS',
      'KIS REST response was not successful.',
    );
  }
}

function readOutput(response: unknown): Record<string, unknown> {
  const body = asRecord(response);
  const output = body.output ?? body.output1;
  if (!isRecord(output)) {
    throw new ProviderHttpError(
      'kis',
      'KIS_OUTPUT_MISSING',
      'KIS REST response does not include output.',
    );
  }

  return output;
}

function readPositiveDecimal(value: string | null, fieldName: string): string {
  if (value === null) {
    throw new ProviderHttpError(
      'kis',
      'KIS_PRICE_MISSING',
      `${fieldName} is required.`,
    );
  }

  try {
    const decimal = new Prisma.Decimal(value.replace(/,/g, ''));
    if (!decimal.isFinite() || decimal.lte(0)) {
      throw new Error();
    }

    return decimal.toFixed(8);
  } catch {
    throw new ProviderHttpError(
      'kis',
      'INVALID_DECIMAL',
      `${fieldName} must be a positive decimal.`,
    );
  }
}

function parseKstTimestamp(
  dateText: string | null,
  timeText: string | null,
): Date | null {
  const date = normalizeKisDate(dateText);
  const time = timeText?.trim() ?? '';
  if (!/^\d{8}$/u.test(date) || !/^\d{6}$/u.test(time)) {
    return null;
  }

  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(4, 6));
  const day = Number(date.slice(6, 8));
  const hour = Number(time.slice(0, 2));
  const minute = Number(time.slice(2, 4));
  const second = Number(time.slice(4, 6));

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }

  return new Date(Date.UTC(year, month - 1, day, hour - 9, minute, second));
}

function normalizeKisDate(dateText: string | null): string {
  const value = dateText?.trim() ?? '';
  if (/^\d{6}$/u.test(value)) {
    return `20${value}`;
  }

  return value;
}

function readString(
  record: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }

  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ProviderHttpError(
      'kis',
      'KIS_MALFORMED_RESPONSE',
      'KIS REST response must be an object.',
    );
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === '[object Object]'
  );
}
