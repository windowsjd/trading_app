import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import {
  findPreviousMarketSession,
  resolveStockMarketSessionState,
  type MarketCalendarAsset,
} from '../orders/market-calendar.policy';
import { zonedDateTimeToUtc } from '../providers/kis/candles/kis-candle-time';
import { MARKET_DAILY_CANDLE_SOURCE } from '../providers/market-daily-candle-source';
import { resolvePeriodWindowForDate } from '../providers/kis/candles/kis-period-candle-normalizer.service';
import { usCandlesFromTiingo } from './us-candle-provider';
import { MarketCandlesRepository } from './market-candles.repository';

const DAY_MS = 86_400_000;
const MAX_CACHE_ASSETS = 1024;
type BaselineWindow = {
  openTime: Date;
  closeTime: Date;
  completedAt: Date;
  provider: (typeof MARKET_DAILY_CANDLE_SOURCE)[keyof typeof MARKET_DAILY_CANDLE_SOURCE];
};
type ConfirmedDailyClose = { close: Prisma.Decimal; receivedAt: Date };
type CacheEntry = {
  key: string;
  close: ConfirmedDailyClose | null;
  expiresAt: number;
};

/**
 * The confirmed end-of-day close of one completed US session (display only).
 */
export type LatestSessionClose = {
  close: Prisma.Decimal;
  /** The session's regular close: the moment the close price is as of. */
  sessionCloseAt: Date;
  /** When the confirmed end-of-day row was received from the provider. */
  receivedAt: Date;
};

/** Read-only daily return shared by REST and provider ticker presentation. */
@Injectable()
export class DailyChangeRateService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<
    string,
    Promise<ConfirmedDailyClose | null>
  >();

  constructor(private readonly candles: MarketCandlesRepository) {}

  async calculate(input: {
    asset: MarketCalendarAsset & { id: string };
    price: Prisma.Decimal | string;
    effectiveAt: Date;
    now: Date;
  }): Promise<string | null> {
    try {
      const price = new Prisma.Decimal(input.price);
      if (!price.isFinite() || price.lte(0)) return null;
      const window = dailyBaselineWindow(input);
      if (!window) return null;
      const close = (
        await this.readCachedClose(
          input.asset.id,
          input.asset.id,
          window,
          input.now,
        )
      )?.close;
      return close ? price.minus(close).div(close).mul(100).toFixed(8) : null;
    } catch {
      // Invalid/missing baseline must not take the current price away.
      return null;
    }
  }

  /**
   * Display only, for the asset read paths of a CLOSED US market: the
   * confirmed Tiingo end-of-day RAW close of exactly the latest completed
   * session (the same row checks as the change-rate baseline). Null while the
   * market is open or its calendar is unavailable, outside the Tiingo
   * provider, or without that session's confirmed row: never an older
   * session's close and never another provider's price. Nothing is written,
   * and orders, valuation and settlement never call this.
   */
  async findLatestSessionClose(
    asset: MarketCalendarAsset & { id: string },
    now: Date,
  ): Promise<LatestSessionClose | null> {
    if (asset.assetType !== 'us_stock' || !usCandlesFromTiingo(asset))
      return null;
    const state = resolveStockMarketSessionState(asset, now);
    const session =
      state?.state === 'closed' ? state.latestCompletedSession : null;
    if (!session || session.closeTime > now) return null;
    const window = resolvePeriodWindowForDate(
      'US',
      session.localDate.replaceAll('-', ''),
      '1d',
    );
    if (!window) return null;
    const confirmed = await this.readCachedClose(
      `session-close:${asset.id}`,
      asset.id,
      {
        openTime: window.openTime,
        closeTime: window.closeTime,
        completedAt: session.closeTime,
        provider: MARKET_DAILY_CANDLE_SOURCE.usStock,
      },
      now,
    );
    return confirmed
      ? {
          close: confirmed.close,
          sessionCloseAt: session.closeTime,
          receivedAt: confirmed.receivedAt,
        }
      : null;
  }

  private async readCachedClose(
    cacheId: string,
    assetId: string,
    window: BaselineWindow,
    now: Date,
  ): Promise<ConfirmedDailyClose | null> {
    const key = `${window.provider}:${window.openTime.toISOString()}:${window.closeTime.toISOString()}:${window.completedAt.toISOString()}`;
    const cached = this.cache.get(cacheId);
    if (cached?.key === key && Date.now() < cached.expiresAt)
      return cached.close;
    const pendingKey = `${cacheId}:${key}`;
    let pending = this.inFlight.get(pendingKey);
    if (!pending) {
      pending = this.readClose(assetId, window, now)
        .catch(() => null)
        .then((value) => {
          this.cache.delete(cacheId);
          this.cache.set(cacheId, {
            key,
            close: value,
            expiresAt: Date.now() + (value ? 30_000 : 5_000),
          });
          if (this.cache.size > MAX_CACHE_ASSETS) {
            const oldest = this.cache.keys().next();
            if (!oldest.done) this.cache.delete(oldest.value);
          }
          return value;
        })
        .finally(() => this.inFlight.delete(pendingKey));
      this.inFlight.set(pendingKey, pending);
    }
    return pending;
  }

  private async readClose(
    assetId: string,
    window: BaselineWindow,
    now: Date,
  ): Promise<ConfirmedDailyClose | null> {
    const rows = await this.candles.findRange({
      assetId,
      interval: '1d',
      from: window.openTime,
      to: new Date(window.openTime.getTime() + 1),
    });
    if (rows.length !== 1) return null;
    const row = rows[0];
    if (
      row.assetId !== assetId ||
      row.interval !== '1d' ||
      !row.isClosed ||
      (row.sourceProvider !== window.provider && !(window.provider === MARKET_DAILY_CANDLE_SOURCE.domesticStock && row.sourceProvider === 'koscom_history')) ||
      row.openTime.getTime() !== window.openTime.getTime() ||
      row.closeTime.getTime() !== window.closeTime.getTime() ||
      !Number.isFinite(row.sourceUpdatedAt.getTime()) ||
      row.sourceUpdatedAt < window.completedAt ||
      row.sourceUpdatedAt > now
    )
      return null;
    const values = [row.open, row.high, row.low, row.close];
    if (
      values.some((value) => !value.isFinite() || value.lte(0)) ||
      row.high.lt(row.low) ||
      row.high.lt(row.open) ||
      row.high.lt(row.close) ||
      row.low.gt(row.open) ||
      row.low.gt(row.close)
    )
      return null;
    return { close: row.close, receivedAt: row.sourceUpdatedAt };
  }
}

