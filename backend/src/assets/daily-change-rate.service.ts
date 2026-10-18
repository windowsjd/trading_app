import { Injectable } from '@nestjs/common';
import { Prisma, type MarketCandle } from '../generated/prisma/client';
import {
  findPreviousMarketSession,
  resolveStockMarketSessionState,
  type MarketCalendarAsset,
} from '../orders/market-calendar.policy';
import { zonedDateTimeToUtc } from '../providers/kis/candles/kis-candle-time';
import { MARKET_DAILY_CANDLE_SOURCE } from '../providers/market-daily-candle-source';
import { resolvePeriodWindowForDate } from '../providers/kis/candles/kis-period-candle-normalizer.service';
import { KOSCOM_HISTORY_SOURCE } from '../providers/koscom/koscom.config';
import { usCandlesFromTiingo } from './us-candle-provider';
import { MarketCandlesRepository } from './market-candles.repository';

const DAY_MS = 86_400_000;
const MAX_CACHE_ASSETS = 1024;
type BaselineWindow = {
  openTime: Date;
  closeTime: Date;
  completedAt: Date;
  /**
   * The daily row's source. The change-rate baseline's domestic source also
   * accepts `koscom_history`; the closed-KRX display reads only KOSCOM's
   * daily (`krxClosedSessionWindow`).
   */
  provider:
    | (typeof MARKET_DAILY_CANDLE_SOURCE)[keyof typeof MARKET_DAILY_CANDLE_SOURCE]
    | typeof KOSCOM_HISTORY_SOURCE;
};
type ConfirmedDailyClose = { close: Prisma.Decimal; receivedAt: Date };
type CacheEntry = {
  key: string;
  close: ConfirmedDailyClose | null;
  expiresAt: number;
};

/**
 * The daily-bar close of one completed US or KRX session (display only).
 */
export type LatestSessionClose = {
  close: Prisma.Decimal;
  /**
   * The regular close of the session the daily bar belongs to. A KRX close is
   * KOSCOM's daily close, not necessarily the 15:30 auction print: until
   * KOSCOM finalizes the bar it is the NXT after-market last price.
   */
  sessionCloseAt: Date;
  /** When the daily row the close comes from was received from the provider. */
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
    if (asset.assetType === 'domestic_stock')
      return this.findKrxLatestSessionClose(asset, now);
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

  /**
   * Display only, for the asset read paths of a CLOSED KRX market (2026-10-18
   * product rule): the close of KOSCOM's daily bar (`koscom_history`) of
   * exactly the latest completed session, with the change-rate baseline's row
   * checks (that asset, that session's KST day, closed, received after the
   * session close and not in the future, positive consistent O/H/L/C). No
   * other candle is required or compared: the close may still be provisional
   * (the NXT after-market last price until KOSCOM finalizes the bar — 10-16
   * 005930 217,000 vs the 215,500 auction) and is shown as KOSCOM reports it.
   * A later KOSCOM revision shows once the daily jobs upsert it (a found
   * close is cached 30 s). Otherwise null: never an older session's close and
   * never another provider's price. Nothing is written; orders, LOC,
   * valuation and settlement never call this.
   */
  private async findKrxLatestSessionClose(
    asset: MarketCalendarAsset & { id: string },
    now: Date,
  ): Promise<LatestSessionClose | null> {
    const window = krxClosedSessionWindow(asset, now);
    if (!window) return null;
    const confirmed = await this.readCachedClose(
      `session-close:${asset.id}`,
      asset.id,
      window,
      now,
    );
    return confirmed
      ? {
          close: confirmed.close,
          sessionCloseAt: window.completedAt,
          receivedAt: confirmed.receivedAt,
        }
      : null;
  }

  /**
   * Market-list turnover from the confirmed daily row of the LATEST COMPLETED
   * session (sort and home TOP 5 only), one read per market:
   * - US stocks on Tiingo (2026-10-17): RAW close × RAW volume of the Tiingo
   *   end-of-day row — while the market is open, the previous session. It is
   *   derived from end-of-day data, not a provider-summed notional.
   * - KRX stocks while the market is closed (2026-10-18), whose shown price
   *   is that daily's close (`findKrxLatestSessionClose`): the same row's
   *   accumulated trade value (`amount`, KOSCOM `accTrdval`).
   * Same row checks as `findLatestSessionClose` plus a finite, non-negative
   * value. An asset without that session's confirmed row (e.g. after the
   * close, before the daily row arrives) is absent: never an older session's
   * value. Orders, valuation, ranking and settlement never call this.
   */
  async findLatestSessionTurnovers(
    assets: readonly (MarketCalendarAsset & { id: string })[],
    now: Date,
  ): Promise<Map<string, Prisma.Decimal>> {
    const turnovers = new Map<string, Prisma.Decimal>();
    const krxAssets = assets.filter(
      (asset) => asset.assetType === 'domestic_stock',
    );
    const krxWindow = krxAssets.length
      ? krxClosedSessionWindow(krxAssets[0], now)
      : null;
    if (krxWindow) {
      const rows = await this.candles.findManyAtOpenTime({
        assetIds: krxAssets.map((asset) => asset.id),
        interval: '1d',
        openTime: krxWindow.openTime,
      });
      for (const row of rows) {
        if (
          isConfirmedDailyRow(row, row.assetId, krxWindow, now) &&
          row.amount?.isFinite() &&
          row.amount.gte(0)
        )
          turnovers.set(row.assetId, row.amount);
      }
    }
    const usAssets = assets.filter(
      (asset) => asset.assetType === 'us_stock' && usCandlesFromTiingo(asset),
    );
    if (!usAssets.length) return turnovers;
    const session = resolveStockMarketSessionState(
      usAssets[0],
      now,
    )?.latestCompletedSession;
    if (!session || session.closeTime > now) return turnovers;
    const period = resolvePeriodWindowForDate(
      'US',
      session.localDate.replaceAll('-', ''),
      '1d',
    );
    if (!period) return turnovers;
    const window: BaselineWindow = {
      openTime: period.openTime,
      closeTime: period.closeTime,
      completedAt: session.closeTime,
      provider: MARKET_DAILY_CANDLE_SOURCE.usStock,
    };
    const rows = await this.candles.findManyAtOpenTime({
      assetIds: usAssets.map((asset) => asset.id),
      interval: '1d',
      openTime: window.openTime,
    });
    for (const row of rows) {
      if (
        !isConfirmedDailyRow(row, row.assetId, window, now) ||
        !row.volume.isFinite() ||
        row.volume.lt(0)
      )
        continue;
      turnovers.set(row.assetId, row.close.times(row.volume));
    }
    return turnovers;
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
    return isConfirmedDailyRow(row, assetId, window, now)
      ? { close: row.close, receivedAt: row.sourceUpdatedAt }
      : null;
  }
}

