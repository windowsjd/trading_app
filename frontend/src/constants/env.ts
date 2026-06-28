const API_BASE_PATH = '/api/v1';
const WS_ENDPOINT_PATH = `${API_BASE_PATH}/ws`;

declare const process:
  | {
      env?: Record<string, string | undefined>;
    }
  | undefined;

function getRuntimeEnvValue(key: string) {
  if (typeof process === 'undefined') return undefined;
  return process.env?.[key]?.trim();
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '');
}

function toPath(value: string) {
  return value.startsWith('/') ? value : `/${value}`;
}

function toWsOrigin(apiOrigin: string) {
  if (apiOrigin.startsWith('https://')) {
    return apiOrigin.replace(/^https:\/\//, 'wss://');
  }

  if (apiOrigin.startsWith('http://')) {
    return apiOrigin.replace(/^http:\/\//, 'ws://');
  }

  return '';
}

const apiOrigin = trimTrailingSlash(
  getRuntimeEnvValue('EXPO_PUBLIC_API_ORIGIN') ?? '',
);

const configuredWsBaseUrl = trimTrailingSlash(
  getRuntimeEnvValue('EXPO_PUBLIC_WS_BASE_URL') ?? '',
);

export const API_BASE_URL = apiOrigin
  ? `${apiOrigin}${API_BASE_PATH}`
  : API_BASE_PATH;

export const WS_BASE_URL = configuredWsBaseUrl || toWsOrigin(apiOrigin);

export function buildWsUrl(path: string) {
  if (!WS_BASE_URL) return null;

  const baseUrl = trimTrailingSlash(WS_BASE_URL);
  const requestPath = toPath(path);

  if (baseUrl.endsWith(WS_ENDPOINT_PATH)) {
    if (requestPath === WS_ENDPOINT_PATH || requestPath === '/ws') {
      return baseUrl;
    }

    return `${baseUrl}${requestPath}`;
  }

  if (baseUrl.endsWith(API_BASE_PATH)) {
    if (requestPath === API_BASE_PATH) {
      return baseUrl;
    }

    if (requestPath.startsWith(`${API_BASE_PATH}/`)) {
      return `${baseUrl}${requestPath.slice(API_BASE_PATH.length)}`;
    }
  }

  return `${baseUrl}${requestPath}`;
}
