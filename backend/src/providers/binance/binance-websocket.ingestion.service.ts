import { SPOT_ASSET_WHERE } from './binance-product-catalog';
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

/** Activation changes made by the admin tools apply within this long. */
const ASSET_MAPPING_TTL_MS = 30_000;
/** `price_krw` is display-only; the USD/KRW rate behind it may be this old. */
const FX_RATE_TTL_MS = 60_000;
/** An event time this far past receipt is a broken frame or clock. Readers
 * already refuse a row whose effective_at is in their future. */
const MAX_FUTURE_EVENT_MS = 5_000;
/** Ticker fields a slim raw payload keeps: identity, price and time evidence
 * and the 24 h statistics (`q` is the asset-list turnover sort). Bid/ask,
 * trade ids, weighted average and derived change fields are dropped; the
 * columns hold the price and both times. */
export const BINANCE_TICKER_SLIM_FIELDS = [
  'e',
  'E',
  's',
  'c',
  'o',
  'h',
  'l',
  'v',
  'q',
  'O',
  'C',
] as const;

type StoredTicker = {
  capturedAtMs: number;
  effectiveAtMs: number;
  price: string;
};

/**
 * Ticker → asset_price_snapshots. The throttle, duplicate and order decisions
 * use this process's record of the last row PostgreSQL stored per asset
 * (read once per asset after a start, then kept current after each successful
 * INSERT), so a frame costs no SELECT. Only a stored row is evidence: readers
 * re-check every row's freshness, and a failed INSERT changes nothing here.
 * With two writers (a deploy overlap) each throttles itself; at most one extra
 * row per 5 s results.
 */
@Injectable()
export class BinanceWebSocketIngestionService {
  private readonly mappings = new Map<
    string,
    { mapping: BinanceAssetMapping; expiresAt: number }
  >();
  private readonly lastStored = new Map<string, StoredTicker | null>();
  /** Assets with a decision or INSERT under way: frames are not serialized. */
  private readonly inFlight = new Set<string>();
  private fx: {
    rate: Prisma.Decimal | null;
    effectiveAtMs: number | null;
    fetchedAt: number;
  } | null = null;

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

