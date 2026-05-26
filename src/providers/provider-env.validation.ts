import { ProviderConfigError, type ProviderId } from './provider.types';

export type ProviderEnv = Record<string, string | undefined>;

export function readOptionalTrimmedEnv(
  env: ProviderEnv,
  name: string,
): string | undefined {
  const value = env[name];
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function readBooleanEnv(
  env: ProviderEnv,
  name: string,
  defaultValue: boolean,
  provider: ProviderId | 'common',
): boolean {
  const value = readOptionalTrimmedEnv(env, name);
  if (value === undefined) {
    return defaultValue;
  }

  if (value === 'true' || value === '1') {
    return true;
  }

  if (value === 'false' || value === '0') {
    return false;
  }

  throw new ProviderConfigError(
    provider,
    'INVALID_BOOLEAN_ENV',
    `${name} must be true, false, 1, or 0.`,
  );
}

export function readPositiveIntegerEnv(
  env: ProviderEnv,
  name: string,
  defaultValue: number,
  provider: ProviderId | 'common',
): number {
  const value = readOptionalTrimmedEnv(env, name);
  if (value === undefined) {
    return defaultValue;
  }

  if (!/^\d+$/.test(value)) {
    throw new ProviderConfigError(
      provider,
      'INVALID_INTEGER_ENV',
      `${name} must be a positive integer.`,
    );
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ProviderConfigError(
      provider,
      'INVALID_INTEGER_ENV',
      `${name} must be a positive integer.`,
    );
  }

  return parsed;
}

export function requireEnv(
  env: ProviderEnv,
  name: string,
  provider: ProviderId,
): string {
  const value = readOptionalTrimmedEnv(env, name);
  if (value === undefined) {
    throw new ProviderConfigError(
      provider,
      'REQUIRED_ENV_MISSING',
      `${name} is required when ${provider} is enabled.`,
    );
  }

  return value;
}

export function readCsvEnv(env: ProviderEnv, name: string): string[] {
  const value = readOptionalTrimmedEnv(env, name);
  if (value === undefined) {
    return [];
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function normalizeUppercaseCsv(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of values) {
    const text = value.trim().toUpperCase();
    if (!text || seen.has(text)) {
      continue;
    }

    seen.add(text);
    normalized.push(text);
  }

  return normalized;
}
