import { KisDomesticMinuteAdapter } from './kis-domestic-minute.adapter';

const row = (time: string) => ({
  stck_bsop_date: '20260710',
  stck_cntg_hour: time,
  stck_oprc: '100',
  stck_hgpr: '102',
  stck_lwpr: '99',
  stck_prpr: '101',
  cntg_vol: '10',
});

describe('KisDomesticMinuteAdapter', () => {
  const auth = {
    requestConfiguredRestToken: jest.fn().mockResolvedValue({
      state: 'available',
      response: { accessToken: 'token' },
      receivedAt: new Date(),
    }),
  };
  const config = { getKisConfig: () => ({ wsCustType: 'P' }) };

  beforeEach(() => jest.clearAllMocks());

  it('walks backward with the oldest row cursor, deduplicates page overlap, and uses KIS quote client', async () => {
    const quote = {
      getMarketDataByExplicitPath: jest
        .fn()
        .mockResolvedValueOnce({
          state: 'available',
          response: { output2: [row('090500'), row('090400')] },
          receivedAt: new Date('2026-07-10T00:06:00Z'),
        })
        .mockResolvedValueOnce({
          state: 'available',
          response: { output2: [row('090400'), row('090300')] },
          receivedAt: new Date('2026-07-10T00:07:00Z'),
        }),
    };
    const adapter = new KisDomesticMinuteAdapter(
      auth as never,
      quote as never,
      config as never,
    );
    const result = await adapter.fetchDomesticOneMinuteRows({
      asset: { id: 'a', symbol: '005930', marketCode: 'J' },
      from: new Date('2026-07-10T00:03:00Z'),
      to: new Date('2026-07-10T00:10:00Z'),
    });

    expect(result).toMatchObject({
      pagesFetched: 2,
      providerReturnedRows: 4,
      duplicateRows: 1,
      complete: true,
      stopReason: 'target_reached',
    });
    expect(result.rows).toHaveLength(3);
    expect(quote.getMarketDataByExplicitPath).toHaveBeenCalledTimes(2);
    const minuteCalls = quote.getMarketDataByExplicitPath.mock
      .calls as unknown[][];
    expect((minuteCalls[1][0] as { query: unknown }).query).toMatchObject({
      FID_INPUT_DATE_1: '20260710',
      FID_INPUT_HOUR_1: '090300',
      FID_PW_DATA_INCU_YN: 'Y',
    });
  });

  it.each([
    [{ output2: [] }, 'empty_page'],
    [{ unexpected: [] }, 'malformed_response'],
  ])('stops safely for empty or malformed pages', async (response, reason) => {
    const quote = {
      getMarketDataByExplicitPath: jest.fn().mockResolvedValue({
        state: 'available',
        response,
        receivedAt: new Date(),
      }),
    };
    const adapter = new KisDomesticMinuteAdapter(
      auth as never,
      quote as never,
      config as never,
    );
    const result = await adapter.fetchDomesticOneMinuteRows({
      asset: { id: 'a', symbol: '005930', marketCode: 'J' },
      from: new Date('2026-07-10T00:00:00Z'),
      to: new Date('2026-07-10T01:00:00Z'),
    });
    expect(result.complete).toBe(false);
    expect(result.stopReason).toBe(reason);
  });

  it('honors cancellation without issuing a quote request', async () => {
    const quote = { getMarketDataByExplicitPath: jest.fn() };
    const controller = new AbortController();
    controller.abort();
    const result = await new KisDomesticMinuteAdapter(
      auth as never,
      quote as never,
      config as never,
    ).fetchDomesticOneMinuteRows({
      asset: { id: 'a', symbol: '005930', marketCode: 'J' },
      from: new Date('2026-07-10T00:00:00Z'),
      to: new Date('2026-07-10T01:00:00Z'),
      signal: controller.signal,
    });
    expect(result.stopReason).toBe('canceled');
    expect(auth.requestConfiguredRestToken).not.toHaveBeenCalled();
    expect(quote.getMarketDataByExplicitPath).not.toHaveBeenCalled();
  });

  it('bounds collection by maxRows without fetching another page', async () => {
    const quote = {
      getMarketDataByExplicitPath: jest.fn().mockResolvedValue({
        state: 'available',
        response: { output2: [row('090500'), row('090400')] },
        receivedAt: new Date(),
      }),
    };
    const result = await new KisDomesticMinuteAdapter(
      auth as never,
      quote as never,
      config as never,
    ).fetchDomesticOneMinuteRows({
      asset: { id: 'a', symbol: '005930', marketCode: 'J' },
      from: new Date('2026-07-09T00:00:00Z'),
      to: new Date('2026-07-10T01:00:00Z'),
      maxRows: 1,
    });
    expect(result.stopReason).toBe('max_rows');
    expect(result.rows).toHaveLength(1);
    expect(quote.getMarketDataByExplicitPath).toHaveBeenCalledTimes(1);
  });

  it('bounds backward pagination by maxPages', async () => {
    const quote = {
      getMarketDataByExplicitPath: jest.fn().mockResolvedValue({
        state: 'available',
        response: { output2: [row('090500')] },
        receivedAt: new Date(),
      }),
    };
    const result = await new KisDomesticMinuteAdapter(
      auth as never,
      quote as never,
      config as never,
    ).fetchDomesticOneMinuteRows({
      asset: { id: 'a', symbol: '005930', marketCode: 'J' },
      from: new Date('2026-07-09T00:00:00Z'),
      to: new Date('2026-07-10T01:00:00Z'),
      maxPages: 1,
    });
    expect(result).toMatchObject({ stopReason: 'max_pages', complete: false });
    expect(quote.getMarketDataByExplicitPath).toHaveBeenCalledTimes(1);
  });

  it('detects a provider that ignores the backward cursor', async () => {
    const quote = {
      getMarketDataByExplicitPath: jest.fn().mockResolvedValue({
        state: 'available',
        response: { output2: [row('090500')] },
        receivedAt: new Date(),
      }),
    };
    const result = await new KisDomesticMinuteAdapter(
      auth as never,
      quote as never,
      config as never,
    ).fetchDomesticOneMinuteRows({
      asset: { id: 'a', symbol: '005930', marketCode: 'J' },
      from: new Date('2026-07-09T00:00:00Z'),
      to: new Date('2026-07-10T01:00:00Z'),
    });
    expect(result.stopReason).toBe('cursor_not_advanced');
    expect(quote.getMarketDataByExplicitPath).toHaveBeenCalledTimes(2);
  });

  it('aborts an in-flight physical request when maxDuration is exhausted', async () => {
    jest.useFakeTimers();
    try {
      const quote = {
        getMarketDataByExplicitPath: jest.fn(
          ({ signal }: { signal: AbortSignal }) =>
            new Promise((_, reject) => {
              signal.addEventListener(
                'abort',
                () => reject(new Error('aborted')),
                { once: true },
              );
            }),
        ),
      };
      const pending = new KisDomesticMinuteAdapter(
        auth as never,
        quote as never,
        config as never,
      ).fetchDomesticOneMinuteRows({
        asset: { id: 'a', symbol: '005930', marketCode: 'J' },
        from: new Date('2026-07-09T00:00:00Z'),
        to: new Date('2026-07-10T01:00:00Z'),
        maxDurationMs: 10,
      });
      await jest.advanceTimersByTimeAsync(10);
      await expect(pending).resolves.toMatchObject({
        stopReason: 'max_duration',
        complete: false,
      });
      expect(
        quote.getMarketDataByExplicitPath.mock.calls[0][0].signal,
      ).toBeInstanceOf(AbortSignal);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects an invalid asset before authentication or provider calls', async () => {
    const quote = { getMarketDataByExplicitPath: jest.fn() };
    await expect(
      new KisDomesticMinuteAdapter(
        auth as never,
        quote as never,
        config as never,
      ).fetchDomesticOneMinuteRows({
        asset: { id: 'a', symbol: ' ', marketCode: 'J' },
        from: new Date('2026-07-10T00:00:00Z'),
        to: new Date('2026-07-10T01:00:00Z'),
      }),
    ).rejects.toThrow('asset.symbol');
    expect(auth.requestConfiguredRestToken).not.toHaveBeenCalled();
  });

  it('bounds a shared OAuth token wait without issuing a quote request', async () => {
    jest.useFakeTimers();
    try {
      const slowAuth = {
        requestConfiguredRestToken: jest.fn(() => new Promise(() => undefined)),
      };
      const quote = { getMarketDataByExplicitPath: jest.fn() };
      const pending = new KisDomesticMinuteAdapter(
        slowAuth as never,
        quote as never,
        config as never,
      ).fetchDomesticOneMinuteRows({
        asset: { id: 'a', symbol: '005930', marketCode: 'J' },
        from: new Date('2026-07-09T00:00:00Z'),
        to: new Date('2026-07-10T01:00:00Z'),
        maxDurationMs: 10,
      });
      await jest.advanceTimersByTimeAsync(10);
      await expect(pending).resolves.toMatchObject({
        stopReason: 'max_duration',
        complete: false,
      });
      expect(quote.getMarketDataByExplicitPath).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