/**
 * The KOSCOM daily window (that KST day) of a CLOSED KRX market's latest
 * completed session. Null while the market is open — a missing live price is
 * never covered by a past close — or without calendar coverage.
 */
function krxClosedSessionWindow(
  asset: MarketCalendarAsset,
  now: Date,
): BaselineWindow | null {
  const state = resolveStockMarketSessionState(asset, now);
  const session =
    state?.state === 'closed' ? state.latestCompletedSession : null;
  if (!session || session.closeTime > now) return null;
  const openTime = zonedDateTimeToUtc(
    session.localDate.replaceAll('-', ''),
    '000000',
    session.timeZone,
  );
  return openTime
    ? {
        openTime,
        closeTime: new Date(openTime.getTime() + DAY_MS),
        completedAt: session.closeTime,
        provider: KOSCOM_HISTORY_SOURCE,
      }
    : null;
}

/**
 * The confirmed daily row of exactly `window` for `assetId` from the
 * window's provider: closed, received after the session close and not in
 * the future, with positive, consistent O/H/L/C.
 */
function isConfirmedDailyRow(
  row: MarketCandle,
  assetId: string,
  window: BaselineWindow,
  now: Date,
): boolean {
  if (
    row.assetId !== assetId ||
    row.interval !== '1d' ||
    !row.isClosed ||
    (row.sourceProvider !== window.provider &&
      !(
        window.provider === MARKET_DAILY_CANDLE_SOURCE.domesticStock &&
        row.sourceProvider === 'koscom_history'
      )) ||
    row.openTime.getTime() !== window.openTime.getTime() ||
    row.closeTime.getTime() !== window.closeTime.getTime() ||
    !Number.isFinite(row.sourceUpdatedAt.getTime()) ||
    row.sourceUpdatedAt < window.completedAt ||
    row.sourceUpdatedAt > now
  )
    return false;
  const values = [row.open, row.high, row.low, row.close];
  return !(
    values.some((value) => !value.isFinite() || value.lte(0)) ||
    row.high.lt(row.low) ||
    row.high.lt(row.open) ||
    row.high.lt(row.close) ||
    row.low.gt(row.open) ||
    row.low.gt(row.close)
  );
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
