import { spawnSync } from 'node:child_process';

/**
 * Opt-in PostgreSQL integration tests for the TradingAccount foundation.
 * Runs only with TRADING_ACCOUNT_DB_INTEGRATION=1 against the migrated dev
 * DB (prepare = `prisma migrate deploy` only; never reset/drop/seed).
 *
 * Covers what mocks cannot: the migration backfill SQL executed verbatim from
 * the migration file, the general-mode partial unique index, table CHECK
 * constraints, join-transaction atomicity/rollback, replay idempotency, and
 * the duplicate-join race.
 */
const RUN_DB_INTEGRATION = process.env.TRADING_ACCOUNT_DB_INTEGRATION === '1';
const itDbIntegration = RUN_DB_INTEGRATION ? it : it.skip;

describe('TradingAccount DB integration', () => {
  itDbIntegration(
    'verifies backfill mapping, partial unique, CHECKs, join atomicity, replay, and race against PostgreSQL',
    () => {
      runDbIntegrationPrepare();

      const result = spawnSync(
        getPnpmCommand(),
        ['tsx', '-e', TRADING_ACCOUNT_DB_RUNNER],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 120_000,
        },
      );

      if (result.status !== 0) {
        throw new Error(
          [
            'TradingAccount DB integration runner failed.',
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
          ].join('\n'),
        );
      }

      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('trading account db integration ok');
    },
    130_000,
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
        'TradingAccount DB integration prepare failed.',
        'The opt-in test applies existing Prisma migrations with `prisma migrate deploy` only; it does not reset, drop, or seed the database.',
        'stdout:',
        result.stdout,
        'stderr:',
        result.stderr,
      ].join('\n'),
    );
  }
}

