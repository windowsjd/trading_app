import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  AssetType,
  CurrencyCode,
  Prisma,
  SeasonStatus,
} from '../generated/prisma/client';
import { BinancePublicClient } from '../providers/binance/binance-public.client';
import type { BinanceKlinesResponse } from '../providers/binance/binance.types';
import { KisAuthClient } from '../providers/kis/kis-auth.client';
import { KisQuoteClient } from '../providers/kis/kis-quote.client';
import { normalizeKisUsMarketCode } from '../providers/kis/kis-websocket.subscription';
import {
  ProviderConfigError,
  ProviderHttpError,
} from '../providers/provider.types';
import { PrismaService } from '../prisma/prisma.service';
import { CandleServingService } from './candle-serving.service';
import { CandleResponseBuilder } from './candle-response.builder';

export type AssetCandlesQuery = {
  range?: string;
  interval?: string;
  limit?: string;
  date?: string;
  to?: string;
  includePrevious?: string;
};

// 'prev_open'  = previous regular market open → now (weekends skipped for stocks)
// 'prev2_open' = two market days back, regular open → now
// '1y'         = rolling 365 days → now
// Exported (type-only) so the candle response cache can key on and store the
// exact HTTP response shape without duplicating these definitions. This does
// not change the response shape or the provider call flow.
export type CandleRange =
  | '1d'
  | '7d'
  | '30d'
  | 'prev_open'
  | 'prev2_open'
  | '1y'
  | 'season';
export type CandleInterval =
  | '1m'
  | '5m'
  | '15m'
  | '30m'
  | '1h'
  | '4h'
  | '1d'
  | '1w';
type CryptoCandleInterval = CandleInterval;
type KisDomesticPeriodDivCode = 'D' | 'W';

export type AssetCandlesAsset = {
  id: string;
  symbol: string;
  name: string;
  market: string;
  assetType: AssetType;
  currencyCode: CurrencyCode;
  priceCurrency: CurrencyCode;
  settlementCurrency: CurrencyCode;
  isActive: boolean;
};
type AssetRecord = AssetCandlesAsset;

export type ParsedAssetCandlesQuery = {
  range: CandleRange;
  rangeProvided: boolean;
  rangeStartAt: Date | null;
  rangeEndAt: Date | null;
  interval: CandleInterval;
  intervalMinutes: number;
  limit: number;
  requestedDate: string;
  toHHmmss: string;
  toInstant: Date | null;
  dateProvided: boolean;
  toProvided: boolean;
  includePrevious: boolean;
  explicitDate: boolean;
  explicitTo: boolean;
  clock: Date;
};

export type CandlePayload = {
  time: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  amount: string;
  sourceDate: string;
  sourceTime: string;
};

type NormalizedCandle = {
  time: Date;
  open: Prisma.Decimal;
  high: Prisma.Decimal;
  low: Prisma.Decimal;
  close: Prisma.Decimal;
  volume: Prisma.Decimal;
  amount: Prisma.Decimal;
  sourceDate: string;
  sourceTime: string;
};

type KisCandleResponse = {
  rt_cd?: unknown;
  output?: unknown;
  output1?: unknown;
  output2?: unknown;
  [key: string]: unknown;
};

type KisCallDescriptor = {
  path: string;
  trId: string;
  query: Record<string, string>;
  marketCode: string;
  requestedCount: number;
};

type BinanceCallDescriptor = {
  endpoint: typeof BINANCE_KLINE_PATH;
  symbol: string;
  interval: CryptoCandleInterval;
  requestedCount: number;
};

export type AssetCandlesResponse = {
  success: true;
  data: {
    state: 'available' | 'empty';
    asset: {
      id: string;
      symbol: string;
      name: string;
      assetType: AssetType;
      market: string;
      priceCurrency: CurrencyCode;
    };
    range: CandleRange;
    interval: CandleInterval;
    requestedDate: string;
    candles: CandlePayload[];
    source:
      | {
          provider: 'kis';
          trId: string;
          path: string;
          marketCode: string;
          requestedCount: number;
          returnedCount: number;
        }
      | {
          provider: 'binance';
          endpoint: typeof BINANCE_KLINE_PATH;
          symbol: string;
          interval: CryptoCandleInterval;
          requestedCount: number;
          returnedCount: number;
          // Present (true) only when the requested window needs more rows than
          // the effective single-call request can return, i.e. older candles
          // were cut off and the latest candles were preserved.
          truncated?: boolean;
        };
  };
};

// Provider-specific per-request row caps. Our request `limit` is clamped to
// MAX_LIMIT up front, then clamped again per provider when the call is built,
// so a large user limit can never exceed what a provider accepts.
//   - Binance spot klines (/api/v3/klines): hard cap 1000 rows per call.
//   - KIS 국내 주식당일분봉조회 (FHKST03010200): max 30 rows, current day only.
//   - KIS 국내 주식일별분봉조회 (FHKST03010230): max 120 rows/call, ~1yr retention.
//   - KIS 국내 주식기간별시세 (FHKST03010100): max 100 rows/call, no tr_cont.
//   - KIS 해외주식분봉조회 (HHDFS76950200): NREC max 120; NEXT/KEYB/tr_cont
//     continuation exists but is not implemented here yet.
// TODO(chart-range): KIS coverage beyond one page requires multi-call:
//   - domestic: page the daily-minute endpoint backwards via FID_INPUT_DATE_1/
//     FID_INPUT_HOUR_1 anchors (dedupe on sourceDate+sourceTime, bound pages,
//     mind KIS TPS limits).
//   - overseas: NEXT/KEYB/tr_cont continuation loop with a maxPages bound.
const BINANCE_KLINE_MAX_LIMIT = 1000;
const KIS_DOMESTIC_TODAY_MAX_COUNT = 30;
const KIS_DOMESTIC_DAILY_MINUTE_MAX_COUNT = 120;
const KIS_DOMESTIC_PERIOD_MAX_COUNT = 100;
const KIS_DOMESTIC_DAILY_PERIOD_MAX_PAGES = 5;
const KIS_DOMESTIC_WEEKLY_PERIOD_MAX_PAGES = 3;
const KIS_OVERSEAS_MINUTE_MAX_COUNT = 120;
const DEFAULT_LIMIT = 100;
// Request-level cap; per-provider caps above clamp lower where needed.
const MAX_LIMIT = BINANCE_KLINE_MAX_LIMIT;
const DEFAULT_RANGE: CandleRange = '1d';
const KOREA_TIME_ZONE = 'Asia/Seoul';
const US_EASTERN_TIME_ZONE = 'America/New_York';
const UTC_TIME_ZONE = 'UTC';
const BINANCE_KLINE_PATH = '/api/v3/klines';
const CANDLE_INTERVAL_ERROR_MESSAGE =
  'interval must be one of 1m, 5m, 15m, 30m, 1h, 4h, 1d, or 1w.';

const DEFAULT_INTERVAL_BY_RANGE: Record<CandleRange, CandleInterval> = {
  '1d': '5m',
  '7d': '1h',
  '30d': '1d',
  prev_open: '5m',
  prev2_open: '30m',
  '1y': '1d',
  season: '1d',
};

