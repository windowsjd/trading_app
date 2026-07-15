import { ProviderConfigService } from '../provider-config.service';
import { ProviderHttpClient } from '../provider-http.client';
import { BinancePublicClient } from './binance-public.client';

describe('BinancePublicClient', () => {
  it('fetches Spot klines from /api/v3/klines with public query params', async () => {
    const configService = {
      getConfig: () => ({
        common: {
          providerIngestionEnabled: false,
          httpTimeoutMs: 5000,
          rawPayloadMaxBytes: 12000,
        },
        exchangeRateApi: {
          enabled: false,
          baseUrl: 'https://example.test',
        },
        koreaEximExchange: {
          enabled: false,
          baseUrl: 'https://example.test',
          data: 'AP01',
          lookbackDays: 7,
        },
        binance: {
          enabled: true,
          restBaseUrl: 'https://api.binance.com',
          wsMarketDataBaseUrl: 'wss://data-stream.binance.vision',
          symbols: ['BTCUSDT', 'ETHUSDT'],
          usdtAsUsdEquivalent: true,
        },
        kis: {
          enabled: false,
          wsCustType: 'P',
          wsDomesticTrId: 'H0STCNT0',
          wsOverseasDelayedTrId: 'HDFSCNT0',
          wsSnapshotThrottleMs: 5000,
          wsMaxRuntimeMs: 30000,
          wsAllowUsDelayed: true,
          maxWatchlistSize: 41,
          domesticSymbols: [],
          usSymbols: [],
          allSymbols: [],
          canCallRestLive: false,
          canCallWebSocketLive: false,
        },
      }),
    } as unknown as ProviderConfigService;
    const getJson = jest.fn().mockResolvedValue({
      json: [],
      receivedAt: new Date('2026-06-21T04:00:00.000Z'),
      status: 200,
    });
    const httpClient = { getJson } as unknown as ProviderHttpClient;
    const client = new BinancePublicClient(configService, httpClient);

    await client.fetchKlines({
      symbol: 'btcusdt',
      interval: '5m',
      limit: 100,
      startTime: Date.parse('2026-06-21T00:00:00.000Z'),
      endTime: Date.parse('2026-06-21T04:30:00.000Z'),
    });

    expect(getJson).toHaveBeenCalledTimes(1);
    const [[url, options]] = (
      getJson as jest.MockedFunction<ProviderHttpClient['getJson']>
    ).mock.calls;
    const parsedUrl = new URL(url);

    expect(parsedUrl.pathname).toBe('/api/v3/klines');
    expect(parsedUrl.searchParams.get('symbol')).toBe('BTCUSDT');
    expect(parsedUrl.searchParams.get('interval')).toBe('5m');
    expect(parsedUrl.searchParams.get('limit')).toBe('100');
    expect(parsedUrl.searchParams.get('startTime')).toBe(
      String(Date.parse('2026-06-21T00:00:00.000Z')),
    );
    expect(parsedUrl.searchParams.get('endTime')).toBe(
      String(Date.parse('2026-06-21T04:30:00.000Z')),
    );
    expect(parsedUrl.searchParams.has('timeZone')).toBe(false);
    expect(options).toMatchObject({
      provider: 'binance',
      timeoutMs: 5000,
    });
  });
});
