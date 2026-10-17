import Decimal from 'decimal.js';
import { buyAmountAtRatio } from '../tradingAccount/indicativePreview.ts';

/**
 * Ratio picks (slider and 25/50/75/100%) of the conditional BUY/SELL forms
 * (2026-10-18): the ordinary order form's controls on a watch's size. Input
 * help only — a watch reserves nothing, and the server re-checks cash, the
 * holding and every input rule when it fires. Every size is rounded DOWN, so
 * a pick never exceeds the cash or the holding it was taken from. Pure
 * module: runs under `node --test`.
 *
 * - Stock BUY: shares of the available cash at a reference price with the
 *   ordinary form's fee headroom (never below 0.2 % or the real fee), whole
 *   shares for a limit execution and 6 decimals for a market one. A limit
 *   execution is priced at its limit price (its reservation when it fires).
 *   A market one needs the fresh current price and uses the higher of it and
 *   the watch price; with no current price (the market is closed, or the
 *   price failed) the ratio stays off and the quantity is typed.
 * - Crypto BUY keeps the fee-exclusive principal amount of the ordinary form.
 * - SELL: a share of the holding (not of the unreserved part: nothing is
 *   reserved while watching), whole shares for a stock limit execution.
 */
export const RATIO_PICKS = [0.25, 0.5, 0.75, 1] as const;

const BUY_FEE_BUFFER = new Decimal('0.002');

function positive(value: string | null | undefined): Decimal | null {
  const text = value?.trim() ?? '';
  if (!/^\d{1,20}(?:\.\d{1,12})?$/u.test(text)) return null;
  const parsed = new Decimal(text);
  return parsed.gt(0) ? parsed : null;
}

function validRatio(ratio: number) {
  return Number.isFinite(ratio) && ratio > 0 && ratio <= 1;
}

/** Rounded down to the method's unit; null when nothing is left. */
function sized(value: Decimal, wholeShares: boolean): string | null {
  const scaled = value.toDecimalPlaces(wholeShares ? 0 : 6, Decimal.ROUND_DOWN);
  if (scaled.lte(0)) return null;
  return wholeShares ? scaled.toFixed(0) : scaled.toFixed(6).replace(/\.?0+$/u, '');
}

export type ConditionalBuyRatioInput = {
  crypto: boolean;
  executionType: 'market' | 'limit';
  /** Available cash (balance − reserved); null while unknown. */
  available: string | null;
  feeRate: string | null | undefined;
  /** The fresh current price; null when there is none. */
  currentPrice: string | null;
  triggerPrice: string;
  limitPrice: string;
  /** Registered while the market is closed (no current price by definition). */
  offSession: boolean;
  currency: string;
};

/** The stock price a ratio is computed at; null when there is no safe one. */
export function conditionalBuyRatioPrice(input: ConditionalBuyRatioInput): string | null {
  if (input.executionType === 'limit') return positive(input.limitPrice)?.toFixed() ?? null;
  const current = positive(input.currentPrice);
  const trigger = positive(input.triggerPrice);
  return current && trigger ? Decimal.max(current, trigger).toFixed() : null;
}

/** Why the BUY ratio cannot size the watch now; null when it can. */
export function getConditionalBuyRatioBlock(input: ConditionalBuyRatioInput): string | null {
  if (input.available === null) return '주문 가능 금액을 확인하면 비율을 계산할 수 있어요.';
  if (!positive(input.available)) return `${input.currency} 주문 가능 금액이 없어요.`.trim();
  if (input.crypto)
    return buyAmountAtRatio(input.available, input.feeRate, 1) === null
      ? '수수료 정보를 확인해야 매수 금액 비율을 계산할 수 있어요.'
      : null;
  if (input.executionType === 'limit')
    return positive(input.limitPrice) ? null : '발동 시 지정가격을 입력하면 비율 수량을 계산할 수 있어요.';
  if (!positive(input.triggerPrice)) return '감시가격을 입력하면 비율 수량을 계산할 수 있어요.';
  if (!positive(input.currentPrice))
    return input.offSession
      ? '정규장 외 시간에는 현재가가 없어 시장가 발동 수량을 비율로 계산할 수 없어요. 수량을 직접 입력하거나 발동 시 지정가를 선택해 주세요.'
      : '현재가를 확인할 수 없어 비율 수량을 계산할 수 없어요. 수량은 직접 입력할 수 있어요.';
  return null;
}

/** The watch's size at a ratio: stock shares, or the crypto principal amount. */
export function conditionalBuySizeAtRatio(input: ConditionalBuyRatioInput, ratio: number): string | null {
  if (!validRatio(ratio) || getConditionalBuyRatioBlock(input)) return null;
  if (input.crypto) {
    const amount = buyAmountAtRatio(input.available, input.feeRate, ratio);
    return amount && positive(amount) ? amount : null;
  }
  const available = positive(input.available);
  const price = positive(conditionalBuyRatioPrice(input));
  if (!available || !price) return null;
  const fee = Decimal.max(BUY_FEE_BUFFER, positive(input.feeRate) ?? 0);
  return sized(available.mul(ratio).div(price.mul(fee.add(1))), input.executionType === 'limit');
}

export type ConditionalSellRatioInput = {
  /** The server's holding quantity; null while unknown. */
  holding: string | null;
  /** Whole shares only (a stock with limit execution). */
  wholeShares: boolean;
};

/** Why the SELL ratio cannot size the condition now; null when it can. */
export function getConditionalSellRatioBlock(input: ConditionalSellRatioInput): string | null {
  if (input.holding === null) return '보유 수량을 확인하면 비율을 계산할 수 있어요.';
  return positive(input.holding) ? null : '보유 수량이 없어요.';
}

export function conditionalSellQuantityAtRatio(input: ConditionalSellRatioInput, ratio: number): string | null {
  const holding = positive(input.holding);
  if (!holding || !validRatio(ratio)) return null;
  return sized(holding.mul(ratio), input.wholeShares);
}

/** The share of `capacity` an entered size is, clamped to 0..1; 0 when unknown. */
export function ratioOfCapacity(value: string, capacity: string | null): number {
  const entered = positive(value);
  const total = positive(capacity);
  if (!entered || !total) return 0;
  return Math.min(1, entered.div(total).toNumber());
}
