import type { AdminDiagnostic } from '../../src/common/admin-diagnostics';
import { safeDiagnosticMessage } from '../../src/common/safe-diagnostic-message';
import { sanitizeOpsJson } from '../../src/ops/ops-redaction';

/** Test/review policy only. Reports missing observations; never invents them. */
export function diagnosticQualityGaps(
  diagnostic: AdminDiagnostic | undefined,
  level: 'baseline' | 'triage',
): string[] {
  if (!diagnostic) return ['diagnostic'];
  const gaps: string[] = [];
  for (const field of [
    'code',
    'domain',
    'operation',
    'requestId',
    'failureStage',
  ] as const) {
    if (!diagnostic[field]) gaps.push(field);
  }
  if (!diagnostic.httpStatus || !diagnostic.exception.message)
    gaps.push('exception');
  if (level === 'baseline') return gaps;
  if (diagnostic.domain === 'HTTP') gaps.push('domain');
  if (/^(?:GET|POST|PUT|PATCH|DELETE)\s/u.test(diagnostic.operation))
    gaps.push('workflow operation');
  if (
    [
      'request_boundary',
      'request_processing',
      'request_validation',
      'backend_execution',
    ].includes(diagnostic.failureStage)
  ) {
    gaps.push('meaningful failureStage');
  }
  const evidence = diagnostic.evidence ?? {};
  const domainEvidence = Object.entries(evidence).some(
    ([key, value]) =>
      !['safeCause', 'failedStep', 'truncated'].includes(key) &&
      value !== null &&
      value !== undefined &&
      (typeof value !== 'object' || Object.keys(value).length > 0),
  );
  const cause = evidence.safeCause;
  const classifiedCause =
    cause &&
    typeof cause === 'object' &&
    !Array.isArray(cause) &&
    typeof cause.category === 'string' &&
    cause.category !== 'unexpected_error';
  if (!domainEvidence && !classifiedCause) gaps.push('observed evidence');
  // The code is an observed domain classification, not an inferred root cause.
  const classificationObserved = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(
      ([key, item]) =>
        (/(?:reason|category|result|state)$/iu.test(key) &&
          typeof item === 'string' &&
          item.length > 0) ||
        classificationObserved(item),
    );
  };
  if (!classifiedCause && !classificationObserved(evidence))
    gaps.push('safe failure category');
  if (
    !diagnostic.nextInvestigation?.some(
      (hint) =>
        /^backend\/(?:src|scripts)\/.+\.ts$/u.test(hint) &&
        hint !== 'backend/src/common/global-http-exception.filter.ts',
    )
  )
    gaps.push('nextInvestigation');
  return [...new Set(gaps)];
}

/** Code-specific contracts are required only for triage-level emitters. The
 * caller must exercise the actual production failure, not construct a payload.
 */
export function assertDiagnosticTriage(
  diagnostic: AdminDiagnostic | undefined,
  code: string,
  subject: string,
): void {
  const gaps = diagnosticQualityGaps(diagnostic, 'triage');
  if (diagnostic?.code !== code) gaps.push('expected code');
  if (gaps.length)
    throw new Error(
      `Diagnostic triage gaps for ${subject} (${code}): ${gaps.join(', ')}`,
    );
}

/** New route contracts assert observed workflow context, not guessed stages. */
export function assertDiagnosticBaseline(
  diagnostic: AdminDiagnostic | undefined,
  subject: string,
): void {
  const gaps = diagnosticQualityGaps(
    diagnostic,
    (diagnostic?.httpStatus ?? 0) >= 500 ? 'triage' : 'baseline',
  );
  if (diagnostic?.domain === 'HTTP') gaps.push('route domain');
  if (
    diagnostic &&
    (/^(?:GET|POST|PUT|PATCH|DELETE)\s/u.test(diagnostic.operation) ||
      /_REQUEST_(?:READ|REQUEST)$/u.test(diagnostic.operation))
  )
    gaps.push('workflow operation');
  if (
    !diagnostic?.nextInvestigation?.some(
      (hint) => hint !== 'backend/src/common/global-http-exception.filter.ts',
    )
  )
    gaps.push('route investigation target');
  if (gaps.length)
    throw new Error(`Diagnostic route gaps for ${subject}: ${gaps.join(', ')}`);
}

/** Public() routes use safe server logging, never an admin diagnostic bypass. */
export function assertPreAuthFailure(
  body: { error: { code: string; message: string; diagnostic?: unknown } },
  subject: string,
  logs: string[],
): void {
  if (body.error.diagnostic || !safeDiagnosticMessage(body.error.message))
    throw new Error(`Unsafe pre-auth response for ${subject}.`);
  const observed = logs.map(
    (log) => JSON.parse(log) as Record<string, unknown>,
  );
  if (
    !observed.some(
      (log) =>
        log.surface === 'pre_auth_http' &&
        log.code === body.error.code &&
        log.safeCause,
    )
  ) {
    throw new Error(
      `Missing safe pre-auth operational failure for ${subject}.`,
    );
  }
}

/** Separate Ops contract; does not apply HTTP financial-value restrictions. */
export function assertOpsFailure(
  result: {
    error?: { code: string; message: string; diagnostic?: unknown };
    data: { run: { resultJson?: unknown } };
  },
  code: string,
  subject: string,
): void {
  if (
    !result.error ||
    result.error.code !== code ||
    result.error.diagnostic ||
    !safeDiagnosticMessage(result.error.message)
  )
    throw new Error(`Unsafe Ops failure surface for ${subject}.`);
  const stored = result.data.run.resultJson;
  if (
    !stored ||
    JSON.stringify(stored) !== JSON.stringify(sanitizeOpsJson(stored))
  )
    throw new Error(`Missing bounded safe Ops result for ${subject}.`);
}
