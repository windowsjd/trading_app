import { spawnSync } from 'node:child_process';

const RUN_DB_INTEGRATION = process.env.FX_EXECUTE_DB_INTEGRATION === '1';
const itDbIntegration = RUN_DB_INTEGRATION ? it : it.skip;

describe('FxService.execute DB integration', () => {
  itDbIntegration(
    'verifies write path, rollback proof, replay, conflict, no-rate/stale-rate, and overspend safety against PostgreSQL',
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
  QuoteStatus,
  QuoteType,
  SeasonStatus,
  WalletTransactionDirection,
  WalletTransactionReferenceType,
  WalletTransactionType,
} from './src/generated/prisma/client';
import { PrismaService } from './src/prisma/prisma.service';
import { FxService } from './src/fx/fx.service';
import { computeFxQuoteRequestHash } from './src/providers/durable-quote.policy';

const TEST_PREFIX = 'fx-execute-db-integration';
const ZERO_AMOUNT = '0.00000000';
const prisma = new PrismaService();
const service = new FxService(prisma);

async function main() {
  await prisma.$connect();

  try {
    await runCase('success write path', testSuccessWritePath);
    await runCase('usd to krw success wallets field', testUsdToKrwSuccess);
    await runCase('succeeded duplicate replay', testSucceededDuplicateReplay);
    await runCase(
      'concurrent same idempotency key replay',
      testConcurrentSameIdempotencyKeyReplay,
    );
    await runCase('idempotency conflict', testIdempotencyConflict);
    await runCase('insufficient balance', testInsufficientBalance);
    await runCase('no eligible snapshot', testNoEligibleSnapshot);
    await runCase('stale snapshot', testStaleSnapshot);
    await runCase(
      'db transaction rollback failure injection',
      testDbTransactionRollbackFailureInjection,
    );
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
      await buildKrwToUsdBody(scenario, 'success-key'),
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
        wallets: response.data.wallets,
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
        wallets: {
          KRW: '1000.00000000',
          USD: '0.99900000',
        },
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
    await expectOneExchangeExecutedEquitySnapshot(scenario);
  } finally {
    await cleanupScenario(scenario);
  }
}

async function testUsdToKrwSuccess() {
  const scenario = await createScenario('usd-to-krw-success', {
    sourceCurrency: CurrencyCode.USD,
    targetCurrency: CurrencyCode.KRW,
    sourceBalance: '2.00000000',
    targetBalance: '1000.00000000',
  });

  try {
    const response = await executeSuccess(
      scenario.userId,
      await buildUsdToKrwBody(scenario, 'usd-to-krw-success-key'),
    );

    assert.deepEqual(response.data.wallets, {
      KRW: '1999.00000000',
      USD: '1.00000000',
    });
    assert.equal(response.data.sourceWalletBalanceAfter, '1.00000000');
    assert.equal(response.data.targetWalletBalanceAfter, '1999.00000000');
  } finally {
    await cleanupScenario(scenario);
  }
}

async function testSucceededDuplicateReplay() {
  const scenario = await createScenario('replay');

  try {
    const body = await buildKrwToUsdBody(scenario, 'replay-key');
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

async function testConcurrentSameIdempotencyKeyReplay() {
  const scenario = await createScenario('same-key-race');

  try {
    const body = await buildKrwToUsdBody(scenario, 'same-key-race-key');
    const results = await Promise.allSettled([
      service.execute(scenario.userId, body),
      service.execute(scenario.userId, body),
    ]);

    const failures = results.filter((result) => result.status === 'rejected');
    assert.equal(failures.length, 0);

    const responses = results.map((result) => result.value);
    assert.deepEqual(responses[1], responses[0]);
    assert.equal(responses[0].success, true);

    const state = await readMutationState(scenario);
    assert.equal(state.sourceBalance, '1000.00000000');
    assert.equal(state.targetBalance, '0.99900000');
    assert.equal(state.exchangeCount, 1);
    assert.equal(state.ledgerCount, 2);
    assert.equal(await countCommandsForUser(scenario.userId), 1);

    const commandRows = await prisma.fxExecuteRequest.findMany({
      where: { userId: scenario.userId },
    });
    assert.equal(commandRows.length, 1);
    assert.equal(commandRows[0].status, FxExecuteRequestStatus.succeeded);
    assert.deepEqual(commandRows[0].responsePayloadJson, responses[0]);
    await expectOneExchangeExecutedEquitySnapshot(scenario);
  } finally {
    await cleanupScenario(scenario);
  }
}

async function testIdempotencyConflict() {
  const scenario = await createScenario('conflict');

  try {
    const firstBody = await buildKrwToUsdBody(scenario, 'conflict-key');
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
      service.execute(
        scenario.userId,
        await buildKrwToUsdBody(scenario, 'insufficient-key'),
      ),
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

    await withoutEligibleProviderSnapshots(async (isolatedService) => {
      await expectExecuteError(
        isolatedService.execute(
          scenario.userId,
          await buildKrwToUsdBody(scenario, 'no-rate-key'),
        ),
        'PROVIDER_RATE_UNAVAILABLE',
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
      service.execute(
        scenario.userId,
        await buildKrwToUsdBody(scenario, 'stale-rate-key'),
      ),
      'PROVIDER_RATE_STALE',
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
    const firstBody = await buildKrwToUsdBody(scenario, 'concurrency-key-a');
    const secondBody = await buildKrwToUsdBody(scenario, 'concurrency-key-b');
    const results = await Promise.allSettled([
      service.execute(scenario.userId, firstBody),
      service.execute(scenario.userId, secondBody),
    ]);
    const successes = results.filter((result) => result.status === 'fulfilled');
    const failures = results.filter((result) => result.status === 'rejected');

    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    assert.ok(
      ['INSUFFICIENT_BALANCE', 'CONFLICT'].includes(
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
    await expectOneExchangeExecutedEquitySnapshot(scenario);
  } finally {
    await cleanupScenario(scenario);
  }
}

async function testDbTransactionRollbackFailureInjection() {
  const failureCases = [
    {
      label: 'source debit wallet missing after pending command',
      idempotencyKey: 'rollback-source-debit-wallet-missing-key',
      expectedCode: 'INSUFFICIENT_BALANCE',
      mode: 'source-debit-wallet-missing',
    },
    {
      label: 'target credit numeric overflow after source debit',
      idempotencyKey: 'rollback-target-credit-overflow-key',
      expectedCode: 'EXECUTE_TRANSACTION_FAILED',
      mode: null,
      options: {
        targetBalance: '9999999999999999.99999999',
      },
    },
    {
      label: 'exchange row snapshot FK failure after wallet updates',
      idempotencyKey: 'rollback-exchange-snapshot-fk-key',
      expectedCode: 'EXECUTE_TRANSACTION_FAILED',
      mode: 'exchange-snapshot-fk',
    },
    {
      label: 'source ledger wallet FK failure after exchange row',
      idempotencyKey: 'rollback-source-ledger-wallet-fk-key',
      expectedCode: 'EXECUTE_TRANSACTION_FAILED',
      mode: 'source-ledger-wallet-fk',
    },
    {
      label: 'target ledger wallet FK failure after source ledger',
      idempotencyKey: 'rollback-target-ledger-wallet-fk-key',
      expectedCode: 'EXECUTE_TRANSACTION_FAILED',
      mode: 'target-ledger-wallet-fk',
    },
    {
      label: 'finalization exchange FK failure after ledger rows',
      idempotencyKey: 'rollback-finalization-exchange-fk-key',
      expectedCode: 'EXECUTE_TRANSACTION_FAILED',
      mode: 'finalization-exchange-fk',
    },
    {
      label: 'response payload JSON storage check failure after ledger rows',
      idempotencyKey: 'rollback-response-payload-json-key',
      expectedCode: 'EXECUTE_TRANSACTION_FAILED',
      mode: 'response-payload-json-check',
    },
  ];

  for (const failureCase of failureCases) {
    const scenario = await createScenario(
      'rollback-' + failureCase.idempotencyKey,
      failureCase.options ?? {},
    );

    try {
      const body = await buildKrwToUsdBody(
        scenario,
        failureCase.idempotencyKey,
      );
      const before = await readRollbackProofState(scenario);
      const injectedService = failureCase.mode
        ? createDbFailureInjectionService(failureCase.mode, scenario)
        : service;

      await expectExecuteError(
        injectedService.execute(scenario.userId, body),
        failureCase.expectedCode,
      );

      const after = await readRollbackProofState(scenario);
      assert.deepEqual(
        after,
        before,
        failureCase.label + ' left partial writes',
      );
    } finally {
      await cleanupScenario(scenario);
    }
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
      startAt: new Date(now.getTime() - 60_000),
      endAt: new Date(now.getTime() + 86_400_000),
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
            sourceType: FxRateSourceType.provider_api,
            sourceName: 'exchange_rate_api',
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
  await prisma.quote.deleteMany({
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

async function buildKrwToUsdBody(scenario, idempotencyKey) {
  const quoteId = await createFxQuote(scenario, {
    fromCurrency: CurrencyCode.KRW,
    toCurrency: CurrencyCode.USD,
    sourceAmount: '1000.00000000',
  });

  return {
    fromCurrency: CurrencyCode.KRW,
    toCurrency: CurrencyCode.USD,
    sourceAmount: '1000.00000000',
    quoteId,
    idempotencyKey,
  };
}

async function buildUsdToKrwBody(scenario, idempotencyKey) {
  const quoteId = await createFxQuote(scenario, {
    fromCurrency: CurrencyCode.USD,
    toCurrency: CurrencyCode.KRW,
    sourceAmount: '1.00000000',
  });

  return {
    fromCurrency: CurrencyCode.USD,
    toCurrency: CurrencyCode.KRW,
    sourceAmount: '1.00000000',
    quoteId,
    idempotencyKey,
  };
}

async function createFxQuote(
  scenario,
  { fromCurrency, toCurrency, sourceAmount },
) {
  const requestHash = computeFxQuoteRequestHash({
    userId: scenario.userId,
    seasonParticipantId: scenario.participantId,
    fromCurrency,
    toCurrency,
    sourceAmount,
  });
  const quote = await prisma.quote.create({
    data: {
      userId: scenario.userId,
      seasonParticipantId: scenario.participantId,
      quoteType: QuoteType.fx,
      status: QuoteStatus.active,
      fromCurrency,
      toCurrency,
      sourceAmount,
      targetAmount:
        fromCurrency === CurrencyCode.KRW ? '0.99900000' : '999.00000000',
      quotedRate: '1000.00000000',
      fxRateSnapshotId: scenario.snapshotId,
      maxChangeBps: '30.0000',
      expiresAt: new Date(Date.now() + 15_000),
      requestHash,
    },
    select: { id: true },
  });

  return quote.id;
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

async function readRollbackProofState(scenario) {
  const mutationState = await readMutationState(scenario);
  const commandRows = await prisma.fxExecuteRequest.findMany({
    where: { userId: scenario.userId },
    select: {
      status: true,
      exchangeTransactionId: true,
      responsePayloadJson: true,
    },
  });
  const equitySnapshotCount = await prisma.equitySnapshot.count({
    where: { seasonParticipantId: scenario.participantId },
  });
  const quoteRows = await prisma.quote.findMany({
    where: { userId: scenario.userId },
    select: {
      status: true,
    },
  });
  const snapshotCount = scenario.snapshotId
    ? await prisma.fxRateSnapshot.count({ where: { id: scenario.snapshotId } })
    : 0;

  return {
    ...mutationState,
    commandCount: commandRows.length,
    succeededCommandCount: commandRows.filter(
      (row) => row.status === FxExecuteRequestStatus.succeeded,
    ).length,
    finalizedCommandCount: commandRows.filter(
      (row) => row.exchangeTransactionId !== null,
    ).length,
    responsePayloadJsonCount: commandRows.filter(
      (row) => row.responsePayloadJson !== null,
    ).length,
    equitySnapshotCount,
    quoteCount: quoteRows.length,
    activeQuoteCount: quoteRows.filter(
      (row) => row.status === QuoteStatus.active,
    ).length,
    consumedQuoteCount: quoteRows.filter(
      (row) => row.status === QuoteStatus.consumed,
    ).length,
    snapshotCount,
  };
}

async function countCommandsForUser(userId) {
  return prisma.fxExecuteRequest.count({ where: { userId } });
}

async function expectOneExchangeExecutedEquitySnapshot(scenario) {
  const snapshot = await prisma.equitySnapshot.findMany({
    where: { seasonParticipantId: scenario.participantId },
    select: { snapshotReason: true },
  });

  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].snapshotReason, 'exchange_executed');
}

async function withoutEligibleProviderSnapshots(fn) {
  const rollbackMessage = 'rollback snapshot isolation transaction';

  try {
    await prisma.$transaction(async (tx) => {
      const existingSnapshots = await tx.fxRateSnapshot.findMany({
        where: {
          baseCurrency: CurrencyCode.USD,
          quoteCurrency: CurrencyCode.KRW,
          sourceType: FxRateSourceType.provider_api,
          effectiveAt: {
            lte: new Date(),
          },
        },
        select: {
          id: true,
          effectiveAt: true,
          capturedAt: true,
          sourceName: true,
          note: true,
        },
      });

      if (existingSnapshots.length > 0) {
        const future = new Date(Date.now() + 3_600_000);
        const result = await tx.fxRateSnapshot.updateMany({
          where: {
            id: {
              in: existingSnapshots.map((snapshot) => snapshot.id),
            },
          },
          data: {
            effectiveAt: future,
            capturedAt: future,
          },
        });

        if (result.count !== existingSnapshots.length) {
          throw new Error(
            [
              'snapshot isolation failed to hide all eligible rows',
              'ids=' + existingSnapshots.map((snapshot) => snapshot.id).join(','),
              'updated=' + result.count,
              'expected=' + existingSnapshots.length,
            ].join(' '),
          );
        }
      }

      const isolatedService = new FxService(tx);
      await fn(isolatedService);

      throw new Error(rollbackMessage);
    });
  } catch (error) {
    if (error instanceof Error && error.message === rollbackMessage) {
      return;
    }

    throw error;
  }
}

function createDbFailureInjectionService(mode, scenario) {
  const injectedPrisma = new Proxy(prisma, {
    get(target, property, receiver) {
      if (property === '$transaction') {
        const transaction = Reflect.get(target, property, receiver);

        return async (callback, ...rest) =>
          Reflect.apply(transaction, target, [
            async (tx) =>
              callback(createDbFailureInjectionTransaction(tx, mode, scenario)),
            ...rest,
          ]);
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return new FxService(injectedPrisma);
}

function createDbFailureInjectionTransaction(tx, mode, scenario) {
  let walletTransactionCreateCount = 0;

  return new Proxy(tx, {
    get(target, property, receiver) {
      if (property === 'fxExecuteRequest') {
        return new Proxy(target.fxExecuteRequest, {
          get(model, method, modelReceiver) {
            const value = Reflect.get(model, method, modelReceiver);

            if (method === 'create') {
              return async (...args) => {
                const result = await Reflect.apply(value, model, args);

                if (mode === 'source-debit-wallet-missing') {
                  await tx.cashWallet.delete({
                    where: { id: scenario.sourceWalletId },
                  });
                }

                return result;
              };
            }

            if (method === 'update') {
              return async (...args) => {
                if (mode === 'finalization-exchange-fk') {
                  await tx.exchangeTransaction.delete({
                    where: { id: args[0].data.exchangeTransactionId },
                  });
                }

                if (
                  mode === 'response-payload-json-check' &&
                  args[0]?.data?.responsePayloadJson
                ) {
                  const commandId = String(args[0].where.id).replaceAll(
                    "'",
                    "''",
                  );
                  const constraintName =
                    'fx_exec_resp_payload_reject_' +
                    String(scenario.participantId)
                      .replace(/[^a-zA-Z0-9_]/g, '_')
                      .slice(0, 24);
                  const sqlQuote = String.fromCharCode(39);

                  await tx.$executeRawUnsafe(
                    'ALTER TABLE "fx_execute_requests" ' +
                      'ADD CONSTRAINT "' +
                      constraintName +
                      '" CHECK ("id" <> ' +
                      sqlQuote +
                      commandId +
                      sqlQuote +
                      ' OR "response_payload_json" IS NULL)',
                  );
                }

                return Reflect.apply(value, model, args);
              };
            }

            return typeof value === 'function' ? value.bind(model) : value;
          },
        });
      }

      if (property === 'exchangeTransaction') {
        return new Proxy(target.exchangeTransaction, {
          get(model, method, modelReceiver) {
            const value = Reflect.get(model, method, modelReceiver);

            if (method === 'create') {
              return async (...args) => {
                if (mode === 'exchange-snapshot-fk') {
                  await tx.fxRateSnapshot.delete({
                    where: { id: scenario.snapshotId },
                  });
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
                walletTransactionCreateCount += 1;

                if (
                  mode === 'source-ledger-wallet-fk' &&
                  walletTransactionCreateCount === 1
                ) {
                  await tx.cashWallet.delete({
                    where: { id: scenario.sourceWalletId },
                  });
                }

                if (
                  mode === 'target-ledger-wallet-fk' &&
                  walletTransactionCreateCount === 2
                ) {
                  await tx.cashWallet.delete({
                    where: { id: scenario.targetWalletId },
                  });
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

function formatScale8(value) {
  return value.toFixed(8);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
`;
