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

export type AssetCandlesQuery = {
  range?: string;
  interval?: string;
  limit?: string;
  date?: string;
  to?: string;
  includePrevious?: string;
};

type CandleRange = '1d' | '7d' | '30d' | 'season';
type CandleInterval = '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w';
type CryptoCandleInterval = CandleInterval;

type AssetRecord = {
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

type ParsedAssetCandlesQuery = {
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
};

type CandlePayload = {
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

type AssetCandlesResponse = {
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
        };
  };
};

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 120;
const CRYPTO_MAX_LIMIT = 1000;
const DOMESTIC_TODAY_MAX_COUNT = 30;
const DEFAULT_RANGE: CandleRange = '1d';
const KOREA_TIME_ZONE = 'Asia/Seoul';
const US_EASTERN_TIME_ZONE = 'America/New_York';
const UTC_TIME_ZONE = 'UTC';
const BINANCE_KLINE_PATH = '/api/v3/klines';

const DEFAULT_INTERVAL_BY_RANGE: Record<CandleRange, CandleInterval> = {
  '1d': '5m',
  '7d': '1h',
  '30d': '1d',
  season: '1d',
};

const CANDLE_INTERVAL_MINUTES: Record<CandleInterval, number> = {
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '4h': 240,
  '1d': 1440,
  '1w': 10080,
};

const CANDLE_INTERVALS: Record<CandleInterval, true> = {
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
  season: true,
};

const RANGE_INTERVALS: Record<
  CandleRange,
  Readonly<Record<CandleInterval, true>>
> = {
  '1d': CANDLE_INTERVALS,
  '7d': CANDLE_INTERVALS,
  '30d': CANDLE_INTERVALS,
  season: CANDLE_INTERVALS,
};

const DOMESTIC_TODAY_CANDLE_PATH =
  '/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice';
const DOMESTIC_DAILY_CANDLE_PATH =
  '/uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice';
const OVERSEAS_CANDLE_PATH =
  '/uapi/overseas-price/v1/quotations/inquire-time-itemchartprice';

