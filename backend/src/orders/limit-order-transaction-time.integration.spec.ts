import { spawnSync } from 'node:child_process';

const RUN_DB_INTEGRATION =
  process.env.LIMIT_ORDER_RESERVATION_DB_INTEGRATION === '1';
const itDbIntegration = RUN_DB_INTEGRATION ? it : it.skip;

describe('Limit order post-lock transaction clock DB integration', () => {
  itDbIntegration(
    'rechecks quote TTL, season end, and stock close after row-lock waits',
    () => {
      const result = spawnSync(
        'pnpm',
        ['tsx', '-e', LIMIT_ORDER_TRANSACTION_TIME_RUNNER],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            LIMIT_ORDER_ENABLED: 'true',
            LIMIT_ORDER_AUTO_EXECUTION_ENABLED: 'false',
          },
          encoding: 'utf8',
          timeout: 180_000,
        },
      );

      if (result.status !== 0) {
        throw new Error(
          [
            'Limit order transaction-time DB integration runner failed.',
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
          ].join('\n'),
        );
      }
      for (const name of [
        'quote expired while create waited',
        'season ended while create waited',
        'stock market closed while create waited',
      ]) {
        expect(result.stdout).toContain(`ok ${name}`);
      }
      expect(result.stdout).toContain(
        'limit order transaction-time db integration ok',
      );
    },
    190_000,
  );
});

