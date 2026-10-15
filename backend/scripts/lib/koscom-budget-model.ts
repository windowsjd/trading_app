/**
 * KOSCOM call-volume model of design v2.1 §7 (calc/koscom_budget.py,
 * final design F and the governor demo) and an online replay of one quota
 * day through the stage-3c governor policy. Pure: no network, no Redis.
 */
import {
  koscomBudgetLimits,
  type KoscomBudgetInput,
} from '../../src/providers/koscom/koscom-budget-policy';
import {
  KOSCOM_CALL_CATEGORIES,
  KOSCOM_CALL_PRIORITY,
  type KoscomCallCategory,
} from '../../src/providers/koscom/koscom-call-context';

export const DAILY_CAP = 50_000;
export const MONTHLY_CAP = 1_000_000;
export const SESSIONS_MONTH = 22;
export const NON_TRADING_MONTH = 9;
export const SESSIONS_ROLLING_31 = 23;
const SESSION_S = 390 * 60;
const SESSION_MIN = 390;
const TICKS = 79;

type Part = {
  name: string;
  category: KoscomCallCategory | 'backfill';
  trading: number;
  nonTrading: number;
};

export type ModelDay = {
  parts: Part[];
  trading: number;
  nonTrading: number;
  monthly: (sessions?: number, nonTrading?: number) => number;
  byPriority: () => Record<1 | 2 | 3 | 4, number>;
};

function day(parts: Part[]): ModelDay {
  const trading = parts.reduce((sum, part) => sum + part.trading, 0);
  const nonTrading = parts.reduce((sum, part) => sum + part.nonTrading, 0);
  return {
    parts,
    trading,
    nonTrading,
    monthly: (sessions = SESSIONS_MONTH, rest = NON_TRADING_MONTH) =>
      sessions * trading + rest * nonTrading,
    byPriority: () => {
      const out = { 1: 0, 2: 0, 3: 0, 4: 0 };
      for (const part of parts) out[priorityOf(part.category)] += part.trading;
      return out;
    },
  };
}

export function priorityOf(category: Part['category']): 1 | 2 | 3 | 4 {
  return category === 'backfill' ? 4 : KOSCOM_CALL_PRIORITY[category];
}

export function batches(kospi: number, kosdaq: number): number {
  return Math.ceil(kospi / 20) + Math.ceil(kosdaq / 20);
}

export function batchRange(n: number): [number, number] {
  const values = Array.from({ length: n + 1 }, (_, k) => batches(k, n - k));
  return [Math.min(...values), Math.max(...values)];
}

/** calc/koscom_budget.py `final_design` (v2.1 final design F). */
export function finalDesign(
  n: number,
  b: number,
  options: {
    priceS?: number;
    worst?: boolean;
    weekly?: boolean;
    minuteEvery?: number;
  } = {},
): ModelDay {
  const priceS = options.priceS ?? 5;
  const worst = options.worst ?? false;
  const r = worst ? 0.2 : 0.01;
  const every = options.minuteEvery ?? 5;
  const ticks = every === 5 ? TICKS : Math.ceil(SESSION_MIN / every) + 1;
  const lists = worst ? 144 : 12;
  const parts: Part[] = [
    {
      name: 'P1 price',
      category: 'price',
      trading: b * (SESSION_S / priceS),
      nonTrading: 0,
    },
    {
      name: 'P1 market lists',
      category: 'lists',
      trading: lists * (1 + r),
      nonTrading: lists * (1 + r),
    },
    {
      name: 'P2 1d post-close',
      category: 'daily',
      trading: n * (worst ? 3 : 1.1) * (1 + r),
      nonTrading: 0,
    },
    {
      name: 'P2 LOC evidence',
      category: 'loc',
      trading: n * (worst ? 33 : 2) * (1 + r),
      nonTrading: 0,
    },
    {
      name: 'P2 recoverClose',
      category: 'recover_close',
      trading: (worst ? n * 3 : 0) * (1 + r),
      nonTrading: 0,
    },
    {
      name: 'P3 1m per bucket',
      category: 'minute',
      trading: n * ticks * (1 + r),
      nonTrading: 0,
    },
    {
      name: 'P3 same-day gap repair',
      category: 'gap_repair',
      trading: (worst ? Math.min(300, n * 3) : n * 0.05) * (1 + r),
      nonTrading: 0,
    },
    {
      name: 'P4 4h long sync',
      category: 'long_4h',
      trading: n * (worst ? 2 : 1) * (1 + r),
      nonTrading: 0,
    },
  ];
  if (options.weekly ?? true)
    parts.push({
      name: 'P4 1w weekly',
      category: 'weekly',
      trading: (n / 5) * (1 + r),
      nonTrading: 0,
    });
  return day(parts);
}

/** calc/koscom_budget.py `governor_demo`: the offline daily allocation. */
export function governorDemo(model: ModelDay, backfill = 0, soft = 0.9) {
  const pr = model.byPriority();
  const reserve = pr[1] + pr[2];
  const room = soft * DAILY_CAP - reserve;
  const p3 = Math.min(pr[3], Math.max(0, room));
  const p4 = Math.min(pr[4] + backfill, Math.max(0, room - p3));
  const total = reserve + p3 + p4;
  return { reserve, p3, p4, total, shed: model.trading + backfill - total };
}

export type ReplayEvent = {
  atMs: number;
  category: KoscomCallCategory | 'backfill';
  calls: number;
};

const MIN = 60_000;

