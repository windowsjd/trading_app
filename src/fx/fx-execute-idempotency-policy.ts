import { createHash } from 'node:crypto';
import { formatMoneyScale8, parsePositiveDecimalString } from './fx-decimal-policy';

export const fxExecuteRequestHashApiVersion = 'fx-execute:v1' as const;

export type FxExecuteCanonicalPayload = {
  apiVersion: typeof fxExecuteRequestHashApiVersion;
  userId: string;
  seasonParticipantId: string;
  fromCurrency: string;
  toCurrency: string;
  sourceAmount: string;
};

export type BuildFxExecuteCanonicalPayloadInput = {
  userId: string;
  seasonParticipantId: string;
  fromCurrency: string;
  toCurrency: string;
  sourceAmount: string;
  [ignoredField: string]: unknown;
};

export function buildFxExecuteCanonicalPayload(
  input: BuildFxExecuteCanonicalPayloadInput,
): FxExecuteCanonicalPayload {
  return {
    apiVersion: fxExecuteRequestHashApiVersion,
    userId: normalizeRequiredString(input.userId, 'userId'),
    seasonParticipantId: normalizeRequiredString(
      input.seasonParticipantId,
      'seasonParticipantId',
    ),
    fromCurrency: normalizeCurrency(input.fromCurrency, 'fromCurrency'),
    toCurrency: normalizeCurrency(input.toCurrency, 'toCurrency'),
    sourceAmount: formatMoneyScale8(
      parsePositiveDecimalString(input.sourceAmount),
    ),
  };
}

export function serializeFxExecuteCanonicalPayload(
  payload: FxExecuteCanonicalPayload,
): string {
  return JSON.stringify(payload);
}

export function computeFxExecuteRequestHash(
  input: BuildFxExecuteCanonicalPayloadInput,
): string {
  const canonicalPayload = buildFxExecuteCanonicalPayload(input);
  const canonicalJson = serializeFxExecuteCanonicalPayload(canonicalPayload);

  return createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}

function normalizeRequiredString(value: string, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} is required`);
  }

  return value.trim();
}

function normalizeCurrency(value: string, fieldName: string): string {
  return normalizeRequiredString(value, fieldName).toUpperCase();
}
