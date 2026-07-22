import { spawnSync } from 'node:child_process';

/**
 * Opt-in PostgreSQL race tests for limit-buy CREATE against the two writers
 * that can invalidate it mid-flight: participant exclusion and season ending.
 *
 * Shares the LIMIT_ORDER_RESERVATION_DB_INTEGRATION switch with
 * limit-order-reservation.integration.spec.ts so one env var enables the whole
 * limit-order database suite. Real services, real transactions, real row
 * locks — a mock cannot demonstrate that a FOR SHARE lock actually blocks a
 * concurrent UPDATE.
 */
const RUN_DB_INTEGRATION =
  process.env.LIMIT_ORDER_RESERVATION_DB_INTEGRATION === '1';
const itDbIntegration = RUN_DB_INTEGRATION ? it : it.skip;

describe('Limit order create race DB integration', () => {
  itDbIntegration(
    'never leaves a reservation behind when create races participant exclusion or season ending',
    () => {
      const result = spawnSync(
        'pnpm',
        ['tsx', '-e', LIMIT_ORDER_CREATE_RACE_RUNNER],
        {
          cwd: process.cwd(),
          env: { ...process.env, LIMIT_ORDER_ENABLED: 'true' },
          encoding: 'utf8',
          timeout: 180_000,
        },
      );

      if (result.status !== 0) {
        throw new Error(
          [
            'Limit order create race DB integration runner failed.',
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
          ].join('\n'),
        );
      }

      // Every case must have reported, not just the final marker — a runner
      // that silently skipped a scenario would otherwise still pass.
      for (const caseName of [
        'exclusion committed first',
        'create committed first: exclusion cleanup',
        'create lock first: exclusion waits deterministically',
        'season ended first',
        'create committed first: season cleanup',
        'create lock first: season ending waits deterministically',
        'failure after the season/participant checks rolls the whole create back',
        'quote fee rate stays pinned',
      ]) {
        expect(result.stdout).toContain(`ok ${caseName}`);
      }
      expect(result.stdout).toContain(
        'limit order create race db integration ok',
      );
    },
    190_000,
  );
});

