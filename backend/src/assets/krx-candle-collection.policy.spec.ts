import { resolveMarketSession } from '../orders/market-calendar.policy';
import {
  applyMarketSessionOverrideSnapshot,
  resetMarketSessionOverrideStoreForTest,
} from '../orders/market-calendar/market-session-override.store';
import {
  FIVE_MINUTES_MS,
  krxDailyBridge,
  krxFiveMinuteBridge,
  krxIntradayTickTimes,
  krxSessionSlotState,
  nextKrxCentralRun,
  planKrxIntradayWindow,
  planKrxRepairWindow,
  requiredFiveMinuteSlotStarts,
  type KrxCheckpointRow,
} from './krx-candle-collection.policy';

const at = (iso: string) => Date.parse(iso);
const kst = (local: string) => at(`${local}+09:00`);
const session = (date: string) => resolveMarketSession('KRX', date)!;

function proof(fromLocal: string, toLocal: string, createdLocal: string) {
  return row({
    coveredFrom: new Date(kst(fromLocal)),
    coveredTo: new Date(kst(toLocal)),
    targetFrom: new Date(kst(fromLocal)),
    targetTo: new Date(kst(toLocal)),
    createdAt: new Date(kst(createdLocal)),
  });
}

/** An audited run that found `missingLocal` as its first unproven slot. */
function miss(
  missingLocal: string,
  createdLocal: string,
  phase: 'intraday' | 'repair' = 'intraday',
) {
  return row({
    coverageComplete: false,
    targetFrom: new Date(kst(missingLocal) - FIVE_MINUTES_MS),
    targetTo: new Date(kst(createdLocal)),
    createdAt: new Date(kst(createdLocal)),
    auditPhase: phase,
    auditFirstMissingMs: kst(missingLocal),
  });
}

function row(overrides: Partial<KrxCheckpointRow>): KrxCheckpointRow {
  return {
    mode: 'repair',
    status: 'completed',
    coverageComplete: true,
    targetFrom: new Date(0),
    targetTo: new Date(0),
    coveredFrom: null,
    coveredTo: null,
    createdAt: new Date(0),
    auditPhase: null,
    auditFirstMissingMs: null,
    ...overrides,
  };
}

describe('KRX required slots and ticks', () => {
  it('requires 76 slots on a regular day and never the 10-minute closing auction', () => {
    const slots = requiredFiveMinuteSlotStarts(session('20261015'));
    expect(slots.length).toBe(76);
    expect(new Date(slots[slots.length - 1]).toISOString()).toBe(
      '2026-10-15T06:15:00.000Z', // 15:15 KST; 15:20/15:25 are the auction
    );
  });

  it('follows calendar overrides: CSAT day 10:00–16:30 and the 10:00 New Year open', () => {
    const csat = requiredFiveMinuteSlotStarts(session('20261119'));
    expect(new Date(csat[0]).toISOString()).toBe('2026-11-19T01:00:00.000Z');
    expect(new Date(csat[csat.length - 1]).toISOString()).toBe(
      '2026-11-19T07:15:00.000Z', // 16:15; 16:20/16:25 are the auction
    );
    expect(requiredFiveMinuteSlotStarts(session('20260102')).length).toBe(64);
  });

  it('ticks at every bucket end + delay, the last one at the close', () => {
    const ticks = krxIntradayTickTimes(session('20261015'), 70_000);
    expect(ticks.length).toBe(78);
    expect(new Date(ticks[0]).toISOString()).toBe('2026-10-15T00:06:10.000Z');
    expect(new Date(ticks[ticks.length - 1]).toISOString()).toBe(
      '2026-10-15T06:31:10.000Z',
    );
  });

  it('schedules post-close repair/daily phases, skips weekends, and stops at a calendar gap', () => {
    const afterClose = nextKrxCentralRun(kst('2026-10-16T15:31:11'), 70_000);
    expect(afterClose?.phase).toBe('repair');
    expect(new Date(afterClose!.atMs).toISOString()).toBe(
      '2026-10-16T06:40:00.000Z',
    );
    const weekend = nextKrxCentralRun(kst('2026-10-16T23:00:00'), 70_000);
    expect(weekend?.session.localDate).toBe('2026-10-19');
    expect(weekend?.phase).toBe('intraday');
    expect(nextKrxCentralRun(kst('2027-12-30T20:00:00'), 70_000)).toBeNull();
  });
});

