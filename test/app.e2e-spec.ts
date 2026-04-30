jest.mock('../src/generated/prisma/client', () => ({
  CurrencyCode: {
    KRW: 'KRW',
    USD: 'USD',
  },
  ParticipantStatus: {
    active: 'active',
    registered: 'registered',
    finished: 'finished',
    rewarded: 'rewarded',
  },
  Prisma: {
    PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {},
  },
  PrismaClient: class PrismaClient {},
  SeasonStatus: {
    active: 'active',
    upcoming: 'upcoming',
    ended: 'ended',
    settled: 'settled',
  },
  WalletTransactionDirection: {
    credit: 'credit',
    debit: 'debit',
  },
  WalletTransactionReferenceType: {
    season_join: 'season_join',
  },
  WalletTransactionType: {
    initial_grant: 'initial_grant',
  },
}));

jest.mock('../src/prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({
        $connect: jest.fn(),
        $disconnect: jest.fn(),
        $queryRaw: jest.fn(),
      })
      .compile();

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
});
