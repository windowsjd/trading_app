import { Injectable } from '@nestjs/common';
import {
  CurrencyCode,
  FxRateSourceType,
  Prisma,
} from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ProviderConfigService } from '../provider-config.service';
import { ProviderConfigError, ProviderHttpError } from '../provider.types';
import { KoreaEximExchangeClient } from './korea-exim-exchange.client';
import {
  KOREA_EXIM_EXCHANGE_SOURCE_NAME,
  type KoreaEximExchangeRateRow,
  type ParsedKoreaEximUsdKrwRate,
} from './korea-exim-exchange.types';

export type KoreaEximEnsureFreshOptions = {
  now?: Date;
  maxAgeSeconds?: number;
  lookbackDays?: number;
};

export type KoreaEximEnsureFreshResult = {
  snapshotId: string;
  rate: string;
  sourceName: typeof KOREA_EXIM_EXCHANGE_SOURCE_NAME;
  searchDate: string;
  effectiveAt: Date;
  capturedAt: Date;
  reused: boolean;
};

export type KoreaEximExchangeIngestionOptions = {
  dryRun?: boolean;
  requestedBy?: string;
  lookbackDays?: number;
};

export type KoreaEximExchangeIngestionResult = {
  success: boolean;
  provider: typeof KOREA_EXIM_EXCHANGE_SOURCE_NAME;
  dryRun: boolean;
  fromCurrency: CurrencyCode;
  toCurrency: CurrencyCode;
  rate: string | null;
  effectiveAt: string | null;
  searchDate: string | null;
  created: number;
  skipped: number;
  wouldCreate: number;
  errorCode?: string;
  errorMessage?: string;
};

const DEFAULT_MAX_AGE_SECONDS = 300;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

