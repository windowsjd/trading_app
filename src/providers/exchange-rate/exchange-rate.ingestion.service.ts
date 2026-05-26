import { Injectable } from '@nestjs/common';
import {
  CurrencyCode,
  FxRateSourceType,
  Prisma,
} from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ProviderConfigService } from '../provider-config.service';
import { buildProviderRawPayloadJson } from '../provider-raw-payload';
import { collectProviderSecretsFromEnv } from '../provider-secret-redaction';
import { ProviderConfigError, ProviderHttpError } from '../provider.types';
import { ExchangeRateClient } from './exchange-rate.client';
import type {
  ExchangeRateApiLatestUsdResponse,
  ParsedUsdKrwExchangeRate,
} from './exchange-rate.types';

export type ExchangeRateIngestionOptions = {
  dryRun?: boolean;
  requestedBy?: string;
  baseCurrency?: string;
};

export type ExchangeRateIngestionResult = {
  success: boolean;
  provider: 'exchange_rate_api';
  fromCurrency: CurrencyCode;
  toCurrency: CurrencyCode;
  rate: string | null;
  effectiveAt: string | null;
  dryRun: boolean;
  created: number;
  skipped: number;
  wouldCreate: number;
  errorCode?: string;
  errorMessage?: string;
};

const EXCHANGE_RATE_SOURCE_NAME = 'exchange_rate_api';

@Injectable()
export class ExchangeRateIngestionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ProviderConfigService,
    private readonly client: ExchangeRateClient,
  ) {}

  async ingestUsdKrw(
    options: ExchangeRateIngestionOptions = {},
  ): Promise<ExchangeRateIngestionResult> {
    const dryRun = Boolean(options.dryRun);
    try {
      if (options.baseCurrency && options.baseCurrency !== CurrencyCode.USD) {
        throw new ProviderConfigError(
          'exchange_rate_api',
          'UNSUPPORTED_BASE_CURRENCY',
          'ExchangeRate-API ingestion supports USD base only.',
        );
      }

      const config = this.configService.getConfig();
      if (!config.common.providerIngestionEnabled) {
        throw new ProviderConfigError(
          'common',
          'PROVIDER_INGESTION_DISABLED',
          'Provider ingestion is disabled.',
        );
      }

      if (!config.exchangeRateApi.enabled) {
        throw new ProviderConfigError(
          'exchange_rate_api',
          'PROVIDER_DISABLED',
          'ExchangeRate-API provider is disabled.',
        );
      }

      const fetched = await this.client.fetchLatestUsd();
      const parsed = parseUsdKrwExchangeRateResponse(
        fetched.response,
        fetched.receivedAt,
      );
      const duplicate = await this.findDuplicateSnapshot(parsed);
      if (duplicate) {
        return this.successResult({
          parsed,
          dryRun,
          created: 0,
          skipped: 1,
          wouldCreate: 0,
        });
      }

      if (dryRun) {
        return this.successResult({
          parsed,
          dryRun,
          created: 0,
          skipped: 0,
          wouldCreate: 1,
        });
      }

      const rawPayloadJson = buildProviderRawPayloadJson({
        payload: fetched.response,
        maxBytes: config.common.rawPayloadMaxBytes,
        secrets: [
          ...collectProviderSecretsFromEnv(),
          config.exchangeRateApi.apiKey,
        ].filter((secret): secret is string => Boolean(secret)),
      });

      await this.prisma.fxRateSnapshot.create({
        data: {
          baseCurrency: CurrencyCode.USD,
          quoteCurrency: CurrencyCode.KRW,
          rate: parsed.rate,
          sourceType: FxRateSourceType.provider_api,
          sourceName: EXCHANGE_RATE_SOURCE_NAME,
          sourceTimestamp: parsed.sourceTimestamp,
          effectiveAt: parsed.effectiveAt,
          capturedAt: fetched.receivedAt,
          approvedByUserId: null,
          note: buildProviderNote(options.requestedBy),
          rawPayloadJson: rawPayloadJson as Prisma.InputJsonValue,
        },
        select: {
          id: true,
        },
      });

      return this.successResult({
        parsed,
        dryRun,
        created: 1,
        skipped: 0,
        wouldCreate: 0,
      });
    } catch (error) {
      if (
        error instanceof ProviderConfigError ||
        error instanceof ProviderHttpError
      ) {
        return {
          success: false,
          provider: EXCHANGE_RATE_SOURCE_NAME,
          fromCurrency: CurrencyCode.USD,
          toCurrency: CurrencyCode.KRW,
          rate: null,
          effectiveAt: null,
          dryRun,
          created: 0,
          skipped: 0,
          wouldCreate: 0,
          errorCode: error.code,
          errorMessage: error.message,
        };
      }

      throw error;
    }
  }

  private async findDuplicateSnapshot(parsed: ParsedUsdKrwExchangeRate) {
    return this.prisma.fxRateSnapshot.findFirst({
      where: {
        baseCurrency: CurrencyCode.USD,
        quoteCurrency: CurrencyCode.KRW,
        sourceType: FxRateSourceType.provider_api,
        sourceName: EXCHANGE_RATE_SOURCE_NAME,
        effectiveAt: parsed.effectiveAt,
        rate: parsed.rate,
      },
      select: {
        id: true,
      },
    });
  }

  private successResult(input: {
    parsed: ParsedUsdKrwExchangeRate;
    dryRun: boolean;
    created: number;
    skipped: number;
    wouldCreate: number;
  }): ExchangeRateIngestionResult {
    return {
      success: true,
      provider: EXCHANGE_RATE_SOURCE_NAME,
      fromCurrency: CurrencyCode.USD,
      toCurrency: CurrencyCode.KRW,
      rate: input.parsed.rate,
      effectiveAt: input.parsed.effectiveAt.toISOString(),
      dryRun: input.dryRun,
      created: input.created,
      skipped: input.skipped,
      wouldCreate: input.wouldCreate,
    };
  }
}

