import { spawnSync } from 'node:child_process';

/**
 * Opt-in PostgreSQL integration tests for 작업 8 (SeasonRanking account scope,
 * season write locks, and settlement account closure).
 *
 * None of what is checked here can be established with mocks: the additive
 * migration's backfill against real rows, the new account-scoped UNIQUE, a real
 * `SELECT ... FOR UPDATE` on the season row serialising two writers, the
 * all-or-nothing settlement transaction (final rankings + participant results +
 * account closure + season status), and the repair script's dry-run/apply
 * behaviour against real data.
 *
 * Runs only with TRADING_ACCOUNT_DB_INTEGRATION=1 against the migrated dev DB
 * (prepare = `prisma migrate deploy` only; never reset/drop/seed).
 */
const RUN_DB_INTEGRATION = process.env.TRADING_ACCOUNT_DB_INTEGRATION === '1';
const itDbIntegration = RUN_DB_INTEGRATION ? it : it.skip;

describe('SeasonRanking trading-account scope DB integration', () => {
  itDbIntegration(
    'verifies migration backfill, dual-write, source scope, season locks, settlement closure, and the repair script against PostgreSQL',
    () => {
      runDbIntegrationPrepare();

      const result = spawnSync(getPnpmCommand(), ['tsx', '-e', RUNNER], {
        cwd: process.cwd(),
        env: process.env,
        encoding: 'utf8',
        timeout: 300_000,
      });

      if (result.status !== 0) {
        throw new Error(
          [
            'Season ranking scope DB integration runner failed.',
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
          ].join('\n'),
        );
      }

      expect(result.stdout).toContain('season ranking scope ok');
    },
    320_000,
  );
});

function getPnpmCommand() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function runDbIntegrationPrepare() {
  const result = spawnSync(
    getPnpmCommand(),
    ['run', '--silent', 'test:db:prepare'],
    {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
      timeout: 60_000,
    },
  );

  if (result.status !== 0) {
    throw new Error(
      [
        'Season ranking scope DB integration prepare failed.',
        'The opt-in test applies existing Prisma migrations with `prisma migrate deploy` only; it does not reset, drop, or seed the database.',
        'stdout:',
        result.stdout,
        'stderr:',
        result.stderr,
      ].join('\n'),
    );
  }
}

