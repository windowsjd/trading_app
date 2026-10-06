jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    AssetPriceSourceType: {
      official_batch: 'official_batch',
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
    },
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    CurrencyCode: {
      KRW: 'KRW',
      USD: 'USD',
    },
    FxRateSourceType: {
      official_batch: 'official_batch',
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
    },
    Prisma: {
      Decimal,
    },
  };
});

import { Prisma } from '../generated/prisma/client';
import {
  CANONICAL_CASH_WALLET_IDENTITIES,
  canonicalCashWalletSetIssue,
} from './canonical-cash-wallets';
import { calculatePortfolioValuation } from '../portfolio/portfolio-valuation.policy';

const at = new Date('2026-10-06T00:00:00Z');
const fx = {
  id: 'one-fx-evidence',
  baseCurrency: 'USD' as const,
  quoteCurrency: 'KRW' as const,
  rate: '1400',
  sourceType: 'admin_manual' as const,
  approvedByUserId: 'operator',
  effectiveAt: at,
  capturedAt: at,
  createdAt: at,
};
const wallets = (usd = ['0', '0', '0']) =>
  CANONICAL_CASH_WALLET_IDENTITIES.map((identity, i) => ({
    ...identity,
    balanceAmount: i === 0 ? '5000000' : usd[i - 1],
    reservedAmount: '0',
  }));
const value = (
  cashWallets = wallets(),
  positions: Parameters<
    typeof calculatePortfolioValuation
  >[0]['positions'] = [],
) =>
  calculatePortfolioValuation({
    seasonParticipantId: 'participant',
    tradingAccountId: 'account',
    initialCapitalKrw: '10000000',
    cashWallets,
    positions,
    valuationAt: at,
    usdKrwSnapshot: fx,
  });

describe('canonical cash wallet set and valuation', () => {
  it('requires each of the four identities once, with no substitutes', () => {
    expect(canonicalCashWalletSetIssue(wallets())).toBeNull();
    expect(canonicalCashWalletSetIssue(wallets().slice(0, 3))).toBe('missing');
    expect(canonicalCashWalletSetIssue([...wallets(), wallets()[0]])).toBe(
      'invalid',
    );
    expect(
      canonicalCashWalletSetIssue([
        ...wallets().slice(0, 3),
        { walletScope: 'crypto_futures', currencyCode: 'KRW' },
      ]),
    ).toBe('invalid');
  });

  it('zero Crypto containers preserve the legacy KRW-only values without FX', () => {
    const result = calculatePortfolioValuation({
      seasonParticipantId: 'participant',
      initialCapitalKrw: '10000000',
      cashWallets: wallets(),
      positions: [],
      valuationAt: at,
    });
    expect(result).toMatchObject({
      totalAssetKrw: '5000000.00000000',
      krwCash: '5000000.00000000',
      usdCashKrw: '0.00000000',
      assetValueKrw: '0.00000000',
      realizedPnlKrw: '0.00000000',
      unrealizedPnlKrw: '0.00000000',
      returnRate: '-50.00000000',
      fxRateSourceDecision: null,
    });
  });

  it('counts all three USD balances once and never subtracts reservations', () => {
    const cash = wallets(['1000', '500', '200']);
    cash[1].reservedAmount = '100';
    const result = value(cash);
    expect(result.totalAssetKrw).toBe('7380000.00000000');
    expect(result.usdCashKrw).toBe('2380000.00000000');
  });

  it('cash and USD positions use the same FX evidence', () => {
    const result = value(wallets(['1000', '500', '200']), [
      {
        assetId: 'usd-position',
        assetType: 'crypto',
        currencyCode: 'USD',
        quantity: '2',
        averageCost: '90',
        realizedPnlKrw: '123',
        latestPriceSnapshot: {
          assetId: 'usd-position',
          currencyCode: 'USD',
          price: '100',
          sourceType: 'admin_manual',
          effectiveAt: at,
          capturedAt: at,
          createdAt: at,
        },
      },
    ]);
    expect(result.assetValueKrw).toBe('280000.00000000');
    expect(result.unrealizedPnlKrw).toBe('28000.00000000');
    expect(result.realizedPnlKrw).toBe('123.00000000');
    expect(result.totalAssetKrw).toBe('7660000.00000000');
    expect(result.usdCashKrw).toBe('2380000.00000000');
  });

  it('changing only the location of USD cash preserves every valuation component', () => {
    expect(value(wallets(['500', '500', '700']))).toEqual(
      value(wallets(['1700', '0', '0'])),
    );
  });

  it('never presents missing, duplicate or negative cash as zero', () => {
    expect(() => value(wallets().slice(0, 3))).toThrow(
      'All four canonical cash wallets',
    );
    expect(() => value([...wallets(), wallets()[0]])).toThrow(
      'Exactly one non-negative cash wallet',
    );
    expect(() => value(wallets(['0', '-1', '0']))).toThrow(
      'Exactly one non-negative cash wallet',
    );
    expect(
      new Prisma.Decimal(
        value(wallets(['0.00000001', '0.00000001', '0.00000001'])).usdCashKrw,
      ).equals('0.00004200'),
    ).toBe(true);
  });
});
