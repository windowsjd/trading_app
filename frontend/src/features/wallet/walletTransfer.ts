import Decimal from 'decimal.js';
import type { WalletBalanceDto } from './api';

export function parseTransferAmount(text: string): string | null {
  const value = text.trim();
  if (!/^\d{1,16}(\.\d{1,8})?$/.test(value)) return null;
  const amount = new Decimal(value);
  return amount.gt(0) ? amount.toFixed(8) : null;
}

export function transferAvailableAmount(wallet: WalletBalanceDto | null): string | null {
  if (!wallet || wallet.currencyCode !== 'USD' || typeof wallet.balanceAmount !== 'string' || typeof wallet.reservedAmount !== 'string') return null;
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
  if (code === 'INSUFFICIENT_AVAILABLE_BALANCE') return '보내는 지갑의 이체 가능 잔액이 부족합니다. 잔액을 확인해주세요.';
  if (code === 'WALLET_TRANSFER_IDEMPOTENCY_CONFLICT') return '다른 이체에 사용된 요청입니다. 원장에서 처리 내역을 확인해주세요.';
  if (code === 'WALLET_TRANSFER_WALLET_NOT_FOUND') return '선택한 계정에서 지갑을 확인할 수 없습니다.';
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
