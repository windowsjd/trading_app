import { Prisma, SeasonStatus } from '../generated/prisma/client';
import { DEVELOPMENT_SEASON_ID } from './season-availability.policy';
import { parseLaunchStart } from './launch-season.operations';

type Tx = Prisma.TransactionClient;

/**
 * Regular (non-launch) seasons for the operator CLI (docs/season-schedule-operations.md).
 *
 * A regular season has `launchKind = NULL`: no development cutover, no beta
 * badge, no fixed 21-day length (the launch CHECK applies to launch rows only).
 * The existing lifecycle job activates it at `startAt` and ends it at `endAt`;
 * joining, the one initial grant, ranking, settlement and the final result use
 * the existing season-ID-keyed paths unchanged.
 *
 * Operating days are Korean calendar days. The operator names the first and
 * the last operating day (inclusive, Asia/Seoul — fixed UTC+9, no DST); the
 * exclusive trading boundary `endAt` is always 00:00 KST of the day after the
 * last operating day, derived here, so it can never be typed nine hours off.
 */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A sanity bound against a mistyped year; seasons are weeks long. */
const MAX_OPERATING_DAYS = 366;
const SEASON_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;
const KST_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONEY = /^\d{1,16}(?:\.\d{1,8})?$/;
const RATIO = /^\d{1,6}(?:\.\d{1,4})?$/;
const COUNT = /^\d{1,4}$/;
export const SCHEDULED_SEASON_AUDIT_TARGET = 'launch_season';
export const PREPARE_SEASON_AUDIT_ACTION = 'launch_season.prepare-season';

export type ScheduledSeasonRequest = {
  seasonId: string;
  name?: string;
  startAt?: string;
  firstDayKst?: string;
  lastDayKst?: string;
  initialCapitalKrw?: string;
  minTradedInstruments?: string;
  minTurnoverRatio?: string;
  feeSourceSeasonId?: string;
};

export type SeasonSchedule = {
  startAt: Date;
  endAt: Date;
  firstDayKst: string;
  lastDayKst: string;
};

const fail = (message: string): never => {
  throw /* @diagnosticSurface internal: Operator-only season schedule guard; the CLI prints this and writes nothing. */ new Error(
    message,
  );
};

/** 00:00 KST of a real Gregorian day given as YYYY-MM-DD. */
export function kstDayStart(day: string): Date {
  const match = KST_DAY.exec(day ?? '');
  if (!match) return fail('A KST day must be YYYY-MM-DD.');
  const [year, month, date] = match.slice(1).map(Number);
  const midnight = new Date(Date.UTC(year, month - 1, date));
  if (
    midnight.getUTCFullYear() !== year ||
    midnight.getUTCMonth() !== month - 1 ||
    midnight.getUTCDate() !== date
  )
    return fail(`Invalid calendar day ${day}.`);
  return new Date(midnight.getTime() - KST_OFFSET_MS);
}

