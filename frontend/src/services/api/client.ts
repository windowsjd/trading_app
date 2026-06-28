import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import { getAccessToken, getRefreshToken, saveTokens, clearTokens } from '../storage/tokenStorage';
import { API_BASE_URL } from '../../constants/env';

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

export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 10000,
});

let isRefreshing = false;
let refreshPromise: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  if (isRefreshing && refreshPromise) {
    return refreshPromise;
  }

  isRefreshing = true;

  refreshPromise = (async () => {
    try {
      const refreshToken = await getRefreshToken();

      if (!refreshToken) {
        await clearTokens();
        return null;
      }

      const response = await axios.post<RefreshResponse>(
        `${API_BASE_URL}/auth/refresh`,
        { refreshToken },
        { timeout: 10000 },
      );

      const tokens = getRefreshTokens(response.data.data);

      if (!tokens) {
        await clearTokens();
        return null;
      }

      await saveTokens(tokens.accessToken, tokens.refreshToken);

      return tokens.accessToken;
    } catch {
      await clearTokens();
      return null;
    } finally {
      isRefreshing = false;
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

apiClient.interceptors.request.use(
  async (config: InternalAxiosRequestConfig) => {
    const token = await getAccessToken();

    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }

    return config;
  },
);

apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as (InternalAxiosRequestConfig & {
      _retry?: boolean;
    }) | null;

    if (!originalRequest) {
      return Promise.reject(error);
    }

    const status = error.response?.status;

    if (status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;

      const nextAccessToken = await refreshAccessToken();

      if (!nextAccessToken) {
        return Promise.reject(error);
      }

      originalRequest.headers.Authorization = `Bearer ${nextAccessToken}`;
      return apiClient(originalRequest);
    }

    return Promise.reject(error);
  },
);
