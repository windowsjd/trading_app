jest.mock('../generated/prisma/client', () => ({
  CurrencyCode: { KRW: 'KRW', USD: 'USD' },
  AssetType: { crypto: 'crypto' },
  FxRateSourceType: {
    provider_api: 'provider_api',
    admin_manual: 'admin_manual',
  },
  Prisma: {
    Decimal: jest.requireActual('@prisma/client/runtime/client').Decimal,
  },
}));
import {
  calculatePortfolioValuation,
  type PortfolioValuationInput,
  type PortfolioFuturesPositionInput,
} from '../portfolio/portfolio-valuation.policy';
import { futuresDecimal as d } from './futures-math';
import {
  parseFuturesContracts,
  verifiedFuturesInstrument,
} from './futures-instrument-coverage';
const now = new Date('2026-10-08T00:00:00Z');
function position(
  direction = 'long',
  price = '110',
  marginMode = 'isolated',
  leverage = 37,
): PortfolioFuturesPositionInput {
  return {
    id: 'p',
    tradingAccountId: 'account',
    instrumentId: 'i',
    status: 'open',
    direction,
    marginMode,
    leverage,
    quantity: d('2'),
    averageEntryPrice: d('100'),
    isolatedMargin: d('100'),
    instrument: {
      id: 'i',
      productType: 'synthetic_perpetual',
      settlementCurrency: 'USD',
      underlyingAsset: {
        id: 'a',
        symbol: 'BTCUSDT',
        market: 'BINANCE',
        assetType: 'crypto',
        currencyCode: 'USD',
        priceCurrency: 'USD',
        settlementCurrency: 'USD',
      },
    },
    mark: {
      id: 'mark',
      instrumentId: 'i',
      symbol: 'BTCUSDT',
      source: 'binance_usdm_mark_ws',
      providerProduct: 'binance_usdm_perpetual',
      currencyCode: 'USD',
      price: d(price),
      effectiveAt: now,
      capturedAt: now,
    },
  } as PortfolioFuturesPositionInput;
}
function input(
  positions: PortfolioFuturesPositionInput[] = [],
): PortfolioValuationInput {
  return {
    seasonParticipantId: null,
    tradingAccountId: 'account',
    initialCapitalKrw: '1000000',
    valuationAt: now,
    sourceEligibilityWorkflow: 'live_portfolio_valuation',
    cashWallets: [
      { walletScope: 'securities', currencyCode: 'KRW', balanceAmount: '100' },
      { walletScope: 'securities', currencyCode: 'USD', balanceAmount: '2' },
      { walletScope: 'crypto_spot', currencyCode: 'USD', balanceAmount: '3' },
      {
        walletScope: 'crypto_futures',
        currencyCode: 'USD',
        balanceAmount: '1000',
      },
    ],
    positions: [],
    futuresPositions: positions,
    usdKrwSnapshot: {
      id: 'fx',
      baseCurrency: 'USD',
      quoteCurrency: 'KRW',
      rate: '1400',
      sourceType: 'provider_api',
      sourceName: 'korea_exim_exchange_rate',
      effectiveAt: now,
      capturedAt: now,
      createdAt: now,
    },
  };
}
describe('F3 shared Mark valuation', () => {
  it('keeps no-Futures cash and Spot meanings', () => {
    const result = calculatePortfolioValuation(input());
    expect(result.totalAssetKrw).toBe('1407100.00000000');
    expect(result.futuresUnrealizedPnlKrw).toBe('0.00000000');
    expect(result.assetValueKrw).toBe('0.00000000');
  });
  for (const direction of ['long', 'short'])
    for (const marginMode of ['isolated', 'cross'])
      for (const leverage of [1, 37, 100])
        for (const price of ['90', '110']) {
          it(`${direction} ${marginMode} ${leverage}x mark=${price}: adds signed UPNL once with the cash FX row`, () => {
            const result = calculatePortfolioValuation(
              input([position(direction, price, marginMode, leverage)]),
            );
            const expected = d(price)
              .sub(100)
              .mul(2)
              .mul(direction === 'long' ? 1 : -1);
            expect(result.futuresUnrealizedPnlUsd).toBe(expected.toFixed(8));
            expect(result.totalAssetKrw).toBe(
              d('1407100').add(expected.mul(1400)).toFixed(8),
            );
            expect(result.cryptoValueKrw).toBe('0.00000000');
            expect(result.futuresValuationJson!.usdKrw).toEqual({
              snapshotId: 'fx',
              rate: '1400',
              effectiveAt: now.toISOString(),
            });
          });
        }
  it('offsets multiple positions with mixed modes without adding collateral/notional/estimated fees', () => {
    const result = calculatePortfolioValuation(
      input([position('long', '105'), position('short', '90', 'cross')]),
    );
    expect(result.futuresUnrealizedPnlUsd).toBe('30.00000000');
    expect(result.totalAssetKrw).toBe('1449100.00000000');
  });
  for (const corruption of [
    'missing',
    'stale',
    'future',
    'instrument',
    'symbol',
    'currency',
    'source',
    'product',
  ]) {
    it(`rejects ${corruption} Mark even with cash/Spot evidence available`, () => {
      const p = position();
      if (corruption === 'missing') p.mark = null;
      else if (corruption === 'stale')
        p.mark!.capturedAt = p.mark!.effectiveAt = new Date(+now - 5001);
      else if (corruption === 'future')
        p.mark!.capturedAt = p.mark!.effectiveAt = new Date(+now + 1);
      else if (corruption === 'instrument') p.mark!.instrumentId = 'other';
      else if (corruption === 'symbol') p.mark!.symbol = 'ETHUSDT';
      else if (corruption === 'currency') p.mark!.currencyCode = 'KRW';
      else if (corruption === 'source')
        p.mark!.source = 'binance_spot_ws_ticker' as never;
      else p.mark!.providerProduct = 'spot';
      expect(() => calculatePortfolioValuation(input([p]))).toThrow(
        /Mark Price/,
      );
    });
  }
  it('accepts the exact 5-second boundary', () => {
    const p = position();
    p.mark!.capturedAt = p.mark!.effectiveAt = new Date(+now - 5000);
    expect(
      calculatePortfolioValuation(input([p])).futuresUnrealizedPnlUsd,
    ).toBe('20.00000000');
  });
});
describe('exact public contract coverage', () => {
  const valid = {
    symbol: 'BTCUSDT',
    pair: 'BTCUSDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    marginAsset: 'USDT',
    underlyingType: 'COIN',
    contractType: 'PERPETUAL',
    status: 'TRADING',
  };
  it('requires the exact listed perpetual and rejects coin-M, dated, paused and TradFi', () => {
    expect(parseFuturesContracts({ symbols: [valid] }).size).toBe(1);
    for (const patch of [
      { contractType: 'CURRENT_QUARTER' },
      { status: 'BREAK' },
      { marginAsset: 'BTC' },
      { underlyingType: 'INDEX' },
      { baseAsset: '1000BTC' },
      { quoteAsset: 'USDC' },
    ])
      expect(
        parseFuturesContracts({ symbols: [{ ...valid, ...patch }] }).size,
      ).toBe(0);
    const p = position().instrument;
    Object.assign(p, {
      isActive: true,
      markContractJson: valid,
      markVerifiedAt: now,
    });
    p.underlyingAsset.isActive = true;
    expect(verifiedFuturesInstrument(p, now)).toBe(true);
    p.underlyingAsset.symbol = 'ETHUSDT';
    expect(verifiedFuturesInstrument(p, now)).toBe(false);
  });
});
