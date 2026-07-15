import { Injectable } from '@nestjs/common';
import { KisAuthClient } from '../kis-auth.client';
import { KisQuoteClient } from '../kis-quote.client';
import type { KisLowLevelCallWithMetadataResult } from '../kis.types';
import { ProviderConfigService } from '../../provider-config.service';
import type { KisRawCandleRow } from './kis-candle.types';
import {
  KIS_OVERSEAS_PERIOD_ADJUSTED_PRICE_FLAG,
  KIS_OVERSEAS_PERIOD_GUBN,
  KIS_OVERSEAS_PERIOD_PATH,
  KIS_OVERSEAS_PERIOD_TR_ID,
  type KisPeriodPageInput,
  type KisPeriodPageResult,
} from './kis-period-candle.types';
import {
  earlierDateText,
  laterDateText,
  validatePeriodPageInput,
} from './kis-domestic-period.adapter';
import { awaitWithinBudget, createBoundedAbortSignal } from './kis-candle-time';

const DEFAULT_PAGE_TIMEOUT_MS = 15_000;

/**
 * Single-page adapter for KIS 해외주식 기간별시세 (HHDFS76240000).
 *
 * One call returns at most 100 daily (GUBN=0) or weekly (GUBN=1) rows,
 * newest first, walking backwards from BYMD (endDate). The next page is a
 * fresh idempotent request whose BYMD is the day before this page's oldest
 * row; the response `tr_cont` continuation header is preserved as metadata
 * but the date cursor is what guarantees forward progress into the past.
 * Multi-page iteration is owned by the sync orchestrator.
 */
@Injectable()
export class KisOverseasPeriodAdapter {
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
            path: KIS_OVERSEAS_PERIOD_PATH,
            query: {
              AUTH: '',
              EXCD: input.asset.marketCode,
              SYMB: input.asset.symbol,
              GUBN: KIS_OVERSEAS_PERIOD_GUBN[input.interval],
              BYMD: input.endDate,
              MODP: KIS_OVERSEAS_PERIOD_ADJUSTED_PRICE_FLAG,
              KEYB: '',
            },
            headers: {
              authorization: `Bearer ${token.response.accessToken}`,
              tr_id: KIS_OVERSEAS_PERIOD_TR_ID,
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
      const date = record ? readDateText(record.xymd) : null;
      if (!record || !date) {
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
