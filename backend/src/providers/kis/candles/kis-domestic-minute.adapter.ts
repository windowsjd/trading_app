import { Injectable } from '@nestjs/common';
import type { AssetType } from '../../../generated/prisma/client';
import {
  inspectMarketSessionsInRange,
  resolveStockMarketDataUpperBound,
} from '../../../orders/market-calendar.policy';
import { KisAuthClient } from '../kis-auth.client';
import { KisQuoteClient } from '../kis-quote.client';
import type { KisLowLevelCallResult } from '../kis.types';
import { ProviderConfigService } from '../../provider-config.service';
import {
  KIS_DOMESTIC_MINUTE_PATH,
  KIS_DOMESTIC_MINUTE_TR_ID,
  type KisCandleAdapterResult,
  type KisCandleFetchInput,
  type KisRawCandleRow,
} from './kis-candle.types';
import {
  awaitWithinBudget,
  createBoundedAbortSignal,
  formatZonedCursor,
  validateCandleAsset,
  validateFetchInput,
  zonedDateTimeToUtc,
} from './kis-candle-time';

const TIME_ZONE = 'Asia/Seoul';
const MINUTE_MS = 60_000;

@Injectable()
export class KisDomesticMinuteAdapter {
  constructor(
    private readonly authClient: KisAuthClient,
    private readonly quoteClient: KisQuoteClient,
    private readonly configService: ProviderConfigService,
  ) {}

