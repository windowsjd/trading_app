import {
  AssetPriceSourceType,
  AssetType,
  CurrencyCode,
  Prisma,
} from '../generated/prisma/client';

export type AdminAssetInputArgs = {
  symbol?: string;
  name?: string;
  market?: string;
  currencyCode?: string;
  assetType?: string;
  isActive?: string;
  dryRun?: boolean;
};

export type AdminAssetUpsertPayload = {
  symbol: string;
  name: string;
  market: string;
  currencyCode: CurrencyCode;
  assetType: AssetType;
  isActive: boolean;
};

export type AdminAssetPriceInputArgs = {
  assetId?: string;
  symbol?: string;
  market?: string;
  price?: string;
  currencyCode?: string;
  sourceType?: string;
  sourceName?: string;
  effectiveAt?: string;
  capturedAt?: string;
  sourceTimestamp?: string;
  note?: string;
  rawPayloadJson?: string;
  dryRun?: boolean;
};

export type AdminAssetPriceAssetCandidate = {
  id: string;
  symbol: string;
  market: string;
  currencyCode: CurrencyCode;
  isActive: boolean;
};

export type AdminAssetPriceSnapshotPayload = {
  assetId?: string;
  symbol?: string;
  market?: string;
  price: string;
  currencyCode: CurrencyCode;
  sourceType: AssetPriceSourceType;
  sourceName: string;
  sourceTimestamp?: Date;
  effectiveAt: Date;
  capturedAt: Date;
  rawPayloadJson?: unknown;
  note?: string;
};

const FORBIDDEN_INPUT_TERMS = [
  'fake',
  'static',
  'temporary',
  'sample',
  'placeholder',
  'test',
] as const;

const MAX_DECIMAL_24_8 = new Prisma.Decimal('9999999999999999.99999999');
const UTC_ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UTC_ISO_TIMESTAMP_EXAMPLE = '2026-05-01T00:00:00.000Z';

export function buildAdminAssetUpsertPayload(
  args: AdminAssetInputArgs,
): AdminAssetUpsertPayload {
  const symbol = parseRequiredText(args.symbol, 'symbol');
  const name = parseRequiredText(args.name, 'name');
  const market = parseRequiredText(args.market, 'market');
  const currencyCode = parseCurrencyCode(args.currencyCode);
  const assetType = parseAssetType(args.assetType);
  const isActive = parseBoolean(args.isActive, 'is-active', true);

  assertNoForbiddenTerms('symbol', symbol);
  assertNoForbiddenTerms('name', name);
  assertNoForbiddenTerms('market', market);

  return {
    symbol,
    name,
    market,
    currencyCode,
    assetType,
    isActive,
  };
}

export function buildAdminAssetPriceSnapshotPayload(
  args: AdminAssetPriceInputArgs,
  asset?: AdminAssetPriceAssetCandidate,
  now = new Date(),
): AdminAssetPriceSnapshotPayload {
  const assetId = parseOptionalText(args.assetId);
  const symbol = parseOptionalText(args.symbol);
  const market = parseOptionalText(args.market);

  if (!assetId && (!symbol || !market)) {
    throw new Error('Provide either --asset-id or both --market and --symbol.');
  }

  if (assetId && (symbol || market)) {
    throw new Error('Use either --asset-id or --market/--symbol, not both.');
  }

  const price = parsePrice(args.price);
  const currencyCode = parseCurrencyCode(args.currencyCode);
  const sourceType = parseAssetPriceSourceType(args.sourceType);
  const sourceName = parseRequiredText(args.sourceName, 'source-name');
  const effectiveAt = args.effectiveAt
    ? parseDate(args.effectiveAt, 'effective-at')
    : now;
  const capturedAt = args.capturedAt
    ? parseDate(args.capturedAt, 'captured-at')
    : now;
  const sourceTimestamp = args.sourceTimestamp
    ? parseDate(args.sourceTimestamp, 'source-timestamp')
    : undefined;
  const note = parseOptionalText(args.note);
  const rawPayloadJson = parseRawPayloadJson(args.rawPayloadJson);

  assertNoForbiddenTerms('source-name', sourceName);
  assertNoForbiddenTerms('note', note);
  assertNoForbiddenTerms('raw-payload-json', args.rawPayloadJson);

  if (asset) {
    assertUsableAssetForPriceInput(asset, currencyCode);
  }

  return {
    assetId,
    symbol,
    market,
    price: price.toFixed(8),
    currencyCode,
    sourceType,
    sourceName,
    sourceTimestamp,
    effectiveAt,
    capturedAt,
    rawPayloadJson,
    note,
  };
}

