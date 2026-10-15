import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import {
  koscomBudgetLimits,
  koscomCallAdmissionLimit,
  koscomP3Cadence,
  koscomPriceSlotPermitted,
  koscomQuotaDayCalendar,
  type KoscomBudgetInput,
  type KoscomBudgetLimits,
  type KoscomP3Cadence,
} from './koscom-budget-policy';
import {
  KOSCOM_CALL_CATEGORIES,
  KOSCOM_CALL_PRIORITY,
  type KoscomCallCategory,
} from './koscom-call-context';

// Daily keys must outlive a rolling 31-day window (contract unit unknown, Q15).
const DAY_KEY_TTL_SECONDS = 40 * 24 * 60 * 60;
const MONTH_KEY_TTL_SECONDS = 70 * 24 * 60 * 60;

const RECORD_ATTEMPT_SCRIPT = `
redis.call('HINCRBY', KEYS[1], ARGV[1], 1)
redis.call('HINCRBY', KEYS[1], 'total', 1)
redis.call('EXPIRE', KEYS[1], ARGV[2])
redis.call('HINCRBY', KEYS[2], ARGV[1], 1)
redis.call('HINCRBY', KEYS[2], 'total', 1)
redis.call('EXPIRE', KEYS[2], ARGV[3])
return 1
`;

// Several remaining-count streams were observed live while the limit read
// 50,000 (2026-10-12/13): keep the LOWEST remaining value of the quota day.
const RECORD_QUOTA_SCRIPT = `
if ARGV[1] ~= '' then
  local current = redis.call('HGET', KEYS[1], 'remainingMin')
  if (not current) or tonumber(ARGV[1]) < tonumber(current) then
    redis.call('HSET', KEYS[1], 'remainingMin', ARGV[1])
  end
end
if ARGV[2] ~= '' then redis.call('HSET', KEYS[1], 'limit', ARGV[2]) end
redis.call('HSET', KEYS[1], 'observedAt', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return 1
`;

const READ_HASH_SCRIPT = `return redis.call('HGETALL', KEYS[1])`;

// Stage 3c: check and count in one step, so concurrent attempts from every
// instance can never pass a cap together and nothing is counted twice.
// Usage = max(attempt counter, header limit - lowest header remaining).
// ARGV[4] is the admission limit; ARGV[5] = '1' enforces it. Unenforced
// ("shadow"), the attempt is always counted and a would-be denial is
// tallied as shadow_denied:<category>. Returns 1 admitted, 0 denied,
// 2 admitted in shadow mode although the policy would have denied it.
const ADMIT_ATTEMPT_SCRIPT = `
local used = tonumber(redis.call('HGET', KEYS[1], 'total') or '0') or 0
local limitH = tonumber(redis.call('HGET', KEYS[3], 'limit') or '')
local remaining = tonumber(redis.call('HGET', KEYS[3], 'remainingMin') or '')
if limitH and remaining and (limitH - remaining) > used then
  used = limitH - remaining
end
local admit = used < tonumber(ARGV[4])
if (not admit) and ARGV[5] == '1' then return 0 end
redis.call('HINCRBY', KEYS[1], ARGV[1], 1)
redis.call('HINCRBY', KEYS[1], 'total', 1)
redis.call('EXPIRE', KEYS[1], ARGV[2])
redis.call('HINCRBY', KEYS[2], ARGV[1], 1)
redis.call('HINCRBY', KEYS[2], 'total', 1)
redis.call('EXPIRE', KEYS[2], ARGV[3])
if not admit then
  redis.call('HINCRBY', KEYS[1], 'shadow_denied:' .. ARGV[1], 1)
  return 2
end
return 1
`;

/** Limits are recomputed from the counters at most this often per process. */
const LIMITS_CACHE_MS = 1_000;
const PRICE_PLAN_TTL_SECONDS = 24 * 60 * 60;
const ALERT_INTERVAL_MS = 60_000;

