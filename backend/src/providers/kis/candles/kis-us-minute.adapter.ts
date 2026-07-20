import { Injectable } from '@nestjs/common';
import type { AssetType } from '../../../generated/prisma/client';
import { inspectMarketSessionsInRange } from '../../../orders/market-calendar.policy';
import { KisAuthClient } from '../kis-auth.client';
import { KisQuoteClient } from '../kis-quote.client';
import type { KisLowLevelCallWithMetadataResult } from '../kis.types';
import { ProviderConfigService } from '../../provider-config.service';
import {
  KIS_US_MINUTE_PATH,
  KIS_US_MINUTE_TR_ID,
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

const TIME_ZONE = 'America/New_York';
const FIVE_MINUTES_MS = 5 * 60_000;

@Injectable()
export class KisUsMinuteAdapter {
  constructor(
    private readonly authClient: KisAuthClient,
    private readonly quoteClient: KisQuoteClient,
    private readonly configService: ProviderConfigService,
  ) {}

  async fetchUsFiveMinuteRows(
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
    const range = inspectMarketSessionsInRange(
      { assetType: 'us_stock' as AssetType, market: 'US' },
      input.from,
      effectiveTo,
    );
    if (!range.calendarCovered) return emptyResult('calendar_unavailable');
    if (!range.hasTradingSession) {
      return emptyResult('expected_no_data', true);
    }
    const config = this.configService.getKisConfig();
    const tokenWait = await awaitWithinBudget(
      this.authClient.requestConfiguredRestToken(),
      input.signal,
      limits.maxDurationMs - (Date.now() - startedAt),
    );
    if (tokenWait.state !== 'resolved') return emptyResult(tokenWait.state);
    const token = tokenWait.value;
    if (token.state === 'skipped') return emptyResult('malformed_response');
    let keyb = '';
    let next = '';
    let requestTrCont = '';
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
      const cursorKey = `${next}:${keyb}:${requestTrCont}`;
      if (visited.has(cursorKey)) {
        stopReason = 'cursor_not_advanced';
        break;
      }
      visited.add(cursorKey);
      const remainingMs = limits.maxDurationMs - (Date.now() - startedAt);
      const boundedSignal = createBoundedAbortSignal(input.signal, remainingMs);
      let fetched: KisLowLevelCallWithMetadataResult<unknown>;
      try {
        fetched =
          await this.quoteClient.getMarketDataWithMetadataByExplicitPath<unknown>(
            {
              path: KIS_US_MINUTE_PATH,
              query: {
                AUTH: '',
                EXCD: input.asset.marketCode,
                SYMB: input.asset.symbol,
                NMIN: '5',
                PINC: next ? '1' : '0',
                NEXT: next,
                NREC: '120',
                FILL: '',
                KEYB: keyb,
              },
              headers: {
                authorization: `Bearer ${token.response.accessToken}`,
                tr_id: KIS_US_MINUTE_TR_ID,
                custtype: config.wsCustType,
                ...(requestTrCont ? { tr_cont: requestTrCont } : {}),
              },
              signal: boundedSignal.signal,
            },
          );
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
        const timestamp = usTimestamp(record);
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
      const responseTrCont = fetched.trCont?.toUpperCase();
      const hasContinuation = responseTrCont === 'M' || responseTrCont === 'F';
      if (!hasContinuation) {
        stopReason = 'provider_exhausted';
        break;
      }
      const nextKeyb = formatZonedCursor(
        new Date(pageOldest.getTime() - FIVE_MINUTES_MS),
        TIME_ZONE,
      ).compact;
      if (nextKeyb === keyb) {
        stopReason = 'cursor_not_advanced';
        break;
      }
      keyb = nextKeyb;
      next = '1';
      requestTrCont = 'N';
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

function usTimestamp(row: Record<string, unknown>): Date | null {
  const date = firstString(row, ['xymd', 'date', 'stck_bsop_date']);
  const time = firstString(row, ['xhms', 'time', 'stck_cntg_hour']);
  return date && time ? zonedDateTimeToUtc(date, time, TIME_ZONE) : null;
}

function firstString(
  value: Record<string, unknown>,
  fields: readonly string[],
): string | null {
  for (const field of fields) {
    const candidate = value[field];
    if (typeof candidate === 'string' && candidate.trim())
      return candidate.trim();
  }
  return null;
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
