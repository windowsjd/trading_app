import { Decimal } from '@prisma/client/runtime/client';

/** General FX is independent of Season.fxFeeRate and general trade fees. */
export const DEFAULT_GENERAL_FX_FEE_RATE = '0.001000';

export class GeneralFxConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeneralFxConfigError';
  }
}

export function parseGeneralFxFeeRate(raw: string | undefined): Decimal {
  const value = raw === undefined ? DEFAULT_GENERAL_FX_FEE_RATE : raw.trim();
  if (!/^(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?)$/u.test(value)) {
    throw new GeneralFxConfigError(
      `GENERAL_FX_FEE_RATE must be a decimal between 0 and 1 with at most 6 fractional digits. Received: ${JSON.stringify(raw)}.`,
    );
  }
  return new Decimal(value).toDecimalPlaces(6);
}

export function readGeneralFxFeeRate(
  env: NodeJS.ProcessEnv = process.env,
): Decimal {
  return parseGeneralFxFeeRate(env.GENERAL_FX_FEE_RATE);
}
