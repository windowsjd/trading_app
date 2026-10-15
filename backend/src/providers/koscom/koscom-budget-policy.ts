/**
 * KOSCOM budget governor policy (design v2.1 §7.3, §7.6; stage 3c), pure.
 *
 * Every attempt is admitted against the quota day's usage — the larger of
 * the attempt counter and the provider's remaining-quota header — by the
 * priority of its call category:
 *
 *   P1 price, lists          up to the effective daily cap (paced above hard)
 *   P2 1d, LOC, recoverClose up to the hard cap (98 %)
 *   P3 1m, gap repair        up to the soft cap (90 %) after reserving the
 *                            day's remaining expected P1+P2
 *   P4 4h, 1w, backfill, …   up to the soft cap after reserving the
 *                            bounded-worst P1+P2 and the remaining P3
 *
 * so P4 is shed first, then P3; P2 stops only at the hard cap and P1 last.
 * The monthly cap enters as a daily allowance:
 *   (0.98 × monthly cap − used before today) ÷ remaining KRX sessions.
 */
import { resolveMarketSession } from '../../orders/market-calendar.policy';
import { hasEffectiveMarketCalendarForDate } from '../../orders/market-holidays.config';
import {
  KOSCOM_CALL_PRIORITY,
  type KoscomCallCategory,
} from './koscom-call-context';

export const KOSCOM_BUDGET_SOFT_RATIO = 0.9;
export const KOSCOM_BUDGET_HARD_RATIO = 0.98;
export const KOSCOM_BUDGET_MONTHLY_RATIO = 0.98;
/**
 * Non-price P1+P2 of a session day, reserved until KST midnight (LOC
 * evidence and close recovery are over by then), per stock plus market
 * lists (design v2.1 §7.2). P3 is admitted after the EXPECTED amount
 * (normal day: 1d 1.1 + LOC 2 calls, +1 % retries; 12 lists); P4 only after
 * the BOUNDED-WORST amount (1d 3 + LOC 33 + recoverClose 3, +20 %; 173
 * lists), so optional work never takes what financial evidence may need.
 * Beyond either, P2 still runs until the hard cap. Without a published
 * stock count the floor applies.
 */
export const KOSCOM_BUDGET_EXPECTED_P2_PER_ASSET = 3.131;
export const KOSCOM_BUDGET_EXPECTED_LISTS = 12;
export const KOSCOM_BUDGET_WORST_P2_PER_ASSET = 46.8;
export const KOSCOM_BUDGET_WORST_LISTS = 173;
export const KOSCOM_BUDGET_OTHER_P1P2_FLOOR = 600;
/**
 * The same-day gap repair cap with retries (300/day + 20 %), reserved
 * against P4 until an hour after the close.
 */
export const KOSCOM_BUDGET_REPAIR_RESERVE = 360;
const REPAIR_WINDOW_MS = 60 * 60_000;
const BUCKET_MS = 5 * 60_000;
const TICK_DELAY_MS = 70_000;
/** Observed rates are trusted once this much of the session has elapsed. */
const RATE_WARMUP_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const KST_OFFSET_MS = 9 * 60 * 60_000;

type Counts = Readonly<Record<KoscomCallCategory | 'total', number>>;

export type KoscomBudgetInput = {
  nowMs: number;
  dailyCap: number;
  monthlyCap: number;
  /** Attempt counters of this quota day and of its month (today included). */
  day: Counts;
  month: Counts;
  /** Lowest X-RateLimit-Remaining-Day and the limit seen this quota day. */
  headerRemainingMin: number | null;
  headerLimit: number | null;
  /** The KRX session of this quota day (it starts at 09:00 KST), if any. */
  session: { openMs: number; closeMs: number } | null;
  /** KRX sessions from this quota day (inclusive) to the end of its month. */
  remainingSessions: number;
  /** Published by the price loop each cycle: requests per cycle, period, stocks. */
  pricePlan: { batches: number; periodMs: number; assets: number } | null;
};

