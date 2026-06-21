import { Injectable } from '@nestjs/common';
import {
  AssetPriceSourceType,
  AssetType,
  CurrencyCode,
  FxRateSourceType,
  Prisma,
} from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ProviderConfigService,
  type ProviderConfig,
} from '../provider-config.service';
import { buildProviderRawPayloadJson } from '../provider-raw-payload';
import { ProviderConfigError, ProviderHttpError } from '../provider.types';
import { KisAuthClient } from './kis-auth.client';
import { KisQuoteClient } from './kis-quote.client';
import {
  parseKisDomesticCurrentPriceResponse,
  parseKisUsCurrentPriceResponse,
} from './kis-rest-current-price.parser';
import type {
  KisRestCurrentPriceIngestionResult,
  KisRestCurrentPriceQuote,
  KisRestCurrentPriceSummary,
} from './kis-rest-current-price.types';
import { buildKisWatchlist } from './kis-watchlist.policy';
import {
  KIS_DOMESTIC_TRADE_SOURCE_NAME,
  KIS_US_DELAYED_TRADE_SOURCE_NAME,
} from './kis-websocket.types';
import {
  normalizeKisUsMarketCode,
  parseKisUsSymbolConfig,
  type KisUsMarketCode,
} from './kis-websocket.subscription';

export type KisRestCurrentPriceIngestionOptions = {
  dryRun?: boolean;
  requestedBy?: string;
  domesticSymbols?: readonly string[];
  usSymbols?: readonly string[];
  maxSnapshots?: number;
  secrets?: readonly string[];
};

type KisRestCurrentPriceTarget =
  | {
      kind: 'domestic';
      symbol: string;
      marketCode: 'KRX';
    }
  | {
      kind: 'us';
      symbol: string;
      marketCode: KisUsMarketCode;
    };

type KisRestTargetBuildResult = {
  targets: KisRestCurrentPriceTarget[];
  skipped: KisRestCurrentPriceSummary[];
};

type KisAssetMapping =
  | {
      state: 'mapped';
      assetId: string;
    }
  | {
      state: 'skipped';
      reason: string;
    };

type AssetMappingCandidate = {
  id: string;
  market: string;
  currencyCode: CurrencyCode;
  assetType: AssetType;
  isActive: boolean;
};

const DOMESTIC_KRX_MARKETS = new Set(['KRX', 'KOSPI', 'KOSDAQ', 'KONEX']);
const SKIPPED_PROVIDER_CODES = new Set([
  'INVALID_DECIMAL',
  'KIS_PRICE_MISSING',
  'INVALID_KIS_DOMESTIC_SYMBOL',
  'INVALID_KIS_US_SYMBOL',
  'US_MARKET_NOT_ALLOWED',
]);

