import type { CorsOptions, CustomOrigin } from '@nestjs/common/interfaces/external/cors-options.interface';

const DEFAULT_CORS_METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PATCH',
  'PUT',
  'DELETE',
  'OPTIONS',
];

const DEFAULT_CORS_HEADERS = [
  'Authorization',
  'Content-Type',
  'X-Idempotency-Key',
];

type CorsEnv = Partial<
  Pick<NodeJS.ProcessEnv, 'CORS_ORIGINS' | 'FRONTEND_ORIGINS' | 'NODE_ENV'>
>;

function parseOriginList(value?: string) {
  return (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function isPrivateIpv4(hostname: string) {
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    return true;
  }

  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    return true;
  }

  const match = /^172\.(\d{1,2})\.\d{1,3}\.\d{1,3}$/.exec(hostname);
  if (!match) return false;

  const secondOctet = Number(match[1]);
  return secondOctet >= 16 && secondOctet <= 31;
}

function isDevelopmentOrigin(origin: string) {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return false;
    }

    const hostname = url.hostname.toLowerCase();
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]' ||
      hostname === '10.0.2.2' ||
      isPrivateIpv4(hostname)
    );
  } catch {
    return false;
  }
}

export function createCorsOptions(env: CorsEnv = process.env): CorsOptions {
  const configuredOrigins = parseOriginList(
    env.CORS_ORIGINS || env.FRONTEND_ORIGINS,
  );
  const allowAnyConfiguredOrigin = configuredOrigins.includes('*');
  const isProduction = env.NODE_ENV === 'production';

  const origin: CustomOrigin = (requestOrigin, callback) => {
    if (!requestOrigin) {
      callback(null, true);
      return;
    }

    if (
      allowAnyConfiguredOrigin ||
      configuredOrigins.includes(requestOrigin) ||
      (!isProduction && isDevelopmentOrigin(requestOrigin))
    ) {
      callback(null, true);
      return;
    }

    callback(null, false);
  };

  return {
    origin,
    methods: DEFAULT_CORS_METHODS,
    allowedHeaders: DEFAULT_CORS_HEADERS,
    credentials: false,
    optionsSuccessStatus: 204,
  };
}
