import { Injectable } from '@nestjs/common';
import { ProviderConfigService } from '../provider-config.service';
import { redactText } from '../provider-secret-redaction';
import { ProviderConfigError, ProviderHttpError } from '../provider.types';
import type {
  KisLowLevelCallResult,
  KisLowLevelCallWithMetadataResult,
} from './kis.types';
import { KisRequestCoordinatorService } from './coordination/kis-request-coordinator.service';

@Injectable()
export class KisQuoteClient {
  constructor(
    private readonly configService: ProviderConfigService,
    private readonly requestCoordinator: KisRequestCoordinatorService,
  ) {}

  async getMarketDataByExplicitPath<T>(input: {
    path: string;
    query?: Record<string, string>;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<KisLowLevelCallResult<T>> {
    const result = await this.getMarketDataWithMetadataByExplicitPath<T>(input);
    if (result.state === 'skipped') {
      return result;
    }
    return {
      state: 'available',
      response: result.response,
      receivedAt: result.receivedAt,
    };
  }

  /**
   * Additive low-level contract for KIS endpoints whose continuation state is
   * carried in response headers. Existing callers keep the body-only method.
   */
  async getMarketDataWithMetadataByExplicitPath<T>(input: {
    path: string;
    query?: Record<string, string>;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<KisLowLevelCallWithMetadataResult<T>> {
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

    const normalizedPath = normalizeExplicitPath(input.path);
    const baseUrl = `${config.kis.restBaseUrl.replace(/\/+$/u, '')}${normalizedPath}`;
    const url = new URL(baseUrl);
    for (const [key, value] of Object.entries(input.query ?? {})) {
      url.searchParams.set(key, value);
    }

    if (input.signal) {
      await this.requestCoordinator.acquire('rest', { signal: input.signal });
    } else {
      await this.requestCoordinator.acquire('rest');
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      config.common.httpTimeoutMs,
    );
    const secrets = [config.kis.appKey, config.kis.appSecret];

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          appkey: config.kis.appKey,
          appsecret: config.kis.appSecret,
          ...(input.headers ?? {}),
        },
        signal: input.signal
          ? AbortSignal.any([controller.signal, input.signal])
          : controller.signal,
      });
      const receivedAt = new Date();
      const bodyText = await response.text();

      if (!response.ok) {
        throw new ProviderHttpError(
          'kis',
          'PROVIDER_HTTP_ERROR',
          `KIS HTTP ${response.status} from ${redactText(url.toString(), {
            secrets,
          })}: ${redactText(bodyText.slice(0, 500), { secrets })}`,
        );
      }

      try {
        const responseHeaders: Record<string, string> = {};
        response.headers?.forEach((value, key) => {
          responseHeaders[key.toLowerCase()] = value;
        });
        return {
          state: 'available',
          response: JSON.parse(bodyText) as T,
          receivedAt,
          headers: responseHeaders,
          trCont: responseHeaders['tr_cont']?.trim() || null,
        };
      } catch {
        throw new ProviderHttpError(
          'kis',
          'PROVIDER_JSON_PARSE_ERROR',
          `KIS returned invalid JSON from ${redactText(url.toString(), {
            secrets,
          })}.`,
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
        'KIS market data request failed.',
      );
    } finally {
      clearTimeout(timeout);
    }
  }
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