const LIMIT_ORDER_TRANSACTION_TIME_RUNNER = `
import 'dotenv/config';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import {
  AssetType,
  CurrencyCode,
  OrderSide,
  OrderType,
  ParticipantStatus,
  QuoteStatus,
  QuoteType,
  SeasonStatus,
} from './src/generated/prisma/client';
import { PrismaService } from './src/prisma/prisma.service';
import { OrdersService } from './src/orders/orders.service';
import { LimitOrderCreateService } from './src/orders/limit-order-create.service';
import { LimitOrderCancelService } from './src/orders/limit-order-cancel.service';
import { OrderReservationService } from './src/orders/order-reservation.service';
import { computeOrderQuoteRequestHash } from './src/providers/durable-quote.policy';
import {
  applyMarketSessionOverrideSnapshot,
  resetMarketSessionOverrideStoreForTest,
} from './src/orders/market-calendar/market-session-override.store';
import { getZonedParts } from './src/providers/kis/candles/kis-candle-time';
import { getAssetTradingStatus } from './src/orders/market-hours.policy';

const prisma = new PrismaService();
const reservation = new OrderReservationService();
const createService = new LimitOrderCreateService(prisma, reservation);
const cancelService = new LimitOrderCancelService(prisma, reservation);
const orders = new OrdersService(prisma, undefined, createService, cancelService);
const PREFIX = 'limit-order-transaction-time';
const ZERO = '0.00000000';
const LIMIT = '100.00000000';
const QUANTITY = '1.000000';
const RESERVED = '100.10000000';

async function main() {
  await prisma.$connect();
  try {
    await run('quote expired while create waited', testQuoteExpiry);
    await run('season ended while create waited', testSeasonEnd);
    await run('stock market closed while create waited', testMarketClose);
    console.log('limit order transaction-time db integration ok');
  } finally {
    resetMarketSessionOverrideStoreForTest();
    await prisma.$disconnect();
  }
}

async function run(name, fn) {
  await fn();
  console.log('ok ' + name);
}

async function dbNow(client = prisma) {
  const rows = await client.$queryRawUnsafe('SELECT clock_timestamp() AS now');
  return rows[0].now;
}

async function createScenario(label, options = {}) {
  const suffix = Date.now() + '-' + Math.random().toString(16).slice(2);
  const now = await dbNow();
  const user = await prisma.user.create({
    data: {
      email: PREFIX + '-' + label + '-' + suffix + '@example.com',
      passwordHash: 'integration-test-only',
      nickname: (PREFIX + '-' + label + '-' + suffix).slice(0, 40),
    },
    select: { id: true },
  });
  const season = await prisma.season.create({
    data: {
      name: PREFIX + '-' + label + '-' + suffix,
      status: SeasonStatus.active,
      startAt: new Date(now.getTime() - 1000),
      endAt: options.endAt ?? new Date(now.getTime() + 86_400_000),
      initialCapitalKrw: '1000000.00000000',
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
      initialCapitalKrw: '1000000.00000000',
      totalAssetKrw: '1000000.00000000',
      totalReturnRate: ZERO,
      maxDrawdown: ZERO,
    },
    select: { id: true },
  });
  const wallet = await prisma.cashWallet.create({
    data: {
      seasonParticipantId: participant.id,
      currencyCode: CurrencyCode.KRW,
      balanceAmount: '1000000.00000000',
      reservedAmount: ZERO,
    },
    select: { id: true },
  });
  const asset = await prisma.asset.create({
    data: {
      symbol: (PREFIX + '-' + suffix).slice(0, 32),
      name: PREFIX + '-' + label,
      market: options.market ?? 'BINANCE',
      assetType: options.assetType ?? AssetType.crypto,
      currencyCode: CurrencyCode.KRW,
      priceCurrency: CurrencyCode.KRW,
      settlementCurrency: CurrencyCode.KRW,
      isActive: true,
    },
    select: { id: true },
  });
  return {
    userId: user.id,
    seasonId: season.id,
    participantId: participant.id,
    walletId: wallet.id,
    assetId: asset.id,
  };
}

async function createQuote(scenario, expiresAt) {
  const requestHash = computeOrderQuoteRequestHash({
    userId: scenario.userId,
    seasonParticipantId: scenario.participantId,
    assetId: scenario.assetId,
    side: 'buy',
    orderType: 'limit',
    quantity: QUANTITY,
    limitPrice: LIMIT,
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
      limitPrice: LIMIT,
      currencyCode: CurrencyCode.KRW,
      quotedPrice: LIMIT,
      quotedFeeRate: '0.001000',
      quotedGrossAmount: '100.00000000',
      quotedFeeAmount: '0.10000000',
      quotedReservedAmount: RESERVED,
      maxChangeBps: '50.0000',
      expiresAt,
      requestHash,
    },
    select: { id: true },
  });
  return quote.id;
}

function createBody(scenario, quoteId, key) {
  return {
    quoteId,
    assetId: scenario.assetId,
    side: 'buy',
    orderType: 'limit',
    quantity: QUANTITY,
    limitPrice: LIMIT,
    idempotencyKey: key,
  };
}

async function openClient(name) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query("SELECT set_config('application_name', $1, false)", [name]);
  return client;
}

async function waitForBlockedParticipantRead(observer) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const row = await observer.query(
      "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%season_participants%' LIMIT 1",
    );
    if (row.rowCount > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('create never reached the participant row-lock barrier');
}

async function waitUntilAfter(observer, target) {
  for (;;) {
    const row = await observer.query('SELECT clock_timestamp() AS now');
    if (row.rows[0].now.getTime() > target.getTime()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function runBlockedCreate(scenario, quoteId, key, target, expectedCode, afterBoundary) {
  const blocker = await openClient('limit-time-blocker-' + key);
  const observer = await openClient('limit-time-observer-' + key);
  try {
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT id FROM season_participants WHERE id = $1 FOR UPDATE',
      [scenario.participantId],
    );
    const createPromise = orders.createOrder(
      scenario.userId,
      createBody(scenario, quoteId, key),
    );
    await waitForBlockedParticipantRead(observer);
    await waitUntilAfter(observer, target);
    if (afterBoundary) await afterBoundary();
    await blocker.query('COMMIT');

    let code = 'NO_ERROR';
    try {
      await createPromise;
    } catch (error) {
      const response = typeof error?.getResponse === 'function' ? error.getResponse() : null;
      code = response?.error?.code ?? (error instanceof Error ? error.message : String(error));
    }
    assert.equal(code, expectedCode);
    const wallet = await prisma.cashWallet.findUnique({
      where: { id: scenario.walletId },
      select: { reservedAmount: true },
    });
    assert.equal(wallet.reservedAmount.toFixed(8), ZERO);
    assert.equal(
      await prisma.order.count({ where: { seasonParticipantId: scenario.participantId } }),
      0,
    );
    const quote = await prisma.quote.findUnique({
      where: { id: quoteId },
      select: { consumedAt: true },
    });
    assert.equal(quote.consumedAt, null);
  } finally {
    await blocker.query('ROLLBACK').catch(() => undefined);
    await blocker.end();
    await observer.end();
  }
}

async function cleanup(scenario) {
  await prisma.order.deleteMany({ where: { seasonParticipantId: scenario.participantId } });
  await prisma.quote.deleteMany({ where: { seasonParticipantId: scenario.participantId } });
  await prisma.cashWallet.deleteMany({ where: { seasonParticipantId: scenario.participantId } });
  await prisma.seasonParticipant.deleteMany({ where: { id: scenario.participantId } });
  await prisma.assetPriceSnapshot.deleteMany({ where: { assetId: scenario.assetId } });
  await prisma.asset.deleteMany({ where: { id: scenario.assetId } });
  await prisma.season.deleteMany({ where: { id: scenario.seasonId } });
  await prisma.user.deleteMany({ where: { id: scenario.userId } });
}

async function testQuoteExpiry() {
  const scenario = await createScenario('quote-expiry');
  try {
    const now = await dbNow();
    const expiresAt = new Date(now.getTime() + 1000);
    const quoteId = await createQuote(scenario, expiresAt);
    await runBlockedCreate(scenario, quoteId, 'quote-expiry', expiresAt, 'QUOTE_EXPIRED');
  } finally {
    await cleanup(scenario);
  }
}

async function testSeasonEnd() {
  const now = await dbNow();
  const endAt = new Date(now.getTime() + 1200);
  const scenario = await createScenario('season-end', { endAt });
  try {
    const quoteId = await createQuote(scenario, new Date(now.getTime() + 15_000));
    await runBlockedCreate(scenario, quoteId, 'season-end', endAt, 'SEASON_ENDED');
  } finally {
    await cleanup(scenario);
  }
}

function pad(value) {
  return String(value).padStart(2, '0');
}

async function testMarketClose() {
  const now = await dbNow();
  const closeAt = new Date(now.getTime() + 5000);
  const parts = getZonedParts(closeAt, 'Asia/Seoul');
  const localDate = parts.year + '-' + pad(parts.month) + '-' + pad(parts.day);
  applyMarketSessionOverrideSnapshot(
    [{
      market: 'KRX',
      localDate,
      overrideType: 'custom',
      openTime: '000000',
      closeTime: pad(parts.hour) + pad(parts.minute) + pad(parts.second),
      reason: 'deterministic integration close barrier',
    }],
    now,
  );
  assert.deepEqual(
    getAssetTradingStatus(
      { assetType: AssetType.domestic_stock, market: 'KRX' },
      now,
    ),
    { tradable: true },
  );
  const scenario = await createScenario('market-close', {
    market: 'KRX',
    assetType: AssetType.domestic_stock,
  });
  try {
    const quoteId = await createQuote(scenario, new Date(now.getTime() + 20_000));
    await runBlockedCreate(
      scenario,
      quoteId,
      'market-close',
      closeAt,
      'MARKET_CLOSED',
      async () => {
        const status = getAssetTradingStatus(
          { assetType: AssetType.domestic_stock, market: 'KRX' },
          await dbNow(),
        );
        assert.equal(status.tradable, false);
        assert.equal(status.reason, 'MARKET_CLOSED');
      },
    );
  } finally {
    resetMarketSessionOverrideStoreForTest();
    await cleanup(scenario);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;