/** The KST calendar day (YYYY-MM-DD) an instant falls on. */
export function kstDayOf(instant: Date): string {
  return new Date(instant.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** An instant written in Korea time, e.g. 2026-11-30T00:00:00.000+09:00. */
export function formatKstInstant(instant: Date): string {
  return `${new Date(instant.getTime() + KST_OFFSET_MS).toISOString().slice(0, 23)}+09:00`;
}

/**
 * The operator's schedule: an exact start (ISO with Z or an offset) that must
 * fall on the approved first KST day, and the last KST operating day. The end
 * is derived, never typed: 00:00 KST after the last day (exclusive).
 */
export function resolveSeasonSchedule(input: {
  startAt?: string;
  firstDayKst?: string;
  lastDayKst?: string;
}): SeasonSchedule {
  const startAt = parseLaunchStart(input.startAt ?? '');
  const firstDayKst = input.firstDayKst ?? '';
  const lastDayKst = input.lastDayKst ?? '';
  const first = kstDayStart(firstDayKst);
  const last = kstDayStart(lastDayKst);
  if (kstDayOf(startAt) !== firstDayKst)
    fail(
      `start-at is ${formatKstInstant(startAt)} (KST day ${kstDayOf(startAt)}), not on the approved first day ${firstDayKst}.`,
    );
  if (last.getTime() < first.getTime())
    fail('The last operating day is before the first.');
  const operatingDays = (last.getTime() - first.getTime()) / DAY_MS + 1;
  if (operatingDays > MAX_OPERATING_DAYS)
    fail(`A season of ${operatingDays} days is not plausible.`);
  return {
    startAt,
    endAt: new Date(last.getTime() + DAY_MS),
    firstDayKst,
    lastDayKst,
  };
}

/** The schedule as the plan shows it to the operator (KST and UTC side by side). */
export function describeSeasonSchedule(schedule: SeasonSchedule) {
  const lastTradingInstant = new Date(schedule.endAt.getTime() - 1);
  return {
    timeZone: 'Asia/Seoul',
    firstDayKst: schedule.firstDayKst,
    lastDayKst: schedule.lastDayKst,
    operatingDays:
      (kstDayStart(schedule.lastDayKst).getTime() -
        kstDayStart(schedule.firstDayKst).getTime()) /
        DAY_MS +
      1,
    startAtUtc: schedule.startAt.toISOString(),
    startAtKst: formatKstInstant(schedule.startAt),
    endAtUtc: schedule.endAt.toISOString(),
    endAtKst: formatKstInstant(schedule.endAt),
    endIsExclusive: true,
    lastTradingInstantKst: formatKstInstant(lastTradingInstant),
    appDisplay: `${schedule.firstDayKst.replaceAll('-', '.')} ~ ${kstDayOf(lastTradingInstant).replaceAll('-', '.')}`,
  };
}

/** Name, capital, final-ranking rule and fee source of a new regular season. */
export function parseSeasonSettings(request: ScheduledSeasonRequest) {
  const id = request.seasonId?.trim() ?? '';
  if (!SEASON_ID.test(id) || id === DEVELOPMENT_SEASON_ID)
    fail(
      'A new, explicit season ID (3-64 of A-Z a-z 0-9 _ -) is required; the development season ID is never reused.',
    );
  const name = request.name ?? '';
  if (
    !name.trim() ||
    name !== name.trim() ||
    name.length > 40 ||
    /\p{Cc}/u.test(name)
  )
    fail(
      'A season name of 1-40 characters without surrounding spaces is required.',
    );
  const capital = request.initialCapitalKrw ?? '';
  if (!MONEY.test(capital) || !/[1-9]/.test(capital))
    fail(
      'initial-capital-krw must be a positive KRW amount (up to 8 decimals).',
    );
  const minTraded = request.minTradedInstruments ?? '';
  if (!COUNT.test(minTraded) || Number(minTraded) < 1)
    fail('min-traded-instruments must be a whole number of at least 1.');
  const ratio = request.minTurnoverRatio ?? '';
  if (!RATIO.test(ratio) || !/[1-9]/.test(ratio))
    fail(
      'min-turnover-ratio must be positive with up to 4 decimals (3 = 300%).',
    );
  const feeSourceSeasonId = request.feeSourceSeasonId?.trim() ?? '';
  if (!feeSourceSeasonId)
    fail('fee-source-season-id is required: fees are copied, never typed.');
  return {
    id,
    name,
    initialCapitalKrw: capital,
    finalRankingMinTradedInstruments: Number(minTraded),
    finalRankingMinTurnoverRatio: ratio,
    feeSourceSeasonId,
  };
}

/** Another armed launch owns a pending cutover; a regular season never races it. */
async function assertNoArmedLaunch(tx: Tx) {
  const armed = await tx.season.findFirst({
    where: { launchArmed: true },
    select: { id: true },
  });
  if (armed) fail(`Launch ${armed.id} is armed; disarm or finish it first.`);
}

/**
 * Two seasons may never be tradable at once (the lifecycle refuses duplicate
 * active seasons). Unlike a launch cutover, a regular season replaces nothing,
 * so every non-suspended upcoming/active window counts, the development
 * season included.
 */
async function assertNoOverlappingSeason(
  tx: Tx,
  id: string,
  startAt: Date,
  endAt: Date,
) {
  const conflict = await tx.season.findFirst({
    where: {
      id: { not: id },
      suspendedAt: null,
      status: { in: [SeasonStatus.upcoming, SeasonStatus.active] },
      startAt: { lt: endAt },
      endAt: { gt: startAt },
    },
    select: { id: true },
  });
  if (conflict) fail(`Season window conflicts with ${conflict.id}.`);
}

/**
 * Creates one upcoming regular season (`apply`), or returns exactly what it
 * would create (dry run). The caller holds the season administration lock; the
 * start is checked against the database clock, never a process clock.
 */
export async function prepareScheduledSeason(
  tx: Tx,
  request: ScheduledSeasonRequest,
  now: Date,
  apply = true,
) {
  const settings = parseSeasonSettings(request);
  const schedule = resolveSeasonSchedule(request);
  if (
    await tx.season.findUnique({
      where: { id: settings.id },
      select: { id: true },
    })
  )
    fail('Season ID already exists; a new season always gets a new ID.');
  if (
    await tx.operatorAuditLog.findFirst({
      where: {
        targetType: SCHEDULED_SEASON_AUDIT_TARGET,
        targetId: settings.id,
      },
      select: { id: true },
    })
  )
    fail('This season ID has already been used; choose a fresh ID.');
  if (schedule.startAt.getTime() <= now.getTime())
    fail(
      `The start ${formatKstInstant(schedule.startAt)} is not in the future at the database clock ${formatKstInstant(now)}; it is never backdated.`,
    );
  const feeSource = await tx.season.findUnique({
    where: { id: settings.feeSourceSeasonId },
    select: {
      id: true,
      name: true,
      status: true,
      tradeFeeRate: true,
      fxFeeRate: true,
    },
  });
  if (!feeSource) return fail('The fee source season does not exist.');
  await assertNoArmedLaunch(tx);
  await assertNoOverlappingSeason(
    tx,
    settings.id,
    schedule.startAt,
    schedule.endAt,
  );
  const data = {
    id: settings.id,
    name: settings.name,
    status: SeasonStatus.upcoming,
    startAt: schedule.startAt,
    endAt: schedule.endAt,
    initialCapitalKrw: settings.initialCapitalKrw,
    tradeFeeRate: feeSource.tradeFeeRate,
    fxFeeRate: feeSource.fxFeeRate,
    finalRankingMinTradedInstruments: settings.finalRankingMinTradedInstruments,
    finalRankingMinTurnoverRatio: settings.finalRankingMinTurnoverRatio,
  } satisfies Prisma.SeasonUncheckedCreateInput;
  const summary = {
    schedule: describeSeasonSchedule(schedule),
    feeSource: {
      id: feeSource.id,
      name: feeSource.name,
      status: feeSource.status,
      tradeFeeRate: feeSource.tradeFeeRate.toFixed(6),
      fxFeeRate: feeSource.fxFeeRate.toFixed(6),
    },
    launchKind: null,
    displayBadge: null,
  };
  return {
    season: apply ? await tx.season.create({ data }) : data,
    ...summary,
  };
}

/**
 * Moves the window of an upcoming regular season this tool created, before its
 * original start and with no participation or activity at all. Name, capital,
 * fees and the final-ranking rule stay as prepared.
 */
export async function rescheduleScheduledSeason(
  tx: Tx,
  request: ScheduledSeasonRequest,
  now: Date,
  apply = true,
) {
  const id = request.seasonId?.trim() ?? '';
  const season = await tx.season.findUnique({ where: { id } });
  if (!season) return fail('Season not found.');
  if (
    season.launchKind !== null ||
    season.status !== SeasonStatus.upcoming ||
    season.suspendedAt ||
    now.getTime() >= season.startAt.getTime()
  )
    fail(
      'Only an unused upcoming regular season before its original start can be rescheduled.',
    );
  if (
    !(await tx.operatorAuditLog.findFirst({
      where: {
        targetType: SCHEDULED_SEASON_AUDIT_TARGET,
        targetId: id,
        action: PREPARE_SEASON_AUDIT_ACTION,
      },
      select: { id: true },
    }))
  )
    fail('Only a season prepared with prepare-season can be rescheduled here.');
  const counts = await Promise.all([
    tx.seasonParticipant.count({ where: { seasonId: id } }),
    tx.seasonRanking.count({ where: { seasonId: id } }),
    tx.futuresSeasonPrice.count({ where: { seasonId: id } }),
    tx.futuresSeasonSettlement.count({ where: { seasonId: id } }),
    tx.seasonReward.count({ where: { seasonId: id } }),
    tx.userBadge.count({ where: { seasonId: id } }),
    tx.rewardFulfillmentRequest.count({ where: { seasonId: id } }),
  ]);
  if (counts.some(Boolean))
    fail('Season already has participation or activity.');
  const schedule = resolveSeasonSchedule(request);
  if (schedule.startAt.getTime() <= now.getTime())
    fail('The new start must be in the future at the database clock.');
  await assertNoArmedLaunch(tx);
  await assertNoOverlappingSeason(tx, id, schedule.startAt, schedule.endAt);
  const summary = { schedule: describeSeasonSchedule(schedule) };
  return {
    season: apply
      ? await tx.season.update({
          where: { id },
          data: { startAt: schedule.startAt, endAt: schedule.endAt },
        })
      : { ...season, startAt: schedule.startAt, endAt: schedule.endAt },
    ...summary,
  };
}
