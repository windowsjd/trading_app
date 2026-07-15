jest.mock('../../../generated/prisma/client', () => {
  const runtime = jest.requireActual<{ Decimal: unknown }>(
    '@prisma/client/runtime/client',
  );
  return { Prisma: { Decimal: runtime.Decimal } };
});

import { KisCandleNormalizerService } from './kis-candle-normalizer.service';
import type { KisRawCandleRow } from './kis-candle.types';

const raw = (
  value: Record<string, unknown>,
  sequence = 0,
): KisRawCandleRow => ({
  value,
  sequence,
  receivedAt: new Date(`2026-07-10T14:00:0${sequence}.000Z`),
});

const us = (
  date: string,
  time: string,
  overrides: Record<string, unknown> = {},
) =>
  raw({
    xymd: date,
    xhms: time,
    open: '100',
    high: '102',
    low: '99',
    last: '101',
    evol: '10',
    eamt: '1000',
    ...overrides,
  });

describe('KisCandleNormalizerService', () => {
  const service = new KisCandleNormalizerService();

  it('normalizes US regular-session boundaries with IANA DST offsets', () => {
    // 2026-03-06 is before the US DST start (2026-03-08): 09:30 ET = 14:30Z.
    // 2026-03-09 is after it: 09:30 ET = 13:30Z. Both are trading days and
    // both wall-clock session opens must be accepted without hardcoded
    // offsets. 2026-11-02 (after DST end on 2026-11-01) maps back to 14:30Z.
    const result = service.normalizeUsFiveMinuteRows({
      rows: [
        us('20260306', '093000'),
        us('20260309', '093000', {}),
        us('20261102', '093000'),
      ],
      from: new Date('2026-03-06T00:00:00Z'),
      to: new Date('2026-11-03T00:00:00Z'),
      now: new Date('2026-11-03T00:00:00Z'),
    });
    expect(result.candles.map((row) => row.openTime.toISOString())).toEqual([
      '2026-03-06T14:30:00.000Z',
      '2026-03-09T13:30:00.000Z',
      '2026-11-02T14:30:00.000Z',
    ]);
    expect(result.integrityFailedRows).toBe(0);
  });

  it('strictly normalizes and deduplicates domestic rows without synthesizing required values', () => {
    const valid = raw({
      stck_bsop_date: '20260710',
      stck_cntg_hour: '090000',
      stck_oprc: '100',
      stck_hgpr: '102',
      stck_lwpr: '99',
      stck_prpr: '101',
      cntg_vol: '10',
    });
    const duplicate = {
      ...valid,
      receivedAt: new Date('2026-07-10T15:00:00Z'),
    };
    const missingVolume = raw({
      ...valid.value,
      stck_cntg_hour: '090100',
      cntg_vol: undefined,
    });
    const result = service.normalizeDomesticOneMinuteRows({
      rows: [valid, duplicate, missingVolume],
      from: new Date('2026-07-10T00:00:00Z'),
      to: new Date('2026-07-10T01:00:00Z'),
      now: new Date('2026-07-10T01:00:00Z'),
    });
    expect(result).toMatchObject({
      acceptedRows: 1,
      rejectedRows: 1,
      duplicateRows: 1,
    });
    expect(result.rows[0].amount).toBeNull();
  });

  it('excludes pre-market, 16:00, after-hours and non-5-minute boundaries', () => {
    const result = service.normalizeUsFiveMinuteRows({
      rows: [
        us('20260710', '092500'),
        us('20260710', '160000'),
        us('20260710', '160500'),
        us('20260710', '093100'),
      ],
      from: new Date('2026-07-10T00:00:00Z'),
      to: new Date('2026-07-11T00:00:00Z'),
      now: new Date('2026-07-11T00:00:00Z'),
    });
    // Pre-market/after-hours rows are benign; the 09:31 row sits INSIDE the
    // regular session off the 5-minute grid, which is corrupt data.
    expect(result).toMatchObject({
      acceptedRows: 0,
      rejectedRows: 4,
      integrityFailedRows: 1,
    });
  });

  it('strictly rejects malformed OHLC, missing volume, negative values, and future rows', () => {
    const result = service.normalizeUsFiveMinuteRows({
      rows: [
        us('20260710', '093000', { high: '98' }),
        us('20260710', '093500', { evol: undefined }),
        us('20260710', '094000', { evol: '-1' }),
        us('20260710', '094500'),
      ],
      from: new Date('2026-07-10T00:00:00Z'),
      to: new Date('2026-07-11T00:00:00Z'),
      now: new Date('2026-07-10T13:44:59Z'),
    });
    // Three regular-session strict-validation failures; the 09:45 row is a
    // not-yet-started future bucket — benign, never an integrity failure.
    expect(result).toMatchObject({
      acceptedRows: 0,
      rejectedRows: 4,
      integrityFailedRows: 3,
    });
  });

  it('treats an unparsable regular-session timestamp as an integrity failure, never benign', () => {
    const result = service.normalizeUsFiveMinuteRows({
      rows: [us('20260710', '093000'), us('garbage', 'alsogarbage')],
      from: new Date('2026-07-10T00:00:00Z'),
      to: new Date('2026-07-11T00:00:00Z'),
      now: new Date('2026-07-11T00:00:00Z'),
    });
    expect(result).toMatchObject({
      acceptedRows: 1,
      rejectedRows: 1,
      integrityFailedRows: 1,
    });
  });

  it('excludes holiday and weekend rows as benign via the market calendar', () => {
    // 2026-07-03 is the observed Independence Day closure; 2026-07-11 is a
    // Saturday. Rows with in-session wall-clock times on those dates are
    // legitimate provider padding, not data corruption — and never accepted.
    const result = service.normalizeUsFiveMinuteRows({
      rows: [
        us('20260703', '093000'),
        us('20260711', '093000'),
        us('20260710', '093000'),
      ],
      from: new Date('2026-07-01T00:00:00Z'),
      to: new Date('2026-07-12T00:00:00Z'),
      now: new Date('2026-07-12T00:00:00Z'),
    });
    expect(result).toMatchObject({
      acceptedRows: 1,
      rejectedRows: 2,
      integrityFailedRows: 0,
    });
    expect(result.candles[0].openTime.toISOString()).toBe(
      '2026-07-10T13:30:00.000Z',
    );
  });

  it('honors early closes from the market calendar without treating the tail as a gap or corruption', () => {
    // 2026-11-27 closes at 13:00 ET (day after Thanksgiving). The 12:55
    // bucket is the last regular-session bucket; 13:00 and later are
    // after-hours — benign exclusions, not integrity failures.
    const result = service.normalizeUsFiveMinuteRows({
      rows: [
        us('20261127', '125500'),
        us('20261127', '130000'),
        us('20261127', '140000'),
      ],
      from: new Date('2026-11-27T00:00:00Z'),
      to: new Date('2026-11-28T00:00:00Z'),
      now: new Date('2026-11-28T00:00:00Z'),
    });
    expect(result).toMatchObject({
      acceptedRows: 1,
      rejectedRows: 2,
      integrityFailedRows: 0,
    });
    expect(result.candles[0].openTime.toISOString()).toBe(
      '2026-11-27T17:55:00.000Z',
    );
  });

  it('keeps missing amount as null, marks current candle open, and deterministically deduplicates timestamps', () => {
    const first = us('20260710', '093000', { eamt: ' ' });
    const newer = {
      ...first,
      receivedAt: new Date('2026-07-10T15:00:00Z'),
      value: { ...first.value, last: '101.5' },
    };
    const result = service.normalizeUsFiveMinuteRows({
      rows: [first, newer],
      from: new Date('2026-07-10T13:30:00Z'),
      to: new Date('2026-07-10T14:00:00Z'),
      now: new Date('2026-07-10T13:32:00Z'),
    });
    expect(result).toMatchObject({ acceptedRows: 1, duplicateRows: 1 });
    expect(result.candles[0].amount).toBeNull();
    expect(result.candles[0].isClosed).toBe(false);
    expect(result.candles[0].close.toString()).toBe('101.5');
    // The in-progress bucket is accepted as current data and never counted
    // as a historical gap or integrity failure.
    expect(result.integrityFailedRows).toBe(0);
  });
});
