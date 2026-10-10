jest.mock('../../generated/prisma/client', () => ({
  Prisma: {
    Decimal: jest.requireActual<{
      Decimal: typeof import('@prisma/client/runtime/client').Decimal;
    }>('@prisma/client/runtime/client').Decimal,
  },
  PrismaClient: class {},
  AssetType: {
    domestic_stock: 'domestic_stock',
    us_stock: 'us_stock',
    crypto: 'crypto',
  },
  CurrencyCode: { KRW: 'KRW', USD: 'USD' },
}));
import type { KoscomClient, KoscomResponse } from './koscom.client';
import { KoscomCandleAdapter } from './koscom-candle.adapter';
import { KisCandleNormalizerService } from '../kis/candles/kis-candle-normalizer.service';
import { KisDomesticFiveMinuteBuilder } from '../kis/candles/kis-domestic-five-minute.builder';
import { KisPeriodCandleNormalizerService } from '../kis/candles/kis-period-candle-normalizer.service';
import { MarketCandleAggregationService } from '../../assets/market-candle-aggregation.service';
import { CandleResponseBuilder } from '../../assets/candle-response.builder';
import { LiveCandleEventNormalizerService } from '../../assets/live-candle-event-normalizer.service';
import { MarketCandleIngestionService } from '../../assets/market-candle-ingestion.service';
import { readLiveCandleConfig } from '../../assets/live-candle.config';

