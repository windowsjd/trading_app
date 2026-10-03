import { ProviderHttpClient } from './provider-http.client';
import {
  adminDiagnosticRequestMiddleware,
  buildAdminDiagnostic,
} from '../common/admin-diagnostics';

describe('ProviderHttpClient safe failures', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    'exchange_rate_api',
    'korea_exim_exchange_rate',
    'binance',
    'kis',
  ] as const)(
    'retains provider/status/category while discarding %s non-2xx body and URL',
    async (provider) => {
      const text = jest
        .fn()
        .mockResolvedValue(
          'unlabeled-synthetic-provider-body {"apiKey":"fake-secret"}',
        );
      const cancel = jest.fn().mockResolvedValue(undefined);
      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 503,
        text,
        body: { cancel },
      } as unknown as Response);
      const error = await new ProviderHttpClient()
        .getJson(
          'https://fake-secret.example.test/private?authkey=fake-secret',
          { provider, timeoutMs: 1000 },
        )
        .catch((failure: unknown) => failure);
      expect(error).toMatchObject({
        provider,
        code: 'PROVIDER_HTTP_ERROR',
        message: `${provider} HTTP 503 (PROVIDER_HTTP_ERROR).`,
      });
      expect(text).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledTimes(1);
      let diagnostic;
      adminDiagnosticRequestMiddleware(
        {
          method: 'GET',
          originalUrl: '/api/v1/fx/rates/current',
          headers: {},
          user: { userId: 'admin', role: 'admin' },
        } as never,
        { setHeader: jest.fn() } as never,
        () => {
          diagnostic = buildAdminDiagnostic(error, 'FX_RATE_UNAVAILABLE', 503);
        },
      );
      expect(JSON.stringify(diagnostic)).toContain('HTTP 503');
      expect(JSON.stringify(diagnostic)).not.toMatch(
        /unlabeled-synthetic-provider-body|fake-secret|authkey/,
      );
    },
  );

  it('keeps HTTP status/category when stream cleanup itself fails', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({
        ok: false,
        status: 500,
        body: {
          cancel: () =>
            Promise.reject(new Error('synthetic-cleanup-private-message')),
        },
      } as unknown as Response);
    await expect(
      new ProviderHttpClient().getJson('https://example.test', {
        provider: 'binance',
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_HTTP_ERROR',
      message: 'binance HTTP 500 (PROVIDER_HTTP_ERROR).',
    });
  });

  it.each([
    ['parse', 'PROVIDER_JSON_PARSE_ERROR'],
    ['request', 'PROVIDER_REQUEST_FAILED'],
    ['timeout', 'PROVIDER_TIMEOUT'],
  ])(
    'preserves safe %s classification without URL/body/native error message',
    async (kind, code) => {
      const spy = jest.spyOn(global, 'fetch');
      if (kind === 'parse')
        spy.mockResolvedValue({
          ok: true,
          status: 200,
          text: async () => 'unlabeled-synthetic-body',
        } as Response);
      else
        spy.mockRejectedValue(
          Object.assign(new Error('unlabeled-synthetic-native-error'), {
            name: kind === 'timeout' ? 'AbortError' : 'Error',
          }),
        );
      const error = await new ProviderHttpClient()
        .getJson('https://fake-private-path.example.test', {
          provider: 'binance',
          timeoutMs: 1000,
        })
        .catch((failure: unknown) => failure);
      expect(error).toMatchObject({ provider: 'binance', code });
      expect((error as Error).message).not.toMatch(
        /synthetic|fake-private-path/,
      );
    },
  );

  it('still parses successful business responses', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{"price":"123.45"}',
    } as Response);
    await expect(
      new ProviderHttpClient().getJson('https://example.test', {
        provider: 'binance',
        timeoutMs: 1000,
      }),
    ).resolves.toMatchObject({ json: { price: '123.45' }, status: 200 });
  });
});