  async fetchDomesticOneMinuteRows(
    input: KisCandleFetchInput,
  ): Promise<KisCandleAdapterResult> {
    const limits = validateFetchInput(input);
    validateCandleAsset(input.asset);
    const startedAt = Date.now();
    if (input.signal?.aborted) return emptyResult('canceled');
    const now = input.now ?? new Date();
    const effectiveTo = new Date(Math.min(input.to.getTime(), now.getTime()));
    if (effectiveTo.getTime() <= input.from.getTime()) {
      return emptyResult('expected_no_data', true);
    }
    const marketAsset = {
      assetType: 'domestic_stock' as AssetType,
      market: 'KRX',
    };
    const range = inspectMarketSessionsInRange(
      marketAsset,
      input.from,
      effectiveTo,
    );
    if (!range.calendarCovered) return emptyResult('calendar_unavailable');
    if (!range.hasTradingSession) {
      return emptyResult('expected_no_data', true);
    }
    const providerTo = resolveStockMarketDataUpperBound(
      marketAsset,
      input.to,
      now,
    );
    if (!providerTo) return emptyResult('calendar_unavailable');
    const config = this.configService.getKisConfig();
    const tokenWait = await awaitWithinBudget(
      this.authClient.requestConfiguredRestToken(),
      input.signal,
      limits.maxDurationMs - (Date.now() - startedAt),
    );
    if (tokenWait.state !== 'resolved') return emptyResult(tokenWait.state);
    const token = tokenWait.value;
    if (token.state === 'skipped') return emptyResult('malformed_response');
    let cursor = new Date(providerTo.getTime() - 1);
    const visited = new Set<string>();
    const seenRows = new Map<number, number>();
    const rows: KisRawCandleRow[] = [];
    let pagesFetched = 0;
    let providerReturnedRows = 0;
    let duplicateRows = 0;
    let oldestOpenTime: Date | null = null;
    let latestOpenTime: Date | null = null;
    let stopReason: KisCandleAdapterResult['stopReason'] = 'max_pages';

    while (pagesFetched < limits.maxPages) {
      if (input.signal?.aborted) {
        stopReason = 'canceled';
        break;
      }
      if (Date.now() - startedAt >= limits.maxDurationMs) {
        stopReason = 'max_duration';
        break;
      }
      const formatted = formatZonedCursor(cursor, TIME_ZONE);
      const cursorKey = `${formatted.date}:${formatted.time}`;
      if (visited.has(cursorKey)) {
        stopReason = 'cursor_not_advanced';
        break;
      }
      visited.add(cursorKey);

      const remainingMs = limits.maxDurationMs - (Date.now() - startedAt);
      const boundedSignal = createBoundedAbortSignal(input.signal, remainingMs);
      let fetched: KisLowLevelCallResult<unknown>;
      try {
        fetched = await this.quoteClient.getMarketDataByExplicitPath<unknown>({
          path: KIS_DOMESTIC_MINUTE_PATH,
          query: {
            FID_COND_MRKT_DIV_CODE: input.asset.marketCode,
            FID_INPUT_ISCD: input.asset.symbol,
            FID_INPUT_DATE_1: formatted.date,
            FID_INPUT_HOUR_1: formatted.time,
            FID_PW_DATA_INCU_YN: 'Y',
            FID_FAKE_TICK_INCU_YN: '',
          },
          headers: {
            authorization: `Bearer ${token.response.accessToken}`,
            tr_id: KIS_DOMESTIC_MINUTE_TR_ID,
            custtype: config.wsCustType,
          },
          signal: boundedSignal.signal,
        });
      } catch (error) {
        if (input.signal?.aborted) {
          stopReason = 'canceled';
          break;
        }
        if (boundedSignal.deadlineSignal.aborted) {
          stopReason = 'max_duration';
          break;
        }
        throw error;
      } finally {
        boundedSignal.clear();
      }
      pagesFetched += 1;
      if (fetched.state === 'skipped') {
        stopReason = 'malformed_response';
        break;
      }
      const page = extractOutputRows(fetched.response);
      if (!page) {
        stopReason = 'malformed_response';
        break;
      }
      providerReturnedRows += page.length;
      if (page.length === 0) {
        stopReason = 'empty_page';
        break;
      }

      let pageOldest: Date | null = null;
      for (const value of page) {
        const record = isRecord(value) ? value : {};
        const timestamp = domesticTimestamp(record);
        if (timestamp) {
          pageOldest = earlierDate(pageOldest, timestamp);
          oldestOpenTime = earlierDate(oldestOpenTime, timestamp);
          latestOpenTime = laterDate(latestOpenTime, timestamp);
          const time = timestamp.getTime();
          const existingIndex = seenRows.get(time);
          if (existingIndex !== undefined) {
            duplicateRows += 1;
            if (
              fetched.receivedAt.getTime() >
              rows[existingIndex].receivedAt.getTime()
            ) {
              rows[existingIndex] = {
                value: record,
                receivedAt: fetched.receivedAt,
                sequence: existingIndex,
              };
            }
            continue;
          }
          if (rows.length < limits.maxRows) seenRows.set(time, rows.length);
        }
        if (rows.length >= limits.maxRows) continue;
        rows.push({
          value: record,
          receivedAt: fetched.receivedAt,
          sequence: rows.length,
        });
      }
      if (rows.length >= limits.maxRows) {
        stopReason = 'max_rows';
        break;
      }
      if (!pageOldest) {
        stopReason = 'malformed_response';
        break;
      }
      if (pageOldest.getTime() <= input.from.getTime()) {
        stopReason = 'target_reached';
        break;
      }
      const nextCursor = new Date(pageOldest.getTime() - MINUTE_MS);
      if (nextCursor.getTime() >= cursor.getTime()) {
        stopReason = 'cursor_not_advanced';
        break;
      }
      cursor = nextCursor;
      if (pagesFetched === limits.maxPages) stopReason = 'max_pages';
    }
    return {
      pagesFetched,
      providerReturnedRows,
      rows,
      duplicateRows,
      complete:
        stopReason === 'target_reached' &&
        oldestOpenTime !== null &&
        oldestOpenTime.getTime() <= input.from.getTime(),
      stopReason,
      oldestOpenTime,
      latestOpenTime,
    };
  }
}

function domesticTimestamp(row: Record<string, unknown>): Date | null {
  return typeof row.stck_bsop_date === 'string' &&
    typeof row.stck_cntg_hour === 'string'
    ? zonedDateTimeToUtc(row.stck_bsop_date, row.stck_cntg_hour, TIME_ZONE)
    : null;
}

function extractOutputRows(payload: unknown): unknown[] | null {
  if (!isRecord(payload)) return null;
  const rows: unknown = payload.output2;
  // Array.isArray narrows `unknown` to `any[]`; re-assert the safe element
  // type so no `any` escapes this boundary.
  return Array.isArray(rows) ? (rows as unknown[]) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emptyResult(
  stopReason: KisCandleAdapterResult['stopReason'],
  complete = false,
): KisCandleAdapterResult {
  return {
    pagesFetched: 0,
    providerReturnedRows: 0,
    rows: [],
    duplicateRows: 0,
    complete,
    stopReason,
    oldestOpenTime: null,
    latestOpenTime: null,
  };
}

function earlierDate(current: Date | null, candidate: Date): Date {
  return current === null || candidate.getTime() < current.getTime()
    ? candidate
    : current;
}

function laterDate(current: Date | null, candidate: Date): Date {
  return current === null || candidate.getTime() > current.getTime()
    ? candidate
    : current;
}
