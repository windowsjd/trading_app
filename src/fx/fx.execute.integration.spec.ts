import { spawnSync } from 'node:child_process';

const RUN_DB_INTEGRATION = process.env.FX_EXECUTE_DB_INTEGRATION === '1';
const itDbIntegration = RUN_DB_INTEGRATION ? it : it.skip;

describe('FxService.execute DB integration', () => {
  itDbIntegration(
    'verifies write path, replay, conflict, no-rate/stale-rate, and overspend safety against PostgreSQL',
    () => {
      const result = spawnSync('pnpm', ['tsx', '-e', FX_EXECUTE_DB_RUNNER], {
        cwd: process.cwd(),
        env: process.env,
        encoding: 'utf8',
        timeout: 120_000,
      });

      if (result.status !== 0) {
        throw new Error(
          [
            'FX execute DB integration runner failed.',
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
          ].join('\n'),
        );
      }

      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('fx execute db integration ok');
    },
    130_000,
  );
});

const FX_EXECUTE_DB_RUNNER = `
import 'dotenv/config';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import {
  CurrencyCode,
  FxExecuteRequestStatus,
  FxRateSourceType,
  ParticipantStatus,
  Prisma,
  SeasonStatus,
  WalletTransactionDirection,
  WalletTransactionReferenceType,
  WalletTransactionType,
} from './src/generated/prisma/client';
import { PrismaService } from './src/prisma/prisma.service';
import { FxService } from './src/fx/fx.service';

const TEST_PREFIX = 'fx-execute-db-integration';
const ZERO_AMOUNT = '0.00000000';
const prisma = new PrismaService();
const service = new FxService(prisma);

async function main() {
  await prisma.$connect();

  try {
    await runCase('success write path', testSuccessWritePath);
    await runCase('succeeded duplicate replay', testSucceededDuplicateReplay);
    await runCase('idempotency conflict', testIdempotencyConflict);
    await runCase('insufficient balance', testInsufficientBalance);
    await runCase('no eligible snapshot', testNoEligibleSnapshot);
    await runCase('stale snapshot', testStaleSnapshot);
    await runCase('concurrent overspend prevention', testConcurrentOverspend);
    console.log('fx execute db integration ok');
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

async function testSuccessWritePath() {
  const scenario = await createScenario('success');

  try {
    const response = await executeSuccess(
      scenario.userId,
      buildKrwToUsdBody('success-key'),
    );

    assert.equal(response.success, true);
    assert.deepEqual(
      {
        fromCurrency: response.data.fromCurrency,
        toCurrency: response.data.toCurrency,
        sourceAmount: response.data.sourceAmount,
        grossTargetAmount: response.data.grossTargetAmount,
        feeRate: response.data.feeRate,
        feeAmount: response.data.feeAmount,
        feeCurrency: response.data.feeCurrency,
        appliedRate: response.data.appliedRate,
        netTargetAmount: response.data.netTargetAmount,
        sourceWalletId: response.data.sourceWalletId,
        targetWalletId: response.data.targetWalletId,
        sourceWalletBalanceAfter: response.data.sourceWalletBalanceAfter,
        targetWalletBalanceAfter: response.data.targetWalletBalanceAfter,
        fxRateSnapshotId: response.data.fxRateSnapshotId,
      },
      {
        fromCurrency: CurrencyCode.KRW,
        toCurrency: CurrencyCode.USD,
        sourceAmount: '1000.00000000',
        grossTargetAmount: '1.00000000',
        feeRate: '0.001000',
        feeAmount: '0.00100000',
        feeCurrency: CurrencyCode.USD,
        appliedRate: '1000.00000000',
        netTargetAmount: '0.99900000',
        sourceWalletId: scenario.sourceWalletId,
        targetWalletId: scenario.targetWalletId,
        sourceWalletBalanceAfter: '1000.00000000',
        targetWalletBalanceAfter: '0.99900000',
        fxRateSnapshotId: scenario.snapshotId,
      },
    );

    const sourceWallet = await prisma.cashWallet.findUniqueOrThrow({
      where: { id: scenario.sourceWalletId },
    });
    const targetWallet = await prisma.cashWallet.findUniqueOrThrow({
      where: { id: scenario.targetWalletId },
    });
    assert.equal(formatScale8(sourceWallet.balanceAmount), '1000.00000000');
    assert.equal(formatScale8(targetWallet.balanceAmount), '0.99900000');

    const exchangeRows = await prisma.exchangeTransaction.findMany({
      where: { seasonParticipantId: scenario.participantId },
    });
    assert.equal(exchangeRows.length, 1);
    assert.equal(exchangeRows[0].id, response.data.exchangeId);
    assert.equal(exchangeRows[0].fxRateSnapshotId, scenario.snapshotId);
    assert.equal(
      formatScale8(exchangeRows[0].netTargetAmount),
      response.data.netTargetAmount,
    );

    const commandRows = await prisma.fxExecuteRequest.findMany({
      where: { userId: scenario.userId },
    });
    assert.equal(commandRows.length, 1);
    assert.equal(commandRows[0].status, FxExecuteRequestStatus.succeeded);
    assert.equal(commandRows[0].exchangeTransactionId, response.data.exchangeId);
    assert.deepEqual(commandRows[0].responsePayloadJson, response);

    const ledgerRows = await prisma.walletTransaction.findMany({
      where: { seasonParticipantId: scenario.participantId },
      orderBy: { createdAt: 'asc' },
    });
    assert.equal(ledgerRows.length, 2);

    const sourceLedger = ledgerRows.find(
      (row) => row.txType === WalletTransactionType.exchange_source,
    );
    const targetLedger = ledgerRows.find(
      (row) => row.txType === WalletTransactionType.exchange_target,
    );
    assert.ok(sourceLedger);
    assert.ok(targetLedger);
    assert.equal(sourceLedger.walletId, scenario.sourceWalletId);
    assert.equal(sourceLedger.direction, WalletTransactionDirection.debit);
    assert.equal(
      sourceLedger.referenceType,
      WalletTransactionReferenceType.exchange_transaction,
    );
    assert.equal(sourceLedger.referenceId, response.data.exchangeId);
    assert.equal(formatScale8(sourceLedger.amount), '1000.00000000');
    assert.equal(
      formatScale8(sourceLedger.balanceAfter),
      formatScale8(sourceWallet.balanceAmount),
    );
    assert.equal(targetLedger.walletId, scenario.targetWalletId);
    assert.equal(targetLedger.direction, WalletTransactionDirection.credit);
    assert.equal(
      targetLedger.referenceType,
      WalletTransactionReferenceType.exchange_transaction,
    );
    assert.equal(targetLedger.referenceId, response.data.exchangeId);
    assert.equal(
      formatScale8(targetLedger.amount),
      response.data.netTargetAmount,
    );
    assert.equal(
      formatScale8(targetLedger.balanceAfter),
      formatScale8(targetWallet.balanceAmount),
    );
    assert.equal(
      ledgerRows.some((row) => row.txType === WalletTransactionType.fee),
      false,
    );
    await expectNoEquitySnapshot(scenario);
  } finally {
    await cleanupScenario(scenario);
  }
}

async function testSucceededDuplicateReplay() {
  const scenario = await createScenario('replay');

  try {
    const body = buildKrwToUsdBody('replay-key');
    const firstResponse = await executeSuccess(scenario.userId, body);
    const before = await readMutationState(scenario);
    const secondResponse = await executeSuccess(scenario.userId, body);
    const after = await readMutationState(scenario);

    assert.deepEqual(secondResponse, firstResponse);
    assert.deepEqual(after, before);
    assert.equal(await countCommandsForUser(scenario.userId), 1);
  } finally {
    await cleanupScenario(scenario);
  }
}

async function testIdempotencyConflict() {
  const scenario = await createScenario('conflict');

  try {
    const firstBody = buildKrwToUsdBody('conflict-key');
    await executeSuccess(scenario.userId, firstBody);
    const before = await readMutationState(scenario);

    await expectExecuteError(
      service.execute(scenario.userId, {
        ...firstBody,
        sourceAmount: '1001.00000000',
      }),
      'IDEMPOTENCY_CONFLICT',
    );

    const after = await readMutationState(scenario);
    assert.deepEqual(after, before);
    assert.equal(await countCommandsForUser(scenario.userId), 1);
  } finally {
    await cleanupScenario(scenario);
  }
}

async function testInsufficientBalance() {
  const scenario = await createScenario('insufficient', {
    sourceBalance: '999.99999999',
  });

  try {
    const before = await readMutationState(scenario);

    await expectExecuteError(
      service.execute(scenario.userId, buildKrwToUsdBody('insufficient-key')),
      'INSUFFICIENT_BALANCE',
    );

    const after = await readMutationState(scenario);
    assert.deepEqual(after, before);
    assert.equal(await countCommandsForUser(scenario.userId), 0);
  } finally {
    await cleanupScenario(scenario);
  }
}

async function testNoEligibleSnapshot() {
  const scenario = await createScenario('no-rate', { snapshot: 'none' });

  try {
    const before = await readMutationState(scenario);

    await withoutEligibleAdminManualSnapshots(async () => {
      await expectExecuteError(
        service.execute(scenario.userId, buildKrwToUsdBody('no-rate-key')),
        'FX_RATE_UNAVAILABLE',
      );
    });

    const after = await readMutationState(scenario);
    assert.deepEqual(after, before);
    assert.equal(await countCommandsForUser(scenario.userId), 0);
  } finally {
    await cleanupScenario(scenario);
  }
}

async function testStaleSnapshot() {
  const scenario = await createScenario('stale-rate', { snapshot: 'stale' });

  try {
    const before = await readMutationState(scenario);

    await expectExecuteError(
      service.execute(scenario.userId, buildKrwToUsdBody('stale-rate-key')),
      'FX_RATE_STALE',
    );

    const after = await readMutationState(scenario);
    assert.deepEqual(after, before);
    assert.equal(await countCommandsForUser(scenario.userId), 0);
  } finally {
    await cleanupScenario(scenario);
  }
}

async function testConcurrentOverspend() {
  const scenario = await createScenario('concurrency', {
    sourceBalance: '1000.00000000',
  });

  try {
    const results = await Promise.allSettled([
      service.execute(scenario.userId, buildKrwToUsdBody('concurrency-key-a')),
      service.execute(scenario.userId, buildKrwToUsdBody('concurrency-key-b')),
    ]);
    const successes = results.filter((result) => result.status === 'fulfilled');
    const failures = results.filter((result) => result.status === 'rejected');

    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    assert.ok(
      ['INSUFFICIENT_BALANCE', 'CONCURRENT_WALLET_UPDATE'].includes(
        getErrorCode(failures[0].reason),
      ),
    );

    const state = await readMutationState(scenario);
    assert.equal(state.sourceBalance, '0.00000000');
    assert.equal(new Prisma.Decimal(state.sourceBalance).gte(0), true);
    assert.equal(state.targetBalance, '0.99900000');
    assert.equal(state.exchangeCount, 1);
    assert.equal(state.ledgerCount, 2);
    assert.equal(await countCommandsForUser(scenario.userId), 1);
    await expectNoEquitySnapshot(scenario);
  } finally {
    await cleanupScenario(scenario);
  }
}

async function createScenario(label, options = {}) {
  const suffix = String(Date.now()) + '-' + Math.random().toString(16).slice(2);
  const sourceCurrency = options.sourceCurrency ?? CurrencyCode.KRW;
  const targetCurrency = options.targetCurrency ?? CurrencyCode.USD;
  const now = new Date();

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
      status: SeasonStatus.active,
      startAt: new Date('2099-01-01T00:00:00.000Z'),
      endAt: new Date('2100-01-01T00:00:00.000Z'),
      initialCapitalKrw: '10000000.00000000',
      tradeFeeRate: '0.001000',
      fxFeeRate: options.fxFeeRate ?? '0.001000',
    },
    select: { id: true },
  });

  const participant = await prisma.seasonParticipant.create({
    data: {
      seasonId: season.id,
      userId: user.id,
      joinedAt: now,
      participantStatus: ParticipantStatus.active,
      initialCapitalKrw: '10000000.00000000',
      totalAssetKrw: '10000000.00000000',
      totalReturnRate: ZERO_AMOUNT,
      maxDrawdown: ZERO_AMOUNT,
    },
    select: { id: true },
  });

  const sourceWallet = await prisma.cashWallet.create({
    data: {
      seasonParticipantId: participant.id,
      currencyCode: sourceCurrency,
      balanceAmount: options.sourceBalance ?? '2000.00000000',
    },
    select: { id: true },
  });

  const targetWallet = await prisma.cashWallet.create({
    data: {
      seasonParticipantId: participant.id,
      currencyCode: targetCurrency,
      balanceAmount: options.targetBalance ?? ZERO_AMOUNT,
    },
    select: { id: true },
  });

  const snapshot =
    options.snapshot === 'none'
      ? null
      : await prisma.fxRateSnapshot.create({
          data: {
            baseCurrency: CurrencyCode.USD,
            quoteCurrency: CurrencyCode.KRW,
            sourceType: FxRateSourceType.admin_manual,
            sourceName: TEST_PREFIX,
            rate: options.rate ?? '1000.00000000',
            effectiveAt:
              options.snapshot === 'stale'
                ? new Date(Date.now() - 61_000)
                : new Date(Date.now() - 1_000),
            capturedAt:
              options.snapshot === 'stale'
                ? new Date(Date.now() - 61_000)
                : new Date(Date.now() - 1_000),
            approvedByUserId: user.id,
            note: TEST_PREFIX + ' fixture',
          },
          select: { id: true },
        });

  return {
    userId: user.id,
    seasonId: season.id,
    participantId: participant.id,
    sourceWalletId: sourceWallet.id,
    targetWalletId: targetWallet.id,
    snapshotId: snapshot?.id ?? null,
  };
}

async function cleanupScenario(scenario) {
  await prisma.fxExecuteRequest.deleteMany({
    where: { userId: scenario.userId },
  });
  await prisma.walletTransaction.deleteMany({
    where: { seasonParticipantId: scenario.participantId },
  });
  await prisma.exchangeTransaction.deleteMany({
    where: { seasonParticipantId: scenario.participantId },
  });
  await prisma.equitySnapshot.deleteMany({
    where: { seasonParticipantId: scenario.participantId },
  });
  await prisma.cashWallet.deleteMany({
    where: { seasonParticipantId: scenario.participantId },
  });
  await prisma.seasonParticipant.deleteMany({
    where: { id: scenario.participantId },
  });

  if (scenario.snapshotId) {
    await prisma.fxRateSnapshot.deleteMany({
      where: { id: scenario.snapshotId },
    });
  }

  await prisma.season.deleteMany({ where: { id: scenario.seasonId } });
  await prisma.user.deleteMany({ where: { id: scenario.userId } });
}

async function executeSuccess(userId, body) {
  const response = await service.execute(userId, body);
  assert.equal(response.success, true);
  return response;
}

function buildKrwToUsdBody(idempotencyKey) {
  return {
    fromCurrency: CurrencyCode.KRW,
    toCurrency: CurrencyCode.USD,
    sourceAmount: '1000.00000000',
    idempotencyKey,
  };
}

async function expectExecuteError(promise, code) {
  await assert.rejects(
    promise,
    (error) => error instanceof HttpException && getErrorCode(error) === code,
  );
}

function getErrorCode(error) {
  const response = error.getResponse();
  return response.error.code;
}

async function readMutationState(scenario) {
  const sourceWallet = await prisma.cashWallet.findUniqueOrThrow({
    where: { id: scenario.sourceWalletId },
  });
  const targetWallet = await prisma.cashWallet.findUniqueOrThrow({
    where: { id: scenario.targetWalletId },
  });
  const exchangeCount = await prisma.exchangeTransaction.count({
    where: { seasonParticipantId: scenario.participantId },
  });
  const ledgerCount = await prisma.walletTransaction.count({
    where: { seasonParticipantId: scenario.participantId },
  });

  return {
    sourceBalance: formatScale8(sourceWallet.balanceAmount),
    targetBalance: formatScale8(targetWallet.balanceAmount),
    exchangeCount,
    ledgerCount,
  };
}

async function countCommandsForUser(userId) {
  return prisma.fxExecuteRequest.count({ where: { userId } });
}

async function expectNoEquitySnapshot(scenario) {
  assert.equal(
    await prisma.equitySnapshot.count({
      where: { seasonParticipantId: scenario.participantId },
    }),
    0,
  );
}

async function withoutEligibleAdminManualSnapshots(fn) {
  const existingSnapshots = await prisma.fxRateSnapshot.findMany({
    where: {
      baseCurrency: CurrencyCode.USD,
      quoteCurrency: CurrencyCode.KRW,
      sourceType: FxRateSourceType.admin_manual,
      effectiveAt: {
        lte: new Date(),
      },
    },
    select: {
      id: true,
      effectiveAt: true,
    },
  });

  if (existingSnapshots.length === 0) {
    await fn();
    return;
  }

  await prisma.fxRateSnapshot.updateMany({
    where: {
      id: {
        in: existingSnapshots.map((snapshot) => snapshot.id),
      },
    },
    data: {
      effectiveAt: new Date(Date.now() + 60_000),
    },
  });

  try {
    await fn();
  } finally {
    await Promise.all(
      existingSnapshots.map((snapshot) =>
        prisma.fxRateSnapshot.update({
          where: {
            id: snapshot.id,
          },
          data: {
            effectiveAt: snapshot.effectiveAt,
          },
        }),
      ),
    );
  }
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
