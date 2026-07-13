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
import { buildKisWatchlist } from './kis-watchlist.policy';
import {
  buildKisDomesticSubscriptionTarget,
  buildKisUsDelayedSubscriptionTarget,
  normalizeKisUsMarketCode,
  parseKisUsSymbolConfig,
  sourceNameForKisSubscriptionKind,
  type KisUsMarketCode,
} from './kis-websocket.subscription';
import {
  KIS_DOMESTIC_TRADE_SOURCE_NAME,
  KIS_US_DELAYED_TRADE_SOURCE_NAME,
  type KisSnapshotIngestionSummary,
  type KisWebSocketIngestionResult,
  type KisWebSocketParsedMessage,
  type KisWebSocketSubscriptionSkip,
  type KisWebSocketSubscriptionTarget,
  type KisWebSocketTradeTick,
} from './kis-websocket.types';

export type KisWebSocketIngestionOptions = {
  dryRun?: boolean;
  requestedBy?: string;
  maxSnapshots?: number;
  secrets?: readonly string[];
};

export type BuildKisWebSocketSubscriptionTargetsOptions = {
  domesticSymbols?: readonly string[];
  usSymbols?: readonly string[];
};

export type BuildKisWebSocketSubscriptionTargetsResult = {
  targets: KisWebSocketSubscriptionTarget[];
  skipped: KisWebSocketSubscriptionSkip[];
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

const DOMESTIC_KRX_MARKETS = new Set(['KRX', 'KOSPI', 'KOSDAQ', 'KONEX']);

@Injectable()
export class KisWebSocketIngestionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ProviderConfigService,
  ) {}

  async buildSubscriptionTargets(
    options: BuildKisWebSocketSubscriptionTargetsOptions = {},
  ): Promise<BuildKisWebSocketSubscriptionTargetsResult> {
    const config = this.configService.getConfig();
    const watchlist = buildKisWatchlist({
      domesticSymbols: options.domesticSymbols ?? config.kis.domesticSymbols,
      usSymbols: options.usSymbols ?? config.kis.usSymbols,
      maxSize: config.kis.maxWatchlistSize,
    });
    const targets: KisWebSocketSubscriptionTarget[] = [];
    const skipped: KisWebSocketSubscriptionSkip[] = [];

    for (const symbol of watchlist.domesticSymbols) {
      targets.push(
        buildKisDomesticSubscriptionTarget({
          symbol,
          trId: config.kis.wsDomesticTrId,
        }),
      );
    }

    if (!config.kis.wsAllowUsDelayed) {
      skipped.push(
        ...watchlist.usSymbols.map((symbol) => ({
          symbol,
          reason: 'KIS_US_DELAYED_DISABLED',
        })),
      );
      return { targets, skipped };
    }

    for (const rawSymbol of watchlist.usSymbols) {
      const parsed = parseKisUsSymbolConfig(rawSymbol);
      if (parsed.state === 'invalid') {
        skipped.push({
          symbol: rawSymbol,
          reason: parsed.reason,
        });
        continue;
      }

      if (parsed.state === 'explicit') {
        targets.push(
          buildKisUsDelayedSubscriptionTarget({
            symbol: parsed.symbol,
            marketCode: parsed.marketCode,
            trId: config.kis.wsOverseasDelayedTrId,
          }),
        );
        continue;
      }

      const market = await this.resolveUsMarketCodeFromAsset(parsed.symbol);
      if (market.state === 'skipped') {
        skipped.push({
          symbol: parsed.symbol,
          reason: market.reason,
        });
        continue;
      }

      targets.push(
        buildKisUsDelayedSubscriptionTarget({
          symbol: parsed.symbol,
          marketCode: market.marketCode,
          trId: config.kis.wsOverseasDelayedTrId,
        }),
      );
    }

    return { targets, skipped };
  }

  async ingestParsedMessage(
    message: KisWebSocketParsedMessage,
    options: KisWebSocketIngestionOptions = {},
  ): Promise<KisWebSocketIngestionResult> {
    if (message.state === 'ack' || message.state === 'heartbeat') {
      // PINGPONG heartbeats prove connection liveness only; they carry no
      // market data and must never count as trade-parse failures.
      return emptyKisIngestionResult({
        dryRun: Boolean(options.dryRun),
        received: 1,
        acknowledged: 1,
      });
    }

    if (message.state === 'skipped') {
      return resultFromSummaries({
        dryRun: Boolean(options.dryRun),
        received: 1,
        summaries: [
          {
            symbol: null,
            sourceName: null,
            state: 'skipped',
            assetId: null,
            price: null,
            effectiveAt: null,
            reason: message.reason,
          },
        ],
      });
    }

    if (message.state === 'failed') {
      return resultFromSummaries({
        dryRun: Boolean(options.dryRun),
        received: 1,
        summaries: [
          {
            symbol: null,
            sourceName: null,
            state: 'failed',
            assetId: null,
            price: null,
            effectiveAt: null,
            reason: message.reason,
          },
        ],
        success: false,
        errorCode: message.reason,
        errorMessage: message.message,
      });
    }

    return this.ingestTrades(message.trades, options);
  }

  async ingestTrades(
    trades: readonly KisWebSocketTradeTick[],
    options: KisWebSocketIngestionOptions = {},
  ): Promise<KisWebSocketIngestionResult> {
    const dryRun = Boolean(options.dryRun);
    try {
      const config = this.configService.getConfig();
      assertKisIngestionEnabled(config);

      const summaries: KisSnapshotIngestionSummary[] = [];
      const maxSnapshots = options.maxSnapshots;

      for (const trade of trades) {
        if (
          maxSnapshots !== undefined &&
          countAcceptedSnapshots(summaries) >= maxSnapshots
        ) {
          summaries.push({
            symbol: trade.symbol,
            sourceName: sourceNameForKisSubscriptionKind(trade.kind),
            state: 'skipped',
            assetId: null,
            price: trade.price,
            effectiveAt: effectiveAtForTrade(trade).toISOString(),
            reason: 'MAX_SNAPSHOTS_REACHED',
          });
          continue;
        }

        summaries.push(
          await this.ingestOneTrade({
            trade,
            dryRun,
            requestedBy: options.requestedBy,
            secrets: options.secrets,
            config,
          }),
        );
      }

      return resultFromSummaries({
        dryRun,
        received: trades.length,
        summaries,
      });
    } catch (error) {
      if (
        error instanceof ProviderConfigError ||
        error instanceof ProviderHttpError
      ) {
        return {
          success: false,
          provider: 'kis',
          dryRun,
          received: trades.length,
          acknowledged: 0,
          created: 0,
          skipped: 0,
          wouldCreate: 0,
          failed: 0,
          snapshots: [],
          errorCode: error.code,
          errorMessage: error.message,
        };
      }

      throw error;
    }
  }

  async ingestTrade(
    trade: KisWebSocketTradeTick,
    options: KisWebSocketIngestionOptions = {},
  ): Promise<KisSnapshotIngestionSummary> {
    const config = this.configService.getConfig();
    assertKisIngestionEnabled(config);

    return this.ingestOneTrade({
      trade,
      dryRun: Boolean(options.dryRun),
      requestedBy: options.requestedBy,
      secrets: options.secrets,
      config,
    });
  }

  private async ingestOneTrade(input: {
    trade: KisWebSocketTradeTick;
    dryRun: boolean;
    requestedBy?: string;
    secrets?: readonly string[];
    config: ProviderConfig;
  }): Promise<KisSnapshotIngestionSummary> {
    const sourceName = sourceNameForKisSubscriptionKind(input.trade.kind);
    const effectiveAt = effectiveAtForTrade(input.trade);
    const mapping = await this.findMappedAsset(input.trade);

    if (mapping.state === 'skipped') {
      return {
        symbol: input.trade.symbol,
        sourceName,
        state: 'skipped',
        assetId: null,
        price: input.trade.price,
        effectiveAt: effectiveAt.toISOString(),
        reason: mapping.reason,
      };
    }

    const duplicate = await this.findDuplicateSnapshot({
      assetId: mapping.assetId,
      trade: input.trade,
      sourceName,
      effectiveAt,
    });
    if (duplicate) {
      return {
        symbol: input.trade.symbol,
        sourceName,
        state: 'skipped',
        assetId: mapping.assetId,
        price: input.trade.price,
        effectiveAt: effectiveAt.toISOString(),
        reason: 'DUPLICATE_PROVIDER_SNAPSHOT',
      };
    }

    const throttled = await this.findRecentSnapshotWithinThrottle({
      assetId: mapping.assetId,
      sourceName,
      receivedAt: input.trade.receivedAt,
      throttleMs: input.config.kis.wsSnapshotThrottleMs,
    });
    if (throttled) {
      return {
        symbol: input.trade.symbol,
        sourceName,
        state: 'skipped',
        assetId: mapping.assetId,
        price: input.trade.price,
        effectiveAt: effectiveAt.toISOString(),
        reason: 'THROTTLED_PROVIDER_SNAPSHOT',
      };
    }

    if (input.dryRun) {
      return {
        symbol: input.trade.symbol,
        sourceName,
        state: 'would_create',
        assetId: mapping.assetId,
        price: input.trade.price,
        effectiveAt: effectiveAt.toISOString(),
      };
    }

    const rawPayloadJson = buildProviderRawPayloadJson({
      payload: {
        provider: 'kis',
        messageType: 'websocket_trade',
        trId: input.trade.trId,
        rawFrame: input.trade.rawFrame,
        rawFields: input.trade.rawFields,
        recordIndex: input.trade.recordIndex,
      },
      maxBytes: input.config.common.rawPayloadMaxBytes,
      secrets: [
        input.config.kis.appKey,
        input.config.kis.appSecret,
        ...(input.secrets ?? []),
      ].filter((secret): secret is string => Boolean(secret)),
    });

    const currencyCode =
      input.trade.kind === 'domestic_krx_realtime_trade'
        ? CurrencyCode.KRW
        : CurrencyCode.USD;
    await this.prisma.assetPriceSnapshot.create({
      data: {
        assetId: mapping.assetId,
        price: input.trade.price,
        priceKrw: await this.buildPriceKrw(
          input.trade.price,
          currencyCode,
          effectiveAt,
        ),
        currencyCode,
        sourceType: AssetPriceSourceType.provider_api,
        sourceName,
        sourceTimestamp: input.trade.sourceTimestamp,
        effectiveAt,
        capturedAt: input.trade.receivedAt,
        rawPayloadJson: rawPayloadJson as Prisma.InputJsonValue,
        note: buildKisProviderNote(input.requestedBy),
      },
      select: {
        id: true,
      },
    });

    return {
      symbol: input.trade.symbol,
      sourceName,
      state: 'created',
      assetId: mapping.assetId,
      price: input.trade.price,
      effectiveAt: effectiveAt.toISOString(),
    };
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
    trade: KisWebSocketTradeTick,
  ): Promise<KisAssetMapping> {
    if (trade.kind === 'domestic_krx_realtime_trade') {
      return this.findMappedDomesticAsset(trade.symbol);
    }

    return this.findMappedUsAsset({
      symbol: trade.symbol,
      marketCode: trade.marketCode,
    });
  }

  private async findMappedDomesticAsset(
    symbol: string,
  ): Promise<KisAssetMapping> {
    const assets = await this.prisma.asset.findMany({
      where: {
        symbol,
        currencyCode: CurrencyCode.KRW,
        assetType: AssetType.domestic_stock,
        isActive: true,
      },
      select: {
        id: true,
        market: true,
      },
    });
    const krxAssets = assets.filter((asset) =>
      DOMESTIC_KRX_MARKETS.has(asset.market.trim().toUpperCase()),
    );

    if (krxAssets.length === 0) {
      return {
        state: 'skipped',
        reason: 'ASSET_MAPPING_NOT_FOUND',
      };
    }

    if (krxAssets.length > 1) {
      return {
        state: 'skipped',
        reason: 'ASSET_MAPPING_AMBIGUOUS',
      };
    }

    return {
      state: 'mapped',
      assetId: krxAssets[0].id,
    };
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
        currencyCode: CurrencyCode.USD,
        assetType: AssetType.us_stock,
        isActive: true,
      },
      select: {
        id: true,
        market: true,
      },
    });
    const mappedAssets = assets.filter(
      (asset) => normalizeKisUsMarketCode(asset.market) === marketCode,
    );

    if (mappedAssets.length === 0) {
      return {
        state: 'skipped',
        reason: 'ASSET_MAPPING_NOT_FOUND',
      };
    }

    if (mappedAssets.length > 1) {
      return {
        state: 'skipped',
        reason: 'ASSET_MAPPING_AMBIGUOUS',
      };
    }

    return {
      state: 'mapped',
      assetId: mappedAssets[0].id,
    };
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
    trade: KisWebSocketTradeTick;
    sourceName: string;
    effectiveAt: Date;
  }) {
    return this.prisma.assetPriceSnapshot.findFirst({
      where: {
        assetId: input.assetId,
        price: input.trade.price,
        sourceType: AssetPriceSourceType.provider_api,
        sourceName: input.sourceName,
        effectiveAt: input.effectiveAt,
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

function assertKisIngestionEnabled(config: ProviderConfig): void {
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
}

function effectiveAtForTrade(trade: KisWebSocketTradeTick): Date {
  return trade.sourceTimestamp ?? trade.receivedAt;
}

function countAcceptedSnapshots(
  summaries: readonly KisSnapshotIngestionSummary[],
): number {
  return summaries.filter(
    (summary) =>
      summary.state === 'created' || summary.state === 'would_create',
  ).length;
}

function resultFromSummaries(input: {
  dryRun: boolean;
  received: number;
  summaries: KisSnapshotIngestionSummary[];
  success?: boolean;
  errorCode?: string;
  errorMessage?: string;
}): KisWebSocketIngestionResult {
  return {
    success:
      input.success ??
      input.summaries.every((summary) => summary.state !== 'failed'),
    provider: 'kis',
    dryRun: input.dryRun,
    received: input.received,
    acknowledged: 0,
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
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
  };
}

function emptyKisIngestionResult(input: {
  dryRun: boolean;
  received: number;
  acknowledged: number;
}): KisWebSocketIngestionResult {
  return {
    success: true,
    provider: 'kis',
    dryRun: input.dryRun,
    received: input.received,
    acknowledged: input.acknowledged,
    created: 0,
    skipped: 0,
    wouldCreate: 0,
    failed: 0,
    snapshots: [],
  };
}

function buildKisProviderNote(requestedBy: string | undefined): string {
  const operator = requestedBy?.trim() || 'unknown';
  return `provider_api KIS WebSocket trade ingestion requested by ${operator}`;
}

export function sourceNameForKisTrade(
  trade: KisWebSocketTradeTick,
):
  | typeof KIS_DOMESTIC_TRADE_SOURCE_NAME
  | typeof KIS_US_DELAYED_TRADE_SOURCE_NAME {
  return trade.kind === 'domestic_krx_realtime_trade'
    ? KIS_DOMESTIC_TRADE_SOURCE_NAME
    : KIS_US_DELAYED_TRADE_SOURCE_NAME;
}
