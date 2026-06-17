import { spawnSync } from 'node:child_process';

const RUN_MVP_FLOW_DB_SMOKE = process.env.MVP_FLOW_DB_SMOKE === '1';
const itDbSmoke = RUN_MVP_FLOW_DB_SMOKE ? it : it.skip;

describe('MVP real PostgreSQL service-composed flow smoke', () => {
  itDbSmoke(
    'verifies provider-key-free admin_manual service-composed MVP flow against real PostgreSQL; not provider/scheduler/settlement coverage',
    () => {
      const result = spawnSync('pnpm', ['tsx', '-e', MVP_FLOW_DB_RUNNER], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          JWT_ACCESS_SECRET:
            process.env.JWT_ACCESS_SECRET || 'mvp-flow-db-smoke-secret',
          JWT_ACCESS_TTL: process.env.JWT_ACCESS_TTL || '15m',
          REFRESH_TOKEN_TTL: process.env.REFRESH_TOKEN_TTL || '7d',
        },
        encoding: 'utf8',
        timeout: 180_000,
      });

      if (result.status !== 0) {
        throw new Error(
          [
            'MVP flow DB smoke runner failed.',
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
          ].join('\n'),
        );
      }

      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('mvp flow db smoke ok');
    },
    190_000,
  );
});