export type KoscomBudgetCaps = { dailyCap: number; monthlyCap: number };
export type KoscomBudgetDecision = 'admitted' | 'denied' | 'shadow_denied';

/**
 * KOSCOM resets the daily quota at 09:00 KST, which is exactly 00:00 UTC, so
 * the quota day is the UTC date (labelled with the KST date it starts on).
 */
export function koscomQuotaDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Calendar month of a quota day (the contract's monthly unit is Q15). */
export function koscomQuotaMonth(quotaDay: string): string {
  return quotaDay.slice(0, 7);
}

export type KoscomCallCounts = Record<KoscomCallCategory | 'total', number>;

function pricePlanKey(namespace: string): string {
  return `koscom:${namespace}:price-plan`;
}

export type KoscomQuotaDaySnapshot = {
  quotaDay: string;
  counts: KoscomCallCounts;
  /** Lowest X-RateLimit-Remaining-Day seen this quota day (any stream). */
  headerRemainingMin: number | null;
  headerLimit: number | null;
  headerObservedAt: string | null;
};

export function koscomCallKeys(namespace: string, now: Date) {
  const day = koscomQuotaDay(now);
  // The hash tag keeps one namespace's keys in one cluster slot for EVAL.
  const prefix = `koscom:{${namespace}}:calls`;
  return {
    day: `${prefix}:day:${day}`,
    month: `${prefix}:month:${koscomQuotaMonth(day)}`,
    quota: `${prefix}:quota:${day}`,
  };
}

/**
 * Per-category attempt counters and the provider daily-quota headers.
 *
 * Stage 1 (observation only): a counter or Redis failure is swallowed and
 * never blocks, delays or fails a KOSCOM call. Every attempt the client is
 * about to send is counted exactly once by the instance that sends it, so
 * restarts and multiple instances never double count (an INCR is atomic and
 * nothing is replayed).
 */
@Injectable()
export class KoscomCallBudgetService {
  private readonly logger = new Logger(KoscomCallBudgetService.name);
  private readonly limitsCache = new Map<
    string,
    {
      atMs: number;
      quotaDay: string;
      input: KoscomBudgetInput;
      limits: KoscomBudgetLimits;
    }
  >();
  private readonly lastAlertAt = new Map<string, number>();

  constructor(private readonly redis: RedisService) {}

  /**
   * Stage 3c admission of one attempt the client is about to send, counted
   * in the same atomic step (retries are attempts too). Enforced, a denial
   * means the call must not be sent; Redis failures propagate so the caller
   * fails closed. Unenforced, the attempt is always counted (Stage 1
   * semantics: failures are swallowed) and only the decision is recorded.
   */
  async admitAttempt(input: {
    namespace: string;
    category: KoscomCallCategory;
    enforce: boolean;
    caps: KoscomBudgetCaps;
    now?: Date;
  }): Promise<KoscomBudgetDecision> {
    const now = input.now ?? new Date();
    let limit = Number.MAX_SAFE_INTEGER;
    try {
      const { limits } = await this.limits(input.namespace, input.caps, now);
      limit = koscomCallAdmissionLimit(limits, input.category);
    } catch (error) {
      if (input.enforce) throw error;
    }
    const keys = koscomCallKeys(input.namespace, now);
    let result: unknown;
    try {
      result = await this.redis.eval(
        ADMIT_ATTEMPT_SCRIPT,
        [keys.day, keys.month, keys.quota],
        [
          input.category,
          String(DAY_KEY_TTL_SECONDS),
          String(MONTH_KEY_TTL_SECONDS),
          String(Math.max(0, Math.floor(limit))),
          input.enforce ? '1' : '0',
        ],
      );
    } catch (error) {
      if (input.enforce) throw error;
      return 'admitted';
    }
    const decision: KoscomBudgetDecision =
      Number(result) === 0
        ? 'denied'
        : Number(result) === 2
          ? 'shadow_denied'
          : 'admitted';
    if (decision !== 'admitted')
      this.alertOncePerMinute(input.namespace, input.category, decision, now);
    return decision;
  }

  /** Price-loop pacing above the hard cap (§7.6 step 4); true on errors. */
  async priceSlotPermitted(input: {
    namespace: string;
    caps: KoscomBudgetCaps;
    slot: number;
    periodMs: number;
    now?: Date;
  }): Promise<boolean> {
    const now = input.now ?? new Date();
    try {
      const { limits, input: state } = await this.limits(
        input.namespace,
        input.caps,
        now,
      );
      const elapsedSlots = state.session
        ? Math.floor(
            (Math.min(now.getTime(), state.session.closeMs) -
              state.session.openMs) /
              input.periodMs,
          )
        : 0;
      return koscomPriceSlotPermitted({
        limits,
        slot: input.slot,
        periodMs: input.periodMs,
        nowMs: now.getTime(),
        session: state.session,
        callsPerCycle:
          state.pricePlan?.batches ??
          (elapsedSlots > 0 ? state.day.price / elapsedSlots : 1),
      });
    } catch {
      // The per-attempt admission still fails closed when enforced.
      return true;
    }
  }

  /** Central intraday 1m cadence (§7.6 step 2); 'normal' on errors. */
  async p3Cadence(input: {
    namespace: string;
    caps: KoscomBudgetCaps;
    projectedP3: number;
    now?: Date;
  }): Promise<KoscomP3Cadence> {
    try {
      const { limits } = await this.limits(
        input.namespace,
        input.caps,
        input.now ?? new Date(),
      );
      return koscomP3Cadence(limits, input.projectedP3);
    } catch {
      return 'normal';
    }
  }

  /**
   * Price requests per cycle, its period and the stock count, published by
   * the price loop every cycle. It outlives the session (P2 reservation of
   * the evening scales with the stock count) and is replaced next session.
   */
  async publishPricePlan(
    namespace: string,
    plan: { batches: number; periodMs: number; assets: number },
  ): Promise<void> {
    try {
      await this.redis.setWithTtl(
        pricePlanKey(namespace),
        JSON.stringify(plan),
        PRICE_PLAN_TTL_SECONDS,
      );
    } catch {
      // Without a plan the reservation falls back to the observed price rate.
    }
  }

  async limits(
    namespace: string,
    caps: KoscomBudgetCaps,
    now: Date = new Date(),
  ): Promise<{ input: KoscomBudgetInput; limits: KoscomBudgetLimits }> {
    const quotaDay = koscomQuotaDay(now);
    const cacheKey = `${namespace}|${caps.dailyCap}|${caps.monthlyCap}`;
    const cached = this.limitsCache.get(cacheKey);
    const age = now.getTime() - (cached?.atMs ?? 0);
    if (
      cached &&
      cached.quotaDay === quotaDay &&
      age >= 0 &&
      age < LIMITS_CACHE_MS
    )
      return cached;
    const [day, month, plan] = await Promise.all([
      this.readQuotaDay(namespace, now),
      this.readQuotaMonth(namespace, now),
      this.readPricePlan(namespace),
    ]);
    const calendar = koscomQuotaDayCalendar(quotaDay);
    const input: KoscomBudgetInput = {
      nowMs: now.getTime(),
      dailyCap: caps.dailyCap,
      monthlyCap: caps.monthlyCap,
      day: day.counts,
      month,
      headerRemainingMin: day.headerRemainingMin,
      headerLimit: day.headerLimit,
      session: calendar.session,
      remainingSessions: calendar.remainingSessions,
      pricePlan: plan,
    };
    const entry = {
      atMs: now.getTime(),
      quotaDay,
      input,
      limits: koscomBudgetLimits(input),
    };
    this.limitsCache.set(cacheKey, entry);
    return entry;
  }

  private async readPricePlan(
    namespace: string,
  ): Promise<KoscomBudgetInput['pricePlan']> {
    const raw = await this.redis.get(pricePlanKey(namespace));
    if (!raw) return null;
    try {
      const plan = JSON.parse(raw) as Record<string, unknown>;
      return typeof plan.batches === 'number' &&
        typeof plan.periodMs === 'number' &&
        typeof plan.assets === 'number' &&
        plan.batches >= 0 &&
        plan.periodMs > 0 &&
        plan.assets >= 0
        ? {
            batches: plan.batches,
            periodMs: plan.periodMs,
            assets: plan.assets,
          }
        : null;
    } catch {
      return null;
    }
  }

  private alertOncePerMinute(
    namespace: string,
    category: KoscomCallCategory,
    decision: Exclude<KoscomBudgetDecision, 'admitted'>,
    now: Date,
  ): void {
    const key = `${namespace}|${category}|${decision}`;
    const last = this.lastAlertAt.get(key);
    if (last !== undefined && now.getTime() - last < ALERT_INTERVAL_MS) return;
    this.lastAlertAt.set(key, now.getTime());
    this.logger.warn(
      JSON.stringify({
        event:
          decision === 'denied'
            ? 'koscom_budget_denied'
            : 'koscom_budget_shadow_denied',
        category,
        priority: KOSCOM_CALL_PRIORITY[category],
      }),
    );
  }

  async recordAttempt(
    namespace: string,
    category: KoscomCallCategory,
    now: Date = new Date(),
  ): Promise<boolean> {
    try {
      const keys = koscomCallKeys(namespace, now);
      await this.redis.eval(
        RECORD_ATTEMPT_SCRIPT,
        [keys.day, keys.month],
        [category, String(DAY_KEY_TTL_SECONDS), String(MONTH_KEY_TTL_SECONDS)],
      );
      return true;
    } catch {
      return false;
    }
  }

  async recordQuotaHeaders(
    namespace: string,
    observed: {
      limitDay: number | null;
      remainingDay: number | null;
      observedAt: Date;
    },
  ): Promise<boolean> {
    try {
      const keys = koscomCallKeys(namespace, observed.observedAt);
      await this.redis.eval(
        RECORD_QUOTA_SCRIPT,
        [keys.quota],
        [
          observed.remainingDay === null ? '' : String(observed.remainingDay),
          observed.limitDay === null ? '' : String(observed.limitDay),
          observed.observedAt.toISOString(),
          String(DAY_KEY_TTL_SECONDS),
        ],
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Throws when Redis is unavailable; callers decide how to degrade. */
  async readQuotaDay(
    namespace: string,
    now: Date = new Date(),
  ): Promise<KoscomQuotaDaySnapshot> {
    const keys = koscomCallKeys(namespace, now);
    const [counts, quota] = await Promise.all([
      this.readHash(keys.day),
      this.readHash(keys.quota),
    ]);
    return {
      quotaDay: koscomQuotaDay(now),
      counts: toCounts(counts),
      headerRemainingMin: toNumberOrNull(quota.remainingMin),
      headerLimit: toNumberOrNull(quota.limit),
      headerObservedAt: quota.observedAt ?? null,
    };
  }

  /** Calendar-month counters for the quota day that contains `now`. */
  async readQuotaMonth(
    namespace: string,
    now: Date = new Date(),
  ): Promise<KoscomCallCounts> {
    return toCounts(await this.readHash(koscomCallKeys(namespace, now).month));
  }

  private async readHash(key: string): Promise<Record<string, string>> {
    const flat = await this.redis.eval(READ_HASH_SCRIPT, [key]);
    const result: Record<string, string> = {};
    if (!Array.isArray(flat)) return result;
    for (let i = 0; i + 1 < flat.length; i += 2)
      result[String(flat[i])] = String(flat[i + 1]);
    return result;
  }
}

function toCounts(raw: Record<string, string>): KoscomCallCounts {
  const counts = { total: toNumberOrNull(raw.total) ?? 0 } as KoscomCallCounts;
  for (const category of KOSCOM_CALL_CATEGORIES)
    counts[category] = toNumberOrNull(raw[category]) ?? 0;
  return counts;
}

function toNumberOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
