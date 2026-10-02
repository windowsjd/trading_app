jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');

  return {
    AssetPriceSourceType: {
      admin_manual: 'admin_manual',
      official_batch: 'official_batch',
      provider_api: 'provider_api',
    },
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    CurrencyCode: {
      KRW: 'KRW',
      USD: 'USD',
    },
    FxRateSourceType: {
      admin_manual: 'admin_manual',
      official_batch: 'official_batch',
      provider_api: 'provider_api',
    },
    Prisma: {
      Decimal,
    },
    PrismaClient: class PrismaClient {},
    SeasonStatus: {
      upcoming: 'upcoming',
      active: 'active',
      ended: 'ended',
      settled: 'settled',
    },
  };
});

import {
  compareAssetListMetric,
  readAssetListTurnover,
} from './asset-list-turnover';
const read = (sourceName: string, payload: unknown, extra = {}) =>
  readAssetListTurnover({
    sourceType: 'provider_api',
    sourceName,
    rawPayloadJson: { truncated: false, payload },
    ...extra,
  });
describe('provider notional turnover evidence', () => {
  it.each([
    [
      'kis_krx_realtime_trade',
      {
        messageType: 'websocket_trade',
        rawFields: { ACML_VOL: '123', ACML_TR_PBMN: '999' },
      },
      'session',
    ],
    [
      'kis_krx_realtime_trade',
      {
        messageType: 'rest_current_price',
        response: { output: { acml_vol: '123', acml_tr_pbmn: '999' } },
      },
      'session',
    ],
    [
      'kis_krx_realtime_trade',
      {
        messageType: 'rest_session_close',
        evidence: { row: { acml_vol: '456', acml_tr_pbmn: '999' } },
      },
      'session',
    ],
    [
      'kis_us_delayed_trade',
      {
        messageType: 'websocket_trade',
        rawFields: { TVOL: '789', TAMT: '999' },
      },
      'session',
    ],
    [
      'kis_us_delayed_trade',
      {
        messageType: 'rest_current_price',
        response: { output1: { tvol: '456', pvol: '1000', tamt: '999' } },
      },
      'session',
    ],
    [
      'binance_public_rest_24hr_ticker',
      { volume: '12.345', quoteVolume: '999' },
      'rolling_24h',
    ],
    [
      'binance_spot_ws_ticker',
      { provider: 'binance', messageType: 'spot_ws_ticker', streamName: null,
        payload: { e: '24hrTicker', s: 'BTCUSDT', v: '123', q: '999' } },
      'rolling_24h',
    ],
    [
      'binance_spot_ws_ticker',
      { provider: 'binance', messageType: 'spot_ws_ticker', streamName: 'btcusdt@ticker',
        payload: { stream: 'btcusdt@ticker', data: { e: '24hrTicker', s: 'BTCUSDT', v: '123', q: '999' } } },
      'rolling_24h',
    ],
  ])('reads stored quote notional from %s', (source, payload, period) => {
    expect(read(source as string, payload)).toEqual({
      turnover: '999',
      turnoverPeriod: period,
    });
  });
  it('preserves real zero and arbitrary decimal precision', () => {
    expect(
      read('binance_public_rest_24hr_ticker', { quoteVolume: '0' }).turnover,
    ).toBe('0');
    expect(
      read('binance_public_rest_24hr_ticker', {
        quoteVolume: '9007199254740993.12345678',
      }).turnover,
    ).toBe('9007199254740993.12345678');
  });
  it('reads only known ticker frames, without recursive q or base-volume fallback', () => {
    for (const payload of [
      { e: '24hrTicker', v: '999' },
      { q: '999' },
      { e: 'kline', q: '999' },
      { stream: 'btcusdt@kline_1m', data: { e: '24hrTicker', q: '999' } },
      { stream: 42, data: { e: '24hrTicker', q: '999' } },
      { stream: 'btcusdt@ticker', data: { e: 'kline', q: '999' } },
      { stream: 'btcusdt@ticker', data: { e: '24hrTicker', v: '999' }, q: '999' },
      { stream: 'btcusdt@ticker', data: { e: '24hrTicker', nested: { q: '999' } } },
    ]) {
      expect(read('binance_spot_ws_ticker', { messageType: 'spot_ws_ticker', payload })).toEqual({
        turnover: null, turnoverPeriod: null,
      });
    }
    expect(read('binance_spot_ws_ticker', {
      messageType: 'other', payload: { e: '24hrTicker', q: '999' },
    }).turnover).toBeNull();
  });
  it.each(['0', '9007199254740993.12345678', '', '-1', 'NaN', '1e8', null, 42])(
    'validates combined-stream q %s exactly as REST quoteVolume', (q) => {
      expect(read('binance_spot_ws_ticker', {
        messageType: 'spot_ws_ticker',
        payload: { stream: 'btcusdt@ticker', data: { e: '24hrTicker', q, v: '999' } },
      })).toEqual(read('binance_public_rest_24hr_ticker', { quoteVolume: q }));
    },
  );
  it('keeps absent/invalid/truncated/manual/quantity-only evidence unavailable', () => {
    for (const quoteVolume of [
      null,
      undefined,
      '',
      'NaN',
      'Infinity',
      '-1',
      '1e8',
      42,
    ])
      expect(
        read('binance_public_rest_24hr_ticker', { quoteVolume, volume: '100' }),
      ).toEqual({ turnover: null, turnoverPeriod: null });
    expect(read('unknown', { quoteVolume: '100' }).turnover).toBeNull();
    expect(
      read(
        'binance_public_rest_24hr_ticker',
        { quoteVolume: '100' },
        { sourceType: 'admin_manual' },
      ).turnover,
    ).toBeNull();
    expect(
      read(
        'binance_public_rest_24hr_ticker',
        {},
        {
          rawPayloadJson: {
            truncated: true,
            payloadPreview: 'quoteVolume:100',
          },
        },
      ).turnover,
    ).toBeNull();
    expect(
      read('kis_krx_realtime_trade', {
        messageType: 'websocket_trade',
        rawFields: { ACML_VOL: '100' },
      }).turnover,
    ).toBeNull();
    expect(
      read('kis_us_delayed_trade', {
        messageType: 'rest_current_price',
        response: { output: { tvol: '100', last: '100' } },
      }).turnover,
    ).toBeNull();
    expect(readAssetListTurnover(undefined).turnover).toBeNull();
  });
  it.each(['asc', 'desc'] as const)(
    'uses exact Decimal comparisons, null last and symbol/id ties in %s',
    (order) => {
      const a = {
        id: 'b',
        symbol: 'S',
        changeRate: null,
        turnover: '9007199254740993',
      };
      const b = { ...a, id: 'a', turnover: '9007199254740992' };
      expect(compareAssetListMetric(a, b, 'turnover', order)).toBe(
        order === 'asc' ? 1 : -1,
      );
      expect(
        compareAssetListMetric(
          a,
          { ...b, turnover: a.turnover },
          'turnover',
          order,
        ),
      ).toBe(1);
      expect(
        compareAssetListMetric(a, { ...b, turnover: null }, 'turnover', order),
      ).toBe(-1);
      expect(
        compareAssetListMetric({ ...a, turnover: null }, b, 'turnover', order),
      ).toBe(1);
    },
  );
});
