import { Injectable } from '@nestjs/common';
import { ProviderConfigService } from '../provider-config.service';
import { redactText } from '../provider-secret-redaction';
import { ProviderConfigError, ProviderHttpError } from '../provider.types';
import type {
  KisApprovalKeyResponse,
  KisLowLevelCallResult,
  KisTokenResponse,
  ParsedKisApprovalKeyResponse,
  ParsedKisTokenResponse,
} from './kis.types';
import { KisRequestCoordinatorService } from './coordination/kis-request-coordinator.service';

const TOKEN_REFRESH_BUFFER_MS = 60_000;
const APPROVAL_KEY_REFRESH_BUFFER_MS = 60_000;
const DEFAULT_APPROVAL_KEY_TTL_MS = 60 * 60 * 1000;

@Injectable()
export class KisAuthClient {
  private tokenCache: ParsedKisTokenResponse | null = null;
  private approvalKeyCache: ParsedKisApprovalKeyResponse | null = null;
  private tokenRefreshPromise: Promise<
    KisLowLevelCallResult<ParsedKisTokenResponse>
  > | null = null;
  private approvalKeyRefreshPromise: Promise<
    KisLowLevelCallResult<ParsedKisApprovalKeyResponse>
  > | null = null;

  constructor(
    private readonly configService: ProviderConfigService,
    private readonly requestCoordinator: KisRequestCoordinatorService,
  ) {}

  getCachedToken(): ParsedKisTokenResponse | null {
    return this.tokenCache;
  }

  getCachedApprovalKey(): ParsedKisApprovalKeyResponse | null {
    return this.approvalKeyCache;
  }

  async requestRestToken(input: {
    path: string;
    body: Record<string, unknown>;
  }): Promise<KisLowLevelCallResult<ParsedKisTokenResponse>> {
    const response = await this.postRestJsonToExplicitPath<KisTokenResponse>(
      input.path,
      input.body,
    );

    if (response.state === 'skipped') {
      return response;
    }

    const parsed = parseKisTokenResponse(
      response.response,
      response.receivedAt,
    );
    this.tokenCache = parsed;

    return {
      state: 'available',
      response: parsed,
      receivedAt: response.receivedAt,
    };
  }

  async requestWebSocketApprovalKey(input: {
    path: string;
    body: Record<string, unknown>;
  }): Promise<KisLowLevelCallResult<ParsedKisApprovalKeyResponse>> {
    const response =
      await this.postRestJsonToExplicitPath<KisApprovalKeyResponse>(
        input.path,
        input.body,
      );

    if (response.state === 'skipped') {
      return response;
    }

    const parsed = parseKisApprovalKeyResponse(
      response.response,
      response.receivedAt,
    );
    this.approvalKeyCache = parsed;

    return {
      state: 'available',
      response: parsed,
      receivedAt: response.receivedAt,
    };
  }

  async requestConfiguredRestToken(): Promise<
    KisLowLevelCallResult<ParsedKisTokenResponse>
  > {
    const config = this.configService.getConfig();
    if (!config.kis.enabled) {
      throw new ProviderConfigError(
        'kis',
        'PROVIDER_DISABLED',
        'KIS market data provider is disabled.',
      );
    }

    if (!config.kis.appKey || !config.kis.appSecret) {
      throw new ProviderConfigError(
        'kis',
        'REQUIRED_ENV_MISSING',
        'KIS_APP_KEY and KIS_APP_SECRET are required.',
      );
    }

    if (!config.kis.restBaseUrl) {
      return {
        state: 'skipped',
        reason: 'KIS_REST_BASE_URL_MISSING',
      };
    }

    const cached = this.tokenCache;
    if (this.isTokenUsable(cached, new Date(), TOKEN_REFRESH_BUFFER_MS)) {
      return availableCachedResult(cached);
    }

    if (this.tokenRefreshPromise) {
      return this.tokenRefreshPromise;
    }

    this.tokenRefreshPromise = this.requestRestToken({
      path: '/oauth2/tokenP',
      body: {
        grant_type: 'client_credentials',
        appkey: config.kis.appKey,
        appsecret: config.kis.appSecret,
      },
    })
      .catch((error: unknown) => {
        const fallback = this.tokenCache;
        if (
          isKisAuthRateLimitError(error) &&
          this.isTokenUsable(fallback, new Date(), 0)
        ) {
          return availableCachedResult(fallback);
        }

        throw error;
      })
      .finally(() => {
        this.tokenRefreshPromise = null;
      });

    return this.tokenRefreshPromise;
  }

