import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { AssetType, Prisma } from '../generated/prisma/client';
import { normalizeKisUsMarketCode } from '../providers/kis/kis-websocket.subscription';
import {
  KIS_DOMESTIC_MINUTE_PATH,
  KIS_DOMESTIC_MINUTE_TR_ID,
  KIS_US_MINUTE_PATH,
  KIS_US_MINUTE_TR_ID,
} from '../providers/kis/candles/kis-candle.types';
import {
  KIS_DOMESTIC_PERIOD_PATH,
  KIS_DOMESTIC_PERIOD_TR_ID,
  KIS_OVERSEAS_PERIOD_PATH,
  KIS_OVERSEAS_PERIOD_TR_ID,
} from '../providers/kis/candles/kis-period-candle.types';
import type {
  AssetCandlesAsset,
  AssetCandlesResponse,
  CandlePayload,
  ParsedAssetCandlesQuery,
} from './asset-candles.service';

export type PersistedResponseCandle = {
  openTime: Date;
  open: Prisma.Decimal | string;
  high: Prisma.Decimal | string;
  low: Prisma.Decimal | string;
  close: Prisma.Decimal | string;
  volume: Prisma.Decimal | string;
  amount: Prisma.Decimal | string | null;
};

export type KisResponseSource = {
  path: string;
  trId: string;
  marketCode: string;
  requestedCount: number;
};

export type BinanceResponseSource = {
  endpoint: '/api/v3/klines';
  symbol: string;
  interval: ParsedAssetCandlesQuery['interval'];
  requestedCount: number;
};

@Injectable()
export class CandleResponseBuilder {
  buildPersisted(
    asset: AssetCandlesAsset,
    query: ParsedAssetCandlesQuery,
    rows: readonly PersistedResponseCandle[],
  ): AssetCandlesResponse {
    const candles = rows.map((row) => this.toPayload(row, asset.assetType));
    const base = this.base(asset, query, candles);

    if (asset.assetType === AssetType.crypto) {
      return {
        success: true,
        data: {
          ...base,
          source: {
            provider: 'binance',
            endpoint: '/api/v3/klines',
            symbol: this.normalizeCryptoSymbol(asset.symbol),
            interval: query.interval,
            requestedCount: Math.min(query.limit, 1000),
            returnedCount: candles.length,
          },
        },
      };
    }

    const period = query.interval === '1d' || query.interval === '1w';
    const domestic = asset.assetType === AssetType.domestic_stock;
    const marketCode = domestic ? 'J' : normalizeKisUsMarketCode(asset.market);
    if (!marketCode) {
      throw this.badRequest(
        'ASSET_CANDLES_UNSUPPORTED_MARKET',
        'Asset market is unsupported for KIS candles.',
      );
    }
    return {
      success: true,
      data: {
        ...base,
        source: {
          provider: 'kis',
          path: period
            ? domestic
              ? KIS_DOMESTIC_PERIOD_PATH
              : KIS_OVERSEAS_PERIOD_PATH
            : domestic
              ? KIS_DOMESTIC_MINUTE_PATH
              : KIS_US_MINUTE_PATH,
          trId: period
            ? domestic
              ? KIS_DOMESTIC_PERIOD_TR_ID
              : KIS_OVERSEAS_PERIOD_TR_ID
            : domestic
              ? KIS_DOMESTIC_MINUTE_TR_ID
              : KIS_US_MINUTE_TR_ID,
          marketCode,
          requestedCount: query.limit,
          returnedCount: candles.length,
        },
      },
    };
  }

  buildKis(
    asset: AssetCandlesAsset,
    query: ParsedAssetCandlesQuery,
    source: KisResponseSource,
    candles: CandlePayload[],
  ): AssetCandlesResponse {
    return {
      success: true,
      data: {
        ...this.base(asset, query, candles),
        source: {
          provider: 'kis',
          trId: source.trId,
          path: source.path,
          marketCode: source.marketCode,
          requestedCount: source.requestedCount,
          returnedCount: candles.length,
        },
      },
    };
  }

  buildCrypto(
    asset: AssetCandlesAsset,
    query: ParsedAssetCandlesQuery,
    source: BinanceResponseSource,
    candles: CandlePayload[],
    truncated = false,
  ): AssetCandlesResponse {
    return {
      success: true,
      data: {
        ...this.base(asset, query, candles),
        source: {
          provider: 'binance',
          ...source,
          returnedCount: candles.length,
          ...(truncated ? { truncated: true } : {}),
        },
      },
    };
  }

  private base(
    asset: AssetCandlesAsset,
    query: ParsedAssetCandlesQuery,
    candles: CandlePayload[],
  ) {
    return {
      state: candles.length > 0 ? ('available' as const) : ('empty' as const),
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
    };
  }

  private toPayload(
    row: PersistedResponseCandle,
    assetType: AssetType,
  ): CandlePayload {
    const timeZone =
      assetType === AssetType.domestic_stock
        ? 'Asia/Seoul'
        : assetType === AssetType.us_stock
          ? 'America/New_York'
          : 'UTC';
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(row.openTime);
    const value = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? '';
    return {
      time: row.openTime.toISOString(),
      open: this.decimal(row.open),
      high: this.decimal(row.high),
      low: this.decimal(row.low),
      close: this.decimal(row.close),
      volume: this.decimal(row.volume),
      // The v1 HTTP contract requires a string. Persisted feeds preserve a
      // missing amount as null, which is compatibility-mapped to zero here.
      amount: this.decimal(row.amount ?? '0'),
      sourceDate: `${value('year')}${value('month')}${value('day')}`,
      sourceTime: `${value('hour')}${value('minute')}${value('second')}`,
    };
  }

  private decimal(value: Prisma.Decimal | string): string {
    return new Prisma.Decimal(value).toFixed(8);
  }

  private normalizeCryptoSymbol(symbol: string): string {
    const normalized = symbol.trim().toUpperCase().replace(/\s+/gu, '');
    const pair = normalized.match(/^([A-Z0-9]{1,20})[/_-](?:USDT|USD)$/u);
    if (pair) return `${pair[1]}USDT`;
    if (/^[A-Z0-9]{1,30}USDT$/u.test(normalized)) return normalized;
    const usd = normalized.match(/^([A-Z0-9]{1,20})USD$/u);
    if (usd) return `${usd[1]}USDT`;
    throw this.badRequest(
      'ASSET_CANDLES_UNSUPPORTED_SYMBOL',
      'Crypto candles require a USDT quote Binance symbol.',
    );
  }

  private badRequest(code: string, message: string): HttpException {
    return new HttpException(
      { success: false, error: { code, message, details: null } },
      HttpStatus.BAD_REQUEST,
    );
  }
}
