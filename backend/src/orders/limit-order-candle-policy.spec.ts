import {
  FIVE_MINUTES_MS,
  firstEligibleCandleOpen,
  firstEligibleCandleOpenMs,
  floorTo5mMs,
  isCandleWithinLookback,
} from './limit-order-candle-policy';

const at = (iso: string) => new Date(iso).getTime();

describe('floorTo5mMs', () => {
  it('floors to the enclosing 5-minute boundary', () => {
    expect(floorTo5mMs(at('2026-07-22T12:02:00.000Z'))).toBe(
      at('2026-07-22T12:00:00.000Z'),
    );
    expect(floorTo5mMs(at('2026-07-22T12:05:00.000Z'))).toBe(
      at('2026-07-22T12:05:00.000Z'),
    );
  });
});

describe('firstEligibleCandleOpen', () => {
  it('submitted exactly on a boundary → that same boundary is eligible', () => {
    expect(firstEligibleCandleOpenMs(at('2026-07-22T12:00:00.000Z'))).toBe(
      at('2026-07-22T12:00:00.000Z'),
    );
  });

  it('submitted mid-candle → the NEXT boundary (never the partial candle)', () => {
    expect(firstEligibleCandleOpenMs(at('2026-07-22T12:00:00.500Z'))).toBe(
      at('2026-07-22T12:05:00.000Z'),
    );
    expect(firstEligibleCandleOpenMs(at('2026-07-22T12:02:00.000Z'))).toBe(
      at('2026-07-22T12:05:00.000Z'),
    );
  });

  it('Date wrapper returns the same boundary as the ms form', () => {
    const submitted = new Date('2026-07-22T12:02:00.000Z');
    expect(firstEligibleCandleOpen(submitted).toISOString()).toBe(
      '2026-07-22T12:05:00.000Z',
    );
  });

  it('FIVE_MINUTES_MS is 300000', () => {
    expect(FIVE_MINUTES_MS).toBe(300_000);
  });
});

describe('isCandleWithinLookback', () => {
  const now = new Date('2026-07-22T12:20:00.000Z');
  it('accepts a candle whose open is within the lookback window', () => {
    // 15-minute lookback → open at 12:05 is within.
    expect(
      isCandleWithinLookback(new Date('2026-07-22T12:05:00.000Z'), now, 900_000),
    ).toBe(true);
    expect(
      isCandleWithinLookback(new Date('2026-07-22T12:05:00.000Z'), now, 900_000),
    ).toBe(true);
  });

  it('rejects a candle older than the lookback window', () => {
    expect(
      isCandleWithinLookback(new Date('2026-07-22T12:00:00.000Z'), now, 900_000),
    ).toBe(false);
  });
});