const CANDLE_INTERVAL_MINUTES: Record<CandleInterval, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '4h': 240,
  '1d': 1440,
  '1w': 10080,
};

const CANDLE_INTERVALS: Record<CandleInterval, true> = {
  '1m': true,
  '5m': true,
  '15m': true,
  '30m': true,
  '1h': true,
  '4h': true,
  '1d': true,
  '1w': true,
};

const CANDLE_RANGES: Record<CandleRange, true> = {
  '1d': true,
  '7d': true,
  '30d': true,
  prev_open: true,
  prev2_open: true,
  '1y': true,
  season: true,
};

const RANGE_INTERVALS: Record<
  CandleRange,
  Readonly<Record<CandleInterval, true>>
> = {
  '1d': CANDLE_INTERVALS,
  '7d': CANDLE_INTERVALS,
  '30d': CANDLE_INTERVALS,
  prev_open: CANDLE_INTERVALS,
  prev2_open: CANDLE_INTERVALS,
  '1y': CANDLE_INTERVALS,
  season: CANDLE_INTERVALS,
};

const DOMESTIC_TODAY_CANDLE_PATH =
  '/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice';
const DOMESTIC_DAILY_CANDLE_PATH =
  '/uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice';
const DOMESTIC_PERIOD_CANDLE_PATH =
  '/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice';
const OVERSEAS_CANDLE_PATH =
  '/uapi/overseas-price/v1/quotations/inquire-time-itemchartprice';

const DOMESTIC_TODAY_CANDLE_TR_ID = 'FHKST03010200';
const DOMESTIC_DAILY_CANDLE_TR_ID = 'FHKST03010230';
const DOMESTIC_PERIOD_CANDLE_TR_ID = 'FHKST03010100';
const OVERSEAS_CANDLE_TR_ID = 'HHDFS76950200';

const DATE_FIELD_ALIASES = [
  'stck_bsop_date',
  'xymd',
  'tymd',
  'kymd',
  'date',
  'tradingDate',
];
const TIME_FIELD_ALIASES = [
  'stck_cntg_hour',
  'xhms',
  'thms',
  'khms',
  'time',
  'tradingTime',
];
const OPEN_FIELD_ALIASES = ['stck_oprc', 'open', 'oprc'];
const HIGH_FIELD_ALIASES = ['stck_hgpr', 'high', 'hgpr'];
const LOW_FIELD_ALIASES = ['stck_lwpr', 'low', 'lwpr'];
const CLOSE_FIELD_ALIASES = ['stck_prpr', 'stck_clpr', 'last', 'close', 'clos'];
const VOLUME_FIELD_ALIASES = ['cntg_vol', 'acml_vol', 'evol', 'volume', 'tvol'];
const AMOUNT_FIELD_ALIASES = [
  'tr_pbmn',
  'acml_tr_pbmn',
  'eamt',
  'amount',
  'turnover',
];

