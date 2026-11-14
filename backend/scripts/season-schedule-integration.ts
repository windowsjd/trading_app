/**
 * Regular season creation (docs/season-schedule-operations.md), opt-in
 * disposable local PostgreSQL only. Never loads production env files.
 *
 * Mirrors production on 2026-11-14: the development season is suspended, the
 * settled launch `season0` (release) stays, and a second, settled regular
 * `season0` exists with participants. A NEW `season0` is then prepared through
 * the real CLI plan/apply functions (READ ONLY dry run → fingerprinted apply
 * → audit), activated by the real lifecycle job, joined through the real join,
 * ended (boundary brought forward on the fixture only) and settled by the real
 * settlement job. Every earlier season's rows must stay byte-identical.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpException, Logger } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { BatchService } from '../src/batch/batch.service';
import { SeasonLifecycleTransitionJobService } from '../src/batch/season-lifecycle-transition-job.service';
import { SeasonSettlementJobService } from '../src/batch/season-settlement-job.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { RankingService } from '../src/ranking/ranking.service';
import { formatKstRankingDate } from '../src/ranking/ranking-date.policy';
import { RecordsService } from '../src/records/records.service';
import { SeasonFinalResultService } from '../src/records/season-final-result.service';
import { DEVELOPMENT_SEASON_ID } from '../src/seasons/season-availability.policy';
import {
  lockSeasonAdministration,
  seasonDatabaseNow,
} from '../src/seasons/launch-season.operations';
import {
  kstDayOf,
  kstDayStart,
  prepareScheduledSeason,
} from '../src/seasons/scheduled-season.operations';
import { SeasonsService } from '../src/seasons/seasons.service';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import { TradingAccountsService } from '../src/trading-accounts/trading-accounts.service';
import {
  applyLaunchPlan,
  planLaunchRequest,
  type LaunchRequest,
} from './launch-season';

const target = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (
  process.env.NODE_ENV !== 'test' ||
  process.env.SEASON_SCHEDULE_DB_INTEGRATION !== '1' ||
  !['localhost', '127.0.0.1'].includes(target.hostname) ||
  !target.pathname.endsWith('_test')
)
  throw new Error(
    'Requires NODE_ENV=test, SEASON_SCHEDULE_DB_INTEGRATION=1 and an explicit disposable loopback *_test DB.',
  );
Logger.overrideLogger(false);

const db = new PrismaService();
const valuation = new PortfolioValuationService(db);
const seasons = new SeasonsService(db);
const accounts = new TradingAccountsService(
  new TradingAccountAccessService(db),
);
const records = new RecordsService(db, valuation);
const finalResults = new SeasonFinalResultService(db);
const ranking = new RankingService(db);
const lifecycle = new SeasonLifecycleTransitionJobService(
  new BatchService(db),
  db,
);
const run = randomUUID().slice(0, 8);
const environment = {
  user: target.username,
  host: target.hostname,
  port: target.port || '(default)',
  database: target.pathname.replace(/^\//u, ''),
};
const confirm = `${environment.host}:${environment.port}/${environment.database}`;
const DAY = 86_400_000;
const releaseId = `sea_2026_s0_release_${run}`;
const previousId = `prev-season0-${run}`;
const nextId = `sea_2026_s0_next_${run}`;

let assertions = 0;
function ok(value: boolean, message: string) {
  assert.equal(value, true, message);
  assertions++;
}
async function rejected(p: Promise<unknown>, pattern: RegExp, message: string) {
  await assert.rejects(p, pattern, message);
  assertions++;
}
const errorCode = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'NO_ERROR';
  } catch (error) {
    if (error instanceof HttpException)
      return (
        (error.getResponse() as { error?: { code?: string } }).error?.code ??
        'HTTP'
      );
    return error instanceof Error ? error.message : String(error);
  }
};
const dbNow = () =>
  seasonDatabaseNow(db as unknown as Prisma.TransactionClient);
/** Waits on the database clock (the one every season boundary is judged by). */
async function untilDb(instant: Date, margin = 300) {
  for (let i = 0; i < 200; i++) {
    const now = await dbNow();
    if (now.getTime() >= instant.getTime() + margin) return now;
    await delay(
      Math.min(1000, instant.getTime() + margin - now.getTime() + 20),
    );
  }
  throw new Error('database clock never reached the boundary');
}
async function tick(label: string) {
  return lifecycle.run({
    idempotencyKey: `schedule-${run}-${label}-${randomUUID()}`,
    now: (await dbNow()).toISOString(),
  });
}
async function settle(seasonId: string, endAt: Date, label: string) {
  return new SeasonSettlementJobService(
    new BatchService(db),
    db,
    valuation,
  ).run({
    seasonId,
    settlementDate: formatKstRankingDate(endAt),
    idempotencyKey: `schedule-${run}-settle-${label}`,
    requestedBy: 'season-schedule-integration',
  });
}
const addDays = (day: string, days: number) =>
  kstDayOf(new Date(kstDayStart(day).getTime() + days * DAY));

