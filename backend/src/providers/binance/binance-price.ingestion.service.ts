import { Injectable } from '@nestjs/common';
import {
  AssetPriceSourceType,
  AssetType,
  CurrencyCode,
  FxRateSourceType,
  Prisma,
} from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ProviderConfigService } from '../provider-config.service';
import { buildProviderRawPayloadJson } from '../provider-raw-payload';
import { ProviderConfigError, ProviderHttpError } from '../provider.types';
import { BinancePublicClient } from './binance-public.client';
import type {
  BinanceSymbolIngestionSummary,
  BinanceTicker24hrResponse,
  ParsedBinanceTickerPrice,
} from './binance.types';

export type BinancePriceIngestionOptions = {
  dryRun?: boolean;
  requestedBy?: string;
  symbols?: readonly string[];
};

export type BinancePriceIngestionResult = {
  success: boolean;
  provider: 'binance';
  dryRun: boolean;
  symbolCount: number;
  created: number;
  skipped: number;
  wouldCreate: number;
  failed: number;
  symbols: BinanceSymbolIngestionSummary[];
  errorCode?: string;
  errorMessage?: string;
};

type BinanceAssetMapping =
  | {
      state: 'mapped';
      assetId: string;
    }
  | {
      state: 'skipped';
      reason: string;
    };

const BINANCE_MARKET = 'BINANCE';
const BINANCE_SOURCE_NAME = 'binance_public_rest_24hr_ticker';