const TRADING_ACCOUNT_DB_RUNNER = `
import 'dotenv/config';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import {
  CurrencyCode,
  ParticipantStatus,
  SeasonStatus,
  TradingAccountMode,
  TradingAccountStatus,
  WalletTransactionDirection,
  WalletTransactionReferenceType,
  WalletTransactionType,
} from './src/generated/prisma/client';
import { PrismaService } from './src/prisma/prisma.service';
import { SeasonsService } from './src/seasons/seasons.service';

const TEST_PREFIX = 'trading-account-db-integration';
const ZERO = '0.00000000';
const CAPITAL = '10000000.00000000';
const prisma = new PrismaService();
const seasonsService = new SeasonsService(prisma);

const MIGRATION_PATH =
  'prisma/migrations/20260801120000_add_trading_account_foundation/migration.sql';

function backfillStatements() {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');
  // Strip full-line comments first: they may themselves contain semicolons,
  // which would break naive statement splitting.
  const sqlWithoutComments = sql
    .split('\\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\\n');
  const statements = sqlWithoutComments
    .split(';')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
  const insert = statements.find((s) =>
    s.includes('INSERT INTO "trading_accounts"'),
  );
  const update = statements.find(
    (s) =>
      s.startsWith('UPDATE "season_participants"') ||
      s.includes('UPDATE "season_participants" sp'),
  );
  assert.ok(insert, 'backfill INSERT not found in migration');
  assert.ok(update, 'backfill UPDATE not found in migration');
  return [insert + ';', update + ';'];
}

async function createUser(label) {
  const suffix = randomUUID().slice(0, 8);
  return prisma.user.create({
    data: {
      email: TEST_PREFIX + '-' + label + '-' + suffix + '@example.com',
      passwordHash: 'integration-test-only',
      nickname: TEST_PREFIX + '-' + label + '-' + suffix,
    },
    select: { id: true },
  });
}

async function createSeason(label, options = {}) {
  const suffix = randomUUID().slice(0, 8);
  const now = new Date();
  return prisma.season.create({
    data: {
      name: TEST_PREFIX + '-' + label + '-' + suffix,
      status: SeasonStatus.active,
      startAt: new Date(now.getTime() - 60_000),
      endAt: new Date(now.getTime() + 86_400_000),
      initialCapitalKrw: options.initialCapitalKrw ?? CAPITAL,
      tradeFeeRate: '0.001000',
      fxFeeRate: '0.001000',
    },
    select: { id: true },
  });
}

async function cleanup(scope) {
  await prisma.walletTransaction.deleteMany({
    where: { seasonParticipantId: { in: scope.participantIds } },
  });
  await prisma.equitySnapshot.deleteMany({
    where: { seasonParticipantId: { in: scope.participantIds } },
  });
  await prisma.cashWallet.deleteMany({
    where: { seasonParticipantId: { in: scope.participantIds } },
  });
  await prisma.seasonParticipant.deleteMany({
    where: { id: { in: scope.participantIds } },
  });
  await prisma.tradingAccount.deleteMany({
    where: { userId: { in: scope.userIds } },
  });
  await prisma.season.deleteMany({ where: { id: { in: scope.seasonIds } } });
  await prisma.user.deleteMany({ where: { id: { in: scope.userIds } } });
}

async function expectUniqueViolation(work, marker) {
  let failed = false;
  try {
    await work();
  } catch (error) {
    failed = true;
    const text =
      (error && error.code ? error.code + ' ' : '') + String(error.message);
    assert.ok(
      error.code === 'P2002' ||
        text.includes(marker) ||
        text.includes('Unique constraint'),
      'expected unique violation (' + marker + '), got: ' + text,
    );
  }
  assert.ok(failed, 'expected unique violation for ' + marker);
}

async function expectCheckViolation(work, constraintName) {
  let failed = false;
  try {
    await work();
  } catch (error) {
    failed = true;
    const text = String(error.message);
    assert.ok(
      text.includes(constraintName) || text.includes('check'),
      'expected CHECK violation (' + constraintName + '), got: ' + text,
    );
  }
  assert.ok(failed, 'expected CHECK violation for ' + constraintName);
}

async function testBackfillMappingAndNonDestruction() {
  const season = await createSeason('backfill');
  const scope = { userIds: [], seasonIds: [season.id], participantIds: [] };
  const statuses = [
    [ParticipantStatus.registered, TradingAccountStatus.active],
    [ParticipantStatus.active, TradingAccountStatus.active],
    [ParticipantStatus.excluded, TradingAccountStatus.suspended],
    [ParticipantStatus.finished, TradingAccountStatus.closed],
    [ParticipantStatus.rewarded, TradingAccountStatus.closed],
  ];

  try {
    const joinedAt = new Date('2026-05-01T01:02:03.000Z');
    const rows = [];
    for (const [participantStatus, expectedAccountStatus] of statuses) {
      const user = await createUser('backfill-' + participantStatus);
      scope.userIds.push(user.id);
      // Pre-account participant shape: tradingAccountId deliberately null,
      // exactly like rows that existed before the migration.
      const participant = await prisma.seasonParticipant.create({
        data: {
          seasonId: season.id,
          userId: user.id,
          joinedAt,
          participantStatus,
          initialCapitalKrw: CAPITAL,
          totalAssetKrw: CAPITAL,
          totalReturnRate: ZERO,
          maxDrawdown: ZERO,
        },
        select: { id: true },
      });
      scope.participantIds.push(participant.id);
      rows.push({ participant, user, participantStatus, expectedAccountStatus });
    }

    // Financial rows that the backfill must not touch.
    const wallet = await prisma.cashWallet.create({
      data: {
        seasonParticipantId: rows[0].participant.id,
        currencyCode: CurrencyCode.KRW,
        balanceAmount: '1234567.00000000',
      },
      select: { id: true },
    });
    await prisma.walletTransaction.create({
      data: {
        seasonParticipantId: rows[0].participant.id,
        walletId: wallet.id,
        currencyCode: CurrencyCode.KRW,
        direction: WalletTransactionDirection.credit,
        txType: WalletTransactionType.initial_grant,
        referenceType: WalletTransactionReferenceType.season_join,
        referenceId: rows[0].participant.id,
        amount: '1234567.00000000',
        balanceAfter: '1234567.00000000',
        occurredAt: joinedAt,
      },
    });

    const [insertSql, updateSql] = backfillStatements();
    await prisma.$executeRawUnsafe(insertSql);
    await prisma.$executeRawUnsafe(updateSql);

    for (const row of rows) {
      const participant = await prisma.seasonParticipant.findUniqueOrThrow({
        where: { id: row.participant.id },
        include: { tradingAccount: true },
      });
      assert.ok(participant.tradingAccountId, 'tradingAccountId backfilled');
      const account = participant.tradingAccount;
      assert.equal(account.userId, row.user.id);
      assert.equal(account.mode, TradingAccountMode.season);
      assert.equal(account.status, row.expectedAccountStatus);
      assert.equal(account.initialCapitalKrw.toFixed(8), CAPITAL);
      assert.equal(account.openedAt.getTime(), participant.joinedAt.getTime());
      assert.equal(account.closedAt, null);
    }

    // Exactly one account per participant, no orphans, no general accounts.
    const accounts = await prisma.tradingAccount.findMany({
      where: { userId: { in: scope.userIds } },
    });
    assert.equal(accounts.length, statuses.length);
    assert.equal(
      accounts.filter((a) => a.mode === TradingAccountMode.general).length,
      0,
    );

    // Idempotent replay of the same statements creates nothing new.
    await prisma.$executeRawUnsafe(insertSql);
    await prisma.$executeRawUnsafe(updateSql);
    const accountsAfterReplay = await prisma.tradingAccount.count({
      where: { userId: { in: scope.userIds } },
    });
    assert.equal(accountsAfterReplay, statuses.length);

    // Financial rows untouched.
    const walletAfter = await prisma.cashWallet.findUniqueOrThrow({
      where: { id: wallet.id },
    });
    assert.equal(walletAfter.balanceAmount.toFixed(8), '1234567.00000000');
    const ledgerCount = await prisma.walletTransaction.count({
      where: { seasonParticipantId: rows[0].participant.id },
    });
    assert.equal(ledgerCount, 1);
  } finally {
    await cleanup(scope);
  }
}

async function testGeneralPartialUniqueAndSharing() {
  const userA = await createUser('unique-a');
  const userB = await createUser('unique-b');
  const season = await createSeason('unique');
  const scope = {
    userIds: [userA.id, userB.id],
    seasonIds: [season.id],
    participantIds: [],
  };
  const now = new Date();

  try {
    const accountData = (userId, mode) => ({
      userId,
      mode,
      status: TradingAccountStatus.active,
      initialCapitalKrw: CAPITAL,
      openedAt: now,
    });

    // First general account per user is allowed.
    await prisma.tradingAccount.create({
      data: accountData(userA.id, TradingAccountMode.general),
    });
    // Second general account for the same user is rejected by the partial
    // unique index.
    await expectUniqueViolation(
      () =>
        prisma.tradingAccount.create({
          data: accountData(userA.id, TradingAccountMode.general),
        }),
      'trading_accounts_general_owner_unique',
    );
    // Multiple season accounts for the same user stay allowed.
    const seasonAccount1 = await prisma.tradingAccount.create({
      data: accountData(userA.id, TradingAccountMode.season),
      select: { id: true },
    });
    await prisma.tradingAccount.create({
      data: accountData(userA.id, TradingAccountMode.season),
    });
    // A different user's first general account is allowed.
    await prisma.tradingAccount.create({
      data: accountData(userB.id, TradingAccountMode.general),
    });

    // Two participants cannot share one trading account (unique FK column).
    const participant = await prisma.seasonParticipant.create({
      data: {
        seasonId: season.id,
        userId: userA.id,
        joinedAt: now,
        participantStatus: ParticipantStatus.active,
        initialCapitalKrw: CAPITAL,
        totalAssetKrw: CAPITAL,
        totalReturnRate: ZERO,
        maxDrawdown: ZERO,
        tradingAccountId: seasonAccount1.id,
      },
      select: { id: true },
    });
    scope.participantIds.push(participant.id);
    const otherSeason = await createSeason('unique-share');
    scope.seasonIds.push(otherSeason.id);
    await expectUniqueViolation(async () => {
      const duplicate = await prisma.seasonParticipant.create({
        data: {
          seasonId: otherSeason.id,
          userId: userA.id,
          joinedAt: now,
          participantStatus: ParticipantStatus.active,
          initialCapitalKrw: CAPITAL,
          totalAssetKrw: CAPITAL,
          totalReturnRate: ZERO,
          maxDrawdown: ZERO,
          tradingAccountId: seasonAccount1.id,
        },
        select: { id: true },
      });
      scope.participantIds.push(duplicate.id);
    }, 'season_participants_trading_account_id_key');
  } finally {
    await cleanup(scope);
  }
}

async function testCheckConstraints() {
  const user = await createUser('check');
  const scope = { userIds: [user.id], seasonIds: [], participantIds: [] };
  const now = new Date();

  try {
    await expectCheckViolation(
      () =>
        prisma.tradingAccount.create({
          data: {
            userId: user.id,
            mode: TradingAccountMode.season,
            initialCapitalKrw: ZERO,
            openedAt: now,
          },
        }),
      'trading_accounts_initial_capital_krw_check',
    );
    await expectCheckViolation(
      () =>
        prisma.tradingAccount.create({
          data: {
            userId: user.id,
            mode: TradingAccountMode.season,
            initialCapitalKrw: CAPITAL,
            openedAt: now,
            closedAt: new Date(now.getTime() - 60_000),
          },
        }),
      'trading_accounts_closed_after_opened_check',
    );
  } finally {
    await cleanup(scope);
  }
}

async function testJoinCreatesAccountAtomically() {
  const user = await createUser('join');
  const season = await createSeason('join');
  const scope = { userIds: [user.id], seasonIds: [season.id], participantIds: [] };

  try {
    const response = await seasonsService.joinSeason(season.id, user.id);
    const participantId = response.data.seasonParticipantId;
    scope.participantIds.push(participantId);

    const participant = await prisma.seasonParticipant.findUniqueOrThrow({
      where: { id: participantId },
      include: { tradingAccount: true },
    });
    assert.ok(participant.tradingAccountId, 'join links a trading account');
    assert.equal(participant.tradingAccount.mode, TradingAccountMode.season);
    assert.equal(
      participant.tradingAccount.status,
      TradingAccountStatus.active,
    );
    assert.equal(
      participant.tradingAccount.initialCapitalKrw.toFixed(8),
      CAPITAL,
    );
    assert.equal(
      participant.tradingAccount.openedAt.getTime(),
      participant.joinedAt.getTime(),
    );

    // Wallets + initial grant still created exactly as before.
    const wallets = await prisma.cashWallet.findMany({
      where: { seasonParticipantId: participantId },
    });
    assert.equal(wallets.length, 2);
    const grants = await prisma.walletTransaction.count({
      where: {
        seasonParticipantId: participantId,
        txType: WalletTransactionType.initial_grant,
      },
    });
    assert.equal(grants, 1);

    // Replay: conflict, and no duplicate participant/account/wallet/grant.
    let replayError = null;
    try {
      await seasonsService.joinSeason(season.id, user.id);
    } catch (error) {
      replayError = error;
    }
    assert.ok(replayError instanceof HttpException);
    assert.equal(replayError.getStatus(), 409);
    assert.equal(
      await prisma.seasonParticipant.count({
        where: { seasonId: season.id, userId: user.id },
      }),
      1,
    );
    assert.equal(
      await prisma.tradingAccount.count({ where: { userId: user.id } }),
      1,
    );
    assert.equal(
      await prisma.cashWallet.count({
        where: { seasonParticipantId: participantId },
      }),
      2,
    );
    assert.equal(
      await prisma.walletTransaction.count({
        where: {
          seasonParticipantId: participantId,
          txType: WalletTransactionType.initial_grant,
        },
      }),
      1,
    );
  } finally {
    await cleanup(scope);
  }
}

async function testJoinRollbackOnLaterFailure(failingModel) {
  const user = await createUser('rollback-' + failingModel);
  const season = await createSeason('rollback-' + failingModel);
  const scope = { userIds: [user.id], seasonIds: [season.id], participantIds: [] };

  try {
    // Real transaction, real DB: the injected failure happens AFTER the
    // trading account (and possibly wallets) were inserted, so a passing test
    // proves PostgreSQL rolled those rows back.
    const failingPrisma = {
      $transaction: (callback) =>
        prisma.$transaction((tx) =>
          callback(
            new Proxy(tx, {
              get(target, prop, receiver) {
                if (prop === failingModel) {
                  return {
                    create: async () => {
                      throw new Error(
                        'injected ' + failingModel + ' failure',
                      );
                    },
                  };
                }
                return Reflect.get(target, prop, receiver);
              },
            }),
          ),
        ),
    };
    const failingService = new SeasonsService(failingPrisma);

    let failure = null;
    try {
      await failingService.joinSeason(season.id, user.id);
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, 'injected failure must propagate');

    assert.equal(
      await prisma.tradingAccount.count({ where: { userId: user.id } }),
      0,
      failingModel + ' failure must roll the trading account back',
    );
    assert.equal(
      await prisma.seasonParticipant.count({
        where: { seasonId: season.id, userId: user.id },
      }),
      0,
    );
    assert.equal(
      await prisma.cashWallet.count({
        where: { seasonParticipant: { userId: user.id } },
      }),
      0,
    );
  } finally {
    await cleanup(scope);
  }
}

async function testDuplicateJoinRace() {
  const user = await createUser('race');
  const season = await createSeason('race');
  const scope = { userIds: [user.id], seasonIds: [season.id], participantIds: [] };

  try {
    const results = await Promise.allSettled([
      seasonsService.joinSeason(season.id, user.id),
      seasonsService.joinSeason(season.id, user.id),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    assert.ok(fulfilled.length >= 1, 'at least one join must succeed');
    for (const result of results) {
      if (result.status === 'rejected') {
        assert.ok(result.reason instanceof HttpException);
        assert.equal(result.reason.getStatus(), 409);
      }
    }
    const participants = await prisma.seasonParticipant.findMany({
      where: { seasonId: season.id, userId: user.id },
      select: { id: true },
    });
    scope.participantIds.push(...participants.map((p) => p.id));
    assert.equal(participants.length, 1, 'no duplicate participant');
    assert.equal(
      await prisma.tradingAccount.count({ where: { userId: user.id } }),
      1,
      'no duplicate or orphan trading account after the race',
    );
  } finally {
    await cleanup(scope);
  }
}

async function runCase(label, work) {
  try {
    await work();
    console.log('case ok: ' + label);
  } catch (error) {
    console.error('case failed: ' + label);
    throw error;
  }
}

async function main() {
  await prisma.$connect();
  try {
    await runCase('backfill mapping + non-destruction', testBackfillMappingAndNonDestruction);
    await runCase('general partial unique + account sharing', testGeneralPartialUniqueAndSharing);
    await runCase('table CHECK constraints', testCheckConstraints);
    await runCase('join creates linked account atomically + replay', testJoinCreatesAccountAtomically);
    await runCase('rollback on wallet failure', () => testJoinRollbackOnLaterFailure('cashWallet'));
    await runCase('rollback on ledger failure', () => testJoinRollbackOnLaterFailure('walletTransaction'));
    await runCase('duplicate join race', testDuplicateJoinRace);
    console.log('trading account db integration ok');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
