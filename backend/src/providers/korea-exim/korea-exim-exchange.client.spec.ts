import { ProviderConfigService } from '../provider-config.service';
import { ProviderHttpClient } from '../provider-http.client';
import { KoreaEximExchangeClient } from './korea-exim-exchange.client';

describe('KoreaEximExchangeClient', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('builds the exchangeJSON path and query parameters', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify([
          {
            RESULT: 1,
            CUR_UNIT: 'USD',
            DEAL_BAS_R: '1,389.50',
          },
        ]),
    } as Response);
    const client = createClient();

    await client.fetchDailyExchangeRates({ searchDate: '20260619' });

    const url = new URL(fetchSpy.mock.calls[0][0] as string);
    expect(url.origin).toBe('https://example.test');
    expect(url.pathname).toBe('/site/program/financial/exchangeJSON');
    expect(url.searchParams.get('authkey')).toBe('test-auth-key');
    expect(url.searchParams.get('searchdate')).toBe('20260619');
    expect(url.searchParams.get('data')).toBe('AP01');
  });

  it('does not expose authkey values in HTTP error messages', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'invalid test-auth-key',
    } as Response);
    const client = createClient();

    await expect(
      client.fetchDailyExchangeRates({ searchDate: '20260619' }),
    ).rejects.toMatchObject({
      code: 'KOREA_EXIM_HTTP_ERROR',
      message: expect.not.stringContaining('test-auth-key'),
    });
  });

  it('maps invalid JSON to a Korea EXIM parse error without exposing authkey', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => 'invalid test-auth-key',
    } as Response);
    const client = createClient();

    await expect(
      client.fetchDailyExchangeRates({ searchDate: '20260619' }),
    ).rejects.toMatchObject({
      code: 'KOREA_EXIM_JSON_PARSE_ERROR',
      message: expect.not.stringContaining('test-auth-key'),
    });
  });
});

function createClient() {
  return new KoreaEximExchangeClient(
    createConfigService(),
    new ProviderHttpClient(),
  );
}

function createConfigService(): ProviderConfigService {
  return {
    getConfig: () => ({
      common: {
        providerIngestionEnabled: true,
        httpTimeoutMs: 5000,
        rawPayloadMaxBytes: 12000,
      },
      exchangeRateApi: {
        enabled: false,
        baseUrl: 'https://example.test/v6',
      },
      koreaEximExchange: {
        enabled: true,
        authKey: 'test-auth-key',
        baseUrl: 'https://example.test',
        data: 'AP01',
        lookbackDays: 7,
      },
      binance: {
        enabled: false,
        restBaseUrl: 'https://example.test',
        wsMarketDataBaseUrl: 'wss://example.test',
        symbols: [],
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
}
