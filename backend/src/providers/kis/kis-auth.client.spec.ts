import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ProviderConfigService } from '../provider-config.service';
import { redactJsonValue } from '../provider-secret-redaction';
import {
  KisAuthClient,
  parseKisApprovalKeyResponse,
  parseKisTokenResponse,
} from './kis-auth.client';

describe('KIS auth client skeleton', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('acquires an oauth slot immediately before each physical token request', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ access_token: 'token' })),
    } as Response);
    const coordinator = { acquire: jest.fn().mockResolvedValue(undefined) };
    const client = new KisAuthClient(
      configServiceFor({ restBaseUrl: 'https://kis.example.test' }),
      coordinator as never,
    );

    await client.requestRestToken({ path: '/oauth2/tokenP', body: {} });
    await client.requestRestToken({ path: '/oauth2/tokenP', body: {} });

    expect(coordinator.acquire).toHaveBeenCalledTimes(2);
    expect(coordinator.acquire).toHaveBeenNthCalledWith(1, 'oauth');
    expect(coordinator.acquire.mock.invocationCallOrder[0]).toBeLessThan(
      fetchSpy.mock.invocationCallOrder[0],
    );
  });

  it('parses token responses without persisting token to DB', () => {
    const parsed = parseKisTokenResponse({
      access_token: 'kis-access-token',
      token_type: 'Bearer',
      expires_in: '86400',
      access_token_token_expired: '2026-05-27T00:00:00.000Z',
    });

    expect(parsed).toEqual({
      accessToken: 'kis-access-token',
      tokenType: 'Bearer',
      expiresInSeconds: 86400,
      expiresAt: new Date('2026-05-27T00:00:00.000Z'),
      receivedAt: null,
    });
  });

  it('derives token expiry from expires_in and receivedAt', () => {
    const receivedAt = new Date('2026-05-27T00:00:00.000Z');

    expect(
      parseKisTokenResponse(
        {
          access_token: 'kis-access-token',
          token_type: 'Bearer',
          expires_in: '120',
        },
        receivedAt,
      ),
    ).toEqual({
      accessToken: 'kis-access-token',
      tokenType: 'Bearer',
      expiresInSeconds: 120,
      expiresAt: new Date('2026-05-27T00:02:00.000Z'),
      receivedAt,
    });
  });

  it('parses WebSocket approval_key responses', () => {
    expect(
      parseKisApprovalKeyResponse({
        approval_key: 'kis-approval-key',
      }),
    ).toEqual({
      approvalKey: 'kis-approval-key',
      expiresInSeconds: null,
      expiresAt: null,
      receivedAt: null,
    });
  });

  it('uses a conservative default TTL for approval_key responses without expiry fields', () => {
    const receivedAt = new Date('2026-05-27T00:00:00.000Z');

    expect(
      parseKisApprovalKeyResponse(
        {
          approval_key: 'kis-approval-key',
        },
        receivedAt,
      ),
    ).toEqual({
      approvalKey: 'kis-approval-key',
      expiresInSeconds: null,
      expiresAt: new Date('2026-05-27T01:00:00.000Z'),
      receivedAt,
    });
  });

  it('requests WebSocket approval_key with the documented body fields', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(JSON.stringify({ approval_key: 'approval-secret' })),
    } as Response);
    const client = new KisAuthClient(
      configServiceFor({
        restBaseUrl: 'https://kis.example.test',
        appKey: 'kis-app-key',
        appSecret: 'kis-app-secret',
      }),
    );

    const result = await client.requestConfiguredWebSocketApprovalKey();

    expect(result.state).toBe('available');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://kis.example.test/oauth2/Approval',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          grant_type: 'client_credentials',
          appkey: 'kis-app-key',
          secretkey: 'kis-app-secret',
        }),
      }),
    );
  });

  it('requests REST access token with the configured KIS app credentials', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            access_token: 'rest-token',
            token_type: 'Bearer',
            expires_in: '86400',
          }),
        ),
    } as Response);
    const client = new KisAuthClient(
      configServiceFor({
        restBaseUrl: 'https://kis.example.test',
        appKey: 'kis-app-key',
        appSecret: 'kis-app-secret',
      }),
    );

    const result = await client.requestConfiguredRestToken();

    expect(result.state).toBe('available');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://kis.example.test/oauth2/tokenP',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          grant_type: 'client_credentials',
          appkey: 'kis-app-key',
          appsecret: 'kis-app-secret',
        }),
      }),
    );
  });

  it('reuses a valid configured REST access token cache', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-27T00:00:00.000Z'));
    const fetchSpy = jest.spyOn(global, 'fetch');
    mockFetchJsonOnce(fetchSpy, {
      access_token: 'rest-token',
      token_type: 'Bearer',
      expires_in: '3600',
    });
    const client = new KisAuthClient(
      configServiceFor({
        restBaseUrl: 'https://kis.example.test',
      }),
    );

    const first = await client.requestConfiguredRestToken();
    const second = await client.requestConfiguredRestToken();

    expect(first.state).toBe('available');
    expect(second).toEqual(first);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('refreshes a configured REST access token inside the refresh buffer', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-27T00:00:00.000Z'));
    const fetchSpy = jest.spyOn(global, 'fetch');
    mockFetchJsonOnce(fetchSpy, {
      access_token: 'rest-token-1',
      token_type: 'Bearer',
      expires_in: '120',
    });
    mockFetchJsonOnce(fetchSpy, {
      access_token: 'rest-token-2',
      token_type: 'Bearer',
      expires_in: '3600',
    });
    const client = new KisAuthClient(
      configServiceFor({
        restBaseUrl: 'https://kis.example.test',
      }),
    );

    await client.requestConfiguredRestToken();
    jest.setSystemTime(new Date('2026-05-27T00:01:01.000Z'));
    const refreshed = await client.requestConfiguredRestToken();

    expect(refreshed.state).toBe('available');
    if (refreshed.state === 'available') {
      expect(refreshed.response.accessToken).toBe('rest-token-2');
    }
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('shares one configured REST token refresh across concurrent callers', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-27T00:00:00.000Z'));
    const fetchSpy = jest.spyOn(global, 'fetch');
    mockFetchJsonOnce(fetchSpy, {
      access_token: 'rest-token',
      token_type: 'Bearer',
      expires_in: '3600',
    });
    const client = new KisAuthClient(
      configServiceFor({
        restBaseUrl: 'https://kis.example.test',
      }),
    );

    const [first, second] = await Promise.all([
      client.requestConfiguredRestToken(),
      client.requestConfiguredRestToken(),
    ]);

    expect(first).toEqual(second);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to an unexpired REST access token when tokenP is rate limited', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-27T00:00:00.000Z'));
    const fetchSpy = jest.spyOn(global, 'fetch');
    mockFetchJsonOnce(fetchSpy, {
      access_token: 'rest-token-1',
      token_type: 'Bearer',
      expires_in: '70',
    });
    mockFetchKisRateLimitOnce(fetchSpy);
    const client = new KisAuthClient(
      configServiceFor({
        restBaseUrl: 'https://kis.example.test',
      }),
    );

    await client.requestConfiguredRestToken();
    jest.setSystemTime(new Date('2026-05-27T00:00:20.000Z'));
    const fallback = await client.requestConfiguredRestToken();

    expect(fallback.state).toBe('available');
    if (fallback.state === 'available') {
      expect(fallback.response.accessToken).toBe('rest-token-1');
    }
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('keeps the REST tokenP rate limit failure when no usable cache exists', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-27T00:00:00.000Z'));
    const fetchSpy = jest.spyOn(global, 'fetch');
    mockFetchKisRateLimitOnce(fetchSpy);
    const client = new KisAuthClient(
      configServiceFor({
        restBaseUrl: 'https://kis.example.test',
      }),
    );

    await expect(client.requestConfiguredRestToken()).rejects.toMatchObject({
      code: 'PROVIDER_HTTP_ERROR',
      message: expect.stringContaining('EGW00133'),
    });
  });

  it('reuses a valid configured WebSocket approval key cache', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-27T00:00:00.000Z'));
    const fetchSpy = jest.spyOn(global, 'fetch');
    mockFetchJsonOnce(fetchSpy, {
      approval_key: 'approval-secret',
    });
    const client = new KisAuthClient(
      configServiceFor({
        restBaseUrl: 'https://kis.example.test',
      }),
    );

    const first = await client.requestConfiguredWebSocketApprovalKey();
    const second = await client.requestConfiguredWebSocketApprovalKey();

    expect(first.state).toBe('available');
    expect(second).toEqual(first);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('refreshes a configured WebSocket approval key inside the default TTL buffer', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-27T00:00:00.000Z'));
    const fetchSpy = jest.spyOn(global, 'fetch');
    mockFetchJsonOnce(fetchSpy, {
      approval_key: 'approval-secret-1',
    });
    mockFetchJsonOnce(fetchSpy, {
      approval_key: 'approval-secret-2',
    });
    const client = new KisAuthClient(
      configServiceFor({
        restBaseUrl: 'https://kis.example.test',
      }),
    );

    await client.requestConfiguredWebSocketApprovalKey();
    jest.setSystemTime(new Date('2026-05-27T00:59:01.000Z'));
    const refreshed = await client.requestConfiguredWebSocketApprovalKey();

    expect(refreshed.state).toBe('available');
    if (refreshed.state === 'available') {
      expect(refreshed.response.approvalKey).toBe('approval-secret-2');
    }
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('shares one configured WebSocket approval key refresh across concurrent callers', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-27T00:00:00.000Z'));
    const fetchSpy = jest.spyOn(global, 'fetch');
    mockFetchJsonOnce(fetchSpy, {
      approval_key: 'approval-secret',
    });
    const client = new KisAuthClient(
      configServiceFor({
        restBaseUrl: 'https://kis.example.test',
      }),
    );

    const [first, second] = await Promise.all([
      client.requestConfiguredWebSocketApprovalKey(),
      client.requestConfiguredWebSocketApprovalKey(),
    ]);

    expect(first).toEqual(second);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to an unexpired approval key when approval refresh is rate limited', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-27T00:00:00.000Z'));
    const fetchSpy = jest.spyOn(global, 'fetch');
    mockFetchJsonOnce(fetchSpy, {
      approval_key: 'approval-secret-1',
    });
    mockFetchKisRateLimitOnce(fetchSpy);
    const client = new KisAuthClient(
      configServiceFor({
        restBaseUrl: 'https://kis.example.test',
      }),
    );

    await client.requestConfiguredWebSocketApprovalKey();
    jest.setSystemTime(new Date('2026-05-27T00:59:30.000Z'));
    const fallback = await client.requestConfiguredWebSocketApprovalKey();

    expect(fallback.state).toBe('available');
    if (fallback.state === 'available') {
      expect(fallback.response.approvalKey).toBe('approval-secret-1');
    }
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('keeps the approval key rate limit failure when no usable cache exists', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-27T00:00:00.000Z'));
    const fetchSpy = jest.spyOn(global, 'fetch');
    mockFetchKisRateLimitOnce(fetchSpy);
    const client = new KisAuthClient(
      configServiceFor({
        restBaseUrl: 'https://kis.example.test',
      }),
    );

    await expect(
      client.requestConfiguredWebSocketApprovalKey(),
    ).rejects.toMatchObject({
      code: 'PROVIDER_HTTP_ERROR',
      message: expect.stringContaining('EGW00133'),
    });
  });

  it('redacts KIS app key, app secret, token, and approval_key fields', () => {
    const redacted = redactJsonValue(
      {
        appkey: 'kis-app-key',
        appsecret: 'kis-app-secret',
        access_token: 'kis-token',
        approval_key: 'kis-approval',
      },
      {
        secrets: ['kis-app-key', 'kis-app-secret', 'kis-token', 'kis-approval'],
      },
    );

    expect(JSON.stringify(redacted)).not.toContain('kis-app-key');
    expect(JSON.stringify(redacted)).not.toContain('kis-app-secret');
    expect(JSON.stringify(redacted)).not.toContain('kis-token');
    expect(JSON.stringify(redacted)).not.toContain('kis-approval');
  });

  it('skips KIS live REST calls when base URL is empty', async () => {
    const client = new KisAuthClient({
      getConfig: () => ({
        common: {
          providerIngestionEnabled: true,
          httpTimeoutMs: 5000,
          rawPayloadMaxBytes: 12000,
        },
        exchangeRateApi: {
          enabled: false,
          baseUrl: 'https://example.test',
        },
        binance: {
          enabled: false,
          restBaseUrl: 'https://example.test',
          wsMarketDataBaseUrl: 'wss://example.test',
          symbols: [],
          usdtAsUsdEquivalent: true,
        },
        kis: {
          enabled: true,
          appKey: 'kis-app-key',
          appSecret: 'kis-app-secret',
          restBaseUrl: undefined,
          wsBaseUrl: undefined,
          maxWatchlistSize: 41,
          domesticSymbols: [],
          usSymbols: [],
          allSymbols: [],
          canCallRestLive: false,
          canCallWebSocketLive: false,
        },
      }),
    } as unknown as ProviderConfigService);

    await expect(
      client.requestRestToken({
        path: '/explicit-token-path',
        body: {},
      }),
    ).resolves.toEqual({
      state: 'skipped',
      reason: 'KIS_REST_BASE_URL_MISSING',
    });
  });

  it('does not add KIS real trading surface names in provider skeleton files', () => {
    const dir = join(__dirname);
    const text = readdirSync(dir)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
      .map((file) => readFileSync(join(dir, file), 'utf8'))
      .join('\n');

    expect(text).not.toMatch(
      /placeOrder|cancelOrder|accountNumber|balanceEndpoint|orderEndpoint|tradingAccount/u,
    );
  });
});

