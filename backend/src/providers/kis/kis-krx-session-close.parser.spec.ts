jest.mock('../../generated/prisma/client', () => {
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
    CurrencyCode: { KRW: 'KRW', USD: 'USD' },
    FxRateSourceType: {
      admin_manual: 'admin_manual',
      official_batch: 'official_batch',
      provider_api: 'provider_api',
    },
    Prisma: { Decimal },
    PrismaClient: class PrismaClient {},
  };
});

import { parseKisKrxSessionCloseResponse } from './kis-krx-session-close.parser';
import {
  applyMarketSessionOverrideSnapshot,
  resetMarketSessionOverrideStoreForTest,
} from '../../orders/market-calendar/market-session-override.store';

const receivedAt = new Date('2026-09-16T07:24:42.850Z');
const row = {
  stck_bsop_date: '20260916',
  stck_oprc: '248000',
  stck_hgpr: '254000',
  stck_lwpr: '247500',
  stck_clpr: '253500',
  acml_vol: '11251311',
  acml_tr_pbmn: '2830288548250',
};
const response = (overrides: Record<string, unknown> = {}) => ({
  rt_cd: '0',
  output1: { stck_shrn_iscd: '005930' },
  output2: [row],
  ...overrides,
});
const parse = (payload: unknown, at = receivedAt) =>
  parseKisKrxSessionCloseResponse({
    response: payload,
    symbol: '005930',
    sessionDate: '2026-09-16',
    receivedAt: at,
  });

describe('KIS completed-session close evidence', () => {
  afterEach(() => resetMarketSessionOverrideStoreForTest());
  it('uses the provider dated close, preserves receipt time, and invents no trade clock', () => {
    const result = parse(response());
    expect(result.price.toFixed(8)).toBe('253500.00000000');
    expect(result.effectiveAt).toEqual(new Date('2026-09-16T06:30:00Z'));
    expect(result.sourceTimestamp).toBeNull();
    expect(result.capturedAt).toEqual(receivedAt);
    expect(result.evidence.row).toEqual(row);
  });
  it('does not reinterpret an actual current-price response as a daily close', () => {
    expect(() =>
      parse({
        rt_cd: '0',
        output: { stck_shrn_iscd: '005930', stck_prpr: '253500' },
      }),
    ).toThrow('KIS_SESSION_CLOSE_SYMBOL_MISMATCH');
  });
  it.each([
    ['provider error', { rt_cd: '1' }, 'KIS_RESPONSE_NOT_SUCCESS'],
    [
      'wrong symbol',
      { output1: { stck_shrn_iscd: '000270' } },
      'KIS_SESSION_CLOSE_SYMBOL_MISMATCH',
    ],
    [
      'missing date',
      { output2: [{ ...row, stck_bsop_date: undefined }] },
      'KIS_SESSION_CLOSE_DATE_MISSING_OR_AMBIGUOUS',
    ],
    [
      'previous date',
      { output2: [{ ...row, stck_bsop_date: '20260915' }] },
      'KIS_SESSION_CLOSE_DATE_MISSING_OR_AMBIGUOUS',
    ],
    [
      'future date',
      { output2: [{ ...row, stck_bsop_date: '20260917' }] },
      'KIS_SESSION_CLOSE_DATE_MISSING_OR_AMBIGUOUS',
    ],
    [
      'ambiguous rows',
      { output2: [row, { ...row, stck_clpr: '250000' }] },
      'KIS_SESSION_CLOSE_DATE_MISSING_OR_AMBIGUOUS',
    ],
    [
      'zero close',
      { output2: [{ ...row, stck_clpr: '0' }] },
      'KIS_SESSION_CLOSE_INVALID_OHLCV',
    ],
    [
      'malformed OHLCV',
      { output2: [{ ...row, stck_hgpr: '1' }] },
      'KIS_SESSION_CLOSE_INVALID_OHLCV',
    ],
  ])('rejects %s', (_name, overrides, code) => {
    expect(() => parse(response(overrides))).toThrow(code);
  });
  it('rejects a provisional intraday daily bar', () => {
    expect(() => parse(response(), new Date('2026-09-16T06:29:59Z'))).toThrow(
      'KIS_SESSION_CLOSE_NOT_COMPLETED',
    );
  });
  it('uses the backend calendar override rather than hardcoded 15:30', () => {
    applyMarketSessionOverrideSnapshot(
      [
        {
          market: 'KRX',
          localDate: '2026-09-16',
          overrideType: 'custom',
          openTime: '100000',
          closeTime: '160000',
          reason: 'test',
        },
      ],
      receivedAt,
    );
    expect(() => parse(response(), new Date('2026-09-16T06:45:00Z'))).toThrow(
      'KIS_SESSION_CLOSE_NOT_COMPLETED',
    );
    expect(parse(response()).effectiveAt).toEqual(
      new Date('2026-09-16T07:00:00Z'),
    );
  });
});
