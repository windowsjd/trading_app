import { limitOnCloseEnabled } from './limit-on-close.config';
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
 */
export function readOrderCapabilities(env: NodeJS.ProcessEnv = process.env) {
  const limitEnabled = isLimitOrderEnabled(env);
  return {
    limitOrder: {
      enabled: limitEnabled,
      autoExecutionEnabled:
        limitEnabled && readLimitOrderMatchingConfig(env).matchingEnabled,
    },
    limitOnClose: {
      enabled: limitEnabled && limitOnCloseEnabled(env),
      markets: ['KRX'] as const,
      sides: ['buy'] as const,
      attachedProtection: false as const,
    },
  };
}
