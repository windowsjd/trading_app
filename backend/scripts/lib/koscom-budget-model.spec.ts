import { resolveMarketSession } from '../../src/orders/market-calendar.policy';
import {
  batchRange,
  finalDesign,
  governorDemo,
  MONTHLY_CAP,
  replayDay,
  replayEvents,
  SESSIONS_ROLLING_31,
} from './koscom-budget-model';

const MIN = 60_000;
const round = (x: number) => Math.round(x);
const day = resolveMarketSession('KRX', '20261015')!;
const session = {
  openMs: day.openTime.getTime(),
  closeMs: day.closeTime.getTime(),
};
const plan = { batches: 6, periodMs: 5_000, assets: 100 };

describe('KOSCOM call-volume model (design v2.1 §7.2, calc/koscom_budget.py)', () => {
  // [N, normal lo, normal hi, worst (hi), month normal (hi), rolling 31 d]
  it.each([
    [5, 15, 5_955, 10_635, 11_750, 234_076, 244_699],
    [5, 25, 11_477, 16_157, 17_909, 355_557, 371_701],
    [5, 50, 18_261, 22_941, 26_285, 504_818, 527_747],
    [5, 100, 31_830, 36_510, 43_037, 803_339, 839_838],
    [6, 15, 5_175, 9_075, 10_190, 199_756, 208_819],
    [6, 25, 9_917, 13_817, 15_569, 304_077, 317_881],
    [6, 50, 15_921, 19_821, 23_165, 436_178, 455_987],
    [6, 100, 27_930, 31_830, 38_357, 700_379, 732_198],
  ])(
    'price %ss, N=%s reproduces the published table',
    (priceS, n, lo, hi, worst, month, rolling) => {
      const [bLo, bHi] = batchRange(n);
      expect(round(finalDesign(n, bLo, { priceS }).trading)).toBe(lo);
      const high = finalDesign(n, bHi, { priceS });
      expect(round(high.trading)).toBe(hi);
      expect(round(finalDesign(n, bHi, { priceS, worst: true }).trading)).toBe(
        worst,
      );
      expect(round(high.monthly())).toBe(month);
      expect(
        round(high.monthly(SESSIONS_ROLLING_31, 31 - SESSIONS_ROLLING_31)),
      ).toBe(rolling);
    },
  );

  it('reproduces the 100-stock, 6-batch, 5 s breakdown and the worst month', () => {
    const parts = (model: ReturnType<typeof finalDesign>) =>
      model.parts.map((part) => round(part.trading));
    expect(parts(finalDesign(100, 6))).toEqual([
      28_080, 12, 111, 202, 0, 7_979, 5, 101, 20,
    ]);
    expect(parts(finalDesign(100, 6, { worst: true }))).toEqual([
      28_080, 173, 360, 3_960, 360, 9_480, 360, 240, 24,
    ]);
    const worstMonth =
      22 * finalDesign(100, 6, { worst: true }).trading + 9 * 144 * 1.2;
    expect(round(worstMonth)).toBe(948_365);
    expect(worstMonth / MONTHLY_CAP > 0.9).toBe(true);
  });

  it('reproduces the governor demo allocations (calc §3)', () => {
    const worst = governorDemo(finalDesign(100, 6, { worst: true }), 10_000);
    expect(round(worst.reserve)).toBe(32_933);
    expect(round(worst.p3)).toBe(9_840);
    expect(round(worst.p4)).toBe(2_227);
    expect(round(worst.total)).toBe(45_000);
    expect(round(worst.shed)).toBe(8_037);
    const normal = governorDemo(finalDesign(100, 6), 10_000);
    expect(round(normal.reserve)).toBe(28_405);
    expect(round(normal.p4)).toBe(8_611);
    expect(round(normal.shed)).toBe(1_510);
    expect((0.98 * MONTHLY_CAP - 600_000) / 10).toBe(38_000);
  });
});

