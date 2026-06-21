jest.mock('../src/generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    AssetPriceSourceType: {
      admin_manual: 'admin_manual',
      official_batch: 'official_batch',
      provider_api: 'provider_api',
    },
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    CurrencyCode: {
      KRW: 'KRW',
      USD: 'USD',
    },
    FxExecuteRequestStatus: {
      failed: 'failed',
      pending: 'pending',
      succeeded: 'succeeded',
    },
    FxRateSourceType: {
      admin_manual: 'admin_manual',
      official_batch: 'official_batch',
      provider_api: 'provider_api',
    },
    OrderSide: {
      buy: 'buy',
      sell: 'sell',
    },
    OrderStatus: {
      canceled: 'canceled',
      executed: 'executed',
      rejected: 'rejected',
      submitted: 'submitted',
    },
    OrderType: {
      limit: 'limit',
      market: 'market',
    },
    OperatorAuditResult: {
      success: 'success',
      failure: 'failure',
    },
    RewardFulfillmentStatus: {
      pending: 'pending',
      processing: 'processing',
      fulfilled: 'fulfilled',
      failed: 'failed',
      canceled: 'canceled',
    },
    OpsJobName: {
      provider_fx_ingest: 'provider_fx_ingest',
      provider_binance_ingest: 'provider_binance_ingest',
      daily_portfolio_snapshot: 'daily_portfolio_snapshot',
      season_ranking_generation: 'season_ranking_generation',
      season_settlement: 'season_settlement',
      season_lifecycle_transition: 'season_lifecycle_transition',
      reward_marker: 'reward_marker',
    },
    OpsJobRunStatus: {
      running: 'running',
      succeeded: 'succeeded',
      failed: 'failed',
      skipped: 'skipped',
      locked: 'locked',
    },
    OpsJobTrigger: {
      scheduler: 'scheduler',
      operator: 'operator',
      manual_script: 'manual_script',
      test: 'test',
    },
    ParticipantStatus: {
      active: 'active',
      registered: 'registered',
      finished: 'finished',
      rewarded: 'rewarded',
    },
    Prisma: {
      Decimal,
      PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {},
    },
    PrismaClient: class PrismaClient {},
    RefreshTokenSessionStatus: {
      active: 'active',
      revoked: 'revoked',
    },
    SeasonStatus: {
      active: 'active',
      upcoming: 'upcoming',
      ended: 'ended',
      settled: 'settled',
    },
    SeasonRankingType: {
      daily: 'daily',
      final: 'final',
    },
    SeasonRewardType: {
      internal: 'internal',
      badge: 'badge',
      trophy: 'trophy',
    },
    SnapshotReason: {
      season_join: 'season_join',
      exchange_executed: 'exchange_executed',
      order_executed: 'order_executed',
      scheduled: 'scheduled',
      settlement: 'settlement',
    },
    UserStatus: {
      active: 'active',
      suspended: 'suspended',
      deleted: 'deleted',
    },
    UserRole: {
      user: 'user',
      operator: 'operator',
      admin: 'admin',
    },
    WalletTransactionDirection: {
      credit: 'credit',
      debit: 'debit',
    },
    WalletTransactionReferenceType: {
      exchange_transaction: 'exchange_transaction',
      manual_adjustment: 'manual_adjustment',
      order: 'order',
      season_join: 'season_join',
      settlement: 'settlement',
    },
    WalletTransactionType: {
      adjustment: 'adjustment',
      exchange_source: 'exchange_source',
      exchange_target: 'exchange_target',
      fee: 'fee',
      initial_grant: 'initial_grant',
      order_buy: 'order_buy',
      order_sell: 'order_sell',
      settlement: 'settlement',
    },
  };
});

jest.mock('argon2', () => ({
  hash: jest.fn(),
  verify: jest.fn(),
}));

jest.mock('../src/prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { WsAdapter } from '@nestjs/platform-ws';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import {
  Prisma,
  RefreshTokenSessionStatus,
} from './../src/generated/prisma/client';
import { PrismaService } from './../src/prisma/prisma.service';
import * as argon2 from 'argon2';
import { createHash } from 'node:crypto';

const mockedArgon2 = jest.mocked(argon2);

type HttpMethod = 'get' | 'patch' | 'post';