describe('KRX 5m holiday bridge (design v2.1 §4.2 rule 7)', () => {
  afterEach(() => resetMarketSessionOverrideStoreForTest());
  const bridge = (nowLocal: string) => krxFiveMinuteBridge(kst(nowLocal));

  it('connects a weekday night, a weekend and the closing auction', () => {
    const night = bridge('2026-10-16T09:03:00');
    // 15:31 Thu → 09:03 Fri: no closed required slot.
    expect(night(kst('2026-10-15T15:20:00'), kst('2026-10-16T09:03:00'))).toBe(
      kst('2026-10-16T09:03:00'),
    );
    const weekend = bridge('2026-10-19T09:04:59');
    expect(
      weekend(kst('2026-10-16T15:21:10'), kst('2026-10-19T09:04:59')),
    ).toBe(kst('2026-10-19T09:04:59'));
  });

  it('connects the Chuseok block, but not a missing slot right after it', () => {
    // 2026-09-23 close → 09-28 (24/25 Chuseok, 26/27 weekend).
    const before = bridge('2026-09-28T09:02:00');
    expect(before(kst('2026-09-23T15:20:00'), kst('2026-09-28T09:02:00'))).toBe(
      kst('2026-09-28T09:02:00'),
    );
    const after = bridge('2026-09-28T09:12:00');
    expect(after(kst('2026-09-23T15:20:00'), kst('2026-09-28T09:12:00'))).toBe(
      kst('2026-09-28T09:00:00'),
    );
  });

  it('treats an operator temporary closure as a holiday (override layer)', () => {
    applyMarketSessionOverrideSnapshot(
      [
        {
          market: 'KRX',
          localDate: '2026-10-15',
          overrideType: 'closed',
          openTime: null,
          closeTime: null,
          reason: 'temporary closure',
        },
      ],
      new Date(),
    );
    const temp = bridge('2026-10-16T09:01:00');
    expect(temp(kst('2026-10-14T15:20:00'), kst('2026-10-16T09:01:00'))).toBe(
      kst('2026-10-16T09:01:00'),
    );
  });

  it('starts CSAT day at 10:00 and keeps its 16:20/16:25 auction unproven-free', () => {
    const csat = bridge('2026-11-19T10:04:00');
    expect(csat(kst('2026-11-18T15:20:00'), kst('2026-11-19T10:04:00'))).toBe(
      kst('2026-11-19T10:04:00'),
    );
    const close = bridge('2026-11-19T16:40:00');
    expect(close(kst('2026-11-19T16:20:00'), kst('2026-11-19T16:40:00'))).toBe(
      kst('2026-11-19T16:40:00'),
    );
  });

  it('never bridges a closed required slot, only up to it', () => {
    const open = bridge('2026-10-15T10:21:00');
    expect(open(kst('2026-10-15T10:05:00'), kst('2026-10-15T10:21:00'))).toBe(
      kst('2026-10-15T10:05:00'),
    );
    // The still-open current bucket needs no proof.
    expect(open(kst('2026-10-15T10:20:00'), kst('2026-10-15T10:21:00'))).toBe(
      kst('2026-10-15T10:21:00'),
    );
  });

  it('fails closed on a date without a calendar dataset', () => {
    const uncovered = krxFiveMinuteBridge(at('2028-01-05T03:00:00Z'));
    expect(
      uncovered(at('2027-12-30T07:00:00Z'), at('2028-01-05T03:00:00Z')),
    ).toBe(at('2027-12-30T07:00:00Z'));
  });
});

describe('KRX 1d holiday bridge', () => {
  it('connects the night and weekend, but stops at the day of an unconfirmed close', () => {
    const friday = krxDailyBridge(kst('2026-10-19T10:00:00'));
    expect(friday(kst('2026-10-16T15:51:00'), kst('2026-10-19T10:00:00'))).toBe(
      kst('2026-10-19T10:00:00'),
    );
    const afterClose = krxDailyBridge(kst('2026-10-19T15:40:00'));
    expect(
      afterClose(kst('2026-10-16T15:51:00'), kst('2026-10-19T15:40:00')),
    ).toBe(kst('2026-10-19T00:00:00'));
  });
});

