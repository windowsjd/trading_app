import Decimal from 'decimal.js';
import type { WalletBalanceDto } from './api';

export function parseTransferAmount(text: string): string | null {
  const value = text.trim();
  if (!/^\d{1,16}(\.\d{1,8})?$/.test(value)) return null;
  const amount = new Decimal(value);
  return amount.gt(0) ? amount.toFixed(8) : null;
}

export function transferAvailableAmount(wallet: WalletBalanceDto | null): string | null {
  if (!wallet || !['KRW', 'USD'].includes(wallet.currencyCode) || typeof wallet.balanceAmount !== 'string' || typeof wallet.reservedAmount !== 'string') return null;
  try {
    const balance = new Decimal(wallet.balanceAmount);
    const reserved = new Decimal(wallet.reservedAmount);
    if (!balance.isFinite() || !reserved.isFinite() || reserved.lt(0) || balance.lt(reserved)) return null;
    return balance.sub(reserved).toFixed(8);
  } catch { return null; }
}

export function transferAmountFits(amount: string | null, available: string | null): boolean {
  return amount !== null && available !== null && new Decimal(amount).lte(available);
}

export function transferErrorMessage(code: string | null): string {
  if (code === 'INSUFFICIENT_AVAILABLE_BALANCE' || code === 'INSUFFICIENT_BALANCE') return '보내는 지갑의 이체 가능 잔액이 부족합니다. 잔액을 확인해주세요.';
  if (code === 'WALLET_TRANSFER_IDEMPOTENCY_CONFLICT') return '다른 이체에 사용된 요청입니다. 원장에서 처리 내역을 확인해주세요.';
  if (code === 'WALLET_TRANSFER_WALLET_NOT_FOUND') return '선택한 계정에서 지갑을 확인할 수 없습니다.';
  if (code === 'QUOTE_EXPIRED') return '견적이 만료되었습니다. 다시 견적을 받아주세요.';
  if (code === 'RATE_CHANGED_REQUOTE_REQUIRED') return '환율이 허용 범위보다 변경되었습니다. 다시 견적을 받아주세요.';
  if (code === 'FX_RATE_UNAVAILABLE' || code === 'FX_RATE_STALE' || code === 'FX_PROVIDER_RATE_STALE' || code === 'FX_PROVIDER_RATE_UNAVAILABLE' || code === 'PROVIDER_RATE_STALE' || code === 'PROVIDER_RATE_UNAVAILABLE') return '최신 환율을 확인할 수 없습니다. 잠시 후 다시 견적을 받아주세요.';
  if (code === 'WALLET_TRANSFER_ROUTE_UNSUPPORTED') return '증권 KRW와 USD 사이의 이동은 환전하기를 이용해주세요.';
  return '이체를 처리하지 못했습니다. 같은 요청으로 다시 시도할 수 있습니다.';
}

export class WalletTransferContractError extends Error {
  constructor() {
    super('이체 결과를 안전하게 확인할 수 없습니다. 원장에서 처리 내역을 확인해주세요.');
    this.name = 'WalletTransferContractError';
  }
}

/** A malformed success must never show balances under the selected account. */
export function parseWalletTransferResponse(
  payload: unknown,
  accountId: string,
  request: import('../tradingAccount/api').WalletTransferRequestDto,
): import('../tradingAccount/api').WalletTransferDto {
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;
  const money = (value: unknown): value is string => typeof value === 'string' && /^\d{1,16}\.\d{8}$/.test(value);
  const fail = (): never => { throw new WalletTransferContractError(); };
  if (!record(payload) || payload.tradingAccountId !== accountId || payload.currencyCode !== 'USD' ||
      typeof payload.transferId !== 'string' || !payload.transferId ||
      typeof payload.executedAt !== 'string' || !payload.executedAt.endsWith('Z') || !Number.isFinite(Date.parse(payload.executedAt)) ||
      !money(payload.amount) || payload.amount !== parseTransferAmount(request.amount) ||
      !record(payload.source) || !record(payload.destination)) return fail();
  for (const [wallet, walletId] of [[payload.source, request.sourceWalletId], [payload.destination, request.destinationWalletId]] as const) {
    if (wallet.walletId !== walletId || typeof wallet.walletScope !== 'string' || !['securities', 'crypto_spot', 'crypto_futures'].includes(wallet.walletScope) ||
        !money(wallet.balanceAfter) || !money(wallet.availableAfter) || new Decimal(wallet.availableAfter).gt(wallet.balanceAfter)) return fail();
  }
  if (payload.source.walletScope === payload.destination.walletScope) return fail();
  return payload as unknown as import('../tradingAccount/api').WalletTransferDto;
}

