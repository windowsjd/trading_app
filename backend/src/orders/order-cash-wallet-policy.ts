import {
  AssetType,
  CurrencyCode,
  type WalletScope,
} from '../generated/prisma/client';
import { throwCashWalletScopeMismatch } from '../wallets/cash-wallet-scope';

/** Only quote creation resolves current product policy. Lifecycle uses persisted scope. */
export function newOrderCashWalletScope(assetType: AssetType): WalletScope {
  return assetType === AssetType.crypto ? 'crypto_spot' : 'securities';
}

/** Never infer a missing legacy scope: migration supplies it before deployment. */
export function requireOrderCashWalletScope(
  scope: WalletScope | null | undefined,
  currency: CurrencyCode,
): WalletScope {
  if (
    scope === 'securities' ||
    (scope === 'crypto_spot' && currency === CurrencyCode.USD)
  )
    return scope;
  return throwCashWalletScopeMismatch(
    'Order cash provenance is missing or unsupported.',
  );
}
