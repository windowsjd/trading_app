import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import {
  appendFileSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  readlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';

// Fixed logarithmic buckets, ~1% relative precision. Counts can be merged
// across shards; percentile averaging is deliberately not supported.
export class Histogram {
  buckets = new Array<number>(1600).fill(0);
  count = 0;
  max = 0;
  total = 0;
  add(ms: number) {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.buckets[
      Math.min(1599, Math.max(0, Math.ceil(Math.log1p(ms) / Math.log(1.01))))
    ]++;
    this.count++;
    this.total += ms;
    this.max = Math.max(this.max, ms);
  }
  merge(other: Histogram) {
    other.buckets.forEach((v, i) => (this.buckets[i] += v));
    this.count += other.count;
    this.total += other.total;
    this.max = Math.max(this.max, other.max);
  }
  percentile(p: number) {
    const target = Math.ceil(this.count * p);
    let n = 0;
    for (let i = 0; i < this.buckets.length; i++) {
      n += this.buckets[i];
      if (n >= target)
        return Math.min(this.max, Math.expm1(i * Math.log(1.01)));
    }
    return this.max;
  }
  summary() {
    return {
      count: this.count,
      p50: this.percentile(0.5),
      p95: this.percentile(0.95),
      p99: this.percentile(0.99),
      max: this.max,
      mean: this.count ? this.total / this.count : 0,
    };
  }
}
export class Metrics {
  phase = 'prepare';
  counters: Record<string, number> = {};
  histograms: Record<string, Histogram> = {};
  failures: Array<{
    at: string;
    phase: string;
    code: string;
    endpoint?: string;
  }> = [];
  count(key: string, n = 1) {
    this.counters[`${this.phase}:${key}`] =
      (this.counters[`${this.phase}:${key}`] ?? 0) + n;
  }
  time(key: string, ms: number) {
    (this.histograms[`${this.phase}:${key}`] ??= new Histogram()).add(ms);
  }
  failure(code: string, endpoint?: string) {
    this.count(`failure:${code}`);
    if (this.failures.length < 100)
      this.failures.push({
        at: new Date().toISOString(),
        phase: this.phase,
        code: code.slice(0, 100),
        endpoint,
      });
  }
  summary() {
    return {
      counters: this.counters,
      latencyMs: Object.fromEntries(
        Object.entries(this.histograms).map(([k, v]) => [k, v.summary()]),
      ),
      failures: this.failures,
    };
  }
  serializable() {
    return { ...this.summary(), histogramBuckets: this.histograms };
  }
}
export function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify(
      value,
      (_key, v) => (typeof v === 'bigint' ? v.toString() : v),
      2,
    ) + '\n',
    { mode: 0o600 },
  );
}
export function jsonl(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(
    file,
    JSON.stringify(value, (_key, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    ) + '\n',
    { mode: 0o600 },
  );
}
export class ProcessSampler {
  private loop = monitorEventLoopDelay({ resolution: 10 });
  private previousCpu = process.cpuUsage();
  private previousTime = performance.now();
  constructor() {
    this.loop.enable();
  }
  sample() {
    const cpu = process.cpuUsage(this.previousCpu);
    this.previousCpu = process.cpuUsage();
    const now = performance.now();
    const seconds = (now - this.previousTime) / 1000;
    this.previousTime = now;
    let openFileDescriptors: number | null = null,
      openNetworkSockets: number | null = null;
    if (process.platform === 'linux') {
      try {
        const entries = readdirSync('/proc/self/fd');
        openFileDescriptors = entries.length;
        openNetworkSockets = entries.filter((fd) => {
          try {
            return readlinkSync(`/proc/self/fd/${fd}`).startsWith('socket:');
          } catch {
            return false;
          }
        }).length;
      } catch {}
    }
    const value = {
      at: new Date().toISOString(),
      monotonicMs: now,
      pid: process.pid,
      uptimeSeconds: process.uptime(),
      cpuCoresUsed: (cpu.user + cpu.system) / 1e6 / seconds,
      rssBytes: process.memoryUsage().rss,
      heapBytes: process.memoryUsage().heapUsed,
      openFileDescriptors,
      openNetworkSockets,
      eventLoopLagP95Ms: this.loop.percentile(95) / 1e6,
      eventLoopLagP99Ms: this.loop.percentile(99) / 1e6,
    };
    this.loop.reset();
    return value;
  }
  close() {
    this.loop.disable();
  }
}
export const endpointKey = (path: string) =>
  path.split('?')[0].replace(/\/[a-f0-9-]{36}(?=\/|$)/g, '/:id');
