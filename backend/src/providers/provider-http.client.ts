import { Injectable } from '@nestjs/common';
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
      if (!response.ok) {
        // Release the fetch stream without reading or retaining the error body.
        await response.body?.cancel().catch(() => undefined);
        throw new ProviderHttpError(
          options.provider,
          'PROVIDER_HTTP_ERROR',
          `${options.provider} HTTP ${response.status} (PROVIDER_HTTP_ERROR).`,
        );
      }

      const bodyText = await response.text();

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
          `${options.provider} returned invalid JSON (PROVIDER_JSON_PARSE_ERROR).`,
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
        `${options.provider} request failed (${code}).`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
