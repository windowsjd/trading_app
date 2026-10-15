import {
  koscomBudgetLimits,
  koscomCallAdmissionLimit,
  koscomP3Cadence,
  koscomPriceSlotPermitted,
  koscomQuotaDayCalendar,
  type KoscomBudgetInput,
} from './koscom-budget-policy';
import {
  KOSCOM_CALL_CATEGORIES,
  type KoscomCallCategory,
} from './koscom-call-context';

const kst = (local: string) => Date.parse(`${local}+09:00`);
const session = {
  openMs: kst('2026-10-15T09:00:00'),
  closeMs: kst('2026-10-15T15:30:00'),
};
const counts = (values: Partial<Record<KoscomCallCategory, number>> = {}) => {
  const out = Object.fromEntries(
    KOSCOM_CALL_CATEGORIES.map((category) => [category, values[category] ?? 0]),
  ) as Record<KoscomCallCategory | 'total', number>;
  out.total = KOSCOM_CALL_CATEGORIES.reduce((sum, c) => sum + out[c], 0);
  return out;
};
const input = (over: Partial<KoscomBudgetInput> = {}): KoscomBudgetInput => ({
  nowMs: kst('2026-10-15T12:00:00'),
  dailyCap: 50_000,
  monthlyCap: 1_000_000,
  day: counts(),
  month: counts(),
  headerRemainingMin: null,
  headerLimit: null,
  session,
  remainingSessions: 12,
  pricePlan: { batches: 6, periodMs: 5_000, assets: 100 },
  ...over,
});

