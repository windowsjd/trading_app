jest.mock('../../../generated/prisma/client', () => {
  const runtime = jest.requireActual<{ Decimal: unknown }>(
    '@prisma/client/runtime/client',
  );
  return { Prisma: { Decimal: runtime.Decimal } };
});

import { KisPeriodCandleNormalizerService } from './kis-period-candle-normalizer.service';
import type { KisRawCandleRow } from './kis-candle.types';

const domesticRow = (
  date: string,
  overrides: Record<string, unknown> = {},
  receivedAt = new Date('2026-07-10T10:00:00Z'),
): KisRawCandleRow => ({
  value: {
    stck_bsop_date: date,
    stck_clpr: '101',
    stck_oprc: '100',
    stck_hgpr: '102',
    stck_lwpr: '99',
    acml_vol: '1000',
    acml_tr_pbmn: '101000',
    ...overrides,
  },
  receivedAt,
  sequence: 0,
});

const usRow = (
  date: string,
  overrides: Record<string, unknown> = {},
  receivedAt = new Date('2026-07-10T10:00:00Z'),
): KisRawCandleRow => ({
  value: {
    xymd: date,
    clos: '101',
    open: '100',
    high: '102',
    low: '99',
    tvol: '1000',
    tamt: '101000',
    ...overrides,
  },
  receivedAt,
  sequence: 0,
});

