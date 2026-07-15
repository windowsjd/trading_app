import { KisOverseasPeriodAdapter } from './kis-overseas-period.adapter';

const row = (date: string, overrides: Record<string, string> = {}) => ({
  xymd: date,
  clos: '101',
  open: '100',
  high: '102',
  low: '99',
  tvol: '1000',
  tamt: '101000',
  sign: '2',
  diff: '1',
  rate: '1.0',
  ...overrides,
});

describe('KisOverseasPeriodAdapter', () => {
  const auth = {
    requestConfiguredRestToken: jest.fn().mockResolvedValue({
      state: 'available',
      response: { accessToken: 'token' },
      receivedAt: new Date(),
    }),
  };
  const config = { getKisConfig: () => ({ wsCustType: 'P' }) };

  beforeEach(() => jest.clearAllMocks());

  const createAdapter = (quote: unknown) =>
    new KisOverseasPeriodAdapter(
      auth as never,
      quote as never,
      config as never,
    );

  it.each([
    ['1d', '0'],
    ['1w', '1'],
  ] as const)(
    'requests HHDFS76240000 %s pages with GUBN=%s, adjusted prices, and a BYMD cursor',
    async (interval, gubn) => {
      const quote = {
        getMarketDataWithMetadataByExplicitPath: jest.fn().mockResolvedValue({
          state: 'available',
          response: { output2: [row('20260709'), row('20260708')] },
          receivedAt: new Date('2026-07-10T00:00:00Z'),
          trCont: 'M',
        }),
      };
      const result = await createAdapter(quote).fetchPeriodPage({
        asset: { id: 'a', symbol: 'AAPL', marketCode: 'NAS' },
        interval,
        fromDate: '20250710',
        endDate: '20260709',
      });

      expect(result.state).toBe('ok');
      expect(result.rows).toHaveLength(2);
      expect(result.oldestDate).toBe('20260708');
      expect(result.latestDate).toBe('20260709');
      // The response continuation header is preserved as metadata.
      expect(result.trCont).toBe('M');
      const overseasCalls = quote.getMarketDataWithMetadataByExplicitPath.mock
        .calls as unknown[][];
      const call = overseasCalls[0][0] as {
        path: string;
        query: unknown;
        headers: unknown;
      };
      expect(call.path).toBe('/uapi/overseas-price/v1/quotations/dailyprice');
      expect(call.query).toMatchObject({
        AUTH: '',
        EXCD: 'NAS',
        SYMB: 'AAPL',
        GUBN: gubn,
        BYMD: '20260709',
        MODP: '1',
        KEYB: '',
      });
      expect(call.headers).toMatchObject({ tr_id: 'HHDFS76240000' });
    },
  );

  it('reports empty pages without fabricating rows', async () => {
    const quote = {
      getMarketDataWithMetadataByExplicitPath: jest.fn().mockResolvedValue({
        state: 'available',
        response: { output2: [] },
        receivedAt: new Date(),
        trCont: null,
      }),
    };
    const result = await createAdapter(quote).fetchPeriodPage({
      asset: { id: 'a', symbol: 'AAPL', marketCode: 'NAS' },
      interval: '1d',
      fromDate: '20260701',
      endDate: '20260710',
    });
    expect(result.state).toBe('ok');
    expect(result.rows).toHaveLength(0);
    expect(result.providerReturnedRows).toBe(0);
    expect(result.oldestDate).toBeNull();
  });

  it('reports malformed responses instead of forcing success', async () => {
    const quote = {
      getMarketDataWithMetadataByExplicitPath: jest.fn().mockResolvedValue({
        state: 'available',
        response: { output2: 'oops' },
        receivedAt: new Date(),
      }),
    };
    const result = await createAdapter(quote).fetchPeriodPage({
      asset: { id: 'a', symbol: 'AAPL', marketCode: 'NAS' },
      interval: '1d',
      fromDate: '20260701',
      endDate: '20260710',
    });
    expect(result.state).toBe('malformed_response');
  });

  it('honors pre-aborted signals without calling KIS', async () => {
    const quote = { getMarketDataWithMetadataByExplicitPath: jest.fn() };
    const controller = new AbortController();
    controller.abort();
    const result = await createAdapter(quote).fetchPeriodPage({
      asset: { id: 'a', symbol: 'AAPL', marketCode: 'NAS' },
      interval: '1d',
      fromDate: '20260701',
      endDate: '20260710',
      signal: controller.signal,
    });
    expect(result.state).toBe('canceled');
    expect(
      quote.getMarketDataWithMetadataByExplicitPath,
    ).not.toHaveBeenCalled();
  });
});
