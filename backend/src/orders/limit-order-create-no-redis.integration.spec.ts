import { spawnSync } from 'node:child_process';

const RUN_DB_INTEGRATION =
  process.env.LIMIT_ORDER_RESERVATION_DB_INTEGRATION === '1';
const itDbIntegration = RUN_DB_INTEGRATION ? it : it.skip;

/**
 * Limit-order registration completes against PostgreSQL alone. This spec
 * proves it operationally: the runner is started with REDIS_URL pointing at a
 * port nothing listens on (Redis hard down), and quote → create → cancel must
 * all succeed anyway. No mock stands in for Redis — the connection target is
 * genuinely unreachable.
 */
describe('Limit order registration without Redis DB integration', () => {
  itDbIntegration(
    'quote, create, and cancel succeed while Redis is unreachable',
    () => {
      const result = spawnSync(
        'pnpm',
        ['tsx', '-e', LIMIT_ORDER_NO_REDIS_RUNNER],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            LIMIT_ORDER_ENABLED: 'true',
            // A closed port on localhost: connection attempts fail fast.
            REDIS_URL: 'redis://127.0.0.1:6399',
          },
          encoding: 'utf8',
          timeout: 180_000,
        },
      );

      if (result.status !== 0) {
        throw new Error(
          [
            'Limit order no-Redis DB integration runner failed.',
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
          ].join('\n'),
        );
      }
      for (const name of [
        'limit quote succeeds without Redis',
        'limit create succeeds without Redis',
        'limit cancel succeeds without Redis',
      ]) {
        expect(result.stdout).toContain(`ok ${name}`);
      }
      expect(result.stdout).toContain(
        'limit order no-redis db integration ok',
      );
    },
    190_000,
  );
});