type FxTransferQuote = import('../tradingAccount/api').WalletFxTransferQuoteDto;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const money = (value: unknown): value is string => typeof value === 'string' && /^\d{1,16}\.\d{8}$/.test(value);
const iso = (value: unknown): value is string => typeof value === 'string' && value.endsWith('Z') && Number.isFinite(Date.parse(value));
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const feeRate = (value: unknown): value is string => typeof value === 'string' && /^\d\.\d{6}$/.test(value) && new Decimal(value).lte(1);
const contractFailure = (): never => { throw new WalletTransferContractError(); };

export function parseWalletFxTransferQuote(payload: unknown, accountId: string, request: import('../tradingAccount/api').WalletFxTransferQuoteRequestDto, sourceCurrency: 'KRW' | 'USD'): FxTransferQuote {
  if (!record(payload) || payload.tradingAccountId !== accountId || !id(payload.quoteId) ||
      payload.sourceWalletId !== request.sourceWalletId || payload.destinationWalletId !== request.destinationWalletId ||
      payload.fromCurrency !== sourceCurrency || payload.toCurrency !== (sourceCurrency === 'KRW' ? 'USD' : 'KRW') ||
      payload.sourceAmount !== parseTransferAmount(request.amount) || !money(payload.sourceAmount) ||
      !money(payload.appliedRate) || new Decimal(payload.appliedRate).lte(0) ||
      !feeRate(payload.feeRate) || !money(payload.feeAmount) || payload.feeCurrency !== payload.toCurrency ||
      !money(payload.netTargetAmount) || !money(payload.grossTargetAmount) || !iso(payload.expiresAt) ||
      !iso(payload.rateCapturedAt) || !iso(payload.rateEffectiveAt) ||
      !((typeof payload.maxChangeBps === 'string' || typeof payload.maxChangeBps === 'number') && /^\d+(\.\d+)?$/.test(String(payload.maxChangeBps)))) return contractFailure();
  return payload as unknown as FxTransferQuote;
}

export function parseWalletFxTransferResponse(payload: unknown, accountId: string, quote: FxTransferQuote): import('../tradingAccount/api').WalletFxTransferDto {
  if (!record(payload) || payload.tradingAccountId !== accountId || quote.tradingAccountId !== accountId ||
      payload.quoteId !== quote.quoteId || !id(payload.commandId) || !id(payload.transferId) || !iso(payload.executedAt) ||
      payload.sourceAmount !== quote.sourceAmount || !money(payload.receivedAmount) ||
      !record(payload.source) || !record(payload.destination) || !record(payload.fx)) return contractFailure();
  const fx = payload.fx;
  if (fx.quoteId !== quote.quoteId || !id(fx.exchangeId) || fx.fromCurrency !== quote.fromCurrency || fx.toCurrency !== quote.toCurrency ||
      fx.sourceAmount !== quote.sourceAmount || fx.netTargetAmount !== payload.receivedAmount ||
      !money(fx.appliedRate) || new Decimal(fx.appliedRate).lte(0) || !money(fx.feeAmount) || !feeRate(fx.feeRate) ||
      fx.feeCurrency !== quote.toCurrency || fx.feeRate !== quote.feeRate || fx.quotedRate !== quote.appliedRate) return contractFailure();
  for (const [wallet, walletId, currency] of [[payload.source, quote.sourceWalletId, quote.fromCurrency], [payload.destination, quote.destinationWalletId, quote.toCurrency]] as const) {
    if (wallet.walletId !== walletId || wallet.currencyCode !== currency ||
        (currency === 'KRW' ? wallet.walletScope !== 'securities' : !(typeof wallet.walletScope === 'string' && ['crypto_spot', 'crypto_futures'].includes(wallet.walletScope))) ||
        !money(wallet.balanceAfter) || !money(wallet.availableAfter) || new Decimal(wallet.availableAfter).gt(wallet.balanceAfter)) return contractFailure();
  }
  return payload as unknown as import('../tradingAccount/api').WalletFxTransferDto;
}
