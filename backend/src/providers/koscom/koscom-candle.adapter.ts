import { Injectable } from '@nestjs/common';
import {
  resolveMarketSession,
  inspectMarketSessionsInRange,
} from '../../orders/market-calendar.policy';
import {
  createBoundedAbortSignal,
  formatZonedCursor,
  validateFetchInput,
} from '../kis/candles/kis-candle-time';
import type {
  KisCandleAdapterResult,
  KisCandleFetchInput,
  KisRawCandleRow,
} from '../kis/candles/kis-candle.types';
import type {
  KisPeriodPageInput,
  KisPeriodPageResult,
} from '../kis/candles/kis-period-candle.types';
import {
  KoscomClient,
  koscomRecord,
  type KoscomResponse,
} from './koscom.client';
import { KoscomError } from './koscom.config';
import { KoscomMarketMapService } from './koscom-market-map.service';
import { koscomTime, koscomDecimal, koscomText } from './koscom-normalizer';

/** Translate at the provider boundary; retain existing calendar/Decimal builders. */
@Injectable()
export class KoscomCandleAdapter {
  constructor(
    private readonly client: KoscomClient,
    private readonly markets: KoscomMarketMapService,
  ) {}

  async fetchDomesticOneMinuteRows(
    input: KisCandleFetchInput,
  ): Promise<KisCandleAdapterResult> {
    const limits = validateFetchInput(input);
    const now = input.now ?? new Date();
    const empty = (
      stopReason: KisCandleAdapterResult['stopReason'],
      complete = false,
    ): KisCandleAdapterResult => ({
      rows: [],
      pagesFetched: 0,
      providerReturnedRows: 0,
      duplicateRows: 0,
      complete,
      stopReason,
      oldestOpenTime: null,
      latestOpenTime: null,
    });
    if (input.signal?.aborted) return empty('canceled');
    const effectiveTo = new Date(Math.min(input.to.getTime(), now.getTime()));
    if (effectiveTo <= input.from) return empty('expected_no_data', true);
    const range = inspectMarketSessionsInRange(
      { assetType: 'domestic_stock', market: 'KRX' },
      input.from,
      effectiveTo,
    );
    if (!range.calendarCovered) return empty('calendar_unavailable');
    if (!range.hasTradingSession) return empty('expected_no_data', true);
    // Historical retention is not documented. Only today's dated intraday
    // response is trusted until live verification establishes a past-date contract.
    const date = formatZonedCursor(now, 'Asia/Seoul').date;
    const session = resolveMarketSession('KRX', date);
    if (!session || effectiveTo <= session.openTime)
      return empty('provider_exhausted');
    const fromMs = Math.max(input.from.getTime(), session.openTime.getTime());
    const toMs = Math.min(effectiveTo.getTime(), session.closeTime.getTime());
    if (fromMs >= toMs) return empty('expected_no_data', true);
    const bounded = createBoundedAbortSignal(
      input.signal,
      limits.maxDurationMs,
    );
    const rows = new Map<number, KisRawCandleRow>();
    const conflicts = new Set<number>();
    let pagesFetched = 0,
      providerReturnedRows = 0,
      duplicateRows = 0,
      malformed = false;
    let endMs = Math.floor(toMs / 60000) * 60000;
    let stopReason: KisCandleAdapterResult['stopReason'] = 'target_reached';
    try {
      let market;
      try {
        market = await this.markets.resolve(
          input.asset.symbol,
          input.asset.marketCode === 'J' ? 'KRX' : input.asset.marketCode,
          bounded.signal,
        );
      } catch (error) {
        if (bounded.signal.aborted)
          return empty(input.signal?.aborted ? 'canceled' : 'max_duration');
        throw error;
      }
      // At most 95 completed one-minute bars + endpoint inclusivity (<100).
      // These are documented time-window requests, not continuation tokens.
      while (endMs > fromMs) {
        if (pagesFetched >= limits.maxPages) {
          stopReason = 'max_pages';
          break;
        }
        if (rows.size >= limits.maxRows) {
          stopReason = 'max_rows';
          break;
        }
        const startMs = Math.max(
          Math.floor(fromMs / 60000) * 60000,
          endMs - 95 * 60000,
        );
        let response: KoscomResponse;
        try {
          response = await this.client.get(
            `/v3/market/realtime/${market}/stocks/${input.asset.symbol}/intraday`,
            {
              inddCycleTpCd: '60',
              inqStrtDd: date,
              strtTm: formatZonedCursor(
                new Date(startMs),
                'Asia/Seoul',
              ).time.slice(0, 4),
              endTm: formatZonedCursor(
                new Date(endMs),
                'Asia/Seoul',
              ).time.slice(0, 4),
            },
            bounded.signal,
          );
        } catch (error) {
          if (bounded.signal.aborted) {
            stopReason = input.signal?.aborted ? 'canceled' : 'max_duration';
            break;
          }
          throw error;
        }
        pagesFetched++;
        if (
          response.result.isuSrtCd !== input.asset.symbol ||
          !Array.isArray(response.result.hisLists) ||
          response.result.hisLists.length > 100
        )
          throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
            'KOSCOM_MALFORMED_CANDLES',
          );
        if (
          response.result.trdDd !== undefined &&
          response.result.trdDd !== date
        )
          throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
            'KOSCOM_CANDLE_DATE_MISMATCH',
          );
        providerReturnedRows += response.result.hisLists.length;
        for (const item of response.result.hisLists) {
          try {
            const row = koscomRecord(item);
            // Official examples begin with 09:10 for the first 10-minute
            // interval: inddTm labels the interval END. Store minute opens.
            const end = koscomTime(date, row.inddTm);
            if (end.getTime() % 60000 !== 0)
              throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
                'KOSCOM_INVALID_TIME',
              );
            const openTime = new Date(end.getTime() - 60000);
            if (
              openTime.getTime() < startMs ||
              end.getTime() > endMs ||
              end > now ||
              end > response.receivedAt
            )
              continue;
            const stamp = formatZonedCursor(openTime, 'Asia/Seoul');
            const values = ohlcv(row, true);
            const value = {
              stck_bsop_date: stamp.date,
              stck_cntg_hour: stamp.time,
              stck_oprc: values.open,
              stck_hgpr: values.high,
              stck_lwpr: values.low,
              stck_prpr: values.close,
              cntg_vol: values.volume,
              cntg_tr_pbmn: values.amount,
            };
            const key = openTime.getTime();
            if (conflicts.has(key)) {
              duplicateRows++;
              continue;
            }
            const previous = rows.get(key);
            if (previous) {
              duplicateRows++;
              if (JSON.stringify(previous.value) !== JSON.stringify(value)) {
                rows.delete(key);
                conflicts.add(key);
                malformed = true;
              }
              continue;
            }
            if (rows.size < limits.maxRows)
              rows.set(key, {
                value,
                receivedAt: response.receivedAt,
                sequence: rows.size,
              });
          } catch {
            malformed = true;
          }
        }
        if (!response.result.hisLists.length) {
          stopReason = 'empty_page';
          break;
        }
        endMs = startMs;
      }
    } finally {
      bounded.clear();
    }
    const ordered = [...rows.entries()].sort((a, b) => a[0] - b[0]);
    const expected = Math.max(
      0,
      Math.floor(toMs / 60000) - Math.ceil(fromMs / 60000),
    );
    const complete =
      stopReason === 'target_reached' &&
      !malformed &&
      ordered.length === expected &&
      input.from >= session.openTime;
    if (malformed) stopReason = 'malformed_response';
    else if (!complete && stopReason === 'target_reached')
      stopReason = 'provider_exhausted';
    return {
      rows: ordered.map(([, row]) => row),
      pagesFetched,
      providerReturnedRows,
      duplicateRows,
      complete,
      stopReason,
      oldestOpenTime: ordered.length ? new Date(ordered[0][0]) : null,
      latestOpenTime: ordered.length ? new Date(ordered.at(-1)![0]) : null,
    };
  }

  async fetchPeriodPage(
    input: KisPeriodPageInput,
  ): Promise<KisPeriodPageResult> {
    if (
      !/^\d{8}$/.test(input.fromDate) ||
      !/^\d{8}$/.test(input.endDate) ||
      input.fromDate > input.endDate
    )
      throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
        'KOSCOM_INVALID_DATE_RANGE',
      );
    const bounded = createBoundedAbortSignal(
      input.signal,
      input.timeoutMs ?? 15000,
    );
    let response: KoscomResponse;
    try {
      const market = await this.markets.resolve(
        input.asset.symbol,
        input.asset.marketCode === 'J' ? 'KRX' : input.asset.marketCode,
        bounded.signal,
      );
      response = await this.client.get(
        `/v3/market/closed/${market}/${input.asset.symbol}/history`,
        {
          trnsmCycleTpCd: input.interval === '1d' ? 'D' : 'W',
          inqStrtDd: input.fromDate,
          inqEndDd: input.endDate,
          reqCnt: '100',
        },
        bounded.signal,
      );
    } finally {
      bounded.clear();
    }
    const result = response.result;
    if (
      result.isuSrtCd !== input.asset.symbol ||
      !Array.isArray(result.hisLists) ||
      result.hisLists.length > 100
    )
      throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
        'KOSCOM_MALFORMED_CANDLES',
      );
    const rows: KisRawCandleRow[] = [];
    const seen = new Map<string, string>();
    for (const item of result.hisLists) {
      const row = koscomRecord(item),
        date = koscomText(row.trdDd);
      if (
        !/^\d{8}$/.test(date) ||
        date < input.fromDate ||
        date > input.endDate ||
        date > formatZonedCursor(response.receivedAt, 'Asia/Seoul').date ||
        !resolveMarketSession('KRX', date)
      )
        throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
          'KOSCOM_CANDLE_DATE_MISMATCH',
        );
      const values = ohlcv(row, false);
      const serialized = JSON.stringify(values);
      if (seen.has(date)) {
        if (seen.get(date) !== serialized)
          throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
            'KOSCOM_CONFLICTING_CANDLES',
          );
        continue;
      }
      seen.set(date, serialized);
      rows.push({
        value: {
          stck_bsop_date: date,
          stck_oprc: values.open,
          stck_hgpr: values.high,
          stck_lwpr: values.low,
          stck_clpr: values.close,
          acml_vol: values.volume,
          acml_tr_pbmn: values.amount,
        },
        receivedAt: response.receivedAt,
        sequence: rows.length,
      });
    }
    const dates = rows.map((r) => String(r.value.stck_bsop_date)).sort();
    return {
      state: 'ok',
      rows,
      providerReturnedRows: result.hisLists.length,
      blankRows: 0,
      oldestDate: dates[0] ?? null,
      latestDate: dates.at(-1) ?? null,
      trCont: null,
    };
  }

  async master(symbol: string, assetMarket: string) {
    const market = await this.markets.resolve(symbol, assetMarket);
    const response = await this.client.get(
      `/v3/market/closed/${market}/${symbol}/master`,
    );
    if (response.result.isuSrtCd !== symbol)
      throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
        'KOSCOM_SYMBOL_MISMATCH',
      );
    return response;
  }
}

export function ohlcv(row: Record<string, unknown>, intraday: boolean) {
  const open = koscomDecimal(row[intraday ? 'inddOpnprc' : 'opnprc'], true);
  const high = koscomDecimal(row[intraday ? 'inddHgprc' : 'hgprc'], true);
  const low = koscomDecimal(row[intraday ? 'inddLwprc' : 'lwprc'], true);
  const close = koscomDecimal(row[intraday ? 'inddClsprc' : 'trdPrc'], true);
  const volume = koscomDecimal(row[intraday ? 'inddTrdvol' : 'accTrdvol']);
  const amount = koscomDecimal(row[intraday ? 'inddTrdval' : 'accTrdval']);
  if (
    high.lt(open) ||
    high.lt(close) ||
    high.lt(low) ||
    low.gt(open) ||
    low.gt(close)
  )
    throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
      'KOSCOM_INVALID_OHLC',
    );
  return {
    open: open.toFixed(),
    high: high.toFixed(),
    low: low.toFixed(),
    close: close.toFixed(),
    volume: volume.toFixed(),
    amount: amount.toFixed(),
  };
}
