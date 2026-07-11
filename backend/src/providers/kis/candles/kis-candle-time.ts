import { KisCandleInputError } from './kis-candle.types';
import type { KisCandleAssetInput } from './kis-candle.types';

export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

export function getZonedParts(date: Date, timeZone: string): ZonedParts {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  const values = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  return values as ZonedParts;
}

export function zonedDateTimeToUtc(
  dateText: string,
  timeText: string,
  timeZone: string,
): Date | null {
  if (!/^\d{8}$/u.test(dateText) || !/^\d{6}$/u.test(timeText)) return null;
  const target: ZonedParts = {
    year: Number(dateText.slice(0, 4)),
    month: Number(dateText.slice(4, 6)),
    day: Number(dateText.slice(6, 8)),
    hour: Number(timeText.slice(0, 2)),
    minute: Number(timeText.slice(2, 4)),
    second: Number(timeText.slice(4, 6)),
  };
  if (
    target.month < 1 ||
    target.month > 12 ||
    target.day < 1 ||
    target.day > 31 ||
    target.hour > 23 ||
    target.minute > 59 ||
    target.second > 59
  ) {
    return null;
  }
  const targetAsUtc = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
    target.second,
  );
  let candidate = targetAsUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = getZonedParts(new Date(candidate), timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    candidate += targetAsUtc - actualAsUtc;
  }
  const result = new Date(candidate);
  const check = getZonedParts(result, timeZone);
  return Object.keys(target).every(
    (key) => check[key as keyof ZonedParts] === target[key as keyof ZonedParts],
  )
    ? result
    : null;
}

export function formatZonedCursor(
  date: Date,
  timeZone: string,
): {
  date: string;
  time: string;
  compact: string;
} {
  const parts = getZonedParts(date, timeZone);
  const pad = (value: number) => String(value).padStart(2, '0');
  const dateText = `${parts.year}${pad(parts.month)}${pad(parts.day)}`;
  const timeText = `${pad(parts.hour)}${pad(parts.minute)}${pad(parts.second)}`;
  return { date: dateText, time: timeText, compact: `${dateText}${timeText}` };
}

export function validateFetchInput(input: {
  from: Date;
  to: Date;
  maxPages?: number;
  maxRows?: number;
  maxDurationMs?: number;
}): Required<Pick<typeof input, 'maxPages' | 'maxRows' | 'maxDurationMs'>> {
  if (
    !(input.from instanceof Date) ||
    !(input.to instanceof Date) ||
    Number.isNaN(input.from.getTime()) ||
    Number.isNaN(input.to.getTime()) ||
    input.from.getTime() >= input.to.getTime()
  ) {
    throw new KisCandleInputError(
      'Candle range must be valid and half-open [from, to).',
    );
  }
  const values = {
    maxPages: input.maxPages ?? 100,
    maxRows: input.maxRows ?? 12_000,
    maxDurationMs: input.maxDurationMs ?? 30_000,
  };
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new KisCandleInputError(`${name} must be a positive integer.`);
    }
  }
  return values;
}

export function validateCandleAsset(asset: KisCandleAssetInput): void {
  for (const [field, value] of Object.entries(asset)) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new KisCandleInputError(
        `asset.${field} must be a non-empty string.`,
      );
    }
  }
}

export function createBoundedAbortSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  deadlineSignal: AbortSignal;
  clear: () => void;
} {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  return {
    signal: externalSignal
      ? AbortSignal.any([externalSignal, deadline.signal])
      : deadline.signal,
    deadlineSignal: deadline.signal,
    clear: () => clearTimeout(timer),
  };
}

export async function awaitWithinBudget<T>(
  promise: Promise<T>,
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<
  | { state: 'resolved'; value: T }
  | { state: 'canceled' }
  | { state: 'max_duration' }
> {
  if (externalSignal?.aborted || timeoutMs <= 0) {
    // The shared operation may still be useful to another waiter. Observe any
    // later rejection without canceling that shared work.
    void promise.catch(() => undefined);
    return {
      state: externalSignal?.aborted ? 'canceled' : 'max_duration',
    };
  }
  const bounded = createBoundedAbortSignal(externalSignal, timeoutMs);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<{ state: 'canceled' | 'max_duration' }>(
    (resolve) => {
      onAbort = () =>
        resolve({
          state: externalSignal?.aborted ? 'canceled' : 'max_duration',
        });
      bounded.signal.addEventListener('abort', onAbort, { once: true });
    },
  );
  try {
    return await Promise.race([
      promise.then((value) => ({ state: 'resolved' as const, value })),
      aborted,
    ]);
  } finally {
    if (onAbort) bounded.signal.removeEventListener('abort', onAbort);
    bounded.clear();
  }
}
