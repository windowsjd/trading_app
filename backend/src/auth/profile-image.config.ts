export const PROFILE_IMAGE_ENV_KEYS = [
  'PROFILE_IMAGE_STORAGE_ENDPOINT',
  'PROFILE_IMAGE_STORAGE_REGION',
  'PROFILE_IMAGE_STORAGE_BUCKET',
  'PROFILE_IMAGE_STORAGE_ACCESS_KEY_ID',
  'PROFILE_IMAGE_STORAGE_SECRET_ACCESS_KEY',
  'PROFILE_IMAGE_PUBLIC_BASE_URL',
] as const;

export type ProfileImageStorageConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string;
};

/** One parser for bootstrap and ConfigService; errors contain names, not values. */
export function readProfileImageStorageConfig(
  env: Record<string, unknown>,
): ProfileImageStorageConfig | null {
  const values = PROFILE_IMAGE_ENV_KEYS.map((key) => {
    const value = env[key];
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') {
      throw new Error(`${key} must be a string.`);
    }
    return value.trim();
  });
  if (values.every((value) => !value)) return null;
  for (const [index, value] of values.entries()) {
    if (!value) {
      throw new Error(
        `${PROFILE_IMAGE_ENV_KEYS[index]} is required when profile image storage is configured.`,
      );
    }
  }
  const [
    endpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    publicBaseUrl,
  ] = values;
  if (!/^[a-zA-Z0-9-]+$/.test(region)) {
    throw new Error('PROFILE_IMAGE_STORAGE_REGION is invalid.');
  }
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
    bucket.includes('..')
  ) {
    throw new Error('PROFILE_IMAGE_STORAGE_BUCKET is invalid.');
  }
  return {
    endpoint: httpBase(endpoint, 'PROFILE_IMAGE_STORAGE_ENDPOINT'),
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    publicBaseUrl: httpBase(publicBaseUrl, 'PROFILE_IMAGE_PUBLIC_BASE_URL'),
  };
}

function httpBase(value: string, name: string): string {
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      value.includes('?') ||
      value.includes('#') ||
      value.includes('\\') ||
      url.pathname.includes('%') ||
      /\/\.\.?(\/|$)/.test(value)
    ) {
      throw new Error();
    }
    return url.href.replace(/\/+$/, '');
  } catch {
    throw new Error(
      `${name} must be an HTTP(S) base URL without credentials, query, fragment or encoded paths.`,
    );
  }
}
