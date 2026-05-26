import { Injectable } from '@nestjs/common';
import { redactText } from './provider-secret-redaction';
import { ProviderHttpError, type ProviderId } from './provider.types';

export type ProviderHttpJsonResult<T> = {
  json: T;
  receivedAt: Date;
  status: number;
};

export type ProviderHttpGetJsonOptions = {
  provider: ProviderId;
  timeoutMs: number;
  secrets?: readonly string[];
  headers?: Record<string, string>;
};

@Injectable()
export class ProviderHttpClient {
  async getJson<T>(
    url: string,
    options: ProviderHttpGetJsonOptions,
  ): Promise<ProviderHttpJsonResult<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: options.headers,
        signal: controller.signal,
      });
      const receivedAt = new Date();
      const bodyText = await response.text();

      if (!response.ok) {
        throw new ProviderHttpError(
          options.provider,
          'PROVIDER_HTTP_ERROR',
          `${options.provider} HTTP ${response.status} from ${redactText(url, {
            secrets: options.secrets,
          })}: ${redactText(bodyText.slice(0, 500), {
            secrets: options.secrets,
          })}`,
        );
      }

      try {
        return {
          json: JSON.parse(bodyText) as T,
          receivedAt,
          status: response.status,
        };
      } catch {
        throw new ProviderHttpError(
          options.provider,
          'PROVIDER_JSON_PARSE_ERROR',
          `${options.provider} returned invalid JSON from ${redactText(url, {
            secrets: options.secrets,
          })}.`,
        );
      }
    } catch (error) {
      if (error instanceof ProviderHttpError) {
        throw error;
      }

      const code =
        error instanceof Error && error.name === 'AbortError'
          ? 'PROVIDER_TIMEOUT'
          : 'PROVIDER_REQUEST_FAILED';
      throw new ProviderHttpError(
        options.provider,
        code,
        `${options.provider} request failed for ${redactText(url, {
          secrets: options.secrets,
        })}.`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
