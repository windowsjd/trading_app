const REDACTED = '[REDACTED]';

const SECRET_KEY_PATTERN =
  /(api[_-]?key|app[_-]?key|app[_-]?secret|secret|token|authorization|approval[_-]?key|access[_-]?token)/i;

export type RedactionOptions = {
  secrets?: readonly (string | undefined | null)[];
};

export function collectProviderSecretsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return [
    env.EXCHANGE_RATE_API_KEY,
    env.KIS_APP_KEY,
    env.KIS_APP_SECRET,
  ].filter((value): value is string => Boolean(value && value.trim()));
}

export function redactText(text: string, options: RedactionOptions = {}): string {
  let result = text;

  for (const secret of normalizeSecrets(options.secrets)) {
    result = result.split(secret).join(REDACTED);
  }

  return result;
}

export function redactJsonValue<T>(value: T, options: RedactionOptions = {}): T {
  return redactJsonValueInternal(value, normalizeSecrets(options.secrets)) as T;
}

function redactJsonValueInternal(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') {
    return redactText(value, { secrets });
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValueInternal(item, secrets));
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEY_PATTERN.test(key)
          ? REDACTED
          : redactJsonValueInternal(item, secrets),
      ]),
    );
  }

  return value;
}

function normalizeSecrets(
  secrets: readonly (string | undefined | null)[] | undefined,
): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of secrets ?? []) {
    const secret = value?.trim();
    if (!secret || seen.has(secret)) {
      continue;
    }

    seen.add(secret);
    normalized.push(secret);
  }

  return normalized;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === '[object Object]'
  );
}