const now = new Date('2026-09-30T01:00:00Z');
const asset = { id: 'samsung', symbol: '005930', marketCode: 'KRX' };
function minute(i: number) {
  return {
    inddTm: String(9000000 + (i + 1) * 10000),
    inddOpnprc: String(100 + i),
    inddHgprc: String(102 + i),
    inddLwprc: String(99 + i),
    inddClsprc: String(101 + i),
    inddTrdvol: '2',
    inddTrdval: '123456789012345.12345678',
    inddAccTrdvol: '9999',
  };
}
function harness(rows: unknown[]) {
  const client = {
    get: jest
      .fn<Promise<KoscomResponse>, Parameters<KoscomClient['get']>>()
      .mockResolvedValue({
        result: { isuSrtCd: '005930', hisLists: rows },
        receivedAt: now,
      }),
  };
  const markets = { resolve: jest.fn().mockResolvedValue('kospi') };
  return {
    adapter: new KoscomCandleAdapter(client as never, markets as never),
    client,
    markets,
  };
}
const input = {
  asset,
  from: new Date('2026-09-30T00:00:00Z'),
  to: new Date('2026-09-30T00:15:00Z'),
  now,
};
describe('KOSCOM candles', () => {
  it('turns reverse-ordered 1m bars into exact 5m and 15m OHLCV/amount', async () => {
    const h = harness(
      Array.from({ length: 15 }, (_, i) => minute(i)).reverse(),
    );
    const result = await h.adapter.fetchDomesticOneMinuteRows(input);
    expect(result.complete).toBe(true);
    expect(result.rows.length).toBe(15);
    const normalized =
      new KisCandleNormalizerService().normalizeDomesticOneMinuteRows({
        ...input,
        rows: result.rows,
      });
    const built = new KisDomesticFiveMinuteBuilder().build({
      rows: normalized.rows,
      now,
    });
    expect(built.candles.length).toBe(3);
    expect(built.incompleteBuckets).toBe(0);
    const candle = built.candles[0];
    expect(
      [candle.open, candle.high, candle.low, candle.close, candle.volume].map(
        (v) => v.toFixed(),
      ),
    ).toEqual(['100', '106', '99', '105', '10']);
    expect(candle.amount?.toFixed(8)).toBe('617283945061725.61728390');
    const aggregated = new MarketCandleAggregationService(
      {} as never,
    ).aggregateCandles({
      assetType: 'domestic_stock',
      interval: '15m',
      candles: built.candles,
      from: input.from,
      to: input.to,
      now,
    });
    expect(aggregated.candles[0].complete).toBe(true);
    expect(aggregated.candles[0].volume.toFixed()).toBe('30');
    expect(aggregated.candles[0].amount?.toFixed(8)).toBe(
      '1851851835185176.85185170',
    );
    expect(h.client.get.mock.calls[0][1]).toEqual({
      inddCycleTpCd: '60',
      inqStrtDd: '20260930',
      strtTm: '0900',
      endTm: '0915',
    });
  });
  it('keeps missing minutes missing and refuses a complete bucket', async () => {
    const h = harness([minute(0), minute(1), minute(3), minute(4)]);
    const request = { ...input, to: new Date('2026-09-30T00:05:00Z') };
    const result = await h.adapter.fetchDomesticOneMinuteRows(request);
    const normalized =
      new KisCandleNormalizerService().normalizeDomesticOneMinuteRows({
        ...request,
        rows: result.rows,
      });
    const built = new KisDomesticFiveMinuteBuilder().build({
      rows: normalized.rows,
      now,
    });
    expect(result.complete).toBe(false);
    expect(built.candles.length).toBe(0);
    expect(built.incompleteBuckets).toBe(1);
  });
  it('deduplicates identical rows and rejects conflicting duplicates', async () => {
    const request = { ...input, to: new Date('2026-09-30T00:05:00Z') };
    const data = Array.from({ length: 5 }, (_, i) => minute(i));
    const identical = await harness([
      ...data,
      minute(0),
    ]).adapter.fetchDomesticOneMinuteRows(request);
    expect(identical.complete).toBe(true);
    expect(identical.duplicateRows).toBe(1);
    const conflict = await harness([
      ...data,
      { ...minute(0), inddClsprc: '102' },
    ]).adapter.fetchDomesticOneMinuteRows(request);
    expect(conflict.complete).toBe(false);
    expect(conflict.stopReason).toBe('malformed_response');
  });
  it('does not call or promise historical intraday retention, holidays, or future candles', async () => {
    const h = harness([]);
    const past = await h.adapter.fetchDomesticOneMinuteRows({
      ...input,
      from: new Date('2026-09-29T00:00:00Z'),
      to: new Date('2026-09-29T01:00:00Z'),
    });
    expect(past.complete).toBe(false);
    expect(past.stopReason).toBe('provider_exhausted');
    expect(h.client.get).not.toHaveBeenCalled();
    const holiday = await h.adapter.fetchDomesticOneMinuteRows({
      ...input,
      from: new Date('2026-10-03T00:00:00Z'),
      to: new Date('2026-10-03T01:00:00Z'),
      now: new Date('2026-10-03T02:00:00Z'),
    });
    expect(holiday.stopReason).toBe('expected_no_data');
    expect(h.client.get).not.toHaveBeenCalled();
  });
  it('uses bounded documented time windows and respects page budget', async () => {
    const h = harness([minute(0)]);
    const result = await h.adapter.fetchDomesticOneMinuteRows({
      ...input,
      to: new Date('2026-09-30T06:30:00Z'),
      now: new Date('2026-09-30T06:31:00Z'),
      maxPages: 2,
    });
    expect(result.pagesFetched).toBe(2);
    expect(result.stopReason).toBe('max_pages');
    for (const call of h.client.get.mock.calls) {
      expect(Object.keys(call[1]).sort()).toEqual([
        'endTm',
        'inddCycleTpCd',
        'inqStrtDd',
        'strtTm',
      ]);
    }
  });
  it.each(['1d', '1w'] as const)(
    'maps %s history and normalizes the last-trading-day date to canonical windows',
    async (interval) => {
      const h = harness([
        {
          trdDd: '20261002',
          opnprc: '100',
          hgprc: '110',
          lwprc: '90',
          trdPrc: '105',
          accTrdvol: '12',
          accTrdval: '1200',
        },
      ]);
      h.client.get.mockResolvedValue({
        result: {
          isuSrtCd: '005930',
          hisLists: [
            {
              trdDd: '20261002',
              opnprc: '100',
              hgprc: '110',
              lwprc: '90',
              trdPrc: '105',
              accTrdvol: '12',
              accTrdval: '1200',
            },
          ],
        },
        receivedAt: new Date('2026-10-02T07:00:00Z'),
      });
      const page = await h.adapter.fetchPeriodPage({
        asset,
        interval,
        fromDate: '20260928',
        endDate: '20261002',
      });
      expect(h.client.get.mock.calls[0][1]).toEqual({
        trnsmCycleTpCd: interval === '1d' ? 'D' : 'W',
        inqStrtDd: '20260928',
        inqEndDd: '20261002',
        reqCnt: '100',
      });
      const normalized =
        new KisPeriodCandleNormalizerService().normalizeDomesticPeriodRows({
          rows: page.rows,
          interval,
          from: new Date('2026-09-27T15:00:00Z'),
          to: new Date('2026-10-03T15:00:00Z'),
          now: new Date('2026-10-03T00:00:00Z'),
        });
      expect(normalized.candles.length).toBe(1);
      expect(normalized.candles[0].isClosed).toBe(true);
      expect(normalized.candles[0].openTime.toISOString()).toBe(
        interval === '1w'
          ? '2026-09-27T15:00:00.000Z'
          : '2026-10-01T15:00:00.000Z',
      );
    },
  );
  it('preserves mixed historical source metadata', () => {
    const response = new CandleResponseBuilder().buildPersisted(
      {
        id: 'a',
        symbol: '005930',
        name: 'Samsung',
        assetType: 'domestic_stock',
        market: 'KRX',
        currencyCode: 'KRW',
      } as never,
      {
        interval: '5m',
        range: '1d',
        limit: 100,
        requestedDate: '2026-09-30',
      } as never,
      [],
      ['kis_domestic_minute', 'koscom_intraday'],
    );
    expect(response.data.source.provider).toBe('mixed');
    expect(
      'sourceProviders' in response.data.source &&
        response.data.source.sourceProviders,
    ).toEqual(['kis_domestic_minute', 'koscom_intraday']);
  });
  it.each([2, 5])(
    'publishes exact native OHLCV after %i completed minutes',
    async (count) => {
      const asOf = new Date(`2026-09-30T00:0${count}:05Z`);
      const h = harness(Array.from({ length: count }, (_, i) => minute(i)));
      const service = new MarketCandleIngestionService(
        h.adapter,
        {} as never,
        new KisCandleNormalizerService(),
        new KisDomesticFiveMinuteBuilder(),
        {} as never,
        {} as never,
      );
      const fetched = await service.fetchDomesticFiveMinuteCandles({
        ...input,
        now: asOf,
        to: asOf,
      });
      expect(fetched.candles.length).toBe(1);
      expect(fetched.complete).toBe(true);
      const result = new LiveCandleEventNormalizerService(
        readLiveCandleConfig({}),
      ).normalizeKoscomCandle(
        fetched.candles[0],
        {
          id: 'a',
          symbol: '005930',
          market: 'KRX',
          assetType: 'domestic_stock',
          isActive: true,
        },
        asOf,
        new Date(asOf.getTime() + 1000),
      );
      expect(result.provider).toBe('koscom');
      expect(result.source).toBe('koscom_intraday');
      expect(result.mode).toBe('absolute');
      expect(result.tradeQuantity).toBeNull();
      expect(result.amount).toBeNull();
      expect(result.absolute?.providerFinal).toBe(count === 5);
      expect(result.absolute?.open).toBe('100.00000000');
      expect(result.absolute?.high).toBe(`${101 + count}.00000000`);
      expect(result.absolute?.close).toBe(`${100 + count}.00000000`);
      expect(result.absolute?.volume).toBe(`${count * 2}.00000000`);
      expect(result.absolute?.amount).toBe(
        count === 2 ? '246913578024690.24691356' : '617283945061725.61728390',
      );
      expect(result.eventTime.toISOString()).toBe(
        `2026-09-30T00:0${count - 1}:59.999Z`,
      );
      expect(result.receivedAt > result.eventTime).toBe(true);
    },
  );
  it('does not publish a partial current bucket when a completed constituent is missing', async () => {
    const h = harness([minute(1)]);
    const service = new MarketCandleIngestionService(
      h.adapter,
      {} as never,
      new KisCandleNormalizerService(),
      new KisDomesticFiveMinuteBuilder(),
      {} as never,
      {} as never,
    );
    const asOf = new Date('2026-09-30T00:02:05Z');
    const fetched = await service.fetchDomesticFiveMinuteCandles({
      ...input,
      now: asOf,
      to: asOf,
    });
    expect(fetched.candles.length).toBe(0);
    expect(fetched.complete).toBe(false);
  });
});
