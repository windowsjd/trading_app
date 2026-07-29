import { resolveMarketSession } from '../orders/market-calendar.policy';
import {
  countRequiredFiveMinuteSlots,
  resolveRequiredFiveMinuteSlotEndMs,
} from './candle-expected-slots.policy';

function session(market: 'KRX' | 'US', localDate: string) {
  const resolved = resolveMarketSession(market, localDate);
  if (!resolved) throw new Error(`no ${market} session on ${localDate}`);
  return resolved;
}

function at(iso: string): number {
  return new Date(iso).getTime();
}

describe('candle expected-slot policy', () => {
  describe('KRX closing single-price auction', () => {
    // 2026-07-10 is a regular Friday: 09:00–15:30 KST = 00:00–06:30Z.
    const krx = session('KRX', '20260710');

    it('stops requiring slots 10 minutes before the close', () => {
      expect(
        new Date(resolveRequiredFiveMinuteSlotEndMs(krx)).toISOString(),
      ).toBe('2026-07-10T06:20:00.000Z'); // 15:20 KST
    });

    it('expects 28 slots for the 13:00-15:30 four-hour bucket', () => {
      expect(
        countRequiredFiveMinuteSlots(
          krx,
          at('2026-07-10T04:00:00.000Z'),
          at('2026-07-10T06:30:00.000Z'),
        ),
      ).toBe(28);
    });

    it('expects 4 slots for the 15:00-15:30 hourly bucket', () => {
      expect(
        countRequiredFiveMinuteSlots(
          krx,
          at('2026-07-10T06:00:00.000Z'),
          at('2026-07-10T06:30:00.000Z'),
        ),
      ).toBe(4);
    });

    it('expects the single 15:15 slot for the last 15m bucket', () => {
      expect(
        countRequiredFiveMinuteSlots(
          krx,
          at('2026-07-10T06:15:00.000Z'),
          at('2026-07-10T06:30:00.000Z'),
        ),
      ).toBe(1);
    });

    it('leaves buckets that end before the auction untouched', () => {
      // 09:00–13:00 morning four-hour bucket.
      expect(
        countRequiredFiveMinuteSlots(
          krx,
          at('2026-07-10T00:00:00.000Z'),
          at('2026-07-10T04:00:00.000Z'),
        ),
      ).toBe(48);
    });

    it('sums to the 76 slots a full KRX day actually produces', () => {
      expect(
        countRequiredFiveMinuteSlots(
          krx,
          krx.openTime.getTime(),
          krx.closeTime.getTime(),
        ),
      ).toBe(76); // 09:00 … 15:15
    });

    it('tracks a calendar close override instead of hardcoding 15:20', () => {
      // 2026-11-19 수능일: 10:00–16:30 KST, so 16:20/16:25 are the auction
      // slots. 14:00–16:30 four-hour bucket spans 30 slots, expects 28.
      const delayed = session('KRX', '20261119');
      expect(delayed.closeTime.toISOString()).toBe('2026-11-19T07:30:00.000Z');
      expect(
        new Date(resolveRequiredFiveMinuteSlotEndMs(delayed)).toISOString(),
      ).toBe('2026-11-19T07:20:00.000Z'); // 16:20 KST
      expect(
        countRequiredFiveMinuteSlots(
          delayed,
          at('2026-11-19T05:00:00.000Z'),
          at('2026-11-19T07:30:00.000Z'),
        ),
      ).toBe(28);
    });
  });

  describe('other markets', () => {
    it('requires every slot up to the US close', () => {
      // 2026-07-09: 09:30–16:00 EDT = 13:30–20:00Z.
      const us = session('US', '20260709');
      expect(resolveRequiredFiveMinuteSlotEndMs(us)).toBe(
        us.closeTime.getTime(),
      );
      // 15:30–16:00 EDT partial hourly bucket keeps all 6 slots.
      expect(
        countRequiredFiveMinuteSlots(
          us,
          at('2026-07-09T19:30:00.000Z'),
          at('2026-07-09T20:00:00.000Z'),
        ),
      ).toBe(6);
    });

    it('returns 0 for a sub-range entirely inside the auction window', () => {
      const krx = session('KRX', '20260710');
      expect(
        countRequiredFiveMinuteSlots(
          krx,
          at('2026-07-10T06:20:00.000Z'),
          at('2026-07-10T06:30:00.000Z'),
        ),
      ).toBe(0);
    });
  });
});