const DOMESTIC_TODAY_CANDLE_TR_ID = 'FHKST03010200';
const DOMESTIC_DAILY_CANDLE_TR_ID = 'FHKST03010230';
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

    const parsedQuery = await this.parseQuery(query, asset);

    try {
      if (asset.assetType === AssetType.domestic_stock) {
        return await this.getDomesticStockCandles(asset, parsedQuery);
      }

      if (asset.assetType === AssetType.us_stock) {
        return await this.getUsStockCandles(asset, parsedQuery);
      }

      if (asset.assetType === AssetType.crypto) {
        return await this.getCryptoCandles(asset, parsedQuery);
      }

      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'ASSET_CANDLES_UNSUPPORTED_ASSET_TYPE',
        'Asset type is unsupported for candles.',
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

  private async getDomesticStockCandles(
    asset: AssetRecord,
    query: ParsedAssetCandlesQuery,
  ): Promise<AssetCandlesResponse> {
    const marketCode = this.resolveDomesticKisMarketCode(asset);
    const usesTodayEndpoint =
      query.range === '1d' &&
      query.intervalMinutes < CANDLE_INTERVAL_MINUTES['1d'] &&
      query.requestedDate === this.todayInZone(KOREA_TIME_ZONE);
    const descriptor = usesTodayEndpoint
      ? this.buildDomesticTodayCall(asset, query, marketCode)
      : this.buildDomesticDailyCall(asset, query, marketCode);
    const response = await this.callKisCandles(descriptor);
    const rows = this.extractRows(response);
    const normalized = this.normalizeRows(rows, {
      fallbackDate: query.requestedDate,
      timeZone: KOREA_TIME_ZONE,
    });
    const bucketed = this.bucketStockCandles(
      normalized,
      query.intervalMinutes,
      KOREA_TIME_ZONE,
    );
    const candles = this.sliceRecent(bucketed, query.limit).map((candle) =>
      this.formatCandle(candle),
    );

    return this.buildResponse(asset, query, descriptor, candles);
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
    const bucketed = this.bucketStockCandles(
      normalized,
      query.intervalMinutes,
      US_EASTERN_TIME_ZONE,
    );
    const candles = this.sliceRecent(bucketed, query.limit).map((candle) =>
      this.formatCandle(candle),
    );

    return this.buildResponse(asset, query, descriptor, candles);
  }

  private async getCryptoCandles(
    asset: AssetRecord,
    query: ParsedAssetCandlesQuery,
  ): Promise<AssetCandlesResponse> {
    const interval = this.requireCryptoInterval(query.interval);
    const symbol = this.normalizeCryptoSymbol(asset);
    const timeRange = this.buildCryptoTimeRange(query);
    const descriptor: BinanceCallDescriptor = {
      endpoint: BINANCE_KLINE_PATH,
      symbol,
      interval,
      requestedCount: query.limit,
    };
    const result = await this.binancePublicClient.fetchKlines({
      symbol,
      interval,
      limit: query.limit,
      ...timeRange,
    });
    const candles = this.normalizeBinanceKlines(result.response).map((candle) =>
      this.formatCandle(candle),
    );

    return this.buildCryptoResponse(asset, query, descriptor, candles);
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
      requestedCount: Math.min(query.limit, DOMESTIC_TODAY_MAX_COUNT),
      query: {
        FID_COND_MRKT_DIV_CODE: marketCode,
        FID_INPUT_ISCD: symbol,
        FID_INPUT_HOUR_1: query.toHHmmss,
        FID_ETC_CLS_CODE: '',
        FID_PW_DATA_INCU_YN: 'N',
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
      requestedCount: query.limit,
      query: {
        FID_COND_MRKT_DIV_CODE: marketCode,
        FID_INPUT_ISCD: symbol,
        FID_INPUT_DATE_1: this.compactDate(query.requestedDate),
        FID_INPUT_HOUR_1: query.toHHmmss,
        FID_PW_DATA_INCU_YN: 'N',
        FID_FAKE_TICK_INCU_YN: 'N',
      },
    };
  }

  private buildOverseasCall(
    asset: AssetRecord,
    query: ParsedAssetCandlesQuery,
    marketCode: string,
  ): KisCallDescriptor {
    return {
      path: OVERSEAS_CANDLE_PATH,
      trId: OVERSEAS_CANDLE_TR_ID,
      marketCode,
      requestedCount: query.limit,
      query: {
        AUTH: '',
        EXCD: marketCode,
        SYMB: this.normalizeUsSymbol(asset.symbol),
        NMIN: String(this.resolveKisSourceIntervalMinutes(query)),
        PINC: query.includePrevious ? '1' : '0',
        NEXT: '',
        NREC: String(query.limit),
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

  private buildResponse(
    asset: AssetRecord,
    query: ParsedAssetCandlesQuery,
    descriptor: KisCallDescriptor,
    candles: CandlePayload[],
  ): AssetCandlesResponse {
    return {
      success: true,
      data: {
        state: 'available',
        asset: {
          id: asset.id,
          symbol: asset.symbol,
          name: asset.name,
          assetType: asset.assetType,
          market: asset.market,
          priceCurrency: asset.priceCurrency ?? asset.currencyCode,
        },
        range: query.range,
        interval: query.interval,
        requestedDate: query.requestedDate,
        candles,
        source: {
          provider: 'kis',
          trId: descriptor.trId,
          path: descriptor.path,
          marketCode: descriptor.marketCode,
          requestedCount: descriptor.requestedCount,
          returnedCount: candles.length,
        },
      },
    };
  }

  private buildCryptoResponse(
    asset: AssetRecord,
    query: ParsedAssetCandlesQuery,
    descriptor: BinanceCallDescriptor,
    candles: CandlePayload[],
  ): AssetCandlesResponse {
    return {
      success: true,
      data: {
        state: candles.length > 0 ? 'available' : 'empty',
        asset: {
          id: asset.id,
          symbol: asset.symbol,
          name: asset.name,
          assetType: asset.assetType,
          market: asset.market,
          priceCurrency: asset.priceCurrency ?? asset.currencyCode,
        },
        range: query.range,
        interval: query.interval,
        requestedDate: query.requestedDate,
        candles,
        source: {
          provider: 'binance',
          endpoint: descriptor.endpoint,
          symbol: descriptor.symbol,
          interval: descriptor.interval,
          requestedCount: descriptor.requestedCount,
          returnedCount: candles.length,
        },
      },
    };
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
  ): Promise<ParsedAssetCandlesQuery> {
    const timeZone =
      asset.assetType === AssetType.domestic_stock
        ? KOREA_TIME_ZONE
        : asset.assetType === AssetType.us_stock
          ? US_EASTERN_TIME_ZONE
          : UTC_TIME_ZONE;
    const range = this.parseRange(query.range);
    const rangeProvided = this.parseOptionalText(query.range) !== undefined;
    const interval = this.parseInterval(query.interval, asset.assetType, range);
    const parsedTo = this.parseTo(query.to, timeZone);
    const rangeWindow = rangeProvided
      ? await this.resolveRangeWindow(range, new Date())
      : null;
    const requestedDate = rangeWindow
      ? this.dateInZone(rangeWindow.endAt, timeZone)
      : this.parseDate(query.date, timeZone);
    const toHHmmss = rangeWindow
      ? this.timeInZone(rangeWindow.endAt, timeZone)
      : parsedTo.hhmmss;

    return {
      range,
      rangeProvided,
      rangeStartAt: rangeWindow?.startAt ?? null,
      rangeEndAt: rangeWindow?.endAt ?? null,
      interval,
      intervalMinutes: CANDLE_INTERVAL_MINUTES[interval],
      limit: this.parseLimit(query.limit, asset.assetType),
      requestedDate,
      toHHmmss,
      toInstant: rangeWindow?.endAt ?? parsedTo.instant,
      dateProvided:
        rangeWindow !== null ||
        this.parseOptionalText(query.date) !== undefined,
      toProvided: rangeWindow !== null || parsedTo.provided,
      includePrevious: this.parseBoolean(query.includePrevious, true),
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
      'range must be one of 1d, 7d, 30d, or season.',
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
      'interval must be one of 5m, 15m, 30m, 1h, 4h, 1d, or 1w.',
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

  private parseLimit(value: string | undefined, assetType: AssetType): number {
    if (value === undefined) {
      return DEFAULT_LIMIT;
    }

    const limit = this.parsePositiveInteger(value, 'INVALID_CANDLE_LIMIT');
    const maxLimit =
      assetType === AssetType.crypto ? CRYPTO_MAX_LIMIT : MAX_LIMIT;
    return Math.min(limit, maxLimit);
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
      'interval must be one of 5m, 15m, 30m, 1h, 4h, 1d, or 1w.',
    );
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

    return {
      startAt: new Date(now.getTime() - this.rangeDurationMs(range)),
      endAt: now,
    };
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

  private rangeDurationMs(range: Exclude<CandleRange, 'season'>): number {
    if (range === '1d') {
      return 86_400_000;
    }

    if (range === '7d') {
      return 7 * 86_400_000;
    }

    return 30 * 86_400_000;
  }

  private parseDate(value: string | undefined, timeZone: string): string {
    const text = this.parseOptionalText(value);
    if (!text) {
      return this.todayInZone(timeZone);
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
  ): {
    hhmmss: string;
    instant: Date | null;
    provided: boolean;
  } {
    const text = this.parseOptionalText(value);
    if (!text) {
      return {
        hhmmss: this.nowTimeInZone(timeZone),
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
