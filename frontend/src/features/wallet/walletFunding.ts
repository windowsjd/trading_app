import Decimal from 'decimal.js';

/** Exactly zero on a decimal string ('0', '0.00000000'); absent or unreadable is not zero. */
export function isZeroAmount(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    return new Decimal(value).isZero();
  } catch {
    return false;
  }
}

/** Above zero on a decimal string; absent or unreadable is not. */
function isPositiveAmount(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    return new Decimal(value).gt(0);
  } catch {
    return false;
  }
}

/** The product an order screen trades, by the wallet it pays from. */
export type FundingProduct = 'domestic_stock' | 'us_stock' | 'crypto_spot' | 'crypto_futures';
export type UsdWalletScope = 'securities' | 'crypto_spot' | 'crypto_futures';

/** A way money reaches that wallet, as the existing sheets can make it. */
export type FundingAction =
  | { kind: 'transfer'; destination: UsdWalletScope }
  | { kind: 'fx'; fromCurrency: 'KRW' | 'USD' };

/**
 * Each product's own wallet and the routes the app supports into it:
 * USD wallets take a USD transfer from another USD wallet (wallet-transfers);
 * Securities KRW and USD exchange with each other (fx). Securities KRW takes
 * no USD transfer, so its only route here is 환전 (USD → KRW).
 */
export const FUNDING_WALLET: Readonly<Record<FundingProduct, { name: string; actions: readonly FundingAction[] }>> = {
  domestic_stock: { name: '증권 원화 지갑', actions: [{ kind: 'fx', fromCurrency: 'USD' }] },
  us_stock: { name: '증권 달러 지갑', actions: [{ kind: 'fx', fromCurrency: 'KRW' }, { kind: 'transfer', destination: 'securities' }] },
  crypto_spot: { name: '암호화폐 현물 지갑', actions: [{ kind: 'transfer', destination: 'crypto_spot' }] },
  crypto_futures: { name: '암호화폐 선물 지갑', actions: [{ kind: 'transfer', destination: 'crypto_futures' }] },
};

/**
 * What an order screen says about the wallet it pays from:
 * `empty` — the wallet's TOTAL balance is exactly zero;
 * `committed` — it holds money, but none of it is usable now (reserved by
 * open orders, or held as Futures margin);
 * null — usable money, or unknown (loading, failed or missing reads are never
 * shown as an empty wallet).
 */
export function walletFundingState(balance: string | null | undefined, usable: string | null | undefined): 'empty' | 'committed' | null {
  if (isZeroAmount(balance)) return 'empty';
  return isPositiveAmount(balance) && isZeroAmount(usable) ? 'committed' : null;
}

/** The notice for that state, naming the product's own wallet. */
export function walletFundingMessage(product: FundingProduct, state: 'empty' | 'committed'): string {
  const { name } = FUNDING_WALLET[product];
  if (state === 'empty') return `${name}이 비어 있습니다.`;
  return product === 'crypto_futures'
    ? `${name}의 금액이 모두 포지션 증거금이나 주문에 쓰이고 있어 지금 주문할 수 있는 금액이 없습니다.`
    : `${name}의 금액이 모두 다른 주문에 예약되어 있어 지금 주문할 수 있는 금액이 없습니다.`;
}