  async requestConfiguredWebSocketApprovalKey(): Promise<
    KisLowLevelCallResult<ParsedKisApprovalKeyResponse>
  > {
    const config = this.configService.getConfig();
    if (!config.kis.enabled) {
      throw new ProviderConfigError(
        'kis',
        'PROVIDER_DISABLED',
        'KIS market data provider is disabled.',
      );
    }

    if (!config.kis.appKey || !config.kis.appSecret) {
      throw new ProviderConfigError(
        'kis',
        'REQUIRED_ENV_MISSING',
        'KIS_APP_KEY and KIS_APP_SECRET are required.',
      );
    }

    if (!config.kis.restBaseUrl) {
      return {
        state: 'skipped',
        reason: 'KIS_REST_BASE_URL_MISSING',
      };
    }

    const cached = this.approvalKeyCache;
    if (
      this.isApprovalKeyUsable(
        cached,
        new Date(),
        APPROVAL_KEY_REFRESH_BUFFER_MS,
      )
    ) {
      return availableCachedResult(cached);
    }

    if (this.approvalKeyRefreshPromise) {
      return this.approvalKeyRefreshPromise;
    }

    this.approvalKeyRefreshPromise = this.requestWebSocketApprovalKey({
      path: '/oauth2/Approval',
      body: {
        grant_type: 'client_credentials',
        appkey: config.kis.appKey,
        secretkey: config.kis.appSecret,
      },
    })
      .catch((error: unknown) => {
        const fallback = this.approvalKeyCache;
        if (
          isKisAuthRateLimitError(error) &&
          this.isApprovalKeyUsable(fallback, new Date(), 0)
        ) {
          return availableCachedResult(fallback);
        }

        throw error;
      })
      .finally(() => {
        this.approvalKeyRefreshPromise = null;
      });

    return this.approvalKeyRefreshPromise;
  }

  private isTokenUsable(
    cached: ParsedKisTokenResponse | null,
    now: Date,
    refreshBufferMs: number,
  ): cached is ParsedKisTokenResponse {
    const expiresAt = cached ? resolveTokenExpiresAt(cached) : null;
    return (
      expiresAt !== null &&
      now.getTime() + refreshBufferMs < expiresAt.getTime()
    );
  }

  private isApprovalKeyUsable(
    cached: ParsedKisApprovalKeyResponse | null,
    now: Date,
    refreshBufferMs: number,
  ): cached is ParsedKisApprovalKeyResponse {
    const expiresAt = cached ? resolveApprovalKeyExpiresAt(cached) : null;
    return (
      expiresAt !== null &&
      now.getTime() + refreshBufferMs < expiresAt.getTime()
    );
  }

  async postRestJsonToExplicitPath<T>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<KisLowLevelCallResult<T>> {
    const config = this.configService.getConfig();
    if (!config.kis.enabled) {
      throw new ProviderConfigError(
        'kis',
        'PROVIDER_DISABLED',
        'KIS market data provider is disabled.',
      );
    }

    if (!config.kis.appKey || !config.kis.appSecret) {
      throw new ProviderConfigError(
        'kis',
        'REQUIRED_ENV_MISSING',
        'KIS_APP_KEY and KIS_APP_SECRET are required.',
      );
    }

    if (!config.kis.restBaseUrl) {
      return {
        state: 'skipped',
        reason: 'KIS_REST_BASE_URL_MISSING',
      };
    }

    const normalizedPath = normalizeExplicitPath(path);
    const url = `${config.kis.restBaseUrl.replace(/\/+$/u, '')}${normalizedPath}`;
    // Approval/token endpoints are both KIS OAuth REST traffic. WebSocket
    // handshake/subscription frames themselves never pass this coordinator.
    await this.requestCoordinator.acquire('oauth');
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      config.common.httpTimeoutMs,
    );

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          appkey: config.kis.appKey,
          appsecret: config.kis.appSecret,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const receivedAt = new Date();
      const bodyText = await response.text();
      const secrets = [config.kis.appKey, config.kis.appSecret];

      if (!response.ok) {
        throw new ProviderHttpError(
          'kis',
          'PROVIDER_HTTP_ERROR',
          `KIS HTTP ${response.status} from ${redactText(url, {
            secrets,
          })}: ${redactText(bodyText.slice(0, 500), { secrets })}`,
        );
      }

