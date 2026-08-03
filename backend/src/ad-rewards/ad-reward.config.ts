/**
 * Rewarded-ad configuration (작업 6).
 *
 * NOTHING here has a product default. The reward amount, the daily count and
 * amount caps, the cooldown, the day-boundary timezone, and the provider are
 * OPERATIONAL settings that have not been decided yet, so this parser refuses
 * to invent them: with AD_REWARD_ENABLED=true and any required value missing
 * or invalid, the process fails to boot rather than paying out a number
 * nobody agreed to.
 *
 * Disabled (the default) is a complete, valid state: no claim can be granted,
 * and none of the other variables are required.
 *
 * This is the ONE parser for these variables, reused by startup env
 * validation and by the service at runtime — never a second, more forgiving
 * read inside a method.
 */

export class AdRewardConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdRewardConfigError';
  }
}

export type AdRewardConfig =
  | { enabled: false }
  | {
      enabled: true;
      /** Registered provider key; must have a verifier adapter. */
      provider: string;
      /** Canonical scale-8 decimal string, > 0. Server-decided, never client. */
      rewardAmountKrw: string;
      /** Max granted claims per configured-timezone day, > 0. */
      dailyMaxCount: number;
      /** Max granted KRW per day; >= rewardAmountKrw. Scale-8 string. */
      dailyMaxAmountKrw: string;
      /** Minimum seconds between two granted claims; >= 0. */
      cooldownSeconds: number;
      /** IANA zone that defines the daily boundary (never the server's TZ). */
      dayTimeZone: string;
    };

const TRUE_VALUES = new Set(['true', '1']);
const FALSE_VALUES = new Set(['false', '0']);

export function readAdRewardConfig(
  env: NodeJS.ProcessEnv = process.env,
): AdRewardConfig {
  const enabled = parseStrictBoolean(
    env.AD_REWARD_ENABLED,
    'AD_REWARD_ENABLED',
  );
  if (!enabled) {
    return { enabled: false };
  }

  const provider = requireNonEmpty(
    env.AD_REWARD_PROVIDER,
    'AD_REWARD_PROVIDER',
  );
  const rewardAmountKrw = parsePositiveDecimal(
    env.AD_REWARD_AMOUNT_KRW,
    'AD_REWARD_AMOUNT_KRW',
  );
  const dailyMaxCount = parsePositiveInteger(
    env.AD_REWARD_DAILY_MAX_COUNT,
    'AD_REWARD_DAILY_MAX_COUNT',
  );
  const dailyMaxAmountKrw = parsePositiveDecimal(
    env.AD_REWARD_DAILY_MAX_AMOUNT_KRW,
    'AD_REWARD_DAILY_MAX_AMOUNT_KRW',
  );
  const cooldownSeconds = parseNonNegativeInteger(
    env.AD_REWARD_COOLDOWN_SECONDS,
    'AD_REWARD_COOLDOWN_SECONDS',
  );
  const dayTimeZone = parseTimeZone(
    env.AD_REWARD_DAY_TIME_ZONE,
    'AD_REWARD_DAY_TIME_ZONE',
  );

  // A daily cap below one reward would make every claim impossible — almost
  // certainly a typo, so refuse rather than silently never paying out.
  if (compareDecimalStrings(dailyMaxAmountKrw, rewardAmountKrw) < 0) {
    throw new AdRewardConfigError(
      `AD_REWARD_DAILY_MAX_AMOUNT_KRW (${dailyMaxAmountKrw}) must be greater than or equal to AD_REWARD_AMOUNT_KRW (${rewardAmountKrw}).`,
    );
  }

  return {
    enabled: true,
    provider,
    rewardAmountKrw,
    dailyMaxCount,
    dailyMaxAmountKrw,
    cooldownSeconds,
    dayTimeZone,
  };
}

function parseStrictBoolean(raw: string | undefined, name: string): boolean {
  if (raw === undefined || raw.trim() === '') return false;
  const normalized = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  throw new AdRewardConfigError(
    `${name} must be one of true, false, 1, 0 (case-insensitive), or be omitted for the default false. Received: ${JSON.stringify(raw)}.`,
  );
}

