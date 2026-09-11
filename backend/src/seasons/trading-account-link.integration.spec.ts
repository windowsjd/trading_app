import { spawnSync } from 'node:child_process';

/**
 * Opt-in PostgreSQL integration tests for the trading-account link repair,
 * the exclusion→account-status sync, and the ownership access layer.
 * Runs only with TRADING_ACCOUNT_DB_INTEGRATION=1 against the migrated dev
 * DB (prepare = `prisma migrate deploy` only; never reset/drop/seed).
 *
 * Covers what mocks cannot: the app-side deterministic id vs PostgreSQL's
 * md5(...)::uuid cast, real-transaction repair atomicity and rollback,
 * concurrent repair races (one account, no orphans), non-mutation of
 * financial rows, and ownership-scoped 404 behavior.
 */
const RUN_DB_INTEGRATION = process.env.TRADING_ACCOUNT_DB_INTEGRATION === '1';
const itDbIntegration = RUN_DB_INTEGRATION ? it : it.skip;

describe('TradingAccount link repair DB integration', () => {
  itDbIntegration(
    'verifies deterministic id, null-link repair, join repair, exclusion sync, and ownership against PostgreSQL',
    () => {
      runDbIntegrationPrepare();

      const result = spawnSync(
        getPnpmCommand(),
        ['tsx', '-e', TRADING_ACCOUNT_LINK_DB_RUNNER],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 180_000,
        },
      );

      if (result.status !== 0) {
        throw new Error(
          [
            'TradingAccount link DB integration runner failed.',
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
          ].join('\n'),
        );
      }

      expect(result.stdout).toContain('trading account link db integration ok');
    },
    200_000,
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
        'TradingAccount link DB integration prepare failed.',
        'The opt-in test applies existing Prisma migrations with `prisma migrate deploy` only; it does not reset, drop, or seed the database.',
        'stdout:',
        result.stdout,
        'stderr:',
        result.stderr,
      ].join('\n'),
    );
  }
}

