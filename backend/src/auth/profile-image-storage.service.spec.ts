import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { ProfileImageStorageService } from './profile-image-storage.service';

const send = jest.fn();
const destroy = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send, destroy })),
  PutObjectCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ input })),
  DeleteObjectCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ input })),
}));

const env = {
  PROFILE_IMAGE_STORAGE_ENDPOINT: 'https://storage.example.test',
  PROFILE_IMAGE_STORAGE_REGION: 'auto',
  PROFILE_IMAGE_STORAGE_BUCKET: 'profile-assets',
  PROFILE_IMAGE_STORAGE_ACCESS_KEY_ID: 'test-access',
  PROFILE_IMAGE_STORAGE_SECRET_ACCESS_KEY: 'test-secret',
  PROFILE_IMAGE_PUBLIC_BASE_URL: 'https://cdn.example.test/assets/',
};
const owner = 'cbdc80ec-8f69-44fd-8a76-32b1c136e06a';
const key = `profile-images/${owner}/d1645c18-a1a4-43c9-b1f3-a90c3d63b30b.jpg`;

describe('S3-compatible profile image storage', () => {
  beforeEach(() => jest.clearAllMocks());

  it('stays disabled without credentials and makes no SDK client', async () => {
    const storage = new ProfileImageStorageService(new ConfigService({}));
    expect(S3Client).not.toHaveBeenCalled();
    expect(() => storage.requireConfigured()).toThrow();
    await expect(
      storage.upload(key, Buffer.from('image')),
    ).rejects.toMatchObject({ status: 503 });
    await expect(storage.delete(key)).rejects.toMatchObject({ status: 503 });
  });

  it('uploads with public JPEG/cache metadata and deletes only by object key', async () => {
    const storage = new ProfileImageStorageService(new ConfigService(env));
    send.mockResolvedValue({});
    const bytes = Buffer.from('jpeg bytes');
    await storage.upload(key, bytes);
    expect(PutObjectCommand).toHaveBeenCalledWith({
      Bucket: 'profile-assets',
      Key: key,
      Body: bytes,
      ContentLength: bytes.length,
      ContentType: 'image/jpeg',
      CacheControl: 'public, max-age=31536000, immutable',
    });
    expect(storage.publicUrl(key)).toBe(
      `https://cdn.example.test/assets/${key}`,
    );
    await storage.delete(key);
    expect(DeleteObjectCommand).toHaveBeenCalledWith({
      Bucket: 'profile-assets',
      Key: key,
    });
    storage.onModuleDestroy();
    expect(destroy).toHaveBeenCalled();
  });

  it('recognizes only exact configured URLs for the same owner', () => {
    const storage = new ProfileImageStorageService(new ConfigService(env));
    const url = storage.publicUrl(key);
    expect(storage.managedKey(url, owner)).toBe(key);
    for (const value of [
      null,
      'https://legacy.example.test/photo.jpg',
      url + '?q=1',
      url + '#hash',
      url.replace('cdn.example.test', 'cdn.example.test.evil.test'),
      url.replace('/assets/', '/assets/../assets/'),
      url.replace('profile-images/', 'profile-images%2f'),
      url.replace('.jpg', '%2ejpg'),
      url.replace(owner, 'another-user'),
      url.replace('.jpg', '.svg'),
      url + '/extra',
    ]) {
      expect(storage.managedKey(value, owner)).toBeNull();
    }
    expect(storage.managedKey(url, '../owner')).toBeNull();
  });
});
