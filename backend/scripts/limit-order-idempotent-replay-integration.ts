/**
 * IDEMPOTENT REPLAY runner for limit Create (real PostgreSQL).
 *
 * Two defects are covered, both about a create that ALREADY COMMITTED.
 *
 * 1. ORDERING. The replay lookup used to run AFTER
 *    `assertLimitOrderFeatureEnabled()` and `requireLimitOrderCreateService()`,
 *    so a caller retrying a request whose order and reservation already exist
 *    was answered with LIMIT_ORDER_DISABLED (after an emergency rollback) or
 *    LIMIT_ORDER_SERVICE_UNAVAILABLE (on an instance without the create
 *    service) instead of the stored first response. The retry storm this
 *    replay absorbs is most likely exactly when such a gate is failing.
 *
 * 2. SCOPE. The lookup was `(seasonParticipant.userId, idempotencyKey)`
 *    ordered newest-first, while the only uniqueness the database enforces is
 *    `(seasonParticipantId, idempotencyKey)`. A key reused in a later season —
 *    which the schema permits — made the season-1 retry resolve to the
 *    season-2 order and answer ORDER_IDEMPOTENCY_CONFLICT, even though both
 *    requests were individually valid. The lookup is now keyed on the (unique)
 *    quote, so its scope equals a real constraint instead of exceeding one.
 *
 * Every assertion is against real rows: the order count, the wallet's
 * reservedAmount, and the stored responsePayloadJson.
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import {
  AssetType,
  CurrencyCode,
  OrderSide,
  OrderStatus,
  OrderType,
  ParticipantStatus,
  QuoteStatus,
  QuoteType,
  SeasonStatus,
} from '../src/generated/prisma/client';
import { LimitOrderCancelService } from '../src/orders/limit-order-cancel.service';
import { LimitOrderCreateService } from '../src/orders/limit-order-create.service';
import { OrderReservationService } from '../src/orders/order-reservation.service';
import { OrdersService } from '../src/orders/orders.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { computeOrderQuoteRequestHash } from '../src/providers/durable-quote.policy';

const RUN = process.env.LIMIT_ORDER_IDEMPOTENT_REPLAY_INTEGRATION;
if (RUN !== '1') {
  console.log(
    'limit order idempotent replay integration skipped (set LIMIT_ORDER_IDEMPOTENT_REPLAY_INTEGRATION=1)',
  );
  process.exit(0);
}

const PREFIX = `limit-order-replay-${process.pid}-${Date.now()}`;
const ZERO = '0.00000000';
// 2 x 100000 = 200000 gross, 0.1% fee = 200, reserved 200200.
const LIMIT_PRICE = '100000.00000000';
const QUANTITY = '2.000000';
const EXPECTED_RESERVED = '200200.00000000';
const FEE_RATE = '0.001000';

const prisma = new PrismaService();
const reservation = new OrderReservationService();
const createService = new LimitOrderCreateService(prisma, reservation);
const cancelService = new LimitOrderCancelService(prisma, reservation);

/** The ordinary, fully wired instance. */
const orders = new OrdersService(
  prisma,
  undefined,
  createService,
  cancelService,
);

const createdUserIds: string[] = [];
const createdParticipantIds: string[] = [];
const createdAssetIds: string[] = [];
const createdSeasonIds: string[] = [];

async function main(): Promise<void> {
  requireEnvironment();
  await prisma.$connect();
  try {
    await run(
      'a committed create replays while the feature flag is off',
      testFlagOffReplay,
    );
    await run(
      'a committed create replays on an instance with no create service',
      testMissingCreateServiceReplay,
    );
    await run(
      'a committed create replays while every health gate is failing',
      testFailingHealthGatesReplay,
    );
    await run(
      'a committed create replays after the season ended',
      testSeasonEndedReplay,
    );
    await run(
      'the same key in two seasons replays each season own order',
      testCrossSeasonSameKey,
    );
    await run(
      'a different request under the same quote is a conflict',
      testRequestHashConflict,
    );
    await run(
      'another user cannot replay this order',
      testForeignUserCannotReplay,
    );
    console.log('limit order idempotent replay integration ok');
  } finally {
    await cleanup().catch((error: unknown) => {
      console.error('cleanup failed', error);
    });
    await prisma.$disconnect();
  }
}