describe('KisPeriodCandleNormalizerService', () => {
  const service = new KisPeriodCandleNormalizerService();
  const wideFrom = new Date('2025-01-01T00:00:00Z');
  const wideTo = new Date('2027-01-01T00:00:00Z');

  describe('domestic daily', () => {
    it('anchors candles to the Asia/Seoul trading date and closes them after 15:30 KST', () => {
      const result = service.normalizeDomesticPeriodRows({
        rows: [domesticRow('20260710')],
        interval: '1d',
        from: wideFrom,
        to: wideTo,
        // 15:29 KST on the trading date: not yet closed.
        now: new Date('2026-07-10T06:29:00Z'),
      });
      expect(result.acceptedRows).toBe(1);
      const candle = result.candles[0];
      expect(candle.openTime.toISOString()).toBe('2026-07-09T15:00:00.000Z');
      expect(candle.closeTime.toISOString()).toBe('2026-07-10T15:00:00.000Z');
      expect(candle.isClosed).toBe(false);
      expect(candle.open.toFixed()).toBe('100');
      expect(candle.volume.toFixed()).toBe('1000');
      expect(candle.amount?.toFixed()).toBe('101000');

      const closed = service.normalizeDomesticPeriodRows({
        rows: [domesticRow('20260710')],
        interval: '1d',
        from: wideFrom,
        to: wideTo,
        now: new Date('2026-07-10T06:30:00Z'),
      });
      expect(closed.candles[0].isClosed).toBe(true);
    });

    it('keeps duplicate dates once, preferring the later receivedAt (revised rows win)', () => {
      const result = service.normalizeDomesticPeriodRows({
        rows: [
          domesticRow(
            '20260709',
            { stck_clpr: '100' },
            new Date('2026-07-09T10:00:00Z'),
          ),
          domesticRow(
            '20260709',
            { stck_clpr: '105', stck_hgpr: '106' },
            new Date('2026-07-10T10:00:00Z'),
          ),
        ],
        interval: '1d',
        from: wideFrom,
        to: wideTo,
        now: new Date('2026-07-10T10:00:00Z'),
      });
      expect(result.acceptedRows).toBe(1);
      expect(result.duplicateRows).toBe(1);
      expect(result.candles[0].close.toFixed()).toBe('105');
    });

    it.each([
      ['missing volume', { acml_vol: '' }],
      ['negative volume', { acml_vol: '-1' }],
      ['zero close', { stck_clpr: '0' }],
      ['high below low', { stck_hgpr: '98' }],
      ['low above close', { stck_lwpr: '101.5' }],
      ['malformed amount', { acml_tr_pbmn: 'abc' }],
      ['invalid date', { stck_bsop_date: '20261332' }],
    ])('rejects %s instead of repairing it', (_name, overrides) => {
      const result = service.normalizeDomesticPeriodRows({
        rows: [domesticRow('20260710', overrides)],
        interval: '1d',
        from: wideFrom,
        to: wideTo,
        now: new Date('2026-07-10T10:00:00Z'),
      });
      expect(result.acceptedRows).toBe(0);
      expect(result.rejectedRows).toBe(1);
    });

    it('stores a missing amount as null instead of synthesizing close*volume', () => {
      const result = service.normalizeDomesticPeriodRows({
        rows: [domesticRow('20260710', { acml_tr_pbmn: '' })],
        interval: '1d',
        from: wideFrom,
        to: wideTo,
        now: new Date('2026-07-10T10:00:00Z'),
      });
      expect(result.acceptedRows).toBe(1);
      expect(result.candles[0].amount).toBeNull();
    });

    it('rejects future trading dates and rows outside the target range', () => {
      const result = service.normalizeDomesticPeriodRows({
        rows: [
          domesticRow('20260711'), // openTime in the future relative to now
          domesticRow('20260601'), // fully before from
          domesticRow('20260709'),
        ],
        interval: '1d',
        from: new Date('2026-07-05T00:00:00Z'),
        to: new Date('2026-07-11T00:00:00Z'),
        now: new Date('2026-07-10T10:00:00Z'),
      });
      expect(result.acceptedRows).toBe(1);
      expect(result.rejectedRows).toBe(2);
    });
  });

  describe('domestic weekly', () => {
    it('anchors any reported date to Monday 00:00 KST and closes after Friday 15:30 KST', () => {
      // 2026-07-08 is a Wednesday; its ISO week starts Monday 2026-07-06.
      const result = service.normalizeDomesticPeriodRows({
        rows: [domesticRow('20260708')],
        interval: '1w',
        from: wideFrom,
        to: wideTo,
        now: new Date('2026-07-10T06:29:00Z'), // Friday 15:29 KST
      });
      const candle = result.candles[0];
      expect(candle.openTime.toISOString()).toBe('2026-07-05T15:00:00.000Z');
      expect(candle.closeTime.toISOString()).toBe('2026-07-12T15:00:00.000Z');
      expect(candle.isClosed).toBe(false);

      const closed = service.normalizeDomesticPeriodRows({
        rows: [domesticRow('20260708')],
        interval: '1w',
        from: wideFrom,
        to: wideTo,
        now: new Date('2026-07-10T06:30:00Z'), // Friday 15:30 KST
      });
      expect(closed.candles[0].isClosed).toBe(true);
    });

    it('merges rows from the same week into a single anchored candle', () => {
      const result = service.normalizeDomesticPeriodRows({
        rows: [
          domesticRow('20260706', {}, new Date('2026-07-06T10:00:00Z')),
          domesticRow(
            '20260710',
            { stck_clpr: '110', stck_hgpr: '111' },
            new Date('2026-07-10T10:00:00Z'),
          ),
        ],
        interval: '1w',
        from: wideFrom,
        to: wideTo,
        now: new Date('2026-07-11T10:00:00Z'),
      });
      expect(result.acceptedRows).toBe(1);
      expect(result.duplicateRows).toBe(1);
      expect(result.candles[0].close.toFixed()).toBe('110');
    });
  });

  describe('US daily and weekly (America/New_York, DST-aware)', () => {
    it('spans 24 hours on a standard-time date', () => {
      const result = service.normalizeOverseasPeriodRows({
        rows: [usRow('20260306')],
        interval: '1d',
        from: wideFrom,
        to: wideTo,
        now: new Date('2026-07-01T00:00:00Z'),
      });
      const candle = result.candles[0];
      // EST is UTC-5 before the 2026-03-08 spring-forward.
      expect(candle.openTime.toISOString()).toBe('2026-03-06T05:00:00.000Z');
      expect(candle.closeTime.toISOString()).toBe('2026-03-07T05:00:00.000Z');
      expect(candle.isClosed).toBe(true);
    });

    it('spans 23 hours across the spring-forward date instead of using a fixed UTC offset', () => {
      const result = service.normalizeOverseasPeriodRows({
        rows: [usRow('20260308')],
        interval: '1d',
        from: wideFrom,
        to: wideTo,
        now: new Date('2026-07-01T00:00:00Z'),
      });
      const candle = result.candles[0];
      expect(candle.openTime.toISOString()).toBe('2026-03-08T05:00:00.000Z');
      // Next midnight is EDT (UTC-4): only 23 hours later.
      expect(candle.closeTime.toISOString()).toBe('2026-03-09T04:00:00.000Z');
      expect(candle.closeTime.getTime() - candle.openTime.getTime()).toBe(
        23 * 60 * 60 * 1000,
      );
    });

    it('closes a daily candle only after 16:00 New York time', () => {
      const beforeClose = service.normalizeOverseasPeriodRows({
        rows: [usRow('20260709')],
        interval: '1d',
        from: wideFrom,
        to: wideTo,
        now: new Date('2026-07-09T19:59:00Z'), // 15:59 EDT
      });
      expect(beforeClose.candles[0].isClosed).toBe(false);
      const afterClose = service.normalizeOverseasPeriodRows({
        rows: [usRow('20260709')],
        interval: '1d',
        from: wideFrom,
        to: wideTo,
        now: new Date('2026-07-09T20:00:00Z'), // 16:00 EDT
      });
      expect(afterClose.candles[0].isClosed).toBe(true);
    });

    it('anchors weekly candles to Monday 00:00 New York across the DST transition', () => {
      const result = service.normalizeOverseasPeriodRows({
        rows: [usRow('20260311')], // Wednesday after spring-forward
        interval: '1w',
        from: wideFrom,
        to: wideTo,
        now: new Date('2026-07-01T00:00:00Z'),
      });
      const candle = result.candles[0];
      // Monday 2026-03-09 00:00 EDT (UTC-4).
      expect(candle.openTime.toISOString()).toBe('2026-03-09T04:00:00.000Z');
      expect(candle.closeTime.toISOString()).toBe('2026-03-16T04:00:00.000Z');
      expect(candle.isClosed).toBe(true);
    });

    it('stores missing tamt as null (some exchanges omit the traded amount)', () => {
      const result = service.normalizeOverseasPeriodRows({
        rows: [usRow('20260709', { tamt: '' })],
        interval: '1d',
        from: wideFrom,
        to: wideTo,
        now: new Date('2026-07-10T00:00:00Z'),
      });
      expect(result.acceptedRows).toBe(1);
      expect(result.candles[0].amount).toBeNull();
    });

    it('keeps the boundary candle whose window intersects the range start', () => {
      // from falls mid-week: the week candle opening before `from` still
      // intersects [from, to) and must not be dropped.
      const result = service.normalizeOverseasPeriodRows({
        rows: [usRow('20260707')],
        interval: '1w',
        from: new Date('2026-07-08T00:00:00Z'),
        to: new Date('2026-08-01T00:00:00Z'),
        now: new Date('2026-07-31T00:00:00Z'),
      });
      expect(result.acceptedRows).toBe(1);
      expect(result.candles[0].openTime.getTime()).toBeLessThan(
        new Date('2026-07-08T00:00:00Z').getTime(),
      );
    });
  });
});
