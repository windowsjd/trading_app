import { Injectable } from '@nestjs/common';
import { ProviderHttpClient } from '../provider-http.client';
import type { BinanceKlinesSource } from './binance-candle.types';

/**
 * Binance USDⓈ-M Futures public klines. This is the CONTRACT trade-price
 * series (the `/fapi/v1/klines` candles of the PERPETUAL contract), not the
 * Mark (`markPriceKlines`), Index (`indexPriceKlines`) or Spot (`/api/v3/klines`)
 * series. Same hard-coded public host as the existing Last/Mark/exchangeInfo
 * futures paths; no API key.
 */
export const BINANCE_USDM_KLINES_URL =
  'https://fapi.binance.com/fapi/v1/klines';
export const BINANCE_USDM_KLINES_PATH = '/fapi/v1/klines';

/** DI token: a BinanceCandleIngestionService paging USDⓈ-M contract klines. */
export const BINANCE_USDM_CANDLE_INGESTION = Symbol(
  'BINANCE_USDM_CANDLE_INGESTION',
);

// Short public reads; the shared Binance REST coordinator still bounds
// admission (weight budget, 2 global slots, 418/429 back-off).
const USDM_KLINES_TIMEOUT_MS = 5_000;

/**
 * Kline transport for the futures candle ingestion instance. Every call goes
 * through ProviderHttpClient with provider `binance`, so the existing shared
 * REST coordinator prices it with the `/fapi/v1/klines` LIMIT tiers and the
 * same budget/back-off as the Last/Mark recovery calls.
 */
@Injectable()
export class BinanceUsdmKlineClient implements BinanceKlinesSource {
  constructor(private readonly httpClient: ProviderHttpClient) {}

  async fetchKlines(input: {
    symbol: string;
    interval: string;
    limit: number;
    startTime?: number;
    endTime?: number;
  }): Promise<{ response: unknown; receivedAt: Date }> {
    const url = new URL(BINANCE_USDM_KLINES_URL);
    url.searchParams.set('symbol', input.symbol.trim().toUpperCase());
    url.searchParams.set('interval', input.interval);
    url.searchParams.set('limit', String(input.limit));
    if (input.startTime !== undefined) {
      url.searchParams.set('startTime', String(input.startTime));
    }
    if (input.endTime !== undefined) {
      url.searchParams.set('endTime', String(input.endTime));
    }
    const result = await this.httpClient.getJson<unknown>(url.toString(), {
      provider: 'binance',
      timeoutMs: USDM_KLINES_TIMEOUT_MS,
    });
    return { response: result.json, receivedAt: result.receivedAt };
  }
}