@Injectable()
export class BinancePriceIngestionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ProviderConfigService,
    private readonly client: BinancePublicClient,
  ) {}

  async ingestPrices(
    options: BinancePriceIngestionOptions = {},
  ): Promise<BinancePriceIngestionResult> {
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

      if (!config.binance.enabled) {
        throw new ProviderConfigError(
          'binance',
          'PROVIDER_DISABLED',
          'Binance public market data provider is disabled.',
        );
      }

      const symbols = normalizeSymbols(
        options.symbols ?? config.binance.symbols,
      );
      const summaries: BinanceSymbolIngestionSummary[] = [];

      for (const symbol of symbols) {
        summaries.push(
          await this.ingestOneSymbol({
            symbol,
            dryRun,
            requestedBy: options.requestedBy,
            usdtAsUsdEquivalent: config.binance.usdtAsUsdEquivalent,
            rawPayloadMaxBytes: config.common.rawPayloadMaxBytes,
          }),
        );
      }

      return buildBinanceResult({
        dryRun,
        summaries,
        success: summaries.every((summary) => summary.state !== 'failed'),
      });
    } catch (error) {
      if (
        error instanceof ProviderConfigError ||
        error instanceof ProviderHttpError
      ) {
        return {
          success: false,
          provider: 'binance',
          dryRun,
          symbolCount: 0,
          created: 0,
          skipped: 0,
          wouldCreate: 0,
          failed: 0,
          symbols: [],
          errorCode: error.code,
          errorMessage: error.message,
        };
      }

      throw error;
    }
  }

  private async ingestOneSymbol(input: {
    symbol: string;
    dryRun: boolean;
    requestedBy?: string;
    usdtAsUsdEquivalent: boolean;
    rawPayloadMaxBytes: number;
  }): Promise<BinanceSymbolIngestionSummary> {
    try {
      const symbolPolicy = parseBinanceUsdEquivalentSymbol(
        input.symbol,
        input.usdtAsUsdEquivalent,
      );
      if (!symbolPolicy.supported) {
        return {
          symbol: input.symbol,
          state: 'skipped',
          assetId: null,
          price: null,
          effectiveAt: null,
          reason: symbolPolicy.reason,
        };
      }

      const fetched = await this.client.fetchTicker24hr(input.symbol);
      const parsed = parseBinanceTickerPrice(
        fetched.response,
        fetched.receivedAt,
        input.symbol,
      );
      const mapping = await this.findMappedAsset({
        providerSymbol: parsed.providerSymbol,
        baseSymbol: symbolPolicy.baseSymbol,
      });

      if (mapping.state === 'skipped') {
        return {
          symbol: parsed.providerSymbol,
          state: 'skipped',
          assetId: null,
          price: parsed.price,
          effectiveAt: parsed.effectiveAt.toISOString(),
          reason: mapping.reason,
        };
      }

      const duplicate = await this.findDuplicateSnapshot({
        assetId: mapping.assetId,
        parsed,
      });
      if (duplicate) {
        return {
          symbol: parsed.providerSymbol,
          state: 'skipped',
          assetId: mapping.assetId,
          price: parsed.price,
          effectiveAt: parsed.effectiveAt.toISOString(),
          reason: 'DUPLICATE_PROVIDER_SNAPSHOT',
        };
      }

      if (input.dryRun) {
        return {
          symbol: parsed.providerSymbol,
          state: 'would_create',
          assetId: mapping.assetId,
          price: parsed.price,
          effectiveAt: parsed.effectiveAt.toISOString(),
        };
      }

      const rawPayloadJson = buildProviderRawPayloadJson({
        payload: fetched.response,
        maxBytes: input.rawPayloadMaxBytes,
      });

      await this.prisma.assetPriceSnapshot.create({
        data: {
          assetId: mapping.assetId,
          price: parsed.price,
          priceKrw: await this.buildPriceKrw(parsed.price, parsed.effectiveAt),
          currencyCode: CurrencyCode.USD,
          sourceType: AssetPriceSourceType.provider_api,
          sourceName: BINANCE_SOURCE_NAME,
          sourceTimestamp: parsed.sourceTimestamp,
          effectiveAt: parsed.effectiveAt,
          capturedAt: fetched.receivedAt,
          rawPayloadJson: rawPayloadJson as Prisma.InputJsonValue,
          note: buildProviderNote(input.requestedBy),
        },
        select: {
          id: true,
        },
      });

      return {
        symbol: parsed.providerSymbol,
        state: 'created',
        assetId: mapping.assetId,
        price: parsed.price,
        effectiveAt: parsed.effectiveAt.toISOString(),
      };
    } catch (error) {
      if (
        error instanceof ProviderConfigError ||
        error instanceof ProviderHttpError
      ) {
        return {
          symbol: input.symbol,
          state: 'failed',
          assetId: null,
          price: null,
          effectiveAt: null,
          reason: error.code,
        };
      }

      throw error;
    }
  }

  private async buildPriceKrw(
    price: string,
    effectiveAt: Date,
  ): Promise<string | null> {
    if (!this.prisma.fxRateSnapshot) {
      return null;
    }

    const fxRate = await this.prisma.fxRateSnapshot.findFirst({
      where: {
        baseCurrency: CurrencyCode.USD,
        quoteCurrency: CurrencyCode.KRW,
        rate: {
          gt: 0,
        },
        effectiveAt: {
          lte: effectiveAt,
        },
        OR: [
          {
            sourceType: FxRateSourceType.provider_api,
          },
          {
            sourceType: FxRateSourceType.admin_manual,
            approvedByUserId: {
              not: null,
            },
          },
        ],
      },
      orderBy: [
        { effectiveAt: 'desc' },
        { capturedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      select: {
        rate: true,
      },
    });

    return fxRate ? new Prisma.Decimal(price).mul(fxRate.rate).toFixed(8) : null;
  }

  private async findMappedAsset(input: {
    providerSymbol: string;
    baseSymbol: string;
  }): Promise<BinanceAssetMapping> {
    const candidateSymbols =
      input.providerSymbol === input.baseSymbol
        ? [input.providerSymbol]
        : [input.providerSymbol, input.baseSymbol];
    const assets = await this.prisma.asset.findMany({
      where: {
        market: BINANCE_MARKET,
        symbol: {
          in: candidateSymbols,
        },
        currencyCode: CurrencyCode.USD,
        assetType: AssetType.crypto,
        isActive: true,
      },
      select: {
        id: true,
        symbol: true,
      },
    });

    if (assets.length === 0) {
      return {
        state: 'skipped',
        reason: 'ASSET_MAPPING_NOT_FOUND',
      };
    }

    if (assets.length > 1) {
      return {
        state: 'skipped',
        reason: 'ASSET_MAPPING_AMBIGUOUS',
      };
    }

    return {
      state: 'mapped',
      assetId: assets[0].id,
    };
  }

  private async findDuplicateSnapshot(input: {
    assetId: string;
    parsed: ParsedBinanceTickerPrice;
  }) {
    return this.prisma.assetPriceSnapshot.findFirst({
      where: {
        assetId: input.assetId,
        price: input.parsed.price,
        currencyCode: CurrencyCode.USD,
        sourceType: AssetPriceSourceType.provider_api,
        sourceName: BINANCE_SOURCE_NAME,
        effectiveAt: input.parsed.effectiveAt,
      },
      select: {
        id: true,
      },
    });
  }
}

export function parseBinanceTickerPrice(
  response: BinanceTicker24hrResponse,
  receivedAt: Date,
  requestedSymbol: string,
): ParsedBinanceTickerPrice {
  const providerSymbol = String(response.symbol ?? requestedSymbol)
    .trim()
    .toUpperCase();
  const rawPrice = response.lastPrice ?? response.price;
  if (rawPrice === undefined) {
    throw new ProviderHttpError(
      'binance',
      'BINANCE_PRICE_MISSING',
      'Binance ticker response does not include lastPrice.',
    );
  }

  const price = toPositiveDecimalString(rawPrice, 'lastPrice', 8);
  const sourceTimestamp =
    typeof response.closeTime === 'number' &&
    Number.isFinite(response.closeTime) &&
    response.closeTime > 0
      ? new Date(response.closeTime)
      : null;

  return {
    providerSymbol,
    internalCurrencyCode: CurrencyCode.USD,
    price,
    effectiveAt: sourceTimestamp ?? receivedAt,
    sourceTimestamp,
  };
}

export function parseBinanceUsdEquivalentSymbol(
  symbol: string,
  usdtAsUsdEquivalent: boolean,
):
  | {
      supported: true;
      providerSymbol: string;
      baseSymbol: string;
    }
  | {
      supported: false;
      reason: string;
    } {
  const providerSymbol = symbol.trim().toUpperCase();
  if (!providerSymbol) {
    return {
      supported: false,
      reason: 'EMPTY_SYMBOL',
    };
  }

  if (providerSymbol.endsWith('USDT')) {
    if (!usdtAsUsdEquivalent) {
      return {
        supported: false,
        reason: 'USDT_QUOTE_NOT_ALLOWED',
      };
    }

    return {
      supported: true,
      providerSymbol,
      baseSymbol: providerSymbol.slice(0, -4),
    };
  }

  if (providerSymbol.endsWith('USD')) {
    return {
      supported: true,
      providerSymbol,
      baseSymbol: providerSymbol.slice(0, -3),
    };
  }

  return {
    supported: false,
    reason: 'UNSUPPORTED_QUOTE_CURRENCY',
  };
}

function normalizeSymbols(symbols: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const symbol of symbols) {
    const text = symbol.trim().toUpperCase();
    if (!text || seen.has(text)) {
      continue;
    }

    seen.add(text);
    normalized.push(text);
  }

  return normalized;
}