@Injectable()
export class AssetCandlesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kisAuthClient: KisAuthClient,
    private readonly kisQuoteClient: KisQuoteClient,
    private readonly binancePublicClient: BinancePublicClient,
    private readonly serving: CandleServingService,
    private readonly responses: CandleResponseBuilder,
  ) {}

  async getAssetCandles(
    userId: string | undefined,
    assetId: string | undefined,
    query: AssetCandlesQuery = {},
  ): Promise<AssetCandlesResponse> {
    if (!userId) {
      this.throwApiError(
        HttpStatus.UNAUTHORIZED,
        'UNAUTHORIZED',
        'Unauthorized',
      );
    }

    const parsedAssetId = this.parseAssetId(assetId);
    const asset = await this.prisma.asset.findUnique({
      where: {
        id: parsedAssetId,
      },
      select: this.assetSelect(),
    });

    if (!asset) {
      this.throwApiError(
        HttpStatus.NOT_FOUND,
        'ASSET_NOT_FOUND',
        'Asset not found.',
      );
    }

    const clock = new Date();
    const parsedQuery = await this.parseQuery(query, asset, clock);

    try {
      return await this.serving.serve(asset, parsedQuery, () =>
        this.loadLegacy(asset, parsedQuery),
      );
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      if (
        error instanceof ProviderConfigError ||
        error instanceof ProviderHttpError
      ) {
        if (error.provider === 'binance') {
          this.throwApiError(
            HttpStatus.BAD_GATEWAY,
            'ASSET_CANDLES_PROVIDER_ERROR',
            'Binance candle provider is unavailable.',
          );
        }

        this.throwApiError(
          HttpStatus.SERVICE_UNAVAILABLE,
          'ASSET_CANDLES_PROVIDER_UNAVAILABLE',
          'KIS candle provider is unavailable.',
        );
      }

      throw error;
    }
  }

  private async loadLegacy(
    asset: AssetCandlesAsset,
    query: ParsedAssetCandlesQuery,
  ): Promise<AssetCandlesResponse> {
    if (asset.assetType === AssetType.domestic_stock) {
      return this.getDomesticStockCandles(asset, query);
    }
    if (asset.assetType === AssetType.us_stock) {
      return this.getUsStockCandles(asset, query);
    }
    if (asset.assetType === AssetType.crypto) {
      return this.getCryptoCandles(asset, query);
    }
    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'ASSET_CANDLES_UNSUPPORTED_ASSET_TYPE',
      'Asset type is unsupported for candles.',
    );
  }

  private async getDomesticStockCandles(
    asset: AssetCandlesAsset,
    query: ParsedAssetCandlesQuery,
  ): Promise<AssetCandlesResponse> {
    const marketCode = this.resolveDomesticKisMarketCode(asset);

    if (query.interval === '1d' || query.interval === '1w') {
      return this.getDomesticStockPeriodCandles(asset, query, marketCode);
    }

    // Same-day-only ranges may use the today endpoint (30 rows). Multi-day
    // ranges (prev_open/prev2_open/7d/…) need the daily-minute endpoint, which
    // returns up to 120 rows and can cross into prior days.
    const usesTodayEndpoint =
      query.range === '1d' &&
      query.intervalMinutes < CANDLE_INTERVAL_MINUTES['1d'] &&
      query.requestedDate === this.dateInZone(query.clock, KOREA_TIME_ZONE);
    const descriptor = usesTodayEndpoint
      ? this.buildDomesticTodayCall(asset, query, marketCode)
      : this.buildDomesticDailyCall(asset, query, marketCode);
    const response = await this.callKisCandles(descriptor);
    const rows = this.extractRows(response);
    const normalized = this.normalizeRows(rows, {
      fallbackDate: query.requestedDate,
      timeZone: KOREA_TIME_ZONE,
    });
    const rangeFiltered = this.filterCandlesToRange(normalized, query);
    const bucketed = this.bucketStockCandles(
      rangeFiltered,
      query.intervalMinutes,
      KOREA_TIME_ZONE,
    );
    const candles = this.sliceRecent(
      this.filterCandlesToRange(bucketed, query),
      query.limit,
    ).map((candle) => this.formatCandle(candle));

    return this.buildResponse(asset, query, descriptor, candles);
  }

  private async getDomesticStockPeriodCandles(
    asset: AssetRecord,
    query: ParsedAssetCandlesQuery,
    marketCode: string,
  ): Promise<AssetCandlesResponse> {
    const periodCode: KisDomesticPeriodDivCode =
      query.interval === '1w' ? 'W' : 'D';
    const maxPages =
      periodCode === 'D'
        ? KIS_DOMESTIC_DAILY_PERIOD_MAX_PAGES
        : KIS_DOMESTIC_WEEKLY_PERIOD_MAX_PAGES;
    const requestedCount = Math.min(
      query.limit,
      KIS_DOMESTIC_PERIOD_MAX_COUNT * maxPages,
    );
    const dateRange = this.resolveDomesticPeriodDateRange(query);
    const sourceDescriptor = this.buildDomesticPeriodCall({
      asset,
      marketCode,
      periodCode,
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      requestedCount,
    });
    const candlesBySourceDate = new Map<string, NormalizedCandle>();
    let cursorEndDate = dateRange.endDate;

    for (
      let page = 0;
      page < maxPages && candlesBySourceDate.size < requestedCount;
      page += 1
    ) {
      if (cursorEndDate < dateRange.startDate) {
        break;
      }

      const descriptor = this.buildDomesticPeriodCall({
        asset,
        marketCode,
        periodCode,
        startDate: dateRange.startDate,
        endDate: cursorEndDate,
        requestedCount,
      });
      const response = await this.callKisCandles(descriptor);
      const rows = this.extractRows(response);

      if (rows.length === 0) {
        break;
      }

      const normalized = this.normalizeDomesticPeriodRows(rows);
      let oldestSourceDate: string | null = null;

      for (const candle of normalized) {
        if (
          candle.sourceDate < dateRange.startDate ||
          candle.sourceDate > dateRange.endDate
        ) {
          continue;
        }

        if (!candlesBySourceDate.has(candle.sourceDate)) {
          candlesBySourceDate.set(candle.sourceDate, candle);
        }

        if (!oldestSourceDate || candle.sourceDate < oldestSourceDate) {
          oldestSourceDate = candle.sourceDate;
        }
      }

      if (
        rows.length < KIS_DOMESTIC_PERIOD_MAX_COUNT ||
        !oldestSourceDate ||
        oldestSourceDate <= dateRange.startDate
      ) {
        break;
      }

      cursorEndDate = this.previousCompactDate(oldestSourceDate);
    }

    const candles = this.sliceRecent(
      this.filterCandlesToRange([...candlesBySourceDate.values()], query),
      requestedCount,
    ).map((candle) => this.formatCandle(candle));

    return this.buildResponse(asset, query, sourceDescriptor, candles);
  }

  private async getUsStockCandles(
    asset: AssetRecord,
    query: ParsedAssetCandlesQuery,
  ): Promise<AssetCandlesResponse> {
    const marketCode = this.resolveUsKisMarketCode(asset);
    const descriptor = this.buildOverseasCall(asset, query, marketCode);
    const response = await this.callKisCandles(descriptor);
    const rows = this.extractRows(response);
    const normalized = this.normalizeRows(rows, {
      fallbackDate: query.requestedDate,
      timeZone: US_EASTERN_TIME_ZONE,
    });
    const rangeFiltered = this.filterCandlesToRange(normalized, query);
    const bucketed = this.bucketStockCandles(
      rangeFiltered,
      query.intervalMinutes,
      US_EASTERN_TIME_ZONE,
    );
    const candles = this.sliceRecent(
      this.filterCandlesToRange(bucketed, query),
      query.limit,
    ).map((candle) => this.formatCandle(candle));

    return this.buildResponse(asset, query, descriptor, candles);
  }

  private async getCryptoCandles(
    asset: AssetRecord,
    query: ParsedAssetCandlesQuery,
  ): Promise<AssetCandlesResponse> {
    const interval = this.requireCryptoInterval(query.interval);
    const symbol = this.normalizeCryptoSymbol(asset);
    const timeRange = this.buildCryptoTimeRange(query);
    const requestLimit = Math.min(query.limit, BINANCE_KLINE_MAX_LIMIT);
    const intervalMs = CANDLE_INTERVAL_MINUTES[interval] * 60_000;
    // With a known window we can tell whether one klines call covers it.
    const expectedCount =
      timeRange.startTime !== undefined && timeRange.endTime !== undefined
        ? Math.ceil((timeRange.endTime - timeRange.startTime) / intervalMs)
        : null;
    const truncated = expectedCount !== null && expectedCount > requestLimit;
    const providerTimeRange =
      truncated && timeRange.endTime !== undefined
        ? {
            startTime: Math.max(
              0,
              timeRange.endTime - requestLimit * intervalMs,
            ),
            endTime: timeRange.endTime,
          }
        : timeRange;
    const descriptor: BinanceCallDescriptor = {
      endpoint: BINANCE_KLINE_PATH,
      symbol,
      interval,
      requestedCount: requestLimit,
    };
    const result = await this.binancePublicClient.fetchKlines({
      symbol,
      interval,
      limit: requestLimit,
      ...providerTimeRange,
    });
    const candles = this.sliceRecent(
      this.filterCandlesToRange(
        this.normalizeBinanceKlines(result.response),
        query,
      ),
      requestLimit,
    ).map((candle) => this.formatCandle(candle));

    return this.buildCryptoResponse(
      asset,
      query,
      descriptor,
      candles,
      truncated,
    );
  }

  private buildDomesticTodayCall(
    asset: AssetRecord,
    query: ParsedAssetCandlesQuery,
    marketCode: string,
  ): KisCallDescriptor {
    const symbol = this.normalizeDomesticSymbol(asset.symbol);

    return {
      path: DOMESTIC_TODAY_CANDLE_PATH,
      trId: DOMESTIC_TODAY_CANDLE_TR_ID,
      marketCode,
      requestedCount: Math.min(query.limit, KIS_DOMESTIC_TODAY_MAX_COUNT),
      query: {
        FID_COND_MRKT_DIV_CODE: marketCode,
        FID_INPUT_ISCD: symbol,
        FID_INPUT_HOUR_1: query.toHHmmss,
        FID_ETC_CLS_CODE: '',
        FID_PW_DATA_INCU_YN: 'N',
      },
    };
  }

  private buildDomesticPeriodCall(input: {
    asset: AssetRecord;
    marketCode: string;
    periodCode: KisDomesticPeriodDivCode;
    startDate: string;
    endDate: string;
    requestedCount: number;
  }): KisCallDescriptor {
    const symbol = this.normalizeDomesticSymbol(input.asset.symbol);

    return {
      path: DOMESTIC_PERIOD_CANDLE_PATH,
      trId: DOMESTIC_PERIOD_CANDLE_TR_ID,
      marketCode: input.marketCode,
      requestedCount: input.requestedCount,
      query: {
        FID_COND_MRKT_DIV_CODE: input.marketCode,
        FID_INPUT_ISCD: symbol,
        FID_INPUT_DATE_1: input.startDate,
        FID_INPUT_DATE_2: input.endDate,
        FID_PERIOD_DIV_CODE: input.periodCode,
        FID_ORG_ADJ_PRC: '0',
      },
    };
  }

  private buildDomesticDailyCall(
    asset: AssetRecord,
    query: ParsedAssetCandlesQuery,
    marketCode: string,
  ): KisCallDescriptor {
    const symbol = this.normalizeDomesticSymbol(asset.symbol);

    return {
      path: DOMESTIC_DAILY_CANDLE_PATH,
      trId: DOMESTIC_DAILY_CANDLE_TR_ID,
      marketCode,
      // KIS returns at most 120 rows per call regardless of how many we want.
      requestedCount: Math.min(
        query.limit,
        KIS_DOMESTIC_DAILY_MINUTE_MAX_COUNT,
      ),
      query: {
        FID_COND_MRKT_DIV_CODE: marketCode,
        FID_INPUT_ISCD: symbol,
        FID_INPUT_DATE_1: this.compactDate(query.requestedDate),
        FID_INPUT_HOUR_1: query.toHHmmss,
        // 'Y' lets the 120 returned rows continue backwards into prior trading
        // days, which multi-day ranges (prev_open/prev2_open/7d/…) need.
        FID_PW_DATA_INCU_YN: query.includePrevious ? 'Y' : 'N',
        FID_FAKE_TICK_INCU_YN: 'N',
      },
    };
  }

  private buildOverseasCall(
    asset: AssetRecord,
    query: ParsedAssetCandlesQuery,
    marketCode: string,
  ): KisCallDescriptor {
    // Single-page call: NREC caps at 120. Fetching more requires the
    // NEXT/KEYB/tr_cont continuation loop — see TODO(chart-range) above.
    const requestedCount = Math.min(query.limit, KIS_OVERSEAS_MINUTE_MAX_COUNT);

    return {
      path: OVERSEAS_CANDLE_PATH,
      trId: OVERSEAS_CANDLE_TR_ID,
      marketCode,
      requestedCount,
      query: {
        AUTH: '',
        EXCD: marketCode,
        SYMB: this.normalizeUsSymbol(asset.symbol),
        NMIN: String(this.resolveKisSourceIntervalMinutes(query)),
        PINC: query.includePrevious ? '1' : '0',
        NEXT: '',
        NREC: String(requestedCount),
        FILL: 'Y',
        KEYB: '',
      },
    };
  }

  private async callKisCandles(
    descriptor: KisCallDescriptor,
  ): Promise<KisCandleResponse> {
    const authorization = await this.getKisAuthorizationHeader();
    const result =
      await this.kisQuoteClient.getMarketDataByExplicitPath<KisCandleResponse>({
        path: descriptor.path,
        query: descriptor.query,
        headers: {
          authorization,
          tr_id: descriptor.trId,
          custtype: 'P',
        },
      });

    if (result.state === 'skipped') {
      this.throwApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'ASSET_CANDLES_PROVIDER_UNAVAILABLE',
        'KIS candle provider is unavailable.',
      );
    }

    this.assertKisSuccess(result.response);
    return result.response;
  }

  private async getKisAuthorizationHeader(): Promise<string> {
    const cached = this.kisAuthClient.getCachedToken();
    if (cached && !this.isTokenExpired(cached.expiresAt)) {
      return this.formatAuthorization(cached.tokenType, cached.accessToken);
    }

    const token = await this.kisAuthClient.requestConfiguredRestToken();
    if (token.state === 'skipped') {
      this.throwApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'ASSET_CANDLES_PROVIDER_UNAVAILABLE',
        'KIS candle provider is unavailable.',
      );
    }

    return this.formatAuthorization(
      token.response.tokenType,
      token.response.accessToken,
    );
  }

  private assertKisSuccess(response: KisCandleResponse): void {
    const rtCd = this.readOptionalString(response.rt_cd);
    if (rtCd && rtCd !== '0') {
      this.throwApiError(
        HttpStatus.BAD_GATEWAY,
        'ASSET_CANDLES_PROVIDER_ERROR',
        'KIS returned an error for candle data.',
      );
    }
  }

  private extractRows(response: KisCandleResponse): Record<string, unknown>[] {
    for (const candidate of [
      response.output2,
      response.output1,
      response.output,
    ]) {
      if (Array.isArray(candidate)) {
        return candidate.filter((value): value is Record<string, unknown> =>
          this.isRecord(value),
        );
      }
    }

    return [];
  }

  private normalizeRows(
    rows: readonly Record<string, unknown>[],
    input: {
      fallbackDate: string;
      timeZone: string;
    },
  ): NormalizedCandle[] {
    const fallbackSourceDate = this.compactDate(input.fallbackDate);
    const candles: NormalizedCandle[] = [];

    for (const row of rows) {
      const sourceDate = this.normalizeSourceDate(
        this.readFirstString(row, DATE_FIELD_ALIASES),
        fallbackSourceDate,
      );
      const sourceTime = this.normalizeSourceTime(
        this.readFirstString(row, TIME_FIELD_ALIASES),
      );
      const close = this.parseDecimal(
        this.readFirstString(row, CLOSE_FIELD_ALIASES),
      );

      if (!sourceDate || !sourceTime || !close || close.lte(0)) {
        continue;
      }

      const open =
        this.parseDecimal(this.readFirstString(row, OPEN_FIELD_ALIASES)) ??
        close;
      const high =
        this.parseDecimal(this.readFirstString(row, HIGH_FIELD_ALIASES)) ??
        close;
      const low =
        this.parseDecimal(this.readFirstString(row, LOW_FIELD_ALIASES)) ??
        close;
      const volume =
        this.parseDecimal(this.readFirstString(row, VOLUME_FIELD_ALIASES)) ??
        new Prisma.Decimal(0);
      const amount =
        this.parseDecimal(this.readFirstString(row, AMOUNT_FIELD_ALIASES)) ??
        close.mul(volume);

      if (
        open.lte(0) ||
        high.lte(0) ||
        low.lte(0) ||
        volume.lt(0) ||
        amount.lt(0)
      ) {
        continue;
      }

      candles.push({
        time: this.zonedDateTimeToUtc(sourceDate, sourceTime, input.timeZone),
        open,
        high,
        low,
        close,
        volume,
        amount,
        sourceDate,
        sourceTime,
      });
    }

    return this.sortCandles(candles);
  }

  private normalizeDomesticPeriodRows(
    rows: readonly Record<string, unknown>[],
  ): NormalizedCandle[] {
    const candles: NormalizedCandle[] = [];

    for (const row of rows) {
      const sourceDate = this.normalizeSourceDate(
        this.readOptionalString(row.stck_bsop_date),
        '',
      );
      const sourceTime = '000000';
      const open = this.parseDecimal(this.readOptionalString(row.stck_oprc));
      const high = this.parseDecimal(this.readOptionalString(row.stck_hgpr));
      const low = this.parseDecimal(this.readOptionalString(row.stck_lwpr));
      const close = this.parseDecimal(this.readOptionalString(row.stck_clpr));
      const volume = this.parseDecimal(this.readOptionalString(row.acml_vol));
      const amount = this.parseDecimal(
        this.readOptionalString(row.acml_tr_pbmn),
      );

      if (
        !sourceDate ||
        !open ||
        !high ||
        !low ||
        !close ||
        !volume ||
        !amount ||
        open.lte(0) ||
        high.lte(0) ||
        low.lte(0) ||
        close.lte(0) ||
        volume.lt(0) ||
        amount.lt(0)
      ) {
        continue;
      }

      candles.push({
        time: this.zonedDateTimeToUtc(sourceDate, sourceTime, KOREA_TIME_ZONE),
        open,
        high,
        low,
        close,
        volume,
        amount,
        sourceDate,
        sourceTime,
      });
    }

    return this.sortCandles(candles);
  }

  private normalizeBinanceKlines(
    response: BinanceKlinesResponse,
  ): NormalizedCandle[] {
    if (!Array.isArray(response)) {
      this.throwMalformedBinanceResponse();
    }

    if (response.length === 0) {
      return [];
    }

    return this.sortCandles(
      response.map((row) => this.normalizeBinanceKlineRow(row)),
    );
  }

  private normalizeBinanceKlineRow(row: unknown): NormalizedCandle {
    if (!Array.isArray(row)) {
      this.throwMalformedBinanceResponse();
    }

    const openTime = this.parseBinanceOpenTime(row[0]);
    const open = this.parseDecimal(this.readOptionalString(row[1]));
    const high = this.parseDecimal(this.readOptionalString(row[2]));
    const low = this.parseDecimal(this.readOptionalString(row[3]));
    const close = this.parseDecimal(this.readOptionalString(row[4]));
    const volume = this.parseDecimal(this.readOptionalString(row[5]));
    const amount = this.parseDecimal(this.readOptionalString(row[7]));

    if (
      openTime === null ||
      open === null ||
      high === null ||
      low === null ||
      close === null ||
      volume === null ||
      amount === null ||
      open.lte(0) ||
      high.lte(0) ||
      low.lte(0) ||
      close.lte(0) ||
      volume.lt(0) ||
      amount.lt(0)
    ) {
      this.throwMalformedBinanceResponse();
    }

    const time = new Date(openTime);
    if (Number.isNaN(time.getTime())) {
      this.throwMalformedBinanceResponse();
    }

    return {
      time,
      open,
      high,
      low,
      close,
      volume,
      amount,
      sourceDate: time.toISOString().slice(0, 10),
      sourceTime: time.toISOString(),
    };
  }

  private parseBinanceOpenTime(value: unknown): number | null {
    if (typeof value === 'number') {
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    }

    if (typeof value === 'string' && /^\d+$/u.test(value.trim())) {
      const parsed = Number(value.trim());
      return Number.isSafeInteger(parsed) ? parsed : null;
    }

    return null;
  }

  private bucketStockCandles(
    candles: readonly NormalizedCandle[],
    intervalMinutes: number,
    timeZone: string,
  ): NormalizedCandle[] {
    const buckets = new Map<string, NormalizedCandle>();

    for (const candle of this.sortCandles(candles)) {
      const bucketSourceDate = this.bucketSourceDate(
        candle.sourceDate,
        intervalMinutes,
      );
      const bucketSourceTime =
        intervalMinutes >= 1440
          ? '000000'
          : this.bucketSourceTime(candle.sourceTime, intervalMinutes);
      const bucketKey = `${bucketSourceDate}-${bucketSourceTime}`;
      const existing = buckets.get(bucketKey);

      if (!existing) {
        buckets.set(bucketKey, {
          ...candle,
          sourceDate: bucketSourceDate,
          sourceTime: bucketSourceTime,
          time: this.zonedDateTimeToUtc(
            bucketSourceDate,
            bucketSourceTime,
            timeZone,
          ),
        });
        continue;
      }

      existing.high = Prisma.Decimal.max(existing.high, candle.high);
      existing.low = Prisma.Decimal.min(existing.low, candle.low);
      existing.close = candle.close;
      existing.volume = existing.volume.plus(candle.volume);
      existing.amount = existing.amount.plus(candle.amount);
    }

    return this.sortCandles([...buckets.values()]);
  }

  private bucketSourceDate(
    sourceDate: string,
    intervalMinutes: number,
  ): string {
    if (intervalMinutes < 10080) {
      return sourceDate;
    }

    const date = new Date(
      Date.UTC(
        Number(sourceDate.slice(0, 4)),
        Number(sourceDate.slice(4, 6)) - 1,
        Number(sourceDate.slice(6, 8)),
      ),
    );
    const day = date.getUTCDay();
    const daysSinceMonday = day === 0 ? 6 : day - 1;
    date.setUTCDate(date.getUTCDate() - daysSinceMonday);

    return date.toISOString().slice(0, 10).replace(/-/gu, '');
  }

  private bucketSourceTime(
    sourceTime: string,
    intervalMinutes: number,
  ): string {
    const hour = Number(sourceTime.slice(0, 2));
    const minute = Number(sourceTime.slice(2, 4));
    const totalMinutes = hour * 60 + minute;
    const bucketMinutes =
      Math.floor(totalMinutes / intervalMinutes) * intervalMinutes;

    return `${this.pad2(Math.floor(bucketMinutes / 60))}${this.pad2(
      bucketMinutes % 60,
    )}00`;
  }

  private sliceRecent(
    candles: readonly NormalizedCandle[],
    limit: number,
  ): NormalizedCandle[] {
    return this.sortCandles(candles).slice(-limit);
  }

  private filterCandlesToRange(
    candles: readonly NormalizedCandle[],
    query: ParsedAssetCandlesQuery,
  ): NormalizedCandle[] {
    if (!query.rangeStartAt || !query.rangeEndAt) {
      return this.sortCandles(candles);
    }

    const startTime = query.rangeStartAt.getTime();
    const endTime = query.rangeEndAt.getTime();

    return this.sortCandles(
      candles.filter((candle) => {
        const candleTime = candle.time.getTime();
        return candleTime >= startTime && candleTime <= endTime;
      }),
    );
  }

  private buildResponse(
    asset: AssetRecord,
    query: ParsedAssetCandlesQuery,
    descriptor: KisCallDescriptor,
    candles: CandlePayload[],
  ): AssetCandlesResponse {
    return this.responses.buildKis(asset, query, descriptor, candles);
  }

  private buildCryptoResponse(
    asset: AssetRecord,
    query: ParsedAssetCandlesQuery,
    descriptor: BinanceCallDescriptor,
    candles: CandlePayload[],
    truncated = false,
  ): AssetCandlesResponse {
    return this.responses.buildCrypto(
      asset,
      query,
      descriptor,
      candles,
      truncated,
    );
  }

  private formatCandle(candle: NormalizedCandle): CandlePayload {
    return {
      time: candle.time.toISOString(),
      open: this.formatDecimal(candle.open),
      high: this.formatDecimal(candle.high),
      low: this.formatDecimal(candle.low),
      close: this.formatDecimal(candle.close),
      volume: this.formatDecimal(candle.volume),
      amount: this.formatDecimal(candle.amount),
      sourceDate: candle.sourceDate,
      sourceTime: candle.sourceTime,
    };
  }

  private async parseQuery(
    query: AssetCandlesQuery,
    asset: AssetRecord,
    clock: Date,
  ): Promise<ParsedAssetCandlesQuery> {
    const timeZone =
      asset.assetType === AssetType.domestic_stock
        ? KOREA_TIME_ZONE
        : asset.assetType === AssetType.us_stock
          ? US_EASTERN_TIME_ZONE
          : UTC_TIME_ZONE;
    const range = this.parseRange(query.range);
    const rangeProvided = this.parseOptionalText(query.range) !== undefined;
    const legacyDateProvided = this.parseOptionalText(query.date) !== undefined;
    const legacyToProvided = this.parseOptionalText(query.to) !== undefined;
    const interval = this.parseInterval(query.interval, asset.assetType, range);
    const rangeWindow =
      rangeProvided || (!legacyDateProvided && !legacyToProvided)
        ? await this.resolveRangeWindow(range, clock, asset)
        : null;
    const parsedTo = rangeWindow
      ? {
          hhmmss: this.timeInZone(rangeWindow.endAt, timeZone),
          instant: rangeWindow.endAt,
          provided: true,
        }
      : this.parseTo(query.to, timeZone, clock);
    const requestedDate = rangeWindow
      ? this.dateInZone(rangeWindow.endAt, timeZone)
      : this.parseDate(query.date, timeZone, clock);
    const toHHmmss = parsedTo.hhmmss;

    return {
      range,
      rangeProvided,
      rangeStartAt: rangeWindow?.startAt ?? null,
      rangeEndAt: rangeWindow?.endAt ?? null,
      interval,
      intervalMinutes: CANDLE_INTERVAL_MINUTES[interval],
      limit: this.parseLimit(query.limit),
      requestedDate,
      toHHmmss,
      toInstant: parsedTo.instant,
      dateProvided: rangeWindow !== null || legacyDateProvided,
      toProvided: rangeWindow !== null || parsedTo.provided,
      includePrevious: this.parseBoolean(query.includePrevious, true),
      explicitDate: legacyDateProvided,
      explicitTo: legacyToProvided,
      clock,
    };
  }

  private parseRange(value: string | undefined): CandleRange {
    const text = this.parseOptionalText(value) ?? DEFAULT_RANGE;

    if (this.isCandleRange(text)) {
      return text;
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'ASSET_CANDLES_INVALID_RANGE',
      'range must be one of 1d, 7d, 30d, prev_open, prev2_open, 1y, or season.',
    );
  }

  private parseInterval(
    value: string | undefined,
    _assetType: AssetType,
    range: CandleRange,
  ): CandleInterval {
    void _assetType;
    const text =
      this.parseOptionalText(value) ?? DEFAULT_INTERVAL_BY_RANGE[range];

    if (this.isCandleInterval(text)) {
      this.assertRangeInterval(range, text);
      return text;
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'ASSET_CANDLES_INVALID_INTERVAL',
      CANDLE_INTERVAL_ERROR_MESSAGE,
    );
  }

  private assertRangeInterval(
    range: CandleRange,
    interval: CandleInterval,
  ): void {
    if (RANGE_INTERVALS[range][interval]) {
      return;
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'ASSET_CANDLES_INVALID_INTERVAL',
      `interval ${interval} is not supported for range ${range}.`,
    );
  }

  private parseLimit(value: string | undefined): number {
    if (value === undefined) {
      return DEFAULT_LIMIT;
    }

    const limit = this.parsePositiveInteger(value, 'INVALID_CANDLE_LIMIT');
    return Math.min(limit, MAX_LIMIT);
  }

  private resolveKisSourceIntervalMinutes(
    query: ParsedAssetCandlesQuery,
  ): number {
    return Math.min(query.intervalMinutes, 30);
  }

  private requireCryptoInterval(
    interval: CandleInterval,
  ): CryptoCandleInterval {
    if (this.isCandleInterval(interval)) {
      return interval;
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'ASSET_CANDLES_INVALID_INTERVAL',
      CANDLE_INTERVAL_ERROR_MESSAGE,
    );
  }

  private resolveDomesticPeriodDateRange(query: ParsedAssetCandlesQuery): {
    startDate: string;
    endDate: string;
  } {
    const startDate = query.rangeStartAt
      ? this.compactDate(this.dateInZone(query.rangeStartAt, KOREA_TIME_ZONE))
      : this.compactDate(query.requestedDate);
    const endDate = query.rangeEndAt
      ? this.compactDate(this.dateInZone(query.rangeEndAt, KOREA_TIME_ZONE))
      : this.compactDate(query.requestedDate);

    if (startDate <= endDate) {
      return { startDate, endDate };
    }

    return {
      startDate: endDate,
      endDate: startDate,
    };
  }

  private buildCryptoTimeRange(query: ParsedAssetCandlesQuery): {
    startTime?: number;
    endTime?: number;
  } {
    const range: {
      startTime?: number;
      endTime?: number;
    } = {};

    if (query.rangeStartAt && query.rangeEndAt) {
      return {
        startTime: query.rangeStartAt.getTime(),
        endTime: query.rangeEndAt.getTime(),
      };
    }

    if (query.dateProvided) {
      range.startTime = Date.parse(`${query.requestedDate}T00:00:00.000Z`);
    }

    if (query.toProvided) {
      range.endTime =
        query.toInstant?.getTime() ??
        Date.parse(
          `${query.requestedDate}T${query.toHHmmss.slice(
            0,
            2,
          )}:${query.toHHmmss.slice(2, 4)}:${query.toHHmmss.slice(4, 6)}.000Z`,
        );
    } else if (query.dateProvided) {
      range.endTime = Date.parse(`${query.requestedDate}T23:59:59.999Z`);
    }

    return range;
  }

  private async resolveRangeWindow(
    range: CandleRange,
    now: Date,
    asset: AssetRecord,
  ): Promise<{ startAt: Date; endAt: Date }> {
    if (range === 'season') {
      const season = await this.findCurrentSeasonForRange(now);
      if (!season) {
        this.throwApiError(
          HttpStatus.CONFLICT,
          'ASSET_CANDLES_SEASON_UNAVAILABLE',
          'Current season is required for season candle range.',
        );
      }

      const cappedEndAt =
        season.endAt.getTime() < now.getTime() ? season.endAt : now;
      const endAt =
        cappedEndAt.getTime() < season.startAt.getTime()
          ? season.startAt
          : cappedEndAt;

      return {
        startAt: season.startAt,
        endAt,
      };
    }

    if (range === 'prev_open' || range === 'prev2_open') {
      return {
        startAt: this.resolveMarketOpenAnchor(
          asset.assetType,
          range === 'prev_open' ? 1 : 2,
          now,
        ),
        endAt: now,
      };
    }

    return {
      startAt: new Date(now.getTime() - this.rangeDurationMs(range)),
      endAt: now,
    };
  }

  /**
   * Start anchor for the market-open ranges: the regular-session open
   * `daysBack` market days before "today" in the asset's market timezone.
   *   - domestic_stock: KRX regular open 09:00 Asia/Seoul
   *   - us_stock: US regular open 09:30 America/New_York
   *   - crypto: trades 24/7 with no session open, so we anchor to 09:00
   *     Asia/Seoul calendar days back to mirror the KRX-centric UX. Adjust here
   *     if the project adopts a different crypto chart time policy.
   * Weekends are skipped for stocks (previous *trading* day); market holidays
   * are not modeled yet — see TODO(chart-range).
   */
  private resolveMarketOpenAnchor(
    assetType: AssetType,
    daysBack: number,
    now: Date,
  ): Date {
    const usesUsSession = assetType === AssetType.us_stock;
    const timeZone = usesUsSession ? US_EASTERN_TIME_ZONE : KOREA_TIME_ZONE;
    const openTime = usesUsSession ? '093000' : '090000';
    const skipWeekends = assetType !== AssetType.crypto;

    const todayParts = this.zonedParts(now, timeZone);
    const cursor = new Date(
      Date.UTC(todayParts.year, todayParts.month - 1, todayParts.day),
    );
    let remaining = daysBack;
    while (remaining > 0) {
      cursor.setUTCDate(cursor.getUTCDate() - 1);
      const weekday = cursor.getUTCDay();
      if (!skipWeekends || (weekday !== 0 && weekday !== 6)) {
        remaining -= 1;
      }
    }

    const anchorDate = cursor.toISOString().slice(0, 10).replace(/-/gu, '');
    return this.zonedDateTimeToUtc(anchorDate, openTime, timeZone);
  }

  private async findCurrentSeasonForRange(now: Date) {
    const select = {
      startAt: true,
      endAt: true,
    } as const;
    const currentByClock = await this.prisma.season.findFirst({
      where: {
        startAt: {
          lte: now,
        },
        endAt: {
          gte: now,
        },
      },
      orderBy: {
        startAt: 'desc',
      },
      select,
    });

    if (currentByClock) {
      return currentByClock;
    }

    return this.prisma.season.findFirst({
      where: {
        status: SeasonStatus.active,
      },
      orderBy: {
        startAt: 'desc',
      },
      select,
    });
  }

  private rangeDurationMs(
    range: Exclude<CandleRange, 'season' | 'prev_open' | 'prev2_open'>,
  ): number {
    if (range === '1d') {
      return 86_400_000;
    }

    if (range === '7d') {
      return 7 * 86_400_000;
    }

    if (range === '30d') {
      return 30 * 86_400_000;
    }

    return 365 * 86_400_000;
  }

  private parseDate(
    value: string | undefined,
    timeZone: string,
    clock: Date,
  ): string {
    const text = this.parseOptionalText(value);
    if (!text) {
      return this.dateInZone(clock, timeZone);
    }

    if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_CANDLE_DATE',
        'date must use YYYY-MM-DD format.',
      );
    }

    const parsed = new Date(`${text}T00:00:00.000Z`);
    if (
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== text
    ) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_CANDLE_DATE',
        'date must be a valid calendar date.',
      );
    }

    return text;
  }

  private parseTo(
    value: string | undefined,
    timeZone: string,
    clock: Date,
  ): {
    hhmmss: string;
    instant: Date | null;
    provided: boolean;
  } {
    const text = this.parseOptionalText(value);
    if (!text) {
      return {
        hhmmss: this.timeInZone(clock, timeZone),
        instant: null,
        provided: false,
      };
    }

    const compactTime = text.replace(/:/gu, '');
    if (/^\d{6}$/u.test(compactTime)) {
      return {
        hhmmss: this.requireHHmmss(compactTime, 'INVALID_CANDLE_TO'),
        instant: null,
        provided: true,
      };
    }

    if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_CANDLE_TO',
        'to must be HHmmss or an ISO datetime.',
      );
    }

    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_CANDLE_TO',
        'to must be HHmmss or an ISO datetime.',
      );
    }

    const parts = this.zonedParts(parsed, timeZone);
    return {
      hhmmss: `${this.pad2(parts.hour)}${this.pad2(parts.minute)}${this.pad2(
        parts.second,
      )}`,
      instant: parsed,
      provided: true,
    };
  }

  private parseBoolean(
    value: string | undefined,
    defaultValue: boolean,
  ): boolean {
    const text = this.parseOptionalText(value);
    if (!text) {
      return defaultValue;
    }

    if (text === 'true') {
      return true;
    }

    if (text === 'false') {
      return false;
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'INVALID_CANDLE_INCLUDE_PREVIOUS',
      'includePrevious must be true or false.',
    );
  }

  private parsePositiveInteger(value: string, code: string): number {
    if (!/^\d+$/u.test(value.trim())) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        code,
        'limit must be a positive integer.',
      );
    }

    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        code,
        'limit must be a positive integer.',
      );
    }

    return parsed;
  }

  private parseAssetId(value: string | undefined): string {
    const text = this.parseOptionalText(value);
    if (!text) {
      this.throwApiError(
        HttpStatus.NOT_FOUND,
        'ASSET_NOT_FOUND',
        'Asset not found.',
      );
    }

    return text;
  }

  private parseOptionalText(value: string | undefined): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }

  private resolveDomesticKisMarketCode(asset: AssetRecord): string {
    const market = asset.market.trim().toUpperCase();
    if (
      market === 'KRX' ||
      market === 'KOSPI' ||
      market === 'KOSDAQ' ||
      market === 'KONEX'
    ) {
      return 'J';
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'ASSET_CANDLES_UNSUPPORTED_MARKET',
      'Asset market is unsupported for KIS domestic stock candles.',
    );
  }

  private resolveUsKisMarketCode(asset: AssetRecord): string {
    const marketCode = normalizeKisUsMarketCode(asset.market);
    if (marketCode) {
      return marketCode;
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'ASSET_CANDLES_UNSUPPORTED_MARKET',
      'Asset market is unsupported for KIS overseas stock candles.',
    );
  }

  private normalizeDomesticSymbol(symbol: string): string {
    const normalized = symbol.trim().toUpperCase();
    if (/^\d{6}$/u.test(normalized)) {
      return normalized;
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'ASSET_CANDLES_UNSUPPORTED_SYMBOL',
      'Domestic stock candles require a 6-digit KIS stock code.',
    );
  }

  private normalizeUsSymbol(symbol: string): string {
    const normalized = symbol.trim().toUpperCase();
    if (/^[A-Z0-9][A-Z0-9.-]{0,19}$/u.test(normalized)) {
      return normalized;
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'ASSET_CANDLES_UNSUPPORTED_SYMBOL',
      'US stock candles require a KIS-compatible stock symbol.',
    );
  }

  private normalizeCryptoSymbol(asset: AssetRecord): string {
    const rawSymbol = this.parseOptionalText(asset.symbol)?.toUpperCase();
    if (!rawSymbol) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'ASSET_CANDLES_UNSUPPORTED_SYMBOL',
        'Crypto candles require a Binance-compatible symbol.',
      );
    }

    const symbol = rawSymbol.replace(/\s+/gu, '');
    if (/[/_-]/u.test(symbol)) {
      const pair = symbol.match(/^([A-Z0-9]{1,20})[/_-](USDT|USD)$/u);
      if (pair) {
        return `${pair[1]}USDT`;
      }

      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'ASSET_CANDLES_UNSUPPORTED_SYMBOL',
        'Crypto candles require a USDT quote Binance symbol.',
      );
    }

    if (/^[A-Z0-9]{1,30}USDT$/u.test(symbol)) {
      return symbol;
    }

    const usdPair = symbol.match(/^([A-Z0-9]{1,20})USD$/u);
    if (usdPair) {
      return `${usdPair[1]}USDT`;
    }

    if (/^[A-Z0-9]{1,20}$/u.test(symbol)) {
      return `${symbol}USDT`;
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'ASSET_CANDLES_UNSUPPORTED_SYMBOL',
      'Crypto candles require a Binance-compatible symbol.',
    );
  }

  private normalizeSourceDate(
    value: string | undefined,
    fallbackDate: string,
  ): string | null {
    if (!value) {
      return fallbackDate;
    }

    const text = value.trim();
    if (/^\d{8}$/u.test(text)) {
      return text;
    }

    if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) {
      return this.compactDate(text);
    }

    return null;
  }

  private normalizeSourceTime(value: string | undefined): string | null {
    if (!value) {
      return null;
    }

    const digits = value.trim().replace(/:/gu, '');
    if (!/^\d{1,6}$/u.test(digits)) {
      return null;
    }

    const normalized = digits.padStart(6, '0');
    return this.isValidHHmmss(normalized) ? normalized : null;
  }

  private requireHHmmss(value: string, errorCode: string): string {
    if (this.isValidHHmmss(value)) {
      return value;
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      errorCode,
      'time must be a valid HHmmss value.',
    );
  }

  private isValidHHmmss(value: string): boolean {
    const hour = Number(value.slice(0, 2));
    const minute = Number(value.slice(2, 4));
    const second = Number(value.slice(4, 6));

    return (
      /^\d{6}$/u.test(value) &&
      Number.isInteger(hour) &&
      Number.isInteger(minute) &&
      Number.isInteger(second) &&
      hour < 24 &&
      minute < 60 &&
      second < 60
    );
  }

  private parseDecimal(value: string | undefined): Prisma.Decimal | null {
    if (!value) {
      return null;
    }

    const normalized = value.trim().replace(/,/gu, '');
    if (!/^[+-]?\d+(?:\.\d+)?$/u.test(normalized)) {
      return null;
    }

    try {
      const decimal = new Prisma.Decimal(normalized);
      return decimal.isFinite() ? decimal : null;
    } catch {
      return null;
    }
  }

  private readFirstString(
    row: Record<string, unknown>,
    aliases: readonly string[],
  ): string | undefined {
    for (const alias of aliases) {
      const value = this.readOptionalString(row[alias]);
      if (value) {
        return value;
      }
    }

    return undefined;
  }

  private readOptionalString(value: unknown): string | undefined {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed === '' ? undefined : trimmed;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }

    return undefined;
  }

  private compactDate(value: string): string {
    return value.replace(/-/gu, '');
  }

  private previousCompactDate(value: string): string {
    const date = new Date(
      Date.UTC(
        Number(value.slice(0, 4)),
        Number(value.slice(4, 6)) - 1,
        Number(value.slice(6, 8)),
      ),
    );
    date.setUTCDate(date.getUTCDate() - 1);

    return date.toISOString().slice(0, 10).replace(/-/gu, '');
  }

  private formatAuthorization(
    tokenType: string | null,
    accessToken: string,
  ): string {
    return `${tokenType?.trim() || 'Bearer'} ${accessToken}`;
  }

  private isTokenExpired(expiresAt: Date | null): boolean {
    if (!expiresAt) {
      return false;
    }

    return expiresAt.getTime() <= Date.now() + 60_000;
  }

  private todayInZone(timeZone: string): string {
    return this.dateInZone(new Date(), timeZone);
  }

  private dateInZone(date: Date, timeZone: string): string {
    const parts = this.zonedParts(date, timeZone);
    return `${parts.year}-${this.pad2(parts.month)}-${this.pad2(parts.day)}`;
  }

  private nowTimeInZone(timeZone: string): string {
    return this.timeInZone(new Date(), timeZone);
  }

  private timeInZone(date: Date, timeZone: string): string {
    const parts = this.zonedParts(date, timeZone);
    return `${this.pad2(parts.hour)}${this.pad2(parts.minute)}${this.pad2(
      parts.second,
    )}`;
  }

  private zonedDateTimeToUtc(
    sourceDate: string,
    sourceTime: string,
    timeZone: string,
  ): Date {
    const targetAsUtc = Date.UTC(
      Number(sourceDate.slice(0, 4)),
      Number(sourceDate.slice(4, 6)) - 1,
      Number(sourceDate.slice(6, 8)),
      Number(sourceTime.slice(0, 2)),
      Number(sourceTime.slice(2, 4)),
      Number(sourceTime.slice(4, 6)),
    );
    let utc = targetAsUtc;

    for (let i = 0; i < 3; i += 1) {
      const parts = this.zonedParts(new Date(utc), timeZone);
      const actualAsUtc = Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second,
      );
      const diff = actualAsUtc - targetAsUtc;
      if (diff === 0) {
        break;
      }
      utc -= diff;
    }

    return new Date(utc);
  }

  private zonedParts(date: Date, timeZone: string) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const get = (type: Intl.DateTimeFormatPartTypes): number => {
      const value = parts.find((part) => part.type === type)?.value;
      return value ? Number(value) : 0;
    };

    return {
      year: get('year'),
      month: get('month'),
      day: get('day'),
      hour: get('hour'),
      minute: get('minute'),
      second: get('second'),
    };
  }

  private sortCandles(
    candles: readonly NormalizedCandle[],
  ): NormalizedCandle[] {
    return [...candles].sort(
      (left, right) => left.time.getTime() - right.time.getTime(),
    );
  }

  private formatDecimal(value: Prisma.Decimal): string {
    return value.toFixed(8);
  }

  private pad2(value: number): string {
    return String(value).padStart(2, '0');
  }

  private isCandleInterval(value: string): value is CandleInterval {
    return Object.hasOwn(CANDLE_INTERVALS, value);
  }

  private isCandleRange(value: string): value is CandleRange {
    return Object.hasOwn(CANDLE_RANGES, value);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  private assetSelect() {
    return {
      id: true,
      symbol: true,
      name: true,
      market: true,
      assetType: true,
      currencyCode: true,
      priceCurrency: true,
      settlementCurrency: true,
      isActive: true,
    } as const;
  }

  private createErrorBody(code: string, message: string) {
    return {
      success: false,
      error: {
        code,
        message,
      },
    };
  }

  private throwMalformedBinanceResponse(): never {
    this.throwApiError(
      HttpStatus.BAD_GATEWAY,
      'ASSET_CANDLES_PROVIDER_MALFORMED_RESPONSE',
      'Binance returned malformed candle data.',
    );
  }

  private throwApiError(
    status: HttpStatus,
    code: string,
    message: string,
  ): never {
    throw new HttpException(this.createErrorBody(code, message), status);
  }
}