type PrismaMock = {
  $connect: jest.Mock;
  $disconnect: jest.Mock;
  $queryRaw: jest.Mock;
  $transaction: jest.Mock;
  asset: {
    count: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
  };
  assetPriceSnapshot: {
    findFirst: jest.Mock;
    findMany: jest.Mock;
  };
  cashWallet: {
    create: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    updateMany: jest.Mock;
  };
  dailyPortfolioSnapshot: {
    findFirst: jest.Mock;
    findMany: jest.Mock;
  };
  exchangeTransaction: {
    count: jest.Mock;
    create: jest.Mock;
    findMany: jest.Mock;
  };
  fxExecuteRequest: {
    create: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  fxRateSnapshot: {
    findFirst: jest.Mock;
    findMany: jest.Mock;
  };
  order: {
    count: jest.Mock;
    create: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  position: {
    count: jest.Mock;
    create: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  refreshTokenSession: {
    create: jest.Mock;
    findUnique: jest.Mock;
    updateMany: jest.Mock;
  };
  rewardFulfillmentRequest: {
    count: jest.Mock;
    create: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  operatorAuditLog: {
    create: jest.Mock;
  };
  season: {
    findFirst: jest.Mock;
    findUnique: jest.Mock;
  };
  seasonParticipant: {
    count: jest.Mock;
    create: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
  };
  seasonRanking: {
    count: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
  };
  seasonReward: {
    create: jest.Mock;
    findUnique: jest.Mock;
  };
  user: {
    count: jest.Mock;
    create: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  walletTransaction: {
    count: jest.Mock;
    create: jest.Mock;
    findMany: jest.Mock;
  };
  equitySnapshot: {
    create: jest.Mock;
  };
};

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;
  let jwtService: JwtService;
  let prisma: PrismaMock;

  const originalJwtAccessSecret = process.env.JWT_ACCESS_SECRET;
  const originalJwtAccessTtl = process.env.JWT_ACCESS_TTL;
  const originalRefreshTokenTtl = process.env.REFRESH_TOKEN_TTL;
  const originalSchedulerEnabled = process.env.SCHEDULER_ENABLED;
  const now = new Date('2026-05-09T00:00:00.000Z');
  const user = {
    id: 'user-1',
    email: 'user@example.com',
    passwordHash: 'hashed-password',
    nickname: 'traderKim',
    profileImageUrl: null,
    status: 'active',
    role: 'user',
    createdAt: now,
  };
  const season = {
    id: 'season-1',
    name: 'Season 1',
    status: 'active',
    startAt: new Date(Date.now() - 86_400_000),
    endAt: new Date(Date.now() + 86_400_000),
    initialCapitalKrw: new Prisma.Decimal('10000000.00000000'),
    tradeFeeRate: new Prisma.Decimal('0.001000'),
    fxFeeRate: new Prisma.Decimal('0.001000'),
  };
  const participant = {
    id: 'participant-1',
    participantStatus: 'active',
    joinedAt: now,
    initialCapitalKrw: new Prisma.Decimal('10000000.00000000'),
  };
  const krwWallet = {
    id: 'wallet-krw-1',
    seasonParticipantId: participant.id,
    currencyCode: 'KRW',
    balanceAmount: new Prisma.Decimal('10000000.00000000'),
    updatedAt: now,
  };
  const usdWallet = {
    id: 'wallet-usd-1',
    seasonParticipantId: participant.id,
    currencyCode: 'USD',
    balanceAmount: new Prisma.Decimal('0.00000000'),
    updatedAt: now,
  };
  const refreshToken = 'r'.repeat(64);
  const refreshTokenHash = createHash('sha256')
    .update(refreshToken)
    .digest('hex');

  beforeAll(() => {
    process.env.JWT_ACCESS_SECRET = 'test-secret';
    process.env.JWT_ACCESS_TTL = '15m';
    process.env.REFRESH_TOKEN_TTL = '7d';
    process.env.SCHEDULER_ENABLED = 'false';
  });

  afterAll(() => {
    if (originalJwtAccessSecret === undefined) {
      delete process.env.JWT_ACCESS_SECRET;
    } else {
      process.env.JWT_ACCESS_SECRET = originalJwtAccessSecret;
    }

    if (originalJwtAccessTtl === undefined) {
      delete process.env.JWT_ACCESS_TTL;
    } else {
      process.env.JWT_ACCESS_TTL = originalJwtAccessTtl;
    }

    if (originalRefreshTokenTtl === undefined) {
      delete process.env.REFRESH_TOKEN_TTL;
    } else {
      process.env.REFRESH_TOKEN_TTL = originalRefreshTokenTtl;
    }

    if (originalSchedulerEnabled === undefined) {
      delete process.env.SCHEDULER_ENABLED;
    } else {
      process.env.SCHEDULER_ENABLED = originalSchedulerEnabled;
    }
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockedArgon2.hash.mockResolvedValue('hashed-password');
    mockedArgon2.verify.mockResolvedValue(true);

    prisma = {
      $connect: jest.fn(),
      $disconnect: jest.fn(),
      $queryRaw: jest.fn().mockResolvedValue([{ result: 1 }]),
      $transaction: jest.fn(),
      asset: {
        count: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
      },
      assetPriceSnapshot: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
      },
      cashWallet: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      dailyPortfolioSnapshot: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
      },
      exchangeTransaction: {
        count: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
      },
      fxExecuteRequest: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      fxRateSnapshot: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
      },
      order: {
        count: jest.fn(),
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      position: {
        count: jest.fn(),
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      refreshTokenSession: {
        create: jest.fn().mockResolvedValue({ id: 'refresh-session-1' }),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      rewardFulfillmentRequest: {
        count: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      operatorAuditLog: {
        create: jest.fn().mockResolvedValue({
          id: 'audit-1',
          createdAt: now,
        }),
      },
      season: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
      },
      seasonParticipant: {
        count: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
      },
      seasonRanking: {
        count: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
      },
      seasonReward: {
        create: jest.fn(),
        findUnique: jest.fn(),
      },
      user: {
        count: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      walletTransaction: {
        count: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
      },
      equitySnapshot: {
        create: jest.fn(),
      },
    };
    mockTransactionPassthrough();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    jwtService = moduleFixture.get(JwtService);
    app = moduleFixture.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const resetPrismaMocks = () => {
    const resetMockObject = (value: unknown) => {
      if (typeof value === 'function' && 'mockReset' in value) {
        (value as jest.Mock).mockReset();
        return;
      }

      if (value && typeof value === 'object') {
        Object.values(value).forEach(resetMockObject);
      }
    };

    resetMockObject(prisma);
    prisma.$queryRaw.mockResolvedValue([{ result: 1 }]);
    mockTransactionPassthrough();
  };

  const mockTransactionPassthrough = () => {
    prisma.$transaction.mockImplementation(
      async (callback: (tx: PrismaMock) => unknown) => callback(prisma),
    );
  };

  const createValidAccessToken = (userId = user.id) =>
    jwtService.signAsync(
      {
        sub: userId,
      },
      {
        secret: 'test-secret',
        expiresIn: '15m',
      },
    );

  const mockActiveUser = (userId = user.id, role = 'user') => {
    prisma.user.findUnique.mockResolvedValue({
      ...user,
      id: userId,
      role,
      status: 'active',
    });
  };

  const mockActiveSeason = () => {
    prisma.season.findFirst.mockResolvedValue({
      ...season,
      tradeFeeRate: new Prisma.Decimal('0.001000'),
      fxFeeRate: new Prisma.Decimal('0.001000'),
    });
  };

  const mockJoinedParticipant = () => {
    prisma.seasonParticipant.findUnique.mockResolvedValue({
      ...participant,
      cashWallets: [krwWallet, usdWallet],
      positions: [],
    });
  };

  const buildRequest = (method: HttpMethod, path: string) => {
    const http = request(app.getHttpServer());
    if (method === 'get') {
      return http.get(path);
    }

    if (method === 'patch') {
      return http.patch(path);
    }

    return http.post(path);
  };

  const expectUnauthorizedBody = (body: unknown) => {
    expect(body).toMatchObject({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
      },
    });
  };

  const expectNoWriteMutationCalls = () => {
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expectNoModelWriteMutationCalls();
  };

  const expectNoModelWriteMutationCalls = () => {
    expect(prisma.seasonParticipant.create).not.toHaveBeenCalled();
    expect(prisma.cashWallet.create).not.toHaveBeenCalled();
    expect(prisma.cashWallet.updateMany).not.toHaveBeenCalled();
    expect(prisma.fxExecuteRequest.create).not.toHaveBeenCalled();
    expect(prisma.fxExecuteRequest.update).not.toHaveBeenCalled();
    expect(prisma.exchangeTransaction.create).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(prisma.order.create).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(prisma.position.create).not.toHaveBeenCalled();
    expect(prisma.position.update).not.toHaveBeenCalled();
    expect(prisma.position.updateMany).not.toHaveBeenCalled();
    expect(prisma.refreshTokenSession.create).not.toHaveBeenCalled();
    expect(prisma.refreshTokenSession.updateMany).not.toHaveBeenCalled();
    expect(prisma.rewardFulfillmentRequest.create).not.toHaveBeenCalled();
    expect(prisma.rewardFulfillmentRequest.update).not.toHaveBeenCalled();
    expect(prisma.rewardFulfillmentRequest.updateMany).not.toHaveBeenCalled();
    expect(prisma.seasonReward.create).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.operatorAuditLog.create).not.toHaveBeenCalled();
  };

  const expectNoServiceDatabaseCalls = () => {
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.season.findFirst).not.toHaveBeenCalled();
    expect(prisma.season.findUnique).not.toHaveBeenCalled();
    expect(prisma.seasonParticipant.count).not.toHaveBeenCalled();
    expect(prisma.seasonParticipant.findMany).not.toHaveBeenCalled();
    expect(prisma.seasonParticipant.findUnique).not.toHaveBeenCalled();
    expect(prisma.cashWallet.findMany).not.toHaveBeenCalled();
    expect(prisma.cashWallet.findUnique).not.toHaveBeenCalled();
    expect(prisma.dailyPortfolioSnapshot.findFirst).not.toHaveBeenCalled();
    expect(prisma.dailyPortfolioSnapshot.findMany).not.toHaveBeenCalled();
    expect(prisma.exchangeTransaction.count).not.toHaveBeenCalled();
    expect(prisma.exchangeTransaction.findMany).not.toHaveBeenCalled();
    expect(prisma.fxRateSnapshot.findFirst).not.toHaveBeenCalled();
    expect(prisma.fxRateSnapshot.findMany).not.toHaveBeenCalled();
    expect(prisma.fxExecuteRequest.findUnique).not.toHaveBeenCalled();
    expect(prisma.asset.count).not.toHaveBeenCalled();
    expect(prisma.asset.findMany).not.toHaveBeenCalled();
    expect(prisma.asset.findUnique).not.toHaveBeenCalled();
    expect(prisma.assetPriceSnapshot.findFirst).not.toHaveBeenCalled();
    expect(prisma.order.count).not.toHaveBeenCalled();
    expect(prisma.order.findFirst).not.toHaveBeenCalled();
    expect(prisma.order.findMany).not.toHaveBeenCalled();
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
    expect(prisma.position.count).not.toHaveBeenCalled();
    expect(prisma.position.findFirst).not.toHaveBeenCalled();
    expect(prisma.position.findMany).not.toHaveBeenCalled();
    expect(prisma.position.findUnique).not.toHaveBeenCalled();
    expect(prisma.refreshTokenSession.findUnique).not.toHaveBeenCalled();
    expect(prisma.rewardFulfillmentRequest.count).not.toHaveBeenCalled();
    expect(prisma.rewardFulfillmentRequest.findMany).not.toHaveBeenCalled();
    expect(prisma.rewardFulfillmentRequest.findUnique).not.toHaveBeenCalled();
    expect(prisma.seasonReward.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.count).not.toHaveBeenCalled();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.operatorAuditLog.create).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.seasonRanking.findFirst).not.toHaveBeenCalled();
    expect(prisma.seasonRanking.findMany).not.toHaveBeenCalled();
    expect(prisma.seasonRanking.findUnique).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.count).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.findMany).not.toHaveBeenCalled();
    expectNoWriteMutationCalls();
  };

  const expectUnauthorizedWithoutToken = async (
    method: HttpMethod,
    path: string,
    body?: object,
  ) => {
    resetPrismaMocks();
    const testRequest = buildRequest(method, path);
    if (body) {
      testRequest.send(body);
    }

    await testRequest.expect(401).expect((response) => {
      expectUnauthorizedBody(response.body);
      expectNoServiceDatabaseCalls();
    });
  };

  const expectUnauthorizedWithXUserId = async (
    method: HttpMethod,
    path: string,
    body?: object,
  ) => {
    resetPrismaMocks();
    const testRequest = buildRequest(method, path).set('x-user-id', user.id);
    if (body) {
      testRequest.send(body);
    }

    await testRequest.expect(401).expect((response) => {
      expectUnauthorizedBody(response.body);
      expectNoServiceDatabaseCalls();
    });
  };

  const expectUnauthorizedWithAuthorization = async (
    method: HttpMethod,
    path: string,
    authorization: string,
    body?: object,
  ) => {
    resetPrismaMocks();
    const testRequest = buildRequest(method, path).set(
      'Authorization',
      authorization,
    );
    if (body) {
      testRequest.send(body);
    }

    await testRequest.expect(401).expect((response) => {
      expectUnauthorizedBody(response.body);
      expectNoServiceDatabaseCalls();
    });
  };

  const protectedWritePathRequests: Array<{
    label: string;
    method: HttpMethod;
    path: string;
    body?: Record<string, unknown>;
  }> = [
    {
      label: 'POST /api/v1/seasons/:seasonId/join',
      method: 'post',
      path: '/api/v1/seasons/season-1/join',
    },
    {
      label: 'POST /api/v1/fx/quote',
      method: 'post',
      path: '/api/v1/fx/quote',
      body: {
        fromCurrency: 'KRW',
        toCurrency: 'USD',
        sourceAmount: '1000',
      },
    },
    {
      label: 'POST /api/v1/fx/execute',
      method: 'post',
      path: '/api/v1/fx/execute',
      body: {
        quoteId: 'quote-fx-e2e-1',
        idempotencyKey: 'e2e-fx-exec-1',
        fromCurrency: 'KRW',
        toCurrency: 'USD',
        sourceAmount: '1000',
      },
    },
    {
      label: 'POST /api/v1/orders/quote',
      method: 'post',
      path: '/api/v1/orders/quote',
      body: {
        assetId: 'asset-1',
        side: 'buy',
        orderType: 'market',
        quantity: '1',
        idempotencyKey: 'e2e-order-quote-1',
      },
    },
    {
      label: 'POST /api/v1/orders',
      method: 'post',
      path: '/api/v1/orders',
      body: {
        assetId: 'asset-1',
        side: 'buy',
        orderType: 'market',
        quantity: '1',
        quoteId: 'quote-order-e2e-1',
        idempotencyKey: 'e2e-order-create-1',
      },
    },
    {
      label: 'POST /api/v1/orders/:orderId/cancel',
      method: 'post',
      path: '/api/v1/orders/order-1/cancel',
    },
    {
      label: 'POST /api/v1/orders/:orderId/execute',
      method: 'post',
      path: '/api/v1/orders/order-1/execute',
    },
  ];

  it('/health (GET)', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({
        success: true,
        data: {
          service: 'ok',
        },
      });
  });

  it('/health/db (GET) allows public DB health checks without a token', () => {
    prisma.$queryRaw.mockResolvedValueOnce([{ result: 1 }]);

    return request(app.getHttpServer())
      .get('/health/db')
      .expect(200)
      .expect({
        success: true,
        data: {
          database: 'ok',
        },
      })
      .expect(() => {
        expect(prisma.user.findUnique).not.toHaveBeenCalled();
      });
  });

  it('/readiness (GET) reports database and scheduler readiness without secrets', () => {
    prisma.$queryRaw.mockResolvedValueOnce([{ result: 1 }]);

    return request(app.getHttpServer())
      .get('/readiness')
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual({
          success: true,
          data: {
            app: 'ok',
            database: 'ok',
            scheduler: {
              enabled: false,
              timezone: 'Asia/Seoul',
              jobs: expect.objectContaining({
                daily_portfolio_snapshot: false,
                provider_fx_ingest: false,
              }),
            },
            currentTime: expect.any(String),
          },
        });
        expect(JSON.stringify(response.body)).not.toMatch(
          /DATABASE_URL|KIS_APP_SECRET|approval_key|access_token/i,
        );
      });
  });

  it('/api/v1/auth/signup (POST) creates a user and returns access and refresh tokens', () => {
    prisma.user.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    prisma.user.create.mockResolvedValueOnce({
      id: user.id,
      email: user.email,
      nickname: user.nickname,
      status: user.status,
    });

    return request(app.getHttpServer())
      .post('/api/v1/auth/signup')
      .send({
        email: 'USER@example.com',
        password: 'Password123!',
        nickname: 'traderKim',
      })
      .expect(201)
      .expect((response) => {
        expect(response.body.success).toBe(true);
        expect(response.body.data.user).toEqual({
          id: user.id,
          email: user.email,
          nickname: user.nickname,
          status: user.status,
        });
        expect(response.body.data.tokens.accessToken).toEqual(
          expect.any(String),
        );
        expect(response.body.data.tokens.refreshToken).toEqual(
          expect.any(String),
        );
        expect(response.body.data.tokens.accessTokenExpiresIn).toBe('15m');
        expect(response.body.data.tokens.refreshTokenExpiresAt).toEqual(
          expect.any(String),
        );
        expect(JSON.stringify(response.body)).not.toContain('passwordHash');
        expect(prisma.user.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              email: user.email,
              passwordHash: 'hashed-password',
              role: 'user',
            }),
          }),
        );
        expect(prisma.refreshTokenSession.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              userId: user.id,
              tokenHash: expect.any(String),
              status: RefreshTokenSessionStatus.active,
              expiresAt: expect.any(Date),
            }),
          }),
        );
        const storedTokenHash =
          prisma.refreshTokenSession.create.mock.calls[0][0].data.tokenHash;
        expect(storedTokenHash).not.toBe(
          response.body.data.tokens.refreshToken,
        );
        expect(storedTokenHash).toBe(
          createHash('sha256')
            .update(response.body.data.tokens.refreshToken)
            .digest('hex'),
        );
      });
  });

  it('/api/v1/auth/login (POST) authenticates a user and returns access and refresh tokens', () => {
    prisma.user.findUnique.mockResolvedValueOnce(user);

    return request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        email: 'USER@example.com',
        password: 'Password123!',
      })
      .expect(200)
      .expect((response) => {
        expect(response.body.success).toBe(true);
        expect(response.body.data.user).toEqual({
          id: user.id,
          email: user.email,
          nickname: user.nickname,
          status: user.status,
        });
        expect(response.body.data.tokens.accessToken).toEqual(
          expect.any(String),
        );
        expect(response.body.data.tokens.refreshToken).toEqual(
          expect.any(String),
        );
        expect(response.body.data.tokens.accessTokenExpiresIn).toBe('15m');
        expect(response.body.data.tokens.refreshTokenExpiresAt).toEqual(
          expect.any(String),
        );
        expect(prisma.refreshTokenSession.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              userId: user.id,
              tokenHash: expect.any(String),
              status: RefreshTokenSessionStatus.active,
              expiresAt: expect.any(Date),
            }),
          }),
        );
        expect(JSON.stringify(response.body)).not.toContain('passwordHash');
      });
  });

  it('/api/v1/auth/refresh (POST) rejects missing and malformed refresh tokens', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({})
      .expect(401)
      .expect((response) => {
        expect(response.body).toMatchObject({
          success: false,
          error: {
            code: 'INVALID_REFRESH_TOKEN',
          },
        });
        expect(prisma.refreshTokenSession.findUnique).not.toHaveBeenCalled();
      });

    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({
        refreshToken: 'not a token',
      })
      .expect(401)
      .expect((response) => {
        expect(response.body).toMatchObject({
          success: false,
          error: {
            code: 'INVALID_REFRESH_TOKEN',
          },
        });
        expect(prisma.refreshTokenSession.findUnique).not.toHaveBeenCalled();
      });
  });

  it('/api/v1/auth/refresh (POST) rotates a valid refresh token', () => {
    prisma.refreshTokenSession.findUnique.mockResolvedValueOnce({
      id: 'refresh-session-1',
      userId: user.id,
      status: RefreshTokenSessionStatus.active,
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      user: {
        id: user.id,
        email: user.email,
        nickname: user.nickname,
        status: user.status,
      },
    });
    prisma.refreshTokenSession.create.mockResolvedValueOnce({
      id: 'refresh-session-2',
    });
    prisma.refreshTokenSession.updateMany.mockResolvedValueOnce({ count: 1 });

    return request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({
        refreshToken,
      })
      .expect(200)
      .expect((response) => {
        expect(response.body.success).toBe(true);
        expect(response.body.data.user).toEqual({
          id: user.id,
          email: user.email,
          nickname: user.nickname,
          status: user.status,
        });
        expect(response.body.data.tokens.accessToken).toEqual(
          expect.any(String),
        );
        expect(response.body.data.tokens.refreshToken).toEqual(
          expect.any(String),
        );
        expect(response.body.data.tokens.refreshToken).not.toBe(refreshToken);
        expect(prisma.refreshTokenSession.findUnique).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              tokenHash: refreshTokenHash,
            },
          }),
        );
        expect(prisma.refreshTokenSession.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              id: 'refresh-session-1',
              status: RefreshTokenSessionStatus.active,
            },
            data: expect.objectContaining({
              status: RefreshTokenSessionStatus.revoked,
              replacedBySessionId: 'refresh-session-2',
            }),
          }),
        );
      });
  });

  it('/api/v1/auth/refresh (POST) rejects old refresh token reuse after rotation', async () => {
    prisma.refreshTokenSession.findUnique
      .mockResolvedValueOnce({
        id: 'refresh-session-1',
        userId: user.id,
        status: RefreshTokenSessionStatus.active,
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
        user: {
          id: user.id,
          email: user.email,
          nickname: user.nickname,
          status: user.status,
        },
      })
      .mockResolvedValueOnce({
        id: 'refresh-session-1',
        userId: user.id,
        status: RefreshTokenSessionStatus.revoked,
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
        user: {
          id: user.id,
          email: user.email,
          nickname: user.nickname,
          status: user.status,
        },
      });
    prisma.refreshTokenSession.create.mockResolvedValueOnce({
      id: 'refresh-session-2',
    });
    prisma.refreshTokenSession.updateMany.mockResolvedValueOnce({ count: 1 });

    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({
        refreshToken,
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({
        refreshToken,
      })
      .expect(401)
      .expect((response) => {
        expect(response.body).toMatchObject({
          success: false,
          error: {
            code: 'INVALID_REFRESH_TOKEN',
          },
        });
      });
  });

  it('/api/v1/auth/logout (POST) is idempotent and does not expose token existence', async () => {
    prisma.refreshTokenSession.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .send({
        refreshToken,
      })
      .expect(200)
      .expect({
        success: true,
        data: {
          revoked: true,
        },
      });

    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .send({
        refreshToken,
      })
      .expect(200)
      .expect({
        success: true,
        data: {
          revoked: true,
        },
      });
    expect(prisma.refreshTokenSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tokenHash: refreshTokenHash,
          status: RefreshTokenSessionStatus.active,
        },
      }),
    );
  });

  it('/api/v1/auth/logout-all (POST) rejects missing token', async () => {
    await expectUnauthorizedWithoutToken('post', '/api/v1/auth/logout-all');
  });

  it('/api/v1/auth/logout-all (POST) rejects x-user-id only', async () => {
    await expectUnauthorizedWithXUserId('post', '/api/v1/auth/logout-all');
  });

  it('/api/v1/auth/logout-all (POST) revokes active refresh sessions for the authenticated user', async () => {
    mockActiveUser();
    prisma.refreshTokenSession.updateMany.mockResolvedValueOnce({ count: 2 });
    const token = await createValidAccessToken();

    return request(app.getHttpServer())
      .post('/api/v1/auth/logout-all')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual({
          success: true,
          data: {
            revoked: true,
          },
        });
        expect(prisma.refreshTokenSession.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              userId: user.id,
              status: RefreshTokenSessionStatus.active,
            },
            data: expect.objectContaining({
              status: RefreshTokenSessionStatus.revoked,
              revokedAt: expect.any(Date),
            }),
          }),
        );
      });
  });

  it('/api/v1/me (GET) returns the current user with a valid token', async () => {
    prisma.user.findUnique.mockResolvedValue(user);
    const token = await jwtService.signAsync(
      {
        sub: user.id,
      },
      {
        secret: 'test-secret',
        expiresIn: '15m',
      },
    );

    return request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual({
          success: true,
          data: {
            id: user.id,
            email: user.email,
            nickname: user.nickname,
            profileImageUrl: null,
            status: user.status,
            createdAt: now.toISOString(),
          },
        });
        expect(JSON.stringify(response.body)).not.toContain('passwordHash');
      });
  });

  it('/api/v1/me (GET) allows an operator to use regular protected APIs with token identity', async () => {
    prisma.user.findUnique.mockResolvedValue({
      ...user,
      role: 'operator',
    });
    const token = await createValidAccessToken(user.id);

    return request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({
          success: true,
          data: {
            id: user.id,
            email: user.email,
          },
        });
        expect(prisma.user.findUnique).toHaveBeenCalledTimes(2);
      });
  });

  it('/api/v1/operator/me (GET) rejects missing token', async () => {
    await expectUnauthorizedWithoutToken('get', '/api/v1/operator/me');
  });

  it('/api/v1/operator/me (GET) rejects x-user-id only', async () => {
    await expectUnauthorizedWithXUserId('get', '/api/v1/operator/me');
  });

  it('/api/v1/operator/me (GET) rejects invalid bearer tokens', async () => {
    await expectUnauthorizedWithAuthorization(
      'get',
      '/api/v1/operator/me',
      'Bearer invalid-token',
    );
  });

  it('/api/v1/operator/me (GET) rejects regular users', async () => {
    resetPrismaMocks();
    mockActiveUser(user.id, 'user');
    const token = await createValidAccessToken(user.id);

    return request(app.getHttpServer())
      .get('/api/v1/operator/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(403)
      .expect((response) => {
        expect(response.body).toMatchObject({
          success: false,
          error: {
            code: 'OPERATOR_FORBIDDEN',
          },
        });
        expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
        expectNoWriteMutationCalls();
      });
  });

  it.each([
    ['operator', 'operator'],
    ['admin', 'admin'],
  ])('/api/v1/operator/me (GET) allows %s role', async (_label, role) => {
    resetPrismaMocks();
    mockActiveUser(user.id, role);
    const token = await createValidAccessToken(user.id);

    return request(app.getHttpServer())
      .get('/api/v1/operator/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual({
          success: true,
          data: {
            userId: user.id,
            role,
          },
        });
        expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
        expectNoWriteMutationCalls();
      });
  });

  it.each(['suspended', 'deleted'])(
    '/api/v1/operator/me (GET) rejects %s users before operator guard success',
    async (status) => {
      resetPrismaMocks();
      prisma.user.findUnique.mockResolvedValueOnce({
        ...user,
        role: 'operator',
        status,
      });
      const token = await createValidAccessToken(user.id);

      return request(app.getHttpServer())
        .get('/api/v1/operator/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(403)
        .expect((response) => {
          expect(response.body).toMatchObject({
            success: false,
            error: {
              code: 'USER_NOT_ACTIVE',
            },
          });
          expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
          expectNoWriteMutationCalls();
        });
    },
  );

  it('/api/v1/operator/me (GET) uses the current DB role even with an existing token', async () => {
    resetPrismaMocks();
    const token = await createValidAccessToken(user.id);
    prisma.user.findUnique.mockResolvedValueOnce({
      ...user,
      role: 'user',
      status: 'active',
    });

    await request(app.getHttpServer())
      .get('/api/v1/operator/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(403)
      .expect((response) => {
        expect(response.body).toMatchObject({
          success: false,
          error: {
            code: 'OPERATOR_FORBIDDEN',
          },
        });
      });

    prisma.user.findUnique.mockResolvedValueOnce({
      ...user,
      role: 'operator',
      status: 'active',
    });

    await request(app.getHttpServer())
      .get('/api/v1/operator/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual({
          success: true,
          data: {
            userId: user.id,
            role: 'operator',
          },
        });
      });
  });

  it('/api/v1/operator/users (GET) rejects missing token', async () => {
    await expectUnauthorizedWithoutToken('get', '/api/v1/operator/users');
  });

  it('/api/v1/operator/users/:userId/status (PATCH) rejects missing token and x-user-id only', async () => {
    const body = {
      status: 'suspended',
      reason: 'risk review',
    };

    await expectUnauthorizedWithoutToken(
      'patch',
      '/api/v1/operator/users/managed-user-1/status',
      body,
    );
    await expectUnauthorizedWithXUserId(
      'patch',
      '/api/v1/operator/users/managed-user-1/status',
      body,
    );
  });

  it('/api/v1/operator/users/:userId/restore (POST) rejects missing token and x-user-id only', async () => {
    await expectUnauthorizedWithoutToken(
      'post',
      '/api/v1/operator/users/managed-user-1/restore',
      { reason: 'appeal approved' },
    );
    await expectUnauthorizedWithXUserId(
      'post',
      '/api/v1/operator/users/managed-user-1/restore',
      { reason: 'appeal approved' },
    );
  });

  it.each([
    ['user', 'user'],
    ['operator', 'operator'],
  ])('/api/v1/operator/users (GET) rejects %s role', async (_label, role) => {
    resetPrismaMocks();
    mockActiveUser(user.id, role);
    const token = await createValidAccessToken(user.id);

    return request(app.getHttpServer())
      .get('/api/v1/operator/users')
      .set('Authorization', `Bearer ${token}`)
      .expect(403)
      .expect((response) => {
        expect(response.body).toMatchObject({
          success: false,
          error: {
            code: 'ADMIN_REQUIRED',
          },
        });
        expect(prisma.user.count).not.toHaveBeenCalled();
        expect(prisma.user.findMany).not.toHaveBeenCalled();
        expect(prisma.operatorAuditLog.create).not.toHaveBeenCalled();
      });
  });

  it('/api/v1/operator/users (GET) lets admin list users without secret fields', async () => {
    resetPrismaMocks();
    mockActiveUser(user.id, 'admin');
    prisma.user.count.mockResolvedValueOnce(1);
    prisma.user.findMany.mockResolvedValueOnce([
      {
        id: 'managed-user-1',
        email: 'managed@example.com',
        nickname: 'managed',
        status: 'active',
        role: 'operator',
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const token = await createValidAccessToken(user.id);

    return request(app.getHttpServer())
      .get(
        '/api/v1/operator/users?role=operator&status=active&search=managed&limit=150',
      )
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual({
          success: true,
          data: {
            users: [
              {
                id: 'managed-user-1',
                email: 'managed@example.com',
                nickname: 'managed',
                status: 'active',
                role: 'operator',
                createdAt: now.toISOString(),
                updatedAt: now.toISOString(),
              },
            ],
            pagination: {
              limit: 100,
              offset: 0,
              total: 1,
              returned: 1,
              nextOffset: null,
            },
          },
        });
        expect(JSON.stringify(response.body)).not.toMatch(
          /passwordHash|refreshToken|accessToken/i,
        );
        expect(prisma.user.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              role: 'operator',
              status: 'active',
              OR: expect.any(Array),
            }),
            take: 100,
          }),
        );
        expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              action: 'operator.users.list',
              result: 'success',
            }),
          }),
        );
      });
  });

  it('/api/v1/operator/users/:userId (GET) lets admin get one user', async () => {
    resetPrismaMocks();
    prisma.user.findUnique
      .mockResolvedValueOnce({
        ...user,
        role: 'admin',
        status: 'active',
      })
      .mockResolvedValueOnce({
        id: 'managed-user-1',
        email: 'managed@example.com',
        nickname: 'managed',
        status: 'active',
        role: 'user',
        createdAt: now,
        updatedAt: now,
      });
    const token = await createValidAccessToken(user.id);

    return request(app.getHttpServer())
      .get('/api/v1/operator/users/managed-user-1')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({
          success: true,
          data: {
            user: {
              id: 'managed-user-1',
              email: 'managed@example.com',
              role: 'user',
            },
          },
        });
        expect(JSON.stringify(response.body)).not.toMatch(
          /passwordHash|refreshToken|accessToken/i,
        );
      });
  });

  it.each([
    ['user', 'user'],
    ['operator', 'operator'],
  ])(
    '/api/v1/operator/users/:userId/role (PATCH) rejects %s role and audits failure',
    async (_label, role) => {
      resetPrismaMocks();
      mockActiveUser(user.id, role);
      const token = await createValidAccessToken(user.id);

      return request(app.getHttpServer())
        .patch('/api/v1/operator/users/managed-user-1/role')
        .set('Authorization', `Bearer ${token}`)
        .send({
          role: 'admin',
          reason: 'not allowed',
        })
        .expect(403)
        .expect((response) => {
          expect(response.body).toMatchObject({
            success: false,
            error: {
              code: 'ADMIN_REQUIRED',
            },
          });
          expect(prisma.user.update).not.toHaveBeenCalled();
          expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
            expect.objectContaining({
              data: expect.objectContaining({
                action: 'operator.user_role.update.failed',
                actorRole: role,
                result: 'failure',
                errorCode: 'ADMIN_REQUIRED',
              }),
            }),
          );
        });
    },
  );

  it('/api/v1/operator/users/:userId/role (PATCH) lets admin change role and audits success', async () => {
    resetPrismaMocks();
    prisma.user.findUnique
      .mockResolvedValueOnce({
        ...user,
        role: 'admin',
        status: 'active',
      })
      .mockResolvedValueOnce({
        id: 'managed-user-1',
        email: 'managed@example.com',
        nickname: 'managed',
        status: 'active',
        role: 'user',
        createdAt: now,
        updatedAt: now,
      });
    prisma.user.update.mockResolvedValueOnce({
      id: 'managed-user-1',
      email: 'managed@example.com',
      nickname: 'managed',
      status: 'active',
      role: 'operator',
      createdAt: now,
      updatedAt: new Date('2026-05-09T00:01:00.000Z'),
    });
    const token = await createValidAccessToken(user.id);

    return request(app.getHttpServer())
      .patch('/api/v1/operator/users/managed-user-1/role')
      .set('Authorization', `Bearer ${token}`)
      .set('x-request-id', 'request-1')
      .send({
        role: 'operator',
        reason: 'support coverage',
      })
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({
          success: true,
          data: {
            user: {
              id: 'managed-user-1',
              role: 'operator',
            },
            roleChange: {
              beforeRole: 'user',
              afterRole: 'operator',
              reason: 'support coverage',
            },
          },
        });
        expect(JSON.stringify(response.body)).not.toMatch(
          /passwordHash|refreshToken|accessToken/i,
        );
        expect(prisma.user.update).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              id: 'managed-user-1',
            },
            data: {
              role: 'operator',
            },
          }),
        );
        expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              action: 'operator.user_role.update',
              actorRole: 'admin',
              targetId: 'managed-user-1',
              requestId: 'request-1',
              result: 'success',
              metadataJson: expect.objectContaining({
                beforeRole: 'user',
                afterRole: 'operator',
                targetUserId: 'managed-user-1',
                actorUserId: user.id,
                reason: 'support coverage',
              }),
            }),
          }),
        );
      });
  });

  it.each([
    ['user', 'user'],
    ['operator', 'operator'],
  ])(
    '/api/v1/operator/users/:userId/status (PATCH) rejects %s role and audits failure',
    async (_label, role) => {
      resetPrismaMocks();
      mockActiveUser(user.id, role);
      const token = await createValidAccessToken(user.id);

      return request(app.getHttpServer())
        .patch('/api/v1/operator/users/managed-user-1/status')
        .set('Authorization', `Bearer ${token}`)
        .send({
          status: 'suspended',
          reason: 'not allowed',
        })
        .expect(403)
        .expect((response) => {
          expect(response.body).toMatchObject({
            success: false,
            error: {
              code: 'ADMIN_REQUIRED',
            },
          });
          expect(prisma.user.update).not.toHaveBeenCalled();
          expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
            expect.objectContaining({
              data: expect.objectContaining({
                action: 'operator.user_status.update.failed',
                actorRole: role,
                result: 'failure',
                errorCode: 'ADMIN_REQUIRED',
              }),
            }),
          );
        });
    },
  );

  it('/api/v1/operator/users/:userId/status (PATCH) lets admin suspend a user and revoke sessions', async () => {
    resetPrismaMocks();
    prisma.user.findUnique
      .mockResolvedValueOnce({
        ...user,
        role: 'admin',
        status: 'active',
      })
      .mockResolvedValueOnce({
        id: 'managed-user-1',
        email: 'managed@example.com',
        nickname: 'managed',
        status: 'active',
        role: 'user',
        createdAt: now,
        updatedAt: now,
      });
    prisma.refreshTokenSession.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.user.update.mockResolvedValueOnce({
      id: 'managed-user-1',
      email: 'managed@example.com',
      nickname: 'managed',
      status: 'suspended',
      role: 'user',
      createdAt: now,
      updatedAt: new Date('2026-05-09T00:02:00.000Z'),
    });
    const token = await createValidAccessToken(user.id);

    return request(app.getHttpServer())
      .patch('/api/v1/operator/users/managed-user-1/status')
      .set('Authorization', `Bearer ${token}`)
      .set('x-request-id', 'request-status-1')
      .send({
        status: 'suspended',
        reason: 'risk review',
      })
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({
          success: true,
          data: {
            user: {
              id: 'managed-user-1',
              status: 'suspended',
              role: 'user',
            },
            statusChange: {
              beforeStatus: 'active',
              afterStatus: 'suspended',
              beforeRole: 'user',
              afterRole: 'user',
              revokedRefreshSessionCount: 1,
            },
          },
        });
        expect(JSON.stringify(response.body)).not.toMatch(
          /passwordHash|refreshToken|accessToken|tokenHash/i,
        );
        expect(prisma.refreshTokenSession.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              userId: 'managed-user-1',
              status: 'active',
            },
            data: expect.objectContaining({
              status: 'revoked',
            }),
          }),
        );
        expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              action: 'operator.user_status.update',
              requestId: 'request-status-1',
              result: 'success',
            }),
          }),
        );
      });
  });

  it('/api/v1/operator/users/:userId/restore (POST) restores deleted user as role=user', async () => {
    resetPrismaMocks();
    prisma.user.findUnique
      .mockResolvedValueOnce({
        ...user,
        role: 'admin',
        status: 'active',
      })
      .mockResolvedValueOnce({
        id: 'managed-user-1',
        email: 'managed@example.com',
        nickname: 'managed',
        status: 'deleted',
        role: 'admin',
        createdAt: now,
        updatedAt: now,
      });
    prisma.user.update.mockResolvedValueOnce({
      id: 'managed-user-1',
      email: 'managed@example.com',
      nickname: 'managed',
      status: 'active',
      role: 'user',
      createdAt: now,
      updatedAt: new Date('2026-05-09T00:03:00.000Z'),
    });
    const token = await createValidAccessToken(user.id);

    return request(app.getHttpServer())
      .post('/api/v1/operator/users/managed-user-1/restore')
      .set('Authorization', `Bearer ${token}`)
      .send({
        reason: 'appeal approved',
      })
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({
          success: true,
          data: {
            user: {
              id: 'managed-user-1',
              status: 'active',
              role: 'user',
            },
            restore: {
              beforeStatus: 'deleted',
              afterStatus: 'active',
              beforeRole: 'admin',
              afterRole: 'user',
            },
          },
        });
        expect(prisma.refreshTokenSession.updateMany).not.toHaveBeenCalled();
        expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              action: 'operator.user_restore',
              result: 'success',
              metadataJson: expect.objectContaining({
                beforeRole: 'admin',
                afterRole: 'user',
              }),
            }),
          }),
        );
      });
  });

  it('/api/v1/operator/reward-fulfillments rejects missing token for list and create', async () => {
    await expectUnauthorizedWithoutToken(
      'get',
      '/api/v1/operator/reward-fulfillments',
    );
    await expectUnauthorizedWithoutToken(
      'post',
      '/api/v1/operator/reward-fulfillments',
      {
        seasonId: 'season-1',
        seasonParticipantId: 'participant-1',
        rewardType: 'internal',
        rewardCode: 'manual_reward_2026_001',
        rewardName: '시즌 보상',
        idempotencyKey: 'idem-1',
      },
    );
  });

  it('/api/v1/operator/reward-fulfillments (POST) rejects user role and audits failure', async () => {
    resetPrismaMocks();
    mockActiveUser(user.id, 'user');
    const token = await createValidAccessToken(user.id);

    return request(app.getHttpServer())
      .post('/api/v1/operator/reward-fulfillments')
      .set('Authorization', `Bearer ${token}`)
      .send({
        seasonId: 'season-1',
        seasonParticipantId: 'participant-1',
        rewardType: 'internal',
        rewardCode: 'manual_reward_2026_001',
        rewardName: '시즌 보상',
        idempotencyKey: 'idem-1',
      })
      .expect(403)
      .expect((response) => {
        expect(response.body).toMatchObject({
          success: false,
          error: {
            code: 'OPERATOR_REQUIRED',
          },
        });
        expect(prisma.rewardFulfillmentRequest.create).not.toHaveBeenCalled();
        expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              action: 'operator.reward_fulfillment.create.failed',
              result: 'failure',
              errorCode: 'OPERATOR_REQUIRED',
            }),
          }),
        );
      });
  });

  it('/api/v1/operator/reward-fulfillments (POST) lets operator create pending internal fulfillment', async () => {
    resetPrismaMocks();
    mockActiveUser(user.id, 'operator');
    prisma.rewardFulfillmentRequest.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    prisma.season.findUnique.mockResolvedValueOnce({
      id: 'season-1',
      status: 'settled',
    });
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce({
      id: 'participant-1',
      seasonId: 'season-1',
      userId: 'target-user-1',
      user: {
        id: 'target-user-1',
        status: 'active',
      },
    });
    prisma.seasonReward.findUnique.mockResolvedValueOnce(null);
    prisma.rewardFulfillmentRequest.create.mockResolvedValueOnce({
      id: 'fulfillment-1',
      seasonId: 'season-1',
      seasonParticipantId: 'participant-1',
      userId: 'target-user-1',
      rewardType: 'internal',
      rewardCode: 'manual_reward_2026_001',
      rewardName: '시즌 보상',
      rewardValueJson: {
        kind: 'internal',
        accessToken: '[REDACTED]',
      },
      status: 'pending',
      seasonRewardId: null,
      idempotencyKey: 'idem-1',
      requestHash: 'hash-1',
      requestedByUserId: user.id,
      processedByUserId: null,
      canceledByUserId: null,
      requestedAt: now,
      processingStartedAt: null,
      fulfilledAt: null,
      failedAt: null,
      canceledAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    });
    const token = await createValidAccessToken(user.id);

    return request(app.getHttpServer())
      .post('/api/v1/operator/reward-fulfillments')
      .set('Authorization', `Bearer ${token}`)
      .send({
        seasonId: 'season-1',
        seasonParticipantId: 'participant-1',
        rewardType: 'internal',
        rewardCode: 'manual_reward_2026_001',
        rewardName: '시즌 보상',
        rewardValueJson: {
          kind: 'internal',
          accessToken: 'should-redact',
        },
        idempotencyKey: 'idem-1',
        reason: 'manual internal reward',
      })
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({
          success: true,
          data: {
            fulfillment: {
              id: 'fulfillment-1',
              rewardType: 'internal',
              rewardCode: 'manual_reward_2026_001',
              status: 'pending',
              seasonRewardId: null,
            },
            replayed: false,
          },
        });
        expect(JSON.stringify(response.body)).not.toMatch(
          /should-redact|passwordHash|refreshToken|accessToken":"should/i,
        );
        expect(prisma.rewardFulfillmentRequest.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              rewardValueJson: expect.objectContaining({
                accessToken: '[REDACTED]',
              }),
            }),
          }),
        );
        expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              action: 'operator.reward_fulfillment.create',
              result: 'success',
            }),
          }),
        );
      });
  });

  it.each(['suspended', 'deleted'])(
    '/api/v1/operator/users (GET) rejects %s admin actor before management service work',
    async (status) => {
      resetPrismaMocks();
      prisma.user.findUnique.mockResolvedValueOnce({
        ...user,
        role: 'admin',
        status,
      });
      const token = await createValidAccessToken(user.id);

      return request(app.getHttpServer())
        .get('/api/v1/operator/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(403)
        .expect((response) => {
          expect(response.body).toMatchObject({
            success: false,
            error: {
              code: 'USER_NOT_ACTIVE',
            },
          });
          expect(prisma.user.count).not.toHaveBeenCalled();
          expect(prisma.operatorAuditLog.create).not.toHaveBeenCalled();
        });
    },
  );

  it('/api/v1/home (GET) rejects unauthenticated requests before service work', () => {
    return request(app.getHttpServer())
      .get('/api/v1/home')
      .expect(401)
      .expect((response) => {
        expect(response.body).toMatchObject({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
          },
        });
      });
  });

  it('/api/v1/home (GET) ignores x-user-id without a bearer token', () => {
    return request(app.getHttpServer())
      .get('/api/v1/home')
      .set('x-user-id', user.id)
      .expect(401)
      .expect((response) => {
        expect(response.body).toMatchObject({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
          },
        });
      });
  });

  it('/api/v1/home (GET) reaches settled final-result branch with a valid token', async () => {
    resetPrismaMocks();
    mockActiveUser();
    prisma.season.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        ...season,
        status: 'settled',
      });
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce({
      ...participant,
      finalTier: null,
      rewardGrantedAt: null,
    });
    prisma.seasonRanking.findFirst.mockResolvedValueOnce({
      rank: 1,
      totalAssetKrw: new Prisma.Decimal('10100000.00000000'),
      returnRate: new Prisma.Decimal('0.01000000'),
      maxDrawdown: new Prisma.Decimal('0.00000000'),
      totalFillCount: 0,
      reachedReturnAt: null,
      rankingDate: new Date('2026-05-31T00:00:00.000Z'),
      capturedAt: new Date('2026-05-31T00:00:30.000Z'),
    });
    prisma.seasonRanking.count.mockResolvedValueOnce(1);
    prisma.dailyPortfolioSnapshot.findMany.mockResolvedValueOnce([]);
    const token = await createValidAccessToken();

    return request(app.getHttpServer())
      .get('/api/v1/home')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({
          success: true,
          data: {
            mode: 'settled_joined',
            finalResult: {
              state: 'available',
              rankType: 'final',
              rank: 1,
              totalParticipants: 1,
              totalAssetKrw: '10100000.00000000',
              returnRate: '0.01000000',
            },
            equityChart: {
              state: 'unavailable',
              reason: 'FINAL_SNAPSHOT_UNAVAILABLE',
            },
          },
        });
        expect(response.body.error?.code).not.toBe('UNAUTHORIZED');
        expect(prisma.dailyPortfolioSnapshot.findFirst).not.toHaveBeenCalled();
        expect(prisma.position.findMany).not.toHaveBeenCalled();
        expectNoWriteMutationCalls();
      });
  });

  it('/api/v1/seasons/current (GET) allows anonymous optional auth', () => {
    prisma.season.findFirst.mockResolvedValueOnce(season);

    return request(app.getHttpServer())
      .get('/api/v1/seasons/current')
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({
          success: true,
          data: {
            id: season.id,
            joined: false,
            joinedAt: null,
          },
        });
        expect(prisma.user.findUnique).not.toHaveBeenCalled();
      });
  });

  it('/api/v1/seasons/current (GET) ignores x-user-id and stays anonymous without a token', () => {
    prisma.season.findFirst.mockResolvedValueOnce(season);

    return request(app.getHttpServer())
      .get('/api/v1/seasons/current')
      .set('x-user-id', user.id)
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({
          success: true,
          data: {
            id: season.id,
            joined: false,
            joinedAt: null,
          },
        });
        expect(prisma.user.findUnique).not.toHaveBeenCalled();
        expect(prisma.seasonParticipant.findUnique).not.toHaveBeenCalled();
      });
  });

  it('/api/v1/seasons/current (GET) rejects invalid optional auth tokens', () => {
    return request(app.getHttpServer())
      .get('/api/v1/seasons/current')
      .set('Authorization', 'Bearer invalid-token')
      .expect(401)
      .expect((response) => {
        expect(response.body).toMatchObject({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
          },
        });
        expect(prisma.season.findFirst).not.toHaveBeenCalled();
      });
  });

  it('/api/v1/seasons/current (GET) rejects malformed optional auth headers', () => {
    return request(app.getHttpServer())
      .get('/api/v1/seasons/current')
      .set('Authorization', 'Token invalid-token')
      .expect(401)
      .expect((response) => {
        expect(response.body).toMatchObject({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
          },
        });
        expect(prisma.season.findFirst).not.toHaveBeenCalled();
      });
  });

  it('/api/v1/seasons/current (GET) uses a valid optional auth token', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(user);
    prisma.season.findFirst.mockResolvedValueOnce(season);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce({
      joinedAt: now,
    });
    const token = await jwtService.signAsync(
      {
        sub: user.id,
      },
      {
        secret: 'test-secret',
        expiresIn: '15m',
      },
    );

    return request(app.getHttpServer())
      .get('/api/v1/seasons/current')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({
          success: true,
          data: {
            id: season.id,
            joined: true,
            joinedAt: now.toISOString(),
          },
        });
        expect(prisma.seasonParticipant.findUnique).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              seasonId_userId: {
                seasonId: season.id,
                userId: user.id,
              },
            },
          }),
        );
      });
  });

  it.each([
    ['GET /api/v1/me', 'get', '/api/v1/me'],
    ['GET /api/v1/home', 'get', '/api/v1/home'],
    ['GET /api/v1/ranking', 'get', '/api/v1/ranking'],
    ['GET /api/v1/wallets', 'get', '/api/v1/wallets'],
    ['GET /api/v1/assets', 'get', '/api/v1/assets'],
    ['GET /api/v1/positions', 'get', '/api/v1/positions'],
    ['GET /api/v1/records', 'get', '/api/v1/records'],
    ['GET /api/v1/records/me/seasons', 'get', '/api/v1/records/me/seasons'],
    [
      'GET /api/v1/records/me/seasons/:seasonId',
      'get',
      '/api/v1/records/me/seasons/season-1',
    ],
    [
      'GET /api/v1/records/me/seasons/:seasonId/orders',
      'get',
      '/api/v1/records/me/seasons/season-1/orders',
    ],
    [
      'GET /api/v1/records/me/seasons/:seasonId/exchanges',
      'get',
      '/api/v1/records/me/seasons/season-1/exchanges',
    ],
    [
      'GET /api/v1/users/:userId/records/:seasonId',
      'get',
      '/api/v1/users/user-2/records/season-1',
    ],
    ['GET /api/v1/rewards/me', 'get', '/api/v1/rewards/me'],
    ['GET /api/v1/badges/me', 'get', '/api/v1/badges/me'],
    ['GET /api/v1/orders', 'get', '/api/v1/orders'],
  ] as const)(
    '%s rejects missing token and x-user-id-only requests before service work',
    async (_label, method, path) => {
      await expectUnauthorizedWithoutToken(method, path);
      await expectUnauthorizedWithXUserId(method, path);
    },
  );

  it('/api/v1/positions (GET) rejects invalid and malformed bearer tokens before service work', async () => {
    await expectUnauthorizedWithAuthorization(
      'get',
      '/api/v1/positions',
      'Bearer invalid-token',
    );
    await expectUnauthorizedWithAuthorization(
      'get',
      '/api/v1/positions',
      'Token invalid-token',
    );
  });

  it('/api/v1/assets (GET) rejects invalid and malformed bearer tokens before service work', async () => {
    await expectUnauthorizedWithAuthorization(
      'get',
      '/api/v1/assets',
      'Bearer invalid-token',
    );
    await expectUnauthorizedWithAuthorization(
      'get',
      '/api/v1/assets',
      'Token invalid-token',
    );
  });

  it.each([
    [
      'GET /api/v1/me',
      '/api/v1/me',
      () => {
        mockActiveUser();
      },
      (body: Record<string, unknown>) => {
        expect(body).toMatchObject({
          success: true,
          data: {
            id: user.id,
            email: user.email,
          },
        });
        expect(prisma.user.findUnique).toHaveBeenCalledTimes(2);
      },
    ],
    [
      'GET /api/v1/home',
      '/api/v1/home',
      () => {
        mockActiveUser();
        mockActiveSeason();
        mockJoinedParticipant();
        prisma.dailyPortfolioSnapshot.findFirst.mockResolvedValueOnce({
          snapshotDate: now,
          totalAssetKrw: new Prisma.Decimal('10000000.00000000'),
          returnRate: new Prisma.Decimal('0.00000000'),
          krwCash: new Prisma.Decimal('10000000.00000000'),
          usdCashKrw: new Prisma.Decimal('0.00000000'),
          assetValueKrw: new Prisma.Decimal('0.00000000'),
          realizedPnlKrw: new Prisma.Decimal('0.00000000'),
          unrealizedPnlKrw: new Prisma.Decimal('0.00000000'),
          capturedAt: now,
        });
        prisma.dailyPortfolioSnapshot.findMany.mockResolvedValueOnce([]);
        prisma.position.findMany.mockResolvedValueOnce([]);
        prisma.seasonRanking.findFirst.mockResolvedValueOnce(null);
      },
      (body: Record<string, unknown>) => {
        expect(body).toMatchObject({
          success: true,
          data: {
            mode: 'active_joined',
          },
        });
        expect(prisma.dailyPortfolioSnapshot.findFirst).toHaveBeenCalled();
        expect(prisma.dailyPortfolioSnapshot.findMany).toHaveBeenCalled();
        expect(prisma.position.findMany).toHaveBeenCalled();
      },
    ],
    [
      'GET /api/v1/ranking',
      '/api/v1/ranking',
      () => {
        mockActiveUser();
        mockActiveSeason();
        mockJoinedParticipant();
        prisma.seasonRanking.findFirst.mockResolvedValueOnce(null);
      },
      (body: Record<string, unknown>) => {
        expect(body).toMatchObject({
          success: true,
          data: {
            state: 'unavailable',
            reason: 'RANKING_UNAVAILABLE',
          },
        });
        expect(prisma.seasonParticipant.findUnique).toHaveBeenCalled();
      },
    ],
    [
      'GET /api/v1/wallets',
      '/api/v1/wallets',
      () => {
        mockActiveUser();
        mockActiveSeason();
        mockJoinedParticipant();
        prisma.cashWallet.findMany.mockResolvedValueOnce([
          krwWallet,
          usdWallet,
        ]);
      },
      (body: Record<string, unknown>) => {
        expect(body).toMatchObject({
          success: true,
          data: {
            state: 'available',
            summary: {
              totalWallets: 2,
              hasKrwWallet: true,
              hasUsdWallet: true,
            },
          },
        });
        expect(prisma.cashWallet.findMany).toHaveBeenCalled();
      },
    ],
    [
      'GET /api/v1/assets',
      '/api/v1/assets',
      () => {
        mockActiveUser();
        prisma.asset.count.mockResolvedValueOnce(0);
        prisma.asset.findMany.mockResolvedValueOnce([]);
      },
      (body: Record<string, unknown>) => {
        expect(body).toMatchObject({
          success: true,
          data: {
            state: 'available',
            assets: [],
          },
        });
        expect(prisma.asset.count).toHaveBeenCalled();
        expect(prisma.asset.findMany).toHaveBeenCalled();
      },
    ],
    [
      'GET /api/v1/positions',
      '/api/v1/positions',
      () => {
        mockActiveUser();
        mockActiveSeason();
        mockJoinedParticipant();
        prisma.position.findMany.mockResolvedValueOnce([]);
      },
      (body: Record<string, unknown>) => {
        expect(body).toMatchObject({
          success: true,
          data: {
            state: 'available',
            positions: [],
          },
        });
        expect(prisma.position.findMany).toHaveBeenCalled();
      },
    ],
    [
      'GET /api/v1/records',
      '/api/v1/records',
      () => {
        mockActiveUser();
        mockActiveSeason();
        mockJoinedParticipant();
        prisma.exchangeTransaction.count.mockResolvedValueOnce(0);
        prisma.exchangeTransaction.findMany.mockResolvedValueOnce([]);
        prisma.walletTransaction.count.mockResolvedValueOnce(0);
        prisma.walletTransaction.findMany.mockResolvedValueOnce([]);
        prisma.order.count.mockResolvedValueOnce(0);
        prisma.order.findMany.mockResolvedValueOnce([]);
      },
      (body: Record<string, unknown>) => {
        expect(body).toMatchObject({
          success: true,
          data: {
            state: 'available',
            exchanges: {
              records: [],
            },
            walletTransactions: {
              records: [],
            },
            orders: {
              records: [],
            },
          },
        });
        expect(prisma.exchangeTransaction.count).toHaveBeenCalled();
        expect(prisma.walletTransaction.count).toHaveBeenCalled();
        expect(prisma.order.count).toHaveBeenCalled();
      },
    ],
    [
      'GET /api/v1/records/me/seasons',
      '/api/v1/records/me/seasons',
      () => {
        mockActiveUser();
        prisma.seasonParticipant.count.mockResolvedValueOnce(0);
      },
      (body: Record<string, unknown>) => {
        expect(body).toMatchObject({
          success: true,
          data: {
            state: 'empty',
            seasons: [],
          },
        });
        expect(prisma.seasonParticipant.count).toHaveBeenCalled();
      },
    ],
    [
      'GET /api/v1/records/me/seasons/:seasonId',
      '/api/v1/records/me/seasons/season-1',
      () => {
        mockActiveUser();
        prisma.season.findUnique.mockResolvedValueOnce(season);
        prisma.seasonParticipant.findUnique.mockResolvedValueOnce(null);
      },
      (body: Record<string, unknown>) => {
        expect(body).toMatchObject({
          success: true,
          data: {
            state: 'not_joined',
            participant: null,
          },
        });
        expect(prisma.season.findUnique).toHaveBeenCalled();
      },
    ],
    [
      'GET /api/v1/records/me/seasons/:seasonId/orders',
      '/api/v1/records/me/seasons/season-1/orders',
      () => {
        mockActiveUser();
        prisma.season.findUnique.mockResolvedValueOnce(season);
        prisma.seasonParticipant.findUnique.mockResolvedValueOnce(null);
      },
      (body: Record<string, unknown>) => {
        expect(body).toMatchObject({
          success: true,
          data: {
            state: 'not_joined',
            orders: [],
          },
        });
        expect(prisma.order.findMany).not.toHaveBeenCalled();
      },
    ],
    [
      'GET /api/v1/records/me/seasons/:seasonId/exchanges',
      '/api/v1/records/me/seasons/season-1/exchanges',
      () => {
        mockActiveUser();
        prisma.season.findUnique.mockResolvedValueOnce(season);
        prisma.seasonParticipant.findUnique.mockResolvedValueOnce(null);
      },
      (body: Record<string, unknown>) => {
        expect(body).toMatchObject({
          success: true,
          data: {
            state: 'not_joined',
            exchanges: [],
          },
        });
        expect(prisma.exchangeTransaction.findMany).not.toHaveBeenCalled();
      },
    ],
    [
      'GET /api/v1/users/:userId/records/:seasonId',
      '/api/v1/users/user-2/records/season-1',
      () => {
        prisma.user.findUnique
          .mockResolvedValueOnce({
            ...user,
            status: 'active',
          })
          .mockResolvedValueOnce({
            id: 'user-2',
            nickname: 'traderLee',
            profileImageUrl: null,
          });
        prisma.season.findUnique.mockResolvedValueOnce(season);
        prisma.seasonParticipant.findUnique.mockResolvedValueOnce(null);
      },
      (body: Record<string, unknown>) => {
        expect(body).toMatchObject({
          success: true,
          data: {
            state: 'not_joined',
            user: {
              id: 'user-2',
            },
          },
        });
        expect(prisma.user.findUnique).toHaveBeenCalledTimes(2);
      },
    ],
    [
      'GET /api/v1/rewards/me',
      '/api/v1/rewards/me',
      () => {
        mockActiveUser();
        prisma.$queryRaw.mockResolvedValueOnce([{ count: 0 }]);
        prisma.$queryRaw.mockResolvedValueOnce([]);
      },
      (body: Record<string, unknown>) => {
        expect(body).toMatchObject({
          success: true,
          data: {
            state: 'empty',
            items: [],
            pagination: {
              total: 0,
              returned: 0,
              nextOffset: null,
            },
          },
        });
        expect(prisma.$queryRaw).toHaveBeenCalled();
      },
    ],
    [
      'GET /api/v1/badges/me',
      '/api/v1/badges/me',
      () => {
        mockActiveUser();
        prisma.$queryRaw.mockResolvedValueOnce([{ count: 0 }]);
        prisma.$queryRaw.mockResolvedValueOnce([]);
      },
      (body: Record<string, unknown>) => {
        expect(body).toMatchObject({
          success: true,
          data: {
            state: 'empty',
            items: [],
            pagination: {
              total: 0,
              returned: 0,
              nextOffset: null,
            },
          },
        });
        expect(prisma.$queryRaw).toHaveBeenCalled();
      },
    ],
    [
      'GET /api/v1/orders',
      '/api/v1/orders',
      () => {
        mockActiveUser();
        mockActiveSeason();
        mockJoinedParticipant();
        prisma.order.count.mockResolvedValueOnce(0);
        prisma.order.findMany.mockResolvedValueOnce([]);
      },
      (body: Record<string, unknown>) => {
        expect(body).toMatchObject({
          success: true,
          data: {
            state: 'available',
            orders: [],
          },
        });
        expect(prisma.order.findMany).toHaveBeenCalled();
      },
    ],
  ] as Array<
    [string, string, () => void, (body: Record<string, unknown>) => void]
  >)(
    '%s accepts a valid active-user token and reaches the service',
    async (_label, path, setup, assertBody) => {
      resetPrismaMocks();
      setup();
      const token = await createValidAccessToken();

      return request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
        .expect((response) => {
          expect(response.body.error?.code).not.toBe('UNAUTHORIZED');
          assertBody(response.body);
        });
    },
  );

  it('/api/v1/assets/:assetId (GET) accepts a valid bearer token and reaches service-level ASSET_NOT_FOUND', async () => {
    resetPrismaMocks();
    mockActiveUser();
    prisma.asset.findUnique.mockResolvedValueOnce(null);
    const token = await createValidAccessToken();

    return request(app.getHttpServer())
      .get('/api/v1/assets/asset-missing')
      .set('Authorization', `Bearer ${token}`)
      .expect(404)
      .expect((response) => {
        expect(response.body).toMatchObject({
          success: false,
          error: {
            code: 'ASSET_NOT_FOUND',
          },
        });
        expect(response.body.error?.code).not.toBe('UNAUTHORIZED');
        expect(prisma.user.findUnique).toHaveBeenCalled();
        expect(prisma.asset.findUnique).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              id: 'asset-missing',
            },
          }),
        );
        expectNoWriteMutationCalls();
      });
  });

  it.each(protectedWritePathRequests)(
    '$label rejects missing token and x-user-id-only requests before write mutation',
    async ({ method, path, body }) => {
      await expectUnauthorizedWithoutToken(method, path, body);
      await expectUnauthorizedWithXUserId(method, path, body);
    },
  );

  it.each(protectedWritePathRequests)(
    '$label rejects invalid and malformed bearer tokens before service work',
    async ({ method, path, body }) => {
      await expectUnauthorizedWithAuthorization(
        method,
        path,
        'Bearer invalid-token',
        body,
      );
      await expectUnauthorizedWithAuthorization(
        method,
        path,
        'Token invalid-token',
        body,
      );
    },
  );

  it.each([
    {
      label: 'POST /api/v1/seasons/:seasonId/join',
      path: '/api/v1/seasons/season-1/join',
      body: undefined,
      expectedStatus: 201,
      setup: () => {
        mockActiveUser();
        prisma.season.findUnique.mockResolvedValueOnce(season);
        prisma.seasonParticipant.findUnique.mockResolvedValueOnce(null);
        prisma.seasonParticipant.create.mockResolvedValueOnce({
          id: participant.id,
        });
        prisma.cashWallet.create
          .mockResolvedValueOnce({ id: krwWallet.id })
          .mockResolvedValueOnce({ id: usdWallet.id });
        prisma.walletTransaction.create.mockResolvedValueOnce({
          id: 'wallet-transaction-1',
        });
        prisma.equitySnapshot.create.mockResolvedValueOnce({
          id: 'equity-snapshot-1',
        });
      },
      assertBody: (body: Record<string, unknown>) => {
        expect(body).toMatchObject({
          success: true,
          data: {
            seasonParticipantId: participant.id,
            seasonId: season.id,
            wallets: {
              KRW: '10000000.00000000',
              USD: '0.00000000',
            },
          },
        });
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(prisma.seasonParticipant.create).toHaveBeenCalled();
        expect(prisma.cashWallet.create).toHaveBeenCalledTimes(2);
        expect(prisma.walletTransaction.create).toHaveBeenCalledTimes(1);
        expect(prisma.equitySnapshot.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            seasonParticipantId: participant.id,
            totalAssetKrw: '10000000.00000000',
            returnRate: '0.00000000',
            krwCash: '10000000.00000000',
            snapshotReason: 'season_join',
          }),
        });
      },
    },
    {
      label: 'POST /api/v1/fx/quote',
      path: '/api/v1/fx/quote',
      body: {
        fromCurrency: 'KRW',
        toCurrency: 'USD',
        sourceAmount: '1000',
      },
      expectedStatus: 403,
      setup: () => {
        mockActiveUser();
        mockActiveSeason();
        prisma.seasonParticipant.findUnique.mockResolvedValueOnce(null);
      },
      assertBody: (body: Record<string, unknown>) => {
        expect(body).toMatchObject({
          success: false,
          error: {
            code: 'SEASON_NOT_JOINED',
          },
        });
        expect(prisma.season.findFirst).toHaveBeenCalled();
        expect(prisma.seasonParticipant.findUnique).toHaveBeenCalled();
        expectNoWriteMutationCalls();
      },
    },
    {
      label: 'POST /api/v1/fx/execute',
      path: '/api/v1/fx/execute',
      body: {
        quoteId: 'quote-fx-e2e-1',
        idempotencyKey: 'e2e-fx-exec-1',
        fromCurrency: 'KRW',
        toCurrency: 'USD',
        sourceAmount: '1000',
      },
      expectedStatus: 403,
      setup: () => {
        mockActiveUser();
        mockActiveSeason();
        prisma.seasonParticipant.findUnique.mockResolvedValueOnce(null);
      },
      assertBody: (body: Record<string, unknown>) => {
        expect(body).toMatchObject({
          success: false,
          error: {
            code: 'SEASON_NOT_JOINED',
          },
        });
        expect(prisma.season.findFirst).toHaveBeenCalled();
        expect(prisma.seasonParticipant.findUnique).toHaveBeenCalled();
        expectNoWriteMutationCalls();
      },
    },
    {
      label: 'POST /api/v1/orders/quote',
      path: '/api/v1/orders/quote',
      body: {
        assetId: 'asset-1',
        side: 'buy',
        orderType: 'market',
        quantity: '1',
        idempotencyKey: 'e2e-order-quote-1',
      },
      expectedStatus: 403,
      setup: () => {
        mockActiveUser();
        mockActiveSeason();
        prisma.seasonParticipant.findUnique.mockResolvedValueOnce(null);
      },
      assertBody: (body: Record<string, unknown>) => {
        expect(body).toMatchObject({
          success: false,
          error: {
            code: 'SEASON_NOT_JOINED',
          },
        });
        expect(prisma.season.findFirst).toHaveBeenCalled();
        expect(prisma.seasonParticipant.findUnique).toHaveBeenCalled();
        expectNoWriteMutationCalls();
      },
    },
    {
      label: 'POST /api/v1/orders',
      path: '/api/v1/orders',
      body: {
        assetId: 'asset-1',
        side: 'buy',
        orderType: 'market',
        quantity: '1',
        quoteId: 'quote-order-e2e-1',
        idempotencyKey: 'e2e-order-create-1',
      },
      expectedStatus: 403,
      setup: () => {
        mockActiveUser();
        mockActiveSeason();
        prisma.seasonParticipant.findUnique.mockResolvedValueOnce(null);
      },
      assertBody: (body: Record<string, unknown>) => {
        expect(body).toMatchObject({
          success: false,
          error: {
            code: 'SEASON_NOT_JOINED',
          },
        });
        expect(prisma.season.findFirst).toHaveBeenCalled();
        expect(prisma.seasonParticipant.findUnique).toHaveBeenCalled();
        expectNoWriteMutationCalls();
      },
    },
    {
      label: 'POST /api/v1/orders/:orderId/cancel',
      path: '/api/v1/orders/order-1/cancel',
      body: undefined,
      expectedStatus: 410,
      setup: () => {
        mockActiveUser();
      },
      assertBody: (body: Record<string, unknown>) => {
        expect(body).toMatchObject({
          success: false,
          error: {
            code: 'ORDER_CANCEL_NOT_SUPPORTED',
          },
        });
        expect(prisma.order.findFirst).not.toHaveBeenCalled();
        expectNoWriteMutationCalls();
      },
    },
    {
      label: 'POST /api/v1/orders/:orderId/execute',
      path: '/api/v1/orders/order-1/execute',
      body: undefined,
      expectedStatus: 404,
      setup: () => {
        mockActiveUser();
        prisma.order.findFirst.mockResolvedValueOnce(null);
      },
      assertBody: (body: Record<string, unknown>) => {
        expect(body).toMatchObject({
          success: false,
          error: {
            code: 'ORDER_NOT_FOUND',
          },
        });
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(prisma.order.findFirst).toHaveBeenCalled();
        expectNoModelWriteMutationCalls();
      },
    },
  ])(
    '$label accepts a valid bearer token and reaches a service-level response',
    async ({ path, body, expectedStatus, setup, assertBody }) => {
      resetPrismaMocks();
      setup();
      const token = await createValidAccessToken();
      const testRequest = request(app.getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${token}`);

      if (body) {
        testRequest.send(body);
      }

      return testRequest.expect(expectedStatus).expect((response) => {
        expect(response.body.error?.code).not.toBe('UNAUTHORIZED');
        expect(prisma.user.findUnique).toHaveBeenCalled();
        assertBody(response.body);
      });
    },
  );
});
