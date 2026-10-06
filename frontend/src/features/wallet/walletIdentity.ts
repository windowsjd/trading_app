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
