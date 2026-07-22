import { spawnSync } from 'node:child_process';

const RUN_DB_INTEGRATION = process.env.ORDER_EXECUTE_DB_INTEGRATION === '1';
const itDbIntegration = RUN_DB_INTEGRATION ? it : it.skip;

describe('OrdersService.executeOrder DB integration', () => {
  itDbIntegration(
    'verifies order execute write path, rollback, concurrency, and read visibility against PostgreSQL',
    () => {
      const result = spawnSync('pnpm', ['tsx', '-e', ORDER_EXECUTE_DB_RUNNER], {
        cwd: process.cwd(),
        env: process.env,
        encoding: 'utf8',
        timeout: 120_000,
      });

      if (result.status !== 0) {
        throw new Error(
          [
            'Order execute DB integration runner failed.',
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
          ].join('\n'),
        );
      }

      expect(stripKnownPgAdapterDeprecationWarning(result.stderr)).toBe('');
      expect(result.stdout).toContain('order execute db integration ok');
    },
    130_000,
  );
});

function stripKnownPgAdapterDeprecationWarning(stderr: string): string {
  return stderr
    .split('\n')
    .filter(
      (line) =>
        !line.includes(
          'DeprecationWarning: Calling client.query() when the client is already executing a query',
        ) && !line.includes('Use `node --trace-deprecation ...`'),
    )
    .join('\n')
    .trim();
}