const MVP_FLOW_DB_RUNNER = `
import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import {
  AssetPriceSourceType,
  AssetType,
  CurrencyCode,
  FxRateSourceType,
  OrderSide,
  OrderStatus,
  OrderType,
  ParticipantStatus,
  RefreshTokenSessionStatus,
  SeasonStatus,
  WalletTransactionDirection,
  WalletTransactionReferenceType,
  WalletTransactionType,
} from './src/generated/prisma/client';
import { PrismaService } from './src/prisma/prisma.service';
import { AuthService } from './src/auth/auth.service';
import { SeasonsService } from './src/seasons/seasons.service';
import { WalletsService } from './src/wallets/wallets.service';
import { AssetsService } from './src/assets/assets.service';
import { FxService } from './src/fx/fx.service';
import { OrdersService } from './src/orders/orders.service';
import { PositionsService } from './src/positions/positions.service';
import { RecordsService } from './src/records/records.service';
import { HomeService } from './src/home/home.service';
import { RankingService } from './src/ranking/ranking.service';
import { PortfolioValuationService } from './src/portfolio/portfolio-valuation.service';

const TEST_PREFIX = 'mvp-flow-db-smoke';
const password = 'Password123!';
const initialCapitalKrw = '10000000.00000000';
const fxRate = '1000.00000000';
const fxSourceAmount = '1000000.00000000';
const usdAssetPrice = '100.00000000';
const krwAssetPrice = '10000.00000000';
const buyQuantity = '2.00000000';

const prisma = new PrismaService();
const configService = {
  get(key) {
    if (key === 'JWT_ACCESS_SECRET') {
      return process.env.JWT_ACCESS_SECRET;
    }

    if (key === 'JWT_ACCESS_TTL') {
      return process.env.JWT_ACCESS_TTL || '15m';
    }

    if (key === 'REFRESH_TOKEN_TTL') {
      return process.env.REFRESH_TOKEN_TTL;
    }

    return undefined;
  },
};
const authService = new AuthService(prisma, new JwtService(), configService);
const seasonsService = new SeasonsService(prisma);
const walletsService = new WalletsService(prisma);
const assetsService = new AssetsService(prisma);
const fxService = new FxService(prisma);
const ordersService = new OrdersService(prisma);
const positionsService = new PositionsService(prisma);
const recordsService = new RecordsService(prisma);
const portfolioValuationService = new PortfolioValuationService(prisma);
const homeService = new HomeService(prisma, portfolioValuationService);
const rankingService = new RankingService(prisma);

let scenario = null;

async function main() {
  await prisma.$connect();

  try {
    await cleanup();
    scenario = buildScenario();
    authService.onModuleInit();

    const signup = await signupUser();
    scenario.userId = signup.userId;
    scenario.accessToken = signup.accessToken;
    scenario.refreshToken = signup.refreshToken;
    await assertRefreshTokenHashOnly(signup.refreshToken, signup.userId);

    const me = await authService.me(signup.userId);
    assert.equal(me.success, true);
    assert.equal(me.data.id, signup.userId);

    const login = await loginUser();
    assert.ok(login.accessToken);
    assert.ok(login.refreshToken);

    const refresh = await refreshLoginToken(login.refreshToken);
    scenario.accessToken = refresh.accessToken;
    scenario.refreshToken = refresh.refreshToken;

    await createSeasonAndAdminManualFixtures();
    await assertCurrentSeasonBeforeJoin();
    await joinSeason();
    await assertJoinSideEffects();

    await keepFxFresh();
    await assertAssetsApi();
    await assertWalletsBeforeFx();

    await keepFxFresh();
    await executeFxFlow();
    await assertFxSideEffects();

    await keepFxFresh();
    await executeOrderFlow();
    await assertOrderSideEffects();

    await keepFxFresh();
    const beforeReadOnlyCounts = await readMutationCounts();
    await assertReadApisAfterWrites();
    const afterReadOnlyCounts = await readMutationCounts();
    assert.deepEqual(afterReadOnlyCounts, beforeReadOnlyCounts);

    await assertLogoutAll();
    console.log('mvp flow db smoke ok');
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

function buildScenario() {
  const suffix = Date.now() + '-' + Math.random().toString(36).slice(2);
  return {
    suffix,
    email: TEST_PREFIX + '-' + suffix + '@example.com',
    nickname: TEST_PREFIX + '-' + suffix,
    seasonName: TEST_PREFIX + '-season-' + suffix,
    market: TEST_PREFIX + '-' + suffix,
    sourceName: TEST_PREFIX + '-' + suffix,
    krwAssetSymbol: 'KRW-' + suffix.slice(0, 10),
    usdAssetSymbol: 'USD-' + suffix.slice(0, 10),
    userId: null,
    accessToken: null,
    refreshToken: null,
    seasonId: null,
    participantId: null,
    krwWalletId: null,
    usdWalletId: null,
    fxRateSnapshotId: null,
    krwAssetId: null,
    usdAssetId: null,
    krwAssetPriceSnapshotId: null,
    usdAssetPriceSnapshotId: null,
    exchangeId: null,
    orderId: null,
    positionId: null,
  };
}

async function signupUser() {
  const response = await authService.signup(
    {
      email: scenario.email,
      password,
      nickname: scenario.nickname,
    },
    metadata(),
  );

  assert.equal(response.success, true);
  assert.ok(response.data.tokens.accessToken);
  assert.ok(response.data.tokens.refreshToken);

  return {
    userId: response.data.user.id,
    accessToken: response.data.tokens.accessToken,
    refreshToken: response.data.tokens.refreshToken,
  };
}

async function loginUser() {
  const response = await authService.login(
    {
      email: scenario.email,
      password,
    },
    metadata(),
  );

  assert.equal(response.success, true);
  return {
    accessToken: response.data.tokens.accessToken,
    refreshToken: response.data.tokens.refreshToken,
  };
}

async function refreshLoginToken(refreshToken) {
  const response = await authService.refresh(
    {
      refreshToken,
    },
    metadata(),
  );

  assert.equal(response.success, true);
  assert.ok(response.data.tokens.accessToken);
  assert.ok(response.data.tokens.refreshToken);
  assert.notEqual(response.data.tokens.refreshToken, refreshToken);

  const oldSession = await prisma.refreshTokenSession.findUniqueOrThrow({
    where: {
      tokenHash: hashRefreshToken(refreshToken),
    },
  });
  assert.equal(oldSession.status, RefreshTokenSessionStatus.revoked);

  return {
    accessToken: response.data.tokens.accessToken,
    refreshToken: response.data.tokens.refreshToken,
  };
}

async function assertRefreshTokenHashOnly(refreshToken, userId) {
  const session = await prisma.refreshTokenSession.findUniqueOrThrow({
    where: {
      tokenHash: hashRefreshToken(refreshToken),
    },
  });

  assert.equal(session.userId, userId);
  assert.equal(session.status, RefreshTokenSessionStatus.active);
  assert.notEqual(session.tokenHash, refreshToken);
}

async function createSeasonAndAdminManualFixtures() {
  const now = freshDate();
  const season = await prisma.season.create({
    data: {
      name: scenario.seasonName,
      status: SeasonStatus.active,
      startAt: new Date('2999-01-01T00:00:00.000Z'),
      endAt: new Date('2999-12-31T23:59:59.000Z'),
      initialCapitalKrw,
      tradeFeeRate: '0.001000',
      fxFeeRate: '0.001000',
    },
    select: {
      id: true,
    },
  });
  scenario.seasonId = season.id;

  const fxSnapshot = await prisma.fxRateSnapshot.create({
    data: {
      baseCurrency: CurrencyCode.USD,
      quoteCurrency: CurrencyCode.KRW,
      rate: fxRate,
      sourceType: FxRateSourceType.admin_manual,
      sourceName: scenario.sourceName,
      sourceTimestamp: now,
      effectiveAt: now,
      capturedAt: now,
      rawPayloadJson: {
        testFixture: TEST_PREFIX,
        scenario: scenario.suffix,
      },
      approvedByUserId: scenario.userId,
      note: TEST_PREFIX + ' isolated test fixture',
    },
    select: {
      id: true,
    },
  });
  scenario.fxRateSnapshotId = fxSnapshot.id;

  const krwAsset = await prisma.asset.create({
    data: {
      symbol: scenario.krwAssetSymbol,
      name: TEST_PREFIX + ' KRW asset ' + scenario.suffix,
      market: scenario.market,
      currencyCode: CurrencyCode.KRW,
      assetType: AssetType.domestic_stock,
      isActive: true,
    },
    select: {
      id: true,
    },
  });
  scenario.krwAssetId = krwAsset.id;

  const usdAsset = await prisma.asset.create({
    data: {
      symbol: scenario.usdAssetSymbol,
      name: TEST_PREFIX + ' USD asset ' + scenario.suffix,
      market: scenario.market,
      currencyCode: CurrencyCode.USD,
      assetType: AssetType.crypto,
      isActive: true,
    },
    select: {
      id: true,
    },
  });
  scenario.usdAssetId = usdAsset.id;

  const krwPrice = await prisma.assetPriceSnapshot.create({
    data: {
      assetId: scenario.krwAssetId,
      price: krwAssetPrice,
      currencyCode: CurrencyCode.KRW,
      sourceType: AssetPriceSourceType.admin_manual,
      sourceName: scenario.sourceName,
      sourceTimestamp: now,
      effectiveAt: now,
      capturedAt: now,
      rawPayloadJson: {
        testFixture: TEST_PREFIX,
        scenario: scenario.suffix,
      },
      note: TEST_PREFIX + ' isolated test fixture',
    },
    select: {
      id: true,
    },
  });
  scenario.krwAssetPriceSnapshotId = krwPrice.id;

  const usdPrice = await prisma.assetPriceSnapshot.create({
    data: {
      assetId: scenario.usdAssetId,
      price: usdAssetPrice,
      currencyCode: CurrencyCode.USD,
      sourceType: AssetPriceSourceType.admin_manual,
      sourceName: scenario.sourceName,
      sourceTimestamp: now,
      effectiveAt: now,
      capturedAt: now,
      rawPayloadJson: {
        testFixture: TEST_PREFIX,
        scenario: scenario.suffix,
      },
      note: TEST_PREFIX + ' isolated test fixture',
    },
    select: {
      id: true,
    },
  });
  scenario.usdAssetPriceSnapshotId = usdPrice.id;
}

async function assertCurrentSeasonBeforeJoin() {
  const response = await seasonsService.getCurrentSeason(scenario.userId);

  assert.equal(response.success, true);
  assert.equal(response.data.id, scenario.seasonId);
  assert.equal(response.data.joined, false);
}

async function joinSeason() {
  const response = await seasonsService.joinSeason(
    scenario.seasonId,
    scenario.userId,
  );

  assert.equal(response.success, true);
  assert.equal(response.data.seasonId, scenario.seasonId);
  assert.equal(response.data.wallets.KRW, initialCapitalKrw);
  assert.equal(response.data.wallets.USD, '0.00000000');
  scenario.participantId = response.data.seasonParticipantId;
}

async function assertJoinSideEffects() {
  const participant = await prisma.seasonParticipant.findUniqueOrThrow({
    where: {
      seasonId_userId: {
        seasonId: scenario.seasonId,
        userId: scenario.userId,
      },
    },
  });
  assert.equal(participant.id, scenario.participantId);
  assert.equal(participant.participantStatus, ParticipantStatus.active);

  const wallets = await prisma.cashWallet.findMany({
    where: {
      seasonParticipantId: scenario.participantId,
    },
    orderBy: {
      currencyCode: 'asc',
    },
  });
  assert.equal(wallets.length, 2);
  const krwWallet = wallets.find((wallet) => wallet.currencyCode === CurrencyCode.KRW);
  const usdWallet = wallets.find((wallet) => wallet.currencyCode === CurrencyCode.USD);
  assert.ok(krwWallet, 'join wallets: ' + JSON.stringify(wallets));
  assert.ok(usdWallet, 'join wallets: ' + JSON.stringify(wallets));
  assert.equal(formatScale8(krwWallet.balanceAmount), initialCapitalKrw);
  assert.equal(formatScale8(usdWallet.balanceAmount), '0.00000000');
  scenario.krwWalletId = krwWallet.id;
  scenario.usdWalletId = usdWallet.id;

  const initialGrant = await prisma.walletTransaction.findFirst({
    where: {
      seasonParticipantId: scenario.participantId,
      txType: WalletTransactionType.initial_grant,
    },
  });
  assert.ok(initialGrant);
  assert.equal(initialGrant.walletId, scenario.krwWalletId);
  assert.equal(initialGrant.direction, WalletTransactionDirection.credit);
  assert.equal(initialGrant.referenceType, WalletTransactionReferenceType.season_join);
}

async function assertAssetsApi() {
  const listResponse = await assetsService.getAssets(scenario.userId, {
    market: scenario.market,
    limit: '10',
  });

  assert.equal(
    listResponse.success,
    true,
    'assets list response: ' + JSON.stringify(listResponse),
  );
  assert.equal(listResponse.data.state, 'available');
  assert.equal(listResponse.data.assets.length, 2);

  const krwAsset = listResponse.data.assets.find(
    (asset) => asset.assetId === scenario.krwAssetId,
  );
  const usdAsset = listResponse.data.assets.find(
    (asset) => asset.assetId === scenario.usdAssetId,
  );
  assert.ok(krwAsset);
  assert.ok(usdAsset);
  assert.equal(krwAsset.price.state, 'available');
  assert.equal(krwAsset.price.priceKrwState, 'available');
  assert.equal(usdAsset.price.state, 'available');
  assert.equal(usdAsset.price.priceKrwState, 'available');
  assert.equal(usdAsset.price.priceKrw, '100000.00000000');

  const detailResponse = await assetsService.getAsset(
    scenario.userId,
    scenario.usdAssetId,
  );
  assert.equal(detailResponse.success, true);
  assert.equal(detailResponse.data.asset.assetId, scenario.usdAssetId);
  assert.equal(detailResponse.data.asset.price.priceKrwState, 'available');
}

async function assertWalletsBeforeFx() {
  const response = await walletsService.getWallets(scenario.userId);

  assert.equal(response.success, true);
  assert.equal(response.data.state, 'available');
  assert.equal(response.data.summary.hasKrwWallet, true);
  assert.equal(response.data.summary.hasUsdWallet, true);

  const krwWallet = response.data.wallets.find(
    (wallet) => wallet.currencyCode === CurrencyCode.KRW,
  );
  const usdWallet = response.data.wallets.find(
    (wallet) => wallet.currencyCode === CurrencyCode.USD,
  );
  assert.equal(krwWallet.balanceAmount, initialCapitalKrw);
  assert.equal(usdWallet.balanceAmount, '0.00000000');
}

async function executeFxFlow() {
  const quoteResponse = await fxService.quote(scenario.userId, {
    fromCurrency: CurrencyCode.KRW,
    toCurrency: CurrencyCode.USD,
    sourceAmount: fxSourceAmount,
  });

  assert.equal(quoteResponse.success, true);
  assert.equal(quoteResponse.data.appliedRate, fxRate);
  assert.equal(quoteResponse.data.netTargetAmount, '999.00000000');

  await keepFxFresh();
  const executeResponse = await fxService.execute(scenario.userId, {
    idempotencyKey: scenario.sourceName + '-fx',
    fromCurrency: CurrencyCode.KRW,
    toCurrency: CurrencyCode.USD,
    sourceAmount: fxSourceAmount,
  });

  assert.equal(executeResponse.success, true);
  assert.equal(executeResponse.data.sourceWalletBalanceAfter, '9000000.00000000');
  assert.equal(executeResponse.data.targetWalletBalanceAfter, '999.00000000');
  scenario.exchangeId = executeResponse.data.exchangeId;
}

async function assertFxSideEffects() {
  const krwWallet = await prisma.cashWallet.findUniqueOrThrow({
    where: {
      id: scenario.krwWalletId,
    },
  });
  const usdWallet = await prisma.cashWallet.findUniqueOrThrow({
    where: {
      id: scenario.usdWalletId,
    },
  });
  assert.equal(formatScale8(krwWallet.balanceAmount), '9000000.00000000');
  assert.equal(formatScale8(usdWallet.balanceAmount), '999.00000000');

  const exchange = await prisma.exchangeTransaction.findUniqueOrThrow({
    where: {
      id: scenario.exchangeId,
    },
  });
  assert.equal(exchange.seasonParticipantId, scenario.participantId);
  assert.equal(exchange.fxRateSnapshotId, scenario.fxRateSnapshotId);

  const sourceLedger = await prisma.walletTransaction.findFirst({
    where: {
      seasonParticipantId: scenario.participantId,
      txType: WalletTransactionType.exchange_source,
    },
  });
  const targetLedger = await prisma.walletTransaction.findFirst({
    where: {
      seasonParticipantId: scenario.participantId,
      txType: WalletTransactionType.exchange_target,
    },
  });
  assert.ok(sourceLedger);
  assert.ok(targetLedger);
  assert.equal(sourceLedger.referenceId, scenario.exchangeId);
  assert.equal(targetLedger.referenceId, scenario.exchangeId);

  const recordsResponse = await recordsService.getRecords(scenario.userId);
  assert.equal(recordsResponse.data.exchanges.records.length, 1);
  assert.ok(
    recordsResponse.data.walletTransactions.records.some(
      (record) => record.transactionType === WalletTransactionType.exchange_source,
    ),
  );
  assert.ok(
    recordsResponse.data.walletTransactions.records.some(
      (record) => record.transactionType === WalletTransactionType.exchange_target,
    ),
  );
}

async function executeOrderFlow() {
  const orderBody = {
    assetId: scenario.usdAssetId,
    side: OrderSide.buy,
    orderType: OrderType.market,
    quantity: buyQuantity,
  };

  const quoteResponse = await ordersService.quoteOrder(scenario.userId, orderBody);
  assert.equal(quoteResponse.success, true);
  assert.equal(quoteResponse.data.currencyCode, CurrencyCode.USD);
  assert.equal(quoteResponse.data.netAmount, '200.20000000');
  assert.equal(quoteResponse.data.fxRateSnapshotId, scenario.fxRateSnapshotId);

  await keepFxFresh();
  const createResponse = await ordersService.createOrder(scenario.userId, {
    ...orderBody,
    idempotencyKey: scenario.sourceName + '-order',
  });
  assert.equal(createResponse.success, true);
  assert.equal(createResponse.data.order.status, OrderStatus.submitted);
  scenario.orderId = createResponse.data.order.orderId;

  await keepFxFresh();
  const executeResponse = await ordersService.executeOrder(
    scenario.userId,
    scenario.orderId,
  );
  assert.equal(executeResponse.success, true);
  assert.equal(executeResponse.data.order.status, OrderStatus.executed);
  assert.equal(executeResponse.data.execution.walletBalanceAfter, '798.80000000');
  scenario.positionId = executeResponse.data.execution.positionId;
}

async function assertOrderSideEffects() {
  const order = await prisma.order.findUniqueOrThrow({
    where: {
      id: scenario.orderId,
    },
  });
  assert.equal(order.status, OrderStatus.executed);
  assert.equal(formatScale8(order.executedPrice), usdAssetPrice);
  assert.equal(order.assetPriceSnapshotId, scenario.usdAssetPriceSnapshotId);
  assert.equal(order.fxRateSnapshotId, scenario.fxRateSnapshotId);

  const usdWallet = await prisma.cashWallet.findUniqueOrThrow({
    where: {
      id: scenario.usdWalletId,
    },
  });
  assert.equal(formatScale8(usdWallet.balanceAmount), '798.80000000');

  const position = await prisma.position.findUniqueOrThrow({
    where: {
      seasonParticipantId_assetId: {
        seasonParticipantId: scenario.participantId,
        assetId: scenario.usdAssetId,
      },
    },
  });
  assert.equal(position.id, scenario.positionId);
  assert.equal(formatScale8(position.quantity), buyQuantity);

  const orderLedger = await prisma.walletTransaction.findFirst({
    where: {
      seasonParticipantId: scenario.participantId,
      txType: WalletTransactionType.order_buy,
      referenceId: scenario.orderId,
    },
  });
  assert.ok(orderLedger);
  assert.equal(orderLedger.direction, WalletTransactionDirection.debit);
  assert.equal(formatScale8(orderLedger.balanceAfter), '798.80000000');

  const recordsResponse = await recordsService.getRecords(scenario.userId);
  assert.ok(
    recordsResponse.data.orders.records.some(
      (record) =>
        record.orderId === scenario.orderId &&
        record.status === OrderStatus.executed,
    ),
  );
  assert.ok(
    recordsResponse.data.walletTransactions.records.some(
      (record) =>
        record.transactionType === WalletTransactionType.order_buy &&
        record.referenceId === scenario.orderId,
    ),
  );
}

async function assertReadApisAfterWrites() {
  await assertAssetsApi();

  const walletsResponse = await walletsService.getWallets(scenario.userId);
  const usdWallet = walletsResponse.data.wallets.find(
    (wallet) => wallet.currencyCode === CurrencyCode.USD,
  );
  assert.equal(usdWallet.balanceAmount, '798.80000000');

  const recordsResponse = await recordsService.getRecords(scenario.userId);
  assert.equal(recordsResponse.data.state, 'available');
  assert.equal(recordsResponse.data.exchanges.records.length, 1);
  assert.equal(recordsResponse.data.orders.records.length, 1);
  assert.equal(recordsResponse.data.walletTransactions.records.length, 4);

  const positionsResponse = await positionsService.getPositions(scenario.userId);
  assert.equal(positionsResponse.success, true);
  assert.equal(positionsResponse.data.state, 'available');
  const position = positionsResponse.data.positions.find(
    (item) => item.assetId === scenario.usdAssetId,
  );
  assert.ok(position);
  assert.equal(
    position.valuation.state,
    'available',
    'positions response: ' + JSON.stringify(positionsResponse),
  );
  assert.equal(position.valuation.positionValueKrw, '200000.00000000');
  assert.equal(
    positionsResponse.data.summary.totalPositionValueKrw,
    '200000.00000000',
  );

  const ordersResponse = await ordersService.getOrders(scenario.userId);
  assert.equal(ordersResponse.success, true);
  assert.equal(ordersResponse.data.orders.length, 1);
  assert.equal(ordersResponse.data.orders[0].status, OrderStatus.executed);

  const homeResponse = await homeService.getHome(scenario.userId);
  assert.equal(homeResponse.success, true);
  assert.equal(homeResponse.data.mode, 'active_joined');
  assert.equal(
    homeResponse.data.summary.state,
    'available',
    'home response: ' + JSON.stringify(homeResponse),
  );
  assert.equal(homeResponse.data.summary.valuationSource, 'live_valuation');
  assert.equal(
    homeResponse.data.allocation.state,
    'available',
    'home response: ' + JSON.stringify(homeResponse),
  );
  assert.equal(
    homeResponse.data.topPositions.state,
    'available',
    'home response: ' + JSON.stringify(homeResponse),
  );
  assert.equal(homeResponse.data.topPositions.items.length, 1);
  assert.equal(homeResponse.data.equityChart.state, 'unavailable');
  assert.equal(homeResponse.data.equityChart.reason, 'EQUITY_CHART_UNAVAILABLE');
  assert.equal(homeResponse.data.ranking.state, 'unavailable');
  assert.equal(homeResponse.data.ranking.reason, 'RANKING_UNAVAILABLE');

  const rankingResponse = await rankingService.getRanking(scenario.userId);
  assert.equal(rankingResponse.success, true);
  assert.equal(rankingResponse.data.state, 'unavailable');
  assert.equal(rankingResponse.data.reason, 'RANKING_UNAVAILABLE');
  assert.equal(rankingResponse.data.myRanking.state, 'unavailable');
}

async function assertLogoutAll() {
  const response = await authService.logoutAll(scenario.userId);
  assert.deepEqual(response, {
    success: true,
    data: {
      revoked: true,
    },
  });

  const activeSessions = await prisma.refreshTokenSession.count({
    where: {
      userId: scenario.userId,
      status: RefreshTokenSessionStatus.active,
    },
  });
  assert.equal(activeSessions, 0);
}

async function keepFxFresh() {
  if (!scenario?.fxRateSnapshotId) {
    return;
  }

  const now = freshDate();
  await prisma.fxRateSnapshot.update({
    where: {
      id: scenario.fxRateSnapshotId,
    },
    data: {
      sourceTimestamp: now,
      effectiveAt: now,
      capturedAt: now,
    },
  });
}

async function readMutationCounts() {
  const [
    exchangeTransactions,
    walletTransactions,
    orders,
    positions,
    dailyPortfolioSnapshots,
    seasonRankings,
    equitySnapshots,
    assetPriceSnapshots,
    fxRateSnapshots,
  ] = await Promise.all([
    prisma.exchangeTransaction.count({
      where: { seasonParticipantId: scenario.participantId },
    }),
    prisma.walletTransaction.count({
      where: { seasonParticipantId: scenario.participantId },
    }),
    prisma.order.count({
      where: { seasonParticipantId: scenario.participantId },
    }),
    prisma.position.count({
      where: { seasonParticipantId: scenario.participantId },
    }),
    prisma.dailyPortfolioSnapshot.count({
      where: { seasonParticipantId: scenario.participantId },
    }),
    prisma.seasonRanking.count({
      where: {
        OR: [
          { seasonId: scenario.seasonId },
          { seasonParticipantId: scenario.participantId },
        ],
      },
    }),
    prisma.equitySnapshot.count({
      where: { seasonParticipantId: scenario.participantId },
    }),
    prisma.assetPriceSnapshot.count({
      where: { sourceName: scenario.sourceName },
    }),
    prisma.fxRateSnapshot.count({
      where: { sourceName: scenario.sourceName },
    }),
  ]);

  return {
    exchangeTransactions,
    walletTransactions,
    orders,
    positions,
    dailyPortfolioSnapshots,
    seasonRankings,
    equitySnapshots,
    assetPriceSnapshots,
    fxRateSnapshots,
  };
}

async function cleanup() {
  const users = await prisma.user.findMany({
    where: {
      email: {
        startsWith: TEST_PREFIX,
      },
    },
    select: {
      id: true,
    },
  });
  const userIds = users.map((user) => user.id);

  const seasons = await prisma.season.findMany({
    where: {
      name: {
        startsWith: TEST_PREFIX,
      },
    },
    select: {
      id: true,
    },
  });
  const seasonIds = seasons.map((season) => season.id);

  const assets = await prisma.asset.findMany({
    where: {
      market: {
        startsWith: TEST_PREFIX,
      },
    },
    select: {
      id: true,
    },
  });
  const assetIds = assets.map((asset) => asset.id);

  const participantFilters = [];
  if (userIds.length > 0) {
    participantFilters.push({ userId: { in: userIds } });
  }
  if (seasonIds.length > 0) {
    participantFilters.push({ seasonId: { in: seasonIds } });
  }
  const participants =
    participantFilters.length > 0
      ? await prisma.seasonParticipant.findMany({
          where: {
            OR: participantFilters,
          },
          select: {
            id: true,
          },
        })
      : [];
  const participantIds = participants.map((participant) => participant.id);

  if (seasonIds.length > 0 || participantIds.length > 0) {
    await prisma.seasonRanking.deleteMany({
      where: orWhere([
        seasonIds.length > 0 ? { seasonId: { in: seasonIds } } : null,
        participantIds.length > 0
          ? { seasonParticipantId: { in: participantIds } }
          : null,
      ]),
    });
  }

  if (participantIds.length > 0) {
    await prisma.dailyPortfolioSnapshot.deleteMany({
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
    await prisma.fxExecuteRequest.deleteMany({
      where: { seasonParticipantId: { in: participantIds } },
    });
    await prisma.walletTransaction.deleteMany({
      where: { seasonParticipantId: { in: participantIds } },
    });
    await prisma.exchangeTransaction.deleteMany({
      where: { seasonParticipantId: { in: participantIds } },
    });
    await prisma.cashWallet.deleteMany({
      where: { seasonParticipantId: { in: participantIds } },
    });
  }

  await prisma.assetPriceSnapshot.deleteMany({
    where: orWhere([
      { sourceName: { startsWith: TEST_PREFIX } },
      assetIds.length > 0 ? { assetId: { in: assetIds } } : null,
    ]),
  });
  await prisma.fxRateSnapshot.deleteMany({
    where: {
      sourceName: {
        startsWith: TEST_PREFIX,
      },
    },
  });

  if (participantIds.length > 0) {
    await prisma.seasonParticipant.deleteMany({
      where: { id: { in: participantIds } },
    });
  }
  if (userIds.length > 0) {
    await prisma.refreshTokenSession.deleteMany({
      where: { userId: { in: userIds } },
    });
  }
  if (seasonIds.length > 0) {
    await prisma.season.deleteMany({
      where: { id: { in: seasonIds } },
    });
  }
  if (assetIds.length > 0) {
    await prisma.asset.deleteMany({
      where: { id: { in: assetIds } },
    });
  }
  if (userIds.length > 0) {
    await prisma.user.deleteMany({
      where: { id: { in: userIds } },
    });
  }
}

function orWhere(filters) {
  const compact = filters.filter(Boolean);
  assert.ok(compact.length > 0);
  return {
    OR: compact,
  };
}

function metadata() {
  return {
    userAgent: TEST_PREFIX,
    ipAddress: '127.0.0.1',
  };
}

function hashRefreshToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function freshDate() {
  return new Date(Date.now() - 1_000);
}

function formatScale8(value) {
  return value.toFixed(8);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
