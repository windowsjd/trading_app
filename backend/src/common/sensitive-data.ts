export const REDACTED = '[REDACTED]';

/** Preserve the existing conservative Ops/audit storage rule. */
export function redactStoredText(value: string): string {
  return /^bearer\s+/iu.test(value.trim()) ||
    /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\//iu.test(value)
    ? REDACTED
    : redactSensitiveText(value);
}

/** Casing and separators are irrelevant to credential identity. */
export function isSecretKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/giu, '').toLowerCase();
  return /(?:password|authorization|cookie|credential|databaseurl|dburl|token|secret|apikey|appkey|authkey|approvalkey|privatekey)/u.test(
    normalized,
  );
}

export function isSensitiveDiagnosticKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/giu, '').toLowerCase();
  return (
    isSecretKey(key) ||
    /(?:rawpayload|providerpayload|rawbody|responsebody|bodytext|rawresponse|providerresponse)/u.test(
      normalized,
    )
  );
}

/** Redact assignments, not arbitrary prose; do not parse log text as JSON. */
export function redactSensitiveText(value: string): string {
  // JSON-stringified messages can contain another escaped JSON string. Its
  // value boundary is ambiguous; discard text containing an escaped secret field.
  for (const match of value.matchAll(
    /\\+["']([a-z0-9_. -]{1,256})\\+["']\s*[:=]/giu,
  )) {
    if (isSensitiveDiagnosticKey(match[1])) return REDACTED;
  }
  const bearerRedacted = value.replace(
    /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu,
    (match) => `${match.split(/\s/u)[0]} ${REDACTED}`,
  );
  const fields =
    /("(?:\\.|[^"\\]){0,256}"|'(?:\\.|[^'\\]){0,256}'|\b[a-z][\w.-]{0,127}(?:[ \t]+[a-z][\w.-]{0,127}){0,3})(\s*[:=]\s*)/giu;
  // Raw payloads may be nested JSON or multiline text. Drop the whole string
  // instead of trying to delimit an untrusted body with a regular expression.
  let redacted = '';
  let cursor = 0;
  for (const match of bearerRedacted.matchAll(fields)) {
    if (match.index < cursor) continue;
    const key = match[1].replace(/^["']|["']$/gu, '');
    if (isSensitiveDiagnosticKey(key) && !isSecretKey(key)) return REDACTED;
    if (!isSecretKey(key)) continue;
    const valueStart = match.index + match[0].length;
    const remaining = bearerRedacted.slice(valueStart);
    if (remaining.startsWith('{') || remaining.startsWith('[')) return REDACTED;
    const assignedValue =
      /^("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/u.exec(remaining)?.[0];
    if (!assignedValue) continue;
    redacted += `${bearerRedacted.slice(cursor, valueStart)}"${REDACTED}"`;
    cursor = valueStart + assignedValue.length;
  }
  return (redacted + bearerRedacted.slice(cursor))
    .replace(
      /-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END (?:[A-Z ]*PRIVATE KEY)-----/gu,
      REDACTED,
    )
    .replace(
      /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s'"}]+/giu,
      '[REDACTED_DATABASE_URL]',
    );
}
