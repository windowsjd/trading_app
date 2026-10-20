jest.mock('../generated/prisma/client', () => {
  const runtime = jest.requireActual<{
    Decimal: unknown;
    sqltag: unknown;
    join: unknown;
  }>('@prisma/client/runtime/client');
  return {
    PrismaClient: class PrismaClient {},
    Prisma: {
      Decimal: runtime.Decimal,
      sql: runtime.sqltag,
      join: runtime.join,
    },
  };
});

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HttpException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import type {
  BinanceCandlePageInput,
  BinanceCandlePageResult,
  CanonicalBinanceCandle,
} from '../providers/binance/binance-candle.types';
import { BINANCE_REST_RECOVERY_RESERVE_WEIGHT } from '../providers/binance/binance-rest-coordinator';
import { ProviderHttpError } from '../providers/provider.types';
import {
  FuturesCandleProviderService,
  readFuturesCandleProviderConfig,
  type FuturesProviderInterval,
  type FuturesProviderRead,
} from './market-candle-futures-provider.service';
import { FuturesCandlesService } from './market-candle-futures.service';
import { FUTURES_CHART_WINDOWS } from './market-candle-futures-windows';

/**
 * Safety of the on-demand futures chart reads at the PRODUCTION call cap
 * (FUTURES_CANDLE_PROVIDER_MAX_CALLS_PER_MINUTE=120, 2026-10-20) — single
 * flight, the per-minute cap and its window, many distinct series, and the
 * provider/coordinator refusals Futures Last/Mark recovery depends on.
 *
 * Everything runs on the production timings (150 ms call spacing, 2 s / 8 s
 * viewer waits, 15 s turn bound) under Jest's fake clock: a simulated minute
 * takes milliseconds and nothing touches the network. The Binance stand-in
 * gives every (contract, interval) series its own price, so an answer that
 * carried another series' klines could not pass.
 */

const PRODUCTION = readFuturesCandleProviderConfig({
  FUTURES_CANDLE_PROVIDER_MAX_CALLS_PER_MINUTE: '120',
});
const INTERVALS: FuturesProviderInterval[] = ['5m', '15m', '30m', '1h', '1d'];
const CONTRACTS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'BNBUSDT',
];
const START = Date.parse('2026-10-20T12:02:30.000Z');

/** USDⓈ-M `/fapi/v1/klines` LIMIT tiers (backend/docs/binance-rest-limits.md). */
const klinesWeight = (limit: number) =>
  limit < 100 ? 1 : limit < 500 ? 2 : limit <= 1000 ? 5 : 10;

type Call = {
  symbol: string;
  interval: string;
  limit: number;
  startedAt: number;
  endedAt: number;
};

/**
 * A Binance stand-in on the fake clock: every call takes `latencyMs`, is
 * recorded, and answers the buckets it covers with its series' own price.
 * `fail` makes one symbol (or every call) throw instead.
 */
