import { ProviderConfigService } from '../provider-config.service';
import { KisQuoteClient } from './kis-quote.client';
import { Test } from '@nestjs/testing';

describe('KisQuoteClient rate-limit integration', () => {
  afterEach(() => jest.restoreAllMocks());

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
});
