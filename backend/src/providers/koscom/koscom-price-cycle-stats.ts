import { formatZonedCursor } from '../kis/candles/kis-candle-time';
import { koscomTime } from './koscom-normalizer';

/** One price/order-book batch request inside a collection cycle. */
export type KoscomCycleRequest = {
  kind: 'price' | 'orderbook';
  latencyMs: number;
  ok: boolean;
};

export type KoscomCycleOutcome = 'completed' | 'partial' | 'failed';

type Distribution = { p50: number; p99: number; max: number } | null;

/**
 * Per-process price-cycle measurement (design v2.1 Q10: D = cycle duration,
 * J = start jitter, provider latency). Raw samples stay in memory for one
 * wall-clock minute; at most one structured summary line per minute leaves
 * the process, so the log volume does not grow with the polling cadence.
 */
export class KoscomPriceCycleStats {
  private windowStartMs: number | null = null;
  private periodMs = 0;
  private durations: number[] = [];
  private startLags: number[] = [];
  private startIntervals: number[] = [];
  private latencies: number[] = [];
  private outcomes: Record<KoscomCycleOutcome, number> = {
    completed: 0,
    partial: 0,
    failed: 0,
  };
  private requests = 0;
  private failedRequests = 0;
  private skippedBusy = 0;
  private skippedUnavailable = 0;
  private overrunCycles = 0;
  private lastStartMs: number | null = null;

  recordCycle(input: {
    startedAtMs: number;
    durationMs: number;
    periodMs: number;
    outcome: KoscomCycleOutcome;
    requests: readonly KoscomCycleRequest[];
  }): void {
    this.ensureWindow(input.startedAtMs);
    this.periodMs = input.periodMs;
    this.durations.push(input.durationMs);
    // Offset of the start from the shared period grid (slot boundaries).
    this.startLags.push(input.startedAtMs % input.periodMs);
    if (this.lastStartMs !== null)
      this.startIntervals.push(input.startedAtMs - this.lastStartMs);
    this.lastStartMs = input.startedAtMs;
    this.outcomes[input.outcome] += 1;
    // `D ≤ T − 1 s` is the load-test pass condition (design v2.1 §6.5 c).
    if (input.durationMs > input.periodMs - 1000) this.overrunCycles += 1;
    for (const request of input.requests) {
      this.requests += 1;
      if (!request.ok) this.failedRequests += 1;
      this.latencies.push(request.latencyMs);
    }
  }

  recordSkip(atMs: number, reason: 'busy' | 'unavailable'): void {
    this.ensureWindow(atMs);
    if (reason === 'busy') this.skippedBusy += 1;
    else this.skippedUnavailable += 1;
  }

  /** The finished minute's summary once the clock has left it, else null. */
  takeSummaryIfDue(nowMs: number): Record<string, unknown> | null {
    if (this.windowStartMs === null) return null;
    if (minuteStart(nowMs) === this.windowStartMs) return null;
    const summary = this.summary();
    this.reset(null);
    return summary;
  }

  private summary(): Record<string, unknown> {
    return {
      event: 'koscom_price_cycle_summary',
      windowStart: new Date(this.windowStartMs ?? 0).toISOString(),
      periodMs: this.periodMs,
      cycles:
        this.outcomes.completed + this.outcomes.partial + this.outcomes.failed,
      completedCycles: this.outcomes.completed,
      partialCycles: this.outcomes.partial,
      failedCycles: this.outcomes.failed,
      overrunCycles: this.overrunCycles,
      skippedBusy: this.skippedBusy,
      skippedUnavailable: this.skippedUnavailable,
      durationMs: distribution(this.durations),
      startLagMs: distribution(this.startLags),
      startIntervalMs: distribution(this.startIntervals),
      requests: this.requests,
      failedRequests: this.failedRequests,
      requestLatencyMs: distribution(this.latencies),
    };
  }

  private ensureWindow(atMs: number): void {
    const start = minuteStart(atMs);
    if (this.windowStartMs === null) this.windowStartMs = start;
    else if (start > this.windowStartMs) this.reset(start);
  }

  private reset(windowStartMs: number | null): void {
    this.windowStartMs = windowStartMs;
    this.durations = [];
    this.startLags = [];
    this.startIntervals = [];
    this.latencies = [];
    this.outcomes = { completed: 0, partial: 0, failed: 0 };
    this.requests = 0;
    this.failedRequests = 0;
    this.skippedBusy = 0;
    this.skippedUnavailable = 0;
    this.overrunCycles = 0;
  }
}

/**
 * Provider trade time of one polled quote, in epoch seconds, whether or not
 * the row is later stored (poll-log input for `er_replay.py --polls`). Null
 * when the row carries no usable same-day trade time.
 */
export function koscomPollEffectiveSeconds(
  row: Record<string, unknown>,
  receivedAt: Date,
): number | null {
  try {
    const date = formatZonedCursor(receivedAt, 'Asia/Seoul').date;
    if (row.trdDd !== undefined && row.trdDd !== date) return null;
    return koscomTime(date, row.trdTm).getTime() / 1000;
  } catch {
    return null;
  }
}

function minuteStart(ms: number): number {
  return Math.floor(ms / 60_000) * 60_000;
}

function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  return {
    p50: Math.round(at(0.5)),
    p99: Math.round(at(0.99)),
    max: Math.round(sorted[sorted.length - 1]),
  };
}