/** Every row an earlier season owns, by season ID and by its accounts. */
async function seasonFingerprint(seasonId: string) {
  const participants = await db.seasonParticipant.findMany({
    where: { seasonId },
    orderBy: { id: 'asc' },
  });
  const accountIds = participants.map((p) => p.tradingAccountId);
  return JSON.stringify({
    season: await db.season.findUnique({ where: { id: seasonId } }),
    participants,
    accounts: await db.tradingAccount.findMany({
      where: { id: { in: accountIds } },
      orderBy: { id: 'asc' },
    }),
    wallets: await db.cashWallet.findMany({
      where: { tradingAccountId: { in: accountIds } },
      orderBy: { id: 'asc' },
    }),
    ledger: await db.walletTransaction.findMany({
      where: { tradingAccountId: { in: accountIds } },
      orderBy: { id: 'asc' },
    }),
    orders: await db.order.findMany({
      where: { tradingAccountId: { in: accountIds } },
      orderBy: { id: 'asc' },
    }),
    positions: await db.position.findMany({
      where: { tradingAccountId: { in: accountIds } },
      orderBy: { id: 'asc' },
    }),
    snapshots: await db.equitySnapshot.findMany({
      where: { tradingAccountId: { in: accountIds } },
      orderBy: { id: 'asc' },
    }),
    rankings: await db.seasonRanking.findMany({
      where: { seasonId },
      orderBy: { id: 'asc' },
    }),
    rewards: await db.seasonReward.findMany({
      where: { seasonId },
      orderBy: { id: 'asc' },
    }),
    badges: await db.userBadge.findMany({
      where: { seasonId },
      orderBy: { id: 'asc' },
    }),
  });
}