describe('KRX intraday window planner', () => {
  const day = session('20261015');
  const A = kst('2026-10-15T00:00:00');

  it('starts from the frontier, one page, and claims nothing beyond now', () => {
    const plan = planKrxIntradayWindow({
      session: day,
      nowMs: kst('2026-10-15T10:21:10'),
      rows: [
        proof(
          '2026-10-15T09:00:00',
          '2026-10-15T10:16:10',
          '2026-10-15T10:16:10',
        ),
      ],
      obligationStartMs: A,
    });
    expect(new Date(plan!.fromMs).toISOString()).toBe(
      '2026-10-15T01:15:00.000Z',
    );
    expect(plan!.toMs).toBe(kst('2026-10-15T10:21:10'));
    expect(plan!.state.unproven.length).toBe(1); // 10:15 just closed
  });

  it('caps the window at 90 minutes after an outage', () => {
    const plan = planKrxIntradayWindow({
      session: day,
      nowMs: kst('2026-10-15T13:01:10'),
      rows: [
        proof(
          '2026-10-15T09:00:00',
          '2026-10-15T10:01:10',
          '2026-10-15T10:01:10',
        ),
      ],
      obligationStartMs: A,
    });
    expect(plan!.toMs - plan!.fromMs <= 95 * 60_000).toBe(true);
    expect(new Date(plan!.fromMs).toISOString()).toBe(
      '2026-10-15T02:30:00.000Z',
    );
  });

  it('holds a slot after two audited misses and starts after it; a failed run is no attempt', () => {
    const rows = [
      proof(
        '2026-10-15T09:00:00',
        '2026-10-15T10:15:00',
        '2026-10-15T10:21:10',
      ),
      miss('2026-10-15T10:15:00', '2026-10-15T10:21:10'),
      row({
        status: 'failed',
        coverageComplete: false,
        targetFrom: new Date(kst('2026-10-15T10:15:00')),
        targetTo: new Date(kst('2026-10-15T10:26:10')),
        createdAt: new Date(kst('2026-10-15T10:26:10')),
      }),
    ];
    const notYet = planKrxIntradayWindow({
      session: day,
      nowMs: kst('2026-10-15T10:31:10'),
      rows,
      obligationStartMs: A,
    });
    expect(notYet!.state.held.length).toBe(0);
    expect(new Date(notYet!.fromMs).toISOString()).toBe(
      '2026-10-15T01:15:00.000Z',
    );
    const held = planKrxIntradayWindow({
      session: day,
      nowMs: kst('2026-10-15T10:36:10'),
      rows: [...rows, miss('2026-10-15T10:15:00', '2026-10-15T10:31:10')],
      obligationStartMs: A,
    });
    expect(held!.state.held).toEqual([kst('2026-10-15T10:15:00')]);
    expect(new Date(held!.fromMs).toISOString()).toBe(
      '2026-10-15T01:20:00.000Z',
    );
  });

  it('moves past every held hole, not only the first after the frontier', () => {
    const rows = [
      proof(
        '2026-10-15T09:00:00',
        '2026-10-15T10:00:00',
        '2026-10-15T10:06:10',
      ),
      miss('2026-10-15T10:00:00', '2026-10-15T10:06:10'),
      miss('2026-10-15T10:00:00', '2026-10-15T10:11:10'),
      proof(
        '2026-10-15T10:05:00',
        '2026-10-15T10:30:00',
        '2026-10-15T10:36:10',
      ),
      miss('2026-10-15T10:30:00', '2026-10-15T10:36:10'),
      miss('2026-10-15T10:30:00', '2026-10-15T10:41:10'),
    ];
    const plan = planKrxIntradayWindow({
      session: day,
      nowMs: kst('2026-10-15T10:46:10'),
      rows,
      obligationStartMs: A,
    });
    expect(plan!.state.held).toEqual([
      kst('2026-10-15T10:00:00'),
      kst('2026-10-15T10:30:00'),
    ]);
    expect(new Date(plan!.fromMs).toISOString()).toBe(
      '2026-10-15T01:35:00.000Z',
    );
  });

  it('owes nothing before the obligation start A', () => {
    const state = krxSessionSlotState({
      session: day,
      nowMs: kst('2026-10-15T15:40:00'),
      rows: [],
      obligationStartMs: kst('2026-10-15T13:00:00'),
    });
    expect(new Date(state.unproven[0]).toISOString()).toBe(
      '2026-10-15T04:00:00.000Z',
    );
    expect(state.unproven.length).toBe(28);
  });
});

describe('KRX post-close repair window', () => {
  const day = session('20261015');
  const A = kst('2026-10-15T00:00:00');
  const base = [
    proof('2026-10-15T09:00:00', '2026-10-15T10:15:00', '2026-10-15T10:21:10'),
    proof('2026-10-15T10:30:00', '2026-10-15T15:31:10', '2026-10-15T15:31:10'),
  ];

  it('re-requests the hole and skips a slot already missed twice after the close', () => {
    const now = kst('2026-10-15T15:40:00');
    const first = planKrxRepairWindow({
      session: day,
      nowMs: now,
      rows: base,
      obligationStartMs: A,
    });
    expect([first!.fromMs, first!.toMs]).toEqual([
      kst('2026-10-15T10:15:00'),
      kst('2026-10-15T10:30:00'),
    ]);
    const twice = [
      ...base,
      miss('2026-10-15T10:15:00', '2026-10-15T15:40:01', 'repair'),
      miss('2026-10-15T10:15:00', '2026-10-15T16:10:01', 'repair'),
    ];
    const next = planKrxRepairWindow({
      session: day,
      nowMs: kst('2026-10-15T16:20:00'),
      rows: twice,
      obligationStartMs: A,
    });
    expect([next!.fromMs, next!.toMs]).toEqual([
      kst('2026-10-15T10:20:00'),
      kst('2026-10-15T10:30:00'),
    ]);
  });
});
