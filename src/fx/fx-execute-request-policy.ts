import { formatMoneyScale8, parsePositiveDecimalString } from './fx-decimal-policy';
import {
  computeFxExecuteRequestHash,
  type BuildFxExecuteCanonicalPayloadInput,
} from './fx-execute-idempotency-policy';
import {
  fxExecuteErrorCodes,
  type FxExecuteErrorCode,
} from './fx-execute-error-policy';

export type FxExecuteCurrency = 'KRW' | 'USD';

export type FxExecuteRequestBodyLike = {
  fromCurrency?: unknown;
  toCurrency?: unknown;
  sourceAmount?: unknown;
  idempotencyKey?: unknown;
};

export type FxExecuteRequestContextLike = {
  userId: string;
  seasonParticipantId: string;
};

export type NormalizedFxExecuteRequest = {
  userId: string;
  seasonParticipantId: string;
  fromCurrency: FxExecuteCurrency;
  toCurrency: FxExecuteCurrency;
  sourceAmount: string;
  idempotencyKey: string;
  requestHash: string;
};

export type FxExecuteRequestPreflightResult =
  | { ok: true; value: NormalizedFxExecuteRequest }
  | { ok: false; errorCode: FxExecuteErrorCode };

export function preflightFxExecuteRequest(
  body: FxExecuteRequestBodyLike,
  context: FxExecuteRequestContextLike,
): FxExecuteRequestPreflightResult {
  const userId = assertRequiredContextString(context.userId, 'userId');
  const seasonParticipantId = assertRequiredContextString(
    context.seasonParticipantId,
    'seasonParticipantId',
  );

  const idempotencyKey = parseIdempotencyKey(body.idempotencyKey);

  if (!idempotencyKey) {
    return { ok: false, errorCode: fxExecuteErrorCodes.IDEMPOTENCY_REQUIRED };
  }

  const currencyPair = parseExecuteCurrencyPair(
    body.fromCurrency,
    body.toCurrency,
  );

  if (!currencyPair) {
    return { ok: false, errorCode: fxExecuteErrorCodes.INVALID_CURRENCY_PAIR };
  }

  const sourceAmount = parseCanonicalSourceAmount(body.sourceAmount);

  if (!sourceAmount) {
    return { ok: false, errorCode: fxExecuteErrorCodes.INVALID_AMOUNT };
  }

  const hashInput: BuildFxExecuteCanonicalPayloadInput = {
    userId,
    seasonParticipantId,
    fromCurrency: currencyPair.fromCurrency,
    toCurrency: currencyPair.toCurrency,
    sourceAmount,
  };

  const requestHash = computeFxExecuteRequestHash(hashInput);

  return {
    ok: true,
    value: {
      userId,
      seasonParticipantId,
      fromCurrency: currencyPair.fromCurrency,
      toCurrency: currencyPair.toCurrency,
      sourceAmount,
      idempotencyKey,
      requestHash,
    },
  };
}

function assertRequiredContextString(value: string, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} is required`);
  }

  return value.trim();
}

function parseIdempotencyKey(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  return trimmed === '' ? null : trimmed;
}

function parseExecuteCurrencyPair(
  fromCurrencyValue: unknown,
  toCurrencyValue: unknown,
): Pick<NormalizedFxExecuteRequest, 'fromCurrency' | 'toCurrency'> | null {
  const fromCurrency = parseFxExecuteCurrency(fromCurrencyValue);
  const toCurrency = parseFxExecuteCurrency(toCurrencyValue);

  if (!fromCurrency || !toCurrency || fromCurrency === toCurrency) {
    return null;
  }

  return {
    fromCurrency,
    toCurrency,
  };
}

function parseFxExecuteCurrency(value: unknown): FxExecuteCurrency | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toUpperCase();

  return normalized === 'KRW' || normalized === 'USD' ? normalized : null;
}

function parseCanonicalSourceAmount(value: unknown): string | null {
  try {
    return formatMoneyScale8(parsePositiveDecimalString(value));
  } catch {
    return null;
  }
}
