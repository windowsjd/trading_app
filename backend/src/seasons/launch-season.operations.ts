import { Prisma, SeasonStatus } from '../generated/prisma/client';
import {
  DEVELOPMENT_SEASON_ID,
  LAUNCH_DURATION_MS,
} from './season-availability.policy';

type Tx = Prisma.TransactionClient;
export type LaunchKind = 'test' | 'release';

/** Shared by the existing lifecycle job and the operator CLI, never process-local. */
export async function lockSeasonAdministration(
  tx: Tx,
  targetId: string | null = null,
) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(18741, 0)::text`;
  await tx.$queryRaw`
    SELECT id FROM seasons
    WHERE status IN ('active', 'upcoming') OR id = ${DEVELOPMENT_SEASON_ID} OR id = ${targetId}
    ORDER BY id FOR UPDATE`;
}

export async function seasonDatabaseNow(tx: Tx): Promise<Date> {
  const [clock] = await tx.$queryRaw<
    { now: Date; timezone: string }[]
  >`SELECT clock_timestamp() AS now, current_setting('TimeZone') AS timezone`;
  if (
    !clock?.now ||
    !['UTC', 'Etc/UTC', 'GMT', 'Etc/GMT'].includes(clock.timezone)
  )
    throw /* @diagnosticSurface internal: Operator-only launch guard; CLI or existing BatchService records this failure. */ new Error(
      'Launch operations require an available database clock and a UTC database session.',
    );
  return clock.now;
}

export function parseLaunchStart(value: string): Date {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  ) {
    throw /* @diagnosticSurface internal: Operator-only launch guard; CLI or existing BatchService records this failure. */ new Error(
      'start-at must be an ISO date-time with Z or an explicit offset.',
    );
  }
  const start = new Date(value);
  const [year, month, day, hour, minute, second] = value
    .slice(0, 19)
    .split(/[-T:]/)
    .map(Number);
  const monthDays = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > monthDays[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    throw /* @diagnosticSurface internal: Operator-only launch guard; CLI or existing BatchService records this failure. */ new Error(
      'Invalid calendar date-time.',
    );
  if (!Number.isFinite(start.getTime()))
    throw /* @diagnosticSurface internal: Operator-only launch guard; CLI or existing BatchService records this failure. */ new Error(
      'Invalid start-at.',
    );
  return start;
}

export async function requireLaunchSeason(tx: Tx, id: string) {
  const season = await tx.season.findUniqueOrThrow({ where: { id } });
  if (season.launchKind !== 'test' && season.launchKind !== 'release')
    throw /* @diagnosticSurface internal: Operator-only launch guard; CLI or existing BatchService records this failure. */ new Error(
      'Not a launch season.',
    );
  return season;
}

async function assertUnusedUpcoming(tx: Tx, id: string, now: Date) {
  const season = await requireLaunchSeason(tx, id);
  if (
    season.status !== 'upcoming' ||
    now >= season.startAt ||
    season.launchActivatedAt ||
    season.suspendedAt
  ) {
    throw /* @diagnosticSurface internal: Operator-only launch guard; CLI or existing BatchService records this failure. */ new Error(
      'Only an unused upcoming season before its original start can be changed.',
    );
  }
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
    throw /* @diagnosticSurface internal: Operator-only launch guard; CLI or existing BatchService records this failure. */ new Error(
      'Season already has participation or activity.',
    );
  return season;
}

async function assertNoConflictingWindow(
  tx: Tx,
  id: string,
  startAt: Date,
  endAt: Date,
) {
  const conflict = await tx.season.findFirst({
    where: {
      id: { notIn: [id, DEVELOPMENT_SEASON_ID] },
      suspendedAt: null,
      status: { in: ['active', 'upcoming'] },
      startAt: { lt: endAt },
      endAt: { gt: startAt },
    },
    select: { id: true },
  });
  if (conflict)
    throw /* @diagnosticSurface internal: Operator-only launch guard; CLI or existing BatchService records this failure. */ new Error(
      `Season window conflicts with ${conflict.id}.`,
    );
}

export async function prepareLaunchSeason(
  tx: Tx,
  input: {
    id: string;
    kind: LaunchKind;
    startAt: Date;
    testUserIds: string[];
  },
  now: Date,
  apply = true,
) {
  if (!input.id.trim() || input.id === DEVELOPMENT_SEASON_ID)
    throw /* @diagnosticSurface internal: Operator-only launch guard; CLI or existing BatchService records this failure. */ new Error(
      'A new, explicit launch season ID is required.',
    );
  if (
    await tx.season.findUnique({
      where: { id: input.id },
      select: { id: true },
    })
  )
    throw /* @diagnosticSurface internal: Operator-only launch guard; CLI or existing BatchService records this failure. */ new Error(
      'Launch season ID already exists.',
    );
  if (input.kind !== 'test' && input.kind !== 'release')
    throw /* @diagnosticSurface internal: Operator-only launch guard; CLI or existing BatchService records this failure. */ new Error(
      'Invalid launch kind.',
    );
  if (!Number.isFinite(input.startAt.getTime()) || input.startAt <= now)
    throw /* @diagnosticSurface internal: Operator-only launch guard; CLI or existing BatchService records this failure. */ new Error(
      'The start must be in the future.',
    );
  if (
    await tx.operatorAuditLog.findFirst({
      where: { targetType: 'launch_season', targetId: input.id },
      select: { id: true },
    })
  ) {
    throw /* @diagnosticSurface internal: Operator-only launch guard; CLI or existing BatchService records this failure. */ new Error(
      'This launch ID has already been used; generate a fresh ID.',
    );
  }
  const users = [...new Set(input.testUserIds)].sort();
  if (
    (input.kind === 'test' && (!users.length || users.length > 20)) ||
    (input.kind === 'release' && users.length)
  ) {
    throw /* @diagnosticSurface internal: Operator-only launch guard; CLI or existing BatchService records this failure. */ new Error(
      'Only a test launch requires a nonempty allowlist.',
    );
  }
  if (
    users.length &&
    (await tx.user.count({
      where: { id: { in: users }, status: 'active' },
    })) !== users.length
  ) {
    throw /* @diagnosticSurface internal: Operator-only launch guard; CLI or existing BatchService records this failure. */ new Error(
      'Every allowlisted user must exist and be active.',
    );
  }
  const development = await tx.season.findUniqueOrThrow({
    where: { id: DEVELOPMENT_SEASON_ID },
  });
  const endAt = new Date(input.startAt.getTime() + LAUNCH_DURATION_MS);
  await assertNoConflictingWindow(tx, input.id, input.startAt, endAt);
  const data = {
    id: input.id,
    name: 'season0',
    status: 'upcoming' as const,
    startAt: input.startAt,
    endAt,
    initialCapitalKrw: '10000000',
    tradeFeeRate: development.tradeFeeRate,
    fxFeeRate: development.fxFeeRate,
    finalRankingMinTradedInstruments: 5,
    finalRankingMinTurnoverRatio: '3',
    launchKind: input.kind,
    launchTestUserIds: users,
  } satisfies Prisma.SeasonUncheckedCreateInput;
  return apply ? tx.season.create({ data }) : data;
}

export async function rescheduleLaunchSeason(
  tx: Tx,
  id: string,
  startAt: Date,
  now: Date,
  apply = true,
) {
  const season = await assertUnusedUpcoming(tx, id, now);
  if (!Number.isFinite(startAt.getTime()) || startAt <= now)
    throw /* @diagnosticSurface internal: Operator-only launch guard; CLI or existing BatchService records this failure. */ new Error(
      'The new start must be in the future.',
    );
  const endAt = new Date(startAt.getTime() + LAUNCH_DURATION_MS);
  await assertNoConflictingWindow(tx, id, startAt, endAt);
  if (season.launchArmed) {
    const source = await tx.season.findUniqueOrThrow({
      where: { id: DEVELOPMENT_SEASON_ID },
    });
    if (
      source.suspendedAt ||
      source.tradingCutoffAt?.getTime() !== season.startAt.getTime()
    )
      throw /* @diagnosticSurface internal: Operator-only launch guard; CLI or existing BatchService records this failure. */ new Error(
        'Development cutoff ownership changed.',
      );
    if (apply)
      await tx.season.update({
        where: { id: source.id },
        data: { tradingCutoffAt: startAt },
      });
  }
  return apply
    ? tx.season.update({ where: { id }, data: { startAt, endAt } })
    : { ...season, startAt, endAt };
}

export async function armLaunchSeason(
  tx: Tx,
  id: string,
  now: Date,
  arm: boolean,
  apply = true,
) {
  const season = await assertUnusedUpcoming(tx, id, now);
  const source = await tx.season.findUniqueOrThrow({
    where: { id: DEVELOPMENT_SEASON_ID },
  });
  if (
    source.status !== 'active' ||
    source.suspendedAt ||
    now < source.startAt ||
    now >= source.endAt
  )
    throw /* @diagnosticSurface internal: Operator-only launch guard; CLI or existing BatchService records this failure. */ new Error(
      'Development season is not available.',
    );
  if (!arm) {
    if (!season.launchArmed) return season;
    if (source.tradingCutoffAt?.getTime() !== season.startAt.getTime())
      throw /* @diagnosticSurface internal: Operator-only launch guard; CLI or existing BatchService records this failure. */ new Error(
        'Development cutoff ownership changed.',
      );
    if (apply)
      await tx.season.update({
        where: { id: source.id },
        data: { tradingCutoffAt: null },
      });
    return apply
      ? tx.season.update({ where: { id }, data: { launchArmed: false } })
      : { ...season, launchArmed: false };
  }
  if (season.launchArmed) return season;
  if (source.tradingCutoffAt)
    throw /* @diagnosticSurface internal: Operator-only launch guard; CLI or existing BatchService records this failure. */ new Error(
      'Another cutover already owns the development cutoff.',
    );
  if (await tx.season.count({ where: { id: { not: id }, launchArmed: true } }))
    throw /* @diagnosticSurface internal: Operator-only launch guard; CLI or existing BatchService records this failure. */ new Error(
      'Another launch is armed.',
    );
  await assertNoConflictingWindow(tx, id, season.startAt, season.endAt);
  const snapshot = {
    id: source.id,
    name: source.name,
    status: source.status,
    startAt: source.startAt.toISOString(),
    endAt: source.endAt.toISOString(),
    initialCapitalKrw: source.initialCapitalKrw.toFixed(8),
    tradeFeeRate: source.tradeFeeRate.toFixed(6),
    fxFeeRate: source.fxFeeRate.toFixed(6),
    finalRankingMinTradedInstruments: source.finalRankingMinTradedInstruments,
    finalRankingMinTurnoverRatio:
      source.finalRankingMinTurnoverRatio?.toString() ?? null,
  };
  if (apply)
    await tx.season.update({
      where: { id: source.id },
      data: { tradingCutoffAt: season.startAt },
    });
  return apply
    ? tx.season.update({
        where: { id },
        data: { launchArmed: true, launchSourceSnapshotJson: snapshot },
      })
    : { ...season, launchArmed: true, launchSourceSnapshotJson: snapshot };
}

/** Caller holds administration + Season locks; the activation uses the DB clock. */
export async function activateLaunchSeason(
  tx: Tx,
  id: string,
  now: Date,
  apply = true,
) {
  const season = await requireLaunchSeason(tx, id);
  if (
    season.status === 'active' &&
    season.launchActivatedAt &&
    !season.suspendedAt
  )
    return season;
  if (
    !season.launchSourceSnapshotJson ||
    season.status !== 'upcoming' ||
    !season.launchArmed ||
    season.suspendedAt ||
    now < season.startAt ||
    now >= season.endAt
  ) {
    throw /* @diagnosticSurface internal: Operator-only launch guard; CLI or existing BatchService records this failure. */ new Error(
      'Launch is not armed and due at the database clock.',
    );
  }
  const source = await tx.season.findUniqueOrThrow({
    where: { id: DEVELOPMENT_SEASON_ID },
  });
  if (
    source.status !== 'active' ||
    source.suspendedAt ||
    source.tradingCutoffAt?.getTime() !== season.startAt.getTime()
  )
    throw /* @diagnosticSurface internal: Operator-only launch guard; CLI or existing BatchService records this failure. */ new Error(
      'Development cutover ownership changed.',
    );
  const other = await tx.season.count({
    where: {
      id: { notIn: [source.id, id] },
      status: 'active',
      suspendedAt: null,
      endAt: { gt: now },
    },
  });
  if (other)
    throw /* @diagnosticSurface internal: Operator-only launch guard; CLI or existing BatchService records this failure. */ new Error(
      'DUPLICATE_ACTIVE_SEASON',
    );
  if (apply)
    await tx.season.update({
      where: { id: source.id },
      data: { suspendedAt: now },
    });
  return apply
    ? tx.season.update({
        where: { id },
        data: {
          status: SeasonStatus.active,
          launchArmed: false,
          launchActivatedAt: now,
        },
      })
    : {
        ...season,
        status: SeasonStatus.active,
        launchArmed: false,
        launchActivatedAt: now,
      };
}

export async function stopLaunchTest(
  tx: Tx,
  id: string,
  now: Date,
  apply = true,
) {
  const season = await requireLaunchSeason(tx, id);
  if (season.launchKind !== 'test' || !season.launchActivatedAt)
    throw /* @diagnosticSurface internal: Operator-only launch guard; CLI or existing BatchService records this failure. */ new Error(
      'Only an activated test launch may be stopped.',
    );
  if (season.suspendedAt) return season;
  return apply
    ? tx.season.update({
        where: { id },
        data: { suspendedAt: now, launchArmed: false },
      })
    : { ...season, suspendedAt: now, launchArmed: false };
}

export async function restoreDevelopmentSeason(
  tx: Tx,
  id: string,
  now: Date,
  apply = true,
) {
  const test = await requireLaunchSeason(tx, id);
  if (
    test.launchKind !== 'test' ||
    !test.launchActivatedAt ||
    !test.suspendedAt
  )
    throw /* @diagnosticSurface internal: Operator-only launch guard; CLI or existing BatchService records this failure. */ new Error(
      'Only a stopped, activated test can restore development.',
    );
  const source = await tx.season.findUniqueOrThrow({
    where: { id: DEVELOPMENT_SEASON_ID },
  });
  if (source.status !== 'active' || now < source.startAt || now >= source.endAt)
    throw /* @diagnosticSurface internal: Operator-only launch guard; CLI or existing BatchService records this failure. */ new Error(
      'Development lifecycle changed; no automatic repair.',
    );
  const saved = test.launchSourceSnapshotJson as Record<string, unknown> | null;
  if (
    !saved ||
    source.name !== saved.name ||
    source.startAt.toISOString() !== saved.startAt ||
    source.endAt.toISOString() !== saved.endAt ||
    source.initialCapitalKrw.toFixed(8) !== saved.initialCapitalKrw ||
    source.tradeFeeRate.toFixed(6) !== saved.tradeFeeRate ||
    source.fxFeeRate.toFixed(6) !== saved.fxFeeRate ||
    source.finalRankingMinTradedInstruments !==
      saved.finalRankingMinTradedInstruments ||
    (source.finalRankingMinTurnoverRatio?.toString() ?? null) !==
      saved.finalRankingMinTurnoverRatio
  ) {
    throw /* @diagnosticSurface internal: Operator-only launch guard; CLI or existing BatchService records this failure. */ new Error(
      'Original development configuration changed; refusing to rewrite it.',
    );
  }
  if (
    await tx.season.count({
      where: {
        id: { not: source.id },
        status: 'active',
        suspendedAt: null,
        endAt: { gt: now },
      },
    })
  ) {
    throw /* @diagnosticSurface internal: Operator-only launch guard; CLI or existing BatchService records this failure. */ new Error(
      'Another active season prevents development restoration.',
    );
  }
  if (!source.suspendedAt && !source.tradingCutoffAt) return source;
  if (
    source.suspendedAt?.getTime() !== test.launchActivatedAt.getTime() ||
    source.tradingCutoffAt?.getTime() !== test.startAt.getTime()
  )
    throw /* @diagnosticSurface internal: Operator-only launch guard; CLI or existing BatchService records this failure. */ new Error(
      'A different cutover owns development suspension.',
    );
  return apply
    ? tx.season.update({
        where: { id: source.id },
        data: { suspendedAt: null, tradingCutoffAt: null },
      })
    : { ...source, suspendedAt: null, tradingCutoffAt: null };
}
