import type { Manifest } from './manifest';
import type { Metrics } from './metrics';

export type RunFacts = {
  completed: boolean;
  rampAcked: number;
  expectedUsers: number;
  connectedUserSeconds: number;
  holdSeconds: number;
  observerFailures: number;
  generatorInvalidReasons: string[];
  serviceFailures: string[];
  auditVerdict: string;
};
export function judge(m: Manifest, metrics: Metrics, facts: RunFacts) {
  const invalid = [...facts.generatorInvalidReasons];
  if (!facts.completed) invalid.push('HOLD_INCOMPLETE');
  if (facts.observerFailures) invalid.push('METRIC_COLLECTION_GAP');
  const failures = [...facts.serviceFailures];
  if (facts.rampAcked !== facts.expectedUsers)
    failures.push('RAMP_AUTHENTICATED_ACK_TARGET');
  let requests = 0,
    errors = 0;
  for (const [key, n] of Object.entries(metrics.counters)) {
    if (key.startsWith('hold:http.request.')) requests += n;
    if (key.startsWith('hold:http.failed.')) errors += n;
  }
  for (const [key, h] of Object.entries(metrics.histograms)) {
    if (!key.startsWith('hold:http.')) continue;
    const order = /POST .*\/(orders|futures\/(execute|limit-orders))/.test(key);
    if (
      h.percentile(0.95) > (order ? 2000 : 1000) ||
      h.percentile(0.99) > (order ? 5000 : 2000)
    )
      failures.push(`HTTP_SLO:${key}`);
  }
  for (const [key, h] of Object.entries(metrics.histograms))
    if (
      key.startsWith('hold:ws.ingressLatency.') &&
      (h.percentile(0.95) > 2000 || h.percentile(0.99) > 5000)
    )
      failures.push(`REALTIME_SLO:${key}`);
  if (requests === 0) invalid.push('NO_HOLD_HTTP_SAMPLES');
  else if (errors / requests >= 0.001) failures.push('REQUEST_ERROR_RATE');
  if (
    !Object.entries(metrics.counters).some(
      ([k, v]) => k.startsWith('hold:ws.message.') && v > 0,
    )
  )
    invalid.push('NO_HOLD_WS_MESSAGES');
  if (
    !Object.entries(metrics.histograms).some(
      ([k, h]) => k.startsWith('hold:ws.ingressLatency.') && h.count > 0,
    )
  )
    invalid.push('NO_REALTIME_INGRESS_LATENCY_SAMPLES');
  if (
    Object.keys(metrics.counters).some((k) =>
      /failure:(ACCOUNT_SCOPE|IDEMPOTENCY)/.test(k),
    )
  )
    facts.auditVerdict = 'CORRECTNESS FAIL';
  if (facts.auditVerdict === 'CORRECTNESS INCOMPLETE')
    invalid.push('AUDIT_INCOMPLETE');
  return {
    runValidity: invalid.length ? 'INVALID RUN' : 'VALID RUN',
    invalidReasons: invalid,
    correctness: facts.auditVerdict,
    performance: invalid.length
      ? 'NOT EVALUATED'
      : failures.length
        ? 'PERFORMANCE FAIL'
        : 'PERFORMANCE PASS',
    performanceFailures: failures,
    requestErrorRate: requests ? errors / requests : null,
    websocket: {
      rampAuthenticatedAck: facts.rampAcked,
      expected: facts.expectedUsers,
      connectedUserSeconds: facts.connectedUserSeconds,
      expectedUserSeconds: facts.expectedUsers * facts.holdSeconds,
      retention: facts.holdSeconds
        ? facts.connectedUserSeconds / (facts.expectedUsers * facts.holdSeconds)
        : 0,
    },
    capacityHeadroom: {
      verdict: 'REVIEW MEASURED HEADROOM',
      policy:
        'CPU/RAM/pool/network utilization alone is not a performance failure. Compare utilization and trends with achieved workload, latency and errors.',
      source:
        'server.samples.jsonl, database-valkey.samples.jsonl, render.samples.jsonl, generator.samples.jsonl',
    },
    profile: m.profile,
  };
}