export type KoscomBudgetLimits = {
  used: number;
  effectiveCap: number;
  soft: number;
  hard: number;
  /** Remaining price + EXPECTED non-price P1+P2 (P3 admission). */
  reserveP1P2: number;
  /** Remaining price + BOUNDED-WORST non-price P1+P2 (P4 admission). */
  reserveP1P2Worst: number;
  /** Projected remaining P3: the session's 1m ticks + the repair cap. */
  reserveP3: number;
  /** A call of priority p is admitted iff used < limit[p]. */
  limit: Record<1 | 2 | 3 | 4, number>;
};

export function koscomBudgetLimits(
  input: KoscomBudgetInput,
): KoscomBudgetLimits {
  const { day } = input;
  const headerUsed =
    input.headerLimit !== null && input.headerRemainingMin !== null
      ? Math.max(0, input.headerLimit - input.headerRemainingMin)
      : 0;
  // The more conservative of our counter and the provider's own count.
  const used = Math.max(day.total, headerUsed);
  const dayCap =
    input.headerLimit !== null && input.headerLimit > 0
      ? Math.min(input.dailyCap, input.headerLimit)
      : input.dailyCap;
  const usedBeforeToday = Math.max(0, input.month.total - day.total);
  const allowance = Math.floor(
    (KOSCOM_BUDGET_MONTHLY_RATIO * input.monthlyCap - usedBeforeToday) /
      Math.max(1, input.remainingSessions),
  );
  const effectiveCap = Math.max(0, Math.min(dayCap, allowance));
  const soft = Math.floor(KOSCOM_BUDGET_SOFT_RATIO * effectiveCap);
  const hard = Math.floor(KOSCOM_BUDGET_HARD_RATIO * effectiveCap);

  const { remainingMs, elapsedMs } = sessionProgress(input);
  const priceRate = input.pricePlan
    ? input.pricePlan.batches / input.pricePlan.periodMs
    : elapsedMs >= RATE_WARMUP_MS
      ? day.price / elapsedMs
      : 0;
  const session = input.session;
  const otherUsed = day.lists + day.daily + day.loc + day.recover_close;
  const beforeMidnight =
    session !== null && input.nowMs < kstMidnightAfter(session.closeMs);
  const otherReserve = (perAsset: number, lists: number) =>
    beforeMidnight
      ? Math.max(
          0,
          (input.pricePlan
            ? Math.ceil(input.pricePlan.assets * perAsset) + lists
            : KOSCOM_BUDGET_OTHER_P1P2_FLOOR) - otherUsed,
        )
      : 0;
  const remainingPrice = Math.ceil(priceRate * remainingMs);
  const reserveP1P2 =
    remainingPrice +
    otherReserve(
      KOSCOM_BUDGET_EXPECTED_P2_PER_ASSET,
      KOSCOM_BUDGET_EXPECTED_LISTS,
    );
  const reserveP1P2Worst =
    remainingPrice +
    otherReserve(KOSCOM_BUDGET_WORST_P2_PER_ASSET, KOSCOM_BUDGET_WORST_LISTS);
  const p3Used = day.minute + day.gap_repair + day.user_request;
  const inRepairWindow =
    session !== null && input.nowMs < session.closeMs + REPAIR_WINDOW_MS;
  const reserveP3 =
    minuteProjection(input, elapsedMs, p3Used) +
    (inRepairWindow
      ? Math.max(0, KOSCOM_BUDGET_REPAIR_RESERVE - day.gap_repair)
      : 0);
  return {
    used,
    effectiveCap,
    soft,
    hard,
    reserveP1P2,
    reserveP1P2Worst,
    reserveP3,
    limit: {
      1: effectiveCap,
      2: hard,
      3: soft - reserveP1P2,
      4: soft - reserveP1P2Worst - reserveP3,
    },
  };
}

export function koscomCallAdmissionLimit(
  limits: KoscomBudgetLimits,
  category: KoscomCallCategory,
): number {
  return limits.limit[KOSCOM_CALL_PRIORITY[category]];
}

/**
 * P1 above the hard cap (§7.6 step 4): price cycles are slowed to what the
 * rest of the effective cap allows until the close, by running only every
 * `stride`-th slot. Zero budget left stops them (prices age into fail-closed).
 */
