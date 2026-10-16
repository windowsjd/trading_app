import { readLimitOnCloseConfig } from './limit-on-close.config';
import { conditionalBuyEnabled } from '../conditional/conditional-buy.config';
import { conditionalEnabled } from '../conditional/conditional.config';

describe('Limit-on-Close configuration', () => {
  it('defaults to disabled with bounded evidence timing', () => {
    const config = readLimitOnCloseConfig({});
    expect(config.enabled).toBe(false);
    expect(config.evidenceMinDelayMs).toBe(1_200_000);
    expect(config.evidenceConfirmMs).toBe(300_000);
    expect(config.evidenceDeadlineMs).toBe(10_800_000);
  });

  it('accepts only exact true/false and integer seconds within bounds', () => {
    expect(readLimitOnCloseConfig({ LOC_ORDERS_ENABLED: 'true' }).enabled).toBe(
      true,
    );
    for (const env of [
      { LOC_ORDERS_ENABLED: 'yes' },
      { LOC_ORDERS_ENABLED: '' },
      { LOC_CLOSE_EVIDENCE_MIN_DELAY_SECONDS: '299' },
      { LOC_CLOSE_EVIDENCE_CONFIRM_SECONDS: '1.5' },
      { LOC_CLOSE_EVIDENCE_DEADLINE_SECONDS: '43201' },
    ])
      expect(() => readLimitOnCloseConfig(env)).toThrow();
  });

  it('reads US flags and New York wall-clock evidence times separately from KRX', () => {
    const defaults = readLimitOnCloseConfig({});
    expect(defaults.us).toEqual({
      enabled: false,
      sellEnabled: false,
      evidenceEarliestMinute: 21 * 60 + 10,
      evidenceConfirmMs: 300_000,
      evidenceDeadlineMinute: 23 * 60,
    });
    const usOnly = readLimitOnCloseConfig({
      US_STOCK_PRICE_PROVIDER: 'tiingo',
      LOC_US_ORDERS_ENABLED: 'true',
      LOC_US_SELL_ORDERS_ENABLED: 'true',
    });
    expect([usOnly.enabled, usOnly.sellEnabled]).toEqual([false, false]);
    expect([usOnly.us.enabled, usOnly.us.sellEnabled]).toEqual([true, true]);
    const krxOnly = readLimitOnCloseConfig({
      LOC_ORDERS_ENABLED: 'true',
      LOC_SELL_ORDERS_ENABLED: 'true',
    });
    expect([krxOnly.us.enabled, krxOnly.us.sellEnabled]).toEqual([
      false,
      false,
    ]);
    const tuned = readLimitOnCloseConfig({
      LOC_US_CLOSE_EVIDENCE_EARLIEST_ET: '21:30',
      LOC_US_CLOSE_EVIDENCE_CONFIRM_SECONDS: '600',
      LOC_US_CLOSE_EVIDENCE_DEADLINE_ET: '23:30',
    }).us;
    expect([
      tuned.evidenceEarliestMinute,
      tuned.evidenceConfirmMs,
      tuned.evidenceDeadlineMinute,
    ]).toEqual([21 * 60 + 30, 600_000, 23 * 60 + 30]);
  });

  it('never lets US finality start before 21:10 New York time or fit too few confirmations', () => {
    for (const env of [
      { LOC_US_ORDERS_ENABLED: 'yes' },
      { LOC_US_SELL_ORDERS_ENABLED: '1' },
      // Earlier than the 21:10 product policy (20:00 EST corrections as EDT
      // plus a margin) is a startup error, not a tunable.
      { LOC_US_CLOSE_EVIDENCE_EARLIEST_ET: '20:30' },
      { LOC_US_CLOSE_EVIDENCE_EARLIEST_ET: '21:00' },
      { LOC_US_CLOSE_EVIDENCE_EARLIEST_ET: '21:09' },
      { LOC_US_CLOSE_EVIDENCE_EARLIEST_ET: '9:10' },
      { LOC_US_CLOSE_EVIDENCE_EARLIEST_ET: '21:60' },
      { LOC_US_CLOSE_EVIDENCE_CONFIRM_SECONDS: '299' },
      { LOC_US_CLOSE_EVIDENCE_DEADLINE_ET: '24:00' },
      {
        LOC_US_CLOSE_EVIDENCE_EARLIEST_ET: '22:50',
        LOC_US_CLOSE_EVIDENCE_DEADLINE_ET: '22:55',
      },
    ])
      expect(() => readLimitOnCloseConfig(env)).toThrow();
  });

  it('enables US LOC only with the Tiingo provider (its close source)', () => {
    for (const env of [
      { LOC_US_ORDERS_ENABLED: 'true' },
      { LOC_US_SELL_ORDERS_ENABLED: 'true' },
      { LOC_US_ORDERS_ENABLED: 'true', US_STOCK_PRICE_PROVIDER: 'kis' },
    ])
      expect(() => readLimitOnCloseConfig(env)).toThrow(
        'require US_STOCK_PRICE_PROVIDER=tiingo',
      );
    // The flags off, any provider: KRX LOC is unaffected.
    expect(
      readLimitOnCloseConfig({
        LOC_ORDERS_ENABLED: 'true',
        US_STOCK_PRICE_PROVIDER: 'kis',
      }).enabled,
    ).toBe(true);
  });

  it('requires the deadline to fit the delay plus two confirmations', () => {
    expect(() =>
      readLimitOnCloseConfig({
        LOC_CLOSE_EVIDENCE_MIN_DELAY_SECONDS: '7200',
        LOC_CLOSE_EVIDENCE_CONFIRM_SECONDS: '3600',
        LOC_CLOSE_EVIDENCE_DEADLINE_SECONDS: '7200',
      }),
    ).toThrow();
  });
});

describe('conditional BUY capability flag', () => {
  it('is independent of the protection flag and off by default', () => {
    expect(conditionalBuyEnabled({})).toBe(false);
    expect(conditionalBuyEnabled({ CONDITIONAL_ORDERS_ENABLED: 'true' })).toBe(
      false,
    );
    expect(conditionalEnabled({ CONDITIONAL_ORDERS_ENABLED: 'true' })).toBe(
      true,
    );
    expect(
      conditionalBuyEnabled({ CONDITIONAL_BUY_ORDERS_ENABLED: 'true' }),
    ).toBe(true);
    expect(() =>
      conditionalBuyEnabled({ CONDITIONAL_BUY_ORDERS_ENABLED: '1' }),
    ).toThrow();
  });
});