function toPositiveDecimalString(
  value: string,
  fieldName: string,
  scale: number,
): string {
  try {
    const decimal = new Prisma.Decimal(value);
    if (!decimal.isFinite() || decimal.lte(0)) {
      throw new Error();
    }

    return decimal.toFixed(scale);
  } catch {
    throw new ProviderHttpError(
      'binance',
      'INVALID_DECIMAL',
      `${fieldName} must be a positive decimal.`,
    );
  }
}

function buildProviderNote(requestedBy: string | undefined): string {
  const operator = requestedBy?.trim();
  return operator
    ? `provider_api Binance price ingestion requested by ${operator}`
    : 'provider_api Binance price ingestion';
}

function buildBinanceResult(input: {
  dryRun: boolean;
  summaries: BinanceSymbolIngestionSummary[];
  success: boolean;
}): BinancePriceIngestionResult {
  return {
    success: input.success,
    provider: 'binance',
    dryRun: input.dryRun,
    symbolCount: input.summaries.length,
    created: input.summaries.filter((summary) => summary.state === 'created')
      .length,
    skipped: input.summaries.filter((summary) => summary.state === 'skipped')
      .length,
    wouldCreate: input.summaries.filter(
      (summary) => summary.state === 'would_create',
    ).length,
    failed: input.summaries.filter((summary) => summary.state === 'failed')
      .length,
    symbols: input.summaries,
  };
}