const RUNNER = `
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { PrismaService } from './src/prisma/prisma.service';
import { PortfolioValuationService } from './src/portfolio/portfolio-valuation.service';
import { RankingRefreshService } from './src/ranking/ranking-refresh.service';
import { BatchService } from './src/batch/batch.service';
import { SeasonRankingJobService } from './src/batch/season-ranking-job.service';
import { SeasonSettlementJobService } from './src/batch/season-settlement-job.service';
import { FinalTierAssignmentJobService } from './src/batch/final-tier-assignment-job.service';
import { writeSeasonRankings } from './src/portfolio/season-ranking-generation';
import {
  repairRankingScope,
  resolveRankingScopeExitCode,
  auditRankingAndSettlement,
} from './scripts/lib/repair-ranking-scope';

const prisma = new PrismaService();
const valuation = new PortfolioValuationService(prisma);
const refresh = new RankingRefreshService(prisma, valuation);
const batch = new BatchService(prisma);
const rankingJob = new SeasonRankingJobService(batch, prisma);
const settlementJob = new SeasonSettlementJobService(batch, prisma);
const finalTierJob = new FinalTierAssignmentJobService(batch, prisma);

const createdUserIds = [];
const createdSeasonIds = [];
const createdJobKeys = [];
const createdFxSnapshotIds = [];

/**
 * Live valuation converts the USD wallet, so a fresh USD/KRW rate has to
 * exist. It is created once per run and removed in cleanup.
 */
async function ensureFxRate() {
  const now = new Date();
  const snapshot = await prisma.fxRateSnapshot.create({
    data: {
      baseCurrency: 'USD',
      quoteCurrency: 'KRW',
      rate: '1350.00000000',
      sourceType: 'admin_manual',
      sourceName: 'ranking-scope-integration',
      effectiveAt: now,
      capturedAt: now,
    },
    select: { id: true },
  });
  createdFxSnapshotIds.push(snapshot.id);
}

function errorCode(error) {
  assert.ok(
    error instanceof HttpException,
    'expected HttpException, got ' + String(error),
  );
  return error.getResponse().error.code;
}

async function expectCode(promise, code) {
  try {
    await promise;
  } catch (error) {
    assert.equal(errorCode(error), code, 'wrong error code');
    return error;
  }
  throw new Error('expected rejection with ' + code);
}

async function createUser(tag) {
  const id = randomUUID();
  await prisma.user.create({
    data: {
      id,
      email: 'ranking-scope-' + tag + '-' + id + '@example.com',
      passwordHash: 'x',
      nickname: 'ranking-scope-' + id.slice(0, 8),
    },
  });
  createdUserIds.push(id);
  return id;
}

/** A season with N participants, each with its own season TradingAccount. */
async function createSeasonWithParticipants(options) {
  const { participantCount, status, startAt, endAt } = options;
  const season = await prisma.season.create({
    data: {
      name: 'ranking-scope-' + randomUUID().slice(0, 8),
      status,
      startAt,
      endAt,
      initialCapitalKrw: '10000000',
      tradeFeeRate: '0.0001',
      fxFeeRate: '0.001',
    },
    select: { id: true },
  });
  createdSeasonIds.push(season.id);

  const participants = [];
  for (let index = 0; index < participantCount; index += 1) {
    const userId = await createUser('p' + index);
    const account = await prisma.tradingAccount.create({
      data: {
        userId,
        mode: 'season',
        status: 'active',
        initialCapitalKrw: '10000000',
        openedAt: startAt,
      },
      select: { id: true },
    });
    const participant = await prisma.seasonParticipant.create({
      data: {
        seasonId: season.id,
        userId,
        joinedAt: startAt,
        participantStatus: 'active',
        initialCapitalKrw: '10000000',
        totalAssetKrw: '10000000',
        totalReturnRate: '0',
        maxDrawdown: '0',
        totalFillCount: 0,
        tradingAccountId: account.id,
      },
      select: { id: true, userId: true },
    });
    // Valuation requires BOTH currency wallets, so both exist here even
    // though the USD side stays at zero.
    for (const currencyCode of ['KRW', 'USD']) {
      await prisma.cashWallet.create({
        data: {
          seasonParticipantId: participant.id,
          tradingAccountId: account.id,
          currencyCode,
          balanceAmount: currencyCode === 'KRW' ? '10000000' : '0',
          reservedAmount: '0',
        },
      });
    }
    participants.push({
      id: participant.id,
      userId: participant.userId,
      accountId: account.id,
    });
  }

  return { seasonId: season.id, participants, startAt, endAt };
}

async function createDailySnapshot(participant, snapshotDate, totalAssetKrw, returnRate) {
  return prisma.dailyPortfolioSnapshot.create({
    data: {
      seasonParticipantId: participant.id,
      tradingAccountId: participant.accountId,
      snapshotDate,
      totalAssetKrw,
      returnRate,
      krwCash: totalAssetKrw,
      usdCashKrw: '0',
      assetValueKrw: '0',
      realizedPnlKrw: '0',
      unrealizedPnlKrw: '0',
      capturedAt: new Date(snapshotDate.getTime() + 10_000),
    },
    select: { id: true },
  });
}

function dateOnly(text) {
  return new Date(text + 'T00:00:00.000Z');
}

async function runJob(job, input) {
  const key = input.idempotencyKey ?? randomUUID();
  createdJobKeys.push(key);
  return job.run({ ...input, idempotencyKey: key });
}

// ===========================================================================
// 1) Migration backfill + fingerprint + the new account-scoped UNIQUE.
// ===========================================================================
async function testMigrationBackfillAndUnique() {
  const fixture = await createSeasonWithParticipants({
    participantCount: 2,
    status: 'active',
    startAt: new Date(Date.now() - 86_400_000),
    endAt: new Date(Date.now() + 86_400_000),
  });
  const rankingDate = dateOnly('2026-08-01');

  // A row written the OLD way: participant only, no account scope. Raw SQL,
  // because the Prisma writers can no longer produce one.
  const legacyId = randomUUID();
  await prisma.$executeRaw\`
    INSERT INTO "season_rankings"
      ("id", "season_id", "season_participant_id", "rank_type", "rank",
       "total_asset_krw", "return_rate", "max_drawdown", "total_fill_count",
       "ranking_date", "captured_at")
    VALUES (\${legacyId}, \${fixture.seasonId}, \${fixture.participants[0].id},
            'daily'::"SeasonRankingType", 1, 12345.5, 1.25, 0.5, 3,
            \${rankingDate}::date, now())
  \`;

  const beforeRow = await prisma.seasonRanking.findUniqueOrThrow({
    where: { id: legacyId },
  });
  assert.equal(beforeRow.tradingAccountId, null, 'legacy row must start unscoped');

  // The migration's backfill statement, replayed exactly.
  await prisma.$executeRaw\`
    UPDATE "season_rankings" sr
    SET "trading_account_id" = sp."trading_account_id"
    FROM "season_participants" sp
    WHERE sr."season_participant_id" = sp."id"
      AND sr."trading_account_id" IS NULL
      AND sp."trading_account_id" IS NOT NULL
  \`;

  const afterRow = await prisma.seasonRanking.findUniqueOrThrow({
    where: { id: legacyId },
  });
  assert.equal(
    afterRow.tradingAccountId,
    fixture.participants[0].accountId,
    'backfill must copy the participant account link',
  );

  // FINGERPRINT: everything except trading_account_id is byte-identical.
  for (const field of [
    'rank',
    'totalFillCount',
    'seasonId',
    'seasonParticipantId',
    'rankType',
  ]) {
    assert.equal(
      String(afterRow[field]),
      String(beforeRow[field]),
      field + ' must be unchanged by the backfill',
    );
  }
  for (const field of ['totalAssetKrw', 'returnRate', 'maxDrawdown']) {
    assert.ok(
      afterRow[field].equals(beforeRow[field]),
      field + ' must be unchanged by the backfill',
    );
  }
  for (const field of ['rankingDate', 'capturedAt', 'createdAt']) {
    assert.equal(
      afterRow[field].getTime(),
      beforeRow[field].getTime(),
      field + ' must be unchanged by the backfill',
    );
  }
  assert.equal(afterRow.reachedReturnAt, beforeRow.reachedReturnAt);

  // A participant with NO account link stays NULL — never guessed.
  const orphanUserId = await createUser('orphan');
  const orphan = await prisma.seasonParticipant.create({
    data: {
      seasonId: fixture.seasonId,
      userId: orphanUserId,
      joinedAt: fixture.startAt,
      participantStatus: 'active',
      initialCapitalKrw: '10000000',
      totalAssetKrw: '10000000',
      totalReturnRate: '0',
      maxDrawdown: '0',
      tradingAccountId: null,
    },
    select: { id: true },
  });
  const orphanRankingId = randomUUID();
  await prisma.$executeRaw\`
    INSERT INTO "season_rankings"
      ("id", "season_id", "season_participant_id", "rank_type", "rank",
       "total_asset_krw", "return_rate", "max_drawdown", "total_fill_count",
       "ranking_date", "captured_at")
    VALUES (\${orphanRankingId}, \${fixture.seasonId}, \${orphan.id},
            'daily'::"SeasonRankingType", 2, 1, 0, 0, 0, \${rankingDate}::date, now())
  \`;
  await prisma.$executeRaw\`
    UPDATE "season_rankings" sr
    SET "trading_account_id" = sp."trading_account_id"
    FROM "season_participants" sp
    WHERE sr."season_participant_id" = sp."id"
      AND sr."trading_account_id" IS NULL
      AND sp."trading_account_id" IS NOT NULL
  \`;
  const orphanRow = await prisma.seasonRanking.findUniqueOrThrow({
    where: { id: orphanRankingId },
  });
  assert.equal(
    orphanRow.tradingAccountId,
    null,
    'a participant with no link must leave the ranking unscoped',
  );

  // The new account-scoped UNIQUE is real.
  let uniqueViolated = false;
  try {
    await prisma.$executeRaw\`
      INSERT INTO "season_rankings"
        ("id", "season_id", "season_participant_id", "trading_account_id",
         "rank_type", "rank", "total_asset_krw", "return_rate", "max_drawdown",
         "total_fill_count", "ranking_date", "captured_at")
      VALUES (\${randomUUID()}, \${fixture.seasonId}, \${fixture.participants[1].id},
              \${fixture.participants[0].accountId}, 'daily'::"SeasonRankingType",
              99, 1, 0, 0, 0, \${rankingDate}::date, now())
    \`;
  } catch (error) {
    uniqueViolated = true;
  }
  assert.ok(
    uniqueViolated,
    'one account must not hold two rows in the same ranking set',
  );

  // The orphan pair has served its purpose. Removing it here keeps the shared
  // DB free of a permanently unrepairable row, which the repair-script test
  // later asserts a CLEAN converged state against.
  await prisma.$executeRaw\`DELETE FROM "season_rankings" WHERE "id" = \${orphanRankingId}\`;
  await prisma.seasonParticipant.delete({ where: { id: orphan.id } });

  console.log('  [1] migration backfill + fingerprint + account unique ok');
  return fixture;
}

// ===========================================================================
// 2) Every writer dual-writes; a broken participant link blocks the write.
// ===========================================================================
async function testWritersDualWrite() {
  const now = new Date();
  const fixture = await createSeasonWithParticipants({
    participantCount: 2,
    status: 'active',
    startAt: new Date(now.getTime() - 3_600_000),
    endAt: new Date(now.getTime() + 3_600_000),
  });

  // ---- RankingRefreshService (live current ranking) ----
  const refreshResult = await refresh.refreshCurrentRankingForSeason(
    fixture.seasonId,
    { capturedAt: now, createEquitySnapshots: false },
  );
  assert.equal(refreshResult.skipped, false, 'refresh should not be skipped');

  const refreshRows = await prisma.seasonRanking.findMany({
    where: { seasonId: fixture.seasonId, rankType: 'daily' },
    select: { seasonParticipantId: true, tradingAccountId: true },
  });
  assert.equal(refreshRows.length, 2);
  for (const row of refreshRows) {
    const participant = fixture.participants.find(
      (candidate) => candidate.id === row.seasonParticipantId,
    );
    assert.equal(
      row.tradingAccountId,
      participant.accountId,
      'refresh writer must dual-write the account scope',
    );
  }

  // ---- writeSeasonRankings (admin script path) ----
  const scriptDate = dateOnly('2026-08-02');
  const written = await writeSeasonRankings(prisma, {
    seasonId: fixture.seasonId,
    rankType: 'final',
    rankingDate: scriptDate,
    capturedAt: now,
    dryRun: false,
    rows: fixture.participants.map((participant, index) => ({
      seasonParticipantId: participant.id,
      userId: participant.userId,
      rank: index + 1,
      totalAssetKrw: '10000000.00000000',
      returnRate: '0.00000000',
      maxDrawdown: '0.00000000',
      totalFillCount: 0,
      reachedReturnAt: now,
    })),
  });
  assert.equal(written.length, 2);
  const scriptRows = await prisma.seasonRanking.findMany({
    where: { seasonId: fixture.seasonId, rankType: 'final', rankingDate: scriptDate },
    select: { seasonParticipantId: true, tradingAccountId: true },
  });
  for (const row of scriptRows) {
    const participant = fixture.participants.find(
      (candidate) => candidate.id === row.seasonParticipantId,
    );
    assert.equal(
      row.tradingAccountId,
      participant.accountId,
      'writeSeasonRankings must dual-write the account scope',
    );
  }

  // ---- a participant whose link is broken blocks the ENTIRE write ----
  const brokenFixture = await createSeasonWithParticipants({
    participantCount: 2,
    status: 'active',
    startAt: new Date(now.getTime() - 3_600_000),
    endAt: new Date(now.getTime() + 3_600_000),
  });
  await prisma.seasonParticipant.update({
    where: { id: brokenFixture.participants[1].id },
    data: { tradingAccountId: null },
  });

  // The refresh resolves participant scopes BEFORE it opens its write
  // transaction, so a broken link is caught by the source-scope guard first.
  await expectCode(
    refresh.refreshCurrentRankingForSeason(brokenFixture.seasonId, {
      capturedAt: now,
      createEquitySnapshots: false,
    }),
    'SEASON_RANKING_SOURCE_SCOPE_REPAIR_REQUIRED',
  );

  // The admin/script writer has no participant pre-pass, so it is the path
  // that surfaces the ranking-scope link error directly.
  await expectCode(
    writeSeasonRankings(prisma, {
      seasonId: brokenFixture.seasonId,
      rankType: 'final',
      rankingDate: dateOnly('2026-08-09'),
      capturedAt: now,
      dryRun: false,
      rows: brokenFixture.participants.map((participant, index) => ({
        seasonParticipantId: participant.id,
        userId: participant.userId,
        rank: index + 1,
        totalAssetKrw: '10000000.00000000',
        returnRate: '0.00000000',
        maxDrawdown: '0.00000000',
        totalFillCount: 0,
        reachedReturnAt: now,
      })),
    }),
    'TRADING_ACCOUNT_LINK_INTEGRITY',
  );
  assert.equal(
    await prisma.seasonRanking.count({
      where: { seasonId: brokenFixture.seasonId, rankType: 'final' },
    }),
    0,
    'writeSeasonRankings must write nothing when one link is broken',
  );
  const brokenRows = await prisma.seasonRanking.count({
    where: { seasonId: brokenFixture.seasonId },
  });
  assert.equal(
    brokenRows,
    0,
    'a broken link must roll the WHOLE ranking set back, not write a partial one',
  );

  // ---- a general-mode account can never be scoped into a ranking ----
  const generalUserId = await createUser('general');
  const generalAccount = await prisma.tradingAccount.create({
    data: {
      userId: generalUserId,
      mode: 'general',
      status: 'active',
      initialCapitalKrw: '10000000',
      openedAt: now,
    },
    select: { id: true },
  });
  await prisma.seasonParticipant.update({
    where: { id: brokenFixture.participants[1].id },
    data: { tradingAccountId: generalAccount.id },
  });
  await expectCode(
    refresh.refreshCurrentRankingForSeason(brokenFixture.seasonId, {
      capturedAt: now,
      createEquitySnapshots: false,
    }),
    'SEASON_RANKING_SOURCE_SCOPE_MISMATCH',
  );
  await expectCode(
    writeSeasonRankings(prisma, {
      seasonId: brokenFixture.seasonId,
      rankType: 'final',
      rankingDate: dateOnly('2026-08-09'),
      capturedAt: now,
      dryRun: false,
      rows: brokenFixture.participants.map((participant, index) => ({
        seasonParticipantId: participant.id,
        userId: participant.userId,
        rank: index + 1,
        totalAssetKrw: '10000000.00000000',
        returnRate: '0.00000000',
        maxDrawdown: '0.00000000',
        totalFillCount: 0,
        reachedReturnAt: now,
      })),
    }),
    'SEASON_RANKING_SCOPE_MISMATCH',
  );
  // Put it back so cleanup can delete the general account.
  await prisma.seasonParticipant.update({
    where: { id: brokenFixture.participants[1].id },
    data: { tradingAccountId: brokenFixture.participants[1].accountId },
  });

  console.log('  [2] writer dual-write + fail-closed link/mode checks ok');
  return fixture;
}

// ===========================================================================
// 3) Ranking INPUT scope: a damaged source row fails the job, never silently
//    drops out of the calculation.
// ===========================================================================
async function testRankingInputScope() {
  const now = new Date();
  const fixture = await createSeasonWithParticipants({
    participantCount: 2,
    status: 'active',
    startAt: new Date(now.getTime() - 86_400_000),
    endAt: new Date(now.getTime() + 86_400_000),
  });
  const snapshotDate = dateOnly('2026-08-03');

  await createDailySnapshot(fixture.participants[0], snapshotDate, '11000000', '10');
  const second = await createDailySnapshot(
    fixture.participants[1],
    snapshotDate,
    '10500000',
    '5',
  );

  // Healthy first: the job produces a scoped ranking.
  const okResult = await runJob(rankingJob, {
    seasonId: fixture.seasonId,
    snapshotDate: '2026-08-03',
  });
  assert.equal(okResult.data.run.status, 'succeeded');
  const created = await prisma.seasonRanking.findMany({
    where: { seasonId: fixture.seasonId, rankingDate: snapshotDate, rankType: 'daily' },
    select: { rank: true, tradingAccountId: true },
    orderBy: { rank: 'asc' },
  });
  assert.equal(created.length, 2);
  assert.ok(created.every((row) => row.tradingAccountId !== null));

  // Now damage a source snapshot and confirm the job REFUSES rather than
  // ranking one participant fewer.
  const damagedFixture = await createSeasonWithParticipants({
    participantCount: 2,
    status: 'active',
    startAt: new Date(now.getTime() - 86_400_000),
    endAt: new Date(now.getTime() + 86_400_000),
  });
  const damagedDate = dateOnly('2026-08-04');
  await createDailySnapshot(damagedFixture.participants[0], damagedDate, '11000000', '10');
  const damaged = await createDailySnapshot(
    damagedFixture.participants[1],
    damagedDate,
    '10500000',
    '5',
  );
  await prisma.$executeRaw\`
    UPDATE "daily_portfolio_snapshots" SET "trading_account_id" = NULL WHERE "id" = \${damaged.id}
  \`;

  let sourceFailureCode = null;
  try {
    await runJob(rankingJob, {
      seasonId: damagedFixture.seasonId,
      snapshotDate: '2026-08-04',
    });
  } catch (error) {
    sourceFailureCode = errorCode(error);
  }
  assert.equal(
    sourceFailureCode,
    'SEASON_RANKING_SOURCE_SCOPE_REPAIR_REQUIRED',
    'a null-scoped source snapshot must fail the job',
  );
  assert.equal(
    await prisma.seasonRanking.count({
      where: { seasonId: damagedFixture.seasonId, rankingDate: damagedDate },
    }),
    0,
    'no partial ranking may be written when a source row is damaged',
  );

  // A season snapshot carrying GENERAL performance columns is also refused:
  // its returnRate would be a TWR percent, not the season return.
  await prisma.$executeRaw\`
    UPDATE "daily_portfolio_snapshots"
    SET "trading_account_id" = \${damagedFixture.participants[1].accountId},
        "cumulative_external_funding_krw" = 1,
        "investment_pnl_krw" = 0,
        "time_weighted_return_factor" = 1
    WHERE "id" = \${damaged.id}
  \`;
  let generalColumnCode = null;
  try {
    await runJob(rankingJob, {
      seasonId: damagedFixture.seasonId,
      snapshotDate: '2026-08-04',
    });
  } catch (error) {
    generalColumnCode = errorCode(error);
  }
  assert.equal(generalColumnCode, 'SEASON_RANKING_SOURCE_SCOPE_MISMATCH');

  void second;
  console.log('  [3] ranking input scope fail-closed ok');
}

// ===========================================================================
// 4) Settlement: atomic final ranking + participant results + ACCOUNT CLOSURE.
// ===========================================================================
async function testSettlementClosesAccounts() {
  const endAt = new Date(Date.now() - 3_600_000);
  const fixture = await createSeasonWithParticipants({
    participantCount: 3,
    status: 'ended',
    startAt: new Date(endAt.getTime() - 86_400_000),
    endAt,
  });

  // One EXCLUDED participant: out of the final ranking, but its account is
  // still closed when the season settles (작업 8 §14.2).
  await prisma.seasonParticipant.update({
    where: { id: fixture.participants[2].id },
    data: { participantStatus: 'excluded', excludedAt: new Date() },
  });

  // A GENERAL account that must be completely untouched by settlement.
  const bystanderUserId = await createUser('bystander');
  const bystanderAccount = await prisma.tradingAccount.create({
    data: {
      userId: bystanderUserId,
      mode: 'general',
      status: 'active',
      initialCapitalKrw: '10000000',
      openedAt: new Date(),
    },
    select: { id: true, status: true, closedAt: true },
  });

  const settlementDate = dateOnly('2026-08-05');
  await createDailySnapshot(fixture.participants[0], settlementDate, '12000000', '20');
  await createDailySnapshot(fixture.participants[1], settlementDate, '11000000', '10');

  const result = await runJob(settlementJob, {
    seasonId: fixture.seasonId,
    settlementDate: '2026-08-05',
  });
  assert.equal(result.data.run.status, 'succeeded');

  const season = await prisma.season.findUniqueOrThrow({
    where: { id: fixture.seasonId },
    select: { status: true },
  });
  assert.equal(season.status, 'settled', 'season must end up settled');

  // Final rankings: eligible only, and account dual-written.
  const finalRows = await prisma.seasonRanking.findMany({
    where: { seasonId: fixture.seasonId, rankType: 'final' },
    select: { seasonParticipantId: true, tradingAccountId: true, rank: true },
    orderBy: { rank: 'asc' },
  });
  assert.equal(finalRows.length, 2, 'excluded participant gets no final ranking');
  assert.deepEqual(
    finalRows.map((row) => row.rank),
    [1, 2],
    'final ranks must be a gapless 1..N sequence',
  );
  for (const row of finalRows) {
    const participant = fixture.participants.find(
      (candidate) => candidate.id === row.seasonParticipantId,
    );
    assert.equal(row.tradingAccountId, participant.accountId);
  }

  // Participant results agree with the final ranking.
  for (const row of finalRows) {
    const participant = await prisma.seasonParticipant.findUniqueOrThrow({
      where: { id: row.seasonParticipantId },
      select: {
        participantStatus: true,
        finalRank: true,
        finalTier: true,
        currentRank: true,
      },
    });
    assert.equal(participant.finalRank, row.rank);
    assert.equal(participant.currentRank, row.rank);
    assert.ok(participant.finalTier, 'finalTier must be assigned');
    assert.equal(
      participant.participantStatus,
      'finished',
      'active participants become finished at settlement',
    );
  }

  // The excluded participant keeps its status and gets NO final result.
  const excluded = await prisma.seasonParticipant.findUniqueOrThrow({
    where: { id: fixture.participants[2].id },
    select: { participantStatus: true, finalRank: true, finalTier: true },
  });
  assert.equal(excluded.participantStatus, 'excluded');
  assert.equal(excluded.finalRank, null);
  assert.equal(excluded.finalTier, null);

  // EVERY linked season account is closed, including the excluded one, and
  // closedAt is the season's endAt rather than "whenever the job happened to run".
  for (const participant of fixture.participants) {
    const account = await prisma.tradingAccount.findUniqueOrThrow({
      where: { id: participant.accountId },
      select: { status: true, closedAt: true },
    });
    assert.equal(account.status, 'closed', 'every season account must be closed');
    assert.ok(account.closedAt, 'closedAt must be set');
    assert.equal(
      account.closedAt.getTime(),
      endAt.getTime(),
      'closedAt must be the season endAt, not the settlement run time',
    );
  }

  const liveAccounts = await prisma.tradingAccount.count({
    where: {
      seasonParticipant: { seasonId: fixture.seasonId },
      OR: [{ status: { not: 'closed' } }, { closedAt: null }],
    },
  });
  assert.equal(liveAccounts, 0, 'a settled season may hold no live account');

  // The general account is exactly as it was.
  const bystanderAfter = await prisma.tradingAccount.findUniqueOrThrow({
    where: { id: bystanderAccount.id },
    select: { status: true, closedAt: true },
  });
  assert.equal(bystanderAfter.status, 'active');
  assert.equal(bystanderAfter.closedAt, null);

  // Final tier job accepts the settled state as consistent + idempotent.
  const tierResult = await runJob(finalTierJob, {
    seasonId: fixture.seasonId,
    rankingDate: '2026-08-05',
    dryRun: true,
  });
  assert.equal(tierResult.data.run.status, 'succeeded');

  console.log('  [4] settlement account closure + final results ok');
  return fixture;
}

// ===========================================================================
// 5) Settlement rolls back ENTIRELY when one participant's link is broken.
// ===========================================================================
async function testSettlementRollback() {
  const endAt = new Date(Date.now() - 3_600_000);
  const fixture = await createSeasonWithParticipants({
    participantCount: 2,
    status: 'ended',
    startAt: new Date(endAt.getTime() - 86_400_000),
    endAt,
  });
  const settlementDate = dateOnly('2026-08-06');
  await createDailySnapshot(fixture.participants[0], settlementDate, '12000000', '20');
  await createDailySnapshot(fixture.participants[1], settlementDate, '11000000', '10');

  // Break the link of an EXCLUDED participant, AFTER the snapshots exist.
  //
  // Excluded participants are not settlement-ELIGIBLE, so 작업 8 보완 §A-1's
  // pre-transaction participant scope map never sees this one — the failure
  // therefore happens where it is meant to, inside the settlement transaction,
  // at the season-wide account link check that runs before any write.
  await prisma.seasonParticipant.update({
    where: { id: fixture.participants[1].id },
    data: {
      participantStatus: 'excluded',
      excludedAt: new Date(),
      tradingAccountId: null,
    },
  });

  let rollbackCode = null;
  try {
    await runJob(settlementJob, {
      seasonId: fixture.seasonId,
      settlementDate: '2026-08-06',
    });
  } catch (error) {
    rollbackCode = errorCode(error);
  }
  assert.equal(rollbackCode, 'SETTLEMENT_ACCOUNT_LINK_INTEGRITY');

  // NOTHING survived: no final ranking, no result, no closure, no settled flag.
  assert.equal(
    await prisma.seasonRanking.count({
      where: { seasonId: fixture.seasonId, rankType: 'final' },
    }),
    0,
    'final rankings must roll back with the rest of settlement',
  );
  const season = await prisma.season.findUniqueOrThrow({
    where: { id: fixture.seasonId },
    select: { status: true },
  });
  assert.equal(season.status, 'ended', 'season must NOT be settled');
  const account = await prisma.tradingAccount.findUniqueOrThrow({
    where: { id: fixture.participants[0].accountId },
    select: { status: true, closedAt: true },
  });
  assert.equal(
    account.status,
    'active',
    'no account may be closed by a rolled-back settlement',
  );
  assert.equal(account.closedAt, null);
  const participant = await prisma.seasonParticipant.findUniqueOrThrow({
    where: { id: fixture.participants[0].id },
    select: { finalRank: true, participantStatus: true },
  });
  assert.equal(participant.finalRank, null);
  assert.equal(participant.participantStatus, 'active');

  // Restore the link so cleanup can proceed.
  await prisma.seasonParticipant.update({
    where: { id: fixture.participants[1].id },
    data: {
      participantStatus: 'active',
      excludedAt: null,
      tradingAccountId: fixture.participants[1].accountId,
    },
  });

  console.log('  [5] settlement all-or-nothing rollback ok');
}

// ===========================================================================
// 6) Season row lock: a refresh cannot write into a season settlement closed.
// ===========================================================================
async function testRefreshVsSettlement() {
  const now = new Date();
  const fixture = await createSeasonWithParticipants({
    participantCount: 1,
    status: 'active',
    startAt: new Date(now.getTime() - 3_600_000),
    endAt: new Date(now.getTime() + 3_600_000),
  });

  // Baseline: an active season DOES get its ranking refreshed.
  const active = await refresh.refreshCurrentRankingForSeason(fixture.seasonId, {
    capturedAt: now,
    createEquitySnapshots: false,
  });
  assert.equal(active.skipped, false);
  const rowsWhileActive = await prisma.seasonRanking.count({
    where: { seasonId: fixture.seasonId },
  });
  assert.equal(rowsWhileActive, 1);

  // Settlement has since closed the season out. A refresh that started before
  // that would now find the season settled UNDER ITS OWN LOCK and must not
  // delete-and-rewrite the closed leaderboard.
  await prisma.season.update({
    where: { id: fixture.seasonId },
    data: { status: 'settled' },
  });

  const afterSettle = await refresh.refreshCurrentRankingForSeason(
    fixture.seasonId,
    { capturedAt: now, createEquitySnapshots: false },
  );
  assert.equal(afterSettle.skipped, true, 'refresh must skip a settled season');
  assert.equal(
    await prisma.seasonRanking.count({ where: { seasonId: fixture.seasonId } }),
    1,
    'a settled season keeps its ranking rows; refresh must not delete them',
  );

  // The snapshot-based daily job refuses a settled season too.
  const settledDate = dateOnly('2026-08-07');
  await createDailySnapshot(fixture.participants[0], settledDate, '11000000', '10');
  let settledJobCode = null;
  try {
    await runJob(rankingJob, {
      seasonId: fixture.seasonId,
      snapshotDate: '2026-08-07',
    });
  } catch (error) {
    settledJobCode = errorCode(error);
  }
  assert.ok(
    settledJobCode === 'SEASON_STATUS_NOT_ALLOWED' ||
      settledJobCode === 'SEASON_ALREADY_SETTLED',
    'the daily ranking job must refuse a settled season, got ' + settledJobCode,
  );

  console.log('  [6] season write lock vs settlement ok');
}

// ===========================================================================
// 7) repair-ranking-scope: dry-run is read-only, apply is idempotent, and
//    mismatches are never overwritten.
// ===========================================================================
async function testRepairScript() {
  const now = new Date();
  const fixture = await createSeasonWithParticipants({
    participantCount: 2,
    status: 'active',
    startAt: new Date(now.getTime() - 3_600_000),
    endAt: new Date(now.getTime() + 3_600_000),
  });
  const rankingDate = dateOnly('2026-08-08');

  const nullScopedId = randomUUID();
  await prisma.$executeRaw\`
    INSERT INTO "season_rankings"
      ("id", "season_id", "season_participant_id", "rank_type", "rank",
       "total_asset_krw", "return_rate", "max_drawdown", "total_fill_count",
       "ranking_date", "captured_at")
    VALUES (\${nullScopedId}, \${fixture.seasonId}, \${fixture.participants[0].id},
            'daily'::"SeasonRankingType", 1, 777.25, 3.5, 1.5, 9,
            \${rankingDate}::date, now())
  \`;
  const before = await prisma.seasonRanking.findUniqueOrThrow({
    where: { id: nullScopedId },
  });

  // ---- DRY RUN writes nothing ----
  const dry = await repairRankingScope(prisma, { apply: false });
  assert.ok(dry.nullScopeRowCount >= 1);
  assert.ok(dry.backfilledCount >= 1, 'dry-run must report what it would fix');
  const stillNull = await prisma.seasonRanking.findUniqueOrThrow({
    where: { id: nullScopedId },
  });
  assert.equal(stillNull.tradingAccountId, null, 'dry-run must not write');
  assert.equal(resolveRankingScopeExitCode(dry), 0);

  // ---- APPLY fills ONLY the scope column ----
  const applied = await repairRankingScope(prisma, { apply: true });
  assert.ok(applied.backfilledCount >= 1);
  const repaired = await prisma.seasonRanking.findUniqueOrThrow({
    where: { id: nullScopedId },
  });
  assert.equal(repaired.tradingAccountId, fixture.participants[0].accountId);
  assert.equal(repaired.rank, before.rank);
  assert.ok(repaired.totalAssetKrw.equals(before.totalAssetKrw));
  assert.ok(repaired.returnRate.equals(before.returnRate));
  assert.ok(repaired.maxDrawdown.equals(before.maxDrawdown));
  assert.equal(repaired.totalFillCount, before.totalFillCount);
  assert.equal(repaired.capturedAt.getTime(), before.capturedAt.getTime());
  assert.equal(repaired.createdAt.getTime(), before.createdAt.getTime());

  // ---- re-running is a no-op ----
  const again = await repairRankingScope(prisma, { apply: true });
  assert.equal(again.nullScopeRowCount, 0, 'repair must be idempotent');
  assert.equal(again.remainingNullCount, 0);
  assert.equal(again.remainingMismatchCount, 0);
  assert.equal(resolveRankingScopeExitCode(again), 0, 'a clean apply exits 0');

  // ---- a NON-NULL mismatch is reported and NEVER overwritten ----
  await prisma.$executeRaw\`
    UPDATE "season_rankings" SET "trading_account_id" = \${fixture.participants[1].accountId}
    WHERE "id" = \${nullScopedId}
  \`;
  const mismatched = await repairRankingScope(prisma, { apply: true });
  assert.ok(mismatched.mismatchCount >= 1, 'mismatch must be reported');
  assert.equal(
    resolveRankingScopeExitCode(mismatched),
    1,
    'unresolved mismatch must exit non-zero',
  );
  const untouched = await prisma.seasonRanking.findUniqueOrThrow({
    where: { id: nullScopedId },
  });
  assert.equal(
    untouched.tradingAccountId,
    fixture.participants[1].accountId,
    'a mismatch must never be auto-corrected',
  );

  // The audit sees the same damage, read-only.
  const findings = await auditRankingAndSettlement(prisma);
  assert.ok(
    findings.some((finding) => finding.code === 'SEASON_RANKING_SCOPE_MISMATCH'),
    'audit must report the mismatch',
  );

  // Clean it up so the shared DB is left healthy.
  await prisma.$executeRaw\`
    UPDATE "season_rankings" SET "trading_account_id" = \${fixture.participants[0].accountId}
    WHERE "id" = \${nullScopedId}
  \`;

  console.log('  [7] repair-ranking-scope dry-run/apply/idempotency ok');
}

// ===========================================================================

// ===========================================================================
// 8) 작업 8 보완 (§A-1 · §A-2 · §A-3 · §A-5 · §A-6) against real rows.
// ===========================================================================

/** §A-1: a damaged SETTLEMENT input fails the whole settlement. */
async function testSettlementSourceScope() {
  const endAt = new Date(Date.now() - 3_600_000);

  for (const damage of ['null', 'mismatch', 'general-columns']) {
    // Three participants, two snapshots: the third account exists but owns no
    // row on this date, so the "mismatch" case can point at a REAL other
    // account without colliding with the (account, date) unique.
    const fixture = await createSeasonWithParticipants({
      participantCount: 3,
      status: 'ended',
      startAt: new Date(endAt.getTime() - 86_400_000),
      endAt,
    });
    const settlementDate = dateOnly('2026-08-10');
    await createDailySnapshot(fixture.participants[0], settlementDate, '12000000', '20');
    const target = await createDailySnapshot(
      fixture.participants[1],
      settlementDate,
      '11000000',
      '10',
    );

    if (damage === 'null') {
      await prisma.$executeRaw\`
        UPDATE "daily_portfolio_snapshots" SET "trading_account_id" = NULL WHERE "id" = \${target.id}
      \`;
    } else if (damage === 'mismatch') {
      await prisma.$executeRaw\`
        UPDATE "daily_portfolio_snapshots"
        SET "trading_account_id" = \${fixture.participants[2].accountId}
        WHERE "id" = \${target.id}
      \`;
    } else {
      await prisma.$executeRaw\`
        UPDATE "daily_portfolio_snapshots"
        SET "cumulative_external_funding_krw" = 1,
            "investment_pnl_krw" = 0,
            "time_weighted_return_factor" = 1
        WHERE "id" = \${target.id}
      \`;
    }

    let code = null;
    try {
      await runJob(settlementJob, {
        seasonId: fixture.seasonId,
        settlementDate: '2026-08-10',
      });
    } catch (error) {
      code = errorCode(error);
    }
    assert.equal(
      code,
      damage === 'null'
        ? 'SEASON_RANKING_SOURCE_SCOPE_REPAIR_REQUIRED'
        : 'SEASON_RANKING_SOURCE_SCOPE_MISMATCH',
      'settlement source damage (' + damage + ') must fail closed',
    );

    // Fail-CLOSED, not fail-partial: the healthy participant is not settled
    // on its own, and the season stays \`ended\`.
    assert.equal(
      await prisma.seasonRanking.count({
        where: { seasonId: fixture.seasonId, rankType: 'final' },
      }),
      0,
      'no final ranking may be produced from a damaged input set',
    );
    const season = await prisma.season.findUniqueOrThrow({
      where: { id: fixture.seasonId },
      select: { status: true },
    });
    assert.equal(season.status, 'ended');
    const healthy = await prisma.seasonParticipant.findUniqueOrThrow({
      where: { id: fixture.participants[0].id },
      select: { finalRank: true, finalTier: true },
    });
    assert.equal(healthy.finalRank, null);
    assert.equal(healthy.finalTier, null);
  }

  console.log('  [8a] settlement source scope fail-closed ok');
}

/** §A-2: a reused final ranking is the authority for the whole result. */
async function testExistingFinalRankingReuse() {
  const endAt = new Date(Date.now() - 3_600_000);
  const fixture = await createSeasonWithParticipants({
    participantCount: 2,
    status: 'ended',
    startAt: new Date(endAt.getTime() - 86_400_000),
    endAt,
  });
  const settlementDate = dateOnly('2026-08-11');
  await createDailySnapshot(fixture.participants[0], settlementDate, '12000000', '20');
  await createDailySnapshot(fixture.participants[1], settlementDate, '11000000', '10');

  const first = await runJob(settlementJob, {
    seasonId: fixture.seasonId,
    settlementDate: '2026-08-11',
  });
  assert.equal(first.data.run.status, 'succeeded');

  const rankings = await prisma.seasonRanking.findMany({
    where: { seasonId: fixture.seasonId, rankType: 'final' },
    orderBy: { rank: 'asc' },
    select: {
      id: true,
      rank: true,
      seasonParticipantId: true,
      totalAssetKrw: true,
      returnRate: true,
      maxDrawdown: true,
      totalFillCount: true,
    },
  });
  assert.equal(rankings.length, 2);

  // Drift the participant AWAY from its final ranking on every financial
  // field, then replay. The reuse path must restore all of them.
  await prisma.seasonParticipant.update({
    where: { id: rankings[0].seasonParticipantId },
    data: {
      totalAssetKrw: '1',
      totalReturnRate: '-99',
      maxDrawdown: '77',
      totalFillCount: 123,
      currentRank: 9,
      finalRank: null,
      finalTier: null,
    },
  });

  const replay = await runJob(settlementJob, {
    seasonId: fixture.seasonId,
    settlementDate: '2026-08-11',
  });
  assert.equal(replay.data.run.status, 'succeeded');

  const repaired = await prisma.seasonParticipant.findUniqueOrThrow({
    where: { id: rankings[0].seasonParticipantId },
    select: {
      totalAssetKrw: true,
      totalReturnRate: true,
      maxDrawdown: true,
      totalFillCount: true,
      currentRank: true,
      finalRank: true,
      finalTier: true,
    },
  });
  assert.equal(repaired.totalAssetKrw.toString(), rankings[0].totalAssetKrw.toString());
  assert.equal(repaired.totalReturnRate.toString(), rankings[0].returnRate.toString());
  assert.equal(repaired.maxDrawdown.toString(), rankings[0].maxDrawdown.toString());
  assert.equal(repaired.totalFillCount, rankings[0].totalFillCount);
  assert.equal(repaired.currentRank, rankings[0].rank);
  assert.equal(repaired.finalRank, rankings[0].rank);
  assert.ok(repaired.finalTier, 'finalTier must be assigned');

  // Idempotent: no NEW ranking row appeared.
  assert.equal(
    await prisma.seasonRanking.count({
      where: { seasonId: fixture.seasonId, rankType: 'final' },
    }),
    2,
    'a replay must not add ranking rows',
  );

  // A final ranking that no longer covers every eligible participant is
  // refused rather than settled around.
  await prisma.seasonRanking.delete({ where: { id: rankings[1].id } });
  let coverageCode = null;
  try {
    await runJob(settlementJob, {
      seasonId: fixture.seasonId,
      settlementDate: '2026-08-11',
    });
  } catch (error) {
    coverageCode = errorCode(error);
  }
  assert.ok(
    coverageCode === 'FINAL_RESULTS_INTEGRITY' ||
      coverageCode === 'MISSING_FINAL_RANKINGS',
    'a partial final ranking must not be reused, got ' + coverageCode,
  );

  console.log('  [8b] existing final ranking reuse consistency ok');
}

/** §A-3: routine refresh must not delete a damaged ranking set. */
async function testRefreshDoesNotDeleteDamagedRankings() {
  const now = new Date();
  const fixture = await createSeasonWithParticipants({
    participantCount: 2,
    status: 'active',
    startAt: new Date(now.getTime() - 3_600_000),
    endAt: new Date(now.getTime() + 86_400_000),
  });

  await refresh.refreshCurrentRankingForSeason(fixture.seasonId, {
    capturedAt: now,
  });
  const before = await prisma.seasonRanking.findMany({
    where: { seasonId: fixture.seasonId, rankType: 'daily' },
    orderBy: { rank: 'asc' },
    select: { id: true, rank: true, seasonParticipantId: true },
  });
  assert.equal(before.length, 2);

  // A season account that is NOT part of this ranking set, so the "mismatch"
  // case does not collide with the (season, rankType, date, account) unique.
  const bystanderUserId = await createUser('rank-bystander');
  const bystanderAccount = await prisma.tradingAccount.create({
    data: {
      userId: bystanderUserId,
      mode: 'season',
      status: 'active',
      initialCapitalKrw: '10000000',
      openedAt: now,
    },
    select: { id: true },
  });

  for (const damage of ['null', 'mismatch']) {
    if (damage === 'null') {
      await prisma.$executeRaw\`
        UPDATE "season_rankings" SET "trading_account_id" = NULL WHERE "id" = \${before[0].id}
      \`;
    } else {
      await prisma.$executeRaw\`
        UPDATE "season_rankings"
        SET "trading_account_id" = \${bystanderAccount.id}
        WHERE "id" = \${before[0].id}
      \`;
    }

    const ranksBefore = await prisma.seasonParticipant.findMany({
      where: { seasonId: fixture.seasonId },
      orderBy: { id: 'asc' },
      select: { id: true, currentRank: true },
    });

    let code = null;
    try {
      await refresh.refreshCurrentRankingForSeason(fixture.seasonId, {
        capturedAt: new Date(now.getTime() + 60_000),
      });
    } catch (error) {
      code = errorCode(error);
    }
    assert.equal(
      code,
      damage === 'null'
        ? 'SEASON_RANKING_SCOPE_REPAIR_REQUIRED'
        : 'SEASON_RANKING_SCOPE_MISMATCH',
      'refresh must refuse to delete a damaged set (' + damage + ')',
    );

    // The damaged rows are STILL THERE — routine refresh did not launder them.
    const after = await prisma.seasonRanking.findMany({
      where: { seasonId: fixture.seasonId, rankType: 'daily' },
      orderBy: { rank: 'asc' },
      select: { id: true, rank: true },
    });
    assert.equal(after.length, 2, 'damaged ranking rows must survive');
    assert.deepEqual(
      after.map((row) => row.id).sort(),
      before.map((row) => row.id).sort(),
      'the same ranking rows must remain, not recreated ones',
    );
    const ranksAfter = await prisma.seasonParticipant.findMany({
      where: { seasonId: fixture.seasonId },
      orderBy: { id: 'asc' },
      select: { id: true, currentRank: true },
    });
    assert.deepEqual(
      ranksAfter,
      ranksBefore,
      'participant.currentRank must not move when the refresh aborts',
    );
  }

  // A general account linked into the set is refused too.
  const generalUserId = await createUser('general-rank');
  const generalAccount = await prisma.tradingAccount.create({
    data: {
      userId: generalUserId,
      mode: 'general',
      status: 'active',
      initialCapitalKrw: '10000000',
      openedAt: now,
    },
    select: { id: true },
  });
  await prisma.$executeRaw\`
    UPDATE "season_rankings" SET "trading_account_id" = \${generalAccount.id} WHERE "id" = \${before[0].id}
  \`;
  let generalCode = null;
  try {
    await refresh.refreshCurrentRankingForSeason(fixture.seasonId, {
      capturedAt: new Date(now.getTime() + 120_000),
    });
  } catch (error) {
    generalCode = errorCode(error);
  }
  assert.equal(generalCode, 'SEASON_RANKING_SCOPE_MISMATCH');

  // Repaired set: the normal delete-and-recreate policy resumes.
  await prisma.$executeRaw\`
    UPDATE "season_rankings"
    SET "trading_account_id" = \${fixture.participants[0].accountId}
    WHERE "id" = \${before[0].id} AND "season_participant_id" = \${fixture.participants[0].id}
  \`;
  await prisma.seasonRanking.deleteMany({
    where: { seasonId: fixture.seasonId, rankType: 'daily' },
  });
  const healthy = await refresh.refreshCurrentRankingForSeason(fixture.seasonId, {
    capturedAt: new Date(now.getTime() + 180_000),
  });
  assert.equal(healthy.skipped, false);
  assert.equal(healthy.rankingsCreated, 2);

  console.log('  [8c] refresh refuses to delete a damaged ranking set ok');
}

/** §A-5: a settled season never receives a newly computed final ranking. */
async function testSettledWithoutFinalRanking() {
  const endAt = new Date(Date.now() - 3_600_000);
  const fixture = await createSeasonWithParticipants({
    participantCount: 2,
    status: 'ended',
    startAt: new Date(endAt.getTime() - 86_400_000),
    endAt,
  });
  const settlementDate = dateOnly('2026-08-12');
  await createDailySnapshot(fixture.participants[0], settlementDate, '12000000', '20');
  await createDailySnapshot(fixture.participants[1], settlementDate, '11000000', '10');

  await runJob(settlementJob, {
    seasonId: fixture.seasonId,
    settlementDate: '2026-08-12',
  });
  const settled = await prisma.season.findUniqueOrThrow({
    where: { id: fixture.seasonId },
    select: { status: true },
  });
  assert.equal(settled.status, 'settled');

  // settled + COMPLETE final ranking → verified idempotent replay.
  const replay = await runJob(settlementJob, {
    seasonId: fixture.seasonId,
    settlementDate: '2026-08-12',
  });
  assert.equal(replay.data.run.status, 'succeeded');
  assert.equal(
    await prisma.seasonRanking.count({
      where: { seasonId: fixture.seasonId, rankType: 'final' },
    }),
    2,
  );

  // settled + PARTIAL final ranking → refused.
  const rows = await prisma.seasonRanking.findMany({
    where: { seasonId: fixture.seasonId, rankType: 'final' },
    orderBy: { rank: 'asc' },
    select: { id: true },
  });
  await prisma.seasonRanking.delete({ where: { id: rows[1].id } });
  let partialCode = null;
  try {
    await runJob(settlementJob, {
      seasonId: fixture.seasonId,
      settlementDate: '2026-08-12',
    });
  } catch (error) {
    partialCode = errorCode(error);
  }
  assert.equal(partialCode, 'FINAL_RESULTS_INTEGRITY');

  // settled + NO final ranking → refused, and nothing is recomputed.
  await prisma.seasonRanking.deleteMany({
    where: { seasonId: fixture.seasonId, rankType: 'final' },
  });
  const equityBefore = await prisma.equitySnapshot.count({
    where: { seasonParticipantId: fixture.participants[0].id },
  });
  let emptyCode = null;
  try {
    await runJob(settlementJob, {
      seasonId: fixture.seasonId,
      settlementDate: '2026-08-12',
    });
  } catch (error) {
    emptyCode = errorCode(error);
  }
  assert.equal(emptyCode, 'FINAL_RESULTS_INTEGRITY');
  assert.equal(
    await prisma.seasonRanking.count({
      where: { seasonId: fixture.seasonId, rankType: 'final' },
    }),
    0,
    'a settled season must not get a freshly computed final ranking',
  );
  assert.equal(
    await prisma.equitySnapshot.count({
      where: { seasonParticipantId: fixture.participants[0].id },
    }),
    equityBefore,
    'no new settlement snapshot may be created for a settled season',
  );

  console.log('  [8d] settled-without-final-ranking blocked ok');
}

/** §A-6: final tier assignment checks EVERY season account. */
async function testFinalTierChecksEveryAccount() {
  const endAt = new Date(Date.now() - 3_600_000);
  const fixture = await createSeasonWithParticipants({
    participantCount: 3,
    status: 'ended',
    startAt: new Date(endAt.getTime() - 86_400_000),
    endAt,
  });
  // participant[2] is EXCLUDED: never in the final ranking.
  await prisma.seasonParticipant.update({
    where: { id: fixture.participants[2].id },
    data: { participantStatus: 'excluded', excludedAt: new Date() },
  });

  const settlementDate = dateOnly('2026-08-13');
  await createDailySnapshot(fixture.participants[0], settlementDate, '12000000', '20');
  await createDailySnapshot(fixture.participants[1], settlementDate, '11000000', '10');

  await runJob(settlementJob, {
    seasonId: fixture.seasonId,
    settlementDate: '2026-08-13',
  });

  // Clear the assigned results so the job has work to do, then reopen the
  // EXCLUDED participant's account — which no final ranking row mentions.
  await prisma.seasonParticipant.updateMany({
    where: { seasonId: fixture.seasonId },
    data: { finalRank: null, finalTier: null },
  });
  await prisma.tradingAccount.update({
    where: { id: fixture.participants[2].accountId },
    data: { status: 'active', closedAt: null },
  });

  let excludedCode = null;
  try {
    await runJob(finalTierJob, {
      seasonId: fixture.seasonId,
      rankingDate: '2026-08-13',
    });
  } catch (error) {
    excludedCode = errorCode(error);
  }
  assert.equal(
    excludedCode,
    'SEASON_ACCOUNT_CLOSE_INCOMPLETE',
    'an excluded participant with a live account must block final tier assignment',
  );
  const untouched = await prisma.seasonParticipant.findUniqueOrThrow({
    where: { id: fixture.participants[0].id },
    select: { finalTier: true },
  });
  assert.equal(untouched.finalTier, null, 'no tier may be assigned while blocked');
  // The job never closes an account itself.
  const stillOpen = await prisma.tradingAccount.findUniqueOrThrow({
    where: { id: fixture.participants[2].accountId },
    select: { status: true, closedAt: true },
  });
  assert.equal(stillOpen.status, 'active');
  assert.equal(stillOpen.closedAt, null);

  // closedAt = null on a "closed" account is refused too.
  await prisma.tradingAccount.update({
    where: { id: fixture.participants[2].accountId },
    data: { status: 'closed', closedAt: null },
  });
  let closedAtCode = null;
  try {
    await runJob(finalTierJob, {
      seasonId: fixture.seasonId,
      rankingDate: '2026-08-13',
    });
  } catch (error) {
    closedAtCode = errorCode(error);
  }
  assert.equal(closedAtCode, 'SEASON_ACCOUNT_CLOSE_INCOMPLETE');

  // Everything properly closed → the job runs.
  await prisma.tradingAccount.update({
    where: { id: fixture.participants[2].accountId },
    data: { status: 'closed', closedAt: endAt },
  });
  const ok = await runJob(finalTierJob, {
    seasonId: fixture.seasonId,
    rankingDate: '2026-08-13',
  });
  assert.equal(ok.data.run.status, 'succeeded');
  assert.equal(ok.data.run.resultPayloadJson.participants.assigned, 2);

  console.log('  [8e] final tier checks every season account ok');
}

async function cleanup() {
  // Order matters: ranking rows and snapshots reference participants and
  // accounts with onDelete: Restrict.
  await prisma.seasonRanking.deleteMany({
    where: { seasonId: { in: createdSeasonIds } },
  });
  await prisma.dailyPortfolioSnapshot.deleteMany({
    where: { seasonParticipant: { seasonId: { in: createdSeasonIds } } },
  });
  await prisma.equitySnapshot.deleteMany({
    where: { seasonParticipant: { seasonId: { in: createdSeasonIds } } },
  });
  await prisma.equitySnapshot.deleteMany({
    where: { tradingAccount: { userId: { in: createdUserIds } } },
  });
  await prisma.walletTransaction.deleteMany({
    where: { tradingAccount: { userId: { in: createdUserIds } } },
  });
  await prisma.cashWallet.deleteMany({
    where: { tradingAccount: { userId: { in: createdUserIds } } },
  });
  await prisma.seasonParticipant.deleteMany({
    where: { seasonId: { in: createdSeasonIds } },
  });
  await prisma.tradingAccount.deleteMany({
    where: { userId: { in: createdUserIds } },
  });
  await prisma.season.deleteMany({ where: { id: { in: createdSeasonIds } } });
  await prisma.batchJobRun.deleteMany({
    where: { idempotencyKey: { in: createdJobKeys } },
  });
  await prisma.fxRateSnapshot.deleteMany({
    where: { id: { in: createdFxSnapshotIds } },
  });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
}

async function main() {
  try {
    await ensureFxRate();
    await testMigrationBackfillAndUnique();
    await testWritersDualWrite();
    await testRankingInputScope();
    await testSettlementClosesAccounts();
    await testSettlementRollback();
    await testRefreshVsSettlement();
    await testRepairScript();
    await testSettlementSourceScope();
    await testExistingFinalRankingReuse();
    await testRefreshDoesNotDeleteDamagedRankings();
    await testSettledWithoutFinalRanking();
    await testFinalTierChecksEveryAccount();
    console.log('season ranking scope ok');
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
