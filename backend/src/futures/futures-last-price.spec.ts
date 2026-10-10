jest.mock('../generated/prisma/client', () => ({
  CurrencyCode: { KRW: 'KRW', USD: 'USD' },
  Prisma: {
    Decimal: jest.requireActual('@prisma/client/runtime/client').Decimal,
  },
}));
import { HttpException } from '@nestjs/common';
import {
  Prisma,
  type Asset,
  type FuturesLastPriceSnapshot,
} from '../generated/prisma/client';
import {
  FUTURES_LAST_MAX_CAPTURE_AGE_MS,
  FUTURES_LAST_MAX_TRADE_AGE_MS,
  parseBinanceAggTrade,
  parseBinanceTickerPrice,
  presentFuturesLastEvidence,
  readFuturesFinalLastPrice,
  readFuturesLastPrice,
  validFuturesFinalLastPrice,
  validFuturesLastPrice,
} from './futures-last-price';
import { validLegacySpotFinalPrice } from './futures-price';
import type { InstrumentWithAsset } from './futures.presenter';

const now = new Date('2026-10-10T12:00:00Z');
const at = (ms: number) => new Date(+now + ms);
const asset = {
  id: 'btc',
  symbol: 'BTCUSDT',
  market: 'BINANCE',
  assetType: 'crypto',
  currencyCode: 'USD',
  priceCurrency: 'USD',
  settlementCurrency: 'USD',
  isActive: true,
} as Asset;
const instrument = {
  id: 'inst-btc',
  underlyingAssetId: 'btc',
  productType: 'synthetic_perpetual',
  settlementCurrency: 'USD',
  isActive: true,
  underlyingAsset: asset,
} as InstrumentWithAsset;
const row = {
  id: 'last-1',
  instrumentId: 'inst-btc',
  symbol: 'BTCUSDT',
  providerProduct: 'binance_usdm_perpetual',
  currencyCode: 'USD',
  source: 'binance_usdm_agg_trade_ws',
  price: new Prisma.Decimal('82670.3'),
  effectiveAt: at(-1500),
  capturedAt: at(-900),
} as FuturesLastPriceSnapshot;
const aggTrade = {
  e: 'aggTrade',
  E: +now - 850,
  s: 'BTCUSDT',
  a: 4521,
  p: '82670.30',
  q: '0.004',
  f: 100,
  l: 101,
  T: +now - 900,
  m: false,
};
function client(found: FuturesLastPriceSnapshot | null) {
  const findFirst = jest.fn().mockResolvedValue(found);
  return {
    client: { futuresLastPriceSnapshot: { findFirst } } as never,
    findFirst,
  };
}
async function code(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException)
      return (error.getResponse() as { error: { code: string } }).error.code;
    throw error;
  }
  return 'resolved';
}

