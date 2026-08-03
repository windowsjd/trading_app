import { spawnSync } from 'node:child_process';

/**
 * Opt-in PostgreSQL integration tests for the trading trading-account scope
 * (작업 5): schema/index semantics (FX legacy partial unique, account-scoped
 * order/position uniques), the repair-trading-scope script, dual-write on
 * limit create / fill, wallet+order+position+quote scope fail-closed
 * behavior, account-scoped order/position APIs and their legacy
 * equivalence, same-user cross-account idempotency (orders and FX), and the
 * account-scoped read integrity probes.
 * Runs only with TRADING_ACCOUNT_DB_INTEGRATION=1 against the migrated dev
 * DB (prepare = `prisma migrate deploy` only; never reset/drop/seed).
 */
const RUN_DB_INTEGRATION = process.env.TRADING_ACCOUNT_DB_INTEGRATION === '1';
const itDbIntegration = RUN_DB_INTEGRATION ? it : it.skip;

describe('Trading trading-account scope DB integration', () => {
  itDbIntegration(
    'verifies trading-scope schema, repair script, dual-write, scope fail-closed, and account APIs against PostgreSQL',
    () => {
      runDbIntegrationPrepare();

      const result = spawnSync(
        getPnpmCommand(),
        ['tsx', '-e', TRADING_SCOPE_DB_RUNNER],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 300_000,
        },
      );

      if (result.status !== 0) {
        throw new Error(
          [
            'Trading scope DB integration runner failed.',
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
          ].join('\n'),
        );
      }

      expect(result.stdout).toContain('trading scope db integration ok');
    },
    320_000,
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
        'Trading scope DB integration prepare failed.',
        'The opt-in test applies existing Prisma migrations with `prisma migrate deploy` only; it does not reset, drop, or seed the database.',
        'stdout:',
        result.stdout,
        'stderr:',
        result.stderr,
      ].join('\n'),
    );
  }
}

