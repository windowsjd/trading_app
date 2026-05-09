jest.mock('../src/generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    AssetPriceSourceType: {
      admin_manual: 'admin_manual',
      official_batch: 'official_batch',
      provider_api: 'provider_api',
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
import { PrismaService } from './../src/prisma/prisma.service';
import * as argon2 from 'argon2';

const mockedArgon2 = jest.mocked(argon2);

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;
  let jwtService: JwtService;
  let prisma: {
    $connect: jest.Mock;
    $disconnect: jest.Mock;
    $queryRaw: jest.Mock;
    season: {
      findFirst: jest.Mock;
    };
    seasonParticipant: {
      findUnique: jest.Mock;
    };
    user: {
      findUnique: jest.Mock;
      create: jest.Mock;
    };
  };

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
    initialCapitalKrw: {
      toFixed: jest.fn(() => '10000000.00000000'),
    },
    tradeFeeRate: {
      toFixed: jest.fn(() => '0.001000'),
    },
    fxFeeRate: {
      toFixed: jest.fn(() => '0.001000'),
    },
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
      $queryRaw: jest.fn(),
      season: {
        findFirst: jest.fn(),
      },
      seasonParticipant: {
        findUnique: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
    };

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

  it('/api/v1/auth/signup (POST) creates a user and returns an access token', () => {
    prisma.user.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
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

  it('/api/v1/fx/quote (POST) rejects unauthenticated requests', () => {
    return request(app.getHttpServer())
      .post('/api/v1/fx/quote')
      .send({
        fromCurrency: 'KRW',
        toCurrency: 'USD',
        sourceAmount: '135000',
      })
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
});
