import Decimal from 'decimal.js';
import type { Direction, MarginMode } from './api';

/**
 * Futures order sizing for the trade form: a USD order amount (the position's
 * notional, leverage applied) becomes the contract quantity the existing
 * Futures commands take, and the ratio slider gets an estimated upper bound.
 *
 * Estimates only. The server prices, rounds and checks every command; these
 * mirror its rules (backend futures-input / futures-math / futures-risk):
 * quantities have at most 8 decimals, margin is notional ÷ leverage, the fee
 * is notional × the account's trade fee rate, maintenance is 0.5% of the Mark
 * notional plus the closing fee, and Cross positions are valued on Mark.
 */
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

/** 기본 선택 배수. 2x is the low leverage the beginner futures practice suggests. */
export const FUTURES_LEVERAGE_PRESETS = [1, 2, 3, 5, 10, 25, 50, 100] as const;
export const FUTURES_MAINTENANCE_RATE = '0.005';
/**
 * Room kept below the estimated limit for 100%: a market quantity is fixed when
 * it is sent and filled at a later Futures Last, and Mark keeps moving.
 */
export const FUTURES_AMOUNT_HEADROOM = '0.005';

const AMOUNT = /^\d{1,16}(\.\d{1,2})?$/u;
const PRICE = /^\d{1,16}(\.\d{1,8})?$/u;
const SIGNED = /^-?\d{1,20}(\.\d{1,8})?$/u;
const FEE = /^(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?)$/u;

const positive = (value: string | null | undefined): value is string =>
  typeof value === 'string' && PRICE.test(value) && new D(value).gt(0);
const signed = (value: string | null | undefined) =>
  typeof value === 'string' && SIGNED.test(value.trim()) ? new D(value.trim()) : null;
const cents = (value: Decimal) => Decimal.max(0, value).toDecimalPlaces(2, Decimal.ROUND_DOWN).toFixed();

export function isFuturesLeverage(value: number) {
  return Number.isInteger(value) && value >= 1 && value <= 100;
}

/** A positive price with at most 8 decimals, else null (never a guessed price). */
export function futuresPrice(value: string | null | undefined) {
  const text = value?.trim();
  return positive(text) ? text : null;
}

export type FuturesSizing =
  | { state: 'empty' }
  | { state: 'invalid' | 'unpriced' | 'tooSmall'; message: string }
  | { state: 'ready'; quantity: string };

/**
 * USD amount → contract quantity at the basis price, rounded down to the
 * server's 8 decimals so the order never exceeds the amount. Without a valid
 * basis price nothing is converted.
 */
export function futuresQuantityForAmount(amount: string, price: string | null, unpriced: string): FuturesSizing {
  const text = amount.trim();
  if (!text) return { state: 'empty' };
  if (!AMOUNT.test(text) || new D(text).lte(0))
    return { state: 'invalid', message: '주문 금액은 0보다 큰 USD 금액으로 소수점 2자리까지 입력해주세요.' };
  if (!positive(price)) return { state: 'unpriced', message: unpriced };
  const quantity = new D(text).div(price).toDecimalPlaces(8, Decimal.ROUND_DOWN);
  if (quantity.lte(0))
    return { state: 'tooSmall', message: '주문 금액이 너무 작아 계약 수량이 0이 됩니다. 금액을 늘려주세요.' };
  return { state: 'ready', quantity: quantity.toFixed() };
}

/** Whether a reduce quantity is the whole position (the reduce then closes it). */
export function futuresWholePosition(quantity: string, positionQuantity: string) {
  return PRICE.test(quantity) && PRICE.test(positionQuantity) && new D(quantity).eq(positionQuantity);
}

/** quantity × price, the notional a quantity stands for (display and ratios). */
export function futuresNotional(quantity: string, price: string) {
  return new D(quantity).mul(price).toFixed();
}

/** Estimated initial margin (rounded up, like the server) and fee of an amount. */
export function futuresEntryEstimate(amount: string, leverage: number, feeRate: string | null | undefined) {
  if (!AMOUNT.test(amount.trim()) || !isFuturesLeverage(leverage)) return null;
  const notional = new D(amount.trim());
  return {
    margin: notional.div(leverage).toDecimalPlaces(8, Decimal.ROUND_CEIL).toFixed(),
    fee: feeRate && FEE.test(feeRate) ? notional.mul(feeRate).toDecimalPlaces(8).toFixed() : null,
  };
}

export type FuturesEntryCapacity =
  | {
      state: 'ready';
      /** The amount whose estimated margin, fee and risk use exactly the collateral. */
      limit: string;
      /** What 100% writes: the limit less headroom, rounded down to cents. */
      max: string;
    }
  | { state: 'unavailable'; reason: 'collateral' | 'fee' | 'price' | 'maintenance' };

