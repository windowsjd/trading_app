jest.mock('../generated/prisma/client', () => {
  const runtime = jest.requireActual<{ Decimal: unknown }>(
    '@prisma/client/runtime/client',
  );
  return {
    PrismaClient: class PrismaClient {},
    Prisma: { Decimal: runtime.Decimal },
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
  };
});

import { resolveMarketSession } from '../orders/market-calendar.policy';
import {
  planKrxTenMinuteBuckets,
  verifyKrxTenMinuteSession,
  type KrxTenMinuteRow,
} from './market-candle-krx-history';

const TEN_MIN = 10 * 60_000;

function session(date: string) {
  const resolved = resolveMarketSession('KRX', date);
  if (!resolved) throw new Error(`no KRX session on ${date}`);
  return resolved;
}

/**
 * Deterministic END-labelled rows for a whole session: row i opens at
 * 10000 + i, closes at 10000 + i + 1, high = close + 5, low = open - 5.
 * The final (auction) row is a single price, like the live 15:30 row.
 */
function sessionRows(
  date: string,
  options: { auction?: boolean; dropLabels?: string[] } = {},
): KrxTenMinuteRow[] {
  const s = session(date);
  const rows: KrxTenMinuteRow[] = [];
  let index = 0;
  for (
    let label = s.openTime.getTime() + TEN_MIN;
    label <= s.closeTime.getTime();
    label += TEN_MIN
  ) {
    const isAuction = label === s.closeTime.getTime();
    if (isAuction && options.auction === false) continue;
    const hhmm = new Date(label + 9 * 3600_000).toISOString().slice(11, 16);
    if (options.dropLabels?.includes(hhmm)) {
      index += 1;
      continue;
    }
    const open = 10000 + index;
    const close = isAuction ? open : open + 1;
    rows.push({
      label: new Date(label),
      open: String(open),
      high: String(isAuction ? open : close + 5),
      low: String(isAuction ? open : open - 5),
      close: String(close),
      volume: '100',
      amount: String(100 * open),
    });
    index += 1;
  }
  return rows;
}

function dailyOf(rows: readonly KrxTenMinuteRow[], volume?: string) {
  const highs = rows.map((r) => Number(r.high));
  const lows = rows.map((r) => Number(r.low));
  return {
    open: rows[0].open,
    high: String(Math.max(...highs)),
    low: String(Math.min(...lows)),
    close: rows[rows.length - 1].close,
    volume: volume ?? String(rows.length * 100),
  };
}

const receivedAt = new Date('2026-10-13T07:20:00.000Z');