/**
 * One quota day's demand in time order (design §3 schedule): price every
 * period during the session, a 1m tick per completed bucket + 70 s, then
 * the post-close repair (+10/+40), daily (+20/+60/+150), long sync after
 * each daily, 1w at +20, LOC until close + 3 h, close recovery until
 * midnight and market lists across the day. Each model part is rounded to
 * whole calls. An optional backfill is spread evenly over two hours.
 */
export function replayEvents(
  model: ModelDay,
  session: { openMs: number; closeMs: number },
  options: {
    periodMs: number;
    batches: number;
    backfill?: { atMs: number; calls: number };
  },
): ReplayEvent[] {
  const events: ReplayEvent[] = [];
  const total = (category: Part['category']) =>
    Math.round(
      model.parts
        .filter((part) => part.category === category)
        .reduce((sum, part) => sum + part.trading, 0),
    );
  const spread = (
    category: Part['category'],
    calls: number,
    times: readonly number[],
  ) => {
    if (calls <= 0 || times.length === 0) return;
    times.forEach((atMs, i) => {
      const share =
        Math.floor((calls * (i + 1)) / times.length) -
        Math.floor((calls * i) / times.length);
      if (share > 0) events.push({ atMs, category, calls: share });
    });
  };
  const { openMs, closeMs } = session;
  const priceTimes: number[] = [];
  for (let at = openMs; at < closeMs; at += options.periodMs)
    priceTimes.push(at);
  spread('price', total('price'), priceTimes);
  const quotaEnd = openMs + 24 * 60 * MIN;
  const listTimes = Array.from(
    { length: Math.max(1, total('lists')) },
    (_, i) => openMs + Math.floor((i * (quotaEnd - openMs)) / total('lists')),
  );
  spread('lists', total('lists'), listTimes);
  const ticks: number[] = [];
  for (let end = openMs + 5 * MIN; end <= closeMs; end += 5 * MIN)
    ticks.push(end + 70_000);
  ticks.push(closeMs + 10 * MIN); // the model's 79th (closing) tick
  spread('minute', total('minute'), ticks);
  spread('gap_repair', total('gap_repair'), [
    closeMs + 10 * MIN,
    closeMs + 40 * MIN,
  ]);
  const dailyTimes = [20, 60, 150].map((m) => closeMs + m * MIN);
  spread('daily', total('daily'), dailyTimes);
  spread(
    'long_4h',
    total('long_4h'),
    dailyTimes.map((at) => at + MIN),
  );
  spread('weekly', total('weekly'), [closeMs + 21 * MIN]);
  spread(
    'loc',
    total('loc'),
    Array.from({ length: 36 }, (_, i) => closeMs + (i + 1) * 5 * MIN),
  );
  const midnight = closeMs + 8.5 * 60 * MIN; // 15:30 → 24:00 KST
  spread(
    'recover_close',
    total('recover_close'),
    Array.from(
      { length: 8 },
      (_, i) => closeMs + ((i + 1) * (midnight - closeMs)) / 9,
    ),
  );
  if (options.backfill)
    spread(
      'backfill',
      options.backfill.calls,
      Array.from({ length: 120 }, (_, i) => options.backfill!.atMs + i * MIN),
    );
  return events.sort((a, b) => a.atMs - b.atMs);
}

export type ReplayResult = {
  demand: Record<1 | 2 | 3 | 4, number>;
  admitted: Record<1 | 2 | 3 | 4, number>;
  /** The highest quota-day usage at which a call of each priority was admitted. */
  maxUsedAtAdmission: Record<1 | 2 | 3 | 4, number>;
  total: number;
  shed: number;
};

/**
 * Feeds the events through the governor policy one call at a time, with
 * the counter checked and incremented atomically like the Redis script
 * (limits recomputed per event group, as with the 1 s limit cache).
 */
export function replayDay(
  events: readonly ReplayEvent[],
  context: {
    session: { openMs: number; closeMs: number };
    pricePlan: KoscomBudgetInput['pricePlan'];
    usedBeforeToday?: number;
    remainingSessions?: number;
    dailyCap?: number;
  },
): ReplayResult {
  const counts = Object.fromEntries(
    [...KOSCOM_CALL_CATEGORIES, 'total'].map((key) => [key, 0]),
  ) as Record<KoscomCallCategory | 'total', number>;
  const demand = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const admitted = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const maxUsedAtAdmission = { 1: -1, 2: -1, 3: -1, 4: -1 };
  for (const event of events) {
    const counter: KoscomCallCategory =
      event.category === 'backfill' ? 'backfill' : event.category;
    const priority = priorityOf(event.category);
    const limits = koscomBudgetLimits({
      nowMs: event.atMs,
      dailyCap: context.dailyCap ?? DAILY_CAP,
      monthlyCap: MONTHLY_CAP,
      day: counts,
      month: {
        ...counts,
        total: counts.total + (context.usedBeforeToday ?? 0),
      },
      headerRemainingMin: null,
      headerLimit: null,
      session: context.session,
      remainingSessions: context.remainingSessions ?? 12,
      pricePlan: context.pricePlan,
    });
    for (let i = 0; i < event.calls; i++) {
      demand[priority] += 1;
      if (counts.total >= limits.limit[priority]) continue;
      maxUsedAtAdmission[priority] = Math.max(
        maxUsedAtAdmission[priority],
        counts.total,
      );
      counts[counter] += 1;
      counts.total += 1;
      admitted[priority] += 1;
    }
  }
  const total = admitted[1] + admitted[2] + admitted[3] + admitted[4];
  const all = demand[1] + demand[2] + demand[3] + demand[4];
  return { demand, admitted, maxUsedAtAdmission, total, shed: all - total };
}
