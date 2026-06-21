import { CurrencyCode, Prisma } from '../../generated/prisma/client';
import { ProviderHttpError } from '../provider.types';
import type { KisRestHogaSnapshot } from './kis-rest-hoga.types';
import { normalizeKisUsMarketCode } from './kis-websocket.subscription';

export function parseKisDomesticHogaResponse(
  response: unknown,
  receivedAt: Date,
  requestedSymbol: string,
): KisRestHogaSnapshot {
  assertKisRestSuccess(response);
  const output = readOutput(response);
  const symbol =
    readString(output, 'stck_shrn_iscd', 'STCK_SHRN_ISCD', 'mksc_shrn_iscd') ??
    requestedSymbol.trim().toUpperCase();
  const bidPrice = readPositiveDecimal(
    readString(output, 'bidp1', 'BIDP1', 'bid_price'),
    'bidp1',
  );
  const askPrice = readPositiveDecimal(
    readString(output, 'askp1', 'ASKP1', 'ask_price'),
    'askp1',
  );
  const bidQuantity = readOptionalPositiveDecimal(
    readString(output, 'bidp_rsqn1', 'BIDP_RSQN1', 'bid_quantity'),
    'bidp_rsqn1',
  );
  const askQuantity = readOptionalPositiveDecimal(
    readString(output, 'askp_rsqn1', 'ASKP_RSQN1', 'ask_quantity'),
    'askp_rsqn1',
  );
  const sourceTimestamp = parseKstTimestamp(
    readString(output, 'stck_bsop_date', 'STCK_BSOP_DATE', 'bsop_date'),
    readString(output, 'stck_cntg_hour', 'STCK_CNTG_HOUR', 'cntg_hour'),
  );

  if (!/^\d{6}$/u.test(symbol)) {
    throw new ProviderHttpError(
      'kis',
      'INVALID_KIS_DOMESTIC_SYMBOL',
      'KIS domestic hoga symbol must be a 6-digit stock code.',
    );
  }

  return buildSnapshot({
    kind: 'domestic_krx_hoga',
    providerSymbol: symbol,
    symbol,
    marketCode: 'KRX',
    currencyCode: CurrencyCode.KRW,
    bidPrice,
    bidQuantity,
    askPrice,
    askQuantity,
    sourceTimestamp,
    receivedAt,
  });
}

export function parseKisUsHogaResponse(
  response: unknown,
  receivedAt: Date,
  requestedSymbol: string,
  requestedMarketCode: string,
): KisRestHogaSnapshot {
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
  const bidPrice = readPositiveDecimal(
    readString(output, 'pbid', 'PBID', 'bid', 'bid_price'),
    'pbid',
  );
  const askPrice = readPositiveDecimal(
    readString(output, 'pask', 'PASK', 'ask', 'ask_price'),
    'pask',
  );
  const bidQuantity = readOptionalPositiveDecimal(
    readString(output, 'vbid', 'VBID', 'bid_quantity'),
    'vbid',
  );
  const askQuantity = readOptionalPositiveDecimal(
    readString(output, 'vask', 'VASK', 'ask_quantity'),
    'vask',
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
      'KIS US hoga symbol is missing.',
    );
  }

  if (!marketCode) {
    throw new ProviderHttpError(
      'kis',
      'US_MARKET_NOT_ALLOWED',
      'KIS US hoga market code is not allowed.',
    );
  }

  return buildSnapshot({
    kind: 'us_hoga',
    providerSymbol: `${marketCode}:${symbol}`,
    symbol,
    marketCode,
    currencyCode: CurrencyCode.USD,
    bidPrice,
    bidQuantity,
    askPrice,
    askQuantity,
    sourceTimestamp,
    receivedAt,
  });
}

function buildSnapshot(input: {
  kind: 'domestic_krx_hoga' | 'us_hoga';
  providerSymbol: string;
  symbol: string;
  marketCode: string | null;
  currencyCode: CurrencyCode;
  bidPrice: string;
  bidQuantity: string | null;
  askPrice: string;
  askQuantity: string | null;
  sourceTimestamp: Date | null;
  receivedAt: Date;
}): KisRestHogaSnapshot {
  const bid = new Prisma.Decimal(input.bidPrice);
  const ask = new Prisma.Decimal(input.askPrice);
  if (ask.lt(bid)) {
    throw new ProviderHttpError(
      'kis',
      'INVALID_ORDERBOOK_SPREAD',
      'KIS hoga ask price must be greater than or equal to bid price.',
    );
  }

  const mid = bid.plus(ask).div(2);
  const spreadBps = ask.minus(bid).div(mid).mul(10_000).toFixed(8);

  return {
    kind: input.kind,
    providerSymbol: input.providerSymbol,
    symbol: input.symbol,
    marketCode: input.marketCode,
    currencyCode: input.currencyCode,
    bidPrice: input.bidPrice,
    bidQuantity: input.bidQuantity,
    askPrice: input.askPrice,
    askQuantity: input.askQuantity,
    spreadBps,
    sourceTimestamp: input.sourceTimestamp,
    effectiveAt: input.sourceTimestamp ?? input.receivedAt,
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
  const output = body.output1 ?? body.output;
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
      'KIS_HOGA_PRICE_MISSING',
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

function readOptionalPositiveDecimal(
  value: string | null,
  fieldName: string,
): string | null {
  if (value === null) {
    return null;
  }

  try {
    const decimal = new Prisma.Decimal(value.replace(/,/g, ''));
    if (!decimal.isFinite() || decimal.lt(0)) {
      throw new Error();
    }

    return decimal.toFixed(8);
  } catch {
    throw new ProviderHttpError(
      'kis',
      'INVALID_DECIMAL',
      `${fieldName} must be a non-negative decimal.`,
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
