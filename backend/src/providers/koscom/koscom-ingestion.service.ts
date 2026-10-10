import { Injectable } from '@nestjs/common';
import { projectOpsFailure } from '../../ops/ops-failure';
import {
  AssetPriceSourceType,
  AssetType,
  CurrencyCode,
  Prisma,
} from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisLockService } from '../../redis/redis-lock.service';
import { RedisService } from '../../redis/redis.service';
import { resolveStockMarketSessionState } from '../../orders/market-calendar.policy';
import { buildProviderRawPayloadJson } from '../provider-raw-payload';
import { PROVIDER_PRICE_PUBSUB_CHANNEL } from '../fx-rate-update-event';
import {
  MarketPriceEventService,
  type MarketPriceEvent,
} from '../market-price-event.service';
import {
  KoscomClient,
  koscomBatches,
  type KoscomTarget,
} from './koscom.client';
import {
  KOSCOM_PRICE_SOURCE,
  KOSCOM_BOOK_SOURCE,
  KoscomConfigService,
  KoscomError,
  koscomFailure,
} from './koscom.config';
import { KoscomMarketMapService } from './koscom-market-map.service';
import {
  normalizeKoscomOrderbook,
  normalizeKoscomPrice,
} from './koscom-normalizer';
import { ohlcv } from './koscom-candle.adapter';
import { MarketSnapshotHealthService } from '../market-snapshot-health.service';

type SnapshotSummary = {
  assetId: string | null;
  symbol: string | null;
  kind: string;
  state: 'created' | 'would_create' | 'skipped' | 'failed';
  reason?: string;
};
export type KoscomIngestionOptions = {
  dryRun?: boolean;
  symbols?: readonly string[];
  maxSnapshots?: number;
  now?: Date;
  onPrice?: (event: MarketPriceEvent) => void | Promise<void>;
};

