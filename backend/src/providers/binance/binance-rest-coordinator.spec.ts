import {
  binanceUsedWeight,
  parseBinanceRetryAfter,
} from './binance-rest-coordinator';
import { ProviderHttpClient } from '../provider-http.client';

describe('Binance safe HTTP restriction metadata', () => {
  const now = new Date('2026-10-09T00:00:00Z');
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['60', 429, 60_000],
    ['0', 429, 1000],
    [null, 429, 60_000],
    [null, 418, 120_000],
    ['-1', 418, 120_000],
    ['NaN', 429, 60_000],
    ['Infinity', 418, 120_000],
    ['1e9', 429, 60_000],
    ['0.5', 429, 60_000],
    ['', 418, 120_000],
    ['99999999999999999999999999999999999999', 418, 7 * 86_400_000],
    ['Fri, 09 Oct 2026 00:02:00 GMT', 418, 120_000],
    ['Thu, 08 Oct 2026 23:59:59 GMT', 429, 60_000],
    ['not a date https://secret.invalid', 418, 120_000],
    ['Fri, 31 Feb 2027 00:02:00 GMT', 418, 120_000],
  ])('interprets %s for HTTP %s safely', (value, status, expected) => {
    const headers = new Headers(value === null ? {} : { 'Retry-After': value });
    expect(parseBinanceRetryAfter(headers, status, now)).toBe(expected);
  });

  it('uses provider Date for an HTTP deadline even when the application clock differs', () => {
    const headers = new Headers({
      Date: 'Fri, 09 Oct 2026 00:00:00 GMT',
      'Retry-After': 'Fri, 09 Oct 2026 00:05:00 GMT',
    });
    expect(parseBinanceRetryAfter(headers, 418, new Date('2020-01-01'))).toBe(
      300_000,
    );
  });

  it.each(['-1', 'secret', '1.2', '999999999999999999999'])(
    'discards invalid numeric weight %s',
    (value) => {
      expect(
        binanceUsedWeight(new Headers({ 'X-MBX-USED-WEIGHT-1M': value })),
      ).toBeUndefined();
    },
  );

  it('fails closed before fetch on unavailable shared coordination, without leaking its error', async () => {
    const fetch = jest.spyOn(global, 'fetch');
    const client = new ProviderHttpClient({
      eval: () => Promise.reject(new Error('redis://private:secret@host')),
    } as never);
    await expect(
      client.getJson('https://secret.invalid?token=private', {
        provider: 'binance',
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      code: 'BINANCE_REST_COORDINATION_UNAVAILABLE',
      message:
        'binance REST coordination unavailable (BINANCE_REST_COORDINATION_UNAVAILABLE).',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
