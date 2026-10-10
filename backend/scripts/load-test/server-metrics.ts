import pg from 'pg';
import WebSocket from 'ws';
import { performance } from 'node:perf_hooks';
import { Metrics } from './metrics';

/** Isolated-process instrumentation; original options/results/errors and
 * callback/Promise forms are forwarded unchanged. No runtime pool tuning. */
export function instrumentPg(metrics: Metrics) {
  const originalQuery = pg.Client.prototype.query;
  const originalConnect = pg.Pool.prototype.connect;
  const transactions = new WeakMap<object, number>();
  const pools = new Set<pg.Pool>();
  (pg.Client.prototype as any).query = function (this: any, ...args: any[]) {
    if (this.connectionParameters?.application_name === 'load-test-observer')
      return originalQuery.apply(this, args as any);
    const started = performance.now();
    const sql = typeof args[0] === 'string' ? args[0] : (args[0]?.text ?? '');
    const category = /^\s*(\w+)/.exec(sql)?.[1]?.toUpperCase() ?? 'OTHER';
    const op = [
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE',
      'BEGIN',
      'COMMIT',
      'ROLLBACK',
    ].includes(category)
      ? category
      : 'OTHER';
    if (op === 'BEGIN') transactions.set(this, started);
    const done = (error?: any) => {
      metrics.time(`pg.query.${op}`, performance.now() - started);
      metrics.count(`pg.queryCount.${op}`);
      if (error)
        metrics.failure(
          `PG_${typeof error.code === 'string' ? error.code : 'QUERY_ERROR'}`,
        );
      if (['COMMIT', 'ROLLBACK'].includes(op)) {
        const begin = transactions.get(this);
        if (begin !== undefined)
          metrics.time(`pg.transaction.${op}`, performance.now() - begin);
        transactions.delete(this);
      }
    };
    const last = args.length - 1;
    if (typeof args[last] === 'function') {
      const callback = args[last];
      args[last] = function (this: any, error: unknown, ...values: any[]) {
        done(error);
        return callback.call(this, error, ...values);
      };
      try {
        return originalQuery.apply(this, args as any);
      } catch (e) {
        done(e);
        throw e;
      }
    }
    try {
      const p = originalQuery.apply(this, args as any) as any;
      if (p && typeof p.then === 'function')
        return p.then(
          (v: any) => {
            done();
            return v;
          },
          (e: any) => {
            done(e);
            throw e;
          },
        );
      return p;
    } catch (e) {
      done(e);
      throw e;
    }
  };
  (pg.Pool.prototype as any).connect = function (
    this: pg.Pool,
    ...args: any[]
  ) {
    pools.add(this);
    const start = performance.now();
    const done = (error?: any) => {
      metrics.time('pg.poolAcquire', performance.now() - start);
      if (error) metrics.failure('PG_POOL_ACQUIRE_ERROR');
    };
    if (typeof args[0] === 'function') {
      const cb = args[0];
      args[0] = function (this: any, err: any, ...rest: any[]) {
        done(err);
        return cb.call(this, err, ...rest);
      };
      return originalConnect.apply(this, args as any);
    }
    return (originalConnect.apply(this, args as any) as any).then(
      (v: any) => {
        done();
        return v;
      },
      (e: any) => {
        done(e);
        throw e;
      },
    );
  };
  return {
    sample: () =>
      [...pools].map((p) => ({
        max: p.options.max,
        total: p.totalCount,
        idle: p.idleCount,
        waiting: p.waitingCount,
      })),
    close: () => {
      pg.Client.prototype.query = originalQuery;
      pg.Pool.prototype.connect = originalConnect;
    },
  };
}
export function instrumentSends(metrics: Metrics) {
  const original = WebSocket.prototype.send;
  (WebSocket.prototype as any).send = function (
    this: WebSocket,
    data: any,
    ...args: any[]
  ) {
    try {
      const last = args.length - 1;
      if (typeof args[last] === 'function') {
        const callback = args[last];
        args[last] = function (this: any, error?: Error) {
          if (error) metrics.failure('WS_SEND_FAILURE');
          return callback.call(this, error);
        };
      }
      const result = original.call(this, data, ...args);
      metrics.count(
        'ws.serializedBytes',
        typeof data === 'string'
          ? Buffer.byteLength(data)
          : (data?.byteLength ?? data?.length ?? 0),
      );
      metrics.count('ws.sendCalls');
      return result;
    } catch (e) {
      metrics.failure('WS_SEND_FAILURE');
      throw e;
    }
  };
  return () => {
    WebSocket.prototype.send = original;
  };
}
export function instrumentMethod(
  instance: any,
  method: string,
  metrics: Metrics,
  label: string,
  revisit = false,
) {
  const original = instance[method].bind(instance);
  const last = new Map<string, number>();
  instance[method] = async (...args: any[]) => {
    const at = performance.now();
    if (revisit && typeof args[0] === 'string') {
      const previous = last.get(args[0]);
      if (previous !== undefined)
        metrics.time(`worker.revisit.${label}`, at - previous);
      last.set(args[0], at);
    }
    try {
      const value = await original(...args);
      metrics.count(`worker.completed.${label}`);
      if (value && typeof value === 'object') {
        if (typeof value.state === 'string')
          metrics.count(`worker.state.${label}.${value.state}`);
        else
          for (const [state, count] of Object.entries(value))
            if (typeof count === 'number')
              metrics.count(`worker.result.${label}.${state}`, count);
        if (value.batchExhausted || value.scanExhausted)
          metrics.count(`worker.incomplete.${label}`);
        if (value.acquired === false)
          metrics.count(`worker.lockOwnershipUnavailable.${label}`);
      }
      if (label === 'lease' && value === false)
        metrics.count('worker.leaseFailure');
      if (
        value?.state === 'executed' ||
        (label === 'spotEligibleFill' && value?.state === 'filled')
      )
        metrics.time(
          `worker.eligibleEvaluationToCommit.${label}`,
          performance.now() - at,
        );
      return value;
    } catch (e: any) {
      const code = e?.getResponse?.()?.error?.code;
      if (code === 'FUTURES_ENTRY_LIMIT_NOT_REACHED')
        metrics.count(`worker.state.${label}.${code}`);
      else metrics.failure(`WORKER_FAILURE_${label}`);
      throw e;
    } finally {
      metrics.time(`worker.cycle.${label}`, performance.now() - at);
    }
  };
}

/** Existing command timeout and error policy remains authoritative. */
export function instrumentValkey(instance: any, metrics: Metrics) {
  for (const method of ['ensureConnected', 'runCommand']) {
    const original = instance[method].bind(instance);
    instance[method] = async (...args: any[]) => {
      const at = performance.now();
      try {
        return await original(...args);
      } catch (error: any) {
        metrics.failure(
          error?.message === 'Redis command timed out.'
            ? 'VALKEY_TIMEOUT'
            : method === 'ensureConnected'
              ? 'VALKEY_CONNECT_ERROR'
              : 'VALKEY_COMMAND_OR_WRITE_FAILURE',
        );
        throw error;
      } finally {
        metrics.time(`valkey.${method}`, performance.now() - at);
      }
    };
  }
}
