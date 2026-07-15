import { Injectable } from '@nestjs/common';
import { KisAuthClient } from '../kis-auth.client';
import { KisQuoteClient } from '../kis-quote.client';
import type { KisLowLevelCallWithMetadataResult } from '../kis.types';
import { ProviderConfigService } from '../../provider-config.service';
import { KisCandleInputError, type KisRawCandleRow } from './kis-candle.types';
import {
  KIS_DOMESTIC_PERIOD_ADJUSTED_PRICE_FLAG,
  KIS_DOMESTIC_PERIOD_DIV_CODE,
  KIS_DOMESTIC_PERIOD_PATH,
  KIS_DOMESTIC_PERIOD_TR_ID,
  type KisPeriodPageInput,
  type KisPeriodPageResult,
} from './kis-period-candle.types';
import {
  awaitWithinBudget,
  createBoundedAbortSignal,
  validateCandleAsset,
} from './kis-candle-time';

const DEFAULT_PAGE_TIMEOUT_MS = 15_000;

/**
 * Single-page adapter for KIS 국내주식기간별시세 (FHKST03010100).
 *
 * One call fetches at most 100 daily/weekly rows, newest first, inside
 * [fromDate, endDate]. Multi-page iteration (moving endDate backwards) is
 * owned by the sync orchestrator so the checkpoint cursor can advance only
 * after each page's candles are persisted.
 */
@Injectable()
export class KisDomesticPeriodAdapter {
  constructor(
    private readonly authClient: KisAuthClient,
    private readonly quoteClient: KisQuoteClient,
    private readonly configService: ProviderConfigService,
  ) {}

  async fetchPeriodPage(
    input: KisPeriodPageInput,
  ): Promise<KisPeriodPageResult> {
    validatePeriodPageInput(input);
    const timeoutMs = input.timeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS;
    if (input.signal?.aborted) return emptyPage('canceled');
    const config = this.configService.getKisConfig();
    const startedAt = Date.now();
    const tokenWait = await awaitWithinBudget(
      this.authClient.requestConfiguredRestToken(),
      input.signal,
      timeoutMs,
    );
    if (tokenWait.state !== 'resolved') return emptyPage(tokenWait.state);
    const token = tokenWait.value;
    if (token.state === 'skipped') return emptyPage('malformed_response');

    const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
    const boundedSignal = createBoundedAbortSignal(input.signal, remainingMs);
    let fetched: KisLowLevelCallWithMetadataResult<unknown>;
    try {
      fetched =
        await this.quoteClient.getMarketDataWithMetadataByExplicitPath<unknown>(
          {
            path: KIS_DOMESTIC_PERIOD_PATH,
            query: {
              FID_COND_MRKT_DIV_CODE: input.asset.marketCode,
              FID_INPUT_ISCD: input.asset.symbol,
              FID_INPUT_DATE_1: input.fromDate,
              FID_INPUT_DATE_2: input.endDate,
              FID_PERIOD_DIV_CODE: KIS_DOMESTIC_PERIOD_DIV_CODE[input.interval],
              FID_ORG_ADJ_PRC: KIS_DOMESTIC_PERIOD_ADJUSTED_PRICE_FLAG,
            },
            headers: {
              authorization: `Bearer ${token.response.accessToken}`,
              tr_id: KIS_DOMESTIC_PERIOD_TR_ID,
              custtype: config.wsCustType,
            },
            signal: boundedSignal.signal,
          },
        );
    } catch (error) {
      if (input.signal?.aborted) return emptyPage('canceled');
      if (boundedSignal.deadlineSignal.aborted)
        return emptyPage('max_duration');
      throw error;
    } finally {
      boundedSignal.clear();
    }
    if (fetched.state === 'skipped') return emptyPage('malformed_response');
    const page = extractOutputRows(fetched.response);
    if (!page) return emptyPage('malformed_response');

    const rows: KisRawCandleRow[] = [];
    let blankRows = 0;
    let oldestDate: string | null = null;
    let latestDate: string | null = null;
    for (const value of page) {
      const record = isRecord(value) ? value : null;
      const date = record ? readDateText(record.stck_bsop_date) : null;
      if (!record || !date) {
        // FHKST03010100 pads short result sets with rows whose fields are all
        // empty strings; those are padding, not malformed data.
        if (!record || isBlankRecord(record)) {
          blankRows += 1;
        } else {
          rows.push({
            value: record,
            receivedAt: fetched.receivedAt,
            sequence: rows.length,
          });
        }
        continue;
      }
      oldestDate = earlierDateText(oldestDate, date);
      latestDate = laterDateText(latestDate, date);
      rows.push({
        value: record,
        receivedAt: fetched.receivedAt,
        sequence: rows.length,
      });
    }

    return {
      state: 'ok',
      rows,
      providerReturnedRows: page.length,
      blankRows,
      oldestDate,
      latestDate,
      trCont: fetched.trCont ?? null,
    };
  }
}

export function validatePeriodPageInput(input: KisPeriodPageInput): void {
  validateCandleAsset(input.asset);
  if (input.interval !== '1d' && input.interval !== '1w') {
    throw new KisCandleInputError('interval must be 1d or 1w.');
  }
  for (const [field, value] of [
    ['fromDate', input.fromDate],
    ['endDate', input.endDate],
  ] as const) {
    if (typeof value !== 'string' || !/^\d{8}$/u.test(value)) {
      throw new KisCandleInputError(`${field} must be YYYYMMDD text.`);
    }
  }
  if (input.fromDate > input.endDate) {
    throw new KisCandleInputError('fromDate must not be after endDate.');
  }
}

export function earlierDateText(
  current: string | null,
  candidate: string,
): string {
  return current === null || candidate < current ? candidate : current;
}

export function laterDateText(
  current: string | null,
  candidate: string,
): string {
  return current === null || candidate > current ? candidate : current;
}

function readDateText(value: unknown): string | null {
  return typeof value === 'string' && /^\d{8}$/u.test(value.trim())
    ? value.trim()
    : null;
}

function isBlankRecord(record: Record<string, unknown>): boolean {
  return Object.values(record).every(
    (value) =>
      value === null ||
      value === undefined ||
      (typeof value === 'string' && value.trim() === ''),
  );
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

function emptyPage(state: KisPeriodPageResult['state']): KisPeriodPageResult {
  return {
    state,
    rows: [],
    providerReturnedRows: 0,
    blankRows: 0,
    oldestDate: null,
    latestDate: null,
    trCont: null,
  };
}