export function koscomPriceSlotPermitted(input: {
  limits: KoscomBudgetLimits;
  slot: number;
  periodMs: number;
  nowMs: number;
  session: { openMs: number; closeMs: number } | null;
  callsPerCycle: number;
}): boolean {
  const { limits } = input;
  if (limits.used < limits.hard) return true;
  const left = limits.effectiveCap - limits.used;
  const cycles = Math.floor(left / Math.max(1, input.callsPerCycle));
  if (cycles <= 0) return false;
  const remainingMs = input.session
    ? Math.max(
        0,
        input.session.closeMs - Math.max(input.nowMs, input.session.openMs),
      )
    : 0;
  const remainingSlots = Math.ceil(remainingMs / input.periodMs);
  if (cycles >= remainingSlots) return true;
  return input.slot % Math.ceil(remainingSlots / cycles) === 0;
}

export type KoscomP3Cadence = 'normal' | 'reduced' | 'blocked';

/**
 * Central intraday 1m cadence under budget pressure (§7.6 step 2): every
 * 5-minute bucket while the projected remaining P3 fits under its limit,
 * every other bucket (10-minute cadence, the closing tick kept) when it
 * does not, none once P3 is no longer admitted.
 */
export function koscomP3Cadence(
  limits: KoscomBudgetLimits,
  projectedP3: number,
): KoscomP3Cadence {
  if (limits.used >= limits.limit[3]) return 'blocked';
  return limits.used + projectedP3 < limits.limit[3] ? 'normal' : 'reduced';
}

/**
 * The KRX session inside a quota day (YYYY-MM-DD, the KST date it starts
 * on at 09:00) and the sessions left in its month. A date without calendar
 * coverage counts as a session: a smaller allowance, never a larger one.
 */
export function koscomQuotaDayCalendar(quotaDay: string): {
  session: { openMs: number; closeMs: number } | null;
  remainingSessions: number;
} {
  const today = resolveMarketSession('KRX', quotaDay.replace(/-/gu, ''));
  const [year, month] = quotaDay.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let remainingSessions = 0;
  for (let d = Number(quotaDay.slice(8, 10)); d <= lastDay; d += 1) {
    const date = `${quotaDay.slice(0, 8)}${String(d).padStart(2, '0')}`;
    if (
      !hasEffectiveMarketCalendarForDate('KRX', date) ||
      resolveMarketSession('KRX', date.replace(/-/gu, ''))
    )
      remainingSessions += 1;
  }
  return {
    session: today
      ? {
          openMs: today.openTime.getTime(),
          closeMs: today.closeTime.getTime(),
        }
      : null,
    remainingSessions,
  };
}

/**
 * Remaining central 1m calls of the session: one tick per completed bucket
 * (bucket end + the 70 s default delay) and the closing tick, sized by the
 * observed calls per tick and never below one call per published stock.
 */
function minuteProjection(
  input: KoscomBudgetInput,
  elapsedMs: number,
  p3Used: number,
): number {
  const session = input.session;
  if (!session || input.nowMs >= session.closeMs + 2 * BUCKET_MS) return 0;
  const buckets = Math.ceil((session.closeMs - session.openMs) / BUCKET_MS);
  const ticksDone = Math.min(
    buckets,
    Math.max(0, Math.floor((elapsedMs - TICK_DELAY_MS) / BUCKET_MS)),
  );
  const perTick = Math.max(
    ticksDone > 0 ? p3Used / ticksDone : 0,
    input.pricePlan?.assets ?? 0,
  );
  return Math.ceil(perTick * (buckets - ticksDone + 1));
}

function kstMidnightAfter(ms: number): number {
  return (
    (Math.floor((ms + KST_OFFSET_MS) / DAY_MS) + 1) * DAY_MS - KST_OFFSET_MS
  );
}

function sessionProgress(input: KoscomBudgetInput) {
  const session = input.session;
  if (!session) return { remainingMs: 0, elapsedMs: 0 };
  const now = input.nowMs;
  return {
    remainingMs: Math.max(0, session.closeMs - Math.max(now, session.openMs)),
    elapsedMs: Math.max(0, Math.min(now, session.closeMs) - session.openMs),
  };
}