describe('KRX 10-minute history → 4h', () => {
  it('plans the regular session as 24 + 14 required END labels with 15:30 optional', () => {
    const buckets = planKrxTenMinuteBuckets(session('20261012'));
    expect(buckets.length).toBe(2);
    expect(buckets[0].requiredLabels.length).toBe(24);
    expect(buckets[0].optionalLabels.length).toBe(0);
    expect(buckets[1].requiredLabels.length).toBe(14);
    expect(buckets[1].optionalLabels.length).toBe(1);
    expect(buckets[0].openTime.toISOString()).toBe('2026-10-12T00:00:00.000Z');
    expect(buckets[0].closeTime.toISOString()).toBe('2026-10-12T04:00:00.000Z');
    expect(buckets[1].closeTime.toISOString()).toBe('2026-10-12T06:30:00.000Z');
    expect(new Date(buckets[1].optionalLabels[0]).toISOString()).toBe(
      '2026-10-12T06:30:00.000Z',
    );
  });

  it('follows the calendar for the CSAT 10:00–16:30 session instead of assuming 09:00–15:30', () => {
    const buckets = planKrxTenMinuteBuckets(session('20261119'));
    expect(buckets[0].openTime.toISOString()).toBe('2026-11-19T01:00:00.000Z');
    expect(buckets[0].requiredLabels.length).toBe(24);
    expect(buckets[1].requiredLabels.length).toBe(14);
    expect(new Date(buckets[1].optionalLabels[0]).toISOString()).toBe(
      '2026-11-19T07:30:00.000Z',
    );
  });

  it('verifies the measured shape (39 rows, 09:10–15:30) against the dated daily bar', () => {
    const rows = sessionRows('20261012');
    expect(rows.length).toBe(39);
    const verdict = verifyKrxTenMinuteSession({
      session: session('20261012'),
      rows,
      invalidRows: 0,
      daily: dailyOf(rows),
      receivedAt,
    });
    expect(verdict.status).toBe('verified');
    if (verdict.status !== 'verified') return;
    expect(verdict.candles.length).toBe(2);
    expect(verdict.auctionRowPresent).toBe(true);
    expect(verdict.volumeRelation).toBe('equal');
    const [first, second] = verdict.candles;
    // First bucket: rows 0..23; second: rows 24..38 incl. the auction print.
    expect(first.open.toString()).toBe('10000');
    expect(first.close.toString()).toBe('10024');
    expect(first.volume.toString()).toBe('2400');
    expect(second.open.toString()).toBe('10024');
    expect(second.close.toString()).toBe('10038');
    expect(second.volume.toString()).toBe('1500');
    expect(second.closeTime.toISOString()).toBe('2026-10-12T06:30:00.000Z');
    expect(first.sourceUpdatedAt.getTime()).toBe(receivedAt.getTime());
  });

  it('keeps both buckets complete when only the optional 15:30 auction row is absent', () => {
    const rows = sessionRows('20261012', { auction: false });
    expect(rows.length).toBe(38);
    const verdict = verifyKrxTenMinuteSession({
      session: session('20261012'),
      rows,
      invalidRows: 0,
      daily: dailyOf(rows),
      receivedAt,
    });
    expect(verdict.status).toBe('verified');
    expect(verdict.status === 'verified' && verdict.auctionRowPresent).toBe(
      false,
    );
  });

  it('never lets the optional auction row stand in for a missing required row', () => {
    const rows = sessionRows('20261012', { dropLabels: ['11:30'] });
    const verdict = verifyKrxTenMinuteSession({
      session: session('20261012'),
      rows,
      invalidRows: 0,
      daily: dailyOf(rows),
      receivedAt,
    });
    expect(verdict.status === 'held' && verdict.reason).toBe(
      'MISSING_REQUIRED_ROWS',
    );
  });

  it('holds a session whose aggregate O/H/L/C differs from the dated daily bar', () => {
    const rows = sessionRows('20261012');
    const daily = { ...dailyOf(rows), close: '99999' };
    const verdict = verifyKrxTenMinuteSession({
      session: session('20261012'),
      rows,
      invalidRows: 0,
      daily,
      receivedAt,
    });
    expect(verdict.status === 'held' && verdict.reason).toBe(
      'DAILY_OHLC_MISMATCH',
    );
  });

  it('records a volume difference without discarding an OHLC-verified session', () => {
    const rows = sessionRows('20261012');
    const less = verifyKrxTenMinuteSession({
      session: session('20261012'),
      rows,
      invalidRows: 0,
      daily: dailyOf(rows, '999999'),
      receivedAt,
    });
    expect(less.status === 'verified' && less.volumeRelation).toBe(
      'session_less',
    );
    const greater = verifyKrxTenMinuteSession({
      session: session('20261012'),
      rows,
      invalidRows: 0,
      daily: dailyOf(rows, '1'),
      receivedAt,
    });
    expect(greater.status === 'verified' && greater.volumeRelation).toBe(
      'session_greater',
    );
  });

  it('rejects a previous-session re-return (the 10-09 holiday returned 10-08 verbatim)', () => {
    // The holiday itself is never requested (calendar). The failure mode a
    // trading day must survive is the provider handing back the PREVIOUS
    // session: the rows then match the previous day's daily bar, not this one.
    const previousRows = sessionRows('20261008');
    const shifted = previousRows.map((row) => ({
      ...row,
      label: new Date(row.label.getTime() + 4 * 86_400_000),
    }));
    const thisDaily = { ...dailyOf(previousRows), open: '20000' };
    const verdict = verifyKrxTenMinuteSession({
      session: session('20261012'),
      rows: shifted,
      invalidRows: 0,
      daily: thisDaily,
      receivedAt,
    });
    expect(verdict.status === 'held' && verdict.reason).toBe(
      'DAILY_OHLC_MISMATCH',
    );
  });

  it('holds a session whose 4h result repeats the stored previous session', () => {
    const rows = sessionRows('20261012');
    const first = verifyKrxTenMinuteSession({
      session: session('20261012'),
      rows,
      invalidRows: 0,
      daily: dailyOf(rows),
      receivedAt,
    });
    if (first.status !== 'verified') throw new Error('fixture must verify');
    const verdict = verifyKrxTenMinuteSession({
      session: session('20261012'),
      rows,
      invalidRows: 0,
      daily: dailyOf(rows),
      receivedAt,
      previousSessionCandles: first.candles,
    });
    expect(verdict.status === 'held' && verdict.reason).toBe(
      'REPEATED_ADJACENT_SESSION',
    );
  });

  it('dedupes identical duplicate rows but holds conflicting ones', () => {
    const rows = sessionRows('20261012');
    const identical = verifyKrxTenMinuteSession({
      session: session('20261012'),
      rows: [...rows, { ...rows[5] }],
      invalidRows: 0,
      daily: dailyOf(rows),
      receivedAt,
    });
    expect(identical.status === 'verified' && identical.duplicateRows).toBe(1);
    const conflicting = verifyKrxTenMinuteSession({
      session: session('20261012'),
      rows: [...rows, { ...rows[5], close: '1' }],
      invalidRows: 0,
      daily: dailyOf(rows),
      receivedAt,
    });
    expect(conflicting.status === 'held' && conflicting.reason).toBe(
      'CONFLICTING_DUPLICATE_ROWS',
    );
  });

  it('holds pre-open, off-grid, unparsable, empty and possibly truncated responses', () => {
    const s = session('20261012');
    const rows = sessionRows('20261012');
    const base = {
      session: s,
      invalidRows: 0,
      daily: dailyOf(rows),
      receivedAt,
    };
    const preOpen = { ...rows[0], label: new Date(s.openTime.getTime()) };
    expect(
      ((v) => (v.status === 'held' ? v.reason : v.status))(
        verifyKrxTenMinuteSession({ ...base, rows: [preOpen, ...rows] }),
      ),
    ).toBe('OFF_GRID_ROWS');
    const offGrid = {
      ...rows[3],
      label: new Date(rows[3].label.getTime() + 5 * 60_000),
    };
    expect(
      ((v) => (v.status === 'held' ? v.reason : v.status))(
        verifyKrxTenMinuteSession({ ...base, rows: [...rows, offGrid] }),
      ),
    ).toBe('OFF_GRID_ROWS');
    expect(
      ((v) => (v.status === 'held' ? v.reason : v.status))(
        verifyKrxTenMinuteSession({ ...base, rows, invalidRows: 1 }),
      ),
    ).toBe('MALFORMED_ROWS');
    expect(
      ((v) => (v.status === 'held' ? v.reason : v.status))(
        verifyKrxTenMinuteSession({ ...base, rows: [] }),
      ),
    ).toBe('NO_ROWS');
    expect(
      ((v) => (v.status === 'held' ? v.reason : v.status))(
        verifyKrxTenMinuteSession({ ...base, rows, invalidRows: 61 }),
      ),
    ).toBe('TOO_MANY_ROWS');
  });

  it('builds the CSAT-day buckets from the shifted grid', () => {
    const rows = sessionRows('20261119');
    const verdict = verifyKrxTenMinuteSession({
      session: session('20261119'),
      rows,
      invalidRows: 0,
      daily: dailyOf(rows),
      receivedAt,
    });
    expect(verdict.status).toBe('verified');
    if (verdict.status !== 'verified') return;
    expect(verdict.candles.map((c) => c.openTime.toISOString())).toEqual([
      '2026-11-19T01:00:00.000Z',
      '2026-11-19T05:00:00.000Z',
    ]);
  });
});