export function parseUsdKrwExchangeRateResponse(
  response: ExchangeRateApiLatestUsdResponse,
  receivedAt: Date,
): ParsedUsdKrwExchangeRate {
  if (response.result && response.result !== 'success') {
    throw new ProviderHttpError(
      'exchange_rate_api',
      'PROVIDER_RESPONSE_NOT_SUCCESS',
      'ExchangeRate-API response was not successful.',
    );
  }

  if (response.base_code && response.base_code !== CurrencyCode.USD) {
    throw new ProviderHttpError(
      'exchange_rate_api',
      'UNEXPECTED_BASE_CURRENCY',
      'ExchangeRate-API response base currency is not USD.',
    );
  }

  const krwRate = response.conversion_rates?.KRW;
  if (krwRate === undefined || krwRate === null) {
    throw new ProviderHttpError(
      'exchange_rate_api',
      'KRW_RATE_MISSING',
      'ExchangeRate-API response does not include conversion_rates.KRW.',
    );
  }

  const rate = toPositiveDecimalString(krwRate, 'conversion_rates.KRW', 8);
  const timestamp = parseExchangeRateTimestamp(response);

  return {
    fromCurrency: CurrencyCode.USD,
    toCurrency: CurrencyCode.KRW,
    rate,
    effectiveAt: timestamp ?? receivedAt,
    sourceTimestamp: timestamp,
  };
}

function parseExchangeRateTimestamp(
  response: ExchangeRateApiLatestUsdResponse,
): Date | null {
  if (
    typeof response.time_last_update_unix === 'number' &&
    Number.isFinite(response.time_last_update_unix) &&
    response.time_last_update_unix > 0
  ) {
    return new Date(response.time_last_update_unix * 1000);
  }

  if (typeof response.time_last_update_utc === 'string') {
    const parsed = new Date(response.time_last_update_utc);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return null;
}

function toPositiveDecimalString(
  value: number | string,
  fieldName: string,
  scale: number,
): string {
  try {
    const decimal = new Prisma.Decimal(String(value));
    if (!decimal.isFinite() || decimal.lte(0)) {
      throw new Error();
    }

    return decimal.toFixed(scale);
  } catch {
    throw new ProviderHttpError(
      'exchange_rate_api',
      'INVALID_DECIMAL',
      `${fieldName} must be a positive decimal.`,
    );
  }
}

function buildProviderNote(requestedBy: string | undefined): string {
  const operator = requestedBy?.trim();
  return operator
    ? `provider_api ingestion requested by ${operator}`
    : 'provider_api ingestion';
}