@Injectable()
export class KoscomIngestionService {
  private pending: Promise<ReturnType<typeof summary>> | null = null;
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: KoscomConfigService,
    private readonly client: KoscomClient,
    private readonly markets: KoscomMarketMapService,
    private readonly locks: RedisLockService,
    private readonly redis: RedisService,
    private readonly events: MarketPriceEventService,
    private readonly health: MarketSnapshotHealthService,
  ) {}

  collect(options: KoscomIngestionOptions = {}) {
    // Manual and scheduler work share the same lease; never join different dryRun commands.
    if (this.pending)
      return Promise.resolve(
        summary(Boolean(options.dryRun), [], 'KOSCOM_COLLECTION_BUSY'),
      );
    this.pending = this.run(options)
      .catch((error) =>
        summary(Boolean(options.dryRun), [], koscomFailure(error)),
      )
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  private async run(options: KoscomIngestionOptions) {
    const dryRun = Boolean(options.dryRun);
    const config = this.config.getConfig();
    if (!config.enabled) return summary(dryRun, [], 'KOSCOM_DISABLED');
    const now = options.now ?? new Date();
    const state = resolveStockMarketSessionState(
      { assetType: AssetType.domestic_stock, market: 'KRX' },
      now,
    );
    if (state?.state === 'closed') {
      const session = state.currentSession;
      if (
        session &&
        state.latestCompletedSession?.localDate === session.localDate &&
        session.closeTime <= now
      )
        return this.recoverClose(options, session);
      return summary(dryRun, [], 'MARKET_CLOSED_EXPECTED_NO_DATA');
    }
    if (state?.state !== 'open')
      return summary(dryRun, [], 'MARKET_CALENDAR_COVERAGE_MISSING');
    const acquired = await this.locks.acquire(
      `koscom:${config.namespace}:ingestion`,
      60000,
    );
    if (acquired.status !== 'acquired')
      return summary(
        dryRun,
        [],
        acquired.status === 'busy'
          ? 'KOSCOM_COLLECTION_BUSY'
          : 'KOSCOM_COORDINATION_UNAVAILABLE',
      );
    let owned = true;
    const timer = setInterval(() => {
      void this.locks
        .extend(acquired.lock)
        .then((ok) => {
          if (!ok) owned = false;
        })
        .catch(() => {
          owned = false;
        });
    }, 15000);
    timer.unref?.();
    const snapshots: SnapshotSummary[] = [];
    try {
      const assets = await this.prisma.asset.findMany({
        where: {
          assetType: AssetType.domestic_stock,
          currencyCode: CurrencyCode.KRW,
          isActive: true,
          ...(options.symbols ? { symbol: { in: [...options.symbols] } } : {}),
        },
        select: { id: true, symbol: true, market: true },
      });
      const targets: KoscomTarget[] = [];
      for (const asset of assets) {
        try {
          if (assets.filter((a) => a.symbol === asset.symbol).length !== 1)
            throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
              'KOSCOM_ASSET_AMBIGUOUS',
            );
          targets.push({
            assetId: asset.id,
            symbol: asset.symbol,
            market: await this.markets.resolve(asset.symbol, asset.market),
          });
        } catch (error) {
          snapshots.push({
            assetId: asset.id,
            symbol: asset.symbol,
            kind: 'mapping',
            state: 'failed',
            reason: koscomFailure(error),
          });
        }
      }
      const work = koscomBatches(targets).flatMap((batch) =>
        (['price', 'orderbook'] as const).map((kind) => ({ batch, kind })),
      );
      let next = 0;
      let accepted = 0;
      await Promise.all(
        Array.from(
          { length: Math.min(config.concurrency, work.length) },
          async () => {
            while (next < work.length && owned) {
              const { batch, kind } = work[next++];
              try {
                const response = await this.client.batch(batch, kind);
                for (const target of batch.targets) {
                  if (!owned)
                    throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
                      'KOSCOM_LOCK_LOST',
                    );
                  const matches = response.rows.filter(
                    (r) => r.isuSrtCd === target.symbol,
                  );
                  if (matches.length !== 1) {
                    snapshots.push({
                      ...target,
                      kind,
                      state: 'failed',
                      reason: matches.length
                        ? 'KOSCOM_DUPLICATE_SYMBOL'
                        : 'KOSCOM_MISSING_SYMBOL',
                    });
                    continue;
                  }
                  if (
                    options.maxSnapshots !== undefined &&
                    accepted >= options.maxSnapshots
                  ) {
                    snapshots.push({
                      ...target,
                      kind,
                      state: 'skipped',
                      reason: 'MAX_SNAPSHOTS_REACHED',
                    });
                    continue;
                  }
                  // Reserve before await so parallel batches cannot exceed the cap.
                  accepted++;
                  try {
                    const result = await this.persist(
                      target,
                      kind,
                      matches[0],
                      response.receivedAt,
                      dryRun,
                      async () => {
                        if (!owned) return false;
                        if (!(await this.locks.extend(acquired.lock)))
                          owned = false;
                        return owned;
                      },
                      options.onPrice,
                    );
                    snapshots.push({ ...target, kind, ...result });
                  } catch (error) {
                    snapshots.push({
                      ...target,
                      kind,
                      state: 'failed',
                      reason: koscomFailure(error),
                    });
                  }
                }
              } catch (error) {
                snapshots.push(
                  ...batch.targets.map((t) => ({
                    ...t,
                    kind,
                    state: 'failed' as const,
                    reason: koscomFailure(error),
                  })),
                );
              }
            }
          },
        ),
      );
      if (!owned) return summary(dryRun, snapshots, 'KOSCOM_LOCK_LOST');
      return summary(dryRun, snapshots);
    } catch (error) {
      return summary(dryRun, snapshots, koscomFailure(error));
    } finally {
      clearInterval(timer);
      await this.locks.release(acquired.lock);
    }
  }

  private async persist(
    target: KoscomTarget,
    kind: 'price' | 'orderbook',
    row: Record<string, unknown>,
    receivedAt: Date,
    dryRun: boolean,
    owned: () => Promise<boolean>,
    onPrice?: KoscomIngestionOptions['onPrice'],
  ): Promise<Pick<SnapshotSummary, 'state' | 'reason'>> {
    if (kind === 'price') {
      const price = normalizeKoscomPrice(row, receivedAt);
      const latest = await this.prisma.assetPriceSnapshot.findFirst({
        where: {
          assetId: target.assetId,
          sourceType: AssetPriceSourceType.provider_api,
          sourceName: KOSCOM_PRICE_SOURCE,
        },
        orderBy: [{ effectiveAt: 'desc' }, { capturedAt: 'desc' }],
        select: { effectiveAt: true },
      });
      if (latest && latest.effectiveAt >= price.effectiveAt)
        return { state: 'skipped', reason: 'KOSCOM_DUPLICATE_OR_OLDER_PRICE' };
      if (dryRun) return { state: 'would_create' };
      if (!(await owned()))
        throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
          'KOSCOM_LOCK_LOST',
        );
      await this.prisma.assetPriceSnapshot.create({
        data: {
          assetId: target.assetId,
          price: price.price,
          priceKrw: price.price,
          currencyCode: CurrencyCode.KRW,
          sourceType: AssetPriceSourceType.provider_api,
          sourceName: KOSCOM_PRICE_SOURCE,
          sourceTimestamp: price.effectiveAt,
          effectiveAt: price.effectiveAt,
          capturedAt: receivedAt,
          rawPayloadJson: this.raw({
            messageType: 'rest_current_price',
            row,
            market: target.market,
            dateBasis: row.trdDd ? 'provider' : 'receipt_session',
            changeRate: price.changeRate,
          }),
        },
      });
      if (!(await owned())) return { state: 'created' };
      const event: MarketPriceEvent = {
        type: 'market_price',
        assetId: target.assetId,
        price: {
          price: price.price,
          currencyCode: 'KRW',
          sourceName: KOSCOM_PRICE_SOURCE,
          effectiveAt: price.effectiveAt.toISOString(),
          capturedAt: receivedAt.toISOString(),
        },
        delayed: false,
        snapshotState: 'created',
        ...(price.topOfBook ? { topOfBook: price.topOfBook } : {}),
      };
      // Redis is the app's existing multi-instance channel. Local fallback is
      // only for a publish failure; successful publication is not sent twice.
      try {
        await this.redis.publish(
          PROVIDER_PRICE_PUBSUB_CHANNEL,
          JSON.stringify(event),
        );
      } catch {
        this.events.publish(event);
      }
      try {
        await onPrice?.(event);
      } catch {
        // Optional local observers cannot undo a durable price snapshot.
      }
      return { state: 'created' };
    }
    const state = resolveStockMarketSessionState(
      { assetType: AssetType.domestic_stock, market: 'KRX' },
      receivedAt,
    );
    if (state?.state !== 'open')
      throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
        'KOSCOM_OUTSIDE_SESSION',
      );
    const book = normalizeKoscomOrderbook(row);
    // v3 orderbook has no documented provider clock: receipt is not a trade timestamp.
    if (dryRun) return { state: 'would_create' };
    if (!(await owned()))
      throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
        'KOSCOM_LOCK_LOST',
      );
    await this.prisma.assetOrderbookSnapshot.create({
      data: {
        assetId: target.assetId,
        sourceType: AssetPriceSourceType.provider_api,
        sourceName: KOSCOM_BOOK_SOURCE,
        bidPrice: book.bids[0].price,
        bidQuantity: book.bids[0].quantity,
        askPrice: book.asks[0].price,
        askQuantity: book.asks[0].quantity,
        spreadBps: book.spreadBps,
        currencyCode: CurrencyCode.KRW,
        effectiveAt: receivedAt,
        capturedAt: receivedAt,
        rawPayloadJson: this.raw({
          messageType: 'rest_hoga',
          row,
          book,
          market: target.market,
          timestampBasis: 'receipt',
        }),
      },
    });
    return { state: 'created' };
  }

  private raw(payload: Record<string, unknown>): Prisma.InputJsonValue {
    return buildProviderRawPayloadJson({
      payload: { provider: 'koscom', ...payload },
      maxBytes: 32000,
      secrets: [this.config.getConfig().apiKey],
    }) as Prisma.InputJsonValue;
  }

  private async recoverClose(
    options: KoscomIngestionOptions,
    session: { localDate: string; openTime: Date; closeTime: Date },
  ) {
    const config = this.config.getConfig(),
      dryRun = Boolean(options.dryRun);
    const key = `koscom:${config.namespace}:close:${session.localDate}`;
    if (!dryRun && (await this.redis.get(key).catch(() => null)))
      return summary(dryRun, [], 'KOSCOM_CLOSE_ALREADY_CHECKED');
    const acquired = await this.locks.acquire(
      `koscom:${config.namespace}:ingestion`,
      60000,
    );
    if (acquired.status !== 'acquired')
      return summary(dryRun, [], 'KOSCOM_COLLECTION_BUSY');
    const snapshots: SnapshotSummary[] = [];
    try {
      const now = options.now ?? new Date();
      const before = await this.health.checkActiveAssetCoverage({ now });
      const missing = before.assets.filter(
        (a) =>
          a.assetType === 'domestic_stock' &&
          a.state === 'unavailable' &&
          (!options.symbols || options.symbols.includes(a.symbol)),
      );
      const date = session.localDate.replaceAll('-', '');
      for (const asset of missing.slice(0, options.maxSnapshots ?? 100)) {
        try {
          if (!(await this.locks.extend(acquired.lock)))
            throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
              'KOSCOM_LOCK_LOST',
            );
          const market = await this.markets.resolve(asset.symbol, asset.market);
          // closeprice has no documented business date. Dated history is the
          // closing evidence; do not stamp a timestamp-less quote as today's close.
          const response = await this.client.get(
            `/v3/market/closed/${market}/${asset.symbol}/history`,
            {
              trnsmCycleTpCd: 'D',
              inqStrtDd: date,
              inqEndDd: date,
              reqCnt: '1',
            },
          );
          const rows = response.result.hisLists;
          if (
            response.result.isuSrtCd !== asset.symbol ||
            !Array.isArray(rows) ||
            rows.length !== 1 ||
            response.receivedAt < session.closeTime
          )
            throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
              'KOSCOM_CLOSE_EVIDENCE_MISSING',
            );
          const row = rows[0] as Record<string, unknown>;
          if (row.trdDd !== date)
            throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
              'KOSCOM_CLOSE_DATE_MISMATCH',
            );
          const values = ohlcv(row, false);
          if (!dryRun) {
            if (!(await this.locks.extend(acquired.lock)))
              throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
                'KOSCOM_LOCK_LOST',
              );
            await this.prisma.assetPriceSnapshot.create({
              data: {
                assetId: asset.assetId,
                price: values.close,
                priceKrw: values.close,
                currencyCode: CurrencyCode.KRW,
                sourceType: AssetPriceSourceType.provider_api,
                sourceName: KOSCOM_PRICE_SOURCE,
                sourceTimestamp: null,
                effectiveAt: session.closeTime,
                capturedAt: response.receivedAt,
                rawPayloadJson: this.raw({
                  messageType: 'rest_session_close',
                  market,
                  row,
                  dateBasis: 'provider_history',
                }),
              },
            });
          }
          snapshots.push({
            assetId: asset.assetId,
            symbol: asset.symbol,
            kind: 'session_close',
            state: dryRun ? 'would_create' : 'created',
          });
        } catch (error) {
          snapshots.push({
            assetId: asset.assetId,
            symbol: asset.symbol,
            kind: 'session_close',
            state: 'failed',
            reason: koscomFailure(error),
          });
        }
      }
      if (!dryRun) {
        const after = await this.health.checkActiveAssetCoverage({ now });
        const incomplete = missing.some(
          (a) =>
            !after.assets.some(
              (b) => b.assetId === a.assetId && b.state === 'available',
            ),
        );
        await this.redis.setWithTtl(key, '1', incomplete ? 60 : 21600);
        if (incomplete)
          return summary(dryRun, snapshots, 'KOSCOM_CLOSE_RECOVERY_INCOMPLETE');
      }
      return summary(dryRun, snapshots);
    } catch (error) {
      return summary(dryRun, snapshots, koscomFailure(error));
    } finally {
      await this.locks.release(acquired.lock);
    }
  }
}

function summary(
  dryRun: boolean,
  snapshots: SnapshotSummary[],
  errorCode?: string,
) {
  const failed = snapshots.filter((s) => s.state === 'failed').length;
  const failure = projectOpsFailure({ message: errorCode }, errorCode);
  return {
    provider: 'koscom' as const,
    dryRun,
    success: !errorCode && failed === 0,
    received: snapshots.length,
    created: snapshots.filter((s) => s.state === 'created').length,
    wouldCreate: snapshots.filter((s) => s.state === 'would_create').length,
    skipped: snapshots.filter((s) => s.state === 'skipped').length,
    failed,
    snapshots,
    ...(errorCode
      ? { errorCode: failure.code, errorMessage: failure.message }
      : {}),
  };
}
