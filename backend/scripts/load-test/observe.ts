import { Client } from 'pg';
import IORedis from 'ioredis';
import type { Credentials, Manifest } from './manifest';
import { jsonl } from './metrics';
import { controlKey } from './preflight';
import { resolve } from 'node:path';

export function hasMetricSamples(series: unknown): boolean {
  return (
    Array.isArray(series) &&
    series.some(
      (s) =>
        typeof s?.unit === 'string' &&
        Array.isArray(s.values) &&
        s.values.some(
          (v: any) =>
            Number.isFinite(v.value) &&
            Number.isFinite(Date.parse(v.timestamp)),
        ),
    )
  );
}

export class Observer {
  readonly pg: Client;
  readonly redis: IORedis;
  failures = 0;
  private lastRender = 0;
  private startedAt = new Date().toISOString();
  private utilization: Record<
    string,
    { count: number; sum: number; max: number }
  > = {};
  private record(name: string, value: number) {
    if (!Number.isFinite(value)) return;
    const s = (this.utilization[name] ??= { count: 0, sum: 0, max: 0 });
    s.count++;
    s.sum += value;
    s.max = Math.max(s.max, value);
  }
  headroom() {
    return {
      measured: Object.fromEntries(
        Object.entries(this.utilization).map(([name, s]) => [
          name,
          { samples: s.count, average: s.sum / s.count, max: s.max },
        ]),
      ),
      interpretation:
        'Capacity review, never a latency PASS/FAIL. Normalize API/DB CPU, memory, connections and bandwidth to the approved resource limits. Average <60%: sufficient; 60-80%: limited; 80-95%: upgrade recommended; >95%: near bottleneck, subject to trends and achieved workload.',
      cloudSource:
        'render.samples.jsonl contains raw CPU and RAM for API/Postgres/Valkey; local process/PG/Redis samples do not infer managed DB CPU or RAM.',
    };
  }
  constructor(
    readonly m: Manifest,
    readonly c: Credentials,
    readonly out: string,
  ) {
    this.pg = new Client({
      connectionString: c.databaseUrl,
      application_name: 'load-test-observer',
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
    });
    this.redis = new IORedis(c.valkeyUrl, {
      lazyConnect: true,
      commandTimeout: 5000,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    this.redis.on('error', () => {});
  }
  async connect() {
    await this.pg.connect();
    await this.redis.connect();
  }
  async sample() {
    try {
      const state = await this.pg
        .query(`SELECT clock_timestamp() AS now, pg_database_size(current_database()) AS storage_bytes,
        (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()) AS connections,
        (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='active') AS active,
        (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock') AS lock_waiters,
        (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction') AS idle_in_transaction,
        (SELECT max(extract(epoch FROM clock_timestamp()-query_start)*1000) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock') AS max_lock_wait_ms,
        deadlocks, xact_commit, xact_rollback, blks_read, blks_hit FROM pg_stat_database WHERE datname=current_database()`);
      const info = await this.redis.info();
      const valkey = Object.fromEntries(
        info
          .split(/\r?\n/)
          .filter((l) =>
            /^(used_memory|used_memory_peak|maxmemory|maxmemory_policy|maxclients|connected_clients|rejected_connections|total_error_replies|evicted_keys|instantaneous_input_kbps|instantaneous_output_kbps|pubsub_channels|pubsub_patterns|errorstat_)/.test(
              l,
            ),
          )
          .map((l) => {
            const i = l.indexOf(':');
            return [l.slice(0, i), l.slice(i + 1)];
          }),
      );
      const lockRows = await this.pg.query(
        'SELECT lock_key, owner_id, expires_at FROM ops_job_locks',
      );
      const jobRows = await this.pg.query(
        'SELECT job_name,status,count(*)::int AS count FROM ops_job_runs WHERE started_at >= $1 GROUP BY job_name,status',
        [this.startedAt],
      );
      const queues = await this.pg.query(`SELECT
        (SELECT count(*) FROM orders WHERE status='submitted' AND order_type='limit') AS spot_pending,
        (SELECT count(*) FROM futures_limit_orders WHERE status='submitted') AS futures_pending,
        (SELECT count(*) FROM protection_children WHERE status='pending') AS triggered_children_incomplete,
        (SELECT max(extract(epoch FROM clock_timestamp()-triggered_at)*1000) FROM protection_children WHERE status='pending') AS oldest_triggered_child_ms`);
      const sample = {
        at: new Date().toISOString(),
        postgres: state.rows[0],
        valkey,
        locks: lockRows.rows,
        jobs: jobRows.rows,
        queues: queues.rows[0],
      };
      jsonl(resolve(this.out, 'database-valkey.samples.jsonl'), sample);
      const server = await this.redis.get(controlKey(this.m, 'server-sample'));
      if (!server) throw new Error('SERVER_METRICS_STALE');
      const parsed = JSON.parse(server);
      if (parsed.phase === 'hold') {
        this.record('api.cpuCores', parsed.cpuCoresUsed);
        this.record('api.rssBytes', parsed.rssBytes);
        this.record('postgres.connections', Number(state.rows[0].connections));
        this.record('postgres.lockWaiters', Number(state.rows[0].lock_waiters));
        this.record(
          'valkey.memoryFraction',
          Number(valkey.used_memory) / Number(valkey.maxmemory),
        );
        this.record('valkey.clients', Number(valkey.connected_clients));
        for (const pool of parsed.pools) {
          this.record('api.poolConnectionFraction', pool.total / pool.max);
          this.record('api.poolWaiting', pool.waiting);
        }
      }
      jsonl(resolve(this.out, 'server.samples.jsonl'), parsed);
      if (Date.now() - this.lastRender >= 30000 && this.c.renderApiKey) {
        this.lastRender = Date.now();
        await this.render();
      }
      return { ...sample, server: parsed };
    } catch (e) {
      this.failures++;
      jsonl(resolve(this.out, 'observer-errors.jsonl'), {
        at: new Date().toISOString(),
        code: e instanceof Error ? e.name : 'OBSERVER_ERROR',
      });
      throw e;
    }
  }
  private async render() {
    // Read-only metrics, not service/environment mutations. Dates are whole
    // seconds RFC3339 as required by Render. Never emit the API credential.
    const end = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const start = new Date(Date.now() - 90000)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z');
    for (const resource of [
      this.m.target.apiResourceId,
      this.m.target.databaseResourceId,
      this.m.target.valkeyResourceId,
    ]) {
      if (!/^(srv|dpg|red)-/.test(resource)) continue;
      for (const metric of [
        'cpu',
        'memory',
        ...(/^(dpg|red)-/.test(resource) ? ['active-connections'] : []),
      ]) {
        const url = new URL(`https://api.render.com/v1/metrics/${metric}`);
        url.searchParams.append('resource', resource);
        url.searchParams.set('startTime', start);
        url.searchParams.set('endTime', end);
        url.searchParams.set('resolutionSeconds', '30');
        const response = await fetch(url, {
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
          headers: { authorization: `Bearer ${this.c.renderApiKey}` },
        });
        if (!response.ok) throw new Error('RENDER_METRICS_UNAVAILABLE');
        const series = await response.json();
        jsonl(resolve(this.out, 'render.samples.jsonl'), {
          at: end,
          resource,
          metric,
          series,
        });
        if (!hasMetricSamples(series))
          throw new Error('RENDER_METRICS_COVERAGE_MISSING');
      }
    }
  }
  async close() {
    await this.pg.end().catch(() => undefined);
    this.redis.disconnect();
  }
}