function fakeBinance(latencyMs = 50) {
  const prices = new Map<string, number>();
  const failures = new Map<string, Error>();
  let failEvery: Error | null = null;
  const calls: Call[] = [];
  const state = { active: 0, peak: 0 };
  const priceOf = (symbol: string, interval: string) => {
    const key = `${symbol}|${interval}`;
    if (!prices.has(key)) prices.set(key, 100 + prices.size);
    return prices.get(key)!;
  };
  const fetchKlinesPage = jest.fn(
    async (input: BinanceCandlePageInput): Promise<BinanceCandlePageResult> => {
      const call: Call = {
        symbol: input.symbol,
        interval: input.interval,
        limit: input.limit ?? 1000,
        startedAt: Date.now(),
        endedAt: Number.NaN,
      };
      calls.push(call);
      state.active += 1;
      state.peak = Math.max(state.peak, state.active);
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, latencyMs));
      } finally {
        state.active -= 1;
        call.endedAt = Date.now();
      }
      const failure = failEvery ?? failures.get(input.symbol);
      if (failure) throw failure;
      const intervalMs =
        FUTURES_CHART_WINDOWS[input.interval as '5m'].intervalMs;
      const nowMs = input.now!.getTime();
      const price = new Prisma.Decimal(priceOf(input.symbol, input.interval));
      const candles: CanonicalBinanceCandle[] = [];
      for (
        let open = input.from.getTime();
        open < input.to.getTime() && open <= nowMs;
        open += intervalMs
      ) {
        candles.push({
          openTime: new Date(open),
          closeTime: new Date(open + intervalMs),
          open: price,
          high: price,
          low: price,
          close: price,
          volume: new Prisma.Decimal(1),
          amount: price,
          isClosed: open + intervalMs - 1 < nowMs,
          sourceUpdatedAt: new Date(nowMs),
        });
      }
      return {
        candles: candles.slice(0, input.limit),
        providerReturnedRows: candles.length,
        acceptedRows: candles.length,
        rejectedRows: 0,
        duplicateRows: 0,
        nextCursor: null,
        stopReason: 'target_reached',
        complete: true,
      };
    },
  );
  return {
    fetchKlinesPage,
    calls,
    state,
    priceOf,
    fail(symbol: string, error: Error | null) {
      if (error) failures.set(symbol, error);
      else failures.delete(symbol);
    },
    failEverything(error: Error | null) {
      failEvery = error;
    },
  };
}

type Settled<T> = {
  ok: boolean;
  value?: T;
  code?: string;
  startedAt: number;
  settledAt: number;
};

function codeOf(caught: unknown): string {
  if (caught instanceof HttpException) {
    const body = caught.getResponse() as { error: { code: string } };
    return `${caught.getStatus()}:${body.error.code}`;
  }
  return 'unexpected';
}

/**
 * Advances the fake clock until every read has settled (bounded), recording
 * when each settled — the wait a viewer would see.
 */
async function drive<T>(
  work: Array<Promise<T>>,
  maxMs = 120_000,
): Promise<Array<Settled<T>>> {
  const startedAt = Date.now();
  const results: Array<Settled<T> | undefined> = work.map(() => undefined);
  work.forEach((promise, index) => {
    promise.then(
      (value) => {
        results[index] = { ok: true, value, startedAt, settledAt: Date.now() };
      },
      (caught: unknown) => {
        results[index] = {
          ok: false,
          code: codeOf(caught),
          startedAt,
          settledAt: Date.now(),
        };
      },
    );
  });
  for (let waited = 0; waited <= maxMs; waited += 25) {
    await jest.advanceTimersByTimeAsync(waited === 0 ? 0 : 25);
    if (results.every((result) => result !== undefined)) break;
  }
  if (results.some((result) => result === undefined)) {
    throw new Error(`reads did not settle within ${maxMs} ms`);
  }
  return results as Array<Settled<T>>;
}

/** Lets the provider's queued calls finish (the viewers may have stopped waiting). */
async function drain(
  binance: ReturnType<typeof fakeBinance>,
  expected: number,
) {
  for (let waited = 0; waited <= 300_000; waited += 25) {
    if (
      binance.calls.length >= expected &&
      binance.calls.every((call) => !Number.isNaN(call.endedAt))
    ) {
      // One more turn so the cache writes after the last answer land.
      await jest.advanceTimersByTimeAsync(0);
      return;
    }
    await jest.advanceTimersByTimeAsync(25);
  }
  throw new Error(`provider calls did not drain (${binance.calls.length})`);
}

/** 'fresh', 'stale' or the refusal's `status:code`. */
type Outcome = string;
const outcome = (result: Settled<FuturesProviderRead>): Outcome =>
  result.ok ? (result.value!.stale ? 'stale' : 'fresh') : result.code!;

function tally(outcomes: Outcome[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of outcomes) counts[item] = (counts[item] ?? 0) + 1;
  return counts;
}

