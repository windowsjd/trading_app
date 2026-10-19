jest.mock('../generated/prisma/client', () => {
  const runtime = jest.requireActual<{ Decimal: unknown }>(
    '@prisma/client/runtime/client',
  );
  return {
    PrismaClient: class PrismaClient {},
    Prisma: { Decimal: runtime.Decimal },
  };
});

import { HttpException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import type {
  BinanceCandlePageInput,
  BinanceCandlePageResult,
  CanonicalBinanceCandle,
} from '../providers/binance/binance-candle.types';
import { ProviderHttpError } from '../providers/provider.types';
import {
  FuturesCandleProviderService,
  readFuturesCandleProviderConfig,
} from './market-candle-futures-provider.service';

const M5 = 5 * 60_000;
const M15 = 15 * 60_000;

function kline(openMs: number, intervalMs: number, nowMs: number) {
  return {
    openTime: new Date(openMs),
    closeTime: new Date(openMs + intervalMs),
    open: new Prisma.Decimal(100),
    high: new Prisma.Decimal(102),
    low: new Prisma.Decimal(99),
    close: new Prisma.Decimal(101),
    volume: new Prisma.Decimal(3),
    amount: new Prisma.Decimal(300),
    isClosed: openMs + intervalMs - 1 < nowMs,
    sourceUpdatedAt: new Date(nowMs),
  } satisfies CanonicalBinanceCandle;
}

/**
 * A Binance stand-in answering every page with the buckets it covers. `omit`
 * drops buckets (a row the parser refused); `hold()` keeps calls open until
 * released, counting how many run at once.
 */
function fakeIngestion(intervalMs: number) {
  const calls: BinanceCandlePageInput[] = [];
  let failure: Error | null = null;
  let gate: Promise<void> | null = null;
  const ingestion = {
    calls,
    omit: new Set<number>(),
    active: 0,
    peak: 0,
    /** Wall-clock start and end of every call. */
    spans: [] as Array<{ start: number; end: number }>,
    fail(next: Error | null) {
      failure = next;
    },
    hold() {
      let release = () => {};
      gate = new Promise<void>((resolve) => {
        release = () => {
          gate = null;
          resolve();
        };
      });
      return release;
    },
    fetchKlinesPage: jest.fn(
      async (
        input: BinanceCandlePageInput,
      ): Promise<BinanceCandlePageResult> => {
        calls.push(input);
        const span = { start: Date.now(), end: Number.NaN };
        ingestion.spans.push(span);
        ingestion.active += 1;
        ingestion.peak = Math.max(ingestion.peak, ingestion.active);
        try {
          if (gate) await gate;
        } finally {
          ingestion.active -= 1;
          span.end = Date.now();
        }
        if (failure) throw failure;
        const nowMs = input.now!.getTime();
        const candles: CanonicalBinanceCandle[] = [];
        for (
          let open = input.from.getTime();
          open < input.to.getTime() && open <= nowMs;
          open += intervalMs
        ) {
          if (!ingestion.omit.has(open)) {
            candles.push(kline(open, intervalMs, nowMs));
          }
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
    ),
  };
  return ingestion;
}

/** Lets queued promise callbacks run (no timers involved). */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

async function errorCode(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (caught) {
    if (caught instanceof HttpException) {
      const body = caught.getResponse() as { error: { code: string } };
      return `${caught.getStatus()}:${body.error.code}`;
    }
    return 'unexpected';
  }
  return 'resolved';
}

describe('FuturesCandleProviderService', () => {
  // 12:02:30 UTC, inside the 12:00 5m bucket.
  const now = new Date('2026-10-20T12:02:30.000Z');
  const currentStart = Math.floor(now.getTime() / M5) * M5;
  const read = (
    service: FuturesCandleProviderService,
    at: Date,
    interval: '5m' | '15m' = '5m',
    instrumentId = 'fut-btc',
  ) => service.read({ instrumentId, symbol: 'BTCUSDT', interval, now: at });

  it('reads the whole 48 h window once (577 buckets, current one open) and serves it to later viewers', async () => {
    const ingestion = fakeIngestion(M5);
    const service = new FuturesCandleProviderService(ingestion, {
      maxCallsPerMinute: 60,
    });

    const first = await read(service, now);
    expect(ingestion.calls).toHaveLength(1);
    expect(ingestion.calls[0].interval).toBe('5m');
    expect(ingestion.calls[0].limit).toBe(577);
    expect(ingestion.calls[0].from.getTime()).toBe(currentStart - 576 * M5);
    expect(ingestion.calls[0].to.getTime()).toBe(currentStart + M5);
    expect(first.candles).toHaveLength(577);
    expect(first.candles.filter((candle) => !candle.isClosed)).toHaveLength(1);
    expect(first.candles.at(-1)!.openMs).toBe(currentStart);
    expect(first.stale).toBe(false);

    const second = await read(service, new Date(now.getTime() + 10_000));
    expect(ingestion.calls).toHaveLength(1);
    expect(second.candles === first.candles).toBe(true);
    // A request whose clock reads earlier than the copy is served the copy.
    const earlier = await read(service, new Date(now.getTime() - 1_000));
    expect(ingestion.calls).toHaveLength(1);
    expect(earlier.stale).toBe(false);
  });

  it('shares one provider call between concurrent viewers of the same contract and interval', async () => {
    const ingestion = fakeIngestion(M5);
    const service = new FuturesCandleProviderService(ingestion, {
      maxCallsPerMinute: 60,
    });
    await Promise.all([
      read(service, now),
      read(service, now),
      read(service, now),
    ]);
    expect(ingestion.calls).toHaveLength(1);
  });

  it('refreshes only the tail (weight-1 page) once the copy is no longer current', async () => {
    const ingestion = fakeIngestion(M5);
    const service = new FuturesCandleProviderService(ingestion, {
      maxCallsPerMinute: 60,
    });
    await read(service, now);
    // Same bucket, older than the 15 s freshness: from the bucket before the
    // last cached one (the last closed bucket is read again), 2 rows.
    const later = new Date(now.getTime() + 20_000);
    const refreshed = await read(service, later);
    expect(ingestion.calls).toHaveLength(2);
    expect(ingestion.calls[1].from.getTime()).toBe(currentStart - M5);
    expect(ingestion.calls[1].limit).toBe(2);
    expect(refreshed.candles).toHaveLength(577);
    expect(refreshed.stale).toBe(false);
    // Next bucket: the boundary ends the copy even inside the freshness.
    const nextBucket = new Date(currentStart + M5 + 1_000);
    const rolled = await read(service, nextBucket);
    expect(ingestion.calls).toHaveLength(3);
    expect(ingestion.calls[2].from.getTime()).toBe(currentStart - M5);
    expect(ingestion.calls[2].limit).toBe(3);
    expect(rolled.candles.at(-1)!.openMs).toBe(currentStart + M5);
    expect(
      rolled.candles.find((c) => c.openMs === currentStart)!.isClosed,
    ).toBe(true);
    // Duplicate buckets are never kept, and the window slides forward.
    const opens = rolled.candles.map((candle) => candle.openMs);
    expect(new Set(opens).size).toBe(opens.length);
    expect(opens[0]).toBe(currentStart + M5 - 576 * M5);
  });

  it('serves the last good copy as stale when a refresh fails, and 503 with nothing cached', async () => {
    const ingestion = fakeIngestion(M5);
    const service = new FuturesCandleProviderService(ingestion, {
      maxCallsPerMinute: 60,
    });
    await read(service, now);
    ingestion.fail(
      new ProviderHttpError('binance', 'PROVIDER_TIMEOUT', 'binance timeout'),
    );
    const later = new Date(now.getTime() + 20_000);
    const stale = await read(service, later);
    expect(stale.stale).toBe(true);
    expect(stale.candles).toHaveLength(577);
    // The failed key backs off: no second provider call within 15 s.
    await read(service, new Date(later.getTime() + 5_000));
    expect(ingestion.calls).toHaveLength(2);

    expect(await errorCode(read(service, later, '15m'))).toBe(
      '503:FUTURES_CANDLES_UNAVAILABLE',
    );
  });

  it('runs provider calls one at a time, spaced, whatever the contract or interval', async () => {
    const ingestion = fakeIngestion(M5);
    const service = new FuturesCandleProviderService(ingestion, {
      maxCallsPerMinute: 60,
      callSpacingMs: 40,
    });
    const release = ingestion.hold();
    const reads = [
      read(service, now, '5m', 'a'),
      read(service, now, '5m', 'b'),
      read(service, now, '15m', 'a'),
    ];
    await settle();
    // The first call holds the only on-demand slot; the others queue.
    expect(ingestion.calls).toHaveLength(1);
    release();
    await Promise.all(reads);
    expect(ingestion.peak).toBe(1);
    expect(ingestion.calls).toHaveLength(3);
    // Each call starts ≥ the spacing after the previous one ended (timer slack 5 ms).
    for (let index = 1; index < ingestion.spans.length; index += 1) {
      const gap = ingestion.spans[index].start - ingestion.spans[index - 1].end;
      expect(gap >= 35).toBe(true);
    }
  });

  it('a call that never settles gives up its turn instead of stalling every later read', async () => {
    const ingestion = fakeIngestion(M5);
    const service = new FuturesCandleProviderService(ingestion, {
      maxCallsPerMinute: 60,
      callSpacingMs: 0,
      coldWaitMs: 20,
      turnMaxHoldMs: 30,
    });
    const release = ingestion.hold();
    // a's call hangs; its viewer gets the retryable 503 after 20 ms.
    expect(await errorCode(read(service, now, '5m', 'a'))).toBe(
      '503:FUTURES_CANDLES_UNAVAILABLE',
    );
    // b queues behind it and starts once a's 30 ms turn has run out, although
    // a never settled.
    expect(await errorCode(read(service, now, '5m', 'b'))).toBe(
      '503:FUTURES_CANDLES_UNAVAILABLE',
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(ingestion.calls).toHaveLength(2);
    // Once the provider answers, both copies serve the next reads.
    release();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const later = new Date(now.getTime() + 1_000);
    expect((await read(service, later, '5m', 'a')).stale).toBe(false);
    expect((await read(service, later, '5m', 'b')).stale).toBe(false);
    expect(ingestion.calls).toHaveLength(2);
  });

  it('serves a cached copy as stale while its refresh waits behind another contract', async () => {
    const ingestion = fakeIngestion(M5);
    const service = new FuturesCandleProviderService(ingestion, {
      maxCallsPerMinute: 60,
      callSpacingMs: 0,
      warmWaitMs: 20,
      coldWaitMs: 20,
    });
    await read(service, now, '5m', 'a');
    const later = new Date(now.getTime() + 20_000);
    const release = ingestion.hold();
    // Nothing cached for b: the retryable 503 instead of an endless wait.
    const cold = errorCode(read(service, later, '5m', 'b'));
    // a needs a refresh, queued behind b: its copy comes back marked stale.
    const warm = await read(service, later, '5m', 'a');
    expect(warm.stale).toBe(true);
    expect(warm.candles).toHaveLength(577);
    expect(await cold).toBe('503:FUTURES_CANDLES_UNAVAILABLE');
    release();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Both refreshes completed for the next poll: served without a new call.
    const calls = ingestion.calls.length;
    const next = await read(
      service,
      new Date(later.getTime() + 1_000),
      '5m',
      'a',
    );
    const retried = await read(
      service,
      new Date(later.getTime() + 1_000),
      '5m',
      'b',
    );
    expect(ingestion.calls).toHaveLength(calls);
    expect(next.stale).toBe(false);
    expect(retried.stale).toBe(false);
  });

  it('re-reads the whole window once when the cached copy has a missing bucket', async () => {
    const ingestion = fakeIngestion(M5);
    const service = new FuturesCandleProviderService(ingestion, {
      maxCallsPerMinute: 60,
      callSpacingMs: 0,
    });
    const hole = currentStart - 100 * M5;
    ingestion.omit.add(hole);
    const first = await read(service, now);
    expect(first.candles.some((candle) => candle.openMs === hole)).toBe(false);
    expect(first.candles).toHaveLength(576);
    // Never padded: the gap stays a gap until Binance answers for it.
    const second = await read(service, new Date(now.getTime() + 20_000));
    expect(ingestion.calls[1].from.getTime()).toBe(currentStart - 576 * M5);
    expect(ingestion.calls[1].limit).toBe(577);
    expect(second.candles.some((candle) => candle.openMs === hole)).toBe(false);
    // The same gap is not re-read again: tail refreshes resume.
    await read(service, new Date(now.getTime() + 40_000));
    expect(ingestion.calls[2].limit).toBe(2);
    // A hole Binance does answer for is repaired by that one re-read.
    const repaired = fakeIngestion(M5);
    const other = new FuturesCandleProviderService(repaired, {
      maxCallsPerMinute: 60,
      callSpacingMs: 0,
    });
    repaired.omit.add(hole);
    await read(other, now);
    repaired.omit.clear();
    const fixed = await read(other, new Date(now.getTime() + 20_000));
    expect(fixed.candles.some((candle) => candle.openMs === hole)).toBe(true);
    expect(fixed.candles).toHaveLength(577);
  });

  it('pauses on-demand reads only until the coordinator admits again after its own refusal', async () => {
    const ingestion = fakeIngestion(M15);
    const service = new FuturesCandleProviderService(ingestion, {
      maxCallsPerMinute: 60,
      callSpacingMs: 0,
    });
    // Status 0: the shared minute budget is spent (no 418/429 from Binance).
    ingestion.fail(
      new ProviderHttpError('binance', 'PROVIDER_RATE_LIMITED', 'paused', {
        status: 0,
        retryAfterMs: 5_000,
      }),
    );
    expect(await errorCode(read(service, now, '15m', 'fut-btc'))).toBe(
      '503:FUTURES_CANDLES_UNAVAILABLE',
    );
    ingestion.fail(null);
    expect(
      await errorCode(
        read(service, new Date(now.getTime() + 3_000), '15m', 'fut-eth'),
      ),
    ).toBe('503:FUTURES_CANDLES_UNAVAILABLE');
    expect(ingestion.calls).toHaveLength(1);
    // No 30 s floor: reads resume once the coordinator would admit.
    await read(service, new Date(now.getTime() + 6_000), '15m', 'fut-eth');
    expect(ingestion.calls).toHaveLength(2);
  });

  it('drops series nobody has read for 10 minutes', async () => {
    const ingestion = fakeIngestion(M5);
    const service = new FuturesCandleProviderService(ingestion, {
      maxCallsPerMinute: 60,
      callSpacingMs: 0,
    });
    await read(service, now, '5m', 'a');
    const wall = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(wall + 11 * 60_000);
    try {
      await read(service, new Date(now.getTime() + 20_000), '5m', 'a');
    } finally {
      clock.mockRestore();
    }
    // The idle copy was gone: the whole window again, not a tail.
    expect(ingestion.calls).toHaveLength(2);
    expect(ingestion.calls[1].limit).toBe(577);
  });

  it('pauses every on-demand read after a rate-limit answer', async () => {
    const ingestion = fakeIngestion(M15);
    const service = new FuturesCandleProviderService(ingestion, {
      maxCallsPerMinute: 60,
    });
    ingestion.fail(
      new ProviderHttpError('binance', 'PROVIDER_RATE_LIMITED', 'limited', {
        status: 429,
        retryAfterMs: 45_000,
      }),
    );
    expect(await errorCode(read(service, now, '15m', 'fut-btc'))).toBe(
      '503:FUTURES_CANDLES_UNAVAILABLE',
    );
    ingestion.fail(null);
    expect(
      await errorCode(
        read(service, new Date(now.getTime() + 40_000), '15m', 'fut-eth'),
      ),
    ).toBe('503:FUTURES_CANDLES_UNAVAILABLE');
    expect(ingestion.calls).toHaveLength(1);
    await read(service, new Date(now.getTime() + 46_000), '15m', 'fut-eth');
    expect(ingestion.calls).toHaveLength(2);
  });

  it('caps provider calls per minute regardless of how many contracts are viewed', async () => {
    const ingestion = fakeIngestion(M5);
    const service = new FuturesCandleProviderService(ingestion, {
      maxCallsPerMinute: 2,
    });
    await read(service, now, '5m', 'a');
    await read(service, now, '5m', 'b');
    expect(await errorCode(read(service, now, '5m', 'c'))).toBe(
      '503:FUTURES_CANDLES_UNAVAILABLE',
    );
    expect(ingestion.calls).toHaveLength(2);
    await read(service, new Date(now.getTime() + 61_000), '5m', 'c');
    expect(ingestion.calls).toHaveLength(3);
  });

  it('treats an unusable provider page as a failure, never as data', async () => {
    const ingestion = fakeIngestion(M5);
    ingestion.fetchKlinesPage.mockResolvedValueOnce({
      candles: [],
      providerReturnedRows: 3,
      acceptedRows: 0,
      rejectedRows: 3,
      duplicateRows: 0,
      nextCursor: null,
      stopReason: 'malformed_response',
      complete: false,
    });
    const service = new FuturesCandleProviderService(ingestion, {
      maxCallsPerMinute: 60,
    });
    expect(await errorCode(read(service, now))).toBe(
      '503:FUTURES_CANDLES_UNAVAILABLE',
    );
  });

  it('reads FUTURES_CANDLE_PROVIDER_MAX_CALLS_PER_MINUTE strictly', () => {
    expect(readFuturesCandleProviderConfig({})).toEqual({
      maxCallsPerMinute: 60,
    });
    expect(
      readFuturesCandleProviderConfig({
        FUTURES_CANDLE_PROVIDER_MAX_CALLS_PER_MINUTE: '30',
      }),
    ).toEqual({ maxCallsPerMinute: 30 });
    for (const value of ['0', '601', '1.5', 'ten']) {
      expect(() =>
        readFuturesCandleProviderConfig({
          FUTURES_CANDLE_PROVIDER_MAX_CALLS_PER_MINUTE: value,
        }),
      ).toThrow('FUTURES_CANDLE_PROVIDER_MAX_CALLS_PER_MINUTE');
    }
  });
});
