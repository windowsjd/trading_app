import { ProviderHttpError } from '../provider.types';
import { BinanceSymbolMetadataService } from './binance-symbol-metadata.service';
import {
  BINANCE_FIXED_ASSET_UNIVERSE,
  BINANCE_FIXED_SYMBOLS,
} from './binance-fixed-asset-universe';

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
  it('prefers live precision over fallback for all fifteen additions', async () => {
    const additions = BINANCE_FIXED_ASSET_UNIVERSE.slice(10);
    const { service } = createService(
      jest.fn().mockResolvedValue({
        response: exchangeInfo(
          additions.map((entry) => [entry.symbol, '0.000000001']),
        ),
        receivedAt: new Date(),
      }),
    );
    for (const entry of additions) {
      expect(
        service.getPrecision({ market: 'BINANCE', symbol: entry.symbol }),
      ).toMatchObject({
        priceTickSize: entry.priceTickSize,
        displayPriceDecimals: entry.displayPriceDecimals,
        source: 'fixed_universe',
      });
    }
    await service.refresh();
    for (const entry of additions) {
      expect(
        service.getPrecision({ market: 'BINANCE', symbol: entry.symbol }),
      ).toMatchObject({
        priceTickSize: '0.000000001',
        displayPriceDecimals: 9,
        source: 'exchange_info',
      });
    }
  });

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

  it('has fallback metadata for all 25 fixed symbols', () => {
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

  it('keeps refreshing every other symbol when exchangeInfo rejects one symbol', async () => {
    // Binance answers the whole batch with HTTP 400 (-1121) for one unknown symbol.
    const fetchExchangeInfo = jest.fn((symbols: string[]) =>
      symbols.includes('ASTERUSDT')
        ? Promise.reject(
            new ProviderHttpError(
              'binance',
              'PROVIDER_HTTP_ERROR',
              'binance HTTP 400 (PROVIDER_HTTP_ERROR).',
              undefined,
              400,
            ),
          )
        : Promise.resolve({
            response: exchangeInfo(
              symbols.map((symbol) => [symbol, '0.000000001']),
            ),
            receivedAt: new Date(),
          }),
    );
    const { service } = createService(fetchExchangeInfo);

    await expect(service.refresh()).resolves.toBe(true);

    for (const symbol of BINANCE_FIXED_SYMBOLS) {
      expect(service.getPrecision({ market: 'BINANCE', symbol })?.source).toBe(
        symbol === 'ASTERUSDT' ? 'fixed_universe' : 'exchange_info',
      );
    }
    expect(
      service.getPrecision({ market: 'BINANCE', symbol: 'ASTERUSDT' })
        ?.priceTickSize,
    ).toBe('0.00010000');
    expect(service.getStatus()).toMatchObject({
      lastRefreshOk: true,
      lastErrorCode: null,
      cachedSymbolCount: BINANCE_FIXED_SYMBOLS.length - 1,
    });
    // Halving isolates one symbol in at most 1 + 2 * ceil(log2(100)) calls.
    expect(fetchExchangeInfo.mock.calls.length).toBeLessThanOrEqual(15);

    fetchExchangeInfo.mockClear();
    await service.refresh();
    expect(fetchExchangeInfo).toHaveBeenCalledTimes(1);
    const requested = fetchExchangeInfo.mock.calls[0][0];
    expect(requested.length).toBe(BINANCE_FIXED_SYMBOLS.length - 1);
    expect(requested.includes('ASTERUSDT')).toBe(false);
  });

  it.each([
    ['a server error', 500],
    ['a timeout', undefined],
  ])('does not split the batch after %s', async (_label, httpStatus) => {
    const fetchExchangeInfo = jest
      .fn()
      .mockRejectedValue(
        new ProviderHttpError(
          'binance',
          httpStatus === undefined ? 'PROVIDER_TIMEOUT' : 'PROVIDER_HTTP_ERROR',
          'binance request failed.',
          undefined,
          httpStatus,
        ),
      );
    const { service } = createService(fetchExchangeInfo);

    await expect(service.refresh()).resolves.toBe(false);

    expect(fetchExchangeInfo).toHaveBeenCalledTimes(1);
    expect(service.getStatus()).toMatchObject({
      lastRefreshOk: false,
      cachedSymbolCount: 0,
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