const ORDER_EXECUTE_DB_RUNNER = `
import 'dotenv/config';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import {
  AssetPriceSourceType,
  AssetType,
  CurrencyCode,
  FxRateSourceType,
  OrderSide,
  OrderStatus,
  OrderType,
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
import { OrdersService } from './src/orders/orders.service';
import { RecordsService } from './src/records/records.service';
import { WalletsService } from './src/wallets/wallets.service';
import { computeOrderQuoteRequestHash } from './src/providers/durable-quote.policy';

const TEST_PREFIX = 'order-execute-db-integration';
const ZERO_AMOUNT = '0.00000000';
const prisma = new PrismaService();
const service = new OrdersService(prisma);
const recordsService = new RecordsService(prisma);
const walletsService = new WalletsService(prisma);

async function main() {
  await prisma.$connect();

  try {
    await runCase('buy execution one transaction success', testBuyExecution);
    await runCase('sell execution one transaction success', testSellExecution);
    await runCase('concurrent buy overspend prevention', testConcurrentBuyOverspend);
    await runCase('concurrent sell oversell prevention', testConcurrentSellOversell);
    await runCase('same order concurrent execute one success only', testSameOrderConcurrentExecute);
    await runCase('cancel vs execute race one terminal state only', testCancelVsExecuteRace);
    await runCase('rollback failure injection', testRollbackFailureInjection);
    await runCase('executed order and wallet transaction read visibility', testReadVisibility);
    console.log('order execute db integration ok');
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

async function testBuyExecution() {
  const scenario = await createScenario('buy-success', {
    side: OrderSide.buy,
    walletBalance: '1000.00000000',
  });

  try {
    const response = await service.executeOrder(scenario.userId, scenario.orderId);

    assert.equal(response.success, true);
    assert.equal(response.data.execution.state, 'executed');
    assert.equal(response.data.execution.duplicate, false);
    assert.equal(response.data.execution.walletBalanceAfter, '799.80000000');
    assert.equal(response.data.order.status, OrderStatus.executed);
    assert.equal(response.data.order.executedPrice, '100.00000000');
    assert.equal(response.data.order.grossAmount, '200.00000000');
    assert.equal(response.data.order.feeAmount, '0.20000000');
    assert.equal(response.data.order.netAmount, '200.20000000');
    assert.equal(response.data.order.assetPriceSnapshotId, scenario.assetPriceSnapshotId);
    assert.equal(
      response.data.order.fxRateSnapshotId,
      scenario.fxRateSnapshotId,
    );

    const state = await readOrderMutationState(scenario);
    assert.equal(state.settlementWalletBalance, '799.80000000');
    assert.equal(state.positionQuantity, '2.00000000');
    assert.equal(state.positionAverageCost, '100.10000000');
    assert.equal(state.positionRealizedPnl, '0.00000000');
    assert.equal(state.orderStatus, OrderStatus.executed);
    assert.equal(state.ledgerCount, 1);
    assert.equal(state.equitySnapshotCount, 1);
    assert.equal(state.dailyPortfolioSnapshotCount, 0);
    assert.equal(state.seasonRankingCount, 0);

    const ledger = await readOnlyOrderLedger(scenario);
    assert.equal(ledger.direction, WalletTransactionDirection.debit);
    assert.equal(ledger.txType, WalletTransactionType.order_buy);
    assert.equal(ledger.referenceType, WalletTransactionReferenceType.order);
    assert.equal(ledger.referenceId, scenario.orderId);
    assert.equal(formatScale8(ledger.amount), '200.20000000');
    assert.equal(formatScale8(ledger.balanceAfter), '799.80000000');
  } finally {
    await cleanupScenario(scenario);
  }
}

async function testSellExecution() {
  const scenario = await createScenario('sell-success', {
    side: OrderSide.sell,
    walletBalance: '100.00000000',
    positionQuantity: '5.00000000',
    positionAverageCost: '80.00000000',
  });

  try {
    const response = await service.executeOrder(scenario.userId, scenario.orderId);

    assert.equal(response.data.execution.state, 'executed');
    assert.equal(response.data.execution.walletBalanceAfter, '299.80000000');
    assert.equal(response.data.order.status, OrderStatus.executed);
    assert.equal(response.data.order.netAmount, '199.80000000');

    const state = await readOrderMutationState(scenario);
    assert.equal(state.settlementWalletBalance, '299.80000000');
    assert.equal(state.positionQuantity, '3.00000000');
    assert.equal(state.positionAverageCost, '80.00000000');
    assert.equal(state.positionRealizedPnl, '39.80000000');
    assert.equal(state.ledgerCount, 1);

    const ledger = await readOnlyOrderLedger(scenario);
    assert.equal(ledger.direction, WalletTransactionDirection.credit);
    assert.equal(ledger.txType, WalletTransactionType.order_sell);
    assert.equal(formatScale8(ledger.amount), '199.80000000');
    assert.equal(formatScale8(ledger.balanceAfter), '299.80000000');
  } finally {
    await cleanupScenario(scenario);
  }
}

async function testConcurrentBuyOverspend() {
  const scenario = await createScenario('buy-overspend', {
    side: OrderSide.buy,
    walletBalance: '200.20000000',
  });

  try {
    const secondOrderId = await createSubmittedOrder(scenario, {
      side: OrderSide.buy,
    });
    const results = await Promise.allSettled([
      service.executeOrder(scenario.userId, scenario.orderId),
      service.executeOrder(scenario.userId, secondOrderId),
    ]);
    const successes = fulfilled(results);
    const failures = rejected(results);

    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    assert.ok(
      ['INSUFFICIENT_BALANCE', 'CONFLICT'].includes(
        getErrorCode(failures[0].reason),
      ),
    );

    const wallet = await prisma.cashWallet.findUniqueOrThrow({
      where: { id: scenario.settlementWalletId },
    });
    assert.equal(formatScale8(wallet.balanceAmount), '0.00000000');
    assert.equal(
      await prisma.order.count({
        where: {
          seasonParticipantId: scenario.participantId,
          status: OrderStatus.executed,
        },
      }),
      1,
    );
    assert.equal(await countOrderLedgerRows(scenario), 1);
    await expectExecutionSnapshotCount(scenario, 1);
  } finally {
    await cleanupScenario(scenario);
  }
}

async function testConcurrentSellOversell() {
  const scenario = await createScenario('sell-oversell', {
    side: OrderSide.sell,
    walletBalance: ZERO_AMOUNT,
    positionQuantity: '2.00000000',
    positionAverageCost: '80.00000000',
  });

  try {
    const secondOrderId = await createSubmittedOrder(scenario, {
      side: OrderSide.sell,
    });
    const results = await Promise.allSettled([
      service.executeOrder(scenario.userId, scenario.orderId),
      service.executeOrder(scenario.userId, secondOrderId),
    ]);
    const successes = fulfilled(results);
    const failures = rejected(results);

    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    assert.ok(
      ['INSUFFICIENT_QUANTITY', 'CONFLICT'].includes(
        getErrorCode(failures[0].reason),
      ),
    );

    const state = await readOrderMutationState(scenario);
    assert.equal(state.settlementWalletBalance, '199.80000000');
    assert.equal(state.positionQuantity, '0.00000000');
    assert.equal(state.ledgerCount, 1);
    await expectExecutionSnapshotCount(scenario, 1);
  } finally {
    await cleanupScenario(scenario);
  }
}

async function testSameOrderConcurrentExecute() {
  const scenario = await createScenario('same-order-race', {
    side: OrderSide.sell,
    walletBalance: ZERO_AMOUNT,
    quantity: '1.00000000',
    positionQuantity: '2.00000000',
    positionAverageCost: '80.00000000',
  });

  try {
    const results = await Promise.allSettled([
      service.executeOrder(scenario.userId, scenario.orderId),
      service.executeOrder(scenario.userId, scenario.orderId),
    ]);
    const successes = fulfilled(results);
    const failures = rejected(results);
    const executedResponses = successes.filter(
      (result) => result.value.data.execution.state === 'executed',
    );

    assert.equal(executedResponses.length, 1);
    assert.equal(successes.length + failures.length, 2);
    for (const failure of failures) {
      const code = getErrorCode(failure.reason);
      assert.ok(
        [
          'ORDER_EXECUTION_CONFLICT',
          'ORDER_NOT_EXECUTABLE',
          'QUOTE_NOT_ACTIVE',
        ].includes(code),
        'unexpected concurrent execute error: ' + code,
      );
    }

    const state = await readOrderMutationState(scenario);
    assert.equal(state.orderStatus, OrderStatus.executed);
    assert.equal(state.ledgerCount, 1);
    assert.equal(state.positionQuantity, '1.00000000');
    assert.equal(state.settlementWalletBalance, '99.90000000');
    await expectExecutionSnapshotCount(scenario, 1);
  } finally {
    await cleanupScenario(scenario);
  }
}

async function testCancelVsExecuteRace() {
  const scenario = await createScenario('cancel-execute-race', {
    side: OrderSide.sell,
    walletBalance: ZERO_AMOUNT,
    quantity: '1.00000000',
    positionQuantity: '2.00000000',
    positionAverageCost: '80.00000000',
  });

  try {
    const results = await Promise.allSettled([
      service.executeOrder(scenario.userId, scenario.orderId),
      service.cancelOrder(scenario.userId, scenario.orderId),
    ]);

    assert.equal(results.length, 2);
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: scenario.orderId },
    });
    assert.ok([OrderStatus.executed, OrderStatus.canceled].includes(order.status));

    const state = await readOrderMutationState(scenario);
    if (order.status === OrderStatus.executed) {
      assert.equal(state.ledgerCount, 1);
      assert.equal(state.positionQuantity, '1.00000000');
      assert.equal(state.settlementWalletBalance, '99.90000000');
    } else {
      assert.equal(state.ledgerCount, 0);
      assert.equal(state.positionQuantity, '2.00000000');
      assert.equal(state.settlementWalletBalance, '0.00000000');
    }
    await expectExecutionSnapshotCount(
      scenario,
      order.status === OrderStatus.executed ? 1 : 0,
    );
  } finally {
    await cleanupScenario(scenario);
  }
}

async function testRollbackFailureInjection() {
  const failureCases = [
    {
      label: 'failure after wallet debit rolls back',
      mode: 'after-wallet-debit',
      expectedCode: 'ORDER_EXECUTION_TRANSACTION_FAILED',
    },
    {
      label: 'failure after position mutation rolls back',
      mode: 'after-position-mutation',
      expectedCode: 'ORDER_EXECUTION_TRANSACTION_FAILED',
    },
    {
      label: 'failure after walletTransaction create rolls back',
      mode: 'after-wallet-transaction-create',
      expectedCode: 'ORDER_EXECUTION_TRANSACTION_FAILED',
    },
    {
      label: 'failure during order finalization rolls back',
      mode: 'order-finalization-conflict',
      expectedCode: 'ORDER_EXECUTION_CONFLICT',
    },
  ];

  for (const failureCase of failureCases) {
    const scenario = await createScenario('rollback-' + failureCase.mode, {
      side: OrderSide.buy,
      walletBalance: '1000.00000000',
    });

    try {
      const before = await readRollbackProofState(scenario);
      const injectedService = createDbFailureInjectionService(failureCase.mode);

      await expectExecuteError(
        injectedService.executeOrder(scenario.userId, scenario.orderId),
        failureCase.expectedCode,
      );

      const after = await readRollbackProofState(scenario);
      assert.deepEqual(after, before, failureCase.label);
    } finally {
      await cleanupScenario(scenario);
    }
  }
}

async function testReadVisibility() {
  const scenario = await createScenario('read-visibility', {
    side: OrderSide.buy,
    walletBalance: '1000.00000000',
  });

  try {
    await service.executeOrder(scenario.userId, scenario.orderId);

    const orders = await service.getOrders(scenario.userId, {
      status: OrderStatus.executed,
    });
    assert.equal(orders.data.orders.length, 1);
    assert.equal(orders.data.orders[0].orderId, scenario.orderId);
    assert.equal(orders.data.orders[0].status, OrderStatus.executed);

    const records = await recordsService.getRecords(scenario.userId, {
      type: 'wallets',
    });
    assert.equal(records.data.walletTransactions.records.length, 1);
    assert.equal(
      records.data.walletTransactions.records[0].transactionType,
      WalletTransactionType.order_buy,
    );
    assert.equal(records.data.walletTransactions.records[0].referenceId, scenario.orderId);

    const wallets = await walletsService.getWallets(scenario.userId);
    const settlementWallet = wallets.data.wallets.find(
      (wallet) => wallet.currencyCode === CurrencyCode.USD,
    );
    assert.ok(settlementWallet);
    assert.equal(settlementWallet.balanceAmount, '799.80000000');
  } finally {
    await cleanupScenario(scenario);
  }
}

async function createScenario(label, options = {}) {
  const suffix = String(Date.now()) + '-' + Math.random().toString(16).slice(2);
  const now = new Date();
  const side = options.side ?? OrderSide.buy;
  const quantity = options.quantity ?? '2.00000000';
  const price = options.price ?? '100.00000000';

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
      tradeFeeRate: options.tradeFeeRate ?? '0.001000',
      fxFeeRate: '0.001000',
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

  await prisma.cashWallet.create({
    data: {
      seasonParticipantId: participant.id,
      currencyCode: CurrencyCode.KRW,
      balanceAmount: ZERO_AMOUNT,
    },
    select: { id: true },
  });

  const usdWallet = await prisma.cashWallet.create({
    data: {
      seasonParticipantId: participant.id,
      currencyCode: CurrencyCode.USD,
      balanceAmount: options.walletBalance ?? '1000.00000000',
    },
    select: { id: true },
  });

  const asset = await prisma.asset.create({
    data: {
      symbol: 'T' + suffix.slice(-20),
      name: TEST_PREFIX + '-' + label,
      market: 'BINANCE',
      currencyCode: CurrencyCode.USD,
      priceCurrency: CurrencyCode.USD,
      settlementCurrency: CurrencyCode.USD,
      assetType: AssetType.crypto,
      isActive: true,
    },
    select: { id: true },
  });

  const assetPriceSnapshot = await prisma.assetPriceSnapshot.create({
    data: {
      assetId: asset.id,
      price,
      currencyCode: CurrencyCode.USD,
      sourceType: AssetPriceSourceType.provider_api,
      sourceName: 'binance_spot_ws_ticker',
      sourceTimestamp: new Date(Date.now() - 1_000),
      effectiveAt: new Date(Date.now() - 1_000),
      capturedAt: new Date(Date.now() - 1_000),
      note: TEST_PREFIX + ' fixture',
    },
    select: { id: true },
  });
  const fxRateSnapshot = await prisma.fxRateSnapshot.create({
    data: {
      baseCurrency: CurrencyCode.USD,
      quoteCurrency: CurrencyCode.KRW,
      rate: '1000.00000000',
      sourceType: FxRateSourceType.provider_api,
      sourceName: 'exchange_rate_api',
      sourceTimestamp: new Date(Date.now() - 1_000),
      effectiveAt: new Date(Date.now() - 1_000),
      capturedAt: new Date(Date.now() - 1_000),
      note: TEST_PREFIX + ' fixture',
    },
    select: { id: true },
  });

  if (options.positionQuantity) {
    await prisma.position.create({
      data: {
        seasonParticipantId: participant.id,
        assetId: asset.id,
        quantity: options.positionQuantity,
        averageCost: options.positionAverageCost ?? '80.00000000',
        currencyCode: CurrencyCode.USD,
        realizedPnl: ZERO_AMOUNT,
      },
    });
  }

  const orderId = await createSubmittedOrder(
    {
      participantId: participant.id,
      userId: user.id,
      assetId: asset.id,
      assetPriceSnapshotId: assetPriceSnapshot.id,
      fxRateSnapshotId: fxRateSnapshot.id,
    },
    { side, quantity, price },
  );

  return {
    userId: user.id,
    seasonId: season.id,
    participantId: participant.id,
    settlementWalletId: usdWallet.id,
    assetId: asset.id,
    assetPriceSnapshotId: assetPriceSnapshot.id,
    fxRateSnapshotId: fxRateSnapshot.id,
    orderId,
  };
}

async function createSubmittedOrder(scenario, overrides = {}) {
  const side = overrides.side ?? OrderSide.buy;
  const quantity = overrides.quantity ?? '2.00000000';
  const price = overrides.price ?? '100.00000000';
  const grossAmount = new Prisma.Decimal(quantity).mul(price).toFixed(8);
  const feeAmount = new Prisma.Decimal(grossAmount).mul('0.001000').toFixed(8);
  const netAmount =
    side === OrderSide.buy
      ? new Prisma.Decimal(grossAmount).add(feeAmount).toFixed(8)
      : new Prisma.Decimal(grossAmount).sub(feeAmount).toFixed(8);
  const quote = await prisma.quote.create({
    data: {
      userId: scenario.userId,
      seasonParticipantId: scenario.participantId,
      quoteType: QuoteType.order,
      status: QuoteStatus.active,
      assetId: scenario.assetId,
      side,
      orderType: OrderType.market,
      quantity,
      limitPrice: null,
      currencyCode: CurrencyCode.USD,
      quotedPrice: price,
      quotedRate: '1000.00000000',
      assetPriceSnapshotId: scenario.assetPriceSnapshotId,
      fxRateSnapshotId: scenario.fxRateSnapshotId,
      maxChangeBps: '10000.0000',
      expiresAt: new Date(Date.now() + 60_000),
      requestHash: computeOrderQuoteRequestHash({
        userId: scenario.userId,
        seasonParticipantId: scenario.participantId,
        assetId: scenario.assetId,
        side,
        orderType: OrderType.market,
        quantity,
        limitPrice: null,
        currencyCode: CurrencyCode.USD,
      }),
    },
    select: { id: true },
  });
  const order = await prisma.order.create({
    data: {
      seasonParticipantId: scenario.participantId,
      assetId: scenario.assetId,
      quoteId: quote.id,
      side,
      orderType: OrderType.market,
      status: OrderStatus.submitted,
      quantity,
      limitPrice: null,
      executedPrice: null,
      currencyCode: CurrencyCode.USD,
      grossAmount,
      feeAmount,
      netAmount,
      assetPriceSnapshotId: scenario.assetPriceSnapshotId,
      fxRateSnapshotId: scenario.fxRateSnapshotId,
      submittedAt: new Date(),
      executedAt: null,
      canceledAt: null,
      rejectedAt: null,
      rejectReason: null,
    },
    select: { id: true },
  });

  return order.id;
}

async function cleanupScenario(scenario) {
  await prisma.walletTransaction.deleteMany({
    where: { seasonParticipantId: scenario.participantId },
  });
  await prisma.order.deleteMany({
    where: { seasonParticipantId: scenario.participantId },
  });
  await prisma.quote.deleteMany({
    where: { seasonParticipantId: scenario.participantId },
  });
  await prisma.position.deleteMany({
    where: { seasonParticipantId: scenario.participantId },
  });
  await prisma.equitySnapshot.deleteMany({
    where: { seasonParticipantId: scenario.participantId },
  });
  await prisma.dailyPortfolioSnapshot.deleteMany({
    where: { seasonParticipantId: scenario.participantId },
  });
  await prisma.seasonRanking.deleteMany({
    where: { seasonParticipantId: scenario.participantId },
  });
  await prisma.cashWallet.deleteMany({
    where: { seasonParticipantId: scenario.participantId },
  });
  await prisma.assetPriceSnapshot.deleteMany({
    where: { assetId: scenario.assetId },
  });
  await prisma.fxRateSnapshot.deleteMany({
    where: { id: scenario.fxRateSnapshotId },
  });
  await prisma.asset.deleteMany({ where: { id: scenario.assetId } });
  await prisma.seasonParticipant.deleteMany({
    where: { id: scenario.participantId },
  });
  await prisma.season.deleteMany({ where: { id: scenario.seasonId } });
  await prisma.user.deleteMany({ where: { id: scenario.userId } });
}

async function readOrderMutationState(scenario) {
  const settlementWallet = await prisma.cashWallet.findUniqueOrThrow({
    where: { id: scenario.settlementWalletId },
  });
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: scenario.orderId },
  });
  const position = await prisma.position.findUnique({
    where: {
      seasonParticipantId_assetId: {
        seasonParticipantId: scenario.participantId,
        assetId: scenario.assetId,
      },
    },
  });

  return {
    settlementWalletBalance: formatScale8(settlementWallet.balanceAmount),
    positionQuantity: position ? formatScale8(position.quantity) : null,
    positionAverageCost: position ? formatScale8(position.averageCost) : null,
    positionRealizedPnl: position ? formatScale8(position.realizedPnl) : null,
    orderStatus: order.status,
    ledgerCount: await countOrderLedgerRows(scenario),
    equitySnapshotCount: await prisma.equitySnapshot.count({
      where: { seasonParticipantId: scenario.participantId },
    }),
    dailyPortfolioSnapshotCount: await prisma.dailyPortfolioSnapshot.count({
      where: { seasonParticipantId: scenario.participantId },
    }),
    seasonRankingCount: await prisma.seasonRanking.count({
      where: { seasonParticipantId: scenario.participantId },
    }),
  };
}

async function readRollbackProofState(scenario) {
  const state = await readOrderMutationState(scenario);
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: scenario.orderId },
  });

  return {
    ...state,
    orderExecutedAt: order.executedAt ? order.executedAt.toISOString() : null,
    orderGrossAmount: order.grossAmount ? formatScale8(order.grossAmount) : null,
    orderNetAmount: order.netAmount ? formatScale8(order.netAmount) : null,
  };
}

async function readOnlyOrderLedger(scenario) {
  const rows = await prisma.walletTransaction.findMany({
    where: {
      seasonParticipantId: scenario.participantId,
      referenceType: WalletTransactionReferenceType.order,
    },
  });
  assert.equal(rows.length, 1);
  return rows[0];
}

async function countOrderLedgerRows(scenario) {
  return prisma.walletTransaction.count({
    where: {
      seasonParticipantId: scenario.participantId,
      referenceType: WalletTransactionReferenceType.order,
    },
  });
}

async function expectExecutionSnapshotCount(scenario, expected) {
  assert.equal(
    await prisma.equitySnapshot.count({
      where: { seasonParticipantId: scenario.participantId },
    }),
    expected,
  );
  assert.equal(
    await prisma.dailyPortfolioSnapshot.count({
      where: { seasonParticipantId: scenario.participantId },
    }),
    0,
  );
  assert.equal(
    await prisma.seasonRanking.count({
      where: { seasonParticipantId: scenario.participantId },
    }),
    0,
  );
}

function createDbFailureInjectionService(mode) {
  const injectedPrisma = new Proxy(prisma, {
    get(target, property, receiver) {
      if (property === '$transaction') {
        const transaction = Reflect.get(target, property, receiver);

        return async (callback, ...rest) =>
          Reflect.apply(transaction, target, [
            async (tx) => callback(createDbFailureInjectionTransaction(tx, mode)),
            ...rest,
          ]);
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return new OrdersService(injectedPrisma);
}

function createDbFailureInjectionTransaction(tx, mode) {
  return new Proxy(tx, {
    get(target, property, receiver) {
      if (property === 'position') {
        return new Proxy(target.position, {
          get(model, method, modelReceiver) {
            const value = Reflect.get(model, method, modelReceiver);

            if (method === 'create' || method === 'updateMany') {
              return async (...args) => {
                if (mode === 'after-wallet-debit') {
                  throw new Error('injected failure after wallet debit');
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
                if (mode === 'after-position-mutation') {
                  throw new Error('injected failure after position mutation');
                }

                const result = await Reflect.apply(value, model, args);

                return result;
              };
            }

            return typeof value === 'function' ? value.bind(model) : value;
          },
        });
      }

      if (property === 'order') {
        return new Proxy(target.order, {
          get(model, method, modelReceiver) {
            const value = Reflect.get(model, method, modelReceiver);

            if (method === 'updateMany') {
              return async (...args) => {
                if (mode === 'after-wallet-transaction-create') {
                  throw new Error('injected failure after wallet transaction create');
                }

                if (mode === 'order-finalization-conflict') {
                  return { count: 0 };
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