    const assetId = mapping.assetId;
    const effectiveAtMs = input.ticker.effectiveAt.getTime();
    const receivedAtMs = input.ticker.receivedAt.getTime();
    const skip = (reason: string): BinanceWebSocketTickerSummary => ({
      symbol: input.ticker.providerSymbol,
      state: 'skipped',
      assetId,
      price: input.ticker.price,
      effectiveAt: input.ticker.effectiveAt.toISOString(),
      reason,
    });
    if (effectiveAtMs > receivedAtMs + MAX_FUTURE_EVENT_MS)
      return skip('FUTURE_PROVIDER_SNAPSHOT');
    // A row for this asset is being decided or written: this frame is inside
    // that row's throttle window.
    if (this.inFlight.has(assetId)) return skip('THROTTLED_PROVIDER_SNAPSHOT');
    this.inFlight.add(assetId);
    try {
      const last = await this.lastStoredTicker(assetId);
      if (
        last &&
        last.effectiveAtMs === effectiveAtMs &&
        last.price === input.ticker.price
      )
        return skip('DUPLICATE_PROVIDER_SNAPSHOT');
      if (last && effectiveAtMs < last.effectiveAtMs)
        return skip('OUT_OF_ORDER_PROVIDER_SNAPSHOT');
      if (
        last &&
        receivedAtMs - last.capturedAtMs <=
          Math.max(0, input.config.binance.wsSnapshotThrottleMs)
      )
        return skip('THROTTLED_PROVIDER_SNAPSHOT');

      if (input.dryRun) {
        return {
          symbol: input.ticker.providerSymbol,
          state: 'would_create',
          assetId,
          price: input.ticker.price,
          effectiveAt: input.ticker.effectiveAt.toISOString(),
        };
      }

      const slim = input.config.binance.wsRawSlimEnabled;
      const rawPayloadJson = buildProviderRawPayloadJson({
        payload: {
          provider: 'binance',
          messageType: 'spot_ws_ticker',
          streamName: input.ticker.streamName,
          ...(slim
            ? {
                payloadProfile: 'binance_ticker_slim_v1',
                // The writer path, kept here instead of the repeated note.
                requestedBy: input.requestedBy?.trim() || null,
                payload: slimTickerPayload(input.ticker.rawPayload),
              }
            : { payload: input.ticker.rawPayload }),
        },
        maxBytes: input.config.common.rawPayloadMaxBytes,
      });

      await this.prisma.assetPriceSnapshot.create({
        data: {
          assetId,
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
          note: slim ? null : buildProviderNote(input.requestedBy),
        },
        select: {
          id: true,
        },
      });
      this.lastStored.set(assetId, {
        capturedAtMs: receivedAtMs,
        effectiveAtMs,
        price: input.ticker.price,
      });

      return {
        symbol: input.ticker.providerSymbol,
        state: 'created',
        assetId,
        price: input.ticker.price,
        effectiveAt: input.ticker.effectiveAt.toISOString(),
      };
    } finally {
      this.inFlight.delete(assetId);
    }
  }

  /** The newest stored WS row of the asset: memory, or one read after start. */
  private async lastStoredTicker(
    assetId: string,
  ): Promise<StoredTicker | null> {
    const known = this.lastStored.get(assetId);
    if (known !== undefined) return known;
    const row = await this.prisma.assetPriceSnapshot.findFirst({
      where: {
        assetId,
        currencyCode: CurrencyCode.USD,
        sourceType: AssetPriceSourceType.provider_api,
        sourceName: BINANCE_SPOT_WS_TICKER_SOURCE_NAME,
      },
      orderBy: { capturedAt: 'desc' },
      select: { capturedAt: true, effectiveAt: true, price: true },
    });
    const stored = row
      ? {
          capturedAtMs: row.capturedAt.getTime(),
          effectiveAtMs: row.effectiveAt.getTime(),
          price: new Prisma.Decimal(row.price).toFixed(8),
        }
      : null;
    this.lastStored.set(assetId, stored);
    return stored;
  }

  private async findMappedAsset(input: {
    providerSymbol: string;
    baseSymbol: string;
  }): Promise<BinanceAssetMapping> {
    const key = `${input.providerSymbol}|${input.baseSymbol}`;
    const now = Date.now();
    const cached = this.mappings.get(key);
    if (cached && now < cached.expiresAt) return cached.mapping;
    const mapping = await this.readMappedAsset(input);
    this.mappings.set(key, { mapping, expiresAt: now + ASSET_MAPPING_TTL_MS });
    return mapping;
  }

  private async readMappedAsset(input: {
    providerSymbol: string;
    baseSymbol: string;
  }): Promise<BinanceAssetMapping> {
    const candidateSymbols =
      input.providerSymbol === input.baseSymbol
        ? [input.providerSymbol]
        : [input.providerSymbol, input.baseSymbol];
    const assets = await this.prisma.asset.findMany({
      where: {
        ...SPOT_ASSET_WHERE,
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

  private async buildPriceKrw(
    price: string,
    effectiveAt: Date,
  ): Promise<string | null> {
    if (!this.prisma.fxRateSnapshot) {
      return null;
    }

    const now = Date.now();
    if (
      !this.fx ||
      now - this.fx.fetchedAt > FX_RATE_TTL_MS ||
      (this.fx.effectiveAtMs !== null &&
        this.fx.effectiveAtMs > effectiveAt.getTime())
    ) {
      const row = await this.readUsdKrwRate(effectiveAt);
      this.fx = {
        rate: row?.rate ?? null,
        effectiveAtMs: row?.effectiveAt.getTime() ?? null,
        fetchedAt: now,
      };
    }
    return this.fx.rate
      ? new Prisma.Decimal(price).mul(this.fx.rate).toFixed(8)
      : null;
  }

  private readUsdKrwRate(effectiveAt: Date) {
    return this.prisma.fxRateSnapshot.findFirst({
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
        effectiveAt: true,
      },
    });
  }
}

/** The ticker object of a frame (combined-stream `data`, or the frame), kept
 * flat: the turnover reader accepts a flat ticker, and the stream name is
 * already the payload's `streamName`. */
function slimTickerPayload(raw: unknown): Record<string, unknown> {
  const frame =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const data = frame.data;
  const ticker =
    'data' in frame && data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : frame;
  return Object.fromEntries(
    BINANCE_TICKER_SLIM_FIELDS.filter((field) => field in ticker).map(
      (field) => [field, ticker[field]],
    ),
  );
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
