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
  readAssetListVolume,
} from './asset-list-volume';
const read = (sourceName: string, payload: unknown, extra = {}) =>
  readAssetListVolume({
    sourceType: 'provider_api',
    sourceName,
    rawPayloadJson: { truncated: false, payload },
    ...extra,
  });
describe('provider volume evidence', () => {
  it('reads cumulative KIS shares and Binance rolling base units, never amounts', () => {
    expect(
      read('kis_krx_realtime_trade', {
        messageType: 'websocket_trade',
        rawFields: { ACML_VOL: '123', ACML_TR_PBMN: '999' },
      }),
    ).toEqual({ volume: '123', volumePeriod: 'session' });
    expect(
      read('kis_krx_realtime_trade', {
        messageType: 'rest_session_close',
        evidence: { row: { acml_vol: '456' } },
      }).volume,
    ).toBe('456');
    expect(
      read('kis_us_delayed_trade', {
        messageType: 'websocket_trade',
        rawFields: { TVOL: '789', TAMT: '999' },
      }).volume,
    ).toBe('789');
    expect(
      read('binance_public_rest_24hr_ticker', {
        volume: '12.345',
        quoteVolume: '999',
      }),
    ).toEqual({ volume: '12.345', volumePeriod: 'rolling_24h' });
    expect(
      read('binance_spot_ws_ticker', {
        messageType: 'spot_ws_ticker',
        payload: { v: '0', q: '999' },
      }).volume,
    ).toBe('0');
  });
  it('reads the existing KIS REST current-price shapes without using prior volume or amounts', () => {
    expect(read('kis_krx_realtime_trade', { messageType: 'rest_current_price', response: { output: { acml_vol: '123', acml_tr_pbmn: '999' } } }).volume).toBe('123');
    expect(read('kis_us_delayed_trade', { messageType: 'rest_current_price', response: { output: { tvol: '456', pvol: '1000', tamt: '999' } } }).volume).toBe('456');
  });
  it('keeps missing/truncated/invalid/manual evidence unavailable', () => {
    for (const volume of [
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
        read('binance_public_rest_24hr_ticker', { volume }).volume,
      ).toBeNull();
    expect(read('unknown', { volume: '100' }).volume).toBeNull();
    expect(
      read(
        'binance_public_rest_24hr_ticker',
        { volume: '100' },
        { sourceType: 'admin_manual' },
      ).volume,
    ).toBeNull();
    expect(
      read(
        'binance_public_rest_24hr_ticker',
        {},
        { rawPayloadJson: { truncated: true, payloadPreview: 'volume:100' } },
      ).volume,
    ).toBeNull();
    expect(
      read('kis_krx_realtime_trade', {
        messageType: 'websocket_trade',
        rawFields: { CNTG_VOL: '3', ACML_TR_PBMN: '100' },
      }).volume,
    ).toBeNull();
  });
  it('compares exact large decimals and uses symbol then id for ties', () => {
    const a = {
      id: 'b',
      symbol: 'S',
      changeRate: null,
      volume: '9007199254740993',
    };
    const b = { ...a, id: 'a', volume: '9007199254740992' };
    expect(compareAssetListMetric(a, b, 'volume', 'desc')).toBe(-1);
    expect(
      compareAssetListMetric(a, { ...b, volume: a.volume }, 'volume', 'desc'),
    ).toBe(1);
  });
});