describe('Binance USDⓈ-M last trade parsing', () => {
  it('reads @aggTrade trade price p at trade time T, never E', () => {
    const parsed = parseBinanceAggTrade(aggTrade, 'BTCUSDT', now)!;
    expect(parsed.price.toFixed(8)).toBe('82670.30000000');
    expect(+parsed.effectiveAt).toBe(aggTrade.T);
    expect(+parsed.capturedAt).toBe(+now);
    expect(parsed.aggregateId).toBe(4521);
    expect(parsed.source).toBe('binance_usdm_agg_trade_ws');
    expect(parsed.providerProduct).toBe('binance_usdm_perpetual');
    expect(parsed.currencyCode).toBe('USD');
  });
  it.each([
    ['another symbol', { s: 'ETHUSDT' }],
    ['a Mark update', { e: 'markPriceUpdate' }],
    ['a ticker event', { e: '24hrTicker' }],
    ['a coin-margined contract', { st: 2 }],
    ['a numeric price', { p: 82670.3 }],
    ['an exponent price', { p: '8.2e4' }],
    ['a negative price', { p: '-1' }],
    ['a zero price', { p: '0.00000000' }],
    ['nine decimals', { p: '1.123456789' }],
    ['seventeen integer digits', { p: '12345678901234567' }],
    ['a future trade', { T: +now + 1 }],
    ['a trade older than 10 seconds', { T: +now - 10001 }],
    ['a fractional trade time', { T: +now - 0.5 }],
    ['a missing aggregate id', { a: undefined }],
    ['a negative aggregate id', { a: -1 }],
  ])('rejects %s', (_label, patch) => {
    expect(
      parseBinanceAggTrade({ ...aggTrade, ...patch }, 'BTCUSDT', now) === null,
    ).toBe(true);
  });
  it('rejects non-object payloads and non-ASCII or 1000-token substitutions', () => {
    for (const payload of [null, [], 'x', 1])
      expect(parseBinanceAggTrade(payload, 'BTCUSDT', now) === null).toBe(true);
    expect(
      parseBinanceAggTrade(
        { ...aggTrade, s: '1000PEPEUSDT' },
        'PEPEUSDT',
        now,
      ) === null,
    ).toBe(true);
    expect(
      parseBinanceAggTrade(
        { ...aggTrade, s: '币安人生USDT' },
        '币安人生USDT',
        now,
      ) === null,
    ).toBe(true);
  });
  it('reads REST ticker/price as the current last trade, up to 60 seconds old', () => {
    const quiet = { symbol: 'BTCUSDT', price: '82670.30', time: +now - 30000 };
    const parsed = parseBinanceTickerPrice(quiet, 'BTCUSDT', now)!;
    expect(parsed.source).toBe('binance_usdm_ticker_price_rest');
    expect(+parsed.effectiveAt).toBe(quiet.time);
    for (const patch of [
      { time: +now - FUTURES_LAST_MAX_TRADE_AGE_MS - 1 },
      { time: +now + 1 },
      { symbol: 'ETHUSDT' },
      { price: '0' },
      { price: 'NaN' },
      { time: '1791604992015' },
    ])
      expect(
        parseBinanceTickerPrice({ ...quiet, ...patch }, 'BTCUSDT', now) ===
          null,
      ).toBe(true);
  });
});

describe('Futures Last evidence validation', () => {
  it('accepts exact fresh identity', () => {
    expect(validFuturesLastPrice(row, instrument, now)).toBe(true);
  });
  it.each([
    ['another instrument', { instrumentId: 'inst-eth' }],
    ['another symbol', { symbol: 'ETHUSDT' }],
    ['another currency', { currencyCode: 'KRW' }],
    ['another provider product', { providerProduct: 'binance_coinm' }],
    ['a Mark source', { source: 'binance_usdm_mark_ws' }],
    ['a Spot source', { source: 'binance_spot_ws_ticker' }],
    ['a zero price', { price: new Prisma.Decimal('0') }],
    ['provider time after receipt', { effectiveAt: at(-800) }],
    ['a future receipt', { capturedAt: at(1), effectiveAt: at(0) }],
    [
      'a receipt older than 10 seconds',
      { capturedAt: at(-FUTURES_LAST_MAX_CAPTURE_AGE_MS - 1) },
    ],
    [
      'a trade older than 60 seconds',
      { effectiveAt: at(-FUTURES_LAST_MAX_TRADE_AGE_MS - 1) },
    ],
  ])('rejects %s', (_label, patch) => {
    expect(
      validFuturesLastPrice({ ...row, ...patch } as never, instrument, now),
    ).toBe(false);
  });
  it('keeps exact boundaries inclusive', () => {
    expect(
      validFuturesLastPrice(
        {
          ...row,
          capturedAt: at(-FUTURES_LAST_MAX_CAPTURE_AGE_MS),
          effectiveAt: at(-FUTURES_LAST_MAX_TRADE_AGE_MS),
        },
        instrument,
        now,
      ),
    ).toBe(true);
  });
  it('rejects a non-USD or non-Binance instrument identity', () => {
    for (const changed of [
      { ...instrument, productType: 'other' },
      { ...instrument, settlementCurrency: 'KRW' },
      { ...instrument, underlyingAsset: { ...asset, market: 'KRX' } },
      { ...instrument, underlyingAsset: { ...asset, assetType: 'stock' } },
      { ...instrument, underlyingAsset: { ...asset, priceCurrency: 'KRW' } },
    ])
      expect(validFuturesLastPrice(row, changed as never, now)).toBe(false);
  });
});

