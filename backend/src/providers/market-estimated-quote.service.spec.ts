jest.mock('../generated/prisma/client', () => ({
  AssetType: {
    domestic_stock: 'domestic_stock',
    us_stock: 'us_stock',
    crypto: 'crypto',
  },
  CurrencyCode: { KRW: 'KRW', USD: 'USD' },
  Prisma: {
    Decimal: jest.requireActual<typeof import('@prisma/client/runtime/client')>(
      '@prisma/client/runtime/client',
    ).Decimal,
  },
  PrismaClient: class PrismaClient {},
}));

import { MarketDisplayPriceService } from './market-display-price.service';
import {
  isInCurrentRegularSession,
  MarketEstimatedQuoteService,
} from './market-estimated-quote.service';
import type { TiingoQuoteService } from './tiingo/tiingo-quote.service';

const AAPL = {
  id: 'asset-aapl',
  symbol: 'AAPL',
  market: 'NAS',
  assetType: 'us_stock' as never,
  priceCurrency: 'USD' as never,
};

describe('display-only provider facades', () => {
  it('change nothing when Tiingo is absent or disabled', async () => {
    const absent = new MarketDisplayPriceService();
    expect(await absent.resolve(AAPL, new Date())).toBeNull();
    expect(await absent.displaySourceNames(AAPL)).toBeNull();
    const disabled = new MarketDisplayPriceService({
      isEnabled: () => false,
      resolveDisplayPrice: jest.fn(),
    } as unknown as TiingoQuoteService);
    expect(await disabled.resolve(AAPL, new Date())).toBeNull();
    expect(new MarketEstimatedQuoteService().subscribe(jest.fn())).toEqual(
      expect.any(Function),
    );
    expect(
      await new MarketEstimatedQuoteService().loadTarget('asset-aapl'),
    ).toBeNull();
  });

  it('routes a managed asset to the Tiingo source only', async () => {
    const tiingo = {
      isEnabled: () => true,
      targetForAsset: jest.fn().mockResolvedValue({ assetId: 'asset-aapl' }),
    } as unknown as TiingoQuoteService;
    const service = new MarketDisplayPriceService(tiingo);
    expect(await service.displaySourceNames(AAPL)).toEqual([
      'tiingo_equity_reference_price',
    ]);
    expect(service.isEphemeralSourceName('tiingo_equity_reference_price')).toBe(
      true,
    );
    expect(service.isEphemeralSourceName('kis_us_delayed_trade')).toBe(false);
  });

  it('maps estimates to the separate app contract and gates by the regular session', () => {
    let listener: ((quote: unknown) => void) | null = null;
    const service = new MarketEstimatedQuoteService({
      onEstimatedQuote: (callback: (quote: unknown) => void) => {
        listener = callback;
        return () => undefined;
      },
    } as unknown as TiingoQuoteService);
    const delivered: unknown[] = [];
    service.subscribe((event) => delivered.push(event));
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-10-13T14:30:00.000Z')); // 10:30 ET
      const quote = {
        assetId: 'asset-aapl',
        bidPrice: '247.45',
        bidSize: '300',
        askPrice: null,
        askSize: null,
        spread: '0.0004',
        referencePrice: '247.5',
        effectiveAt: new Date('2026-10-13T14:29:59.000Z'),
        capturedAt: new Date('2026-10-13T14:29:59.500Z'),
      };
      listener!(quote);
      expect(delivered).toEqual([
        {
          type: 'asset_estimated_quote',
          assetId: 'asset-aapl',
          kind: 'estimated_liquidity',
          provider: 'tiingo',
          priceCurrency: 'USD',
          quantityUnit: 'share',
          bid: { price: '247.45', size: '300' },
          ask: { price: null, size: null },
          spread: '0.0004',
          referencePrice: '247.5',
          effectiveAt: '2026-10-13T14:29:59.000Z',
          capturedAt: '2026-10-13T14:29:59.500Z',
        },
      ]);
      // Pre-market estimates are not delivered as live data.
      jest.setSystemTime(new Date('2026-10-13T12:00:00.000Z'));
      listener!({
        ...quote,
        effectiveAt: new Date('2026-10-13T11:59:59.000Z'),
        capturedAt: new Date('2026-10-13T11:59:59.500Z'),
      });
      expect(delivered).toHaveLength(1);
      expect(
        isInCurrentRegularSession(
          { effectiveAt: quote.effectiveAt, capturedAt: quote.capturedAt },
          new Date('2026-10-13T14:31:30.000Z'),
        ),
      ).toBe(false); // older than the 60 s estimate horizon
    } finally {
      jest.useRealTimers();
    }
  });
});