function requireEnvironment(): void {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must be configured.');
  // The runner flips LIMIT_ORDER_ENABLED itself; it must start from a state
  // where a create can actually be made.
  process.env.LIMIT_ORDER_ENABLED = 'true';
  // Automatic matching stays OFF: this suite is about the create/replay path,
  // and enabling it would drag Redis and provider readiness in for no reason.
  process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED = 'false';
}

async function run(name: string, test: () => Promise<void>): Promise<void> {
  await test();
  console.log(`ok ${name}`);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function testFlagOffReplay(): Promise<void> {
  const scenario = await createScenario('flag-off');
  const quoteId = await createLimitQuote(scenario);
  const body = createBody(scenario, quoteId, `${PREFIX}-flag-off`);

  const first = await orders.createOrder(scenario.userId, body);
  await assertCommitted(scenario, first);

  // EMERGENCY ROLLBACK. New registrations must stop; a response the system
  // already produced must still be returned.
  process.env.LIMIT_ORDER_ENABLED = 'false';
  try {
    const replayed = await orders.createOrder(scenario.userId, body);
    assert.deepEqual(
      replayed,
      first,
      'the stored first response must be replayed verbatim',
    );
  } finally {
    process.env.LIMIT_ORDER_ENABLED = 'true';
  }

  // And a genuinely NEW create is still refused while the flag is off, which
  // is the whole point of the flag.
  const freshQuote = await createLimitQuote(scenario);
  process.env.LIMIT_ORDER_ENABLED = 'false';
  try {
    await assertErrorCode(
      orders.createOrder(
        scenario.userId,
        createBody(scenario, freshQuote, `${PREFIX}-flag-off-new`),
      ),
      'LIMIT_ORDER_DISABLED',
    );
  } finally {
    process.env.LIMIT_ORDER_ENABLED = 'true';
  }

  await assertNoExtraCommit(scenario, 1);
}

async function testMissingCreateServiceReplay(): Promise<void> {
  const scenario = await createScenario('no-service');
  const quoteId = await createLimitQuote(scenario);
  const body = createBody(scenario, quoteId, `${PREFIX}-no-service`);

  const first = await orders.createOrder(scenario.userId, body);
  await assertCommitted(scenario, first);

  // A second API instance deployed WITHOUT the create service. It cannot
  // create anything, but it can answer for what another instance committed.
  const withoutCreate = new OrdersService(prisma, undefined, undefined);
  const replayed = await withoutCreate.createOrder(scenario.userId, body);
  assert.deepEqual(replayed, first);

  await assertErrorCode(
    withoutCreate.createOrder(
      scenario.userId,
      createBody(
        scenario,
        await createLimitQuote(scenario),
        `${PREFIX}-no-service-new`,
      ),
    ),
    'LIMIT_ORDER_SERVICE_UNAVAILABLE',
  );

  await assertNoExtraCommit(scenario, 1);
}

async function testFailingHealthGatesReplay(): Promise<void> {
  const scenario = await createScenario('health');
  const quoteId = await createLimitQuote(scenario);
  const body = createBody(scenario, quoteId, `${PREFIX}-health`);

  const first = await orders.createOrder(scenario.userId, body);
  await assertCommitted(scenario, first);

  // Every operational gate hard down, and each one instrumented: the replay
  // must not merely survive them, it must never CONSULT them.
  const calls: string[] = [];
  const failing = <T extends string>(name: T) => ({
    isEnabled: () => true,
    assertAvailable: () => {
      calls.push(name);
      throw new Error(`${name} is down`);
    },
    assertAvailableAsync: () => {
      calls.push(`${name}:async`);
      return Promise.reject(new Error(`${name} is down`));
    },
    assertAvailableInTransaction: () => {
      calls.push(`${name}:tx`);
      throw new Error(`${name} is down`);
    },
  });
  const degraded = new OrdersService(
    prisma,
    undefined,
    createService,
    cancelService,
    failing('matcher') as never,
    undefined,
    failing('provider') as never,
    undefined,
    failing('candle') as never,
  );

  const replayed = await degraded.createOrder(scenario.userId, body);
  assert.deepEqual(replayed, first);
  assert.deepEqual(
    calls,
    [],
    'a replay must not consult provider, matcher or path-B health at all',
  );

  await assertNoExtraCommit(scenario, 1);
}

async function testSeasonEndedReplay(): Promise<void> {
  const scenario = await createScenario('season-ended');
  const quoteId = await createLimitQuote(scenario);
  const body = createBody(scenario, quoteId, `${PREFIX}-season-ended`);

  const first = await orders.createOrder(scenario.userId, body);
  await assertCommitted(scenario, first);

  await prisma.season.update({
    where: { id: scenario.seasonId },
    data: {
      status: SeasonStatus.ended,
      endAt: new Date(Date.now() - 60_000),
    },
  });

  const replayed = await orders.createOrder(scenario.userId, body);
  assert.deepEqual(
    replayed,
    first,
    'the replay must not depend on an active season',
  );
  await assertNoExtraCommit(scenario, 1);
}

/**
 * THE SCOPE DEFECT. `idempotencyKey` is unique per SEASON PARTICIPATION, so
 * the same key may legitimately be used again in a later season. The old
 * user-wide lookup returned the NEWEST match, so replaying the season-1
 * request resolved to the season-2 order and conflicted.
 */
async function testCrossSeasonSameKey(): Promise<void> {
  const sharedKey = `${PREFIX}-cross-season`;
  const seasonOne = await createScenario('season-1');
  const quoteOne = await createLimitQuote(seasonOne);
  const bodyOne = createBody(seasonOne, quoteOne, sharedKey);
  const firstResponse = await orders.createOrder(seasonOne.userId, bodyOne);
  await assertCommitted(seasonOne, firstResponse);

  // Season 1 ends; the SAME user joins season 2 and reuses the key.
  await prisma.season.update({
    where: { id: seasonOne.seasonId },
    data: {
      status: SeasonStatus.ended,
      endAt: new Date(Date.now() - 60_000),
    },
  });
  const seasonTwo = await createScenario('season-2', {
    userId: seasonOne.userId,
  });
  const quoteTwo = await createLimitQuote(seasonTwo);
  const bodyTwo = createBody(seasonTwo, quoteTwo, sharedKey);
  const secondResponse = await orders.createOrder(seasonTwo.userId, bodyTwo);
  await assertCommitted(seasonTwo, secondResponse);

  assert.notEqual(
    orderIdOf(firstResponse),
    orderIdOf(secondResponse),
    'the two seasons must have produced two distinct orders',
  );

  // Both retries resolve to THEIR OWN order, in either direction.
  assert.deepEqual(
    await orders.createOrder(seasonOne.userId, bodyOne),
    firstResponse,
    'the season-1 retry must replay the season-1 order',
  );
  assert.deepEqual(
    await orders.createOrder(seasonTwo.userId, bodyTwo),
    secondResponse,
    'the season-2 retry must replay the season-2 order',
  );

  await assertNoExtraCommit(seasonOne, 1);
  await assertNoExtraCommit(seasonTwo, 1);
}

async function testRequestHashConflict(): Promise<void> {
  const scenario = await createScenario('hash-conflict');
  const quoteId = await createLimitQuote(scenario);
  const key = `${PREFIX}-hash-conflict`;
  const first = await orders.createOrder(
    scenario.userId,
    createBody(scenario, quoteId, key),
  );
  await assertCommitted(scenario, first);

  // Same quote, same key, DIFFERENT quantity: a genuinely different request.
  await assertErrorCode(
    orders.createOrder(scenario.userId, {
      ...createBody(scenario, quoteId, key),
      quantity: '3.000000',
    }),
    'ORDER_IDEMPOTENCY_CONFLICT',
  );

  // Same quote presented under a DIFFERENT key: the quote is consumed.
  await assertErrorCode(
    orders.createOrder(
      scenario.userId,
      createBody(scenario, quoteId, `${key}-other`),
    ),
    'ORDER_IDEMPOTENCY_CONFLICT',
  );

  await assertNoExtraCommit(scenario, 1);
}

async function testForeignUserCannotReplay(): Promise<void> {
  const owner = await createScenario('owner');
  const quoteId = await createLimitQuote(owner);
  const key = `${PREFIX}-foreign`;
  const first = await orders.createOrder(
    owner.userId,
    createBody(owner, quoteId, key),
  );
  await assertCommitted(owner, first);

  const stranger = await createScenario('stranger');
  await assertErrorCode(
    orders.createOrder(stranger.userId, createBody(owner, quoteId, key)),
    'ORDER_IDEMPOTENCY_CONFLICT',
  );

  await assertNoExtraCommit(owner, 1);
  await assertNoExtraCommit(stranger, 0);
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function orderIdOf(response: unknown): string {
  const order = (response as { data: { order: { orderId: string } } }).data
    .order;
  return order.orderId;
}

async function assertCommitted(
  scenario: Scenario,
  response: unknown,
): Promise<void> {
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderIdOf(response) },
    select: { status: true, reservedAmount: true, responsePayloadJson: true },
  });
  assert.equal(order.status, OrderStatus.submitted);
  assert.equal(order.reservedAmount?.toFixed(8), EXPECTED_RESERVED);
  assert.ok(
    order.responsePayloadJson,
    'the first response must be stored so it can be replayed verbatim',
  );
  await assertNoExtraCommit(scenario, 1);
}

