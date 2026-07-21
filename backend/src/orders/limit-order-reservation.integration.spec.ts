import { spawnSync } from 'node:child_process';

const RUN_DB_INTEGRATION =
  process.env.LIMIT_ORDER_RESERVATION_DB_INTEGRATION === '1';
const itDbIntegration = RUN_DB_INTEGRATION ? it : it.skip;

describe('Limit order cash reservation DB integration', () => {
  itDbIntegration(
    'verifies atomic reservation, CHECK constraints, rollback, single release, and reserved-cash protection against PostgreSQL',
    () => {
      const result = spawnSync(
        'pnpm',
        ['tsx', '-e', LIMIT_ORDER_RESERVATION_DB_RUNNER],
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
            'Limit order reservation DB integration runner failed.',
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
          ].join('\n'),
        );
      }

      expect(result.stderr).toBe('');
      expect(result.stdout).toContain(
        'limit order reservation db integration ok',
      );
    },
    130_000,
  );
});

const LIMIT_ORDER_RESERVATION_DB_RUNNER = `
import 'dotenv/config';
import assert from 'node:assert/strict';
import {
  CurrencyCode,
  OrderSide,
  OrderStatus,
  OrderType,
  ParticipantStatus,
  SeasonStatus,
} from './src/generated/prisma/client';
import { PrismaService } from './src/prisma/prisma.service';
import {
  debitAvailableCash,
  releaseReservedCash,
  reserveAvailableCash,
} from './src/wallets/cash-wallet-atomic';
import { LimitOrderCancelService } from './src/orders/limit-order-cancel.service';
import { OrderReservationService } from './src/orders/order-reservation.service';

const TEST_PREFIX = 'limit-order-reservation-db-integration';
const ZERO_AMOUNT = '0.00000000';
const prisma = new PrismaService();
const cancelService = new LimitOrderCancelService(
  prisma,
  new OrderReservationService(),
);

async function main() {
  await prisma.$connect();
  try {
    await runCase('concurrent reservation overspend prevention', testConcurrentReservationOverspend);
    await runCase('check constraints reject invalid reservation states', testCheckConstraints);
    await runCase('reservation rolls back with the enclosing transaction', testReservationRollback);
    await runCase('release applies at most once under the guard', testSingleRelease);
    await runCase('ordinary debit never touches reserved cash', testDebitRespectsReservation);
    await runCase('concurrent user cancels release exactly once', testConcurrentCancelSingleRelease);
    console.log('limit order reservation db integration ok');
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

async function createScenario(label, options = {}) {
  const suffix = String(Date.now()) + '-' + Math.random().toString(16).slice(2);
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

  const wallet = await prisma.cashWallet.create({
    data: {
      seasonParticipantId: participant.id,
      currencyCode: CurrencyCode.KRW,
      balanceAmount: options.balance ?? '1000.00000000',
      reservedAmount: options.reserved ?? ZERO_AMOUNT,
    },
    select: { id: true },
  });

  let assetId = null;
  if (options.withAsset) {
    const asset = await prisma.asset.create({
      data: {
        symbol: (TEST_PREFIX + '-' + suffix).slice(0, 32),
        name: TEST_PREFIX + '-' + label,
        market: 'KRX',
        assetType: 'domestic_stock',
        currencyCode: CurrencyCode.KRW,
        isActive: true,
      },
      select: { id: true },
    });
    assetId = asset.id;
  }

  return {
    userId: user.id,
    seasonId: season.id,
    participantId: participant.id,
    walletId: wallet.id,
    assetId,
  };
}

async function cleanupScenario(scenario) {
  await prisma.order.deleteMany({
    where: { seasonParticipantId: scenario.participantId },
  });
  await prisma.cashWallet.deleteMany({
    where: { seasonParticipantId: scenario.participantId },
  });
  await prisma.seasonParticipant.deleteMany({
    where: { id: scenario.participantId },
  });
  if (scenario.assetId) {
    await prisma.asset.deleteMany({ where: { id: scenario.assetId } });
  }
  await prisma.season.deleteMany({ where: { id: scenario.seasonId } });
  await prisma.user.deleteMany({ where: { id: scenario.userId } });
}

async function readWallet(scenario) {
  const wallet = await prisma.cashWallet.findUnique({
    where: { id: scenario.walletId },
    select: { balanceAmount: true, reservedAmount: true },
  });
  assert.ok(wallet);
  return {
    balance: wallet.balanceAmount.toFixed(8),
    reserved: wallet.reservedAmount.toFixed(8),
  };
}

function reservationInput(scenario, amount) {
  return {
    walletId: scenario.walletId,
    seasonParticipantId: scenario.participantId,
    currencyCode: CurrencyCode.KRW,
    amount,
  };
}

async function testConcurrentReservationOverspend() {
  const scenario = await createScenario('overspend', {
    balance: '1000.00000000',
  });
  try {
    // Two 600 reservations against 1000 available: exactly one may win.
    const results = await Promise.all([
      prisma.$transaction((tx) =>
        reserveAvailableCash(tx, reservationInput(scenario, '600.00000000')),
      ),
      prisma.$transaction((tx) =>
        reserveAvailableCash(tx, reservationInput(scenario, '600.00000000')),
      ),
    ]);

    assert.deepEqual([...results].sort(), [0, 1]);
    const wallet = await readWallet(scenario);
    assert.equal(wallet.reserved, '600.00000000');
    assert.equal(wallet.balance, '1000.00000000');
  } finally {
    await cleanupScenario(scenario);
  }
}

async function testCheckConstraints() {
  const scenario = await createScenario('check', { balance: '100.00000000' });
  try {
    await assert.rejects(
      prisma.$executeRawUnsafe(
        'UPDATE "cash_wallets" SET "reserved_amount" = -1 WHERE "id" = $1',
        scenario.walletId,
      ),
    );
    await assert.rejects(
      prisma.$executeRawUnsafe(
        'UPDATE "cash_wallets" SET "reserved_amount" = "balance_amount" + 1 WHERE "id" = $1',
        scenario.walletId,
      ),
    );
    const wallet = await readWallet(scenario);
    assert.equal(wallet.reserved, ZERO_AMOUNT);
  } finally {
    await cleanupScenario(scenario);
  }
}

async function testReservationRollback() {
  const scenario = await createScenario('rollback', {
    balance: '1000.00000000',
  });
  try {
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        const count = await reserveAvailableCash(
          tx,
          reservationInput(scenario, '100.00000000'),
        );
        assert.equal(count, 1);
        throw new Error('inject failure after reservation');
      }),
      /inject failure after reservation/,
    );
    const wallet = await readWallet(scenario);
    assert.equal(wallet.reserved, ZERO_AMOUNT);
    assert.equal(wallet.balance, '1000.00000000');
  } finally {
    await cleanupScenario(scenario);
  }
}

async function testSingleRelease() {
  const scenario = await createScenario('single-release', {
    balance: '1000.00000000',
    reserved: '300.00000000',
  });
  try {
    const results = await Promise.all([
      prisma.$transaction((tx) =>
        releaseReservedCash(tx, reservationInput(scenario, '300.00000000')),
      ),
      prisma.$transaction((tx) =>
        releaseReservedCash(tx, reservationInput(scenario, '300.00000000')),
      ),
    ]);

    assert.deepEqual([...results].sort(), [0, 1]);
    const wallet = await readWallet(scenario);
    assert.equal(wallet.reserved, ZERO_AMOUNT);
    assert.equal(wallet.balance, '1000.00000000');
  } finally {
    await cleanupScenario(scenario);
  }
}

async function testDebitRespectsReservation() {
  const scenario = await createScenario('debit-guard', {
    balance: '1000.00000000',
    reserved: '800.00000000',
  });
  try {
    // available = 200: a 300 debit must be rejected wholesale.
    const blocked = await prisma.$transaction((tx) =>
      debitAvailableCash(tx, reservationInput(scenario, '300.00000000')),
    );
    assert.equal(blocked, 0);
    let wallet = await readWallet(scenario);
    assert.equal(wallet.balance, '1000.00000000');
    assert.equal(wallet.reserved, '800.00000000');

    // A 200 debit fits the available balance and leaves the CHECK intact
    // (balance 800 >= reserved 800).
    const allowed = await prisma.$transaction((tx) =>
      debitAvailableCash(tx, reservationInput(scenario, '200.00000000')),
    );
    assert.equal(allowed, 1);
    wallet = await readWallet(scenario);
    assert.equal(wallet.balance, '800.00000000');
    assert.equal(wallet.reserved, '800.00000000');
  } finally {
    await cleanupScenario(scenario);
  }
}

async function testConcurrentCancelSingleRelease() {
  const scenario = await createScenario('cancel-race', {
    balance: '1000.00000000',
    reserved: '150.15000000',
    withAsset: true,
  });
  try {
    const order = await prisma.order.create({
      data: {
        seasonParticipantId: scenario.participantId,
        assetId: scenario.assetId,
        side: OrderSide.buy,
        orderType: OrderType.limit,
        status: OrderStatus.submitted,
        quantity: '3.000000',
        limitPrice: '50.00000000',
        currencyCode: CurrencyCode.KRW,
        grossAmount: '150.00000000',
        feeAmount: '0.15000000',
        netAmount: '150.15000000',
        reservedAmount: '150.15000000',
        reservationFeeRate: '0.001000',
        submittedAt: new Date(),
      },
      select: { id: true },
    });

    const canceledAt = new Date();
    const results = await Promise.allSettled([
      cancelService.cancelOwnedLimitBuyOrder({
        userId: scenario.userId,
        orderId: order.id,
        canceledAt,
      }),
      cancelService.cancelOwnedLimitBuyOrder({
        userId: scenario.userId,
        orderId: order.id,
        canceledAt,
      }),
    ]);

    const fulfilled = results.filter((entry) => entry.status === 'fulfilled');
    assert.equal(fulfilled.length, 2);
    const firstCancels = fulfilled.filter(
      (entry) => entry.value.data.execution.alreadyCanceled === false,
    );
    const replays = fulfilled.filter(
      (entry) => entry.value.data.execution.alreadyCanceled === true,
    );
    assert.equal(firstCancels.length, 1);
    assert.equal(replays.length, 1);

    const wallet = await readWallet(scenario);
    assert.equal(wallet.reserved, ZERO_AMOUNT);
    assert.equal(wallet.balance, '1000.00000000');

    const finalOrder = await prisma.order.findUnique({
      where: { id: order.id },
      select: {
        status: true,
        cancelReason: true,
        canceledAt: true,
        reservationReleasedAt: true,
      },
    });
    assert.equal(finalOrder.status, OrderStatus.canceled);
    assert.equal(finalOrder.cancelReason, 'user_canceled');
    assert.ok(finalOrder.canceledAt);
    assert.ok(finalOrder.reservationReleasedAt);
  } finally {
    await cleanupScenario(scenario);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