const TRADING_ACCOUNT_LINK_DB_RUNNER = `
import 'dotenv/config';
import assert from 'node:assert/strict';
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
import {
  deriveSeasonTradingAccountId,
  ensureSeasonTradingAccountLink,
  SeasonTradingAccountLinkIntegrityError,
} from './src/seasons/season-trading-account-link';
import { repairMissingTradingAccountLinks } from './scripts/lib/repair-trading-account-links';
import { OperatorAuditService } from './src/operator/operator-audit.service';
import { OperatorSeasonModerationService } from './src/operator/operator-season-moderation.service';
import { TradingAccountAccessService } from './src/trading-accounts/trading-account-access.service';

const TEST_PREFIX = 'trading-account-link-db-integration';
const ZERO = '0.00000000';
const CAPITAL = '10000000.00000000';
const prisma = new PrismaService();
const seasonsService = new SeasonsService(prisma);
const accessService = new TradingAccountAccessService(prisma);

async function createUser(label, role) {
  const suffix = randomUUID().slice(0, 8);
  return prisma.user.create({
    data: {
      email: TEST_PREFIX + '-' + label + '-' + suffix + '@example.com',
      passwordHash: 'integration-test-only',
      nickname: TEST_PREFIX + '-' + label + '-' + suffix,
      role: role ?? 'user',
    },
    select: { id: true },
  });
}

async function createSeason(label, status) {
  const suffix = randomUUID().slice(0, 8);
  const now = new Date();
  return prisma.season.create({
    data: {
      name: TEST_PREFIX + '-' + label + '-' + suffix,
      status: status ?? SeasonStatus.active,
      startAt: new Date(now.getTime() - 60_000),
      endAt: new Date(now.getTime() + 86_400_000),
      initialCapitalKrw: CAPITAL,
      tradeFeeRate: '0.001000',
      fxFeeRate: '0.001000',
    },
    select: { id: true },
  });
}

// Canonical post-migration participant shape. Pre-migration NULL-link behavior
// is covered by the repair helper's unit tests and migration SQL checks; a
// migrated runtime database must only be populated through this required link.
async function createCanonicalParticipant(seasonId, userId, participantStatus) {
  const joinedAt = new Date('2026-06-15T01:02:03.000Z');
  const participantId = randomUUID();
  const accountId = deriveSeasonTradingAccountId(participantId);
  const accountStatus =
    participantStatus === ParticipantStatus.excluded
      ? TradingAccountStatus.suspended
      : participantStatus === ParticipantStatus.finished ||
          participantStatus === ParticipantStatus.rewarded
        ? TradingAccountStatus.closed
        : TradingAccountStatus.active;
  await prisma.tradingAccount.create({
    data: {
      id: accountId,
      userId,
      mode: TradingAccountMode.season,
      status: accountStatus,
      initialCapitalKrw: CAPITAL,
      openedAt: joinedAt,
    },
  });
  const participant = await prisma.seasonParticipant.create({
    data: {
      id: participantId,
      seasonId,
      userId,
      joinedAt,
      participantStatus,
      initialCapitalKrw: CAPITAL,
      totalAssetKrw: CAPITAL,
      totalReturnRate: ZERO,
      maxDrawdown: ZERO,
      tradingAccountId: accountId,
    },
    select: { id: true, joinedAt: true },
  });
  const krwWallet = await prisma.cashWallet.create({
    data: {
      tradingAccountId: accountId,
      currencyCode: CurrencyCode.KRW,
      balanceAmount: CAPITAL,
    },
    select: { id: true },
  });
  await prisma.cashWallet.create({
    data: {
      tradingAccountId: accountId,
      currencyCode: CurrencyCode.USD,
      balanceAmount: ZERO,
    },
    select: { id: true },
  });
  await prisma.walletTransaction.create({
    data: {
      tradingAccountId: accountId,
      walletId: krwWallet.id,
      currencyCode: CurrencyCode.KRW,
      direction: WalletTransactionDirection.credit,
      txType: WalletTransactionType.initial_grant,
      referenceType: WalletTransactionReferenceType.season_join,
      referenceId: participant.id,
      amount: CAPITAL,
      balanceAfter: CAPITAL,
      occurredAt: joinedAt,
    },
  });
  await prisma.equitySnapshot.create({
    data: {
      tradingAccountId: accountId,
      totalAssetKrw: CAPITAL,
      returnRate: ZERO,
      krwCash: CAPITAL,
      usdCashKrw: ZERO,
      domesticStockValueKrw: ZERO,
      usStockValueKrw: ZERO,
      cryptoValueKrw: ZERO,
      snapshotReason: 'season_join',
      capturedAt: joinedAt,
    },
  });
  return {
    id: participant.id,
    joinedAt,
    krwWalletId: krwWallet.id,
    tradingAccountId: accountId,
  };
}

async function financialFingerprint(tradingAccountId) {
  const [wallets, ledger, snapshots, orders, positions] = await Promise.all([
    prisma.cashWallet.findMany({
      where: { tradingAccountId },
      orderBy: { currencyCode: 'asc' },
      select: { id: true, currencyCode: true, balanceAmount: true, reservedAmount: true },
    }),
    prisma.walletTransaction.findMany({
      where: { tradingAccountId },
      orderBy: { id: 'asc' },
      select: { id: true, txType: true, amount: true, balanceAfter: true },
    }),
    prisma.equitySnapshot.count({ where: { tradingAccountId } }),
    prisma.order.count({ where: { tradingAccountId } }),
    prisma.position.count({ where: { tradingAccountId } }),
  ]);
  return JSON.stringify({
    wallets: wallets.map((w) => ({
      id: w.id,
      currencyCode: w.currencyCode,
      balanceAmount: w.balanceAmount.toFixed(8),
      reservedAmount: w.reservedAmount.toFixed(8),
    })),
    ledger: ledger.map((l) => ({
      id: l.id,
      txType: l.txType,
      amount: l.amount.toFixed(8),
      balanceAfter: l.balanceAfter.toFixed(8),
    })),
    snapshots,
    orders,
    positions,
  });
}

async function cleanup(scope) {
  await prisma.operatorAuditLog.deleteMany({
    where: { actorUserId: { in: scope.userIds } },
  });
  await prisma.walletTransaction.deleteMany({
    where: { tradingAccount: { userId: { in: scope.userIds } } },
  });
  await prisma.equitySnapshot.deleteMany({
    where: { tradingAccount: { userId: { in: scope.userIds } } },
  });
  await prisma.cashWallet.deleteMany({
    where: { tradingAccount: { userId: { in: scope.userIds } } },
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

async function testDeterministicIdMatchesPostgres() {
  const samples = ['sp_dev_001', 'sp-legacy-1', randomUUID(), randomUUID()];
  for (const pid of samples) {
    const rows = await prisma.$queryRawUnsafe(
      'SELECT md5(' + "'trading-account:season-participant:'" + ' || $1)::uuid::text AS id',
      pid,
    );
    assert.equal(
      deriveSeasonTradingAccountId(pid),
      rows[0].id,
      'app-side deterministic id must equal the migration md5::uuid cast for ' + pid,
    );
  }
}

async function testRepairMappingAndNonMutation() {
  const season = await createSeason('repair');
  const scope = { userIds: [], seasonIds: [season.id], participantIds: [] };
  const cases = [
    [ParticipantStatus.registered, TradingAccountStatus.active],
    [ParticipantStatus.active, TradingAccountStatus.active],
    [ParticipantStatus.excluded, TradingAccountStatus.suspended],
    [ParticipantStatus.finished, TradingAccountStatus.closed],
    [ParticipantStatus.rewarded, TradingAccountStatus.closed],
  ];

  try {
    for (const [participantStatus, expectedStatus] of cases) {
      const user = await createUser('repair-' + participantStatus);
      scope.userIds.push(user.id);
      const legacy = await createCanonicalParticipant(
        season.id,
        user.id,
        participantStatus,
      );
      scope.participantIds.push(legacy.id);
      const before = await financialFingerprint(legacy.tradingAccountId);

      const participantRow = await prisma.seasonParticipant.findUniqueOrThrow({
        where: { id: legacy.id },
        select: {
          id: true,
          userId: true,
          joinedAt: true,
          participantStatus: true,
          initialCapitalKrw: true,
          tradingAccountId: true,
        },
      });
      const result = await prisma.$transaction((tx) =>
        ensureSeasonTradingAccountLink(tx, participantRow),
      );
      assert.equal(result.action, 'already-linked');
      assert.equal(result.tradingAccountId, deriveSeasonTradingAccountId(legacy.id));

      const linked = await prisma.seasonParticipant.findUniqueOrThrow({
        where: { id: legacy.id },
        include: { tradingAccount: true },
      });
      assert.equal(linked.tradingAccountId, result.tradingAccountId);
      assert.equal(linked.tradingAccount.userId, user.id);
      assert.equal(linked.tradingAccount.mode, TradingAccountMode.season);
      assert.equal(linked.tradingAccount.status, expectedStatus);
      assert.equal(linked.tradingAccount.initialCapitalKrw.toFixed(8), CAPITAL);
      assert.equal(
        linked.tradingAccount.openedAt.getTime(),
        legacy.joinedAt.getTime(),
      );
      assert.equal(linked.tradingAccount.closedAt, null);

      // Financial rows byte-identical, replay creates nothing new.
      assert.equal(
        await financialFingerprint(legacy.tradingAccountId),
        before,
      );
      const replay = await prisma.$transaction((tx) =>
        ensureSeasonTradingAccountLink(tx, {
          ...participantRow,
          tradingAccountId: linked.tradingAccountId,
        }),
      );
      assert.equal(replay.action, 'already-linked');
      assert.equal(
        await prisma.tradingAccount.count({ where: { userId: user.id } }),
        1,
      );
      assert.equal(
        await prisma.tradingAccount.count({
          where: { userId: user.id, mode: TradingAccountMode.general },
        }),
        0,
        'repair must never create a general account',
      );
    }
  } finally {
    await cleanup(scope);
  }
}

async function testConcurrentRepairRace() {
  const season = await createSeason('race');
  const user = await createUser('race');
  const scope = { userIds: [user.id], seasonIds: [season.id], participantIds: [] };

  try {
    const legacy = await createCanonicalParticipant(
      season.id,
      user.id,
      ParticipantStatus.active,
    );
    scope.participantIds.push(legacy.id);
    const participantRow = await prisma.seasonParticipant.findUniqueOrThrow({
      where: { id: legacy.id },
      select: {
        id: true,
        userId: true,
        joinedAt: true,
        participantStatus: true,
        initialCapitalKrw: true,
        tradingAccountId: true,
      },
    });

    const results = await Promise.allSettled([
      prisma.$transaction((tx) => ensureSeasonTradingAccountLink(tx, participantRow)),
      prisma.$transaction((tx) => ensureSeasonTradingAccountLink(tx, participantRow)),
    ]);
    for (const result of results) {
      assert.equal(
        result.status,
        'fulfilled',
        'concurrent repair must not fail: ' +
          (result.status === 'rejected' ? String(result.reason) : ''),
      );
      assert.equal(
        result.value.tradingAccountId,
        deriveSeasonTradingAccountId(legacy.id),
      );
    }

    // Exactly one account, linked to exactly this participant — no orphans.
    const accounts = await prisma.tradingAccount.findMany({
      where: { userId: user.id },
      include: { seasonParticipant: { select: { id: true } } },
    });
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].seasonParticipant.id, legacy.id);
  } finally {
    await cleanup(scope);
  }
}

async function testJoinRepairsNullLinkAndKeeps409() {
  const season = await createSeason('join-repair');
  const user = await createUser('join-repair');
  const scope = { userIds: [user.id], seasonIds: [season.id], participantIds: [] };

  try {
    const legacy = await createCanonicalParticipant(
      season.id,
      user.id,
      ParticipantStatus.active,
    );
    scope.participantIds.push(legacy.id);
    const before = await financialFingerprint(legacy.tradingAccountId);

    let joinError = null;
    try {
      await seasonsService.joinSeason(season.id, user.id);
    } catch (error) {
      joinError = error;
    }
    assert.ok(joinError instanceof HttpException, 'join must still conflict');
    assert.equal(joinError.getStatus(), 409);
    assert.equal(joinError.getResponse().error.code, 'SEASON_ALREADY_JOINED');

    // A normal duplicate join must preserve the existing canonical link.
    const repaired = await prisma.seasonParticipant.findUniqueOrThrow({
      where: { id: legacy.id },
      include: { tradingAccount: true },
    });
    assert.equal(
      repaired.tradingAccountId,
      deriveSeasonTradingAccountId(legacy.id),
    );
    assert.equal(repaired.tradingAccount.status, TradingAccountStatus.active);

    // No duplicate wallets, grants, snapshots, participants, or accounts.
    assert.equal(await financialFingerprint(legacy.tradingAccountId), before);
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

    // Replay keeps the plain 409 with no further writes.
    let replayError = null;
    try {
      await seasonsService.joinSeason(season.id, user.id);
    } catch (error) {
      replayError = error;
    }
    assert.equal(replayError.getStatus(), 409);
    assert.equal(
      await prisma.tradingAccount.count({ where: { userId: user.id } }),
      1,
    );
  } finally {
    await cleanup(scope);
  }
}

function createModerationService(prismaLike) {
  const auditService = new OperatorAuditService(prismaLike);
  return new OperatorSeasonModerationService(prismaLike, auditService);
}

async function testExclusionSuspendsAccount() {
  const season = await createSeason('exclude');
  const operator = await createUser('exclude-operator', 'operator');
  const user = await createUser('exclude');
  const scope = {
    userIds: [operator.id, user.id],
    seasonIds: [season.id],
    participantIds: [],
  };

  try {
    const join = await seasonsService.joinSeason(season.id, user.id);
    const participantId = join.data.seasonParticipantId;
    scope.participantIds.push(participantId);
    const service = createModerationService(prisma);

    const response = await service.excludeParticipant(
      { userId: operator.id, role: 'operator' },
      season.id,
      participantId,
      { reason: 'integration-test' },
    );
    assert.equal(response.data.status, ParticipantStatus.excluded);

    const participant = await prisma.seasonParticipant.findUniqueOrThrow({
      where: { id: participantId },
      include: { tradingAccount: true },
    });
    assert.equal(participant.participantStatus, ParticipantStatus.excluded);
    assert.equal(
      participant.tradingAccount.status,
      TradingAccountStatus.suspended,
    );

    // Audit metadata records the account status transition.
    const audit = await prisma.operatorAuditLog.findFirst({
      where: {
        actorUserId: operator.id,
        action: 'operator.season_participant.exclude',
        targetId: participantId,
      },
      orderBy: { createdAt: 'desc' },
    });
    assert.ok(audit, 'success audit row expected');
    assert.equal(audit.metadataJson.tradingAccountId, participant.tradingAccountId);
    assert.equal(audit.metadataJson.beforeTradingAccountStatus, 'active');
    assert.equal(audit.metadataJson.afterTradingAccountStatus, 'suspended');

    // Excluding again conflicts and leaves the account suspended (idempotent).
    let conflict = null;
    try {
      await service.excludeParticipant(
        { userId: operator.id, role: 'operator' },
        season.id,
        participantId,
        {},
      );
    } catch (error) {
      conflict = error;
    }
    assert.equal(conflict.getStatus(), 409);
    const after = await prisma.tradingAccount.findUniqueOrThrow({
      where: { id: participant.tradingAccountId },
    });
    assert.equal(after.status, TradingAccountStatus.suspended);
  } finally {
    await cleanup(scope);
  }
}

async function testExclusionRepairsNullLink() {
  const season = await createSeason('exclude-null');
  const operator = await createUser('exclude-null-operator', 'operator');
  const user = await createUser('exclude-null');
  const scope = {
    userIds: [operator.id, user.id],
    seasonIds: [season.id],
    participantIds: [],
  };

  try {
    const legacy = await createCanonicalParticipant(
      season.id,
      user.id,
      ParticipantStatus.active,
    );
    scope.participantIds.push(legacy.id);
    const before = await financialFingerprint(legacy.tradingAccountId);
    const service = createModerationService(prisma);

    await service.excludeParticipant(
      { userId: operator.id, role: 'operator' },
      season.id,
      legacy.id,
      { reason: 'integration-test-null-link' },
    );

    const participant = await prisma.seasonParticipant.findUniqueOrThrow({
      where: { id: legacy.id },
      include: { tradingAccount: true },
    });
    assert.equal(participant.participantStatus, ParticipantStatus.excluded);
    assert.equal(
      participant.tradingAccountId,
      deriveSeasonTradingAccountId(legacy.id),
    );
    assert.equal(
      participant.tradingAccount.status,
      TradingAccountStatus.suspended,
    );
    assert.equal(await financialFingerprint(legacy.tradingAccountId), before);
  } finally {
    await cleanup(scope);
  }
}

async function testExclusionRollsBackTogether(failingModel, failingMethod) {
  const season = await createSeason('exclude-rollback');
  const operator = await createUser('exclude-rollback-operator', 'operator');
  const user = await createUser('exclude-rollback');
  const scope = {
    userIds: [operator.id, user.id],
    seasonIds: [season.id],
    participantIds: [],
  };

  try {
    const join = await seasonsService.joinSeason(season.id, user.id);
    const participantId = join.data.seasonParticipantId;
    scope.participantIds.push(participantId);

    // Real transaction, real DB: the injected failure happens after earlier
    // writes in the exclusion transaction, so a passing test proves
    // PostgreSQL rolled the participant AND account changes back together.
    const failingPrisma = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop === '$transaction') {
          return (callback) =>
            prisma.$transaction((tx) =>
              callback(
                new Proxy(tx, {
                  get(txTarget, txProp, txReceiver) {
                    if (txProp === failingModel) {
                      const delegate = Reflect.get(txTarget, txProp, txReceiver);
                      return new Proxy(delegate, {
                        get(delegateTarget, methodProp, delegateReceiver) {
                          if (methodProp === failingMethod) {
                            return async () => {
                              throw new Error(
                                'injected ' +
                                  String(failingModel) +
                                  '.' +
                                  String(failingMethod) +
                                  ' failure',
                              );
                            };
                          }
                          return Reflect.get(
                            delegateTarget,
                            methodProp,
                            delegateReceiver,
                          );
                        },
                      });
                    }
                    return Reflect.get(txTarget, txProp, txReceiver);
                  },
                }),
              ),
            );
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const service = createModerationService(failingPrisma);

    let failure = null;
    try {
      await service.excludeParticipant(
        { userId: operator.id, role: 'operator' },
        season.id,
        participantId,
        {},
      );
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, 'injected failure must propagate');

    const participant = await prisma.seasonParticipant.findUniqueOrThrow({
      where: { id: participantId },
      include: { tradingAccount: true },
    });
    assert.equal(
      participant.participantStatus,
      ParticipantStatus.active,
      'participant exclusion must roll back',
    );
    assert.equal(
      participant.tradingAccount.status,
      TradingAccountStatus.active,
      'account suspension must roll back with the participant',
    );
  } finally {
    await cleanup(scope);
  }
}

async function testExclusionRollsBackOnLimitCancelFailure() {
  const season = await createSeason('exclude-limit-fail');
  const operator = await createUser('exclude-limit-fail-operator', 'operator');
  const user = await createUser('exclude-limit-fail');
  const scope = {
    userIds: [operator.id, user.id],
    seasonIds: [season.id],
    participantIds: [],
  };

  try {
    const join = await seasonsService.joinSeason(season.id, user.id);
    const participantId = join.data.seasonParticipantId;
    scope.participantIds.push(participantId);

    // The limit-order cleanup runs AFTER the participant update and the
    // account suspension in the same transaction; its failure must roll both
    // back on the real database.
    const failingCancelService = {
      cancelOpenLimitBuysForParticipantInTransaction: async () => {
        throw new Error('injected limit-order cancel failure');
      },
    };
    const auditService = new OperatorAuditService(prisma);
    const service = new OperatorSeasonModerationService(
      prisma,
      auditService,
      failingCancelService,
    );

    let failure = null;
    try {
      await service.excludeParticipant(
        { userId: operator.id, role: 'operator' },
        season.id,
        participantId,
        {},
      );
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, 'injected limit cancel failure must propagate');

    const participant = await prisma.seasonParticipant.findUniqueOrThrow({
      where: { id: participantId },
      include: { tradingAccount: true },
    });
    assert.equal(participant.participantStatus, ParticipantStatus.active);
    assert.equal(
      participant.tradingAccount.status,
      TradingAccountStatus.active,
      'account suspension must roll back when the limit-order cleanup fails',
    );
  } finally {
    await cleanup(scope);
  }
}

async function testClosedAccountNotReverted() {
  const season = await createSeason('exclude-closed', SeasonStatus.ended);
  const operator = await createUser('exclude-closed-operator', 'operator');
  const user = await createUser('exclude-closed');
  const scope = {
    userIds: [operator.id, user.id],
    seasonIds: [season.id],
    participantIds: [],
  };

  try {
    const legacy = await createCanonicalParticipant(
      season.id,
      user.id,
      ParticipantStatus.finished,
    );
    scope.participantIds.push(legacy.id);
    // The canonical fixture starts with the same finished → closed mapping.
    const participantRow = await prisma.seasonParticipant.findUniqueOrThrow({
      where: { id: legacy.id },
      select: {
        id: true,
        userId: true,
        joinedAt: true,
        participantStatus: true,
        initialCapitalKrw: true,
        tradingAccountId: true,
      },
    });
    await prisma.$transaction((tx) =>
      ensureSeasonTradingAccountLink(tx, participantRow),
    );
    const service = createModerationService(prisma);

    await service.excludeParticipant(
      { userId: operator.id, role: 'operator' },
      season.id,
      legacy.id,
      { reason: 'closed-account-check' },
    );

    const participant = await prisma.seasonParticipant.findUniqueOrThrow({
      where: { id: legacy.id },
      include: { tradingAccount: true },
    });
    assert.equal(participant.participantStatus, ParticipantStatus.excluded);
    assert.equal(
      participant.tradingAccount.status,
      TradingAccountStatus.closed,
      'a closed account must never be reverted to suspended',
    );
  } finally {
    await cleanup(scope);
  }
}

async function testOwnershipAccess() {
  const season = await createSeason('access');
  const owner = await createUser('access-owner');
  const other = await createUser('access-other');
  const scope = {
    userIds: [owner.id, other.id],
    seasonIds: [season.id],
    participantIds: [],
  };

  try {
    const join = await seasonsService.joinSeason(season.id, owner.id);
    scope.participantIds.push(join.data.seasonParticipantId);
    const ownerAccount = await prisma.tradingAccount.findFirstOrThrow({
      where: { userId: owner.id },
      select: { id: true },
    });

    // Owner sees exactly their own account with season info attached.
    const listed = await accessService.listOwnedAccounts(owner.id);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, ownerAccount.id);
    assert.equal(listed[0].seasonParticipant.season.id, season.id);

    // The other user's list never contains it.
    const otherListed = await accessService.listOwnedAccounts(other.id);
    assert.equal(
      otherListed.some((account) => account.id === ownerAccount.id),
      false,
    );

    // Foreign detail access is the same 404 as a nonexistent id.
    for (const accountId of [ownerAccount.id, randomUUID()]) {
      let notFound = null;
      try {
        await accessService.getOwnedAccountOrThrow(other.id, accountId);
      } catch (error) {
        notFound = error;
      }
      assert.ok(notFound instanceof HttpException);
      assert.equal(notFound.getStatus(), 404);
      assert.equal(
        notFound.getResponse().error.code,
        'TRADING_ACCOUNT_NOT_FOUND',
      );
    }

    // Suspended and closed accounts stay readable for the owner.
    for (const status of [TradingAccountStatus.suspended, TradingAccountStatus.closed]) {
      await prisma.tradingAccount.update({
        where: { id: ownerAccount.id },
        data: { status },
      });
      const detail = await accessService.getOwnedAccountOrThrow(
        owner.id,
        ownerAccount.id,
      );
      assert.equal(detail.status, status);
    }
  } finally {
    await cleanup(scope);
  }
}

async function testRepairScriptDryRunAndApply() {
  const season = await createSeason('script');
  const userA = await createUser('script-a');
  const userB = await createUser('script-b');
  const scope = {
    userIds: [userA.id, userB.id],
    seasonIds: [season.id],
    participantIds: [],
  };

  try {
    const legacyA = await createCanonicalParticipant(
      season.id,
      userA.id,
      ParticipantStatus.active,
    );
    const legacyB = await createCanonicalParticipant(
      season.id,
      userB.id,
      ParticipantStatus.excluded,
    );
    scope.participantIds.push(legacyA.id, legacyB.id);
    const beforeA = await financialFingerprint(legacyA.tradingAccountId);
    const beforeB = await financialFingerprint(legacyB.tradingAccountId);

    // A post-migration canonical database has no missing-link repair work.
    const dryRun = await repairMissingTradingAccountLinks(prisma, {
      apply: false,
    });
    const dryRunIds = dryRun.outcomes.map((o) => o.seasonParticipantId);
    assert.equal(dryRunIds.includes(legacyA.id), false);
    assert.equal(dryRunIds.includes(legacyB.id), false);
    assert.equal(
      await prisma.tradingAccount.count({
        where: { userId: { in: [userA.id, userB.id] } },
      }),
      2,
      'dry-run must leave the canonical accounts untouched',
    );

    // Apply is also a no-op; financial rows remain untouched.
    const applied = await repairMissingTradingAccountLinks(prisma, {
      apply: true,
    });
    const appliedIds = applied.outcomes.map((o) => o.seasonParticipantId);
    assert.equal(appliedIds.includes(legacyA.id), false);
    assert.equal(appliedIds.includes(legacyB.id), false);
    const repairedB = await prisma.seasonParticipant.findUniqueOrThrow({
      where: { id: legacyB.id },
      include: { tradingAccount: true },
    });
    assert.equal(
      repairedB.tradingAccount.status,
      TradingAccountStatus.suspended,
    );
    assert.equal(
      await financialFingerprint(legacyA.tradingAccountId),
      beforeA,
    );
    assert.equal(
      await financialFingerprint(legacyB.tradingAccountId),
      beforeB,
    );

    // Re-run: nothing left for these participants, no extra accounts.
    const rerun = await repairMissingTradingAccountLinks(prisma, {
      apply: true,
    });
    assert.equal(
      rerun.outcomes.some((o) => scope.participantIds.includes(o.seasonParticipantId)),
      false,
    );
    assert.equal(
      await prisma.tradingAccount.count({
        where: { userId: { in: [userA.id, userB.id] } },
      }),
      2,
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
    await runCase('deterministic id matches postgres md5 cast', testDeterministicIdMatchesPostgres);
    await runCase('canonical link validation + non-mutation + replay', testRepairMappingAndNonMutation);
    await runCase('concurrent canonical link validation: one account, no orphan', testConcurrentRepairRace);
    await runCase('duplicate join preserves canonical link and keeps 409', testJoinRepairsNullLinkAndKeeps409);
    await runCase('exclusion suspends linked account + audit', testExclusionSuspendsAccount);
    await runCase('exclusion preserves canonical link while suspending', testExclusionRepairsNullLink);
    await runCase('exclusion rollback on account update failure', () =>
      testExclusionRollsBackTogether('tradingAccount', 'update'));
    await runCase('exclusion rollback on participant update failure', () =>
      testExclusionRollsBackTogether('seasonParticipant', 'update'));
    await runCase('exclusion rollback on limit-order cancel failure', testExclusionRollsBackOnLimitCancelFailure);
    await runCase('closed account never reverted to suspended', testClosedAccountNotReverted);
    await runCase('ownership access: own list, foreign 404, suspended/closed readable', testOwnershipAccess);
    await runCase('repair script is a no-op on canonical rows', testRepairScriptDryRunAndApply);
    console.log('trading account link db integration ok');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