export function assertUsableAssetForPriceInput(
  asset: AdminAssetPriceAssetCandidate,
  priceCurrencyCode: CurrencyCode,
) {
  if (!asset.isActive) {
    throw new Error('Asset is inactive.');
  }

  if (asset.currencyCode !== priceCurrencyCode) {
    throw new Error(
      `Asset currency ${asset.currencyCode} does not match price currency ${priceCurrencyCode}.`,
    );
  }
}

function parseCurrencyCode(value: string | undefined): CurrencyCode {
  const text = parseRequiredText(value, 'currency-code');

  if (isEnumValue(CurrencyCode, text)) {
    return text;
  }

  throw new Error(`Invalid --currency-code: ${text}.`);
}

function parseAssetType(value: string | undefined): AssetType {
  const text = parseRequiredText(value, 'asset-type');

  if (isEnumValue(AssetType, text)) {
    return text;
  }

  throw new Error(`Invalid --asset-type: ${text}.`);
}

function parseAssetPriceSourceType(
  value: string | undefined,
): AssetPriceSourceType {
  const text = parseOptionalText(value) ?? AssetPriceSourceType.admin_manual;

  if (text !== AssetPriceSourceType.admin_manual) {
    throw new Error('Only --source-type admin_manual is allowed.');
  }

  return AssetPriceSourceType.admin_manual;
}

function parsePrice(value: string | undefined): Prisma.Decimal {
  const text = parseRequiredText(value, 'price');

  try {
    const decimal = new Prisma.Decimal(text);

    if (!decimal.isFinite() || decimal.lte(0)) {
      throw new Error('price must be greater than 0.');
    }

    if (decimal.decimalPlaces() > 8) {
      throw new Error('price must fit Decimal(24, 8) scale.');
    }

    if (decimal.gt(MAX_DECIMAL_24_8)) {
      throw new Error('price must fit Decimal(24, 8) precision.');
    }

    return decimal;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Invalid price: ${error.message}`);
    }

    throw new Error('Invalid price.');
  }
}

function parseBoolean(
  value: string | undefined,
  fieldName: string,
  defaultValue: boolean,
): boolean {
  const text = parseOptionalText(value);

  if (text === undefined) {
    return defaultValue;
  }

  if (text === 'true') {
    return true;
  }

  if (text === 'false') {
    return false;
  }

  throw new Error(`Invalid --${fieldName}: must be true or false.`);
}

function parseRequiredText(
  value: string | undefined,
  fieldName: string,
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing or empty --${fieldName}.`);
  }

  return value.trim();
}

function parseOptionalText(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed === '' ? undefined : trimmed;
}

function parseDate(value: string | undefined, fieldName: string): Date {
  const text = parseRequiredText(value, fieldName);

  if (!UTC_ISO_TIMESTAMP_PATTERN.test(text)) {
    throwInvalidTimestamp(fieldName);
  }

  const date = new Date(text);

  if (Number.isNaN(date.getTime()) || date.toISOString() !== text) {
    throwInvalidTimestamp(fieldName);
  }

  return date;
}

function throwInvalidTimestamp(fieldName: string): never {
  throw new Error(
    `Invalid --${fieldName}: must be UTC ISO timestamp like ${UTC_ISO_TIMESTAMP_EXAMPLE}.`,
  );
}

function parseRawPayloadJson(value: string | undefined): unknown {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch {
    throw new Error('Invalid --raw-payload-json: must be valid JSON.');
  }
}

function assertNoForbiddenTerms(
  fieldName: string,
  value: string | undefined,
) {
  if (!value) {
    return;
  }

  const normalized = value.toLowerCase();
  const term = FORBIDDEN_INPUT_TERMS.find((candidate) =>
    normalized.includes(candidate),
  );

  if (term) {
    throw new Error(`Invalid --${fieldName}: contains forbidden term "${term}".`);
  }
}

function isEnumValue<T extends Record<string, string>>(
  enumObject: T,
  value: string,
): value is T[keyof T] {
  return Object.values(enumObject).includes(value);
}