      try {
        return {
          state: 'available',
          response: JSON.parse(bodyText) as T,
          receivedAt,
        };
      } catch {
        throw new ProviderHttpError(
          'kis',
          'PROVIDER_JSON_PARSE_ERROR',
          `KIS returned invalid JSON from ${redactText(url, { secrets })}.`,
        );
      }
    } catch (error) {
      if (error instanceof ProviderHttpError) {
        throw error;
      }

      throw new ProviderHttpError(
        'kis',
        error instanceof Error && error.name === 'AbortError'
          ? 'PROVIDER_TIMEOUT'
          : 'PROVIDER_REQUEST_FAILED',
        'KIS REST request failed.',
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function parseKisTokenResponse(
  response: KisTokenResponse,
  receivedAt: Date | null = null,
): ParsedKisTokenResponse {
  if (!response.access_token || typeof response.access_token !== 'string') {
    throw new ProviderHttpError(
      'kis',
      'KIS_TOKEN_MISSING',
      'KIS token response does not include access_token.',
    );
  }

  const expiresInSeconds = parseOptionalPositiveInteger(response.expires_in);
  const expiresAt =
    parseFirstOptionalDate([
      response.access_token_token_expired,
      response.expires_at,
    ]) ?? buildExpiresAtFromTtl(receivedAt, expiresInSeconds);

  return {
    accessToken: response.access_token,
    tokenType:
      typeof response.token_type === 'string' ? response.token_type : null,
    expiresInSeconds,
    expiresAt,
    receivedAt,
  };
}

export function parseKisApprovalKeyResponse(
  response: KisApprovalKeyResponse,
  receivedAt: Date | null = null,
): ParsedKisApprovalKeyResponse {
  if (!response.approval_key || typeof response.approval_key !== 'string') {
    throw new ProviderHttpError(
      'kis',
      'KIS_APPROVAL_KEY_MISSING',
      'KIS approval response does not include approval_key.',
    );
  }

  const expiresInSeconds = parseOptionalPositiveInteger(response.expires_in);
  const expiresAt =
    parseFirstOptionalDate([
      response.approval_key_expired,
      response.approval_key_token_expired,
      response.approval_key_token_expired_at,
      response.expires_at,
    ]) ??
    buildExpiresAtFromTtl(receivedAt, expiresInSeconds) ??
    buildDefaultApprovalKeyExpiresAt(receivedAt);

  return {
    approvalKey: response.approval_key,
    expiresInSeconds,
    expiresAt,
    receivedAt,
  };
}

function normalizeExplicitPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || !trimmed.startsWith('/')) {
    throw new ProviderConfigError(
      'kis',
      'INVALID_EXPLICIT_PATH',
      'KIS low-level client requires an explicit absolute path.',
    );
  }

  return trimmed;
}

function parseOptionalPositiveInteger(
  value: number | string | undefined,
): number | null {
  if (value === undefined) {
    return null;
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function availableCachedResult<T extends { receivedAt: Date | null }>(
  response: T,
): KisLowLevelCallResult<T> {
  return {
    state: 'available',
    response,
    receivedAt: response.receivedAt ?? new Date(),
  };
}

function isKisAuthRateLimitError(error: unknown): boolean {
  if (!(error instanceof ProviderHttpError) || error.provider !== 'kis') {
    return false;
  }

  const text = `${error.code} ${error.message}`.toLowerCase();
  return (
    text.includes('egw00133') ||
    text.includes('rate limit') ||
    text.includes('too many')
  );
}

function resolveTokenExpiresAt(response: ParsedKisTokenResponse): Date | null {
  return (
    response.expiresAt ??
    buildExpiresAtFromTtl(response.receivedAt, response.expiresInSeconds)
  );
}

function resolveApprovalKeyExpiresAt(
  response: ParsedKisApprovalKeyResponse,
): Date | null {
  return (
    response.expiresAt ??
    buildExpiresAtFromTtl(response.receivedAt, response.expiresInSeconds) ??
    buildDefaultApprovalKeyExpiresAt(response.receivedAt)
  );
}

function buildExpiresAtFromTtl(
  receivedAt: Date | null,
  expiresInSeconds: number | null,
): Date | null {
  if (!receivedAt || !expiresInSeconds) {
    return null;
  }

  return new Date(receivedAt.getTime() + expiresInSeconds * 1000);
}

function buildDefaultApprovalKeyExpiresAt(
  receivedAt: Date | null,
): Date | null {
  if (!receivedAt) {
    return null;
  }

  return new Date(receivedAt.getTime() + DEFAULT_APPROVAL_KEY_TTL_MS);
}

function parseFirstOptionalDate(values: readonly unknown[]): Date | null {
  for (const value of values) {
    const parsed = parseOptionalDate(value);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

function parseOptionalDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
