import { KisUsMinuteAdapter } from './kis-us-minute.adapter';

const row = (time: string) => ({
  xymd: '20260710',
  xhms: time,
  open: '100',
  high: '102',
  low: '99',
  last: '101',
  evol: '10',
  eamt: '1000',
});

describe('KisUsMinuteAdapter', () => {
  const auth = {
    requestConfiguredRestToken: jest.fn().mockResolvedValue({
      state: 'available',
      response: { accessToken: 'token' },
      receivedAt: new Date(),
    }),
  };
  const config = { getKisConfig: () => ({ wsCustType: 'P' }) };

  beforeEach(() => jest.clearAllMocks());

  it('uses NMIN=5 and advances NEXT/KEYB/tr_cont from the last candle', async () => {
    const quote = {
      getMarketDataWithMetadataByExplicitPath: jest
        .fn()
        .mockResolvedValueOnce({
          state: 'available',
          response: { output2: [row('094000'), row('093500')] },
          receivedAt: new Date(),
          headers: {},
          trCont: 'M',
        })
        .mockResolvedValueOnce({
          state: 'available',
          response: { output2: [row('093500'), row('093000')] },
          receivedAt: new Date(),
          headers: {},
          trCont: '',
        }),
    };
    const result = await new KisUsMinuteAdapter(
      auth as never,
      quote as never,
      config as never,
    ).fetchUsFiveMinuteRows({
      asset: { id: 'a', symbol: 'AAPL', marketCode: 'NAS' },
      from: new Date('2026-07-10T13:30:00Z'),
      to: new Date('2026-07-10T14:00:00Z'),
    });

    expect(result).toMatchObject({
      pagesFetched: 2,
      duplicateRows: 1,
      complete: true,
      stopReason: 'target_reached',
    });
    expect(
      quote.getMarketDataWithMetadataByExplicitPath.mock.calls[0][0].query,
    ).toMatchObject({ NMIN: '5', PINC: '0', NEXT: '', KEYB: '' });
    expect(
      quote.getMarketDataWithMetadataByExplicitPath.mock.calls[1][0],
    ).toMatchObject({
      query: { NMIN: '5', PINC: '1', NEXT: '1', KEYB: '20260710093000' },
      headers: { tr_cont: 'N' },
    });
  });

  it('reports provider exhaustion without claiming an uncovered range complete', async () => {
    const quote = {
      getMarketDataWithMetadataByExplicitPath: jest.fn().mockResolvedValue({
        state: 'available',
        response: { output2: [row('094000')] },
        receivedAt: new Date(),
        headers: {},
        trCont: '',
      }),
    };
    const result = await new KisUsMinuteAdapter(
      auth as never,
      quote as never,
      config as never,
    ).fetchUsFiveMinuteRows({
      asset: { id: 'a', symbol: 'AAPL', marketCode: 'NAS' },
      from: new Date('2026-07-09T13:30:00Z'),
      to: new Date('2026-07-10T14:00:00Z'),
    });
    expect(result).toMatchObject({
      stopReason: 'provider_exhausted',
      complete: false,
    });
  });

  it('bounds continuation by maxPages', async () => {
    const quote = {
      getMarketDataWithMetadataByExplicitPath: jest.fn().mockResolvedValue({
        state: 'available',
        response: { output2: [row('094000')] },
        receivedAt: new Date(),
        headers: {},
        trCont: 'F',
      }),
    };
    const result = await new KisUsMinuteAdapter(
      auth as never,
      quote as never,
      config as never,
    ).fetchUsFiveMinuteRows({
      asset: { id: 'a', symbol: 'AAPL', marketCode: 'NAS' },
      from: new Date('2026-07-09T13:30:00Z'),
      to: new Date('2026-07-10T14:00:00Z'),
      maxPages: 1,
    });
    expect(result.stopReason).toBe('max_pages');
    expect(quote.getMarketDataWithMetadataByExplicitPath).toHaveBeenCalledTimes(
      1,
    );
  });

  it('detects repeated KEYB continuation without looping forever', async () => {
    const quote = {
      getMarketDataWithMetadataByExplicitPath: jest.fn().mockResolvedValue({
        state: 'available',
        response: { output2: [row('094000')] },
        receivedAt: new Date(),
        headers: {},
        trCont: 'M',
      }),
    };
    const result = await new KisUsMinuteAdapter(
      auth as never,
      quote as never,
      config as never,
    ).fetchUsFiveMinuteRows({
      asset: { id: 'a', symbol: 'AAPL', marketCode: 'NAS' },
      from: new Date('2026-07-09T13:30:00Z'),
      to: new Date('2026-07-10T14:00:00Z'),
    });
    expect(result.stopReason).toBe('cursor_not_advanced');
    expect(quote.getMarketDataWithMetadataByExplicitPath).toHaveBeenCalledTimes(
      2,
    );
  });

  it('stops on an empty continuation page', async () => {
    const quote = {
      getMarketDataWithMetadataByExplicitPath: jest.fn().mockResolvedValue({
        state: 'available',
        response: { output2: [] },
        receivedAt: new Date(),
        headers: {},
        trCont: '',
      }),
    };
    const result = await new KisUsMinuteAdapter(
      auth as never,
      quote as never,
      config as never,
    ).fetchUsFiveMinuteRows({
      asset: { id: 'a', symbol: 'AAPL', marketCode: 'NAS' },
      from: new Date('2026-07-09T13:30:00Z'),
      to: new Date('2026-07-10T14:00:00Z'),
    });
    expect(result).toMatchObject({ stopReason: 'empty_page', complete: false });
  });

  it('bounds raw US rows before another continuation request', async () => {
    const quote = {
      getMarketDataWithMetadataByExplicitPath: jest.fn().mockResolvedValue({
        state: 'available',
        response: { output2: [row('094000'), row('093500')] },
        receivedAt: new Date(),
        headers: {},
        trCont: 'M',
      }),
    };
    const result = await new KisUsMinuteAdapter(
      auth as never,
      quote as never,
      config as never,
    ).fetchUsFiveMinuteRows({
      asset: { id: 'a', symbol: 'AAPL', marketCode: 'NAS' },
      from: new Date('2026-07-09T13:30:00Z'),
      to: new Date('2026-07-10T14:00:00Z'),
      maxRows: 1,
    });
    expect(result).toMatchObject({ stopReason: 'max_rows', complete: false });
    expect(result.rows).toHaveLength(1);
    expect(quote.getMarketDataWithMetadataByExplicitPath).toHaveBeenCalledTimes(
      1,
    );
  });
});
