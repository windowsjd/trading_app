import { spawnSync } from 'node:child_process';

const RUN_DB_INTEGRATION = process.env.SEASON_JOIN_DB_INTEGRATION === '1';
const itDbIntegration = RUN_DB_INTEGRATION ? it : it.skip;

describe('SeasonsService.joinSeason DB integration', () => {
  itDbIntegration(
    'verifies season join atomicity, duplicate protection, inactive rejection, and rollback against PostgreSQL',
    () => {
      const result = spawnSync('pnpm', ['tsx', '-e', SEASON_JOIN_DB_RUNNER], {
        cwd: process.cwd(),
        env: process.env,
        encoding: 'utf8',
        timeout: 120_000,
      });

      if (result.status !== 0) {
        throw new Error(
          [
            'Season join DB integration runner failed.',
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
          ].join('\n'),
        );
      }

      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('season join db integration ok');
    },
    130_000,
  );
});

const SEASON_JOIN_DB_RUNNER = `
import 'dotenv/config';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import {
  CurrencyCode,
  ParticipantStatus,
  SeasonStatus,
  WalletTransactionDirection,
  WalletTransactionReferenceType,
  WalletTransactionType,
} from './src/generated/prisma/client';
import { PrismaService } from './src/prisma/prisma.service';
import { SeasonsService } from './src/seasons/seasons.service';

const TEST_PREFIX = 'season-join-db-integration';
const ZERO_AMOUNT = '0.00000000';
const prisma = new PrismaService();
const service = new SeasonsService(prisma);

async function main() {
  await prisma.$connect();

  try {
    await runCase('active join writes participant wallets and initial grant ledger', testActiveJoinWritePath);
    await runCase('duplicate join is conflict without duplicate side effects', testDuplicateJoinConflict);
    await runCase('concurrent duplicate join does not double wallet or ledger rows', testConcurrentDuplicateJoinRace);
    await runCase('inactive seasons reject join without partial writes', testInactiveSeasonRejection);
    await runCase('transaction failure injection rolls back participant wallet and ledger writes', testFailureInjectionRollback);
    console.log('season join db integration ok');
  } finally {
    await prisma.$disconnect();
  }
}

async function runCase(name, fn) {
  try {
    await fn();
    console.log('ok ' + name);
  } catch (error) {
    console.error('failed ' + name);
    throw error;
  }
}

async function testActiveJoinWritePath() {
  const scenario = await createScenario('active-success', {
    initialCapitalKrw: '1234567.89000000',
  });

  try {
    const response = await service.joinSeason(scenario.seasonId, scenario.userId);

    assert.equal(response.success, true);
    assert.equal(response.data.seasonId, scenario.seasonId);
    assert.ok(response.data.seasonParticipantId);
    assert.ok(response.data.joinedAt);
    assert.deepEqual(response.data.wallets, {
      KRW: scenario.initialCapitalKrw,
      USD: ZERO_AMOUNT,
    });

    const state = await readJoinState(scenario);
    assert.equal(state.participantCount, 1);
    assert.equal(state.participantId, response.data.seasonParticipantId);
    assert.equal(state.participantStatus, ParticipantStatus.active);
    assert.equal(state.initialCapitalKrw, scenario.initialCapitalKrw);
    assert.equal(state.totalAssetKrw, scenario.initialCapitalKrw);
    assert.equal(state.totalReturnRate, ZERO_AMOUNT);
    assert.equal(state.maxDrawdown, ZERO_AMOUNT);
    assert.equal(state.walletCount, 2);
    assert.equal(state.krwWalletCount, 1);
    assert.equal(state.usdWalletCount, 1);
    assert.equal(state.krwWalletBalance, scenario.initialCapitalKrw);
    assert.equal(state.usdWalletBalance, ZERO_AMOUNT);
    assert.equal(state.ledgerCount, 1);
    assert.equal(state.initialGrantLedgerCount, 1);
    assert.equal(state.initialGrantDirection, WalletTransactionDirection.credit);
    assert.equal(state.initialGrantReferenceType, WalletTransactionReferenceType.season_join);
    assert.equal(state.initialGrantReferenceId, state.participantId);
    assert.equal(state.initialGrantWalletId, state.krwWalletId);
    assert.equal(state.initialGrantAmount, scenario.initialCapitalKrw);
    assert.equal(state.initialGrantBalanceAfter, scenario.initialCapitalKrw);
  } finally {
    await cleanupScenario(scenario);
  }
}

async function testDuplicateJoinConflict() {
  const scenario = await createScenario('duplicate-conflict');

  try {
    await service.joinSeason(scenario.seasonId, scenario.userId);
    const before = await readJoinState(scenario);

    await expectJoinError(
      service.joinSeason(scenario.seasonId, scenario.userId),
      409,
      'SEASON_ALREADY_JOINED',
    );

    const after = await readJoinState(scenario);
    assert.deepEqual(after, before);
  } finally {
    await cleanupScenario(scenario);
  }
}

async function testConcurrentDuplicateJoinRace() {
  const scenario = await createScenario('duplicate-race');

  try {
    const results = await Promise.allSettled([
      service.joinSeason(scenario.seasonId, scenario.userId),
      service.joinSeason(scenario.seasonId, scenario.userId),
    ]);
    const successes = fulfilled(results);
    const failures = rejected(results);

    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    assert.equal(getErrorStatus(failures[0].reason), 409);
    assert.equal(getErrorCode(failures[0].reason), 'SEASON_ALREADY_JOINED');

    const state = await readJoinState(scenario);
    assert.equal(state.participantCount, 1);
    assert.equal(state.walletCount, 2);
    assert.equal(state.krwWalletCount, 1);
    assert.equal(state.usdWalletCount, 1);
    assert.equal(state.krwWalletBalance, scenario.initialCapitalKrw);
    assert.equal(state.usdWalletBalance, ZERO_AMOUNT);
    assert.equal(state.ledgerCount, 1);
    assert.equal(state.initialGrantLedgerCount, 1);
  } finally {
    await cleanupScenario(scenario);
  }
}

async function testInactiveSeasonRejection() {
  for (const status of [
    SeasonStatus.upcoming,
    SeasonStatus.ended,
    SeasonStatus.settled,
  ]) {
    const scenario = await createScenario('inactive-' + status, { status });

    try {
      const before = await readJoinState(scenario);
      await expectJoinError(
        service.joinSeason(scenario.seasonId, scenario.userId),
        409,
        'SEASON_NOT_ACTIVE',
      );
      const after = await readJoinState(scenario);
      assert.deepEqual(after, before);
    } finally {
      await cleanupScenario(scenario);
    }
  }
}

async function testFailureInjectionRollback() {
  const failureCases = [
    {
      label: 'participant create followed by KRW wallet failure',
      mode: 'krw-wallet-create-fails',
    },
    {
      label: 'KRW wallet create followed by USD wallet failure',
      mode: 'usd-wallet-create-fails',
    },
    {
      label: 'wallet creates followed by initial grant ledger failure',
      mode: 'ledger-create-fails',
    },
  ];

  for (const failureCase of failureCases) {
    const scenario = await createScenario('rollback-' + failureCase.mode);

    try {
      const before = await readJoinState(scenario);
      const injectedService = createJoinFailureInjectionService(failureCase.mode);

      await assert.rejects(
        injectedService.joinSeason(scenario.seasonId, scenario.userId),
        (error) =>
          error instanceof Error &&
          error.message === 'injected ' + failureCase.mode,
      );

      const after = await readJoinState(scenario);
      assert.deepEqual(after, before, failureCase.label + ' left partial writes');
    } finally {
      await cleanupScenario(scenario);
    }
  }
}

async function createScenario(label, options = {}) {
  const suffix = String(Date.now()) + '-' + Math.random().toString(16).slice(2);
  const initialCapitalKrw = options.initialCapitalKrw ?? '10000000.00000000';

  const user = await prisma.user.create({
    data: {
      email: TEST_PREFIX + '-' + label + '-' + suffix + '@example.com',
      passwordHash: 'integration-test-only',
      nickname: TEST_PREFIX + '-' + label + '-' + suffix,
    },
    select: { id: true },
  });

  const season = await prisma.season.create({
    data: {
      name: TEST_PREFIX + '-' + label + '-' + suffix,
      status: options.status ?? SeasonStatus.active,
      startAt: new Date('2099-01-01T00:00:00.000Z'),
      endAt: new Date('2100-01-01T00:00:00.000Z'),
      initialCapitalKrw,
      tradeFeeRate: '0.001000',
      fxFeeRate: '0.001000',
    },
    select: { id: true },
  });

  return {
    userId: user.id,
    seasonId: season.id,
    initialCapitalKrw,
  };
}

async function readJoinState(scenario) {
  const participants = await prisma.seasonParticipant.findMany({
    where: {
      seasonId: scenario.seasonId,
      userId: scenario.userId,
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      participantStatus: true,
      initialCapitalKrw: true,
      totalAssetKrw: true,
      totalReturnRate: true,
      maxDrawdown: true,
    },
  });
  const participantIds = participants.map((participant) => participant.id);
  const wallets =
    participantIds.length === 0
      ? []
      : await prisma.cashWallet.findMany({
          where: {
            seasonParticipantId: {
              in: participantIds,
            },
          },
          orderBy: [{ currencyCode: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            currencyCode: true,
            balanceAmount: true,
          },
        });
  const ledgers =
    participantIds.length === 0
      ? []
      : await prisma.walletTransaction.findMany({
          where: {
            seasonParticipantId: {
              in: participantIds,
            },
          },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            walletId: true,
            direction: true,
            txType: true,
            referenceType: true,
            referenceId: true,
            amount: true,
            balanceAfter: true,
          },
        });
  const participant = participants[0] ?? null;
  const krwWallets = wallets.filter(
    (wallet) => wallet.currencyCode === CurrencyCode.KRW,
  );
  const usdWallets = wallets.filter(
    (wallet) => wallet.currencyCode === CurrencyCode.USD,
  );
  const initialGrantLedgers = ledgers.filter(
    (ledger) => ledger.txType === WalletTransactionType.initial_grant,
  );
  const initialGrantLedger = initialGrantLedgers[0] ?? null;

  return {
    participantCount: participants.length,
    participantId: participant?.id ?? null,
    participantStatus: participant?.participantStatus ?? null,
    initialCapitalKrw: participant
      ? formatScale8(participant.initialCapitalKrw)
      : null,
    totalAssetKrw: participant ? formatScale8(participant.totalAssetKrw) : null,
    totalReturnRate: participant
      ? formatScale8(participant.totalReturnRate)
      : null,
    maxDrawdown: participant ? formatScale8(participant.maxDrawdown) : null,
    walletCount: wallets.length,
    krwWalletCount: krwWallets.length,
    usdWalletCount: usdWallets.length,
    krwWalletId: krwWallets[0]?.id ?? null,
    krwWalletBalance: krwWallets[0]
      ? formatScale8(krwWallets[0].balanceAmount)
      : null,
    usdWalletBalance: usdWallets[0]
      ? formatScale8(usdWallets[0].balanceAmount)
      : null,
    ledgerCount: ledgers.length,
    initialGrantLedgerCount: initialGrantLedgers.length,
    initialGrantWalletId: initialGrantLedger?.walletId ?? null,
    initialGrantDirection: initialGrantLedger?.direction ?? null,
    initialGrantReferenceType: initialGrantLedger?.referenceType ?? null,
    initialGrantReferenceId: initialGrantLedger?.referenceId ?? null,
    initialGrantAmount: initialGrantLedger
      ? formatScale8(initialGrantLedger.amount)
      : null,
    initialGrantBalanceAfter: initialGrantLedger
      ? formatScale8(initialGrantLedger.balanceAfter)
      : null,
  };
}

async function cleanupScenario(scenario) {
  const participants = await prisma.seasonParticipant.findMany({
    where: {
      seasonId: scenario.seasonId,
      userId: scenario.userId,
    },
    select: { id: true },
  });
  const participantIds = participants.map((participant) => participant.id);

  if (participantIds.length > 0) {
    await prisma.fxExecuteRequest.deleteMany({
      where: { seasonParticipantId: { in: participantIds } },
    });
    await prisma.walletTransaction.deleteMany({
      where: { seasonParticipantId: { in: participantIds } },
    });
    await prisma.exchangeTransaction.deleteMany({
      where: { seasonParticipantId: { in: participantIds } },
    });
    await prisma.equitySnapshot.deleteMany({
      where: { seasonParticipantId: { in: participantIds } },
    });
    await prisma.order.deleteMany({
      where: { seasonParticipantId: { in: participantIds } },
    });
    await prisma.position.deleteMany({
      where: { seasonParticipantId: { in: participantIds } },
    });
    await prisma.dailyPortfolioSnapshot.deleteMany({
      where: { seasonParticipantId: { in: participantIds } },
    });
    await prisma.seasonRanking.deleteMany({
      where: { seasonParticipantId: { in: participantIds } },
    });
    await prisma.cashWallet.deleteMany({
      where: { seasonParticipantId: { in: participantIds } },
    });
    await prisma.seasonParticipant.deleteMany({
      where: { id: { in: participantIds } },
    });
  }

  await prisma.seasonRanking.deleteMany({
    where: { seasonId: scenario.seasonId },
  });
  await prisma.season.deleteMany({ where: { id: scenario.seasonId } });
  await prisma.user.deleteMany({ where: { id: scenario.userId } });
}

function createJoinFailureInjectionService(mode) {
  const injectedPrisma = new Proxy(prisma, {
    get(target, property, receiver) {
      if (property === '$transaction') {
        const transaction = Reflect.get(target, property, receiver);

        return async (callback, ...rest) =>
          Reflect.apply(transaction, target, [
            async (tx) =>
              callback(createJoinFailureInjectionTransaction(tx, mode)),
            ...rest,
          ]);
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return new SeasonsService(injectedPrisma);
}

function createJoinFailureInjectionTransaction(tx, mode) {
  let cashWalletCreateCalls = 0;

  return new Proxy(tx, {
    get(target, property, receiver) {
      if (property === 'cashWallet') {
        return new Proxy(target.cashWallet, {
          get(model, method, modelReceiver) {
            const value = Reflect.get(model, method, modelReceiver);

            if (method === 'create') {
              return async (...args) => {
                cashWalletCreateCalls += 1;

                if (
                  mode === 'krw-wallet-create-fails' &&
                  cashWalletCreateCalls === 1
                ) {
                  throw new Error('injected ' + mode);
                }

                if (
                  mode === 'usd-wallet-create-fails' &&
                  cashWalletCreateCalls === 2
                ) {
                  throw new Error('injected ' + mode);
                }

                return Reflect.apply(value, model, args);
              };
            }

            return typeof value === 'function' ? value.bind(model) : value;
          },
        });
      }

      if (property === 'walletTransaction') {
        return new Proxy(target.walletTransaction, {
          get(model, method, modelReceiver) {
            const value = Reflect.get(model, method, modelReceiver);

            if (method === 'create') {
              return async (...args) => {
                if (mode === 'ledger-create-fails') {
                  throw new Error('injected ' + mode);
                }

                return Reflect.apply(value, model, args);
              };
            }

            return typeof value === 'function' ? value.bind(model) : value;
          },
        });
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function expectJoinError(promise, status, code) {
  await assert.rejects(
    promise,
    (error) =>
      error instanceof HttpException &&
      getErrorStatus(error) === status &&
      getErrorCode(error) === code,
  );
}

function getErrorStatus(error) {
  return error.getStatus();
}

function getErrorCode(error) {
  const response = error.getResponse();
  return response.error.code;
}

function fulfilled(results) {
  return results.filter((result) => result.status === 'fulfilled');
}

function rejected(results) {
  return results.filter((result) => result.status === 'rejected');
}

function formatScale8(value) {
  return value.toFixed(8);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
`;
