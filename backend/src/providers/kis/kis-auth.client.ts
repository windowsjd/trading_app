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

@Injectable()
export class KisAuthClient {
  private tokenCache: ParsedKisTokenResponse | null = null;
  private approvalKeyCache: ParsedKisApprovalKeyResponse | null = null;

  constructor(private readonly configService: ProviderConfigService) {}

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

    const parsed = parseKisTokenResponse(response.response);
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

    const parsed = parseKisApprovalKeyResponse(response.response);
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

    return this.requestRestToken({
      path: '/oauth2/tokenP',
      body: {
        grant_type: 'client_credentials',
        appkey: config.kis.appKey,
        appsecret: config.kis.appSecret,
      },
    });
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

    return this.requestWebSocketApprovalKey({
      path: '/oauth2/Approval',
      body: {
        grant_type: 'client_credentials',
        appkey: config.kis.appKey,
        secretkey: config.kis.appSecret,
      },
    });
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
): ParsedKisTokenResponse {
  if (!response.access_token || typeof response.access_token !== 'string') {
    throw new ProviderHttpError(
      'kis',
      'KIS_TOKEN_MISSING',
      'KIS token response does not include access_token.',
    );
  }

  return {
    accessToken: response.access_token,
    tokenType:
      typeof response.token_type === 'string' ? response.token_type : null,
    expiresInSeconds: parseOptionalPositiveInteger(response.expires_in),
    expiresAt: parseOptionalDate(response.access_token_token_expired),
  };
}

export function parseKisApprovalKeyResponse(
  response: KisApprovalKeyResponse,
): ParsedKisApprovalKeyResponse {
  if (!response.approval_key || typeof response.approval_key !== 'string') {
    throw new ProviderHttpError(
      'kis',
      'KIS_APPROVAL_KEY_MISSING',
      'KIS approval response does not include approval_key.',
    );
  }

  return {
    approvalKey: response.approval_key,
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

function parseOptionalDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
