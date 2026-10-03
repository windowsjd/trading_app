import { ProviderConfigService } from '../provider-config.service';
import { KisQuoteClient } from './kis-quote.client';
import { Test } from '@nestjs/testing';

describe('KisQuoteClient rate-limit integration', () => {
  afterEach(() => jest.restoreAllMocks());

  it('discards raw quote error bodies and retains provider/status/category', async () => {
    const text = jest
      .fn()
      .mockResolvedValue(
        'unlabeled-synthetic-quote-body appSecret=fake-quote-secret',
      );
    const cancel = jest.fn().mockResolvedValue(undefined);
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 502,
      text,
      body: { cancel },
    } as unknown as Response);
    const configService = {
      getConfig: () => ({
        common: { httpTimeoutMs: 5000 },
        kis: {
          enabled: true,
          appKey: 'fake-key',
          appSecret: 'fake-secret',
          restBaseUrl: 'https://kis.example.test',
        },
      }),
    };
    const client = new KisQuoteClient(
      configService as never,
      { acquire: jest.fn().mockResolvedValue(undefined) } as never,
    );
    const error = await client
      .getMarketDataByExplicitPath({
        path: '/quote',
        query: { authorization: 'fake-query-secret' },
      })
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      provider: 'kis',
      code: 'PROVIDER_HTTP_ERROR',
      message: 'KIS HTTP 502 (PROVIDER_HTTP_ERROR).',
    });
    expect((error as Error).stack).not.toMatch(
      /unlabeled-synthetic|fake-quote-secret|fake-query-secret/,
    );
    expect(text).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('acquires a rest slot immediately before each physical quote request', async () => {
    const config = {
      common: { httpTimeoutMs: 5000 },
      kis: {
        enabled: true,
        appKey: 'app-key',
        appSecret: 'app-secret',
        restBaseUrl: 'https://kis.example.test',
      },
    };
    const configService = { getConfig: () => config };
    const coordinator = { acquire: jest.fn().mockResolvedValue(undefined) };
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{}'),
    } as Response);
    const client = new KisQuoteClient(
      configService as unknown as ProviderConfigService,
      coordinator as never,
    );

    await client.getMarketDataByExplicitPath({ path: '/quote' });
    await client.getMarketDataByExplicitPath({ path: '/quote' });

    expect(coordinator.acquire).toHaveBeenCalledTimes(2);
    expect(coordinator.acquire).toHaveBeenNthCalledWith(1, 'rest');
    expect(coordinator.acquire.mock.invocationCallOrder[0]).toBeLessThan(
      fetchSpy.mock.invocationCallOrder[0],
    );
  });

  it('does not execute HTTP when acquiring the slot fails', async () => {
    const configService = {
      getConfig: () => ({
        common: { httpTimeoutMs: 5000 },
        kis: {
          enabled: true,
          appKey: 'app-key',
          appSecret: 'app-secret',
          restBaseUrl: 'https://kis.example.test',
        },
      }),
    };
    const coordinator = {
      acquire: jest.fn().mockRejectedValue(new Error('timeout')),
    };
    const fetchSpy = jest.spyOn(global, 'fetch');
    const client = new KisQuoteClient(
      configService as unknown as ProviderConfigService,
      coordinator as never,
    );

    await expect(
      client.getMarketDataByExplicitPath({ path: '/quote' }),
    ).rejects.toThrow('timeout');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('cannot be constructed by Nest without the mandatory coordinator', async () => {
    await expect(
      Test.createTestingModule({
        providers: [
          KisQuoteClient,
          {
            provide: ProviderConfigService,
            useValue: { getConfig: jest.fn() },
          },
        ],
      }).compile(),
    ).rejects.toThrow(/KisRequestCoordinatorService/u);
  });

  it('exposes lower-case response headers and tr_cont through the additive metadata method', async () => {
    const configService = {
      getConfig: () => ({
        common: { httpTimeoutMs: 5000 },
        kis: {
          enabled: true,
          appKey: 'key',
          appSecret: 'secret',
          restBaseUrl: 'https://kis.test',
        },
      }),
    };
    const coordinator = { acquire: jest.fn().mockResolvedValue(undefined) };
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ tr_cont: 'M', 'x-test': 'yes' }),
      text: () => Promise.resolve('{"output2":[]}'),
    } as Response);
    const client = new KisQuoteClient(
      configService as never,
      coordinator as never,
    );
    const result = await client.getMarketDataWithMetadataByExplicitPath({
      path: '/minutes',
    });
    expect(result).toMatchObject({
      state: 'available',
      trCont: 'M',
      headers: { tr_cont: 'M', 'x-test': 'yes' },
    });
  });

  it('passes an adapter cancellation signal into the rate-limit queue and fetch', async () => {
    const configService = {
      getConfig: () => ({
        common: { httpTimeoutMs: 5000 },
        kis: {
          enabled: true,
          appKey: 'key',
          appSecret: 'secret',
          restBaseUrl: 'https://kis.test',
        },
      }),
    };
    const coordinator = { acquire: jest.fn().mockResolvedValue(undefined) };
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () => Promise.resolve('{}'),
    } as Response);
    const signal = new AbortController().signal;
    const client = new KisQuoteClient(
      configService as never,
      coordinator as never,
    );
    await client.getMarketDataWithMetadataByExplicitPath({
      path: '/minutes',
      signal,
    });
    expect(coordinator.acquire).toHaveBeenCalledWith('rest', { signal });
    expect((fetchSpy.mock.calls[0][1] as RequestInit).signal).toBeInstanceOf(
      AbortSignal,
    );
  });
});