describe('FuturesCandleProviderService at the production cap (120/min)', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: START });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  const read = (
    service: FuturesCandleProviderService,
    instrumentId: string,
    interval: FuturesProviderInterval,
    symbol = `${instrumentId.toUpperCase()}USDT`,
  ) => service.read({ instrumentId, symbol, interval, now: new Date() });

  it('reads the production value 120 and keeps the default spacing and waits', () => {
    expect(PRODUCTION.maxCallsPerMinute).toBe(120);
    expect(PRODUCTION.callSpacingMs === undefined).toBe(true);
    expect(PRODUCTION.warmWaitMs === undefined).toBe(true);
    expect(PRODUCTION.coldWaitMs === undefined).toBe(true);
  });

  describe('A-1 one series, many viewers', () => {
    it('200 concurrent viewers of one contract and interval cause ONE provider call and share its copy', async () => {
      const binance = fakeBinance();
      const service = new FuturesCandleProviderService(binance, PRODUCTION);
      const results = await drive(
        Array.from({ length: 200 }, () =>
          read(service, 'btc', '5m', 'BTCUSDT'),
        ),
      );
      expect(binance.calls.length).toBe(1);
      expect(binance.calls[0].limit).toBe(577);
      expect(tally(results.map(outcome))).toEqual({ fresh: 200 });
      const first = results[0].value!.candles;
      expect(results.every((result) => result.value!.candles === first)).toBe(
        true,
      );
    });

    it('a current copy causes no call; an expired copy is refreshed ONCE (tail, weight 1) for all concurrent viewers', async () => {
      const binance = fakeBinance();
      const service = new FuturesCandleProviderService(binance, PRODUCTION);
      await drive([read(service, 'btc', '5m', 'BTCUSDT')]);
      // Within the 5m freshness (15 s): nothing is asked of Binance.
      await jest.advanceTimersByTimeAsync(10_000);
      const cached = await drive(
        Array.from({ length: 50 }, () => read(service, 'btc', '5m', 'BTCUSDT')),
      );
      expect(binance.calls.length).toBe(1);
      expect(tally(cached.map(outcome))).toEqual({ fresh: 50 });
      // Past it: 50 concurrent viewers, one refresh of the tail only.
      await jest.advanceTimersByTimeAsync(6_000);
      const refreshed = await drive(
        Array.from({ length: 50 }, () => read(service, 'btc', '5m', 'BTCUSDT')),
      );
      expect(binance.calls.length).toBe(2);
      expect(klinesWeight(binance.calls[1].limit)).toBe(1);
      expect(tally(refreshed.map(outcome))).toEqual({ fresh: 50 });
      expect(binance.state.peak).toBe(1);
    });

    it("one series' failing refresh never touches another series or its viewers", async () => {
      const binance = fakeBinance();
      const service = new FuturesCandleProviderService(binance, PRODUCTION);
      await drive([
        read(service, 'btc', '5m', 'BTCUSDT'),
        read(service, 'eth', '5m', 'ETHUSDT'),
      ]);
      await jest.advanceTimersByTimeAsync(16_000);
      binance.fail(
        'ETHUSDT',
        new ProviderHttpError('binance', 'PROVIDER_TIMEOUT', 'timeout'),
      );
      const mixed = await drive([
        ...Array.from({ length: 20 }, () =>
          read(service, 'eth', '5m', 'ETHUSDT'),
        ),
        ...Array.from({ length: 20 }, () =>
          read(service, 'btc', '5m', 'BTCUSDT'),
        ),
      ]);
      // ETH viewers keep the last good copy, marked stale; BTC is untouched.
      expect(tally(mixed.slice(0, 20).map(outcome))).toEqual({ stale: 20 });
      expect(tally(mixed.slice(20).map(outcome))).toEqual({ fresh: 20 });
      expect(binance.calls.length).toBe(4);
      // The failed series waits 15 s before its next call; BTC refreshes on time.
      await jest.advanceTimersByTimeAsync(16_000);
      const after = await drive([
        read(service, 'eth', '5m', 'ETHUSDT'),
        read(service, 'btc', '5m', 'BTCUSDT'),
      ]);
      expect(after.map(outcome)).toEqual(['stale', 'fresh']);
      // ETH tried once more (its backoff had passed), BTC once more.
      expect(
        binance.calls
          .slice(4)
          .map((call) => call.symbol)
          .sort(),
      ).toEqual(['BTCUSDT', 'ETHUSDT']);
      // A series nobody has read yet fails alone: the retryable 503.
      binance.fail(
        'SOLUSDT',
        new ProviderHttpError('binance', 'PROVIDER_TIMEOUT', 'timeout'),
      );
      const cold = await drive([read(service, 'sol', '5m', 'SOLUSDT')]);
      expect(cold.map(outcome)).toEqual(['503:FUTURES_CANDLES_UNAVAILABLE']);
    });

    it('viewers on different accounts share one series through the route; one bad request fails alone', async () => {
      const binance = fakeBinance();
      const provider = new FuturesCandleProviderService(binance, PRODUCTION);
      const prisma = {
        futuresInstrument: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'fut-btc',
            isActive: true,
            productType: 'synthetic_perpetual',
            settlementCurrency: 'USD',
            markContractJson: { priceTickSize: '0.10' },
            underlyingAsset: {
              symbol: 'BTCUSDT',
              name: 'Bitcoin',
              market: 'BINANCE',
              assetType: 'crypto',
            },
          }),
        },
      };
      const route = new FuturesCandlesService(
        prisma as never,
        { findRange: jest.fn() } as never,
        provider,
      );
      const results = await drive([
        ...Array.from({ length: 30 }, (_, index) =>
          route.getInstrumentCandles(`user-${index}`, 'fut-btc', {
            interval: '5m',
          }),
        ),
        route.getInstrumentCandles('user-bad', 'fut-btc', {
          interval: '5m',
          range: '14d',
        }),
      ]);
      expect(binance.calls.length).toBe(1);
      expect(results.slice(0, 30).every((result) => result.ok)).toBe(true);
      expect(results[30].code).toBe('400:FUTURES_CANDLES_INVALID_QUERY');
      const body = results[0].value!.data;
      expect(results.slice(0, 30).every((r) => r.value!.data === body)).toBe(
        true,
      );
      // Market data only: nothing account-scoped is in the shared answer.
      expect(Object.keys(body).sort()).toEqual([
        'candles',
        'instrument',
        'interval',
        'priceBasis',
        'range',
        'source',
        'state',
      ]);
    });
  });

  describe('A-2 the per-minute cap', () => {
    it('admits exactly 120 provider calls per sliding minute, refuses the rest at once, and resumes when the window moves', async () => {
      const binance = fakeBinance();
      const service = new FuturesCandleProviderService(binance, PRODUCTION);
      const id = (n: number) => `c${String(n).padStart(3, '0')}`;
      // 119 series (one 5m, the rest 1d), three viewers each, at one instant.
      const keyOf = (n: number): FuturesProviderInterval =>
        n === 1 ? '5m' : '1d';
      const below = await drive(
        Array.from({ length: 119 }, (_, index) => index + 1).flatMap((n) =>
          [0, 1, 2].map(() => read(service, id(n), keyOf(n))),
        ),
      );
      await drain(binance, 119);
      // Below the cap: every series admitted once, the duplicates joined it.
      expect(binance.calls.length).toBe(119);
      expect(binance.state.peak).toBe(1);
      // One call at a time, 150 ms apart: the first 40 series answer inside
      // the 8 s cold wait; a viewer further back gets the retryable 503 at
      // 8 s (never a hang) while its refresh finishes for the retry.
      expect(tally(below.map(outcome))).toEqual({
        fresh: 120,
        '503:FUTURES_CANDLES_UNAVAILABLE': 237,
      });
      expect(
        below.every((result) => result.settledAt - result.startedAt <= 8_000),
      ).toBe(true);
      // Their retry is served from the finished refresh: no second call.
      const retried = await drive(
        Array.from({ length: 118 }, (_, index) =>
          read(service, id(index + 2), '1d'),
        ),
      );
      expect(tally(retried.map(outcome))).toEqual({ fresh: 118 });
      expect(binance.calls.length).toBe(119);

      // Exactly at the cap: the 120th call is admitted.
      const at = await drive([read(service, id(120), '1d')]);
      expect(at.map(outcome)).toEqual(['fresh']);
      expect(binance.calls.length).toBe(120);

      // Over the cap: refused immediately, without a provider call — a cached
      // series is served stale, an uncached one is the retryable 503.
      const over = await drive([
        read(service, id(1), '5m'),
        ...Array.from({ length: 11 }, (_, index) =>
          read(service, id(121 + index), '1d'),
        ),
      ]);
      expect(over.map(outcome)).toEqual([
        'stale',
        ...Array.from({ length: 11 }, () => '503:FUTURES_CANDLES_UNAVAILABLE'),
      ]);
      expect(
        over.every((result) => result.settledAt === result.startedAt),
      ).toBe(true);
      expect(binance.calls.length).toBe(120);

      // No retry storm: nothing calls by itself, and refused reads stay refused.
      await jest.advanceTimersByTimeAsync(30_000);
      expect(binance.calls.length).toBe(120);
      const hammered = await drive(
        Array.from({ length: 200 }, (_, index) =>
          read(service, id(121 + (index % 11)), '1d'),
        ),
      );
      expect(tally(hammered.map(outcome))).toEqual({
        '503:FUTURES_CANDLES_UNAVAILABLE': 200,
      });
      expect(binance.calls.length).toBe(120);

      // The window moves: just under a minute after the 119 admissions still
      // refused; at a minute they have left the window and reads resume.
      jest.setSystemTime(START + 59_999);
      const early = await drive([read(service, id(121), '1d')]);
      expect(early.map(outcome)).toEqual(['503:FUTURES_CANDLES_UNAVAILABLE']);
      jest.setSystemTime(START + 60_000);
      const resumed = await drive([
        read(service, id(1), '5m'),
        ...Array.from({ length: 11 }, (_, index) =>
          read(service, id(121 + index), '1d'),
        ),
      ]);
      await drain(binance, 132);
      expect(tally(resumed.map(outcome))).toEqual({ fresh: 12 });
      expect(binance.calls.length).toBe(132);
      expect(binance.state.peak).toBe(1);
    });
  });

  describe('A-3 10, 20 and 30 distinct series', () => {
    function routeWithCatalog(binance: ReturnType<typeof fakeBinance>) {
      const provider = new FuturesCandleProviderService(binance, PRODUCTION);
      const prisma = {
        futuresInstrument: {
          findUnique: jest.fn(({ where }: { where: { id: string } }) => {
            const symbol = CONTRACTS.find(
              (contract) => `fut-${contract}` === where.id,
            );
            return Promise.resolve(
              symbol
                ? {
                    id: where.id,
                    isActive: true,
                    productType: 'synthetic_perpetual',
                    settlementCurrency: 'USD',
                    markContractJson: { priceTickSize: '0.01' },
                    underlyingAsset: {
                      symbol,
                      name: symbol,
                      market: 'BINANCE',
                      assetType: 'crypto',
                    },
                  }
                : null,
            );
          }),
        },
      };
      return new FuturesCandlesService(
        prisma as never,
        { findRange: jest.fn() } as never,
        provider,
      );
    }
    const seriesKeys = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        symbol: CONTRACTS[index % CONTRACTS.length],
        interval: INTERVALS[Math.floor(index / CONTRACTS.length)],
      }));

    it.each([10, 20, 30])(
      '%i series viewed by three accounts each: one call per series, each answer only its own series, polling stays under the cap',
      async (count) => {
        const binance = fakeBinance(50);
        const route = routeWithCatalog(binance);
        const keys = seriesKeys(count);
        const ask = (key: { symbol: string; interval: string }, user: number) =>
          route.getInstrumentCandles(`user-${user}`, `fut-${key.symbol}`, {
            interval: key.interval,
          });
        const first = await drive(
          keys.flatMap((key, index) =>
            [0, 1, 2].map((u) => ask(key, index * 3 + u)),
          ),
        );
        await drain(binance, count);
        // Shared across accounts: one call per series, never per viewer.
        expect(binance.calls.length).toBe(count);
        expect(
          new Set(
            binance.calls.map((call) => `${call.symbol}|${call.interval}`),
          ).size,
        ).toBe(count);
        expect(binance.state.peak).toBe(1);
        // Each answer carries its own series only (no other contract's or
        // interval's klines), whatever order the queue served them in.
        first.forEach((result, index) => {
          if (!result.ok) {
            expect(result.code).toBe('503:FUTURES_CANDLES_UNAVAILABLE');
            return;
          }
          const key = keys[Math.floor(index / 3)];
          const data = result.value!.data;
          expect(data.instrument.symbol).toBe(key.symbol);
          expect(data.interval).toBe(key.interval);
          const price = binance.priceOf(key.symbol, key.interval).toFixed(8);
          expect(data.candles.every((candle) => candle.close === price)).toBe(
            true,
          );
        });
        // 30 cold series at 50 ms each finish inside the 8 s cold wait.
        expect(tally(first.map((r) => (r.ok ? 'ok' : r.code!)))).toEqual({
          ok: count * 3,
        });

        // Five minutes of polling at the app's cadence (= each interval's
        // freshness), three accounts per series; each series' viewers opened
        // their chart at their own moment (a fixed spread, not one instant).
        const pollStart = Date.now();
        const nextPoll = keys.map(
          (key, index) =>
            pollStart +
            ((index * 7_919) %
              FUTURES_CHART_WINDOWS[key.interval as '5m'].freshMs),
        );
        const before = binance.calls.length;
        const served: Outcome[] = [];
        let longestWait = 0;
        while (Date.now() - pollStart < 5 * 60_000) {
          const due = keys
            .map((key, index) => ({ key, index }))
            .filter(({ index }) => nextPoll[index] <= Date.now());
          const answers = await drive(
            due.flatMap(({ key, index }) =>
              [0, 1, 2].map((u) => ask(key, index * 3 + u)),
            ),
          );
          answers.forEach((answer) => {
            longestWait = Math.max(
              longestWait,
              answer.settledAt - answer.startedAt,
            );
            served.push(
              !answer.ok
                ? answer.code!
                : answer.value!.data.source.stale
                  ? 'stale'
                  : 'fresh',
            );
          });
          due.forEach(({ key, index }) => {
            nextPoll[index] =
              Date.now() + FUTURES_CHART_WINDOWS[key.interval as '5m'].freshMs;
          });
          await jest.advanceTimersByTimeAsync(1_000);
        }
        const polled = binance.calls.slice(before);
        // Every poll answered from a copy within the 2 s warm wait (never a
        // 503 once warm), every refresh a weight-1 tail, at most one call per
        // series per freshness window, and far below 120 calls a minute.
        expect(tally(served)).toEqual({ fresh: served.length });
        expect(longestWait <= 2_000).toBe(true);
        expect(polled.every((call) => klinesWeight(call.limit) === 1)).toBe(
          true,
        );
        keys.forEach((key) => {
          const freshMs = FUTURES_CHART_WINDOWS[key.interval as '5m'].freshMs;
          const series = polled.filter(
            (call) =>
              call.symbol === key.symbol && call.interval === key.interval,
          );
          expect(series.length <= Math.ceil((5 * 60_000) / freshMs) + 1).toBe(
            true,
          );
        });
        let busiestMinute = 0;
        for (const call of polled) {
          busiestMinute = Math.max(
            busiestMinute,
            polled.filter(
              (other) =>
                other.startedAt >= call.startedAt &&
                other.startedAt < call.startedAt + 60_000,
            ).length,
          );
        }
        expect(polled.length > count).toBe(true);
        expect(busiestMinute <= 120).toBe(true);
        expect(binance.state.peak).toBe(1);
      },
    );

    it('a viewer that switches contract and interval gets each series only, even while an earlier refresh is still running', async () => {
      const binance = fakeBinance(3_000);
      const route = routeWithCatalog(binance);
      // BTC 5m is slow to answer; the viewer moves to ETH 5m, then BTC 1h.
      const btc = route.getInstrumentCandles('user-1', 'fut-BTCUSDT', {
        interval: '5m',
      });
      const eth = route.getInstrumentCandles('user-1', 'fut-ETHUSDT', {
        interval: '5m',
      });
      const btcHour = route.getInstrumentCandles('user-1', 'fut-BTCUSDT', {
        interval: '1h',
      });
      const [first, second, third] = await drive([btc, eth, btcHour]);
      await drain(binance, 3);
      for (const [result, symbol, interval] of [
        [first, 'BTCUSDT', '5m'],
        [second, 'ETHUSDT', '5m'],
        [third, 'BTCUSDT', '1h'],
      ] as const) {
        if (!result.ok) continue;
        expect(result.value!.data.instrument.symbol).toBe(symbol);
        expect(result.value!.data.interval).toBe(interval);
        const price = binance.priceOf(symbol, interval).toFixed(8);
        expect(
          result.value!.data.candles.every((candle) => candle.close === price),
        ).toBe(true);
      }
    });

    it('a long queue answers a viewer with a copy stale at 2 s and one without a copy with the retryable 503 at 8 s', async () => {
      // 3 s per provider call: ten cold series cannot all finish in 8 s.
      const binance = fakeBinance(3_000);
      const service = new FuturesCandleProviderService(binance, PRODUCTION);
      const cold = await drive(
        CONTRACTS.slice(0, 5).flatMap((symbol) =>
          ['5m', '15m'].map((interval) =>
            read(
              service,
              symbol.toLowerCase(),
              interval as FuturesProviderInterval,
              symbol,
            ),
          ),
        ),
      );
      const waits = cold.map((result) => result.settledAt - result.startedAt);
      expect(waits).toEqual([
        3_000, 6_150, 8_000, 8_000, 8_000, 8_000, 8_000, 8_000, 8_000, 8_000,
      ]);
      expect(tally(cold.map(outcome))).toEqual({
        fresh: 2,
        '503:FUTURES_CANDLES_UNAVAILABLE': 8,
      });
      await drain(binance, 10);
      // Warm now; past the 5m freshness every series needs a refresh again,
      // and the viewer at the back of the queue gets its copy marked stale.
      await jest.advanceTimersByTimeAsync(16_000);
      const warm = await drive(
        CONTRACTS.slice(0, 5).map((symbol) =>
          read(service, symbol.toLowerCase(), '5m', symbol),
        ),
      );
      const warmWaits = warm.map(
        (result) => result.settledAt - result.startedAt,
      );
      expect(warmWaits.every((wait) => wait === 2_000)).toBe(true);
      expect(tally(warm.map(outcome))).toEqual({ stale: 5 });
      await drain(binance, 15);
      expect(binance.state.peak).toBe(1);
    });
  });

  describe('A-4 refusals that protect Futures Last/Mark recovery', () => {
    it("every chart call leaves the coordinator's recovery reserve unspent", async () => {
      const binance = fakeBinance();
      const service = new FuturesCandleProviderService(binance, PRODUCTION);
      await drive(
        INTERVALS.map((interval) => read(service, 'btc', interval, 'BTCUSDT')),
      );
      await jest.advanceTimersByTimeAsync(16_000);
      await drive([read(service, 'btc', '5m', 'BTCUSDT')]);
      const inputs = binance.fetchKlinesPage.mock.calls.map(([input]) => input);
      expect(inputs.length).toBe(6);
      expect(
        inputs.every(
          (input) =>
            input.reserveWeight === BINANCE_REST_RECOVERY_RESERVE_WEIGHT,
        ),
      ).toBe(true);
    });

    it('a coordinator refusal (shared minute budget spent) pauses every chart read; admitted calls are tried once, never retried', async () => {
      const binance = fakeBinance(50);
      const service = new FuturesCandleProviderService(binance, PRODUCTION);
      const budgetSpent = new ProviderHttpError(
        'binance',
        'PROVIDER_RATE_LIMITED',
        'paused',
        { status: 0, retryAfterMs: 20_000 },
      );
      // Twenty series at once; from the third call on the coordinator refuses.
      const reads = CONTRACTS.flatMap((symbol) =>
        INTERVALS.map((interval) => ({ symbol, interval })),
      ).slice(0, 20);
      const pending = reads.map(({ symbol, interval }) =>
        read(service, symbol.toLowerCase(), interval, symbol),
      );
      await jest.advanceTimersByTimeAsync(260);
      expect(binance.calls.length).toBe(2);
      binance.failEverything(budgetSpent);
      await drive(pending);
      await drain(binance, 20);
      // Each admitted series was tried exactly once; nothing was re-sent.
      expect(binance.calls.length).toBe(20);
      expect(
        new Set(binance.calls.map((call) => `${call.symbol}|${call.interval}`))
          .size,
      ).toBe(20);
      // While paused, new chart reads never reach the coordinator.
      binance.failEverything(null);
      const paused = await drive([
        read(service, 'btc', '1d', 'BTCUSDT'),
        read(service, 'zzz', '1d', 'ZZZUSDT'),
      ]);
      expect(
        paused.every((result) => result.settledAt === result.startedAt),
      ).toBe(true);
      expect(binance.calls.length).toBe(20);
      // Once the coordinator would admit again, reads resume.
      await jest.advanceTimersByTimeAsync(20_000);
      await drive([read(service, 'zzz', '1d', 'ZZZUSDT')]);
      expect(binance.calls.length).toBe(21);
      expect(binance.state.peak).toBe(1);
    });

    it('busy coordinator slots (Last/Mark recovery or a sync holding them) back off only that series for 3 s', async () => {
      const binance = fakeBinance(50);
      const service = new FuturesCandleProviderService(binance, PRODUCTION);
      binance.fail(
        'BTCUSDT',
        new ProviderHttpError('binance', 'BINANCE_REST_BUSY', 'busy', {
          status: 0,
          retryAfterMs: 50,
        }),
      );
      const first = await drive([
        read(service, 'btc', '5m', 'BTCUSDT'),
        read(service, 'eth', '5m', 'ETHUSDT'),
      ]);
      expect(first.map(outcome)).toEqual([
        '503:FUTURES_CANDLES_UNAVAILABLE',
        'fresh',
      ]);
      binance.fail('BTCUSDT', null);
      // Within 3 s the busy series is not re-sent; other series still read.
      await jest.advanceTimersByTimeAsync(2_000);
      const during = await drive([
        read(service, 'btc', '5m', 'BTCUSDT'),
        read(service, 'sol', '5m', 'SOLUSDT'),
      ]);
      expect(during.map(outcome)).toEqual([
        '503:FUTURES_CANDLES_UNAVAILABLE',
        'fresh',
      ]);
      expect(binance.calls.map((call) => call.symbol)).toEqual([
        'BTCUSDT',
        'ETHUSDT',
        'SOLUSDT',
      ]);
      await jest.advanceTimersByTimeAsync(1_100);
      const after = await drive([read(service, 'btc', '5m', 'BTCUSDT')]);
      expect(after.map(outcome)).toEqual(['fresh']);
    });
  });
});