async function main() {
  ok((await db.season.count()) === 0, 'dedicated fixture DB starts empty');
  const user = (label: string, role: 'user' | 'admin' = 'user') =>
    db.user.create({
      data: {
        email: `${label}-${run}@example.invalid`,
        nickname: `${label}-${run}`,
        passwordHash: 'fixture',
        role,
      },
    });
  const admin = await user('admin', 'admin');
  const alice = await user('alice');
  const bob = await user('bob');
  const carol = await user('carol');

  // --- Production shape before the new season -------------------------------
  const t0 = await dbNow();
  await db.season.create({
    data: {
      id: DEVELOPMENT_SEASON_ID,
      name: 'Season 1',
      status: 'active',
      startAt: new Date('2000-01-01T00:00:00Z'),
      endAt: new Date('2099-12-31T23:59:59Z'),
      initialCapitalKrw: '10000000',
      tradeFeeRate: '0.001',
      fxFeeRate: '0.001',
      suspendedAt: new Date(t0.getTime() - 21 * DAY),
    },
  });
  // The settled launch season0 (504 h, beta) as the release left it.
  await db.season.create({
    data: {
      id: releaseId,
      name: 'season0',
      status: 'settled',
      startAt: new Date(t0.getTime() - 22 * DAY),
      endAt: new Date(t0.getTime() - DAY),
      initialCapitalKrw: '10000000',
      tradeFeeRate: '0.001',
      fxFeeRate: '0.001',
      finalRankingMinTradedInstruments: 5,
      finalRankingMinTurnoverRatio: '3',
      launchKind: 'release',
      launchActivatedAt: new Date(t0.getTime() - 22 * DAY),
      launchSourceSnapshotJson: { id: DEVELOPMENT_SEASON_ID },
    },
  });
  // A regular season0 with participants, run through the real lifecycle,
  // join and settlement (a short window on the fixture only).
  const prevStart = new Date(t0.getTime() + 1500);
  const prevEnd = new Date(prevStart.getTime() + 4000);
  await db.season.create({
    data: {
      id: previousId,
      name: 'season0',
      status: 'upcoming',
      startAt: prevStart,
      endAt: prevEnd,
      initialCapitalKrw: '10000000',
      tradeFeeRate: '0.001',
      fxFeeRate: '0.002',
      finalRankingMinTradedInstruments: 5,
      finalRankingMinTurnoverRatio: '3',
    },
  });
  await untilDb(prevStart);
  await tick('prev-activate');
  ok(
    (await db.season.findUniqueOrThrow({ where: { id: previousId } }))
      .status === 'active',
    'the lifecycle activates a regular upcoming season',
  );
  const previousJoin = await seasons.joinSeason(previousId, alice.id);
  await seasons.joinSeason(previousId, bob.id);
  await untilDb(prevEnd);
  await tick('prev-end');
  ok(
    (await db.season.findUniqueOrThrow({ where: { id: previousId } }))
      .status === 'ended',
    'the lifecycle ends it at endAt',
  );
  await settle(previousId, prevEnd, 'prev');
  ok(
    (await db.season.findUniqueOrThrow({ where: { id: previousId } }))
      .status === 'settled',
    'the previous season0 settles',
  );
  const previousRows = await seasonFingerprint(previousId);
  const releaseRows = await seasonFingerprint(releaseId);
  const developmentRows = await seasonFingerprint(DEVELOPMENT_SEASON_ID);

  // --- The new season0: plan (READ ONLY), refusals, apply -------------------
  const now = await dbNow();
  const startAt = new Date(now.getTime() + 6000);
  const firstDayKst = kstDayOf(startAt);
  const lastDayKst = addDays(firstDayKst, 15);
  const request: LaunchRequest = {
    action: 'prepare-season',
    seasonId: nextId,
    actorUserId: admin.id,
    name: 'season0',
    startAt: startAt.toISOString(),
    firstDayKst,
    lastDayKst,
    initialCapitalKrw: '10000000',
    minTradedInstruments: '5',
    minTurnoverRatio: '3',
    feeSourceSeasonId: releaseId,
  };
  const seasonsBefore = await db.season.count();
  const auditsBefore = await db.operatorAuditLog.count();
  const plan = await planLaunchRequest(db, environment, request);
  ok(
    (await db.season.count()) === seasonsBefore &&
      (await db.operatorAuditLog.count()) === auditsBefore,
    'the dry run writes no season and no audit row',
  );
  ok(plan.fingerprint.length === 64, 'the plan is fingerprinted');
  const preview = plan.inspection.preview as {
    season: Record<string, unknown>;
    schedule: Record<string, unknown>;
    feeSource: Record<string, unknown>;
    launchKind: null;
  };
  ok(
    preview.season.name === 'season0' &&
      preview.season.status === 'upcoming' &&
      preview.season.initialCapitalKrw === '10000000' &&
      preview.season.finalRankingMinTradedInstruments === 5 &&
      preview.season.finalRankingMinTurnoverRatio === '3' &&
      preview.launchKind === null,
    'the preview is a regular season0 with 10,000,000 KRW and 5 instruments AND 300%',
  );
  ok(
    preview.feeSource.tradeFeeRate === '0.001000' &&
      preview.feeSource.fxFeeRate === '0.001000',
    'fees are copied from the named source season',
  );
  ok(
    preview.schedule.operatingDays === 16 &&
      preview.schedule.endAtKst ===
        `${addDays(lastDayKst, 1)}T00:00:00.000+09:00` &&
      preview.schedule.lastTradingInstantKst ===
        `${lastDayKst}T23:59:59.999+09:00`,
    'the plan shows 16 KST days ending at the next KST midnight (exclusive)',
  );
  await rejected(
    planLaunchRequest(db, environment, { ...request, actorUserId: carol.id }),
    /operator\/admin/,
    'an ordinary user cannot administer seasons',
  );
  const refusals: Array<[Partial<LaunchRequest>, RegExp, string]> = [
    [
      { startAt: new Date(now.getTime() - 1000).toISOString() },
      /approved first day|never backdated/,
      'past start',
    ],
    [
      {
        firstDayKst: addDays(firstDayKst, 1),
        lastDayKst: addDays(firstDayKst, 16),
      },
      /approved first day/,
      'start off the approved first day',
    ],
    [
      { lastDayKst: addDays(firstDayKst, -1) },
      /before the first/,
      'reversed days',
    ],
    [{ seasonId: previousId }, /already exists/, 'an existing season ID'],
    [{ seasonId: releaseId }, /already exists/, 'the settled release ID'],
    [
      { seasonId: DEVELOPMENT_SEASON_ID },
      /development season/,
      'the development ID',
    ],
    [
      { feeSourceSeasonId: 'missing-season' },
      /fee source/,
      'a missing fee source',
    ],
    [{ initialCapitalKrw: '0' }, /initial-capital-krw/, 'zero capital'],
    [{ minTurnoverRatio: '0' }, /min-turnover-ratio/, 'zero turnover ratio'],
    [
      { minTradedInstruments: '0' },
      /min-traded-instruments/,
      'zero instruments',
    ],
    [{ name: '' }, /season name/, 'an empty name'],
  ];
  for (const [change, pattern, label] of refusals)
    await rejected(
      planLaunchRequest(db, environment, { ...request, ...change }),
      pattern,
      `refused: ${label}`,
    );
  await rejected(
    applyLaunchPlan(db, environment, plan, {
      backupRef: 'local-fixture',
      confirm: `${confirm}/wrong`,
    }),
    /--confirm/,
    'apply requires the exact target confirmation',
  );
  await rejected(
    applyLaunchPlan(db, { ...environment, database: 'other_test' }, plan, {
      backupRef: 'local-fixture',
      confirm: `${environment.host}:${environment.port}/other_test/${nextId}`,
    }),
    /DB identity/,
    'a plan for another DB is refused',
  );
  // A competing plan for another ID over the same window, reviewed at the same time.
  const rival = await planLaunchRequest(db, environment, {
    ...request,
    seasonId: `${nextId}_rival`,
  });
  const applied = await Promise.allSettled([
    applyLaunchPlan(db, environment, plan, {
      backupRef: 'local-fixture',
      confirm: `${confirm}/${nextId}`,
    }),
    applyLaunchPlan(db, environment, rival, {
      backupRef: 'local-fixture',
      confirm: `${confirm}/${nextId}_rival`,
    }),
  ]);
  ok(
    applied.filter((a) => a.status === 'fulfilled').length === 1 &&
      (await db.season.count({
        where: { id: { in: [nextId, `${nextId}_rival`] } },
      })) === 1,
    'two concurrent applies over one window create exactly one season',
  );
  const winnerId = (
    await db.season.findFirstOrThrow({
      where: { id: { in: [nextId, `${nextId}_rival`] } },
    })
  ).id;
  const winnerPlan = winnerId === nextId ? plan : rival;
  const created = await db.season.findUniqueOrThrow({
    where: { id: winnerId },
  });
  ok(
    created.name === 'season0' &&
      created.status === 'upcoming' &&
      created.launchKind === null &&
      !created.launchArmed &&
      created.suspendedAt === null &&
      created.tradingCutoffAt === null &&
      created.startAt.getTime() === startAt.getTime() &&
      created.endAt.getTime() ===
        kstDayStart(addDays(lastDayKst, 1)).getTime() &&
      created.initialCapitalKrw.equals('10000000') &&
      created.tradeFeeRate.equals('0.001') &&
      created.fxFeeRate.equals('0.001') &&
      created.finalRankingMinTradedInstruments === 5 &&
      created.finalRankingMinTurnoverRatio?.equals(3) === true,
    'the stored season keeps the exact UTC instants and the copied fees',
  );
  ok(
    kstDayOf(created.startAt) === firstDayKst &&
      kstDayOf(new Date(created.endAt.getTime() - 1)) === lastDayKst &&
      kstDayOf(created.endAt) === addDays(lastDayKst, 1),
    'stored instants read back on the approved KST days',
  );
  const audit = await db.operatorAuditLog.findFirstOrThrow({
    where: { targetType: 'launch_season', targetId: winnerId },
  });
  ok(
    audit.action === 'launch_season.prepare-season' &&
      audit.actorUserId === admin.id &&
      (audit.metadataJson as { planFingerprint?: string }).planFingerprint ===
        winnerPlan.fingerprint,
    'the apply and its audit row commit together, naming the reviewed plan',
  );
  await rejected(
    applyLaunchPlan(db, environment, winnerPlan, {
      backupRef: 'local-fixture',
      confirm: `${confirm}/${winnerId}`,
    }),
    /changed since approval|already exists/,
    'replaying the applied plan creates nothing',
  );
  await rejected(
    db.$transaction(async (tx) => {
      await lockSeasonAdministration(tx, 'overlap');
      return prepareScheduledSeason(
        tx,
        {
          ...request,
          seasonId: `${nextId}-overlap`,
          startAt: new Date(startAt.getTime() + DAY).toISOString(),
          firstDayKst: addDays(firstDayKst, 1),
        },
        await seasonDatabaseNow(tx),
      );
    }),
    /conflicts with/,
    'an overlapping window is refused',
  );
  ok(
    (await db.season.count()) === seasonsBefore + 1,
    'exactly one new season row exists',
  );
  const listed = (await seasons.getSeasons()).data.seasons;
  ok(
    listed.filter((s) => s.name === 'season0').length === 3 &&
      listed.every((s) => s.id !== DEVELOPMENT_SEASON_ID) &&
      !('displayBadge' in listed.find((s) => s.id === winnerId)!) &&
      listed.find((s) => s.id === releaseId)?.displayBadge === 'beta',
    'three public season0 rows by ID; beta stays the launch metadata only',
  );
  const upcoming = await seasons.getCurrentSeason(alice.id);
  ok(
    upcoming.data.id === winnerId &&
      upcoming.data.effectiveMode === 'upcoming' &&
      !upcoming.data.joined,
    'the new upcoming season becomes current before its start',
  );
  ok(
    (await errorCode(seasons.joinSeason(winnerId, alice.id))) ===
      'SEASON_NOT_ACTIVE',
    'no join before activation',
  );

  // --- Reschedule (unused upcoming only) ------------------------------------
  const later = new Date(startAt.getTime() + 1500);
  if (kstDayOf(later) === firstDayKst) {
    const reschedule = await planLaunchRequest(db, environment, {
      action: 'reschedule-season',
      seasonId: winnerId,
      actorUserId: admin.id,
      startAt: later.toISOString(),
      firstDayKst,
      lastDayKst,
    });
    await applyLaunchPlan(db, environment, reschedule, {
      backupRef: 'local-fixture',
      confirm: `${confirm}/${winnerId}`,
    });
    ok(
      (
        await db.season.findUniqueOrThrow({ where: { id: winnerId } })
      ).startAt.getTime() === later.getTime(),
      'an unused upcoming season can be rescheduled before its start',
    );
  }
  await rejected(
    planLaunchRequest(db, environment, {
      action: 'reschedule-season',
      seasonId: previousId,
      actorUserId: admin.id,
      startAt: request.startAt,
      firstDayKst,
      lastDayKst,
    }),
    /Only an unused upcoming regular season/,
    'a settled season is never rescheduled',
  );

  // --- Activation by the existing lifecycle, join, one initial grant --------
  const scheduled = await db.season.findUniqueOrThrow({
    where: { id: winnerId },
  });
  await untilDb(scheduled.startAt);
  await tick('next-activate');
  ok(
    (await db.season.findUniqueOrThrow({ where: { id: winnerId } })).status ===
      'active',
    'the existing lifecycle activates the new season at its start',
  );
  const current = await seasons.getCurrentSeason(alice.id);
  ok(
    current.data.id === winnerId && current.data.effectiveMode === 'active',
    'current = the new season0',
  );
  const joins = await Promise.allSettled([
    seasons.joinSeason(winnerId, alice.id),
    seasons.joinSeason(winnerId, alice.id),
  ]);
  ok(
    joins.filter((j) => j.status === 'fulfilled').length === 1,
    'concurrent joins have one winner',
  );
  ok(
    (await errorCode(seasons.joinSeason(winnerId, alice.id))) ===
      'SEASON_ALREADY_JOINED',
    'a repeated join is refused',
  );
  await seasons.joinSeason(winnerId, bob.id);
  const newParticipant = await db.seasonParticipant.findUniqueOrThrow({
    where: { seasonId_userId: { seasonId: winnerId, userId: alice.id } },
  });
  ok(
    newParticipant.tradingAccountId !== previousJoin.data.seasonParticipantId &&
      newParticipant.tradingAccountId !==
        (
          await db.seasonParticipant.findUniqueOrThrow({
            where: { id: previousJoin.data.seasonParticipantId },
          })
        ).tradingAccountId,
    'the new season gets a new trading account',
  );
  const grants = await db.walletTransaction.findMany({
    where: {
      tradingAccountId: newParticipant.tradingAccountId,
      txType: 'initial_grant',
    },
  });
  ok(
    grants.length === 1 && grants[0].amount.equals('10000000'),
    'exactly one 10,000,000 KRW initial grant',
  );
  ok(
    (await db.cashWallet.count({
      where: { tradingAccountId: newParticipant.tradingAccountId },
    })) === 4,
    'four fresh wallets; nothing is carried over',
  );
  ok(
    (await db.walletTransaction.count({
      where: { tradingAccountId: newParticipant.tradingAccountId },
    })) === 1,
    'no transfer of earlier funds into the new account',
  );
  ok(
    (await db.seasonParticipant.count({ where: { seasonId: winnerId } })) ===
      2 &&
      (await db.seasonParticipant.count({ where: { userId: carol.id } })) === 0,
    'creating a season grants nobody: only the two joins exist',
  );
  const owned = (
    await accounts.listTradingAccounts(alice.id)
  ).data.accounts.filter((a) => a.mode === 'season');
  const ownedPrev = owned.find((a) => a.season?.seasonId === previousId);
  const ownedNext = owned.find((a) => a.season?.seasonId === winnerId);
  ok(
    owned.length === 2 &&
      ownedPrev?.season?.seasonName === 'season0' &&
      ownedNext?.season?.seasonName === 'season0' &&
      ownedPrev.id !== ownedNext.id &&
      ownedPrev.season.seasonStatus === 'settled' &&
      ownedPrev.season.finalResultViewedAt === null &&
      ownedNext.season.seasonStatus === 'active' &&
      ownedNext.season.startAt === scheduled.startAt.toISOString() &&
      ownedNext.season.endAt === scheduled.endAt.toISOString() &&
      !('displayBadge' in ownedNext.season),
    'two season0 accounts, told apart by season ID, each with its own dates',
  );

  // --- The earlier result stays readable and recordable --------------------
  const prevResult = await finalResults.getMyFinalResult(alice.id, previousId);
  ok(
    prevResult.data.season.id === previousId &&
      prevResult.data.result.state === 'not_qualified' &&
      prevResult.data.viewedAt === null,
    'the earlier season0 result is still unseen and shown (not qualified)',
  );
  ok(
    (await finalResults.getMyFinalResult(alice.id, winnerId)).data.result
      .state === 'pending',
    'the running season has no final result',
  );
  const qualification = await ranking.getFinalQualification(alice.id, {
    seasonId: winnerId,
  });
  ok(
    qualification.data.state === 'available' &&
      qualification.data.basis === 'provisional' &&
      qualification.data.criteria?.minTradedInstrumentCount === 5 &&
      qualification.data.criteria?.minRecognizedTurnoverKrw ===
        '30000000.00000000' &&
      qualification.data.qualified === false &&
      qualification.data.remainingTradedInstrumentCount === 5,
    'the new season reports its own provisional criteria',
  );
  ok(
    (await ranking.getFinalQualification(alice.id, { seasonId: previousId }))
      .data.basis === 'final',
    'the earlier season keeps its final verdict',
  );
  const viewed = await finalResults.markMyFinalResultViewed(
    alice.id,
    previousId,
  );
  ok(
    viewed.data.seasonId === previousId,
    'the earlier result view is recorded for that season',
  );
  ok(
    (
      await db.seasonParticipant.findUniqueOrThrow({
        where: { id: newParticipant.id },
      })
    ).finalResultViewedAt === null,
    'the new season participation is not marked by the old result',
  );
  const history = await records.getMySeasonRecords(alice.id);
  ok(
    history.data.seasons.filter((s) => s.seasonName === 'season0').length ===
      2 &&
      new Set(history.data.seasons.map((s) => s.seasonId)).size ===
        history.data.seasons.length,
    'records list both season0 participations by ID',
  );

  // --- The new season ends and settles independently -----------------------
  // Fixture-only shortcut: bring the boundary forward (16 days cannot pass in a
  // test). Production never edits endAt.
  const shortEnd = new Date((await dbNow()).getTime() + 2000);
  await db.season.update({
    where: { id: winnerId },
    data: { endAt: shortEnd },
  });
  await untilDb(shortEnd);
  ok(
    ['SEASON_ENDED', 'SEASON_NOT_ACTIVE'].includes(
      await errorCode(seasons.joinSeason(winnerId, carol.id)),
    ),
    'no join at or after the exclusive end',
  );
  await tick('next-end');
  ok(
    (await db.season.findUniqueOrThrow({ where: { id: winnerId } })).status ===
      'ended',
    'ended at endAt',
  );
  await settle(winnerId, shortEnd, 'next');
  ok(
    (await db.season.findUniqueOrThrow({ where: { id: winnerId } })).status ===
      'settled',
    'the new season settles',
  );
  const nextResult = await finalResults.getMyFinalResult(alice.id, winnerId);
  ok(
    nextResult.data.season.id === winnerId &&
      nextResult.data.result.state === 'not_qualified' &&
      nextResult.data.viewedAt === null,
    'its own final result is available and unseen',
  );
  ok(
    (await accounts.listTradingAccounts(alice.id)).data.accounts.find(
      (a) => a.season?.seasonId === winnerId,
    )?.season?.finalResultViewedAt === null,
    'the account list says the new result is unseen (explicit null)',
  );

  // --- Earlier seasons are untouched ----------------------------------------
  type Participant = {
    userId: string;
    finalResultViewedAt: string | null;
    updatedAt: string;
  };
  const previousAfter = JSON.parse(await seasonFingerprint(previousId)) as {
    participants: Participant[];
  };
  const previousBefore = JSON.parse(previousRows) as typeof previousAfter;
  // The one change made on purpose above: alice's recorded first view.
  for (const p of previousAfter.participants)
    if (p.userId === alice.id) {
      const before = previousBefore.participants.find(
        (q) => q.userId === alice.id,
      )!;
      ok(p.finalResultViewedAt !== null, 'the recorded view is stored');
      p.finalResultViewedAt = before.finalResultViewedAt;
      p.updatedAt = before.updatedAt;
    }
  ok(
    JSON.stringify(previousAfter) === JSON.stringify(previousBefore),
    'the earlier season0 rows are unchanged',
  );
  ok(
    (await seasonFingerprint(releaseId)) === releaseRows,
    'the settled release season0 is unchanged',
  );
  ok(
    (await seasonFingerprint(DEVELOPMENT_SEASON_ID)) === developmentRows,
    'the development season is unchanged',
  );
  console.log(`season-schedule integration: ${assertions} assertions passed`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
