import { validateEnv } from '../common/env-validation';
import { readProfileImageStorageConfig } from './profile-image.config';

export const storageEnv = {
  PROFILE_IMAGE_STORAGE_ENDPOINT: 'https://storage.example.test',
  PROFILE_IMAGE_STORAGE_REGION: 'auto',
  PROFILE_IMAGE_STORAGE_BUCKET: 'profile-assets',
  PROFILE_IMAGE_STORAGE_ACCESS_KEY_ID: 'test-access',
  PROFILE_IMAGE_STORAGE_SECRET_ACCESS_KEY: 'test-secret',
  PROFILE_IMAGE_PUBLIC_BASE_URL: 'https://cdn.example.test/assets/',
};

describe('profile image storage configuration', () => {
  it('permits entirely absent/blank configuration, including app boot', () => {
    expect(readProfileImageStorageConfig({})).toBeNull();
    expect(
      readProfileImageStorageConfig({ PROFILE_IMAGE_STORAGE_BUCKET: '  ' }),
    ).toBeNull();
    expect(validateEnv({})).toEqual({});
  });

  it('requires every setting together without leaking values', () => {
    for (const key of Object.keys(storageEnv)) {
      const partial = { ...storageEnv, [key]: '' };
      expect(() => validateEnv(partial)).toThrow(key);
      try {
        validateEnv(partial);
      } catch (error) {
        expect(String(error)).not.toContain('test-secret');
        expect(String(error)).not.toContain('test-access');
      }
    }
  });

  it('normalizes only configured HTTP(S) base URLs', () => {
    expect(readProfileImageStorageConfig(storageEnv)?.publicBaseUrl).toBe(
      'https://cdn.example.test/assets',
    );
    expect(() =>
      readProfileImageStorageConfig({
        ...storageEnv,
        PROFILE_IMAGE_STORAGE_REGION: '../auto',
      }),
    ).toThrow('REGION');
    expect(() =>
      readProfileImageStorageConfig({
        ...storageEnv,
        PROFILE_IMAGE_STORAGE_BUCKET: '../bucket',
      }),
    ).toThrow('BUCKET');
    for (const key of [
      'PROFILE_IMAGE_STORAGE_ENDPOINT',
      'PROFILE_IMAGE_PUBLIC_BASE_URL',
    ]) {
      for (const value of [
        'data:image/jpeg,foo',
        'javascript:alert(1)',
        'https://a:b@example.test',
        'https://example.test/a?token=secret',
        'https://example.test/#fragment',
        'https://example.test/%2fpath',
        'https://example.test/../path',
        'https://example.test/a\\b',
      ]) {
        expect(() =>
          readProfileImageStorageConfig({ ...storageEnv, [key]: value }),
        ).toThrow(key);
      }
    }
  });
});
