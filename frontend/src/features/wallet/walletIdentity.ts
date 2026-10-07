import type { WalletScope } from './api';

export const WALLET_SCOPE_LABELS: Record<WalletScope, string> = {
  securities: '증권',
  crypto_spot: '암호화폐 · 현물',
  crypto_futures: '암호화폐 · 선물',
};

export const USD_WALLET_SCOPES = ['securities', 'crypto_spot', 'crypto_futures'] as const;

export const WALLET_GROUPS = [
  { scope: 'securities', currencies: ['KRW', 'USD'] },
  { scope: 'crypto_spot', currencies: ['USD'] },
  { scope: 'crypto_futures', currencies: ['USD'] },
] as const;

export const TRANSFER_WALLETS = [
  { key: 'securities-KRW', scope: 'securities', currency: 'KRW' },
  { key: 'securities', scope: 'securities', currency: 'USD' },
  { key: 'crypto_spot', scope: 'crypto_spot', currency: 'USD' },
  { key: 'crypto_futures', scope: 'crypto_futures', currency: 'USD' },
] as const;
export type TransferWalletIdentity = typeof TRANSFER_WALLETS[number];

export function transferRouteKind(source: TransferWalletIdentity, destination: TransferWalletIdentity): 'same_currency' | 'cross_currency' | 'fx' | 'invalid' {
  if (source.key === destination.key) return 'invalid';
  if (source.scope === 'securities' && destination.scope === 'securities') return 'fx';
  return source.currency === destination.currency ? 'same_currency' : 'cross_currency';
}
