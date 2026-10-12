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
