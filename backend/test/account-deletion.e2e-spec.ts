jest.mock('../src/generated/prisma/client', () => ({
  PrismaClient: class {},
  UserRole: { user: 'user' },
  UserStatus: { active: 'active', suspended: 'suspended', deleted: 'deleted' },
}));

import { type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Server } from 'node:http';
import { AccessTokenGuard } from '../src/auth/access-token.guard';
import { AccountDeletionController } from '../src/auth/account-deletion.controller';
import { AccountDeletionService } from '../src/auth/account-deletion.service';
import { createApiError } from '../src/common/api-error';
import { GlobalHttpExceptionFilter } from '../src/common/global-http-exception.filter';
import { PrismaService } from '../src/prisma/prisma.service';

const owner = 'cbdc80ec-8f69-44fd-8a76-32b1c136e06a';
const deletion = {
  status: 'completed',
  deletedAt: '2026-10-18T00:00:00.000Z',
  completedAt: '2026-10-18T00:00:00.000Z',
};

describe('account deletion HTTP routes (service fixture)', () => {
  let app: INestApplication<Server>;
  let token: string;
  let exists = true;
  const service = {
    checkPassword: jest.fn(),
    deleteFromApp: jest.fn(),
    deleteFromWeb: jest.fn(),
    status: jest.fn(),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [JwtModule.register({})],
      controllers: [AccountDeletionController],
      providers: [
        AccessTokenGuard,
        { provide: APP_GUARD, useExisting: AccessTokenGuard },
        { provide: AccountDeletionService, useValue: service },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            JWT_ACCESS_SECRET: 'deletion-test-secret',
          }),
        },
        {
          provide: PrismaService,
          useValue: {
            user: {
              findUnique: ({ where }: { where: { id: string } }) =>
                Promise.resolve(
                  exists && where.id === owner
                    ? {
                        id: owner,
                        role: 'user',
                        status: 'active',
                        tokenVersion: 0,
                      }
                    : null,
                ),
            },
          },
        },
      ],
    }).compile();
    app = module.createNestApplication<INestApplication<Server>>();
    app.useGlobalFilters(new GlobalHttpExceptionFilter());
    await app.init();
    token = await module
      .get(JwtService)
      .signAsync({ sub: owner, tv: 0 }, { secret: 'deletion-test-secret' });
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    exists = true;
    for (const fn of Object.values(service))
      fn.mockReset().mockResolvedValue({ success: true, data: { deletion } });
  });

  it('requires a Bearer token for both app routes before the service runs', async () => {
    for (const path of [
      '/api/v1/me/account-deletion',
      '/api/v1/me/account-deletion/password-check',
    ]) {
      const response = await request(app.getHttpServer())
        .post(path)
        .send({ password: 'pw', requestKey: 'k'.repeat(43), confirm: true });
      expect(response.status).toBe(401);
      expect((response.body as { error: { code: string } }).error.code).toBe(
        'UNAUTHORIZED',
      );
    }
    expect(service.deleteFromApp).not.toHaveBeenCalled();
    expect(service.checkPassword).not.toHaveBeenCalled();
  });

  it('uses only the token identity and ignores a body userId', async () => {
    const body = {
      password: 'pw',
      requestKey: 'k'.repeat(43),
      confirm: true,
      userId: 'someone-else',
    };
    const response = await request(app.getHttpServer())
      .post('/api/v1/me/account-deletion')
      .set('Authorization', `Bearer ${token}`)
      .set('User-Agent', 'deletion-e2e')
      .send(body);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, data: { deletion } });
    const [userId, received, metadata] = service.deleteFromApp.mock
      .calls[0] as [string, Record<string, unknown>, { userAgent: string }];
    expect(userId).toBe(owner);
    expect(received).toEqual(body);
    expect(metadata.userAgent).toBe('deletion-e2e');
  });

  it('rejects a token whose member no longer exists', async () => {
    exists = false;
    const response = await request(app.getHttpServer())
      .post('/api/v1/me/account-deletion/password-check')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'pw' });
    expect(response.status).toBe(401);
    expect(service.checkPassword).not.toHaveBeenCalled();
  });

  it('serves the web request and status routes without a login', async () => {
    const web = await request(app.getHttpServer())
      .post('/api/v1/auth/account-deletion')
      .send({
        email: 'm@example.com',
        verificationToken: 'p',
        requestKey: 'k',
        confirm: true,
      });
    expect(web.status).toBe(200);
    expect(service.deleteFromWeb).toHaveBeenCalledTimes(1);
    const status = await request(app.getHttpServer())
      .post('/api/v1/auth/account-deletion/status')
      .send({ requestKey: 'k'.repeat(43) });
    expect(status.status).toBe(200);
    expect(service.status).toHaveBeenCalledTimes(1);
  });

  it('keeps the shared error envelope and status codes', async () => {
    service.deleteFromApp.mockRejectedValue(
      createApiError(
        'ACCOUNT_DELETION_PASSWORD_MISMATCH',
        'The password does not match.',
        400,
      ),
    );
    const mismatch = await request(app.getHttpServer())
      .post('/api/v1/me/account-deletion')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(mismatch.status).toBe(400);
    expect(mismatch.body).toMatchObject({
      success: false,
      error: {
        code: 'ACCOUNT_DELETION_PASSWORD_MISMATCH',
        message: 'The password does not match.',
      },
    });
    service.status.mockRejectedValue(
      createApiError(
        'ACCOUNT_DELETION_NOT_FOUND',
        'Account deletion request not found.',
        404,
      ),
    );
    const missing = await request(app.getHttpServer())
      .post('/api/v1/auth/account-deletion/status')
      .send({ requestKey: 'k'.repeat(43) });
    expect(missing.status).toBe(404);
    expect((missing.body as { error: { code: string } }).error.code).toBe(
      'ACCOUNT_DELETION_NOT_FOUND',
    );
  });
});
