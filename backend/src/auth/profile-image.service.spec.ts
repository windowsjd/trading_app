jest.mock('../generated/prisma/client', () => ({
  PrismaClient: class {},
  UserStatus: { active: 'active' },
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger, UnauthorizedException } from '@nestjs/common';
import { ProfileImageService } from './profile-image.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthService } from './auth.service';
import type { ProfileImageStorageService } from './profile-image-storage.service';

const userId = 'cbdc80ec-8f69-44fd-8a76-32b1c136e06a';
const jpeg = readFileSync(
  join(__dirname, '../../test/fixtures/profile-image.jpg'),
);
const file = { buffer: jpeg, size: jpeg.length, mimetype: 'image/jpeg' };
const oldKey = `profile-images/${userId}/d1645c18-a1a4-43c9-b1f3-a90c3d63b30b.jpg`;
const oldUrl = `https://cdn.example.test/${oldKey}`;

function harness(url: string | null = oldUrl) {
  let user = {
    id: userId,
    email: 'me@example.test',
    nickname: 'me',
    role: 'user',
    status: 'active',
    portfolioPublic: true,
    profileImageUrl: url,
    createdAt: new Date('2026-10-06T00:00:00Z'),
  };
  const events: string[] = [];
  const tx = {
    $queryRaw: jest.fn().mockImplementation(() => {
      events.push('lock');
      return Promise.resolve([]);
    }),
    user: {
      findUnique: jest
        .fn()
        .mockImplementation(() => Promise.resolve({ ...user })),
      update: jest
        .fn()
        .mockImplementation(
          ({ data }: { data: { profileImageUrl: string | null } }) => {
            events.push('update');
            user = { ...user, ...data };
            return Promise.resolve({ ...user });
          },
        ),
    },
  };
  const prisma = {
    $transaction: jest
      .fn()
      .mockImplementation(async (run: (t: typeof tx) => Promise<unknown>) => {
        const result = await run(tx);
        events.push('commit');
        return result;
      }),
  };
  const auth = {
    me: jest
      .fn()
      .mockImplementation(() =>
        Promise.resolve({ success: true, data: { ...user } }),
      ),
  };
  const storage = {
    requireConfigured: jest.fn(),
    publicUrl: (key: string) => `https://cdn.example.test/${key}`,
    managedKey: (value: string | null, owner: string) =>
      value?.startsWith(`https://cdn.example.test/profile-images/${owner}/`)
        ? value.slice('https://cdn.example.test/'.length)
        : null,
    upload: jest
      .fn<Promise<void>, [string, Buffer]>()
      .mockImplementation(() => {
        events.push('upload');
        return Promise.resolve();
      }),
    delete: jest.fn<Promise<void>, [string]>().mockImplementation(() => {
      events.push('delete');
      return Promise.resolve();
    }),
  };
  const service = new ProfileImageService(
    prisma as unknown as PrismaService,
    auth as unknown as AuthService,
    storage as unknown as ProfileImageStorageService,
  );
  return {
    service,
    storage,
    prisma,
    tx,
    auth,
    events,
    get user() {
      return user;
    },
  };
}

describe('profile image lifecycle', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('uploads a generated unique key, commits, then removes the previous managed file', async () => {
    const h = harness();
    const response = await h.service.upload(userId, {
      ...file,
      originalname: '../../private.jpg',
    } as never);
    const key = h.storage.upload.mock.calls[0][0];
    expect(key).toMatch(
      new RegExp(`^profile-images/${userId}/[0-9a-f-]{36}\\.jpg$`),
    );
    expect(key).not.toContain('private');
    expect(response.data.profileImageUrl).toBe(h.storage.publicUrl(key));
    expect(response.data.nickname).toBe('me');
    expect(response.data.createdAt).toBe('2026-10-06T00:00:00.000Z');
    expect(h.storage.delete).toHaveBeenCalledWith(oldKey);
    expect(h.events).toEqual(['upload', 'lock', 'update', 'commit', 'delete']);
    await h.service.upload(userId, file);
    expect(h.storage.upload.mock.calls[1][0]).not.toBe(key);
  });

  it('uses the latest locked URL rather than the pre-upload snapshot', async () => {
    const h = harness('https://legacy.example.test/photo.jpg');
    h.tx.user.findUnique.mockResolvedValueOnce({
      ...h.user,
      profileImageUrl: oldUrl,
    });
    await h.service.upload(userId, file);
    expect(h.storage.delete).toHaveBeenCalledWith(oldKey);
  });

  it('never requests legacy external URLs on replacement or delete', async () => {
    for (const remove of [false, true]) {
      const h = harness('https://legacy.example.test/photo.jpg');
      if (remove)
        expect(
          (await h.service.delete(userId)).data.profileImageUrl,
        ).toBeNull();
      else await h.service.upload(userId, file);
      expect(h.storage.delete).not.toHaveBeenCalled();
    }
  });

  it('rejects unauthenticated users before storage/DB writes', async () => {
    const h = harness();
    h.auth.me.mockRejectedValue(new UnauthorizedException());
    await expect(h.service.upload(undefined, file)).rejects.toMatchObject({
      status: 401,
    });
    await expect(h.service.delete(undefined)).rejects.toMatchObject({
      status: 401,
    });
    expect(h.storage.upload).not.toHaveBeenCalled();
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('keeps the prior URL on disabled storage or upload failure and hides raw errors', async () => {
    const disabled = harness();
    disabled.storage.requireConfigured.mockImplementation(() => {
      throw new Error('disabled');
    });
    await expect(disabled.service.upload(userId, file)).rejects.toThrow(
      'disabled',
    );
    await expect(disabled.service.delete(userId)).rejects.toThrow('disabled');
    expect(disabled.prisma.$transaction).not.toHaveBeenCalled();
    const h = harness();
    h.storage.upload.mockRejectedValue(
      new Error('secret credentials binary payload'),
    );
    await expect(h.service.upload(userId, file)).rejects.toMatchObject({
      status: 503,
      response: { error: { code: 'PROFILE_IMAGE_UPLOAD_FAILED' } },
    });
    expect(h.user.profileImageUrl).toBe(oldUrl);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.storage.delete).toHaveBeenCalledWith(
      h.storage.upload.mock.calls[0][0],
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
  });

  it('compensates a DB failure by removing only the new object', async () => {
    const h = harness();
    h.tx.user.update.mockRejectedValue(new Error('DB failed'));
    await expect(h.service.upload(userId, file)).rejects.toThrow('DB failed');
    expect(h.user.profileImageUrl).toBe(oldUrl);
    expect(h.storage.delete).toHaveBeenCalledTimes(1);
    expect(h.storage.delete).toHaveBeenCalledWith(
      h.storage.upload.mock.calls[0][0],
    );
    expect(h.storage.delete).not.toHaveBeenCalledWith(oldKey);
  });

  it('preserves DB failure even when compensation also fails', async () => {
    const h = harness();
    h.tx.user.update.mockRejectedValue(new Error('DB failed'));
    h.storage.delete.mockRejectedValue(new Error('secret provider failure'));
    await expect(h.service.upload(userId, file)).rejects.toThrow('DB failed');
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
  });

  it('retains the successful upload and null deletion despite cleanup failure', async () => {
    for (const remove of [false, true]) {
      const h = harness();
      h.storage.delete.mockRejectedValue(new Error('cleanup secret'));
      const response = remove
        ? await h.service.delete(userId)
        : await h.service.upload(userId, file);
      expect(response.data.profileImageUrl).toBe(h.user.profileImageUrl);
      if (remove) expect(response.data.profileImageUrl).toBeNull();
      else expect(response.data.profileImageUrl).not.toBe(oldUrl);
      expect(warn).toHaveBeenCalled();
    }
  });

  it('deletes DB state before the managed object and remains idempotent', async () => {
    const h = harness();
    expect((await h.service.delete(userId)).data.profileImageUrl).toBeNull();
    expect(h.events).toEqual(['lock', 'update', 'commit', 'delete']);
    await h.service.delete(userId);
    expect(h.storage.delete).toHaveBeenCalledTimes(1);
    const empty = harness(null);
    expect(
      (await empty.service.delete(userId)).data.profileImageUrl,
    ).toBeNull();
    expect(empty.storage.delete).not.toHaveBeenCalled();
  });

  it('leaves the old object intact when deletion cannot commit', async () => {
    const h = harness();
    h.tx.user.update.mockRejectedValue(new Error('DB failed'));
    await expect(h.service.delete(userId)).rejects.toThrow('DB failed');
    expect(h.user.profileImageUrl).toBe(oldUrl);
    expect(h.storage.delete).not.toHaveBeenCalled();
  });

  it('rechecks status inside the lock and compensates if user is no longer active', async () => {
    const h = harness();
    h.tx.user.findUnique.mockResolvedValue({ ...h.user, status: 'suspended' });
    await expect(h.service.upload(userId, file)).rejects.toMatchObject({
      status: 403,
    });
    expect(h.tx.user.update).not.toHaveBeenCalled();
    expect(h.storage.delete).toHaveBeenCalledTimes(1);
  });
});