/**
 * The financial invariant a replay must never break: no second order, and no
 * second reservation on the wallet.
 */
async function assertNoExtraCommit(
  scenario: Scenario,
  expectedOrders: number,
): Promise<void> {
  const count = await prisma.order.count({
    where: { seasonParticipantId: scenario.participantId },
  });
  assert.equal(
    count,
    expectedOrders,
    'a replay must not create a second order',
  );

  const wallet = await prisma.cashWallet.findUniqueOrThrow({
    where: { id: scenario.walletId },
    select: { reservedAmount: true, balanceAmount: true },
  });
  const expectedReserved =
    expectedOrders === 0
      ? ZERO
      : (Number(EXPECTED_RESERVED) * expectedOrders).toFixed(8);
  assert.equal(
    wallet.reservedAmount.toFixed(8),
    expectedReserved,
    'a replay must not reserve cash a second time',
  );
  assert.equal(
    wallet.balanceAmount.toFixed(8),
    '1000000.00000000',
    'a submitted limit order never moves balanceAmount',
  );
}

async function assertErrorCode(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert.ok(
      error instanceof HttpException,
      `expected an HttpException for ${code}`,
    );
    const response = error.getResponse() as {
      error?: { code?: string };
    };
    assert.equal(response.error?.code, code);
    return;
  }
  assert.fail(`expected ${code} but the call resolved`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Scenario = {
  userId: string;
  seasonId: string;
  participantId: string;
  walletId: string;
  assetId: string;
};

async function createScenario(
  label: string,
  options: { userId?: string } = {},
): Promise<Scenario> {
  const suffix = `${label}-${randomUUID()}`;
  const now = new Date();

  let userId = options.userId;
  if (!userId) {
    const user = await prisma.user.create({
      data: {
        email: `${PREFIX}-${suffix}@example.com`,
        passwordHash: 'integration-test-only',
        // User.nickname is unique and capped at 40 chars; the run prefix alone
        // nearly fills it, so the unique part has to lead.
        nickname: `rp-${randomUUID()}`.slice(0, 40),
      },
      select: { id: true },
    });
    userId = user.id;
    createdUserIds.push(user.id);
  }

  const season = await prisma.season.create({
    data: {
      name: `${PREFIX}-${suffix}`,
      status: SeasonStatus.active,
      // OrdersService resolves "the active season" as startAt DESC, so a very
      // recent startAt makes this scenario's season win over any other active
      // season in the database. Still <= now, so the season is tradable.
      startAt: new Date(now.getTime() - 1_000),
      endAt: new Date(now.getTime() + 86_400_000),
      initialCapitalKrw: '10000000.00000000',
      tradeFeeRate: FEE_RATE,
      fxFeeRate: FEE_RATE,
    },
    select: { id: true },
  });
  createdSeasonIds.push(season.id);

  const participant = await prisma.seasonParticipant.create({
    data: {
      seasonId: season.id,
      userId,
      joinedAt: now,
      participantStatus: ParticipantStatus.active,
      initialCapitalKrw: '10000000.00000000',
      totalAssetKrw: '10000000.00000000',
      totalReturnRate: ZERO,
      maxDrawdown: ZERO,
    },
    select: { id: true },
  });
  createdParticipantIds.push(participant.id);

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
      symbol: `RP${randomUUID().replace(/-/gu, '').slice(0, 20)}`,
      name: `${PREFIX}-${label}`,
      market: 'BINANCE',
      assetType: AssetType.crypto,
      currencyCode: CurrencyCode.KRW,
      isActive: true,
    },
    select: { id: true },
  });
  createdAssetIds.push(asset.id);

  return {
    userId,
    seasonId: season.id,
    participantId: participant.id,
    walletId: wallet.id,
    assetId: asset.id,
  };
}

