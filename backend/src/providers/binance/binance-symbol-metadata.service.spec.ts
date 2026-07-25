import { BinanceSymbolMetadataService } from './binance-symbol-metadata.service';
import { BINANCE_FIXED_SYMBOLS } from './binance-fixed-asset-universe';

function exchangeInfo(entries: Array<[string, string]>) {
  return {
    symbols: entries.map(([symbol, tickSize]) => ({
      symbol,
      filters: [{ filterType: 'PRICE_FILTER', tickSize }],
    })),
  };
}

function createService(
  fetchExchangeInfo: jest.Mock = jest.fn().mockResolvedValue({
    response: exchangeInfo([
      ['BTCUSDT', '0.01000000'],
      ['DOGEUSDT', '0.00001000'],
    ]),
    receivedAt: new Date(),
  }),
) {
  const client = { fetchExchangeInfo } as unknown as never;
  return {
    service: new BinanceSymbolMetadataService(client),
    fetchExchangeInfo,
  };
}

describe('BinanceSymbolMetadataService', () => {
  it('serves the reviewed fixed-universe fallback before any refresh completes', () => {
    const { service } = createService();

    expect(
      service.getDisplayPriceDecimals({
        market: 'BINANCE',
        symbol: 'DOGEUSDT',
      }),
    ).toBe(5);
    expect(
      service.getPrecision({ market: 'BINANCE', symbol: 'DOGEUSDT' }),
    ).toMatchObject({ source: 'fixed_universe' });
  });

  it('has fallback metadata for all 10 fixed symbols', () => {
    const { service } = createService();

    for (const symbol of BINANCE_FIXED_SYMBOLS) {
      expect(
        service.getDisplayPriceDecimals({ market: 'BINANCE', symbol }),
      ).toEqual(expect.any(Number));
    }
  });

  it('prefers live exchangeInfo tick sizes once cached', async () => {
    const { service } = createService(
      jest.fn().mockResolvedValue({
        response: exchangeInfo([['BTCUSDT', '0.00010000']]),
        receivedAt: new Date(),
      }),
    );

    await service.refresh();

    expect(
      service.getPrecision({ market: 'BINANCE', symbol: 'BTCUSDT' }),
    ).toEqual({
      symbol: 'BTCUSDT',
      priceTickSize: '0.00010000',
      displayPriceDecimals: 4,
      source: 'exchange_info',
    });
  });

  it('does not call exchangeInfo on every read', async () => {
    const { service, fetchExchangeInfo } = createService();

    await service.refresh();
    for (let index = 0; index < 50; index += 1) {
      service.getDisplayPriceDecimals({
        market: 'BINANCE',
        symbol: 'BTCUSDT',
      });
    }
    await new Promise((resolve) => setImmediate(resolve));

    expect(fetchExchangeInfo).toHaveBeenCalledTimes(1);
  });

  it('triggers at most one background refresh from a burst of cold reads', async () => {
    const { service, fetchExchangeInfo } = createService();

    for (let index = 0; index < 20; index += 1) {
      service.getDisplayPriceDecimals({
        market: 'BINANCE',
        symbol: 'BTCUSDT',
      });
    }
    await new Promise((resolve) => setImmediate(resolve));

    expect(fetchExchangeInfo).toHaveBeenCalledTimes(1);
  });

  it('keeps the last successful cache when a refresh fails', async () => {
    const fetchExchangeInfo = jest.fn().mockResolvedValueOnce({
      response: exchangeInfo([['BTCUSDT', '0.00010000']]),
      receivedAt: new Date(),
    });
    const { service } = createService(fetchExchangeInfo);

    await service.refresh();
    fetchExchangeInfo.mockRejectedValue(
      Object.assign(new Error('boom'), { code: 'PROVIDER_HTTP_ERROR' }),
    );
    await service.refresh();

    expect(
      service.getPrecision({ market: 'BINANCE', symbol: 'BTCUSDT' }),
    ).toMatchObject({ displayPriceDecimals: 4, source: 'exchange_info' });
    expect(service.getStatus()).toMatchObject({
      lastRefreshOk: false,
      lastErrorCode: 'PROVIDER_HTTP_ERROR',
      cachedSymbolCount: 1,
    });
  });

  it('falls back to the fixed universe when the provider is unreachable from the start', async () => {
    const { service } = createService(
      jest.fn().mockRejectedValue(new Error('offline')),
    );

    await service.refresh();

    expect(
      service.getDisplayPriceDecimals({ market: 'BINANCE', symbol: 'XRPUSDT' }),
    ).toBe(4);
    expect(service.getStatus().lastRefreshOk).toBe(false);
  });

  it('returns null for non-Binance assets and unknown symbols', () => {
    const { service } = createService();

    expect(
      service.getDisplayPriceDecimals({ market: 'KRX', symbol: '005930' }),
    ).toBeNull();
    expect(
      service.getDisplayPriceDecimals({ market: 'NAS', symbol: 'AAPL' }),
    ).toBeNull();
    expect(
      service.getDisplayPriceDecimals({ market: 'BINANCE', symbol: 'NOPE' }),
    ).toBeNull();
  });
});