function dailyBaselineWindow(input: {
  asset: MarketCalendarAsset;
  effectiveAt: Date;
  now: Date;
}): BaselineWindow | null {
  const nowMs = input.now.getTime();
  const priceMs = input.effectiveAt.getTime();
  if (!Number.isFinite(nowMs) || !Number.isFinite(priceMs) || priceMs > nowMs)
    return null;
  if (input.asset.assetType === 'crypto') {
    const end = Math.floor(nowMs / DAY_MS) * DAY_MS;
    return {
      openTime: new Date(end - DAY_MS),
      closeTime: new Date(end),
      completedAt: new Date(end),
      provider: MARKET_DAILY_CANDLE_SOURCE.crypto,
    };
  }
  const us = input.asset.assetType === 'us_stock';
  if (
    input.asset.assetType !== 'domestic_stock' &&
    !(us && usCandlesFromTiingo(input.asset))
  )
    return null;
  const state = resolveStockMarketSessionState(input.asset, input.now);
  if (!state || state.state === 'calendar_unavailable') return null;
  const priceSession =
    state.state === 'open'
      ? state.currentSession
      : state.latestCompletedSession;
  if (
    !priceSession ||
    priceMs < priceSession.openTime.getTime() ||
    priceMs > priceSession.closeTime.getTime()
  )
    return null;
  const previous = findPreviousMarketSession(
    input.asset,
    priceSession.openTime,
    1,
  );
  if (!previous || previous.closeTime > input.now) return null;
  if (us) {
    // The stored US daily window of that New York date (local midnights).
    const window = resolvePeriodWindowForDate(
      'US',
      previous.localDate.replaceAll('-', ''),
      '1d',
    );
    if (!window) return null;
    return {
      openTime: window.openTime,
      closeTime: window.closeTime,
      completedAt: previous.closeTime,
      provider: MARKET_DAILY_CANDLE_SOURCE.usStock,
    };
  }
  const openTime = zonedDateTimeToUtc(
    previous.localDate.replaceAll('-', ''),
    '000000',
    previous.timeZone,
  );
  if (!openTime) return null;
  return {
    openTime,
    closeTime: new Date(openTime.getTime() + DAY_MS),
    completedAt: previous.closeTime,
    provider: MARKET_DAILY_CANDLE_SOURCE.domesticStock,
  };
}