describe('KOSCOM budget governor policy (design v2.1 §7.3)', () => {
  it('admits P1 to the cap, P2 to the hard cap and P3/P4 under the soft cap after their reservations', () => {
    // 12:00 KST: 3 of 6.5 session hours done, 35 ticks of 100 stocks run.
    const day = counts({ price: 12_960, lists: 6, minute: 3_500 });
    const limits = koscomBudgetLimits(input({ day, month: day }));
    expect([limits.effectiveCap, limits.soft, limits.hard]).toEqual([
      50_000, 45_000, 49_000,
    ]);
    // 3.5 h of 6 requests / 5 s left, + expected (normal) non-price P1+P2.
    expect(limits.reserveP1P2).toBe(15_120 + (Math.ceil(100 * 3.131) + 12 - 6));
    // P4 also leaves the bounded-worst P2 and the projected P3 untouched.
    expect(limits.reserveP1P2Worst).toBe(15_120 + (4_680 + 173 - 6));
    expect(limits.reserveP3).toBe(100 * (78 - 35 + 1) + 360);
    expect(limits.limit[1]).toBe(50_000);
    expect(limits.limit[2]).toBe(49_000);
    expect(limits.limit[3]).toBe(45_000 - limits.reserveP1P2);
    expect(limits.limit[4]).toBe(
      45_000 - limits.reserveP1P2Worst - limits.reserveP3,
    );
    expect(
      limits.limit[4] < limits.limit[3] &&
        limits.limit[3] < limits.limit[2] &&
        limits.limit[2] < limits.limit[1],
    ).toBe(true);
    expect(koscomCallAdmissionLimit(limits, 'backfill')).toBe(limits.limit[4]);
    expect(koscomCallAdmissionLimit(limits, 'loc')).toBe(limits.limit[2]);
    expect(koscomCallAdmissionLimit(limits, 'lists')).toBe(limits.limit[1]);
  });

  it('uses the provider header when it is more conservative than the counter (Q7)', () => {
    const day = counts({ price: 30_000 });
    const limits = koscomBudgetLimits(
      input({
        day,
        month: day,
        headerLimit: 40_000,
        headerRemainingMin: 5_000,
      }),
    );
    // Another consumer of the key: the header has 35,000 used, not 30,000.
    expect(limits.used).toBe(35_000);
    // A lower provider limit caps the day.
    expect(limits.effectiveCap).toBe(40_000);
    const lower = koscomBudgetLimits(
      input({
        day,
        month: day,
        headerLimit: 50_000,
        headerRemainingMin: 45_000,
      }),
    );
    expect(lower.used).toBe(30_000);
  });

  it('turns the monthly cap into a daily allowance (calc §3c: 38,000)', () => {
    const day = counts({ price: 1_000 });
    const limits = koscomBudgetLimits(
      input({
        day,
        month: { ...day, total: 600_000 + day.total },
        remainingSessions: 10,
      }),
    );
    expect(limits.effectiveCap).toBe(38_000);
    expect(limits.soft).toBe(34_200);
    expect(limits.hard).toBe(37_240);
    // A spent month stops everything, P1 included.
    const spent = koscomBudgetLimits(
      input({ month: counts({ backfill: 980_000 }), remainingSessions: 3 }),
    );
    expect(spent.effectiveCap).toBe(0);
    expect(spent.limit[1]).toBe(0);
  });

  it('reserves no price after the close and no evidence after midnight', () => {
    const day = counts({ price: 28_080, minute: 7_800, loc: 100 });
    const evening = koscomBudgetLimits(
      input({ nowMs: kst('2026-10-15T20:00:00'), day, month: day }),
    );
    expect(evening.reserveP1P2).toBe(Math.ceil(100 * 3.131) + 12 - 100);
    expect(evening.reserveP3).toBe(0);
    const night = koscomBudgetLimits(
      input({ nowMs: kst('2026-10-16T01:00:00'), day, month: day }),
    );
    expect([
      night.reserveP1P2,
      night.reserveP1P2Worst,
      night.reserveP3,
    ]).toEqual([0, 0, 0]);
    expect(night.limit[4]).toBe(45_000);
    // Repairs keep their reservation for an hour after the close.
    const repairs = koscomBudgetLimits(
      input({ nowMs: kst('2026-10-15T15:50:00'), day, month: day }),
    );
    expect(repairs.reserveP3).toBe(360);
  });

  it('paces price slots above the hard cap and stops them at the cap (§7.6 step 4)', () => {
    const at = (used: number) =>
      koscomBudgetLimits(
        input({
          nowMs: kst('2026-10-15T15:00:00'),
          day: counts({ price: used }),
          month: counts({ price: used }),
        }),
      );
    const permitted = (used: number) =>
      Array.from({ length: 12 }, (_, slot) =>
        koscomPriceSlotPermitted({
          limits: at(used),
          slot,
          periodMs: 5_000,
          nowMs: kst('2026-10-15T15:00:00'),
          session,
          callsPerCycle: 6,
        }),
      ).filter(Boolean).length;
    expect(permitted(48_000)).toBe(12);
    // 600 left for 360 slots of 6 calls: 100 cycles, every 4th slot.
    expect(permitted(49_400)).toBe(3);
    expect(permitted(50_000)).toBe(0);
  });

  it('halves, then stops, the central 1m cadence as P3 stops fitting (§7.6 step 2)', () => {
    const limits = koscomBudgetLimits(input());
    const room = limits.limit[3] - limits.used;
    expect(koscomP3Cadence(limits, room - 1)).toBe('normal');
    expect(koscomP3Cadence(limits, room)).toBe('reduced');
    expect(
      koscomP3Cadence(
        { ...limits, used: limits.limit[3], limit: limits.limit },
        0,
      ),
    ).toBe('blocked');
  });

  it('reads the quota day session and the sessions left in its month from the KRX calendar', () => {
    const thursday = koscomQuotaDayCalendar('2026-10-15');
    expect(thursday.session?.openMs).toBe(session.openMs);
    expect(thursday.session?.closeMs).toBe(session.closeMs);
    // 15, 16, 19–23, 26–30 October 2026.
    expect(thursday.remainingSessions).toBe(12);
    const saturday = koscomQuotaDayCalendar('2026-10-17');
    expect(saturday.session === null).toBe(true);
    expect(saturday.remainingSessions).toBe(10);
    // No 2028 calendar yet: every remaining day counts (smaller allowance).
    expect(koscomQuotaDayCalendar('2028-01-15').remainingSessions).toBe(17);
  });
});