@Injectable()
export class KisRestCurrentPriceIngestionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ProviderConfigService,
    private readonly authClient: KisAuthClient,
    private readonly quoteClient: KisQuoteClient,
  ) {}

  async ingestCurrentPrices(
    options: KisRestCurrentPriceIngestionOptions = {},
  ): Promise<KisRestCurrentPriceIngestionResult> {
    const dryRun = Boolean(options.dryRun);

    try {
      const config = this.configService.getConfig();
      assertKisRestIngestionEnabled(config);

      const targets = await this.buildTargets(config, options);
      if (targets.targets.length === 0) {
        return resultFromSummaries({
          dryRun,
          received: 0,
          summaries: targets.skipped,
        });
      }

      const token = await this.authClient.requestConfiguredRestToken();
      if (token.state === 'skipped') {
        return failedResult({
          dryRun,
          errorCode: token.reason,
          errorMessage: token.reason,
        });
      }

      const summaries: KisRestCurrentPriceSummary[] = [...targets.skipped];
      for (const target of targets.targets) {
        if (
          options.maxSnapshots !== undefined &&
          countAcceptedSnapshots(summaries) >= options.maxSnapshots
        ) {
          summaries.push({
            symbol: target.symbol,
            sourceName: sourceNameForTarget(target),
            state: 'skipped',
            assetId: null,
            price: null,
            effectiveAt: null,
            reason: 'MAX_SNAPSHOTS_REACHED',
          });
          continue;
        }

        summaries.push(
          await this.ingestOneTarget({
            target,
            config,
            dryRun,
            requestedBy: options.requestedBy,
            accessToken: token.response.accessToken,
            secrets: options.secrets,
          }),
        );
      }

      return resultFromSummaries({
        dryRun,
        received: targets.targets.length,
        summaries,
      });
    } catch (error) {
      if (
        error instanceof ProviderConfigError ||
        error instanceof ProviderHttpError
      ) {
        return failedResult({
          dryRun,
          errorCode: error.code,
          errorMessage: error.message,
        });
      }

      throw error;
    }
  }

  private async ingestOneTarget(input: {
    target: KisRestCurrentPriceTarget;
    config: ProviderConfig;
    dryRun: boolean;
    requestedBy?: string;
    accessToken: string;
    secrets?: readonly string[];
  }): Promise<KisRestCurrentPriceSummary> {
    try {
      const fetched =
        input.target.kind === 'domestic'
          ? await this.quoteClient.getMarketDataByExplicitPath<unknown>({
              path: input.config.kis.restDomesticCurrentPricePath,
              query: {
                FID_COND_MRKT_DIV_CODE: 'J',
                FID_INPUT_ISCD: input.target.symbol,
              },
              headers: {
                authorization: `Bearer ${input.accessToken}`,
                tr_id: input.config.kis.restDomesticCurrentPriceTrId,
                custtype: input.config.kis.wsCustType,
              },
            })
          : await this.quoteClient.getMarketDataByExplicitPath<unknown>({
              path: input.config.kis.restUsCurrentPricePath,
              query: {
                AUTH: '',
                EXCD: input.target.marketCode,
                SYMB: input.target.symbol,
              },
              headers: {
                authorization: `Bearer ${input.accessToken}`,
                tr_id: input.config.kis.restUsCurrentPriceTrId,
                custtype: input.config.kis.wsCustType,
              },
            });

      if (fetched.state === 'skipped') {
        return skippedTarget(input.target, fetched.reason);
      }

      const parsed =
        input.target.kind === 'domestic'
          ? parseKisDomesticCurrentPriceResponse(
              fetched.response,
              fetched.receivedAt,
              input.target.symbol,
            )
          : parseKisUsCurrentPriceResponse(
              fetched.response,
              fetched.receivedAt,
              input.target.symbol,
              input.target.marketCode,
            );
      const mapping = await this.findMappedAsset(parsed);
      const sourceName = sourceNameForQuote(parsed);

      if (mapping.state === 'skipped') {
        return {
          symbol: parsed.symbol,
          sourceName,
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
        sourceName,
      });
      if (duplicate) {
        return {
          symbol: parsed.symbol,
          sourceName,
          state: 'skipped',
          assetId: mapping.assetId,
          price: parsed.price,
          effectiveAt: parsed.effectiveAt.toISOString(),
          reason: 'DUPLICATE_PROVIDER_SNAPSHOT',
        };
      }

      const throttled = await this.findRecentSnapshotWithinThrottle({
        assetId: mapping.assetId,
        sourceName,
        receivedAt: fetched.receivedAt,
        throttleMs: input.config.kis.wsSnapshotThrottleMs,
      });
      if (throttled) {
        return {
          symbol: parsed.symbol,
          sourceName,
          state: 'skipped',
          assetId: mapping.assetId,
          price: parsed.price,
          effectiveAt: parsed.effectiveAt.toISOString(),
          reason: 'THROTTLED_PROVIDER_SNAPSHOT',
        };
      }

      if (input.dryRun) {
        return {
          symbol: parsed.symbol,
          sourceName,
          state: 'would_create',
          assetId: mapping.assetId,
          price: parsed.price,
          effectiveAt: parsed.effectiveAt.toISOString(),
        };
      }

      const rawPayloadJson = buildProviderRawPayloadJson({
        payload: {
          provider: 'kis',
          messageType: 'rest_current_price',
          response: fetched.response,
        },
        maxBytes: input.config.common.rawPayloadMaxBytes,
        secrets: [
          input.config.kis.appKey,
          input.config.kis.appSecret,
          input.accessToken,
          ...(input.secrets ?? []),
        ].filter((secret): secret is string => Boolean(secret)),
      });

      await this.prisma.assetPriceSnapshot.create({
        data: {
          assetId: mapping.assetId,
          price: parsed.price,
          priceKrw: await this.buildPriceKrw(
            parsed.price,
            parsed.currencyCode,
            parsed.effectiveAt,
          ),
          currencyCode: parsed.currencyCode,
          sourceType: AssetPriceSourceType.provider_api,
          sourceName,
          sourceTimestamp: parsed.sourceTimestamp,
          effectiveAt: parsed.effectiveAt,
          capturedAt: fetched.receivedAt,
          rawPayloadJson: rawPayloadJson as Prisma.InputJsonValue,
          note: buildKisProviderNote(input.requestedBy),
        },
        select: {
          id: true,
        },
      });

      return {
        symbol: parsed.symbol,
        sourceName,
        state: 'created',
        assetId: mapping.assetId,
        price: parsed.price,
        effectiveAt: parsed.effectiveAt.toISOString(),
      };
    } catch (error) {
      if (error instanceof ProviderHttpError) {
        return {
          symbol: input.target.symbol,
          sourceName: sourceNameForTarget(input.target),
          state: SKIPPED_PROVIDER_CODES.has(error.code) ? 'skipped' : 'failed',
          assetId: null,
          price: null,
          effectiveAt: null,
          reason: error.code,
        };
      }

      if (error instanceof ProviderConfigError) {
        return {
          symbol: input.target.symbol,
          sourceName: sourceNameForTarget(input.target),
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

  private async buildTargets(
    config: ProviderConfig,
    options: KisRestCurrentPriceIngestionOptions,
  ): Promise<KisRestTargetBuildResult> {
    const watchlist = buildKisWatchlist({
      domesticSymbols: options.domesticSymbols ?? config.kis.domesticSymbols,
      usSymbols: options.usSymbols ?? config.kis.usSymbols,
      maxSize: config.kis.maxWatchlistSize,
    });
    const targets: KisRestCurrentPriceTarget[] = [];
    const skipped: KisRestCurrentPriceSummary[] = [];

    for (const symbol of watchlist.domesticSymbols) {
      targets.push({
        kind: 'domestic',
        symbol,
        marketCode: 'KRX',
      });
    }

    for (const rawSymbol of watchlist.usSymbols) {
      const parsed = parseKisUsSymbolConfig(rawSymbol);
      if (parsed.state === 'invalid') {
        skipped.push({
          symbol: rawSymbol,
          sourceName: KIS_US_DELAYED_TRADE_SOURCE_NAME,
          state: 'skipped',
          assetId: null,
          price: null,
          effectiveAt: null,
          reason: parsed.reason,
        });
        continue;
      }

      if (parsed.state === 'explicit') {
        targets.push({
          kind: 'us',
          symbol: parsed.symbol,
          marketCode: parsed.marketCode,
        });
        continue;
      }

      const market = await this.resolveUsMarketCodeFromAsset(parsed.symbol);
      if (market.state === 'skipped') {
        skipped.push({
          symbol: parsed.symbol,
          sourceName: KIS_US_DELAYED_TRADE_SOURCE_NAME,
          state: 'skipped',
          assetId: null,
          price: null,
          effectiveAt: null,
          reason: market.reason,
        });
        continue;
      }

      targets.push({
        kind: 'us',
        symbol: parsed.symbol,
        marketCode: market.marketCode,
      });
    }

    return { targets, skipped };
  }

  private async buildPriceKrw(
    price: string,
    currencyCode: CurrencyCode,
    effectiveAt: Date,
  ): Promise<string | null> {
    const decimalPrice = new Prisma.Decimal(price);
    if (currencyCode === CurrencyCode.KRW) {
      return decimalPrice.toFixed(8);
    }

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

    return fxRate ? decimalPrice.mul(fxRate.rate).toFixed(8) : null;
  }

  private async findMappedAsset(
    quote: KisRestCurrentPriceQuote,
  ): Promise<KisAssetMapping> {
    if (quote.kind === 'domestic_krx_current_price') {
      return this.findMappedDomesticAsset(quote.symbol);
    }

    return this.findMappedUsAsset({
      symbol: quote.symbol,
      marketCode: quote.marketCode,
    });
  }

  private async findMappedDomesticAsset(
    symbol: string,
  ): Promise<KisAssetMapping> {
    const assets = await this.prisma.asset.findMany({
      where: {
        symbol,
      },
      select: {
        id: true,
        market: true,
        currencyCode: true,
        assetType: true,
        isActive: true,
      },
    });

    return selectDomesticAsset(assets);
  }

  private async findMappedUsAsset(input: {
    symbol: string;
    marketCode: string | null;
  }): Promise<KisAssetMapping> {
    const marketCode = normalizeKisUsMarketCode(input.marketCode);
    if (!marketCode) {
      return {
        state: 'skipped',
        reason: 'US_MARKET_NOT_ALLOWED',
      };
    }

    const assets = await this.prisma.asset.findMany({
      where: {
        symbol: input.symbol,
      },
      select: {
        id: true,
        market: true,
        currencyCode: true,
        assetType: true,
        isActive: true,
      },
    });

    return selectUsAsset(assets, marketCode);
  }

  private async resolveUsMarketCodeFromAsset(symbol: string): Promise<
    | {
        state: 'mapped';
        marketCode: KisUsMarketCode;
      }
    | {
        state: 'skipped';
        reason: string;
      }
  > {
    const assets = await this.prisma.asset.findMany({
      where: {
        symbol,
        currencyCode: CurrencyCode.USD,
        assetType: AssetType.us_stock,
        isActive: true,
      },
      select: {
        market: true,
      },
    });
    const markets = [
      ...new Set(
        assets
          .map((asset) => normalizeKisUsMarketCode(asset.market))
          .filter((market): market is KisUsMarketCode => Boolean(market)),
      ),
    ];

    if (markets.length === 0) {
      return {
        state: 'skipped',
        reason: 'ASSET_MARKET_MAPPING_NOT_FOUND',
      };
    }

    if (markets.length > 1) {
      return {
        state: 'skipped',
        reason: 'ASSET_MARKET_MAPPING_AMBIGUOUS',
      };
    }

    return {
      state: 'mapped',
      marketCode: markets[0],
    };
  }

  private async findDuplicateSnapshot(input: {
    assetId: string;
    parsed: KisRestCurrentPriceQuote;
    sourceName: string;
  }) {
    return this.prisma.assetPriceSnapshot.findFirst({
      where: {
        assetId: input.assetId,
        price: input.parsed.price,
        sourceType: AssetPriceSourceType.provider_api,
        sourceName: input.sourceName,
        effectiveAt: input.parsed.effectiveAt,
      },
      select: {
        id: true,
      },
    });
  }

  private async findRecentSnapshotWithinThrottle(input: {
    assetId: string;
    sourceName: string;
    receivedAt: Date;
    throttleMs: number;
  }) {
    const capturedAtGte = new Date(
      input.receivedAt.getTime() - input.throttleMs,
    );

    return this.prisma.assetPriceSnapshot.findFirst({
      where: {
        assetId: input.assetId,
        sourceType: AssetPriceSourceType.provider_api,
        sourceName: input.sourceName,
        capturedAt: {
          gte: capturedAtGte,
        },
      },
      orderBy: {
        capturedAt: 'desc',
      },
      select: {
        id: true,
      },
    });
  }
}

function assertKisRestIngestionEnabled(config: ProviderConfig): void {
  if (!config.common.providerIngestionEnabled) {
    throw new ProviderConfigError(
      'common',
      'PROVIDER_INGESTION_DISABLED',
      'Provider ingestion is disabled.',
    );
  }

  if (!config.kis.enabled) {
    throw new ProviderConfigError(
      'kis',
      'PROVIDER_DISABLED',
      'KIS market data provider is disabled.',
    );
  }

  if (!config.kis.restBaseUrl) {
    throw new ProviderConfigError(
      'kis',
      'KIS_REST_BASE_URL_MISSING',
      'KIS_REST_BASE_URL is required for KIS REST ingestion.',
    );
  }
}

function selectDomesticAsset(
  assets: readonly AssetMappingCandidate[],
): KisAssetMapping {
  if (assets.length === 0) {
    return skipped('ASSET_MAPPING_NOT_FOUND');
  }

  const active = assets.filter((asset) => asset.isActive);
  if (active.length === 0) {
    return skipped('ASSET_INACTIVE');
  }

  const typed = active.filter(
    (asset) => asset.assetType === AssetType.domestic_stock,
  );
  if (typed.length === 0) {
    return skipped('WRONG_ASSET_TYPE');
  }

  const currency = typed.filter(
    (asset) => asset.currencyCode === CurrencyCode.KRW,
  );
  if (currency.length === 0) {
    return skipped('WRONG_CURRENCY');
  }

  const market = currency.filter((asset) =>
    DOMESTIC_KRX_MARKETS.has(asset.market.trim().toUpperCase()),
  );
  if (market.length === 0) {
    return skipped('MARKET_NOT_ALLOWED');
  }

  if (market.length > 1) {
    return skipped('ASSET_MAPPING_AMBIGUOUS');
  }

  return {
    state: 'mapped',
    assetId: market[0].id,
  };
}

function selectUsAsset(
  assets: readonly AssetMappingCandidate[],
  marketCode: KisUsMarketCode,
): KisAssetMapping {
  if (assets.length === 0) {
    return skipped('ASSET_MAPPING_NOT_FOUND');
  }

  const active = assets.filter((asset) => asset.isActive);
  if (active.length === 0) {
    return skipped('ASSET_INACTIVE');
  }

  const typed = active.filter(
    (asset) => asset.assetType === AssetType.us_stock,
  );
  if (typed.length === 0) {
    return skipped('WRONG_ASSET_TYPE');
  }

  const currency = typed.filter(
    (asset) => asset.currencyCode === CurrencyCode.USD,
  );
  if (currency.length === 0) {
    return skipped('WRONG_CURRENCY');
  }

  const market = currency.filter(
    (asset) => normalizeKisUsMarketCode(asset.market) === marketCode,
  );
  if (market.length === 0) {
    return skipped('MARKET_NOT_ALLOWED');
  }

  if (market.length > 1) {
    return skipped('ASSET_MAPPING_AMBIGUOUS');
  }

  return {
    state: 'mapped',
    assetId: market[0].id,
  };
}

function skipped(reason: string): KisAssetMapping {
  return {
    state: 'skipped',
    reason,
  };
}

function skippedTarget(
  target: KisRestCurrentPriceTarget,
  reason: string,
): KisRestCurrentPriceSummary {
  return {
    symbol: target.symbol,
    sourceName: sourceNameForTarget(target),
    state: 'skipped',
    assetId: null,
    price: null,
    effectiveAt: null,
    reason,
  };
}

function sourceNameForQuote(
  quote: KisRestCurrentPriceQuote,
):
  | typeof KIS_DOMESTIC_TRADE_SOURCE_NAME
  | typeof KIS_US_DELAYED_TRADE_SOURCE_NAME {
  return quote.kind === 'domestic_krx_current_price'
    ? KIS_DOMESTIC_TRADE_SOURCE_NAME
    : KIS_US_DELAYED_TRADE_SOURCE_NAME;
}

function sourceNameForTarget(
  target: KisRestCurrentPriceTarget,
):
  | typeof KIS_DOMESTIC_TRADE_SOURCE_NAME
  | typeof KIS_US_DELAYED_TRADE_SOURCE_NAME {
  return target.kind === 'domestic'
    ? KIS_DOMESTIC_TRADE_SOURCE_NAME
    : KIS_US_DELAYED_TRADE_SOURCE_NAME;
}

function countAcceptedSnapshots(
  summaries: readonly KisRestCurrentPriceSummary[],
): number {
  return summaries.filter(
    (summary) =>
      summary.state === 'created' || summary.state === 'would_create',
  ).length;
}

function resultFromSummaries(input: {
  dryRun: boolean;
  received: number;
  summaries: KisRestCurrentPriceSummary[];
}): KisRestCurrentPriceIngestionResult {
  return {
    success: input.summaries.every((summary) => summary.state !== 'failed'),
    provider: 'kis',
    ingestion: 'rest_current_price',
    dryRun: input.dryRun,
    received: input.received,
    created: input.summaries.filter((summary) => summary.state === 'created')
      .length,
    skipped: input.summaries.filter((summary) => summary.state === 'skipped')
      .length,
    wouldCreate: input.summaries.filter(
      (summary) => summary.state === 'would_create',
    ).length,
    failed: input.summaries.filter((summary) => summary.state === 'failed')
      .length,
    snapshots: input.summaries,
  };
}

function failedResult(input: {
  dryRun: boolean;
  errorCode: string;
  errorMessage: string;
}): KisRestCurrentPriceIngestionResult {
  return {
    success: false,
    provider: 'kis',
    ingestion: 'rest_current_price',
    dryRun: input.dryRun,
    received: 0,
    created: 0,
    skipped: 0,
    wouldCreate: 0,
    failed: 1,
    snapshots: [],
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
  };
}

function buildKisProviderNote(requestedBy: string | undefined): string {
  const operator = requestedBy?.trim() || 'unknown';
  return `provider_api KIS REST current-price ingestion requested by ${operator}`;
}