function configServiceFor(input: {
  restBaseUrl?: string;
  wsBaseUrl?: string;
  appKey?: string;
  appSecret?: string;
}): ProviderConfigService {
  return {
    getConfig: () => ({
      common: {
        providerIngestionEnabled: true,
        httpTimeoutMs: 5000,
        rawPayloadMaxBytes: 12000,
      },
      exchangeRateApi: {
        enabled: false,
        baseUrl: 'https://example.test',
      },
      binance: {
        enabled: false,
        restBaseUrl: 'https://example.test',
        wsMarketDataBaseUrl: 'wss://example.test',
        symbols: [],
        usdtAsUsdEquivalent: true,
      },
      kis: {
        enabled: true,
        appKey: input.appKey ?? 'kis-app-key',
        appSecret: input.appSecret ?? 'kis-app-secret',
        restBaseUrl: input.restBaseUrl,
        wsBaseUrl: input.wsBaseUrl,
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
        canCallRestLive: Boolean(input.restBaseUrl),
        canCallWebSocketLive: Boolean(input.wsBaseUrl),
      },
    }),
  } as unknown as ProviderConfigService;
}

function mockFetchJsonOnce(
  fetchSpy: jest.SpyInstance,
  body: Record<string, unknown>,
): void {
  fetchSpy.mockResolvedValueOnce({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

function mockFetchKisRateLimitOnce(fetchSpy: jest.SpyInstance): void {
  fetchSpy.mockResolvedValueOnce({
    ok: false,
    status: 403,
    text: () =>
      Promise.resolve(
        JSON.stringify({
          error_code: 'EGW00133',
          error_description: 'Token issuance rate limit exceeded.',
        }),
      ),
  } as Response);
}
