jest.mock('../src/generated/prisma/client', () => ({
  PrismaClient: class {},
  UserRole: { user: 'user' },
  UserStatus: { active: 'active', suspended: 'suspended', deleted: 'deleted' },
}));

import {
  type INestApplication,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request, { type Response } from 'supertest';
import type { Server } from 'node:http';
import type { CurrentUserResponse } from '../src/auth/auth.types';
import { AuthController } from '../src/auth/auth.controller';
import { AuthService } from '../src/auth/auth.service';
import { AccessTokenGuard } from '../src/auth/access-token.guard';
import { ProfileImageController } from '../src/auth/profile-image.controller';
import { ProfileImageService } from '../src/auth/profile-image.service';
import { ProfileImageStorageService } from '../src/auth/profile-image-storage.service';
import {
  PROFILE_IMAGE_MAX_BYTES,
  profileImageError,
} from '../src/auth/profile-image.validation';
import { PrismaService } from '../src/prisma/prisma.service';
import { GlobalHttpExceptionFilter } from '../src/common/global-http-exception.filter';

function body(response: Response): {
  data: CurrentUserResponse['data'];
  error: { code: string };
} {
  return response.body as {
    data: CurrentUserResponse['data'];
    error: { code: string };
  };
}

const owner = 'cbdc80ec-8f69-44fd-8a76-32b1c136e06a';
const original = {
  id: owner,
  email: 'me@example.test',
  nickname: 'me',
  role: 'user',
  status: 'active',
  portfolioPublic: true,
  profileImageUrl: null as string | null,
  createdAt: new Date('2026-10-06T00:00:00Z'),
};
const jpeg = readFileSync(join(__dirname, 'fixtures/profile-image.jpg'));

describe('authenticated multipart profile image HTTP API (storage/DB fixtures)', () => {
  let app: INestApplication<Server>;
  let token: string;
  let user = { ...original };
  let databaseFailure = false;
  const storage = {
    requireConfigured: jest.fn(),
    upload: jest.fn(),
    delete: jest.fn(),
    publicUrl: (key: string) => `https://cdn.example.test/${key}`,
    managedKey: (url: string | null, userId: string) =>
      url?.startsWith(`https://cdn.example.test/profile-images/${userId}/`)
        ? url.slice('https://cdn.example.test/'.length)
        : null,
  };
  let warn: jest.SpyInstance;

  beforeAll(async () => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      user: {
        findUnique: jest
          .fn()
          .mockImplementation(({ where }: { where: { id?: string } }) =>
            Promise.resolve(where.id === owner ? { ...user } : null),
          ),
        update: jest
          .fn()
          .mockImplementation(({ data }: { data: Record<string, unknown> }) => {
            if (databaseFailure)
              return Promise.reject(new Error('private DB failure'));
            user = { ...user, ...data };
            return Promise.resolve({ ...user });
          }),
      },
    };
    const module = await Test.createTestingModule({
      imports: [JwtModule.register({})],
      controllers: [AuthController, ProfileImageController],
      providers: [
        AuthService,
        ProfileImageService,
        AccessTokenGuard,
        { provide: APP_GUARD, useExisting: AccessTokenGuard },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            JWT_ACCESS_SECRET: 'profile-test-secret',
            REFRESH_TOKEN_TTL: '7d',
          }),
        },
        {
          provide: PrismaService,
          useValue: {
            ...tx,
            $transaction: (run: (client: typeof tx) => Promise<unknown>) =>
              run(tx),
          },
        },
        { provide: ProfileImageStorageService, useValue: storage },
      ],
    }).compile();
    app = module.createNestApplication<INestApplication<Server>>();
    app.useGlobalFilters(new GlobalHttpExceptionFilter());
    await app.init();
    await app.listen(0, '127.0.0.1');
    token = await module
      .get(JwtService)
      .signAsync({ sub: owner }, { secret: 'profile-test-secret' });
  });
  afterAll(async () => {
    await app?.close();
    warn?.mockRestore();
  });
  beforeEach(() => {
    user = { ...original };
    databaseFailure = false;
    storage.requireConfigured.mockReset();
    storage.upload.mockReset().mockResolvedValue(undefined);
    storage.delete.mockReset().mockResolvedValue(undefined);
  });

  it('requires Bearer auth on both endpoints before multipart/storage work', async () => {
    for (const authorization of ['', 'Bearer invalid']) {
      await request(app.getHttpServer())
        .post('/api/v1/me/profile-image')
        .set('Authorization', authorization)
        .attach('file', jpeg, {
          filename: 'avatar.jpg',
          contentType: 'image/jpeg',
        })
        .expect(401);
      await request(app.getHttpServer())
        .delete('/api/v1/me/profile-image')
        .set('Authorization', authorization)
        .expect(401);
    }
    expect(storage.upload).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('uploads JPEG, returns GET /me shape, replaces and idempotently deletes', async () => {
    const first = await request(app.getHttpServer())
      .post('/api/v1/me/profile-image')
      .auth(token, { type: 'bearer' })
      .attach('file', jpeg, {
        filename: '../private.jpg',
        contentType: 'image/jpeg',
      })
      .expect(200);
    expect(body(first)).toMatchObject({
      success: true,
      data: {
        id: owner,
        nickname: 'me',
        portfolioPublic: true,
        profileImageUrl: expect.stringMatching(
          new RegExp(
            `^https://cdn.example.test/profile-images/${owner}/[0-9a-f-]+\\.jpg$`,
          ),
        ) as unknown,
      },
    });
    const get = await request(app.getHttpServer())
      .get('/api/v1/me')
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(body(get)).toEqual(body(first));
    const second = await request(app.getHttpServer())
      .post('/api/v1/me/profile-image')
      .auth(token, { type: 'bearer' })
      .attach('file', jpeg, {
        filename: 'avatar.jpg',
        contentType: 'image/jpeg',
      })
      .expect(200);
    expect(body(second).data.profileImageUrl).not.toBe(
      body(first).data.profileImageUrl,
    );
    expect(storage.delete).toHaveBeenCalledWith(
      body(first).data.profileImageUrl!.slice(
        'https://cdn.example.test/'.length,
      ),
    );
    for (let count = 0; count < 2; count++) {
      const deleted = await request(app.getHttpServer())
        .delete('/api/v1/me/profile-image')
        .auth(token, { type: 'bearer' })
        .expect(200);
      expect(body(deleted).data.profileImageUrl).toBeNull();
    }
    expect(storage.delete).toHaveBeenCalledTimes(2);
  });

  it('rejects absent, oversized, wrong MIME and fake JPEG files with safe codes', async () => {
    const missing = await request(app.getHttpServer())
      .post('/api/v1/me/profile-image')
      .auth(token, { type: 'bearer' })
      .expect(400);
    expect(body(missing).error.code).toBe('PROFILE_IMAGE_REQUIRED');
    const large = await request(app.getHttpServer())
      .post('/api/v1/me/profile-image')
      .auth(token, { type: 'bearer' })
      .attach('file', Buffer.alloc(PROFILE_IMAGE_MAX_BYTES + 1), {
        filename: 'large.jpg',
        contentType: 'image/jpeg',
      })
      .expect(413);
    expect(body(large).error.code).toBe('PROFILE_IMAGE_TOO_LARGE');
    for (const [buffer, contentType] of [
      [jpeg, 'image/png'],
      [Buffer.from('<svg/>'), 'image/svg+xml'],
      [Buffer.from('<html/>'), 'image/jpeg'],
      [Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg'],
    ] as const) {
      const invalid = await request(app.getHttpServer())
        .post('/api/v1/me/profile-image')
        .auth(token, { type: 'bearer' })
        .attach('file', buffer, { filename: 'avatar.jpg', contentType })
        .expect(400);
      expect(body(invalid).error.code).toBe('INVALID_PROFILE_IMAGE');
    }
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('rejects other fields, multi-file uploads and userId injection', async () => {
    for (const route of [
      request(app.getHttpServer())
        .post('/api/v1/me/profile-image')
        .attach('wrong', jpeg, {
          filename: 'avatar.jpg',
          contentType: 'image/jpeg',
        }),
      request(app.getHttpServer())
        .post('/api/v1/me/profile-image')
        .attach('file', jpeg, {
          filename: 'avatar.jpg',
          contentType: 'image/jpeg',
        })
        .attach('file', jpeg, {
          filename: 'avatar.jpg',
          contentType: 'image/jpeg',
        }),
      request(app.getHttpServer())
        .post('/api/v1/me/profile-image')
        .field('userId', 'another-user')
        .attach('file', jpeg, {
          filename: 'avatar.jpg',
          contentType: 'image/jpeg',
        }),
    ]) {
      const result = await route.auth(token, { type: 'bearer' }).expect(400);
      expect(body(result).error.code).toBe('INVALID_PROFILE_IMAGE');
    }
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('reports disabled storage on both endpoints and conceals provider errors', async () => {
    storage.requireConfigured.mockImplementation(() => {
      throw new ServiceUnavailableException(
        profileImageError(
          'PROFILE_IMAGE_STORAGE_UNAVAILABLE',
          'Profile image storage is unavailable.',
        ),
      );
    });
    const unavailable = await request(app.getHttpServer())
      .post('/api/v1/me/profile-image')
      .auth(token, { type: 'bearer' })
      .attach('file', jpeg, {
        filename: 'avatar.jpg',
        contentType: 'image/jpeg',
      })
      .expect(503);
    expect(body(unavailable).error.code).toBe(
      'PROFILE_IMAGE_STORAGE_UNAVAILABLE',
    );
    await request(app.getHttpServer())
      .delete('/api/v1/me/profile-image')
      .auth(token, { type: 'bearer' })
      .expect(503);
    storage.requireConfigured.mockReset();
    storage.upload.mockRejectedValue(new Error('AWS secret token'));
    const failure = await request(app.getHttpServer())
      .post('/api/v1/me/profile-image')
      .auth(token, { type: 'bearer' })
      .attach('file', jpeg, {
        filename: 'avatar.jpg',
        contentType: 'image/jpeg',
      })
      .expect(503);
    expect(body(failure).error.code).toBe('PROFILE_IMAGE_UPLOAD_FAILED');
    expect(JSON.stringify(body(failure))).not.toMatch(/AWS|secret|token/);
  });

  it('cleans a new object after DB failure and never deletes an external URL', async () => {
    user.profileImageUrl = 'https://legacy.example.test/avatar.jpg';
    databaseFailure = true;
    const failed = await request(app.getHttpServer())
      .post('/api/v1/me/profile-image')
      .auth(token, { type: 'bearer' })
      .attach('file', jpeg, {
        filename: 'avatar.jpg',
        contentType: 'image/jpeg',
      })
      .expect(500);
    expect(body(failed).error.code).toBe('INTERNAL_SERVER_ERROR');
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(user.profileImageUrl).toBe('https://legacy.example.test/avatar.jpg');
    databaseFailure = false;
    storage.delete.mockClear();
    await request(app.getHttpServer())
      .delete('/api/v1/me/profile-image')
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('blocks URL PATCH while preserving nickname and portfolio privacy', async () => {
    for (const profileImageUrl of [
      'https://attacker.example/avatar.jpg',
      null,
    ]) {
      const blocked = await request(app.getHttpServer())
        .patch('/api/v1/me')
        .auth(token, { type: 'bearer' })
        .send({ profileImageUrl, portfolioPublic: false })
        .expect(400);
      expect(body(blocked).error.code).toBe('PROFILE_IMAGE_READ_ONLY');
      expect(user.portfolioPublic).toBe(true);
    }
    const saved = await request(app.getHttpServer())
      .patch('/api/v1/me')
      .auth(token, { type: 'bearer' })
      .send({ nickname: 'new name', portfolioPublic: false })
      .expect(200);
    expect(body(saved).data).toMatchObject({
      nickname: 'new name',
      portfolioPublic: false,
    });
  });

  it('rejects inactive users on upload/delete', async () => {
    user.status = 'suspended';
    await request(app.getHttpServer())
      .post('/api/v1/me/profile-image')
      .auth(token, { type: 'bearer' })
      .attach('file', jpeg)
      .expect(403);
    await request(app.getHttpServer())
      .delete('/api/v1/me/profile-image')
      .auth(token, { type: 'bearer' })
      .expect(403);
    expect(storage.upload).not.toHaveBeenCalled();
  });
});