const TRADING_SCOPE_DB_RUNNER = `
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import {
  AssetType,
  CurrencyCode,
  FxRateSourceType,
  OrderSide,
  OrderStatus,
  OrderType,
  ParticipantStatus,
  QuoteStatus,
  QuoteType,
  SeasonStatus,
  TradingAccountMode,
  TradingAccountStatus,
} from './src/generated/prisma/client';
import { PrismaService } from './src/prisma/prisma.service';
import { FxService } from './src/fx/fx.service';
import { preflightFxExecuteRequest } from './src/fx/fx-execute-request-policy';
import { computeFxQuoteRequestHash, computeOrderQuoteRequestHash } from './src/providers/durable-quote.policy';
import { OrdersService } from './src/orders/orders.service';
import { OrderReservationService } from './src/orders/order-reservation.service';
import { LimitOrderCreateService } from './src/orders/limit-order-create.service';
import { LimitOrderCancelService } from './src/orders/limit-order-cancel.service';
import { LimitOrderCandleEvidenceService } from './src/orders/limit-order-candle-evidence.service';
import { LimitOrderExecutionService } from './src/orders/limit-order-execution.service';
import { PositionsService } from './src/positions/positions.service';
import { WalletsService } from './src/wallets/wallets.service';
import { TradingAccountAccessService } from './src/trading-accounts/trading-account-access.service';
import {
  repairTradingScope,
  resolveTradingScopeExitCode,
} from './scripts/lib/repair-trading-scope';

process.env.LIMIT_ORDER_ENABLED = 'true';

const TEST_PREFIX = 'trading-scope-db-integration';
const ZERO = '0.00000000';
const CAPITAL = '10000000.00000000';
const prisma = new PrismaService();
const accessService = new TradingAccountAccessService(prisma);
const reservationService = new OrderReservationService();
const limitCreateService = new LimitOrderCreateService(prisma, reservationService);
const limitCancelService = new LimitOrderCancelService(prisma, reservationService);
const ordersService = new OrdersService(
  prisma,
  undefined,
  limitCreateService,
  limitCancelService,
  accessService,
);
const candleEvidenceService = new LimitOrderCandleEvidenceService(prisma);
const executionService = new LimitOrderExecutionService(
  prisma,
  candleEvidenceService,
  ordersService,
);
const positionsService = new PositionsService(prisma, accessService);
const walletsService = new WalletsService(prisma, accessService);
const fxService = new FxService(prisma, undefined, undefined, accessService);

function decimalText(value) {
  return value == null ? null : value.toFixed(8);
}

async function expectHttpError(promise, expectedStatus, expectedCode, label) {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    const body = error.getResponse();
    const code = body && body.error ? body.error.code : undefined;
    assert.equal(error.getStatus(), expectedStatus, label + ' status');
    assert.equal(code, expectedCode, label + ' code');
    return;
  }
  assert.fail(label + ': expected HttpException ' + expectedCode);
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

async function createSeason(label, startOffsetMs) {
  const suffix = randomUUID().slice(0, 8);
  const now = new Date();
  return prisma.season.create({
    data: {
      name: TEST_PREFIX + '-' + label + '-' + suffix,
      status: SeasonStatus.active,
      startAt: new Date(now.getTime() - (startOffsetMs ?? 60_000)),
      endAt: new Date(now.getTime() + 86_400_000),
      initialCapitalKrw: CAPITAL,
      tradeFeeRate: '0.001000',
      fxFeeRate: '0.001000',
    },
    select: { id: true },
  });
}

async function createKrwCryptoAsset(label) {
  return prisma.asset.create({
    data: {
      symbol: 'TS' + randomUUID().replace(/-/gu, '').slice(0, 18).toUpperCase(),
      name: TEST_PREFIX + '-' + label,
      market: 'BINANCE',
      assetType: AssetType.crypto,
      currencyCode: CurrencyCode.KRW,
      priceCurrency: CurrencyCode.KRW,
      settlementCurrency: CurrencyCode.KRW,
      isActive: true,
    },
    select: { id: true },
  });
}

// Full trading-capable scenario: user + season + linked account +
// participant + scoped KRW wallet (+ optional USD wallet for FX).
async function createScenario(label, options = {}) {
  const user = options.userId ? { id: options.userId } : await createUser(label);
  const season = await createSeason(label, options.seasonStartOffsetMs);
  const now = new Date();
  const account = await prisma.tradingAccount.create({
    data: {
      userId: user.id,
      mode: TradingAccountMode.season,
      status: options.accountStatus ?? TradingAccountStatus.active,
      initialCapitalKrw: CAPITAL,
      openedAt: now,
    },
    select: { id: true },
  });
  const participant = await prisma.seasonParticipant.create({
    data: {
      seasonId: season.id,
      userId: user.id,
      joinedAt: now,
      participantStatus: options.participantStatus ?? ParticipantStatus.active,
      initialCapitalKrw: CAPITAL,
      totalAssetKrw: CAPITAL,
      totalReturnRate: ZERO,
      maxDrawdown: ZERO,
      tradingAccountId: account.id,
    },
    select: { id: true },
  });
  const krwWallet = await prisma.cashWallet.create({
    data: {
      seasonParticipantId: participant.id,
      tradingAccountId: account.id,
      currencyCode: CurrencyCode.KRW,
      balanceAmount: CAPITAL,
      reservedAmount: ZERO,
    },
    select: { id: true },
  });
  let usdWalletId = null;
  if (options.withUsdWallet) {
    const usdWallet = await prisma.cashWallet.create({
      data: {
        seasonParticipantId: participant.id,
        tradingAccountId: account.id,
        currencyCode: CurrencyCode.USD,
        balanceAmount: ZERO,
        reservedAmount: ZERO,
      },
      select: { id: true },
    });
    usdWalletId = usdWallet.id;
  }

  return {
    userId: user.id,
    seasonId: season.id,
    accountId: account.id,
    participantId: participant.id,
    krwWalletId: krwWallet.id,
    usdWalletId,
  };
}

const cleanupScopes = [];
function trackScope(scope) {
  cleanupScopes.push(scope);
  return scope;
}

async function cleanupAll() {
  const userIds = [...new Set(cleanupScopes.flatMap((s) => s.userIds ?? []))];
  const seasonIds = [...new Set(cleanupScopes.flatMap((s) => s.seasonIds ?? []))];
  const participantIds = [
    ...new Set(cleanupScopes.flatMap((s) => s.participantIds ?? [])),
  ];
  const assetIds = [...new Set(cleanupScopes.flatMap((s) => s.assetIds ?? []))];
  const snapshotIds = [
    ...new Set(cleanupScopes.flatMap((s) => s.snapshotIds ?? [])),
  ];
  const priceSnapshotIds = [
    ...new Set(cleanupScopes.flatMap((s) => s.priceSnapshotIds ?? [])),
  ];

  await prisma.fxExecuteRequest.deleteMany({ where: { userId: { in: userIds } } });
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
  await prisma.quote.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.cashWallet.deleteMany({
    where: { seasonParticipantId: { in: participantIds } },
  });
  await prisma.seasonParticipant.deleteMany({
    where: { id: { in: participantIds } },
  });
  await prisma.tradingAccount.deleteMany({ where: { userId: { in: userIds } } });
  if (priceSnapshotIds.length) {
    await prisma.assetPriceSnapshot.deleteMany({
      where: { id: { in: priceSnapshotIds } },
    });
  }
  if (assetIds.length) {
    await prisma.asset.deleteMany({ where: { id: { in: assetIds } } });
  }
  if (snapshotIds.length) {
    await prisma.fxRateSnapshot.deleteMany({ where: { id: { in: snapshotIds } } });
  }
  await prisma.season.deleteMany({ where: { id: { in: seasonIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

// ---------------------------------------------------------------------------
// T1: index/constraint fingerprints
// ---------------------------------------------------------------------------
async function testIndexFingerprints() {
  const indexes = await prisma.$queryRawUnsafe(
    "SELECT indexname, indexdef FROM pg_indexes WHERE tablename IN ('fx_execute_requests','orders','positions','quotes')",
  );
  const byName = new Map(indexes.map((row) => [row.indexname, row.indexdef]));

  assert.ok(
    !byName.has('fx_execute_requests_user_id_idempotency_key_key'),
    'global FX per-user unique must be dropped',
  );
  const legacyPartial = byName.get(
    'fx_execute_requests_user_id_idempotency_key_legacy_null_key',
  );
  assert.ok(legacyPartial, 'FX legacy partial unique must exist');
  assert.ok(
    legacyPartial.includes('WHERE (trading_account_id IS NULL)'),
    'FX legacy unique must be partial on trading_account_id IS NULL',
  );
  assert.ok(
    byName.has('fx_execute_requests_trading_account_id_idempotency_key_key'),
    'FX account unique must exist',
  );
  assert.ok(
    byName.has('orders_trading_account_id_idempotency_key_key'),
    'order account idempotency unique must exist',
  );
  assert.ok(
    byName.has('positions_trading_account_id_asset_id_key'),
    'position account+asset unique must exist',
  );
  assert.ok(
    byName.has('orders_trading_account_id_submitted_at_idx'),
    'order account list index must exist',
  );
  assert.ok(
    byName.has('quotes_trading_account_id_created_at_idx'),
    'quote account index must exist',
  );
  console.log('[ok] index fingerprints');
}

// ---------------------------------------------------------------------------
// T2: DB-level unique semantics (insert level)
// ---------------------------------------------------------------------------
async function testDbUniqueSemantics() {
  const user = await createUser('unique');
  const a = await createScenario('unique-a', { userId: user.id });
  const b = await createScenario('unique-b', { userId: user.id });
  trackScope({
    userIds: [user.id],
    seasonIds: [a.seasonId, b.seasonId],
    participantIds: [a.participantId, b.participantId],
  });

  const fxKey = 'fx-key-' + randomUUID().slice(0, 8);
  const fxRow = (participantId, accountId, key) => ({
    userId: user.id,
    seasonParticipantId: participantId,
    tradingAccountId: accountId,
    idempotencyKey: key,
    requestHash: 'hash-' + randomUUID().slice(0, 8),
    fromCurrency: CurrencyCode.KRW,
    toCurrency: CurrencyCode.USD,
    sourceAmount: '1000.00000000',
    status: 'succeeded',
    requestedAt: new Date(),
  });

  // Same user + same key on two DIFFERENT accounts: both insert fine.
  await prisma.fxExecuteRequest.create({ data: fxRow(a.participantId, a.accountId, fxKey) });
  await prisma.fxExecuteRequest.create({ data: fxRow(b.participantId, b.accountId, fxKey) });

  // Same account + same key: unique violation.
  await assert.rejects(
    prisma.fxExecuteRequest.create({ data: fxRow(a.participantId, a.accountId, fxKey) }),
    (error) => error.code === 'P2002',
    'same-account FX key must conflict',
  );

  // Legacy NULL rows stay protected by the partial unique.
  const legacyKey = 'fx-legacy-' + randomUUID().slice(0, 8);
  await prisma.fxExecuteRequest.create({ data: fxRow(a.participantId, null, legacyKey) });
  await assert.rejects(
    prisma.fxExecuteRequest.create({ data: fxRow(b.participantId, null, legacyKey) }),
    (error) => error.code === 'P2002',
    'duplicate legacy null FX key must conflict',
  );

  // Orders: same key across two accounts is fine; within one account (or one
  // participant) it conflicts.
  const asset = await createKrwCryptoAsset('unique');
  trackScope({ assetIds: [asset.id] });
  const orderKey = 'order-key-' + randomUUID().slice(0, 8);
  const orderRow = (participantId, accountId, key) => ({
    seasonParticipantId: participantId,
    tradingAccountId: accountId,
    assetId: asset.id,
    side: OrderSide.buy,
    orderType: OrderType.market,
    status: OrderStatus.executed,
    quantity: '1.000000',
    currencyCode: CurrencyCode.KRW,
    idempotencyKey: key,
    requestHash: 'hash',
    submittedAt: new Date(),
  });
  await prisma.order.create({ data: orderRow(a.participantId, a.accountId, orderKey) });
  await prisma.order.create({ data: orderRow(b.participantId, b.accountId, orderKey) });
  await assert.rejects(
    prisma.order.create({ data: orderRow(a.participantId, a.accountId, orderKey) }),
    (error) => error.code === 'P2002',
    'same-account order key must conflict',
  );

  // Positions: one aggregate position per (account, asset).
  await prisma.position.create({
    data: {
      seasonParticipantId: a.participantId,
      tradingAccountId: a.accountId,
      assetId: asset.id,
      quantity: '1.00000000',
      averageCost: '100.00000000',
      currencyCode: CurrencyCode.KRW,
    },
  });
  await assert.rejects(
    prisma.position.create({
      data: {
        seasonParticipantId: b.participantId,
        tradingAccountId: a.accountId,
        assetId: asset.id,
        quantity: '1.00000000',
        averageCost: '100.00000000',
        currencyCode: CurrencyCode.KRW,
      },
    }),
    (error) => error.code === 'P2002',
    'duplicate account+asset position must conflict',
  );
  console.log('[ok] db unique semantics');
}

// ---------------------------------------------------------------------------
// T3: repair-trading-scope (dry-run/apply/idempotent/fail-closed)
// ---------------------------------------------------------------------------
async function testRepairTradingScope() {
  const linked = await createScenario('repair-linked');
  const other = await createScenario('repair-other');
  const orphanUser = await createUser('repair-orphan');
  const orphanSeason = await createSeason('repair-orphan');
  const orphanParticipant = await prisma.seasonParticipant.create({
    data: {
      seasonId: orphanSeason.id,
      userId: orphanUser.id,
      joinedAt: new Date(),
      participantStatus: ParticipantStatus.active,
      initialCapitalKrw: CAPITAL,
      totalAssetKrw: CAPITAL,
      totalReturnRate: ZERO,
      maxDrawdown: ZERO,
      tradingAccountId: null,
    },
    select: { id: true },
  });
  const asset = await createKrwCryptoAsset('repair');
  trackScope({
    userIds: [
      ...new Set([linked.userId, other.userId, orphanUser.id]),
    ],
    seasonIds: [linked.seasonId, other.seasonId, orphanSeason.id],
    participantIds: [
      linked.participantId,
      other.participantId,
      orphanParticipant.id,
    ],
    assetIds: [asset.id],
  });

  // Old-writer rows: null scope with a linked participant (repairable), null
  // scope with an unlinked participant (blocked), and a non-null mismatch
  // (fail-closed, never overwritten).
  const nullOrder = await prisma.order.create({
    data: {
      seasonParticipantId: linked.participantId,
      assetId: asset.id,
      side: OrderSide.buy,
      orderType: OrderType.limit,
      status: OrderStatus.submitted,
      quantity: '2.000000',
      limitPrice: '100.00000000',
      currencyCode: CurrencyCode.KRW,
      reservedAmount: '200.20000000',
      reservationFeeRate: '0.001000',
      submittedAt: new Date(),
    },
    select: { id: true },
  });
  const nullPosition = await prisma.position.create({
    data: {
      seasonParticipantId: linked.participantId,
      assetId: asset.id,
      quantity: '3.00000000',
      averageCost: '90.00000000',
      currencyCode: CurrencyCode.KRW,
      realizedPnl: '1.23000000',
      realizedPnlKrw: '1.23000000',
    },
    select: { id: true },
  });
  const nullQuote = await prisma.quote.create({
    data: {
      userId: linked.userId,
      seasonParticipantId: linked.participantId,
      quoteType: QuoteType.order,
      status: QuoteStatus.active,
      assetId: asset.id,
      side: OrderSide.buy,
      orderType: OrderType.limit,
      quantity: '2.000000',
      limitPrice: '100.00000000',
      currencyCode: CurrencyCode.KRW,
      quotedPrice: '100.00000000',
      maxChangeBps: '30.0000',
      expiresAt: new Date(Date.now() + 15_000),
      requestHash: 'repair-hash',
    },
    select: { id: true },
  });
  const blockedOrder = await prisma.order.create({
    data: {
      seasonParticipantId: orphanParticipant.id,
      assetId: asset.id,
      side: OrderSide.buy,
      orderType: OrderType.market,
      status: OrderStatus.executed,
      quantity: '1.000000',
      currencyCode: CurrencyCode.KRW,
      submittedAt: new Date(),
    },
    select: { id: true },
  });
  const mismatchOrder = await prisma.order.create({
    data: {
      seasonParticipantId: linked.participantId,
      tradingAccountId: other.accountId,
      assetId: asset.id,
      side: OrderSide.sell,
      orderType: OrderType.market,
      status: OrderStatus.executed,
      quantity: '1.000000',
      currencyCode: CurrencyCode.KRW,
      submittedAt: new Date(),
    },
    select: { id: true },
  });

  const fingerprintBefore = await prisma.order.findUnique({
    where: { id: nullOrder.id },
    select: {
      status: true,
      quantity: true,
      limitPrice: true,
      reservedAmount: true,
      reservationFeeRate: true,
    },
  });

  // Dry-run: reports, never writes.
  const dryRun = await repairTradingScope(prisma, { apply: false });
  assert.equal(dryRun.mode, 'dry-run');
  assert.ok(dryRun.models.order.nullRowCount >= 2, 'null orders detected');
  assert.ok(dryRun.models.position.nullRowCount >= 1, 'null positions detected');
  assert.ok(dryRun.models.quote.nullRowCount >= 1, 'null quotes detected');
  assert.ok(
    dryRun.models.order.missingParticipantLinkRows.some(
      (row) => row.rowId === blockedOrder.id,
    ),
    'unlinked-participant order reported',
  );
  assert.ok(
    dryRun.failures.some((f) => f.code === 'TRADING_ACCOUNT_SCOPE_MISMATCH'),
    'mismatch reported in dry-run',
  );
  const stillNull = await prisma.order.findUnique({
    where: { id: nullOrder.id },
    select: { tradingAccountId: true },
  });
  assert.equal(stillNull.tradingAccountId, null, 'dry-run must not write');

  // Apply: backfills only repairable rows; mismatch survives untouched;
  // exit code is 1 while problems remain.
  const apply = await repairTradingScope(prisma, { apply: true });
  assert.equal(apply.mode, 'apply');
  const repairedOrder = await prisma.order.findUnique({
    where: { id: nullOrder.id },
    select: {
      tradingAccountId: true,
      status: true,
      quantity: true,
      limitPrice: true,
      reservedAmount: true,
      reservationFeeRate: true,
    },
  });
  assert.equal(repairedOrder.tradingAccountId, linked.accountId);
  assert.equal(repairedOrder.status, fingerprintBefore.status);
  assert.equal(
    decimalText(repairedOrder.quantity),
    decimalText(fingerprintBefore.quantity),
  );
  assert.equal(
    decimalText(repairedOrder.limitPrice),
    decimalText(fingerprintBefore.limitPrice),
  );
  assert.equal(
    decimalText(repairedOrder.reservedAmount),
    decimalText(fingerprintBefore.reservedAmount),
  );
  const repairedPosition = await prisma.position.findUnique({
    where: { id: nullPosition.id },
    select: { tradingAccountId: true, quantity: true, averageCost: true, realizedPnl: true },
  });
  assert.equal(repairedPosition.tradingAccountId, linked.accountId);
  assert.equal(decimalText(repairedPosition.quantity), '3.00000000');
  assert.equal(decimalText(repairedPosition.averageCost), '90.00000000');
  assert.equal(decimalText(repairedPosition.realizedPnl), '1.23000000');
  const repairedQuote = await prisma.quote.findUnique({
    where: { id: nullQuote.id },
    select: { tradingAccountId: true, status: true, requestHash: true },
  });
  assert.equal(repairedQuote.tradingAccountId, linked.accountId);
  assert.equal(repairedQuote.status, QuoteStatus.active);
  assert.equal(repairedQuote.requestHash, 'repair-hash');
  const blockedAfter = await prisma.order.findUnique({
    where: { id: blockedOrder.id },
    select: { tradingAccountId: true },
  });
  assert.equal(blockedAfter.tradingAccountId, null, 'unlinked row untouched');
  const mismatchAfter = await prisma.order.findUnique({
    where: { id: mismatchOrder.id },
    select: { tradingAccountId: true },
  });
  assert.equal(
    mismatchAfter.tradingAccountId,
    other.accountId,
    'mismatch never overwritten',
  );
  const applyExit = resolveTradingScopeExitCode(apply);
  assert.equal(applyExit.exitCode, 1, 'apply with residue must exit 1');

  // Replay is idempotent: nothing else to backfill for the linked rows.
  const replay = await repairTradingScope(prisma, { apply: true });
  assert.equal(replay.models.position.backfilledCount, 0, 'replay backfills nothing new (positions)');
  assert.equal(replay.models.quote.backfilledCount, 0, 'replay backfills nothing new (quotes)');

  // Order↔quote scope disagreement detection.
  const crossQuote = await prisma.quote.create({
    data: {
      userId: linked.userId,
      seasonParticipantId: linked.participantId,
      tradingAccountId: other.accountId,
      quoteType: QuoteType.order,
      status: QuoteStatus.consumed,
      assetId: asset.id,
      side: OrderSide.buy,
      orderType: OrderType.market,
      quantity: '1.000000',
      currencyCode: CurrencyCode.KRW,
      quotedPrice: '100.00000000',
      maxChangeBps: '30.0000',
      expiresAt: new Date(),
      requestHash: 'cross-hash',
    },
    select: { id: true },
  });
  const crossOrder = await prisma.order.create({
    data: {
      seasonParticipantId: linked.participantId,
      tradingAccountId: linked.accountId,
      quoteId: crossQuote.id,
      assetId: asset.id,
      side: OrderSide.buy,
      orderType: OrderType.market,
      status: OrderStatus.executed,
      quantity: '1.000000',
      currencyCode: CurrencyCode.KRW,
      submittedAt: new Date(),
    },
    select: { id: true },
  });
  const crossReport = await repairTradingScope(prisma, { apply: false });
  assert.ok(
    crossReport.orderQuoteAccountMismatchCount >= 1,
    'order-quote account mismatch detected',
  );
  assert.ok(
    crossReport.failures.some(
      (f) => f.code === 'ORDER_QUOTE_ACCOUNT_SCOPE_MISMATCH',
    ),
    'order-quote mismatch failure reported',
  );

  // Cleanup local anomalies so later fingerprints stay clean.
  await prisma.order.deleteMany({
    where: { id: { in: [mismatchOrder.id, crossOrder.id, blockedOrder.id] } },
  });
  await prisma.quote.deleteMany({ where: { id: crossQuote.id } });
  console.log('[ok] repair-trading-scope');
}

// ---------------------------------------------------------------------------
// T4: limit lifecycle dual-write + scope fail-closed + fill gating
// ---------------------------------------------------------------------------
async function testLimitLifecycleAndFill() {
  const user = await createUser('limit');
  const s = await createScenario('limit-a', { userId: user.id, seasonStartOffsetMs: 1_000 });
  const s2 = await createScenario('limit-b', { userId: user.id, seasonStartOffsetMs: 500 });
  const stranger = await createScenario('limit-stranger');
  // Wallet-less foreign account used purely as a mismatch target: pointing a
  // wallet at an account that already owns one would trip the
  // (tradingAccountId, currencyCode) unique instead of testing scope.
  const foilAccount = await prisma.tradingAccount.create({
    data: {
      userId: stranger.userId,
      mode: TradingAccountMode.season,
      initialCapitalKrw: CAPITAL,
      openedAt: new Date(),
    },
    select: { id: true },
  });
  const asset = await createKrwCryptoAsset('limit');
  trackScope({
    userIds: [user.id, stranger.userId],
    seasonIds: [s.seasonId, s2.seasonId, stranger.seasonId],
    participantIds: [s.participantId, s2.participantId, stranger.participantId],
    assetIds: [asset.id],
  });

  const quoteBody = {
    assetId: asset.id,
    side: 'buy',
    orderType: 'limit',
    quantity: '2',
    limitPrice: '100',
  };

  // Account-scoped limit quote: durable quote rows dual-write the account.
  const quoteResponse = await ordersService.quoteOrderForTradingAccount(
    user.id,
    s.accountId,
    quoteBody,
  );
  const quoteId = quoteResponse.data.quoteId;
  const quoteRow = await prisma.quote.findUnique({
    where: { id: quoteId },
    select: { tradingAccountId: true, seasonParticipantId: true },
  });
  assert.equal(quoteRow.tradingAccountId, s.accountId, 'quote dual-write');
  assert.equal(quoteRow.seasonParticipantId, s.participantId);

  // Account-scoped limit create: order dual-writes; quote consumed with
  // account-conditioned updateMany; reservation applied.
  const createKey = 'limit-key-' + randomUUID().slice(0, 8);
  const createResponse = await ordersService.createOrderForTradingAccount(
    user.id,
    s.accountId,
    { ...quoteBody, quoteId, idempotencyKey: createKey },
  );
  assert.equal(createResponse.data.execution.state, 'submitted');
  const orderId = createResponse.data.order.orderId;
  const orderRow = await prisma.order.findUnique({
    where: { id: orderId },
    select: { tradingAccountId: true, status: true, reservedAmount: true },
  });
  assert.equal(orderRow.tradingAccountId, s.accountId, 'order dual-write');
  const consumedQuote = await prisma.quote.findUnique({
    where: { id: quoteId },
    select: { status: true },
  });
  assert.equal(consumedQuote.status, QuoteStatus.consumed);
  const reservedWallet = await prisma.cashWallet.findUnique({
    where: { id: s.krwWalletId },
    select: { reservedAmount: true },
  });
  assert.equal(decimalText(reservedWallet.reservedAmount), '200.20000000');

  // Replay: same account + same key + same request → the STORED first
  // response (limit creates persist responsePayloadJson verbatim), no new
  // order row and no double reservation.
  const replayResponse = await ordersService.createOrderForTradingAccount(
    user.id,
    s.accountId,
    { ...quoteBody, quoteId, idempotencyKey: createKey },
  );
  assert.equal(replayResponse.data.order.orderId, orderId, 'replay same order');
  assert.equal(replayResponse.data.execution.state, 'submitted');
  const orderCountAfterReplay = await prisma.order.count({
    where: { seasonParticipantId: s.participantId },
  });
  assert.equal(orderCountAfterReplay, 1, 'replay created no new order');
  const walletAfterReplay = await prisma.cashWallet.findUnique({
    where: { id: s.krwWalletId },
    select: { reservedAmount: true },
  });
  assert.equal(
    decimalText(walletAfterReplay.reservedAmount),
    '200.20000000',
    'replay reserved nothing extra',
  );

  // SAME user, DIFFERENT account, SAME idempotency key → independent order.
  const quote2 = await ordersService.quoteOrderForTradingAccount(
    user.id,
    s2.accountId,
    quoteBody,
  );
  const create2 = await ordersService.createOrderForTradingAccount(
    user.id,
    s2.accountId,
    { ...quoteBody, quoteId: quote2.data.quoteId, idempotencyKey: createKey },
  );
  assert.equal(create2.data.execution.state, 'submitted');
  assert.notEqual(create2.data.order.orderId, orderId, 'cross-account key reuse');

  // A quote minted on account A cannot back a create on account B.
  const quote3 = await ordersService.quoteOrderForTradingAccount(
    user.id,
    s.accountId,
    quoteBody,
  );
  await expectHttpError(
    ordersService.createOrderForTradingAccount(user.id, s2.accountId, {
      ...quoteBody,
      quoteId: quote3.data.quoteId,
      idempotencyKey: 'cross-quote-' + randomUUID().slice(0, 8),
    }),
    409,
    'QUOTE_MISMATCH',
    'cross-account quote use',
  );

  // Wallet scope null → quote AND account wallet reads fail closed.
  await prisma.cashWallet.update({
    where: { id: s.krwWalletId },
    data: { tradingAccountId: null },
  });
  await expectHttpError(
    ordersService.quoteOrderForTradingAccount(user.id, s.accountId, quoteBody),
    500,
    'FINANCIAL_SCOPE_REPAIR_REQUIRED',
    'limit quote with null wallet scope',
  );
  await expectHttpError(
    walletsService.getWalletsForTradingAccount(user.id, s.accountId),
    500,
    'FINANCIAL_SCOPE_REPAIR_REQUIRED',
    'account wallet read with null wallet scope',
  );
  await prisma.cashWallet.update({
    where: { id: s.krwWalletId },
    data: { tradingAccountId: foilAccount.id },
  });
  await expectHttpError(
    ordersService.quoteOrderForTradingAccount(user.id, s.accountId, quoteBody),
    500,
    'FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH',
    'limit quote with mismatched wallet scope',
  );
  await prisma.cashWallet.update({
    where: { id: s.krwWalletId },
    data: { tradingAccountId: s.accountId },
  });

  // Cancel scope: a null ORDER scope blocks the release (rollback: order
  // stays submitted, reservation untouched); repaired scope cancels cleanly.
  await prisma.order.update({
    where: { id: orderId },
    data: { tradingAccountId: null },
  });
  await expectHttpError(
    ordersService.cancelOrder(user.id, orderId),
    500,
    'TRADING_SCOPE_REPAIR_REQUIRED',
    'cancel with null order scope',
  );
  let afterBlockedCancel = await prisma.order.findUnique({
    where: { id: orderId },
    select: { status: true },
  });
  assert.equal(afterBlockedCancel.status, OrderStatus.submitted);
  let walletAfterBlockedCancel = await prisma.cashWallet.findUnique({
    where: { id: s.krwWalletId },
    select: { reservedAmount: true },
  });
  assert.equal(
    decimalText(walletAfterBlockedCancel.reservedAmount),
    '200.20000000',
    'reservation untouched by blocked cancel',
  );
  await prisma.order.update({
    where: { id: orderId },
    data: { tradingAccountId: s.accountId },
  });

  // Wallet scope null blocks the cancel too (repair before release).
  await prisma.cashWallet.update({
    where: { id: s.krwWalletId },
    data: { tradingAccountId: null },
  });
  await expectHttpError(
    ordersService.cancelOrder(user.id, orderId),
    500,
    'FINANCIAL_SCOPE_REPAIR_REQUIRED',
    'cancel with null wallet scope',
  );
  await prisma.cashWallet.update({
    where: { id: s.krwWalletId },
    data: { tradingAccountId: s.accountId },
  });

  // Account-scoped cancel: another account's orderId is 404; the right one
  // cancels and releases exactly once.
  await expectHttpError(
    ordersService.cancelOrderForTradingAccount(user.id, s2.accountId, orderId),
    404,
    'ORDER_NOT_FOUND',
    'cross-account cancel',
  );
  const cancelResponse = await ordersService.cancelOrderForTradingAccount(
    user.id,
    s.accountId,
    orderId,
  );
  assert.equal(cancelResponse.data.execution.alreadyCanceled, false);
  assert.equal(
    cancelResponse.data.execution.reservedAmountReleased,
    '200.20000000',
  );
  const cancelReplay = await ordersService.cancelOrderForTradingAccount(
    user.id,
    s.accountId,
    orderId,
  );
  assert.equal(cancelReplay.data.execution.alreadyCanceled, true);
  const walletAfterCancel = await prisma.cashWallet.findUnique({
    where: { id: s.krwWalletId },
    select: { reservedAmount: true },
  });
  assert.equal(decimalText(walletAfterCancel.reservedAmount), ZERO);

  // Fill gating: suspended account skips; scope mismatch rolls back; active
  // account fills with full dual-write.
  const fillQuote = await ordersService.quoteOrderForTradingAccount(
    user.id,
    s.accountId,
    quoteBody,
  );
  const fillCreate = await ordersService.createOrderForTradingAccount(
    user.id,
    s.accountId,
    {
      ...quoteBody,
      quoteId: fillQuote.data.quoteId,
      idempotencyKey: 'fill-key-' + randomUUID().slice(0, 8),
    },
  );
  const fillOrderId = fillCreate.data.order.orderId;
  const priceSnapshot = await prisma.assetPriceSnapshot.create({
    data: {
      assetId: asset.id,
      price: '90.00000000',
      currencyCode: CurrencyCode.KRW,
      sourceType: 'admin_manual',
      sourceName: TEST_PREFIX,
      effectiveAt: new Date(Date.now() - 1_000),
      capturedAt: new Date(Date.now() - 1_000),
    },
    select: { id: true },
  });
  trackScope({ priceSnapshotIds: [priceSnapshot.id] });
  const fillPlan = {
    path: 'snapshot',
    executedPrice: new (require('./src/generated/prisma/client').Prisma.Decimal)(
      '90.00000000',
    ),
    assetPriceSnapshotId: priceSnapshot.id,
  };

  await prisma.tradingAccount.update({
    where: { id: s.accountId },
    data: { status: TradingAccountStatus.suspended },
  });
  const suspendedOutcome = await executionService.fillLimitBuyOrder({
    orderId: fillOrderId,
    now: new Date(),
    plan: fillPlan,
  });
  assert.equal(suspendedOutcome.state, 'skipped');
  assert.equal(suspendedOutcome.reason, 'account_not_active');
  const suspendedOrder = await prisma.order.findUnique({
    where: { id: fillOrderId },
    select: { status: true },
  });
  assert.equal(suspendedOrder.status, OrderStatus.submitted);
  await prisma.tradingAccount.update({
    where: { id: s.accountId },
    data: { status: TradingAccountStatus.active },
  });

  await prisma.cashWallet.update({
    where: { id: s.krwWalletId },
    data: { tradingAccountId: foilAccount.id },
  });
  await assert.rejects(
    executionService.fillLimitBuyOrder({
      orderId: fillOrderId,
      now: new Date(),
      plan: fillPlan,
    }),
    (error) =>
      error instanceof HttpException &&
      error.getResponse().error.code === 'FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH',
    'fill with mismatched wallet scope must fail',
  );
  const orderAfterBlockedFill = await prisma.order.findUnique({
    where: { id: fillOrderId },
    select: { status: true },
  });
  assert.equal(
    orderAfterBlockedFill.status,
    OrderStatus.submitted,
    'blocked fill rolls back',
  );
  await prisma.cashWallet.update({
    where: { id: s.krwWalletId },
    data: { tradingAccountId: s.accountId },
  });

  const filled = await executionService.fillLimitBuyOrder({
    orderId: fillOrderId,
    now: new Date(),
    plan: fillPlan,
  });
  assert.equal(filled.state, 'filled');
  const filledOrder = await prisma.order.findUnique({
    where: { id: fillOrderId },
    select: { status: true, tradingAccountId: true, netAmount: true },
  });
  assert.equal(filledOrder.status, OrderStatus.executed);
  assert.equal(filledOrder.tradingAccountId, s.accountId);
  assert.equal(decimalText(filledOrder.netAmount), '180.18000000');
  const filledPosition = await prisma.position.findUnique({
    where: {
      seasonParticipantId_assetId: {
        seasonParticipantId: s.participantId,
        assetId: asset.id,
      },
    },
    select: { tradingAccountId: true, quantity: true },
  });
  assert.equal(filledPosition.tradingAccountId, s.accountId, 'position dual-write');
  assert.equal(decimalText(filledPosition.quantity), '2.00000000');
  const fillLedger = await prisma.walletTransaction.findFirst({
    where: { referenceId: fillOrderId },
    select: { tradingAccountId: true },
  });
  assert.equal(fillLedger.tradingAccountId, s.accountId, 'ledger dual-write');
  const walletAfterFill = await prisma.cashWallet.findUnique({
    where: { id: s.krwWalletId },
    select: { reservedAmount: true },
  });
  assert.equal(decimalText(walletAfterFill.reservedAmount), ZERO);

  // A mis-scoped existing position blocks the next fill (rollback).
  const blockQuote = await ordersService.quoteOrderForTradingAccount(
    user.id,
    s.accountId,
    quoteBody,
  );
  const blockCreate = await ordersService.createOrderForTradingAccount(
    user.id,
    s.accountId,
    {
      ...quoteBody,
      quoteId: blockQuote.data.quoteId,
      idempotencyKey: 'fill-block-' + randomUUID().slice(0, 8),
    },
  );
  await prisma.position.updateMany({
    where: { seasonParticipantId: s.participantId, assetId: asset.id },
    data: { tradingAccountId: foilAccount.id },
  });
  await assert.rejects(
    executionService.fillLimitBuyOrder({
      orderId: blockCreate.data.order.orderId,
      now: new Date(),
      plan: fillPlan,
    }),
    (error) =>
      error instanceof HttpException &&
      error.getResponse().error.code === 'TRADING_ACCOUNT_SCOPE_MISMATCH',
    'fill with mismatched position scope must fail',
  );
  const blockedFillOrder = await prisma.order.findUnique({
    where: { id: blockCreate.data.order.orderId },
    select: { status: true },
  });
  assert.equal(blockedFillOrder.status, OrderStatus.submitted);
  await prisma.position.updateMany({
    where: { seasonParticipantId: s.participantId, assetId: asset.id },
    data: { tradingAccountId: s.accountId },
  });
  await ordersService.cancelOrderForTradingAccount(
    user.id,
    s.accountId,
    blockCreate.data.order.orderId,
  );

  // General account: no trading, empty reads, nothing auto-created.
  const generalAccount = await prisma.tradingAccount.create({
    data: {
      userId: user.id,
      mode: TradingAccountMode.general,
      initialCapitalKrw: CAPITAL,
      openedAt: new Date(),
    },
    select: { id: true },
  });
  await expectHttpError(
    ordersService.quoteOrderForTradingAccount(user.id, generalAccount.id, quoteBody),
    409,
    'GENERAL_ACCOUNT_TRADING_NOT_IMPLEMENTED',
    'general account quote',
  );
  await expectHttpError(
    ordersService.createOrderForTradingAccount(user.id, generalAccount.id, {
      ...quoteBody,
      quoteId: 'irrelevant',
      idempotencyKey: 'general-key',
    }),
    409,
    'GENERAL_ACCOUNT_TRADING_NOT_IMPLEMENTED',
    'general account create',
  );
  // 작업 6 보완 2: this general account was created RAW (no wallets, no
  // initial grant), i.e. exactly the structurally incomplete shape the
  // account-open endpoint can never produce. It used to read as a normal
  // empty wallet list; it must now fail closed instead of presenting missing
  // wallets and a missing grant as "nothing here yet".
  await expectHttpError(
    walletsService.getWalletsForTradingAccount(user.id, generalAccount.id),
    500,
    'GENERAL_ACCOUNT_INTEGRITY',
    'incomplete general account wallet read',
  );
  await expectHttpError(
    walletsService.getWalletTransactionsForTradingAccount(
      user.id,
      generalAccount.id,
    ),
    500,
    'GENERAL_ACCOUNT_INTEGRITY',
    'incomplete general account ledger read',
  );
  const generalPositions = await positionsService.getPositionsForTradingAccount(
    user.id,
    generalAccount.id,
  );
  assert.equal(
    generalPositions.data.positions.length,
    0,
    'general positions empty',
  );
  const generalWalletCount = await prisma.cashWallet.count({
    where: { tradingAccountId: generalAccount.id },
  });
  assert.equal(generalWalletCount, 0, 'GET created no general wallet');

  console.log('[ok] limit lifecycle + fill scope');
  return { user, s, s2, stranger, foilAccount, asset, filledOrderId: fillOrderId };
}

// ---------------------------------------------------------------------------
// T5: account-scoped order/position reads + legacy equivalence + probes
// ---------------------------------------------------------------------------
async function testAccountReads(ctx) {
  const { user, s, s2, stranger, asset } = ctx;

  // Legacy (seasonId-pinned) vs account-scoped list equivalence.
  const legacyOrders = await ordersService.getOrders(user.id, {
    seasonId: s.seasonId,
  });
  const accountOrders = await ordersService.getOrdersForTradingAccount(
    user.id,
    s.accountId,
  );
  const legacyOrderIds = legacyOrders.data.orders.map((o) => o.orderId).sort();
  const accountOrderIds = accountOrders.data.orders
    .map((o) => o.orderId)
    .sort();
  assert.deepEqual(accountOrderIds, legacyOrderIds, 'order list equivalence');
  assert.ok(accountOrderIds.length >= 2, 'account list non-empty');

  const detail = await ordersService.getOrderForTradingAccount(
    user.id,
    s.accountId,
    ctx.filledOrderId,
  );
  assert.equal(detail.data.order.orderId, ctx.filledOrderId);

  // Foreign/unknown accounts and foreign orderIds are the same 404s.
  await expectHttpError(
    ordersService.getOrdersForTradingAccount(stranger.userId, s.accountId),
    404,
    'TRADING_ACCOUNT_NOT_FOUND',
    'foreign account list',
  );
  await expectHttpError(
    ordersService.getOrdersForTradingAccount(user.id, randomUUID()),
    404,
    'TRADING_ACCOUNT_NOT_FOUND',
    'unknown account list',
  );
  await expectHttpError(
    ordersService.getOrderForTradingAccount(user.id, s2.accountId, ctx.filledOrderId),
    404,
    'ORDER_NOT_FOUND',
    'cross-account order detail',
  );
  await expectHttpError(
    ordersService.getOrdersForTradingAccount(undefined, s.accountId),
    401,
    'UNAUTHORIZED',
    'unauthenticated order list',
  );

  // Suspended/closed accounts stay readable.
  await prisma.tradingAccount.update({
    where: { id: s.accountId },
    data: { status: TradingAccountStatus.suspended },
  });
  const suspendedList = await ordersService.getOrdersForTradingAccount(
    user.id,
    s.accountId,
  );
  assert.equal(suspendedList.data.orders.length, accountOrderIds.length);
  const suspendedPositions = await positionsService.getPositionsForTradingAccount(
    user.id,
    s.accountId,
  );
  assert.ok(suspendedPositions.data.positions.length >= 1);
  await prisma.tradingAccount.update({
    where: { id: s.accountId },
    data: { status: TradingAccountStatus.closed, closedAt: new Date() },
  });
  const closedList = await ordersService.getOrdersForTradingAccount(
    user.id,
    s.accountId,
  );
  assert.equal(closedList.data.orders.length, accountOrderIds.length);
  await prisma.tradingAccount.update({
    where: { id: s.accountId },
    data: { status: TradingAccountStatus.active, closedAt: null },
  });

  // Position equivalence + integrity probes.
  const legacyPositions = await positionsService.getPositions(user.id, {
    seasonId: s.seasonId,
  });
  const accountPositions = await positionsService.getPositionsForTradingAccount(
    user.id,
    s.accountId,
  );
  assert.deepEqual(
    accountPositions.data.positions.map((p) => p.positionId).sort(),
    legacyPositions.data.positions.map((p) => p.positionId).sort(),
    'position list equivalence',
  );

  await prisma.position.updateMany({
    where: { seasonParticipantId: s.participantId, assetId: asset.id },
    data: { tradingAccountId: null },
  });
  await expectHttpError(
    positionsService.getPositionsForTradingAccount(user.id, s.accountId),
    500,
    'FINANCIAL_SCOPE_REPAIR_REQUIRED',
    'null-scope position read',
  );
  await prisma.position.updateMany({
    where: { seasonParticipantId: s.participantId, assetId: asset.id },
    data: { tradingAccountId: ctx.foilAccount.id },
  });
  await expectHttpError(
    positionsService.getPositionsForTradingAccount(user.id, s.accountId),
    500,
    'TRADING_ACCOUNT_SCOPE_MISMATCH',
    'mismatched position read',
  );
  await prisma.position.updateMany({
    where: { seasonParticipantId: s.participantId, assetId: asset.id },
    data: { tradingAccountId: s.accountId },
  });

  // Null-scope order rows must not silently vanish from account lists.
  const hiddenOrder = await prisma.order.create({
    data: {
      seasonParticipantId: s.participantId,
      assetId: asset.id,
      side: OrderSide.buy,
      orderType: OrderType.market,
      status: OrderStatus.executed,
      quantity: '1.000000',
      currencyCode: CurrencyCode.KRW,
      submittedAt: new Date(),
    },
    select: { id: true },
  });
  await expectHttpError(
    ordersService.getOrdersForTradingAccount(user.id, s.accountId),
    500,
    'FINANCIAL_SCOPE_REPAIR_REQUIRED',
    'null-scope order read',
  );
  await prisma.order.delete({ where: { id: hiddenOrder.id } });

  console.log('[ok] account-scoped reads');
}

// ---------------------------------------------------------------------------
// T6: FX same-user cross-account idempotency + legacy replay pinning
// ---------------------------------------------------------------------------
async function testFxCrossAccountIdempotency() {
  const user = await createUser('fx');
  const a = await createScenario('fx-a', { userId: user.id, withUsdWallet: true });
  const b = await createScenario('fx-b', { userId: user.id, withUsdWallet: true });
  trackScope({
    userIds: [user.id],
    seasonIds: [a.seasonId, b.seasonId],
    participantIds: [a.participantId, b.participantId],
  });
  const snapshot = await prisma.fxRateSnapshot.create({
    data: {
      baseCurrency: CurrencyCode.USD,
      quoteCurrency: CurrencyCode.KRW,
      sourceType: FxRateSourceType.provider_api,
      sourceName: 'exchange_rate_api',
      rate: '1000.00000000',
      effectiveAt: new Date(Date.now() - 1_000),
      capturedAt: new Date(Date.now() - 1_000),
      note: TEST_PREFIX + ' fx fixture',
    },
    select: { id: true },
  });
  trackScope({ snapshotIds: [snapshot.id] });

  async function createFxQuoteFor(scenario, sourceAmount) {
    const requestHash = computeFxQuoteRequestHash({
      userId: user.id,
      seasonParticipantId: scenario.participantId,
      fromCurrency: CurrencyCode.KRW,
      toCurrency: CurrencyCode.USD,
      sourceAmount,
    });
    const quote = await prisma.quote.create({
      data: {
        userId: user.id,
        seasonParticipantId: scenario.participantId,
        tradingAccountId: scenario.accountId,
        quoteType: QuoteType.fx,
        status: QuoteStatus.active,
        fromCurrency: CurrencyCode.KRW,
        toCurrency: CurrencyCode.USD,
        sourceAmount,
        targetAmount: '0.99900000',
        quotedRate: '1000.00000000',
        fxRateSnapshotId: snapshot.id,
        maxChangeBps: '30.0000',
        expiresAt: new Date(Date.now() + 15_000),
        requestHash,
      },
      select: { id: true },
    });
    return quote.id;
  }

  const sharedKey = 'fx-shared-' + randomUUID().slice(0, 8);
  const bodyA = {
    fromCurrency: CurrencyCode.KRW,
    toCurrency: CurrencyCode.USD,
    sourceAmount: '1000.00000000',
    quoteId: await createFxQuoteFor(a, '1000.00000000'),
    idempotencyKey: sharedKey,
  };
  const responseA = await fxService.executeForTradingAccount(
    user.id,
    a.accountId,
    bodyA,
  );
  assert.equal(responseA.success, true, 'FX execute on account A');

  const bodyB = {
    fromCurrency: CurrencyCode.KRW,
    toCurrency: CurrencyCode.USD,
    sourceAmount: '1000.00000000',
    quoteId: await createFxQuoteFor(b, '1000.00000000'),
    idempotencyKey: sharedKey,
  };
  const responseB = await fxService.executeForTradingAccount(
    user.id,
    b.accountId,
    bodyB,
  );
  assert.equal(
    responseB.success,
    true,
    'SAME user + SAME key on a different account must succeed',
  );
  assert.notEqual(
    responseB.data.exchangeId,
    responseA.data.exchangeId,
    'independent executions',
  );

  // Same account + same key replays the stored first response.
  const replayA = await fxService.executeForTradingAccount(
    user.id,
    a.accountId,
    bodyA,
  );
  assert.equal(replayA.data.exchangeId, responseA.data.exchangeId, 'replay');

  // Legacy null-scope rows replay ONLY for their own participant.
  const legacyKey = 'fx-legacy-' + randomUUID().slice(0, 8);
  const legacyBody = {
    fromCurrency: CurrencyCode.KRW,
    toCurrency: CurrencyCode.USD,
    sourceAmount: '500.00000000',
    quoteId: 'legacy-not-used',
    idempotencyKey: legacyKey,
  };
  const preflight = preflightFxExecuteRequest(legacyBody, {
    userId: user.id,
    seasonParticipantId: a.participantId,
  });
  assert.equal(preflight.ok, true);
  const legacyMarker = { success: true, data: { marker: 'legacy-replay' } };
  await prisma.fxExecuteRequest.create({
    data: {
      userId: user.id,
      seasonParticipantId: a.participantId,
      tradingAccountId: null,
      idempotencyKey: legacyKey,
      requestHash: preflight.value.requestHash,
      fromCurrency: CurrencyCode.KRW,
      toCurrency: CurrencyCode.USD,
      sourceAmount: '500.00000000',
      status: 'succeeded',
      responsePayloadJson: legacyMarker,
      requestedAt: new Date(),
      completedAt: new Date(),
    },
  });
  const legacyReplay = await fxService.executeForTradingAccount(
    user.id,
    a.accountId,
    legacyBody,
  );
  assert.equal(
    legacyReplay.data.marker,
    'legacy-replay',
    'legacy null row replays for its own participant',
  );

  // Account B never sees A's legacy row: the same key runs independently.
  const bodyBLegacyKey = {
    fromCurrency: CurrencyCode.KRW,
    toCurrency: CurrencyCode.USD,
    sourceAmount: '500.00000000',
    quoteId: await createFxQuoteFor(b, '500.00000000'),
    idempotencyKey: legacyKey,
  };
  const responseBLegacyKey = await fxService.executeForTradingAccount(
    user.id,
    b.accountId,
    bodyBLegacyKey,
  );
  assert.equal(responseBLegacyKey.success, true);
  assert.equal(
    responseBLegacyKey.data.marker,
    undefined,
    'another participant legacy row is never replayed',
  );

  // FX execute fails closed on a null source wallet scope.
  await prisma.cashWallet.update({
    where: { id: a.krwWalletId },
    data: { tradingAccountId: null },
  });
  await expectHttpError(
    fxService.executeForTradingAccount(user.id, a.accountId, {
      fromCurrency: CurrencyCode.KRW,
      toCurrency: CurrencyCode.USD,
      sourceAmount: '100.00000000',
      quoteId: await createFxQuoteFor(a, '100.00000000'),
      idempotencyKey: 'fx-null-' + randomUUID().slice(0, 8),
    }),
    500,
    'FINANCIAL_SCOPE_REPAIR_REQUIRED',
    'FX execute with null source wallet scope',
  );
  await prisma.cashWallet.update({
    where: { id: a.krwWalletId },
    data: { tradingAccountId: a.accountId },
  });

  console.log('[ok] fx cross-account idempotency');
}

async function main() {
  try {
    await testIndexFingerprints();
    await testDbUniqueSemantics();
    await testRepairTradingScope();
    const ctx = await testLimitLifecycleAndFill();
    await testAccountReads(ctx);
    await testFxCrossAccountIdempotency();
    console.log('trading scope db integration ok');
  } finally {
    await cleanupAll();
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;
