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
import {
  BINANCE_MARKET,
  BINANCE_SPOT_WS_TICKER_SOURCE_NAME,
  parseBinanceUsdEquivalentSymbol,
} from './binance-price.ingestion.service';
import type {
  BinanceWebSocketIngestionResult,
  BinanceWebSocketParsedMessage,
  BinanceWebSocketTicker,
  BinanceWebSocketTickerSummary,
} from './binance-websocket.types';

type BinanceAssetMapping =
  | {
      state: 'mapped';
      assetId: string;
    }
  | {
      state: 'skipped';
      reason: string;
    };

export type BinanceWebSocketIngestionOptions = {
  dryRun?: boolean;
  requestedBy?: string;
};

@Injectable()
export class BinanceWebSocketIngestionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ProviderConfigService,
  ) {}

  async ingestParsedMessage(
    message: BinanceWebSocketParsedMessage,
    options: BinanceWebSocketIngestionOptions = {},
  ): Promise<BinanceWebSocketIngestionResult> {
    const dryRun = Boolean(options.dryRun);
    if (message.state === 'ack' || message.state === 'server_shutdown') {
      return resultFromSummaries({
        dryRun,
        received: 0,
        summaries: [],
      });
    }

    if (message.state === 'skipped') {
      return resultFromSummaries({
        dryRun,
        received: 0,
        summaries: [
          {
            symbol: null,
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
        dryRun,
        received: 0,
        summaries: [
          {
            symbol: null,
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

    return this.ingestTicker(message.ticker, options);
  }

  async ingestTicker(
    ticker: BinanceWebSocketTicker,
    options: BinanceWebSocketIngestionOptions = {},
  ): Promise<BinanceWebSocketIngestionResult> {
    const dryRun = Boolean(options.dryRun);
    try {
      const config = this.configService.getConfig();
      assertBinanceWebSocketIngestionEnabled(config);

      const summary = await this.ingestOneTicker({
        ticker,
        dryRun,
        requestedBy: options.requestedBy,
        config,
      });

      return resultFromSummaries({
        dryRun,
        received: 1,
        summaries: [summary],
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
          received: 1,
          created: 0,
          skipped: 0,
          wouldCreate: 0,
          failed: 0,
          tickers: [],
          errorCode: error.code,
          errorMessage: error.message,
        };
      }

      throw error;
    }
  }

  private async ingestOneTicker(input: {
    ticker: BinanceWebSocketTicker;
    dryRun: boolean;
    requestedBy?: string;
    config: ProviderConfig;
  }): Promise<BinanceWebSocketTickerSummary> {
    const symbolPolicy = parseBinanceUsdEquivalentSymbol(
      input.ticker.providerSymbol,
      input.config.binance.usdtAsUsdEquivalent,
    );
    if (!symbolPolicy.supported) {
      return skipped(input.ticker, symbolPolicy.reason);
    }

    const mapping = await this.findMappedAsset({
      providerSymbol: symbolPolicy.providerSymbol,
      baseSymbol: symbolPolicy.baseSymbol,
    });
    if (mapping.state === 'skipped') {
      return skipped(input.ticker, mapping.reason);
    }

    const duplicate = await this.findDuplicateSnapshot({
      assetId: mapping.assetId,
      ticker: input.ticker,
    });
    if (duplicate) {
      return {
        symbol: input.ticker.providerSymbol,
        state: 'skipped',
        assetId: mapping.assetId,
        price: input.ticker.price,
        effectiveAt: input.ticker.effectiveAt.toISOString(),
        reason: 'DUPLICATE_PROVIDER_SNAPSHOT',
      };
    }

    const throttled = await this.findRecentSnapshotWithinThrottle({
      assetId: mapping.assetId,
      receivedAt: input.ticker.receivedAt,
      throttleMs: input.config.binance.wsSnapshotThrottleMs,
    });
    if (throttled) {
      return {
        symbol: input.ticker.providerSymbol,
        state: 'skipped',
        assetId: mapping.assetId,
        price: input.ticker.price,
        effectiveAt: input.ticker.effectiveAt.toISOString(),
        reason: 'THROTTLED_PROVIDER_SNAPSHOT',
      };
    }

    if (input.dryRun) {
      return {
        symbol: input.ticker.providerSymbol,
        state: 'would_create',
        assetId: mapping.assetId,
        price: input.ticker.price,
        effectiveAt: input.ticker.effectiveAt.toISOString(),
      };
    }

    const rawPayloadJson = buildProviderRawPayloadJson({
      payload: {
        provider: 'binance',
        messageType: 'spot_ws_ticker',
        streamName: input.ticker.streamName,
        payload: input.ticker.rawPayload,
      },
      maxBytes: input.config.common.rawPayloadMaxBytes,
    });

    await this.prisma.assetPriceSnapshot.create({
      data: {
        assetId: mapping.assetId,
        price: input.ticker.price,
        priceKrw: await this.buildPriceKrw(
          input.ticker.price,
          input.ticker.effectiveAt,
        ),
        currencyCode: CurrencyCode.USD,
        sourceType: AssetPriceSourceType.provider_api,
        sourceName: BINANCE_SPOT_WS_TICKER_SOURCE_NAME,
        sourceTimestamp: input.ticker.sourceTimestamp,
        effectiveAt: input.ticker.effectiveAt,
        capturedAt: input.ticker.receivedAt,
        rawPayloadJson: rawPayloadJson as Prisma.InputJsonValue,
        note: buildProviderNote(input.requestedBy),
      },
      select: {
        id: true,
      },
    });

    return {
      symbol: input.ticker.providerSymbol,
      state: 'created',
      assetId: mapping.assetId,
      price: input.ticker.price,
      effectiveAt: input.ticker.effectiveAt.toISOString(),
    };
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
    ticker: BinanceWebSocketTicker;
  }) {
    return this.prisma.assetPriceSnapshot.findFirst({
      where: {
        assetId: input.assetId,
        price: input.ticker.price,
        currencyCode: CurrencyCode.USD,
        sourceType: AssetPriceSourceType.provider_api,
        sourceName: BINANCE_SPOT_WS_TICKER_SOURCE_NAME,
        effectiveAt: input.ticker.effectiveAt,
      },
      select: {
        id: true,
      },
    });
  }

  private async findRecentSnapshotWithinThrottle(input: {
    assetId: string;
    receivedAt: Date;
    throttleMs: number;
  }) {
    const capturedAtGte = new Date(
      input.receivedAt.getTime() - Math.max(0, input.throttleMs),
    );

    return this.prisma.assetPriceSnapshot.findFirst({
      where: {
        assetId: input.assetId,
        currencyCode: CurrencyCode.USD,
        sourceType: AssetPriceSourceType.provider_api,
        sourceName: BINANCE_SPOT_WS_TICKER_SOURCE_NAME,
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

    return fxRate
      ? new Prisma.Decimal(price).mul(fxRate.rate).toFixed(8)
      : null;
  }
}

function assertBinanceWebSocketIngestionEnabled(config: ProviderConfig): void {
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
}

function skipped(
  ticker: BinanceWebSocketTicker,
  reason: string,
): BinanceWebSocketTickerSummary {
  return {
    symbol: ticker.providerSymbol,
    state: 'skipped',
    assetId: null,
    price: ticker.price,
    effectiveAt: ticker.effectiveAt.toISOString(),
    reason,
  };
}

function resultFromSummaries(input: {
  dryRun: boolean;
  received: number;
  summaries: BinanceWebSocketTickerSummary[];
  success?: boolean;
  errorCode?: string;
  errorMessage?: string;
}): BinanceWebSocketIngestionResult {
  return {
    success:
      input.success ??
      input.summaries.every((summary) => summary.state !== 'failed'),
    provider: 'binance',
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
    tickers: input.summaries,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
  };
}

function buildProviderNote(requestedBy: string | undefined): string {
  const operator = requestedBy?.trim();
  return operator
    ? `provider_api Binance WebSocket ticker ingestion requested by ${operator}`
    : 'provider_api Binance WebSocket ticker ingestion';
}
