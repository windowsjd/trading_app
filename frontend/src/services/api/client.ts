import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { getAccessToken, getRefreshToken, saveTokens } from '../storage/tokenStorage';
import { API_BASE_URL } from '../../constants/env';
import { notifySessionExpired } from './sessionExpiry';
import {
  assertCurrentSession,
  canUseSessionCredentials,
  getSessionGeneration,
  SessionSupersededError,
} from './sessionOwnership';

declare module 'axios' {
  interface AxiosRequestConfig {
    _sessionGeneration?: number;
    _sessionAccessToken?: string | null;
    _retry?: boolean;
    /** Public login/signup/revoke must not use or refresh outgoing credentials. */
    skipSessionAuth?: boolean;
  }
}

export function getRequestGeneration(error: unknown): number | undefined {
  return axios.isAxiosError(error) ? error.config?._sessionGeneration : undefined;
}

type RefreshResponse = {
  success: true;
  data: {
    user?: {
      id: string;
      email: string;
      nickname: string;
      status: 'active' | 'suspended' | 'deleted';
    };
    tokens?: {
      accessToken: string;
      refreshToken: string;
      accessTokenExpiresIn?: string;
      refreshTokenExpiresAt?: string;
    };
    accessToken?: string;
    refreshToken?: string;
  };
};

function getRefreshTokens(data: RefreshResponse['data']) {
  const accessToken = data.tokens?.accessToken ?? data.accessToken;
  const refreshToken = data.tokens?.refreshToken ?? data.refreshToken;

  if (!accessToken || !refreshToken) return null;

  return { accessToken, refreshToken };
}

export const apiClient = axios.create({ baseURL: API_BASE_URL, timeout: 10000 });
let refreshFlight: { generation: number; promise: Promise<string | null> } | null = null;

/**
 * Only the refresh endpoint's own verdict ends a session: a dead, revoked or
 * malformed refresh token (400/401) or a user no longer active (403). Offline,
 * a timeout, 429 or a 5xx while the server restarts say nothing about it —
 * the server rotates the token in one transaction, so the stored one is still
 * current — and used to log the user out over a network blip.
 */
function isRefreshRejected(error: unknown) {
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  return status === 400 || status === 401 || status === 403;
}

/** A refresh without a verdict: the request fails like a network error; the session stays. */
class RefreshUnavailableError extends Error {
  readonly reason: unknown;
  constructor(reason: unknown) {
    super('Session refresh unavailable');
    this.reason = reason;
  }
}

const renewedListeners = new Set<() => void>();

/** Told after a refresh saved a new access token (a refused realtime socket tries it). */
export function onAccessTokenRenewed(listener: () => void): () => void {
  renewedListeners.add(listener);
  return () => {
    renewedListeners.delete(listener);
  };
}

/**
 * For the realtime socket the server refused: the stored access token when a
 * request already refreshed past the refused one, else one refresh through the
 * shared single-flight. Null without a usable session or without a verdict; a
 * refresh the server refuses ends the session as any request's would.
 */
export async function renewAccessToken(refused: string | null): Promise<string | null> {
  const owner = getSessionGeneration();
  if (!canUseSessionCredentials(owner)) return null;
  try {
    const current = await getAccessToken(owner);
    assertUsableSession(owner);
    if (current && current !== refused) return current;
    return await refreshAccessToken(owner);
  } catch {
    return null;
  }
}

function assertUsableSession(owner: number) {
  if (!canUseSessionCredentials(owner)) throw new SessionSupersededError();
}

function refreshAccessToken(owner: number): Promise<string | null> {
  assertUsableSession(owner);
  if (refreshFlight?.generation === owner) return refreshFlight.promise;
  const promise = (async () => {
    try {
      const refreshToken = await getRefreshToken(owner);
      assertUsableSession(owner);
      if (!refreshToken) {
        notifySessionExpired(owner);
        return null;
      }
      let response;
      try {
        response = await axios.post<RefreshResponse>(
          `${API_BASE_URL}/auth/refresh`,
          { refreshToken },
          { timeout: 10000 },
        );
      } catch (error) {
        // No verdict: keep the credentials; the next request refreshes again.
        throw isRefreshRejected(error) ? error : new RefreshUnavailableError(error);
      }
      assertUsableSession(owner);
      const tokens = getRefreshTokens(response.data.data);
      if (!tokens) {
        notifySessionExpired(owner);
        return null;
      }
      await saveTokens(tokens.accessToken, tokens.refreshToken, owner);
      assertUsableSession(owner);
      for (const listener of renewedListeners) {
        try {
          listener();
        } catch {
          // A listener's failure must not fail the refresh.
        }
      }
      return tokens.accessToken;
    } catch (error) {
      if (error instanceof RefreshUnavailableError) throw error;
      notifySessionExpired(owner);
      return null;
    } finally {
      // A's late completion must not release B's single-flight slot.
      if (refreshFlight?.generation === owner) refreshFlight = null;
    }
  })();
  refreshFlight = { generation: owner, promise };
  return promise;
}

apiClient.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
  // Preserve this owner on retry, including across the token storage await.
  const owner = config._sessionGeneration ?? getSessionGeneration();
  config._sessionGeneration = owner;
  assertCurrentSession(owner);
  config.headers.delete('Authorization');
  if (config.skipSessionAuth) return config;
  assertUsableSession(owner);
  try {
    const token = await getAccessToken(owner);
    assertUsableSession(owner);
    config._sessionAccessToken = token;
    if (token) config.headers.Authorization = `Bearer ${token}`;
    return config;
  } catch (error) {
    notifySessionExpired(owner);
    throw error;
  }
});

apiClient.interceptors.response.use(
  (response) => {
    assertCurrentSession(response.config._sessionGeneration);
    return response;
  },
  async (error: AxiosError) => {
    const original = error.config;
    if (!original || original._sessionGeneration === undefined) throw error;
    const owner = original._sessionGeneration;
    // Reject stale successes AND errors before any caller/cache or refresh effect.
    assertCurrentSession(owner);
    if (original.skipSessionAuth || error.response?.status !== 401) throw error;
    assertUsableSession(owner);
    if (original._retry) {
      notifySessionExpired(owner);
      throw error;
    }
    original._retry = true;
    try {
      const currentToken = await getAccessToken(owner);
      assertUsableSession(owner);
      // Another request may already have rotated while this 401 was in flight.
      const token =
        currentToken && currentToken !== original._sessionAccessToken
          ? currentToken
          : await refreshAccessToken(owner);
      assertUsableSession(owner);
      if (!token) throw error;
      return apiClient(original);
    } catch (failure) {
      // The refresh had no verdict: this request fails with its network/server error, signed in.
      if (failure instanceof RefreshUnavailableError) throw failure.reason;
      notifySessionExpired(owner);
      throw failure;
    }
  },
);
