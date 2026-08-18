import { Decimal } from '@prisma/client/runtime/client';

/**
 * General accounts are independent of every season, including its fee.
 * This is the single canonical source used when a TradingContext is built.
 * The default matches the product's established 0.1% virtual-trade policy;
 * operators may override it explicitly without adding an account column.
 */
export const DEFAULT_GENERAL_TRADE_FEE_RATE = '0.001000';

export class GeneralTradingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeneralTradingConfigError';
  }
}

export function parseGeneralTradeFeeRate(raw: string | undefined): Decimal {
  const value = raw === undefined ? DEFAULT_GENERAL_TRADE_FEE_RATE : raw.trim();
  if (!/^(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?)$/u.test(value)) {
    throw new GeneralTradingConfigError(
      `GENERAL_TRADE_FEE_RATE must be a decimal between 0 and 1 with at most 6 fractional digits. Received: ${JSON.stringify(raw)}.`,
    );
  }
  return new Decimal(value).toDecimalPlaces(6);
}

export function readGeneralTradeFeeRate(
  env: NodeJS.ProcessEnv = process.env,
): Decimal {
  return parseGeneralTradeFeeRate(env.GENERAL_TRADE_FEE_RATE);
}