@Injectable()
export class KoreaEximExchangeIngestionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ProviderConfigService,
    private readonly client: KoreaEximExchangeClient,
  ) {}

  async ingestUsdKrw(
    options: KoreaEximExchangeIngestionOptions = {},
  ): Promise<KoreaEximExchangeIngestionResult> {
    const dryRun = Boolean(options.dryRun);

    try {
      const config = this.configService.getConfig();
      if (!config.common.providerIngestionEnabled) {
        throw new ProviderConfigError(
          'common',
          'PROVIDER_INGESTION_DISABLED',
          'Provider ingestion is disabled.',
        );
      }

      if (!config.koreaEximExchange.enabled) {
        throw new ProviderConfigError(
          KOREA_EXIM_EXCHANGE_SOURCE_NAME,
          'KOREA_EXIM_PROVIDER_DISABLED',
          'Korea EXIM exchange provider is disabled.',
        );
      }

      const lookbackDays = normalizeLookbackDays(
        options.lookbackDays ?? config.koreaEximExchange.lookbackDays,
      );
      const now = new Date();

      for (let offsetDays = 0; offsetDays < lookbackDays; offsetDays += 1) {
        const searchDate = formatKstSearchDate(now, offsetDays);
        const fetched = await this.client.fetchDailyExchangeRates({
          searchDate,
        });
        const parsed = parseKoreaEximUsdKrwRate(fetched.rows, searchDate);

        if (!parsed) {
          continue;
        }

        const duplicate = await this.findDuplicateSnapshot(parsed);
        if (duplicate) {
          return this.ingestionResult({
            parsed,
            dryRun,
            created: 0,
            skipped: 1,
            wouldCreate: 0,
          });
        }

        if (dryRun) {
          return this.ingestionResult({
            parsed,
            dryRun,
            created: 0,
            skipped: 0,
            wouldCreate: 1,
          });
        }

        await this.prisma.fxRateSnapshot.create({
          data: {
            baseCurrency: CurrencyCode.USD,
            quoteCurrency: CurrencyCode.KRW,
            rate: parsed.rate,
            sourceType: FxRateSourceType.provider_api,
            sourceName: KOREA_EXIM_EXCHANGE_SOURCE_NAME,
            sourceTimestamp: parsed.effectiveAt,
            effectiveAt: parsed.effectiveAt,
            capturedAt: fetched.receivedAt,
            approvedByUserId: null,
            note: buildProviderNote(options.requestedBy),
            rawPayloadJson: buildSafeRawPayloadMetadata(parsed),
          },
          select: {
            id: true,
          },
        });

        return this.ingestionResult({
          parsed,
          dryRun,
          created: 1,
          skipped: 0,
          wouldCreate: 0,
        });
      }

      throw new ProviderHttpError(
        KOREA_EXIM_EXCHANGE_SOURCE_NAME,
        'KOREA_EXIM_USD_RATE_UNAVAILABLE',
        'Korea EXIM exchange API did not return an available USD/KRW rate within the configured lookback window.',
      );
    } catch (error) {
      if (
        error instanceof ProviderConfigError ||
        error instanceof ProviderHttpError
      ) {
        return {
          success: false,
          provider: KOREA_EXIM_EXCHANGE_SOURCE_NAME,
          dryRun,
          fromCurrency: CurrencyCode.USD,
          toCurrency: CurrencyCode.KRW,
          rate: null,
          effectiveAt: null,
          searchDate: null,
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

  async ensureFreshUsdKrwSnapshot(
    options: KoreaEximEnsureFreshOptions = {},
  ): Promise<KoreaEximEnsureFreshResult> {
    const now = options.now ?? new Date();
    const maxAgeSeconds =
      options.maxAgeSeconds && options.maxAgeSeconds > 0
        ? options.maxAgeSeconds
        : DEFAULT_MAX_AGE_SECONDS;
    const reusable = await this.findReusableFreshSnapshot({
      now,
      maxAgeSeconds,
    });

    if (reusable) {
      return {
        snapshotId: reusable.id,
        rate: reusable.rate.toFixed(8),
        sourceName: KOREA_EXIM_EXCHANGE_SOURCE_NAME,
        searchDate: formatKstSearchDate(reusable.effectiveAt),
        effectiveAt: reusable.effectiveAt,
        capturedAt: reusable.capturedAt,
        reused: true,
      };
    }

    const config = this.configService.getConfig();
    if (!config.common.providerIngestionEnabled) {
      throw new ProviderConfigError(
        'common',
        'PROVIDER_INGESTION_DISABLED',
        'Provider ingestion is disabled.',
      );
    }

    if (!config.koreaEximExchange.enabled) {
      throw new ProviderConfigError(
        KOREA_EXIM_EXCHANGE_SOURCE_NAME,
        'KOREA_EXIM_PROVIDER_DISABLED',
        'Korea EXIM exchange provider is disabled.',
      );
    }

    const lookbackDays = normalizeLookbackDays(
      options.lookbackDays ?? config.koreaEximExchange.lookbackDays,
    );

    for (let offsetDays = 0; offsetDays < lookbackDays; offsetDays += 1) {
      const searchDate = formatKstSearchDate(now, offsetDays);
      const fetched = await this.client.fetchDailyExchangeRates({ searchDate });
      const parsed = parseKoreaEximUsdKrwRate(fetched.rows, searchDate);

      if (!parsed) {
        continue;
      }

      const duplicate = await this.findDuplicateSnapshot(parsed);
      if (duplicate) {
        return {
          snapshotId: duplicate.id,
          rate: duplicate.rate.toFixed(8),
          sourceName: KOREA_EXIM_EXCHANGE_SOURCE_NAME,
          searchDate,
          effectiveAt: duplicate.effectiveAt,
          capturedAt: duplicate.capturedAt,
          reused: true,
        };
      }

      const created = await this.prisma.fxRateSnapshot.create({
        data: {
          baseCurrency: CurrencyCode.USD,
          quoteCurrency: CurrencyCode.KRW,
          rate: parsed.rate,
          sourceType: FxRateSourceType.provider_api,
          sourceName: KOREA_EXIM_EXCHANGE_SOURCE_NAME,
          sourceTimestamp: parsed.effectiveAt,
          effectiveAt: parsed.effectiveAt,
          capturedAt: fetched.receivedAt,
          approvedByUserId: null,
          note: 'provider_api korea_exim_exchange_rate ingestion',
          rawPayloadJson: buildSafeRawPayloadMetadata(parsed),
        },
        select: {
          id: true,
          rate: true,
          effectiveAt: true,
          capturedAt: true,
        },
      });

      return {
        snapshotId: created.id,
        rate: created.rate.toFixed(8),
        sourceName: KOREA_EXIM_EXCHANGE_SOURCE_NAME,
        searchDate,
        effectiveAt: created.effectiveAt,
        capturedAt: created.capturedAt,
        reused: false,
      };
    }

    throw new ProviderHttpError(
      KOREA_EXIM_EXCHANGE_SOURCE_NAME,
      'KOREA_EXIM_USD_RATE_UNAVAILABLE',
      'Korea EXIM exchange API did not return an available USD/KRW rate within the configured lookback window.',
    );
  }

  private findReusableFreshSnapshot(input: {
    now: Date;
    maxAgeSeconds: number;
  }) {
    const capturedAfter = new Date(
      input.now.getTime() - input.maxAgeSeconds * 1000,
    );

    return this.prisma.fxRateSnapshot.findFirst({
      where: {
        baseCurrency: CurrencyCode.USD,
        quoteCurrency: CurrencyCode.KRW,
        sourceType: FxRateSourceType.provider_api,
        sourceName: KOREA_EXIM_EXCHANGE_SOURCE_NAME,
        rate: {
          gt: 0,
        },
        effectiveAt: {
          lte: input.now,
        },
        capturedAt: {
          gte: capturedAfter,
          lte: input.now,
        },
      },
      orderBy: [
        { effectiveAt: 'desc' },
        { capturedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      select: {
        id: true,
        rate: true,
        effectiveAt: true,
        capturedAt: true,
      },
    });
  }

  private findDuplicateSnapshot(parsed: ParsedKoreaEximUsdKrwRate) {
    return this.prisma.fxRateSnapshot.findFirst({
      where: {
        baseCurrency: CurrencyCode.USD,
        quoteCurrency: CurrencyCode.KRW,
        sourceType: FxRateSourceType.provider_api,
        sourceName: KOREA_EXIM_EXCHANGE_SOURCE_NAME,
        effectiveAt: parsed.effectiveAt,
        rate: parsed.rate,
      },
      select: {
        id: true,
        rate: true,
        effectiveAt: true,
        capturedAt: true,
      },
    });
  }

  private ingestionResult(input: {
    parsed: ParsedKoreaEximUsdKrwRate;
    dryRun: boolean;
    created: number;
    skipped: number;
    wouldCreate: number;
  }): KoreaEximExchangeIngestionResult {
    return {
      success: true,
      provider: KOREA_EXIM_EXCHANGE_SOURCE_NAME,
      dryRun: input.dryRun,
      fromCurrency: CurrencyCode.USD,
      toCurrency: CurrencyCode.KRW,
      rate: input.parsed.rate,
      effectiveAt: input.parsed.effectiveAt.toISOString(),
      searchDate: input.parsed.searchDate,
      created: input.created,
      skipped: input.skipped,
      wouldCreate: input.wouldCreate,
    };
  }
}

export function parseKoreaEximUsdKrwRate(
  rows: readonly KoreaEximExchangeRateRow[],
  searchDate: string,
): ParsedKoreaEximUsdKrwRate | null {
  if (rows.length === 0) {
    return null;
  }

  assertSuccessfulResultCode(rows);

  const usdRow = rows.find((row) => {
    const curUnit = readStringField(row, 'CUR_UNIT', 'cur_unit');
    return curUnit.trim().toUpperCase().startsWith('USD');
  });

  if (!usdRow) {
    return null;
  }

  const curUnit = readStringField(usdRow, 'CUR_UNIT', 'cur_unit').trim();
  const curName = readOptionalStringField(usdRow, 'CUR_NM', 'cur_nm');
  const rawDealBasR = readOptionalValueField(
    usdRow,
    'DEAL_BAS_R',
    'deal_bas_r',
  );

  if (rawDealBasR === undefined) {
    throw malformedResponseError('Korea EXIM USD row is missing DEAL_BAS_R.');
  }

  const dealBasR = String(rawDealBasR).trim();
  const rate = toPositiveDecimalString(dealBasR.replace(/,/g, ''));

  return {
    fromCurrency: CurrencyCode.USD,
    toCurrency: CurrencyCode.KRW,
    rate,
    searchDate,
    effectiveAt: kstSearchDateToUtcMidnight(searchDate),
    curUnit,
    curName: curName?.trim() || null,
    dealBasR,
  };
}

export function formatKstSearchDate(now: Date, offsetDays = 0): string {
  const kstDate = new Date(now.getTime() + KST_OFFSET_MS);
  const shifted = new Date(
    Date.UTC(
      kstDate.getUTCFullYear(),
      kstDate.getUTCMonth(),
      kstDate.getUTCDate() - offsetDays,
    ),
  );

  return [
    shifted.getUTCFullYear(),
    String(shifted.getUTCMonth() + 1).padStart(2, '0'),
    String(shifted.getUTCDate()).padStart(2, '0'),
  ].join('');
}

export function kstSearchDateToUtcMidnight(searchDate: string): Date {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(searchDate);
  if (!match) {
    throw malformedResponseError('Korea EXIM searchDate must be YYYYMMDD.');
  }

  const [, year, month, day] = match;
  return new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day)) - KST_OFFSET_MS,
  );
}

function assertSuccessfulResultCode(
  rows: readonly KoreaEximExchangeRateRow[],
): void {
  const resultCode = rows
    .map((row) => readOptionalValueField(row, 'RESULT', 'result'))
    .find((value) => value !== undefined);

  if (resultCode === undefined || String(resultCode).trim() === '1') {
    return;
  }

  const code = String(resultCode).trim();
  switch (code) {
    case '2':
      throw new ProviderHttpError(
        KOREA_EXIM_EXCHANGE_SOURCE_NAME,
        'KOREA_EXIM_DATA_CODE_ERROR',
        'Korea EXIM exchange API rejected the requested data code.',
      );
    case '3':
      throw new ProviderHttpError(
        KOREA_EXIM_EXCHANGE_SOURCE_NAME,
        'KOREA_EXIM_AUTH_CODE_ERROR',
        'Korea EXIM exchange API rejected the auth code.',
      );
    case '4':
      throw new ProviderHttpError(
        KOREA_EXIM_EXCHANGE_SOURCE_NAME,
        'KOREA_EXIM_DAILY_LIMIT_EXCEEDED',
        'Korea EXIM exchange API daily request limit was exceeded.',
      );
    default:
      throw malformedResponseError(
        'Korea EXIM exchange API returned an unknown RESULT code.',
      );
  }
}

function readStringField(
  row: KoreaEximExchangeRateRow,
  upperName: string,
  lowerName: string,
): string {
  const value = readOptionalValueField(row, upperName, lowerName);
  return typeof value === 'string' ? value : '';
}

function readOptionalStringField(
  row: KoreaEximExchangeRateRow,
  upperName: string,
  lowerName: string,
): string | undefined {
  const value = readOptionalValueField(row, upperName, lowerName);
  return typeof value === 'string' ? value : undefined;
}

function readOptionalValueField(
  row: KoreaEximExchangeRateRow,
  upperName: string,
  lowerName: string,
): unknown {
  return row[upperName] ?? row[lowerName];
}

function toPositiveDecimalString(value: string): string {
  try {
    const decimal = new Prisma.Decimal(value);
    if (!decimal.isFinite() || decimal.lte(0)) {
      throw new Error();
    }

    return decimal.toFixed(8);
  } catch {
    throw malformedResponseError(
      'Korea EXIM USD DEAL_BAS_R must be a positive decimal.',
    );
  }
}

function normalizeLookbackDays(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ProviderConfigError(
      KOREA_EXIM_EXCHANGE_SOURCE_NAME,
      'INVALID_INTEGER_ENV',
      'KOREA_EXIM_EXCHANGE_LOOKBACK_DAYS must be a positive integer.',
    );
  }

  return value;
}

function buildSafeRawPayloadMetadata(
  parsed: ParsedKoreaEximUsdKrwRate,
): Prisma.InputJsonValue {
  return {
    provider: KOREA_EXIM_EXCHANGE_SOURCE_NAME,
    searchDate: parsed.searchDate,
    curUnit: parsed.curUnit,
    curName: parsed.curName,
    dealBasR: parsed.dealBasR,
  };
}

function buildProviderNote(requestedBy: string | undefined): string {
  const operator = requestedBy?.trim();
  return operator
    ? `provider_api korea_exim_exchange_rate ingestion requested by ${operator}`
    : 'provider_api korea_exim_exchange_rate ingestion';
}

function malformedResponseError(message: string): ProviderHttpError {
  return new ProviderHttpError(
    KOREA_EXIM_EXCHANGE_SOURCE_NAME,
    'KOREA_EXIM_MALFORMED_RESPONSE',
    message,
  );
}
