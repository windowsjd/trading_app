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
    UserStatus: {
      active: 'active',
      suspended: 'suspended',
      deleted: 'deleted',
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
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { Prisma } from './../src/generated/prisma/client';
import { PrismaService } from './../src/prisma/prisma.service';
import * as argon2 from 'argon2';

const mockedArgon2 = jest.mocked(argon2);

type HttpMethod = 'get' | 'post';

type PrismaMock = {
  $connect: jest.Mock;
  $disconnect: jest.Mock;
  $queryRaw: jest.Mock;
  $transaction: jest.Mock;
  asset: {
    findUnique: jest.Mock;
  };
  assetPriceSnapshot: {
    findFirst: jest.Mock;
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
    create: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  season: {
    findFirst: jest.Mock;
    findUnique: jest.Mock;
  };
  seasonParticipant: {
    create: jest.Mock;
    findUnique: jest.Mock;
  };
  seasonRanking: {
    count: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
  };
  user: {
    create: jest.Mock;
    findUnique: jest.Mock;
  };
  walletTransaction: {
    count: jest.Mock;
    create: jest.Mock;
    findMany: jest.Mock;
  };
};

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;
  let jwtService: JwtService;
  let prisma: PrismaMock;

  const originalJwtAccessSecret = process.env.JWT_ACCESS_SECRET;
  const originalJwtAccessTtl = process.env.JWT_ACCESS_TTL;
  const now = new Date('2026-05-09T00:00:00.000Z');
  const user = {
    id: 'user-1',
    email: 'user@example.com',
    passwordHash: 'hashed-password',
    nickname: 'traderKim',
    profileImageUrl: null,
    status: 'active',
    createdAt: now,
  };
  const season = {
    id: 'season-1',
    name: 'Season 1',
    status: 'active',
    startAt: new Date('2026-05-01T00:00:00.000Z'),
    endAt: new Date('2026-05-31T00:00:00.000Z'),
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

  beforeAll(() => {
    process.env.JWT_ACCESS_SECRET = 'test-secret';
    process.env.JWT_ACCESS_TTL = '15m';
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
        findUnique: jest.fn(),
      },
      assetPriceSnapshot: {
        findFirst: jest.fn(),
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
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      season: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
      },
      seasonParticipant: {
        create: jest.fn(),
        findUnique: jest.fn(),
      },
      seasonRanking: {
        count: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
      },
      user: {
        create: jest.fn(),
        findUnique: jest.fn(),
      },
      walletTransaction: {
        count: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
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

  const mockActiveUser = (userId = user.id) => {
    prisma.user.findUnique.mockResolvedValue({
      ...user,
      id: userId,
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
    return method === 'get' ? http.get(path) : http.post(path);
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
  };

  const expectNoServiceDatabaseCalls = () => {
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.season.findFirst).not.toHaveBeenCalled();
    expect(prisma.season.findUnique).not.toHaveBeenCalled();
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
    expect(prisma.asset.findUnique).not.toHaveBeenCalled();
    expect(prisma.assetPriceSnapshot.findFirst).not.toHaveBeenCalled();
    expect(prisma.order.count).not.toHaveBeenCalled();
    expect(prisma.order.findFirst).not.toHaveBeenCalled();
    expect(prisma.order.findMany).not.toHaveBeenCalled();
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
    expect(prisma.position.findFirst).not.toHaveBeenCalled();
    expect(prisma.position.findMany).not.toHaveBeenCalled();
    expect(prisma.position.findUnique).not.toHaveBeenCalled();
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

  it('/api/v1/auth/signup (POST) creates a user and returns an access token', () => {
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
        expect(JSON.stringify(response.body)).not.toContain('passwordHash');
        expect(prisma.user.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              email: user.email,
              passwordHash: 'hashed-password',
            }),
          }),
        );
      });
  });

  it('/api/v1/auth/login (POST) authenticates a user and returns an access token', () => {
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
        expect(JSON.stringify(response.body)).not.toContain('passwordHash');
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
    ['GET /api/v1/positions', 'get', '/api/v1/positions'],
    ['GET /api/v1/records', 'get', '/api/v1/records'],
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
        expect(prisma.order.findFirst).toHaveBeenCalled();
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
