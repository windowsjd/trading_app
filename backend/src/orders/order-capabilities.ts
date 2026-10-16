import {
  limitOnCloseMarkets,
  readLimitOnCloseConfig,
} from './limit-on-close.config';
import { readLimitOrderMatchingConfig } from './limit-order-matching.config';
import { isLimitOrderEnabled } from './limit-order.config';

/**
 * Read-only order feature availability for clients (2026-10-13, order UI 2nd
 * phase). It only reports the same server flags the quote/create gates read,
 * in the same precedence (`LIMIT_ORDER_DISABLED` is checked before
 * `LOC_ORDERS_DISABLED`), so a client never has to replicate an operations
 * flag. It decides nothing: quote and create still re-validate the session,
 * market, side, account and Season rules at their own clock, and a later flag
 * change is caught there. Already accepted LOC orders settle regardless.
 * `limitOnClose` stays the BUY answer (its `sides` is unchanged); LOC SELL
 * (2026-10-13) is its own additive block behind its own flag.
 *
 * `markets` lists exactly the markets whose registration flag for that side
 * is on: `KRX` (LOC_ORDERS_ENABLED / LOC_SELL_ORDERS_ENABLED) and, since
 * 2026-10-17, `US` (LOC_US_ORDERS_ENABLED / LOC_US_SELL_ORDERS_ENABLED).
 * `enabled` is true when at least one market is listed.
 */
export function readOrderCapabilities(env: NodeJS.ProcessEnv = process.env) {
  const limitEnabled = isLimitOrderEnabled(env);
  const loc = readLimitOnCloseConfig(env);
  const buyMarkets = limitEnabled ? limitOnCloseMarkets(loc, 'buy') : [];
  const sellMarkets = limitEnabled ? limitOnCloseMarkets(loc, 'sell') : [];
  return {
    limitOrder: {
      enabled: limitEnabled,
      autoExecutionEnabled:
        limitEnabled && readLimitOrderMatchingConfig(env).matchingEnabled,
    },
    limitOnClose: {
      enabled: buyMarkets.length > 0,
      markets: buyMarkets,
      sides: ['buy'] as const,
      attachedProtection: false as const,
    },
    limitOnCloseSell: {
      enabled: sellMarkets.length > 0,
      markets: sellMarkets,
    },
  };
}