function requireNonEmpty(raw: string | undefined, name: string): string {
  const trimmed = raw?.trim();
  if (!trimmed) {
    throw new AdRewardConfigError(
      `${name} is required when AD_REWARD_ENABLED=true.`,
    );
  }
  return trimmed;
}

/** Positive decimal with at most 8 fraction digits, normalized to scale 8. */
function parsePositiveDecimal(raw: string | undefined, name: string): string {
  const trimmed = requireNonEmpty(raw, name);
  if (!/^\d{1,16}(\.\d{1,8})?$/u.test(trimmed)) {
    throw new AdRewardConfigError(
      `${name} must be a positive decimal with at most 8 fraction digits. Received: ${JSON.stringify(raw)}.`,
    );
  }
  const [whole, fraction = ''] = trimmed.split('.');
  const normalized = `${whole}.${fraction.padEnd(8, '0')}`;
  if (/^0+\.0{8}$/u.test(normalized)) {
    throw new AdRewardConfigError(`${name} must be greater than 0.`);
  }
  return normalized;
}

function parsePositiveInteger(raw: string | undefined, name: string): number {
  const value = parseNonNegativeInteger(raw, name);
  if (value < 1) {
    throw new AdRewardConfigError(`${name} must be a positive integer.`);
  }
  return value;
}

function parseNonNegativeInteger(
  raw: string | undefined,
  name: string,
): number {
  const trimmed = requireNonEmpty(raw, name);
  if (!/^\d+$/u.test(trimmed)) {
    throw new AdRewardConfigError(
      `${name} must be a non-negative integer. Received: ${JSON.stringify(raw)}.`,
    );
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) {
    throw new AdRewardConfigError(`${name} must be a safe integer.`);
  }
  return value;
}

/**
 * The daily boundary must be an explicit IANA zone. Relying on the server's
 * local timezone would make "today" depend on where the process happens to
 * run, so the value is validated against the platform's own zone database.
 */
function parseTimeZone(raw: string | undefined, name: string): string {
  const trimmed = requireNonEmpty(raw, name);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
  } catch {
    throw new AdRewardConfigError(
      `${name} must be a valid IANA timezone (e.g. Asia/Seoul). Received: ${JSON.stringify(raw)}.`,
    );
  }
  return trimmed;
}

function compareDecimalStrings(left: string, right: string): number {
  const [leftWhole, leftFraction] = left.split('.');
  const [rightWhole, rightFraction] = right.split('.');
  const wholeCompare =
    BigInt(leftWhole) === BigInt(rightWhole)
      ? 0
      : BigInt(leftWhole) > BigInt(rightWhole)
        ? 1
        : -1;
  if (wholeCompare !== 0) return wholeCompare;
  const leftFractionValue = BigInt(leftFraction ?? '0');
  const rightFractionValue = BigInt(rightFraction ?? '0');
  if (leftFractionValue === rightFractionValue) return 0;
  return leftFractionValue > rightFractionValue ? 1 : -1;
}

const ZONE_PART_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function zonePartsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = ZONE_PART_FORMATTER_CACHE.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    ZONE_PART_FORMATTER_CACHE.set(timeZone, formatter);
  }
  return formatter;
}

/** The zone's UTC offset (ms) at a given instant. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = zonePartsFormatter(timeZone).formatToParts(instant);
  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  const hour = get('hour');
  const wallClockAsUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    // Some ICU versions render midnight as hour 24 of the previous day.
    hour === 24 ? 0 : hour,
    get('minute'),
    get('second'),
  );
  return wallClockAsUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Start of the configured-timezone day containing `now`, as a UTC instant.
 *
 * The daily count/amount caps are bounded with this instead of the server's
 * local midnight, so "today" means the same thing regardless of where the
 * process runs. The offset is resolved twice so a day boundary that falls on
 * a DST transition still lands on the correct instant (a no-op for fixed-
 * offset zones such as Asia/Seoul).
 */
export function resolveAdRewardDayStart(now: Date, timeZone: string): Date {
  const parts = zonePartsFormatter(timeZone).formatToParts(now);
  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  const localMidnightAsUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
  );

  const firstGuess = new Date(localMidnightAsUtc - zoneOffsetMs(now, timeZone));
  return new Date(localMidnightAsUtc - zoneOffsetMs(firstGuess, timeZone));
}
