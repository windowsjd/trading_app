import {
  conditionalSellEnabled,
  independentTpSlEnabled,
} from './conditional-sell.config';
import { conditionalBuyEnabled } from './conditional-buy.config';
import { conditionalEnabled } from './conditional.config';
import { readLimitOnCloseConfig } from '../orders/limit-on-close.config';
import { validateEnv } from '../common/env-validation';

describe('SELL capability flags', () => {
  it('default off and never follow an existing flag', () => {
    const existing = {
      CONDITIONAL_ORDERS_ENABLED: 'true',
      CONDITIONAL_BUY_ORDERS_ENABLED: 'true',
      LOC_ORDERS_ENABLED: 'true',
    };
    expect(conditionalSellEnabled({})).toBe(false);
    expect(independentTpSlEnabled({})).toBe(false);
    expect(readLimitOnCloseConfig({}).sellEnabled).toBe(false);
    expect(conditionalSellEnabled(existing)).toBe(false);
    expect(independentTpSlEnabled(existing)).toBe(false);
    expect(readLimitOnCloseConfig(existing).sellEnabled).toBe(false);
    expect(readLimitOnCloseConfig(existing).enabled).toBe(true);
    expect(conditionalEnabled(existing)).toBe(true);
    expect(conditionalBuyEnabled(existing)).toBe(true);
  });

  it('are independent of each other', () => {
    const condition = { CONDITIONAL_SELL_ORDERS_ENABLED: 'true' };
    expect(conditionalSellEnabled(condition)).toBe(true);
    expect(independentTpSlEnabled(condition)).toBe(false);
    const protection = { INDEPENDENT_TP_SL_ORDERS_ENABLED: 'true' };
    expect(conditionalSellEnabled(protection)).toBe(false);
    expect(independentTpSlEnabled(protection)).toBe(true);
    const loc = readLimitOnCloseConfig({ LOC_SELL_ORDERS_ENABLED: 'true' });
    expect(loc.sellEnabled).toBe(true);
    expect(loc.enabled).toBe(false);
  });

  it('reject anything but exact true/false at startup', () => {
    for (const [name, value] of [
      ['CONDITIONAL_SELL_ORDERS_ENABLED', '1'],
      ['INDEPENDENT_TP_SL_ORDERS_ENABLED', 'yes'],
      ['LOC_SELL_ORDERS_ENABLED', 'TRUE'],
      ['LOC_SELL_ORDERS_ENABLED', ''],
    ] as const) {
      expect(() => validateEnv({ [name]: value })).toThrow(
        `${name} must be true or false`,
      );
    }
    expect(() =>
      validateEnv({
        CONDITIONAL_SELL_ORDERS_ENABLED: 'false',
        INDEPENDENT_TP_SL_ORDERS_ENABLED: 'false',
        LOC_SELL_ORDERS_ENABLED: 'false',
      }),
    ).not.toThrow();
  });
});
