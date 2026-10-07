import { parseLimitOrderEnabled } from '../orders/limit-order.config';

/** Development only until F2 liquidation and F3 valuation. Every mutation OFF by default. */
export function isFuturesTradingEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return parseLimitOrderEnabled(
    env.FUTURES_TRADING_ENABLED,
    'FUTURES_TRADING_ENABLED',
  );
}