describe('KOSCOM governor online replay of one quota day (stage 3c, L7)', () => {
  const run = (
    worst: boolean,
    backfill?: { atMs: number; calls: number },
    context: { usedBeforeToday?: number; remainingSessions?: number } = {},
  ) =>
    replayDay(
      replayEvents(finalDesign(100, 6, { worst }), session, {
        periodMs: 5_000,
        batches: 6,
        backfill,
      }),
      { session, pricePlan: plan, ...context },
    );

  it('bounded-worst day + 10,000 backfill in the evening: only backfill is shed, 90 % reached', () => {
    const r = run(true, {
      atMs: session.closeMs + 3 * 60 * MIN,
      calls: 10_000,
    });
    expect(r.admitted[1] === r.demand[1]).toBe(true);
    expect(r.admitted[2] === r.demand[2]).toBe(true);
    expect(r.admitted[3] === r.demand[3]).toBe(true);
    // Model: 45,000 admitted, 8,037 shed (calc §3a).
    expect(Math.abs(r.total - 45_000) <= 100).toBe(true);
    expect(Math.abs(r.shed - 8_037) <= 100).toBe(true);
    expect(r.total <= 45_000).toBe(true);
  });

  it('normal day + backfill after midnight matches the model; before midnight the worst-case P2 stays reserved', () => {
    const nextMidnight = session.openMs + 15 * 60 * MIN; // 00:00 KST
    const late = run(false, { atMs: nextMidnight + 60 * MIN, calls: 10_000 });
    expect(
      late.admitted[1] + late.admitted[2] === late.demand[1] + late.demand[2],
    ).toBe(true);
    expect(late.admitted[3] === late.demand[3]).toBe(true);
    // Model: 1,510 shed (calc §3b).
    expect(Math.abs(late.shed - 1_510) <= 100).toBe(true);
    const evening = run(false, {
      atMs: session.closeMs + 3 * 60 * MIN,
      calls: 10_000,
    });
    expect(evening.admitted[2] === evening.demand[2]).toBe(true);
    expect(evening.shed > late.shed).toBe(true);
  });

  it('a daytime backfill on a worst day never takes price or financial-evidence calls; P4 is shed first', () => {
    const r = run(true, { atMs: session.openMs + 60 * MIN, calls: 10_000 });
    expect(r.admitted[1] === r.demand[1]).toBe(true);
    expect(r.admitted[2] === r.demand[2]).toBe(true);
    expect(r.admitted[3] / r.demand[3] >= 0.99).toBe(true);
    const shedP4 = r.demand[4] - r.admitted[4];
    expect(shedP4 / r.shed >= 0.95).toBe(true);
    // P4 never admitted at/after the soft cap; P2 may use the 90–98 % band.
    expect(r.maxUsedAtAdmission[4] < 45_000).toBe(true);
    expect(r.maxUsedAtAdmission[2] < 49_000).toBe(true);
  });

  it('monthly pressure (600,000 used, 10 sessions left): 38,000/day, P1+P2 intact, P4 then P3 reduced', () => {
    const r = run(false, undefined, {
      usedBeforeToday: 600_000,
      remainingSessions: 10,
    });
    expect(r.admitted[1] === r.demand[1]).toBe(true);
    expect(r.admitted[2] === r.demand[2]).toBe(true);
    // soft = 34,200: P3 is cut before P1/P2, and P4 at least as hard.
    expect(r.admitted[3] < r.demand[3]).toBe(true);
    expect(r.admitted[4] / r.demand[4] <= r.admitted[3] / r.demand[3]).toBe(
      true,
    );
    expect(r.total <= Math.floor(0.98 * 38_000)).toBe(true);
  });

  it('keeps every priority under its cap however large the demand (P1 only up to 100 %)', () => {
    const r = run(true, { atMs: session.openMs, calls: 200_000 });
    expect(r.maxUsedAtAdmission[4] < 45_000).toBe(true);
    expect(r.maxUsedAtAdmission[3] < 45_000).toBe(true);
    expect(r.maxUsedAtAdmission[2] < 49_000).toBe(true);
    expect(r.maxUsedAtAdmission[1] < 50_000).toBe(true);
    expect(r.total <= 50_000).toBe(true);
    // A backfill flood at the open displaces neither prices nor evidence.
    expect(r.admitted[1] === r.demand[1]).toBe(true);
    expect(r.admitted[2] === r.demand[2]).toBe(true);
  });
});