/**
 * How large a new or increased position the account's collateral can carry,
 * by the server's checks for that margin mode:
 * - Cross free collateral stays ≥ 0 (fee + initial margin; Cross margin is on
 *   Mark and an immediate Mark loss counts, a Mark gain is never counted);
 * - the Cross base (cash − reservations − isolated allocations) stays ≥ 0, so
 *   Isolated margin can be allocated (`isolated_allocation_underfunded`);
 * - the Cross liquidation buffer stays above maintenance + closing fees;
 * - a new Isolated position must start above its own maintenance on Mark (an
 *   increase is checked as the whole position, which this cannot see).
 * Collateral figures are the positions endpoint's (`collateral.freeCollateral`,
 * `cross.metrics`); unknown inputs never produce a number.
 */
export function futuresEntryCapacity(input: {
  freeCollateral: string | null | undefined;
  crossBase: string | null | undefined;
  liquidationBuffer: string | null | undefined;
  leverage: number;
  feeRate: string | null | undefined;
  marginMode: MarginMode;
  direction: Direction;
  /** The basis the quantity is computed at (Futures Last, a limit or trigger price). */
  price: string | null | undefined;
  /** Fresh Mark when the basis is the current Futures Last; otherwise omitted. */
  mark?: string | null;
  /** Opening a new position (not increasing a held one). */
  opening: boolean;
}): FuturesEntryCapacity {
  const [free, base, buffer] = [input.freeCollateral, input.crossBase, input.liquidationBuffer].map(signed);
  if (!free || !base || !buffer || !isFuturesLeverage(input.leverage))
    return { state: 'unavailable', reason: 'collateral' };
  if (!input.feeRate || !FEE.test(input.feeRate)) return { state: 'unavailable', reason: 'fee' };
  if (!positive(input.price)) return { state: 'unavailable', reason: 'price' };
  const fee = new D(input.feeRate);
  const margin = new D(1).div(input.leverage);
  const maintenance = new D(FUTURES_MAINTENANCE_RATE).add(fee);
  const side = input.direction === 'long' ? 1 : -1;
  // Mark per unit of the basis price; 1 when the order fills at a later price.
  const mark = positive(input.mark) ? new D(input.mark).div(input.price) : new D(1);
  // Unrealized result per notional at entry: (Mark − price) × direction.
  const opening = mark.sub(1).mul(side);
  const loss = Decimal.max(0, opening.neg());
  let rates: [Decimal, Decimal][];
  if (input.marginMode === 'isolated') {
    // A new Isolated margin + its Mark result must exceed maintenance + closing fee.
    if (input.opening && margin.add(opening).sub(mark.mul(maintenance)).lte(0)) return { state: 'unavailable', reason: 'maintenance' };
    const rate = fee.add(margin);
    rates = [[free, rate], [base, rate], [buffer, rate]];
  } else {
    // Margin and maintenance are on Mark; a Mark below the price is no relief.
    const valued = Decimal.max(mark, 1);
    rates = [
      [free, fee.add(valued.mul(margin)).add(loss)],
      [base, fee],
      [buffer, fee.add(valued.mul(maintenance)).add(loss)],
    ];
  }
  let limit: Decimal | null = null;
  for (const [available, rate] of rates) {
    if (rate.lte(0)) continue;
    const amount = Decimal.max(0, available).div(rate);
    limit = limit === null ? amount : Decimal.min(limit, amount);
  }
  if (limit === null) return { state: 'unavailable', reason: 'collateral' };
  return {
    state: 'ready',
    limit: limit.toDecimalPlaces(8, Decimal.ROUND_DOWN).toFixed(),
    max: cents(limit.mul(new D(1).sub(FUTURES_AMOUNT_HEADROOM))),
  };
}

/** `ratio` of a capacity, rounded down to cents ('0' when nothing fits). */
export function futuresAmountAtRatio(capacity: string, ratio: number) {
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) return '0';
  return cents(new D(capacity).mul(ratio));
}

/** Where an amount sits on a capacity, 0–1 (an over-limit amount reads 100%). */
export function futuresAmountRatio(amount: string, capacity: string | null) {
  if (!capacity || !AMOUNT.test(amount.trim())) return 0;
  const total = new D(capacity);
  if (total.lte(0)) return 0;
  return Math.min(1, new D(amount.trim()).div(total).toNumber());
}

/** Whether a valid amount is above an estimated limit (unknown is never over). */
export function futuresAmountExceeds(amount: string, limit: string | null | undefined) {
  if (!limit || !AMOUNT.test(amount.trim())) return false;
  return new D(amount.trim()).gt(limit);
}
