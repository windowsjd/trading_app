import { KisDomesticPeriodAdapter } from './kis-domestic-period.adapter';
import { KisCandleInputError } from './kis-candle.types';

const row = (date: string, overrides: Record<string, string> = {}) => ({
  stck_bsop_date: date,
  stck_clpr: '101',
  stck_oprc: '100',
  stck_hgpr: '102',
  stck_lwpr: '99',
  acml_vol: '1000',
  acml_tr_pbmn: '101000',
  ...overrides,
});

const blankRow = () => ({
  stck_bsop_date: '',
  stck_clpr: '',
  stck_oprc: '',
  stck_hgpr: '',
  stck_lwpr: '',
  acml_vol: '',
  acml_tr_pbmn: '',
});

describe('KisDomesticPeriodAdapter', () => {
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
    new KisDomesticPeriodAdapter(
      auth as never,
      quote as never,
      config as never,
    );

  it('requests FHKST03010100 daily pages with adjusted prices and reports date extremes', async () => {
    const quote = {
      getMarketDataWithMetadataByExplicitPath: jest.fn().mockResolvedValue({
        state: 'available',
        response: {
          output2: [row('20260710'), row('20260709'), row('20260708')],
        },
        receivedAt: new Date('2026-07-10T07:00:00Z'),
        trCont: 'D',
      }),
    };
    const result = await createAdapter(quote).fetchPeriodPage({
      asset: { id: 'a', symbol: '005930', marketCode: 'J' },
      interval: '1d',
      fromDate: '20250710',
      endDate: '20260710',
    });

    expect(result.state).toBe('ok');
    expect(result.rows).toHaveLength(3);
    expect(result.providerReturnedRows).toBe(3);
    expect(result.oldestDate).toBe('20260708');
    expect(result.latestDate).toBe('20260710');
    expect(result.trCont).toBe('D');
    const call = quote.getMarketDataWithMetadataByExplicitPath.mock.calls[0][0];
    expect(call.path).toBe(
      '/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice',
    );
    expect(call.query).toMatchObject({
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: '005930',
      FID_INPUT_DATE_1: '20250710',
      FID_INPUT_DATE_2: '20260710',
      FID_PERIOD_DIV_CODE: 'D',
      FID_ORG_ADJ_PRC: '0',
    });
    expect(call.headers).toMatchObject({ tr_id: 'FHKST03010100' });
  });

  it('uses FID_PERIOD_DIV_CODE=W for the weekly interval', async () => {
    const quote = {
      getMarketDataWithMetadataByExplicitPath: jest.fn().mockResolvedValue({
        state: 'available',
        response: { output2: [row('20260706')] },
        receivedAt: new Date(),
        trCont: null,
      }),
    };
    await createAdapter(quote).fetchPeriodPage({
      asset: { id: 'a', symbol: '005930', marketCode: 'J' },
      interval: '1w',
      fromDate: '20250710',
      endDate: '20260710',
    });
    expect(
      quote.getMarketDataWithMetadataByExplicitPath.mock.calls[0][0].query,
    ).toMatchObject({ FID_PERIOD_DIV_CODE: 'W' });
  });

  it('separates blank padding rows from data rows without treating them as data', async () => {
    const quote = {
      getMarketDataWithMetadataByExplicitPath: jest.fn().mockResolvedValue({
        state: 'available',
        response: {
          output2: [row('20260710'), blankRow(), blankRow()],
        },
        receivedAt: new Date(),
      }),
    };
    const result = await createAdapter(quote).fetchPeriodPage({
      asset: { id: 'a', symbol: '005930', marketCode: 'J' },
      interval: '1d',
      fromDate: '20260701',
      endDate: '20260710',
    });
    expect(result.rows).toHaveLength(1);
    expect(result.blankRows).toBe(2);
    expect(result.providerReturnedRows).toBe(3);
  });

  it('keeps rows with invalid dates for strict rejection downstream', async () => {
    const quote = {
      getMarketDataWithMetadataByExplicitPath: jest.fn().mockResolvedValue({
        state: 'available',
        response: {
          output2: [row('20260710'), row('not-a-date', { stck_clpr: '5' })],
        },
        receivedAt: new Date(),
      }),
    };
    const result = await createAdapter(quote).fetchPeriodPage({
      asset: { id: 'a', symbol: '005930', marketCode: 'J' },
      interval: '1d',
      fromDate: '20260701',
      endDate: '20260710',
    });
    expect(result.rows).toHaveLength(2);
    expect(result.oldestDate).toBe('20260710');
  });

  it.each([
    [{ unexpected: true }, 'malformed_response'],
    ['not-an-object', 'malformed_response'],
  ])(
    'reports malformed responses without fabricating rows',
    async (response, state) => {
      const quote = {
        getMarketDataWithMetadataByExplicitPath: jest.fn().mockResolvedValue({
          state: 'available',
          response,
          receivedAt: new Date(),
        }),
      };
      const result = await createAdapter(quote).fetchPeriodPage({
        asset: { id: 'a', symbol: '005930', marketCode: 'J' },
        interval: '1d',
        fromDate: '20260701',
        endDate: '20260710',
      });
      expect(result.state).toBe(state);
      expect(result.rows).toHaveLength(0);
    },
  );

  it('honors pre-aborted signals without calling KIS', async () => {
    const quote = { getMarketDataWithMetadataByExplicitPath: jest.fn() };
    const controller = new AbortController();
    controller.abort();
    const result = await createAdapter(quote).fetchPeriodPage({
      asset: { id: 'a', symbol: '005930', marketCode: 'J' },
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

  it.each([
    [{ interval: '1m' }, 'interval'],
    [{ fromDate: '2026-07-01' }, 'fromDate'],
    [{ endDate: '202607' }, 'endDate'],
    [{ fromDate: '20260711', endDate: '20260710' }, 'fromDate'],
  ])('rejects invalid page input %#', async (overrides) => {
    const quote = { getMarketDataWithMetadataByExplicitPath: jest.fn() };
    await expect(
      createAdapter(quote).fetchPeriodPage({
        asset: { id: 'a', symbol: '005930', marketCode: 'J' },
        interval: '1d',
        fromDate: '20260701',
        endDate: '20260710',
        ...(overrides as object),
      } as never),
    ).rejects.toBeInstanceOf(KisCandleInputError);
  });
});
