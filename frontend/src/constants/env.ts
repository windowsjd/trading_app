import { NativeModules, Platform } from 'react-native';
import { parsePublicBooleanFlag } from './publicFlags';

const API_BASE_PATH = '/api/v1';
const WS_ENDPOINT_PATH = `${API_BASE_PATH}/ws`;
const DEFAULT_API_PORT = '3000';
const ANDROID_EMULATOR_HOST = '10.0.2.2';

declare const process:
  | {
      env?: {
        EXPO_PUBLIC_API_ORIGIN?: string;
        EXPO_PUBLIC_WS_BASE_URL?: string;
        EXPO_PUBLIC_LIMIT_ORDER_ENABLED?: string;
      };
    }
  | undefined;

/**
 * EXPO_PUBLIC_* values MUST be read with static dot notation, one expression
 * per variable. babel-preset-expo's inline-env-vars pass only rewrites member
 * expressions whose property is a literal starting with `EXPO_PUBLIC_`; a
 * dynamic `process.env[key]` lookup is invisible to it, so the value never
 * reaches the bundle and every flag silently reads as unset. Do not refactor
 * these three reads back behind a key-taking helper.
 */
const RAW_API_ORIGIN =
  typeof process === 'undefined'
    ? undefined
    : process.env?.EXPO_PUBLIC_API_ORIGIN;

const RAW_WS_BASE_URL =
  typeof process === 'undefined'
    ? undefined
    : process.env?.EXPO_PUBLIC_WS_BASE_URL;

const RAW_LIMIT_ORDER_ENABLED =
  typeof process === 'undefined'
    ? undefined
    : process.env?.EXPO_PUBLIC_LIMIT_ORDER_ENABLED;

/** Shared normalization applied to an ALREADY statically-read raw value. */
function normalizeEnvValue(rawValue: string | undefined) {
  return rawValue?.trim();
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '');
}

function getGlobalLocation() {
  return (globalThis as {
    location?: {
      hostname?: string;
      protocol?: string;
    };
  }).location;
}

function getNativeScriptHostname() {
  const sourceCode = (NativeModules as {
    SourceCode?: {
      scriptURL?: string;
    };
  }).SourceCode;

  const scriptUrl = sourceCode?.scriptURL;
  if (!scriptUrl) return null;

  const match = /^https?:\/\/([^/:]+)(?::\d+)?/.exec(scriptUrl);
  return match?.[1] ?? null;
}

function getDefaultApiOrigin() {
  const nativeScriptHostname = getNativeScriptHostname();

  if (Platform.OS === 'android') {
    if (nativeScriptHostname && nativeScriptHostname !== 'localhost') {
      return `http://${nativeScriptHostname}:${DEFAULT_API_PORT}`;
    }

    return `http://${ANDROID_EMULATOR_HOST}:${DEFAULT_API_PORT}`;
  }

  if (Platform.OS === 'web') {
    const hostname = getGlobalLocation()?.hostname || 'localhost';
    return `http://${hostname}:${DEFAULT_API_PORT}`;
  }

  if (nativeScriptHostname) {
    return `http://${nativeScriptHostname}:${DEFAULT_API_PORT}`;
  }

  return `http://localhost:${DEFAULT_API_PORT}`;
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
  normalizeEnvValue(RAW_API_ORIGIN) || getDefaultApiOrigin(),
);

const configuredWsBaseUrl = trimTrailingSlash(
  normalizeEnvValue(RAW_WS_BASE_URL) ?? '',
);

export const API_BASE_URL = apiOrigin
  ? `${apiOrigin}${API_BASE_PATH}`
  : API_BASE_PATH;

export const WS_BASE_URL = configuredWsBaseUrl || toWsOrigin(apiOrigin);

/**
 * Limit-buy order UI flag (phase 1: registration/cancel only, no automatic
 * execution). Default OFF: only an explicit 'true' or '1' enables the
 * market/limit toggle. Existing submitted limit orders stay visible and
 * cancelable in the order history regardless of this flag.
 */
export const LIMIT_ORDER_ENABLED = parsePublicBooleanFlag(
  RAW_LIMIT_ORDER_ENABLED,
);

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