const LIMIT_ORDER_CREATE_RACE_RUNNER = `
import 'dotenv/config';
import assert from 'node:assert/strict';
import { Client } from 'pg';
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
  UserRole,
} from './src/generated/prisma/client';
import { PrismaService } from './src/prisma/prisma.service';
import { OrdersService } from './src/orders/orders.service';
import { LimitOrderCreateService } from './src/orders/limit-order-create.service';
import { LimitOrderCancelService } from './src/orders/limit-order-cancel.service';
import { OrderReservationService } from './src/orders/order-reservation.service';
import { OperatorAuditService } from './src/operator/operator-audit.service';
import { OperatorSeasonModerationService } from './src/operator/operator-season-moderation.service';
import { computeOrderQuoteRequestHash } from './src/providers/durable-quote.policy';

const TEST_PREFIX = 'limit-order-create-race-db-integration';
const ZERO_AMOUNT = '0.00000000';
// 2 x 100000 = 200000 gross, 0.1% fee = 200, reserved 200200.
const LIMIT_PRICE = '100000.00000000';
const QUANTITY = '2.000000';
const EXPECTED_RESERVED = '200200.00000000';
const FEE_RATE = '0.001000';

const prisma = new PrismaService();
const reservation = new OrderReservationService();
const cancelService = new LimitOrderCancelService(prisma, reservation);
const createService = new LimitOrderCreateService(prisma, reservation);
const ordersService = new OrdersService(
  prisma,
  undefined,
  createService,
  cancelService,
);
const moderationService = new OperatorSeasonModerationService(
  prisma,
  new OperatorAuditService(prisma),
  cancelService,
);

async function main() {
  await prisma.$connect();
  try {
    await runCase('exclusion committed first: create is refused, nothing reserved', testExclusionBeforeCreate);
    await runCase('create committed first: exclusion cleanup cancels it and releases the reservation', testCreateBeforeExclusion);
    await runCase('create lock first: exclusion waits deterministically and cleanup releases once', testConcurrentCreateVsExclusion);
    await runCase('season ended first: create is refused, nothing reserved', testSeasonEndBeforeCreate);
    await runCase('create committed first: season cleanup cancels it and releases the reservation', testCreateBeforeSeasonEnd);
    await runCase('create lock first: season ending waits deterministically and cleanup releases once', testConcurrentCreateVsSeasonEnd);
    await runCase('failure after the season/participant checks rolls the whole create back', testCreateRollback);
    await runCase('quote fee rate stays pinned when the season fee rate changes', testQuoteFeeRatePinning);
    console.log('limit order create race db integration ok');
  } finally {
    await prisma.$disconnect();
  }
}

async function openPgClient(applicationName) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query("SELECT set_config('application_name', $1, false)", [applicationName]);
  return client;
}

async function waitForBlockedQuery(observer, applicationName) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await observer.query(
      "SELECT wait_event_type FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'",
      [applicationName],
    );
    if (result.rowCount > 0) return;
    // This is state-based polling of pg_stat_activity, not a timing-based race.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for blocked transaction ' + applicationName);
}

async function waitForBlockedSql(observer, fragment) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await observer.query(
      "SELECT wait_event_type FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE $1",
      ['%' + fragment + '%'],
    );
    if (result.rowCount > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for blocked SQL containing ' + fragment);
}

function waitForAnyBlockedCashWalletUpdate(observer) {
  return waitForBlockedSql(observer, 'cash_wallets');
}

function waitForAnyBlockedParticipantUpdate(observer) {
  return waitForBlockedSql(observer, 'season_participants');
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

async function createScenario(label) {
  const suffix = String(Date.now()) + '-' + Math.random().toString(16).slice(2);
  const now = new Date();

  const user = await prisma.user.create({
    data: {
      email: TEST_PREFIX + '-' + label + '-' + suffix + '@example.com',
      passwordHash: 'integration-test-only',
      nickname: (TEST_PREFIX + '-' + label + '-' + suffix).slice(0, 40),
    },
    select: { id: true },
  });

  const operator = await prisma.user.create({
    data: {
      email: TEST_PREFIX + '-op-' + label + '-' + suffix + '@example.com',
      passwordHash: 'integration-test-only',
      nickname: (TEST_PREFIX + '-op-' + label + '-' + suffix).slice(0, 40),
      role: UserRole.operator,
    },
    select: { id: true, role: true },
  });

  const season = await prisma.season.create({
    data: {
      name: TEST_PREFIX + '-' + label + '-' + suffix,
      status: SeasonStatus.active,
      // OrdersService resolves "the active season" as startAt DESC, so a very
      // recent startAt makes this scenario's season win over any other active
      // season in the database (a dev season, or a sibling integration spec's
      // season, which uses now - 60s). Without that the create would fail its
      // pre-check with SEASON_NOT_JOINED and never reach the locking path
      // these tests exist to exercise. Still <= now, so the season is tradable.
      startAt: new Date(now.getTime() - 1_000),
      endAt: new Date(now.getTime() + 86_400_000),
      initialCapitalKrw: '10000000.00000000',
      tradeFeeRate: FEE_RATE,
      fxFeeRate: FEE_RATE,
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
      balanceAmount: '1000000.00000000',
      reservedAmount: ZERO_AMOUNT,
    },
    select: { id: true },
  });

  // Crypto settles in the asset currency and is tradable 24h, so the race
  // assertions never depend on the wall-clock market session. KRW settlement
  // keeps the FX snapshot out of the picture entirely.
  const asset = await prisma.asset.create({
    data: {
      symbol: (TEST_PREFIX + '-' + suffix).slice(0, 32),
      name: TEST_PREFIX + '-' + label,
      market: 'BINANCE',
      assetType: AssetType.crypto,
      currencyCode: CurrencyCode.KRW,
      isActive: true,
    },
    select: { id: true },
  });

  return {
    userId: user.id,
    operator: { userId: operator.id, role: operator.role },
    seasonId: season.id,
    participantId: participant.id,
    walletId: wallet.id,
    assetId: asset.id,
  };
}

/**
 * Inserts the durable quote directly, exactly as the quote endpoint would —
 * including the pinned reservation basis. Bypassing the HTTP quote step keeps
 * these tests focused on the create transaction.
 */
async function createLimitQuote(scenario, overrides = {}) {
  const requestHash = computeOrderQuoteRequestHash({
    userId: scenario.userId,
    seasonParticipantId: scenario.participantId,
    assetId: scenario.assetId,
    side: 'buy',
    orderType: 'limit',
    quantity: QUANTITY,
    limitPrice: LIMIT_PRICE,
    currencyCode: CurrencyCode.KRW,
  });

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
      quotedFeeRate: overrides.quotedFeeRate ?? FEE_RATE,
      quotedGrossAmount: overrides.quotedGrossAmount ?? '200000.00000000',
      quotedFeeAmount: overrides.quotedFeeAmount ?? '200.00000000',
      quotedReservedAmount: overrides.quotedReservedAmount ?? EXPECTED_RESERVED,
      maxChangeBps: '50.0000',
      expiresAt: new Date(Date.now() + 15_000),
      requestHash,
    },
    select: { id: true },
  });

  return quote.id;
}

function createBody(scenario, quoteId, idempotencyKey) {
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

async function cleanupScenario(scenario) {
  await prisma.operatorAuditLog.deleteMany({
    where: { actorUserId: scenario.operator.userId },
  });
  await prisma.order.deleteMany({
    where: { seasonParticipantId: scenario.participantId },
  });
  await prisma.quote.deleteMany({
    where: { seasonParticipantId: scenario.participantId },
  });
  await prisma.cashWallet.deleteMany({
    where: { seasonParticipantId: scenario.participantId },
  });
  await prisma.seasonParticipant.deleteMany({
    where: { id: scenario.participantId },
  });
  await prisma.asset.deleteMany({ where: { id: scenario.assetId } });
  await prisma.season.deleteMany({ where: { id: scenario.seasonId } });
  await prisma.user.deleteMany({
    where: { id: { in: [scenario.userId, scenario.operator.userId] } },
  });
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

async function readOrders(scenario) {
  return prisma.order.findMany({
    where: { seasonParticipantId: scenario.participantId },
    select: {
      id: true,
      status: true,
      orderType: true,
      reservedAmount: true,
      reservationFeeRate: true,
      reservationReleasedAt: true,
      cancelReason: true,
      grossAmount: true,
      feeAmount: true,
      netAmount: true,
      executedPrice: true,
      executedAt: true,
    },
    orderBy: { id: 'asc' },
  });
}

async function readParticipantStatus(scenario) {
  const row = await prisma.seasonParticipant.findUnique({
    where: { id: scenario.participantId },
    select: { participantStatus: true },
  });
  return row?.participantStatus ?? null;
}

async function readSeasonStatus(scenario) {
  const row = await prisma.season.findUnique({
    where: { id: scenario.seasonId },
    select: { status: true },
  });
  return row?.status ?? null;
}

function excludeParticipant(scenario) {
  return moderationService.excludeParticipant(
    scenario.operator,
    scenario.seasonId,
    scenario.participantId,
    { reason: 'race-test' },
  );
}

/**
 * Reproduces the season lifecycle job's two steps verbatim: the season status
 * transition commits in its own transaction, and the reservation cleanup runs
 * afterwards in separate transactions (see
 * batch/season-lifecycle-transition-job.service.ts). Constructed here rather
 * than instantiating the job so the test does not depend on BatchService job
 * bookkeeping.
 */
async function endSeasonWithCleanup(scenario) {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.season.updateMany({
      where: { id: scenario.seasonId, status: SeasonStatus.active },
      data: { status: SeasonStatus.ended },
    });
  });
  return cancelService.cleanupEndedSeasonLimitReservations({ now });
}

/**
 * The invariant every ordering must satisfy: no reserved cash and no open
 * limit order may outlive an exclusion or a season end, and a submitted order
 * must never carry execution amounts.
 */
async function assertNoLeakedReservation(scenario) {
  const wallet = await readWallet(scenario);
  assert.equal(wallet.reserved, ZERO_AMOUNT, 'reservation leaked: ' + wallet.reserved);
  // Reserving never moves the balance in either direction.
  assert.equal(wallet.balance, '1000000.00000000');

  const orders = await readOrders(scenario);
  const open = orders.filter((order) => order.status === OrderStatus.submitted);
  assert.equal(open.length, 0, 'open limit order survived cleanup');

  for (const order of orders) {
    assert.equal(order.status, OrderStatus.canceled);
    assert.equal(order.reservationReleasedAt !== null, true);
    assertNoExecutionAmounts(order);
  }
}

function assertNoExecutionAmounts(order) {
  assert.equal(order.grossAmount, null, 'grossAmount must stay null');
  assert.equal(order.feeAmount, null, 'feeAmount must stay null');
  assert.equal(order.netAmount, null, 'netAmount must stay null');
  assert.equal(order.executedPrice, null, 'executedPrice must stay null');
  assert.equal(order.executedAt, null, 'executedAt must stay null');
}

async function expectCreateRejected(scenario, quoteId, key, expectedCodes) {
  let code = null;
  try {
    await ordersService.createOrder(scenario.userId, createBody(scenario, quoteId, key));
  } catch (error) {
    const response = typeof error?.getResponse === 'function' ? error.getResponse() : null;
    code = response?.error?.code ?? null;
  }
  assert.ok(
    code !== null && expectedCodes.includes(code),
    'expected one of ' + expectedCodes.join('/') + ', got ' + String(code),
  );
}

// ---------------------------------------------------------------- exclusion

async function testExclusionBeforeCreate() {
  const scenario = await createScenario('exclusion-first');
  try {
    const quoteId = await createLimitQuote(scenario);
    await excludeParticipant(scenario);

    // Which courtesy code the pre-transaction check produces depends on
    // database contents — it resolves the CURRENTLY active season, and any
    // other active season in the database makes SEASON_NOT_JOINED the answer
    // instead. All of these are correct refusals; the invariant asserted
    // below is what must hold in every case.
    await expectCreateRejected(scenario, quoteId, 'race-excl-1', [
      'PARTICIPANT_EXCLUDED',
      'PARTICIPANT_NOT_ACTIVE',
      'SEASON_NOT_JOINED',
    ]);

    const wallet = await readWallet(scenario);
    assert.equal(wallet.reserved, ZERO_AMOUNT);
    assert.equal((await readOrders(scenario)).length, 0);
    assert.equal(await readParticipantStatus(scenario), ParticipantStatus.excluded);

    // The authoritative guard, independent of any pre-check: the LOCKED
    // participant row inside the create transaction refuses the order.
    let lockedCode = null;
    try {
      await prisma.$transaction(async (tx) => {
        await createService.lockTradableContextInTransaction(tx, {
          userId: scenario.userId,
          seasonParticipantId: scenario.participantId,
          now: new Date(),
        });
      });
    } catch (error) {
      const response = typeof error?.getResponse === 'function' ? error.getResponse() : null;
      lockedCode = response?.error?.code ?? null;
    }
    assert.equal(lockedCode, 'PARTICIPANT_EXCLUDED');
  } finally {
    await cleanupScenario(scenario);
  }
}

async function testCreateBeforeExclusion() {
  const scenario = await createScenario('create-first-excl');
  try {
    const quoteId = await createLimitQuote(scenario);
    const created = await ordersService.createOrder(
      scenario.userId,
      createBody(scenario, quoteId, 'race-excl-2'),
    );

    assert.equal(created.data.execution.state, 'submitted');
    assert.equal(created.data.execution.reservedAmount, EXPECTED_RESERVED);
    assert.equal(created.data.execution.reservationFeeRate, FEE_RATE);
    assert.equal((await readWallet(scenario)).reserved, EXPECTED_RESERVED);
    assertNoExecutionAmounts((await readOrders(scenario))[0]);

    await excludeParticipant(scenario);

    await assertNoLeakedReservation(scenario);
    const orders = await readOrders(scenario);
    assert.equal(orders.length, 1);
    assert.equal(orders[0].cancelReason, 'participant_excluded');
    // The reservation figures survive as history on the canceled row.
    assert.equal(orders[0].reservedAmount.toFixed(8), EXPECTED_RESERVED);
  } finally {
    await cleanupScenario(scenario);
  }
}

async function testConcurrentCreateVsExclusion() {
  const scenario = await createScenario('barrier-excl');
  const walletBlocker = await openPgClient('limit-race-wallet-blocker-exclusion');
  const observer = await openPgClient('limit-race-observer-exclusion');
  try {
    const quoteId = await createLimitQuote(scenario);
    await walletBlocker.query('BEGIN');
    await walletBlocker.query('SELECT id FROM cash_wallets WHERE id = $1 FOR UPDATE', [scenario.walletId]);

    const createPromise = ordersService.createOrder(
      scenario.userId,
      createBody(scenario, quoteId, 'race-excl-barrier'),
    );
    await waitForAnyBlockedCashWalletUpdate(observer);
    const exclusionPromise = excludeParticipant(scenario);
    await waitForAnyBlockedParticipantUpdate(observer);

    await walletBlocker.query('COMMIT');
    const created = await createPromise;
    assert.equal(created.data.execution.state, 'submitted');
    await exclusionPromise;
    await assertNoLeakedReservation(scenario);
    assert.equal((await readOrders(scenario))[0].cancelReason, 'participant_excluded');
  } finally {
    await walletBlocker.query('ROLLBACK').catch(() => undefined);
    await walletBlocker.end();
    await observer.end();
    await cleanupScenario(scenario);
  }
}

// ------------------------------------------------------------ season ending

async function testSeasonEndBeforeCreate() {
  const scenario = await createScenario('season-end-first');
  try {
    const quoteId = await createLimitQuote(scenario);
    await endSeasonWithCleanup(scenario);

    // SEASON_NOT_JOINED is an equally correct refusal: the pre-transaction
    // courtesy check resolves the CURRENTLY active season, and once this
    // scenario's season ends another active season in the database becomes
    // that answer — the user is not a participant of it. Which courtesy code
    // wins depends on database contents; what must never vary is that the
    // order is refused and nothing is reserved.
    await expectCreateRejected(scenario, quoteId, 'race-season-1', [
      'SEASON_NOT_ACTIVE',
      'SEASON_ENDED',
      'SEASON_NOT_JOINED',
    ]);

    assert.equal((await readWallet(scenario)).reserved, ZERO_AMOUNT);
    assert.equal((await readOrders(scenario)).length, 0);
    assert.equal(await readSeasonStatus(scenario), SeasonStatus.ended);

    // Independent of any pre-check: the in-transaction guard on the LOCKED
    // season row is what actually protects the reservation, so assert it
    // directly against the ended season.
    let lockedCode = null;
    try {
      await prisma.$transaction(async (tx) => {
        await createService.lockTradableContextInTransaction(tx, {
          userId: scenario.userId,
          seasonParticipantId: scenario.participantId,
          now: new Date(),
        });
      });
    } catch (error) {
      const response = typeof error?.getResponse === 'function' ? error.getResponse() : null;
      lockedCode = response?.error?.code ?? null;
    }
    assert.equal(lockedCode, 'SEASON_NOT_ACTIVE');
  } finally {
    await cleanupScenario(scenario);
  }
}

async function testCreateBeforeSeasonEnd() {
  const scenario = await createScenario('create-first-season');
  try {
    const quoteId = await createLimitQuote(scenario);
    await ordersService.createOrder(
      scenario.userId,
      createBody(scenario, quoteId, 'race-season-2'),
    );
    assert.equal((await readWallet(scenario)).reserved, EXPECTED_RESERVED);

    const cleanup = await endSeasonWithCleanup(scenario);
    assert.equal(cleanup.canceledOrderCount, 1);

    await assertNoLeakedReservation(scenario);
    const orders = await readOrders(scenario);
    assert.equal(orders[0].cancelReason, 'season_ended');

    // Settlement's open-reservation precondition is now satisfied.
    const summary = await cancelService.getOpenLimitReservationSummary(scenario.seasonId);
    assert.equal(summary.openLimitBuyOrderCount, 0);
    assert.equal(summary.reservedWalletCount, 0);
  } finally {
    await cleanupScenario(scenario);
  }
}

async function testConcurrentCreateVsSeasonEnd() {
  const scenario = await createScenario('barrier-season');
  const walletBlocker = await openPgClient('limit-race-wallet-blocker-season');
  const ender = await openPgClient('limit-race-season-ender');
  const observer = await openPgClient('limit-race-observer-season');
  try {
    const quoteId = await createLimitQuote(scenario);
    await walletBlocker.query('BEGIN');
    await walletBlocker.query('SELECT id FROM cash_wallets WHERE id = $1 FOR UPDATE', [scenario.walletId]);

    const createPromise = ordersService.createOrder(
      scenario.userId,
      createBody(scenario, quoteId, 'race-season-barrier'),
    );
    await waitForAnyBlockedCashWalletUpdate(observer);
    await ender.query('BEGIN');
    const endPromise = ender.query("UPDATE seasons SET status = 'ended' WHERE id = $1", [scenario.seasonId]);
    await waitForBlockedQuery(observer, 'limit-race-season-ender');

    await walletBlocker.query('COMMIT');
    const created = await createPromise;
    assert.equal(created.data.execution.state, 'submitted');
    await endPromise;
    await ender.query('COMMIT');
    await cancelService.cleanupEndedSeasonLimitReservations({ now: new Date() });
    await assertNoLeakedReservation(scenario);
    assert.equal((await readOrders(scenario))[0].cancelReason, 'season_ended');
  } finally {
    await walletBlocker.query('ROLLBACK').catch(() => undefined);
    await ender.query('ROLLBACK').catch(() => undefined);
    await walletBlocker.end();
    await ender.end();
    await observer.end();
    await cleanupScenario(scenario);
  }
}

// ----------------------------------------------------------------- rollback

async function testCreateRollback() {
  const scenario = await createScenario('rollback');
  try {
    const quoteId = await createLimitQuote(scenario);

    // Fail AFTER the season/participant re-validation and the wallet
    // reservation, inside the same transaction the create runs in.
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        await createService.lockQuoteForCreateInTransaction(tx, quoteId);
        await createService.lockTradableContextInTransaction(tx, {
          userId: scenario.userId,
          seasonParticipantId: scenario.participantId,
          now: new Date(),
        });

        const quote = await tx.quote.findUniqueOrThrow({
          where: { id: quoteId },
          select: {
            id: true,
            quantity: true,
            limitPrice: true,
            quotedFeeRate: true,
            quotedGrossAmount: true,
            quotedFeeAmount: true,
            quotedReservedAmount: true,
          },
        });

        await createService.createSubmittedLimitBuyInTransaction(tx, {
          quote: {
            id: quote.id,
            limitPrice: quote.limitPrice,
            quotedFeeRate: quote.quotedFeeRate,
            quotedGrossAmount: quote.quotedGrossAmount,
            quotedFeeAmount: quote.quotedFeeAmount,
            quotedReservedAmount: quote.quotedReservedAmount,
            asset: {
              id: scenario.assetId,
              settlementCurrency: null,
              currencyCode: CurrencyCode.KRW,
            },
          },
          participant: { id: scenario.participantId },
          quantity: quote.quantity,
          idempotency: { idempotencyKey: 'race-rollback-1', requestHash: 'race-rollback-1' },
          submittedAt: new Date(),
        });

        throw new Error('deliberate post-reservation failure');
      }),
      /deliberate post-reservation failure/,
    );

    // Reservation, order row and quote consumption all rolled back together.
    assert.equal((await readWallet(scenario)).reserved, ZERO_AMOUNT);
    assert.equal((await readOrders(scenario)).length, 0);
    const quote = await prisma.quote.findUnique({
      where: { id: quoteId },
      select: { status: true, consumedAt: true },
    });
    assert.equal(quote.status, QuoteStatus.active);
    assert.equal(quote.consumedAt, null);
  } finally {
    await cleanupScenario(scenario);
  }
}

// --------------------------------------------------------- fee rate pinning

async function testQuoteFeeRatePinning() {
  const scenario = await createScenario('fee-pinning');
  try {
    const quoteId = await createLimitQuote(scenario);

    // An operator raises the season fee 50x between quote and create.
    await prisma.season.update({
      where: { id: scenario.seasonId },
      data: { tradeFeeRate: '0.050000' },
    });

    const created = await ordersService.createOrder(
      scenario.userId,
      createBody(scenario, quoteId, 'race-fee-1'),
    );

    // 5% would have reserved 210000; the quote's pinned 0.1% basis wins.
    assert.equal(created.data.execution.reservedAmount, EXPECTED_RESERVED);
    assert.equal(created.data.execution.reservationFeeRate, FEE_RATE);
    assert.equal((await readWallet(scenario)).reserved, EXPECTED_RESERVED);

    const orders = await readOrders(scenario);
    assert.equal(orders.length, 1);
    assert.equal(orders[0].reservedAmount.toFixed(8), EXPECTED_RESERVED);
    assert.equal(orders[0].reservationFeeRate.toFixed(6), FEE_RATE);
    assertNoExecutionAmounts(orders[0]);
  } finally {
    await cleanupScenario(scenario);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;
