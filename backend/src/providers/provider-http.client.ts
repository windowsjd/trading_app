import { Injectable, Optional, OnModuleDestroy } from '@nestjs/common';
import { ProviderHttpError, type ProviderId } from './provider.types';
import { RedisService } from '../redis/redis.service';
import {
  BinanceRestCoordinator,
  parseBinanceRetryAfter,
  binanceUsedWeight,
} from './binance/binance-rest-coordinator';

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
export class ProviderHttpClient implements OnModuleDestroy {
  private readonly ownedRedis: RedisService | null;
  private readonly redis: RedisService;
  private binanceRest: BinanceRestCoordinator | undefined;

  constructor(@Optional() redis?: RedisService) {
    this.ownedRedis = redis ? null : new RedisService();
    this.redis = redis ?? (this.ownedRedis as RedisService);
  }

  async onModuleDestroy(): Promise<void> {
    await this.ownedRedis?.onModuleDestroy();
  }

  async getJson<T>(
    url: string,
    options: ProviderHttpGetJsonOptions,
  ): Promise<ProviderHttpJsonResult<T>> {
    const startedAt = performance.now();
    const coordinator =
      options.provider === 'binance'
        ? (this.binanceRest ??= new BinanceRestCoordinator(this.redis))
        : undefined;
    const token = await coordinator?.acquire(url, options.timeoutMs);
    let outcome: 'success' | 'failure' | 'limited' = 'failure';
    let retryAfterMs = 0;
    let status = 0;
    let usedWeight1m: number | undefined;
    let coordinationCompleted = false;
    const controller = new AbortController();
    const remainingMs = coordinator
      ? options.timeoutMs - (performance.now() - startedAt)
      : options.timeoutMs;
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(1, remainingMs),
    );

    try {
      if (remainingMs <= 0) {
        // @diagnosticSurface internal: Provider callers receive a fixed timeout category after admission consumes the HTTP deadline.
        throw new ProviderHttpError(
          options.provider,
          'PROVIDER_TIMEOUT',
          `${options.provider} request failed (PROVIDER_TIMEOUT).`,
        );
      }
      const response = await fetch(url, {
        method: 'GET',
        headers: options.headers,
        signal: controller.signal,
      });
      const receivedAt = new Date();
      status = response.status;
      if (coordinator) usedWeight1m = binanceUsedWeight(response.headers);
      if (!response.ok) {
        if (coordinator && (status === 418 || status === 429)) {
          outcome = 'limited';
          retryAfterMs = parseBinanceRetryAfter(
            response.headers,
            status,
            receivedAt,
          );
          // Publish the stop instruction before stream cleanup or upper-layer work.
          coordinationCompleted = true;
          try {
            await coordinator.complete(
              token as string,
              outcome,
              retryAfterMs,
              status,
              usedWeight1m,
            );
          } catch {
            // The coordinator retains an unpersisted restriction locally. Keep
            // the original safe 418/429 instead of replacing it with Redis detail.
          }
        }
        // Release the fetch stream without reading or retaining the error body.
        await response.body?.cancel().catch(() => undefined);
        // @diagnosticSurface internal: Provider adapters and HTTP/Ops boundaries receive only sanitized status/category; no response body or URL is retained.
        throw new ProviderHttpError(
          options.provider,
          outcome === 'limited'
            ? 'PROVIDER_RATE_LIMITED'
            : 'PROVIDER_HTTP_ERROR',
          `${options.provider} HTTP ${response.status} (${outcome === 'limited' ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_HTTP_ERROR'}).`,
          outcome === 'limited'
            ? { status, retryAfterMs, usedWeight1m }
            : undefined,
        );
      }

      const bodyText = await response.text();

      let json: T;
      try {
        json = JSON.parse(bodyText) as T;
      } catch {
        throw new ProviderHttpError(
          options.provider,
          'PROVIDER_JSON_PARSE_ERROR',
          `${options.provider} returned invalid JSON (PROVIDER_JSON_PARSE_ERROR).`,
        );
      }
      outcome = 'success';
      if (coordinator && token) {
        coordinationCompleted = true;
        await coordinator.complete(token, outcome, 0, status, usedWeight1m);
      }
      return { json, receivedAt, status: response.status };
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
      if (coordinator && token && !coordinationCompleted) {
        try {
          await coordinator.complete(
            token,
            outcome,
            retryAfterMs,
            status,
            usedWeight1m,
          );
        } catch {
          // Preserve the original safe HTTP failure classification.
        }
      }
    }
  }
}