const LIMIT_ORDER_NO_REDIS_RUNNER = `
import 'dotenv/config';
// dotenv never overrides variables the parent already set, so the dead
// REDIS_URL from the spec survives a .env file that configures a real one.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  AssetType,
  CurrencyCode,
  OrderStatus,
  ParticipantStatus,
  SeasonStatus,
} from './src/generated/prisma/client';
import { PrismaService } from './src/prisma/prisma.service';
import { OrdersService } from './src/orders/orders.service';
import { LimitOrderCreateService } from './src/orders/limit-order-create.service';
import { LimitOrderCancelService } from './src/orders/limit-order-cancel.service';
import { OrderReservationService } from './src/orders/order-reservation.service';

assert.equal(
  process.env.REDIS_URL,
  'redis://127.0.0.1:6399',
  'the runner must be pointed at an unreachable Redis',
);

const prisma = new PrismaService();
const reservation = new OrderReservationService();
const createService = new LimitOrderCreateService(prisma, reservation);
const cancelService = new LimitOrderCancelService(prisma, reservation);
const orders = new OrdersService(prisma, undefined, createService, cancelService);

const PREFIX = 'limit-order-no-redis-' + process.pid + '-' + Date.now();
const ZERO = '0.00000000';
const LIMIT_PRICE = '100000.00000000';
const QUANTITY = '2.000000';
// 2 x 100000 = 200000 gross, 0.1% fee = 200, reserved 200200.
const EXPECTED_RESERVED = '200200.00000000';
const FEE_RATE = '0.001000';

const created = { users: [], seasons: [], participants: [], assets: [] };

async function main() {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must be configured.');
  await prisma.$connect();
  try {
    const scenario = await createScenario();

    const quoteResponse = await orders.quoteOrder(scenario.userId, {
      assetId: scenario.assetId,
      side: 'buy',
      orderType: 'limit',
      quantity: QUANTITY,
      limitPrice: LIMIT_PRICE,
    });
    const quoteId = quoteResponse.data.quoteId;
    assert.ok(quoteId, 'the limit quote must return a durable quote id');
    assert.equal(
      quoteResponse.data.quotedReservedAmount,
      EXPECTED_RESERVED,
      'the quote must pin the reservation basis',
    );
    console.log('ok limit quote succeeds without Redis');

    const createResponse = await orders.createOrder(scenario.userId, {
      quoteId,
      assetId: scenario.assetId,
      side: 'buy',
      orderType: 'limit',
      quantity: QUANTITY,
      limitPrice: LIMIT_PRICE,
      idempotencyKey: PREFIX + '-create',
    });
    const orderId = createResponse.data.order.orderId;
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { status: true, reservedAmount: true },
    });
    assert.equal(order.status, OrderStatus.submitted);
    assert.equal(order.reservedAmount.toFixed(8), EXPECTED_RESERVED);
    const wallet = await prisma.cashWallet.findUniqueOrThrow({
      where: { id: scenario.walletId },
      select: { reservedAmount: true, balanceAmount: true },
    });
    assert.equal(wallet.reservedAmount.toFixed(8), EXPECTED_RESERVED);
    assert.equal(
      wallet.balanceAmount.toFixed(8),
      '1000000.00000000',
      'a submitted limit order never moves balanceAmount',
    );
    console.log('ok limit create succeeds without Redis');

    await orders.cancelOrder(scenario.userId, orderId);
    const canceled = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { status: true, reservationReleasedAt: true },
    });
    assert.equal(canceled.status, OrderStatus.canceled);
    assert.ok(canceled.reservationReleasedAt);
    const walletAfter = await prisma.cashWallet.findUniqueOrThrow({
      where: { id: scenario.walletId },
      select: { reservedAmount: true },
    });
    assert.equal(walletAfter.reservedAmount.toFixed(8), ZERO);
    console.log('ok limit cancel succeeds without Redis');

    console.log('limit order no-redis db integration ok');
  } finally {
    await cleanup().catch((error) => console.error('cleanup failed', error));
    await prisma.$disconnect();
  }
}

async function createScenario() {
  const now = new Date();
  const user = await prisma.user.create({
    data: {
      email: PREFIX + '@example.com',
      passwordHash: 'integration-test-only',
      nickname: ('nr-' + randomUUID()).slice(0, 40),
    },
    select: { id: true },
  });
  created.users.push(user.id);

  const season = await prisma.season.create({
    data: {
      name: PREFIX,
      status: SeasonStatus.active,
      startAt: new Date(now.getTime() - 1_000),
      endAt: new Date(now.getTime() + 86_400_000),
      initialCapitalKrw: '10000000.00000000',
      tradeFeeRate: FEE_RATE,
      fxFeeRate: FEE_RATE,
    },
    select: { id: true },
  });
  created.seasons.push(season.id);

  const tradingAccount = await prisma.tradingAccount.create({
    data: {
      userId: user.id,
      mode: 'season',
      initialCapitalKrw: '10000000.00000000',
      openedAt: now,
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
      totalReturnRate: ZERO,
      maxDrawdown: ZERO,
      tradingAccountId: tradingAccount.id,
    },
    select: { id: true },
  });
  created.participants.push(participant.id);

  const wallet = await prisma.cashWallet.create({
    data: {
      seasonParticipantId: participant.id,
      currencyCode: CurrencyCode.KRW,
      balanceAmount: '1000000.00000000',
      reservedAmount: ZERO,
    },
    select: { id: true },
  });

  // Crypto settles in the asset currency and is tradable 24h, so nothing here
  // depends on the wall-clock market session. KRW settlement keeps FX out.
  const asset = await prisma.asset.create({
    data: {
      symbol: 'NR' + randomUUID().replace(/-/gu, '').slice(0, 20),
      name: PREFIX,
      market: 'BINANCE',
      assetType: AssetType.crypto,
      currencyCode: CurrencyCode.KRW,
      isActive: true,
    },
    select: { id: true },
  });
  created.assets.push(asset.id);

  return {
    userId: user.id,
    participantId: participant.id,
    walletId: wallet.id,
    assetId: asset.id,
  };
}

async function cleanup() {
  await prisma.order.deleteMany({
    where: { seasonParticipantId: { in: created.participants } },
  });
  await prisma.quote.deleteMany({
    where: { seasonParticipantId: { in: created.participants } },
  });
  await prisma.cashWallet.deleteMany({
    where: { seasonParticipantId: { in: created.participants } },
  });
  await prisma.seasonParticipant.deleteMany({
    where: { id: { in: created.participants } },
  });
  await prisma.asset.deleteMany({ where: { id: { in: created.assets } } });
  await prisma.season.deleteMany({ where: { id: { in: created.seasons } } });
  await prisma.tradingAccount.deleteMany({ where: { userId: { in: created.users } } });
  await prisma.user.deleteMany({ where: { id: { in: created.users } } });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;