describe('Futures Last reads', () => {
  it('selects the newest known trade, then its newest receipt, never after now', async () => {
    const { client: db, findFirst } = client(row);
    expect((await readFuturesLastPrice(db, instrument, now))?.id).toBe(
      'last-1',
    );
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        instrumentId: 'inst-btc',
        capturedAt: { lte: now },
        effectiveAt: { lte: now },
      },
      orderBy: [
        { effectiveAt: 'desc' },
        { capturedAt: 'desc' },
        { id: 'desc' },
      ],
    });
  });
  it('fails closed without fallback: stale newest trade or no observation', async () => {
    const stale = { ...row, capturedAt: at(-11000), effectiveAt: at(-11000) };
    expect(
      await code(readFuturesLastPrice(client(stale).client, instrument, now)),
    ).toBe('FUTURES_PRICE_STALE');
    expect(
      await code(readFuturesLastPrice(client(null).client, instrument, now)),
    ).toBe('FUTURES_PRICE_UNAVAILABLE');
    expect(
      (await readFuturesLastPrice(
        client(stale).client,
        instrument,
        now,
        false,
      )) === null,
    ).toBe(true);
  });
  it('presents a superset of the legacy evidence keys', () => {
    expect(presentFuturesLastEvidence(row)).toEqual({
      assetPriceSnapshotId: null,
      lastPriceSnapshotId: 'last-1',
      priceBasis: 'futures_last',
      sourceType: 'provider_api',
      sourceName: 'binance_usdm_agg_trade_ws',
      effectiveAt: row.effectiveAt.toISOString(),
      capturedAt: row.capturedAt.toISOString(),
    });
  });
});

describe('Season end Futures Last evidence', () => {
  const endAt = now;
  it('accepts a receipt in [endAt-10s, endAt] reporting a trade within 60s', () => {
    for (const patch of [
      { capturedAt: at(-10000), effectiveAt: at(-60000) },
      { capturedAt: at(0), effectiveAt: at(0) },
    ])
      expect(
        validFuturesFinalLastPrice({ ...row, ...patch }, instrument, endAt),
      ).toBe(true);
  });
  it.each([
    ['a post-end receipt', { capturedAt: at(1), effectiveAt: at(0) }],
    ['a receipt before the window', { capturedAt: at(-10001) }],
    ['a trade older than 60s', { effectiveAt: at(-60001) }],
    [
      'provider time after receipt',
      { effectiveAt: at(-100), capturedAt: at(-200) },
    ],
  ])('rejects %s', (_label, patch) => {
    expect(
      validFuturesFinalLastPrice({ ...row, ...patch }, instrument, endAt),
    ).toBe(false);
  });
  it('reads only receipts at or before endAt and never substitutes', async () => {
    const { client: db, findFirst } = client(null);
    expect(await code(readFuturesFinalLastPrice(db, instrument, endAt))).toBe(
      'FUTURES_FINAL_PRICE_UNAVAILABLE',
    );
    expect(findFirst.mock.calls[0][0].where).toEqual({
      instrumentId: 'inst-btc',
      capturedAt: { lte: endAt },
      effectiveAt: { lte: endAt },
    });
    const late = client({
      ...row,
      capturedAt: at(-12000),
      effectiveAt: at(-12000),
    });
    expect(
      await code(readFuturesFinalLastPrice(late.client, instrument, endAt)),
    ).toBe('FUTURES_FINAL_PRICE_UNAVAILABLE');
  });
});

describe('legacy Spot Season pins', () => {
  const spot = {
    id: 'spot-pin',
    assetId: 'btc',
    currencyCode: 'USD',
    price: new Prisma.Decimal('100'),
    sourceType: 'provider_api',
    sourceName: 'binance_spot_ws_ticker',
    effectiveAt: at(-2000),
    capturedAt: at(-1000),
  } as Prisma.AssetPriceSnapshotGetPayload<object>;
  it('re-verifies an existing Spot pin unchanged on retry', () => {
    expect(validLegacySpotFinalPrice(spot, asset, now)).toBe(true);
  });
  it.each([
    { assetId: 'eth' },
    { sourceName: 'binance_usdm_agg_trade_ws' },
    { sourceType: 'admin_manual' },
    { capturedAt: at(1) },
    { effectiveAt: at(-10001) },
    { price: new Prisma.Decimal('0') },
  ])('rejects a malformed legacy pin %j', (patch) => {
    expect(validLegacySpotFinalPrice({ ...spot, ...patch }, asset, now)).toBe(
      false,
    );
  });
});
