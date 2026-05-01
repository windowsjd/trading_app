import {
  CurrencyCode,
  FxRateSourceType,
  Prisma,
} from '../generated/prisma/client';

export type AdminFxRateInputArgs = {
  rate?: string;
  sourceName?: string;
  effectiveAt?: string;
  capturedAt?: string;
  sourceTimestamp?: string;
  approvedByUserId?: string;
  note?: string;
  rawPayloadJson?: string;
  dryRun?: boolean;
};

export type AdminFxRateSnapshotPayload = {
  baseCurrency: CurrencyCode;
  quoteCurrency: CurrencyCode;
  rate: string;
  sourceType: FxRateSourceType;
  sourceName: string;
  sourceTimestamp?: Date;
  effectiveAt: Date;
  capturedAt: Date;
  rawPayloadJson?: unknown;
  approvedByUserId?: string;
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

const MAX_FX_RATE_DECIMAL = new Prisma.Decimal('9999999999.99999999');

export function buildAdminFxRateSnapshotPayload(
  args: AdminFxRateInputArgs,
  now = new Date(),
): AdminFxRateSnapshotPayload {
  const rate = parseRate(args.rate);
  const sourceName = parseRequiredText(args.sourceName, 'source-name');
  const effectiveAt = parseDate(args.effectiveAt, 'effective-at');
  const capturedAt = args.capturedAt
    ? parseDate(args.capturedAt, 'captured-at')
    : now;
  const sourceTimestamp = args.sourceTimestamp
    ? parseDate(args.sourceTimestamp, 'source-timestamp')
    : undefined;
  const approvedByUserId = parseOptionalText(args.approvedByUserId);
  const note = parseOptionalText(args.note);
  const rawPayloadJson = parseRawPayloadJson(args.rawPayloadJson);

  assertNoForbiddenTerms('source-name', sourceName);
  assertNoForbiddenTerms('note', note);
  assertNoForbiddenTerms('raw-payload-json', args.rawPayloadJson);

  return {
    baseCurrency: CurrencyCode.USD,
    quoteCurrency: CurrencyCode.KRW,
    rate: rate.toFixed(8),
    sourceType: FxRateSourceType.admin_manual,
    sourceName,
    sourceTimestamp,
    effectiveAt,
    capturedAt,
    rawPayloadJson,
    approvedByUserId,
    note,
  };
}

function parseRate(value: string | undefined): Prisma.Decimal {
  const text = parseRequiredText(value, 'rate');

  try {
    const decimal = new Prisma.Decimal(text);

    if (!decimal.isFinite() || decimal.lte(0)) {
      throw new Error('rate must be greater than 0.');
    }

    if (decimal.decimalPlaces() > 8) {
      throw new Error('rate must fit Decimal(18, 8) scale.');
    }

    if (decimal.gt(MAX_FX_RATE_DECIMAL)) {
      throw new Error('rate must fit Decimal(18, 8) precision.');
    }

    return decimal;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Invalid rate: ${error.message}`);
    }

    throw new Error('Invalid rate.');
  }
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
  const date = new Date(text);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid --${fieldName}: must be a valid UTC ISO date.`);
  }

  return date;
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