/**
 * Inserts the durable quote directly, exactly as the quote endpoint would —
 * including the pinned reservation basis. Bypassing the HTTP quote step keeps
 * this suite focused on the create/replay path.
 */
async function createLimitQuote(scenario: Scenario): Promise<string> {
  const quote = await prisma.quote.create({
    data: {
      userId: scenario.userId,
      seasonParticipantId: scenario.participantId,
      quoteType: QuoteType.order,
      status: QuoteStatus.active,
      assetId: scenario.assetId,
      side: OrderSide.buy,
      orderType: OrderType.limit,
      quantity: QUANTITY,
      limitPrice: LIMIT_PRICE,
      currencyCode: CurrencyCode.KRW,
      quotedPrice: LIMIT_PRICE,
      quotedFeeRate: FEE_RATE,
      quotedGrossAmount: '200000.00000000',
      quotedFeeAmount: '200.00000000',
      quotedReservedAmount: EXPECTED_RESERVED,
      maxChangeBps: '50.0000',
      expiresAt: new Date(Date.now() + 300_000),
      requestHash: computeOrderQuoteRequestHash({
        userId: scenario.userId,
        seasonParticipantId: scenario.participantId,
        assetId: scenario.assetId,
        side: 'buy',
        orderType: 'limit',
        quantity: QUANTITY,
        limitPrice: LIMIT_PRICE,
        currencyCode: CurrencyCode.KRW,
      }),
    },
    select: { id: true },
  });
  return quote.id;
}

function createBody(
  scenario: Scenario,
  quoteId: string,
  idempotencyKey: string,
) {
  return {
    quoteId,
    assetId: scenario.assetId,
    side: 'buy',
    orderType: 'limit',
    quantity: QUANTITY,
    limitPrice: LIMIT_PRICE,
    idempotencyKey,
  };
}

async function cleanup(): Promise<void> {
  await prisma.order.deleteMany({
    where: { seasonParticipantId: { in: createdParticipantIds } },
  });
  await prisma.quote.deleteMany({
    where: { seasonParticipantId: { in: createdParticipantIds } },
  });
  await prisma.walletTransaction.deleteMany({
    where: { seasonParticipantId: { in: createdParticipantIds } },
  });
  await prisma.cashWallet.deleteMany({
    where: { seasonParticipantId: { in: createdParticipantIds } },
  });
  await prisma.seasonParticipant.deleteMany({
    where: { id: { in: createdParticipantIds } },
  });
  await prisma.asset.deleteMany({ where: { id: { in: createdAssetIds } } });
  await prisma.season.deleteMany({ where: { id: { in: createdSeasonIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