describe('Futures chart data never prices anything', () => {
  // Order, fill, TP/SL, valuation, liquidation, ranking and settlement code
  // must not import the chart's kline modules: Futures Last and Mark are
  // their only prices, so chart data can never stand in for either.
  const root = join(__dirname, '..');
  const pricingDirectories = [
    'futures',
    'orders',
    'positions',
    'portfolio',
    'batch',
    'ranking',
    'home',
    'records',
  ];
  const chartModules =
    /from '[^']*(market-candle-futures|market-candle-futures-provider\.service|market-candle-futures-windows|market-candle-futures\.repository)'/u;

  function sources(directory: string): string[] {
    return readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) return sources(path);
      return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
    });
  }

  it('no pricing, order, valuation, liquidation or settlement module imports the chart klines', () => {
    const offenders = pricingDirectories
      .flatMap((directory) => sources(join(root, directory)))
      .filter((path) => chartModules.test(readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the on-demand chart reader writes nothing: no database, no Last/Mark tables', () => {
    const provider = readFileSync(
      join(__dirname, 'market-candle-futures-provider.service.ts'),
      'utf8',
    );
    expect(
      /prisma|futuresLastPriceSnapshot|futuresMarkSnapshot/iu.test(provider),
    ).toBe(false);
  });
});
