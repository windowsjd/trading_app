import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import {
  findPreviousMarketSession,
  resolveStockMarketSessionState,
  type MarketCalendarAsset,
} from '../orders/market-calendar.policy';
import { zonedDateTimeToUtc } from '../providers/kis/candles/kis-candle-time';
import { KIS_DOMESTIC_PERIOD_SOURCE } from '../providers/kis/candles/kis-period-candle.types';
import { BINANCE_CANDLE_SOURCE } from '../providers/binance/binance-candle.types';
import { MarketCandlesRepository } from './market-candles.repository';

const DAY_MS = 86_400_000;
const MAX_CACHE_ASSETS = 1024;
type BaselineWindow = {
  openTime: Date;
  closeTime: Date;
  completedAt: Date;
  provider: typeof KIS_DOMESTIC_PERIOD_SOURCE | typeof BINANCE_CANDLE_SOURCE;
};
type CacheEntry = {
  key: string;
  close: Prisma.Decimal | null;
  expiresAt: number;
};

/** Read-only daily return shared by REST and provider ticker presentation. */
@Injectable()
export class DailyChangeRateService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<Prisma.Decimal | null>>();

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
      const key = `${window.provider}:${window.openTime.toISOString()}:${window.closeTime.toISOString()}:${window.completedAt.toISOString()}`;
      const cached = this.cache.get(input.asset.id);
      let close: Prisma.Decimal | null;
      if (cached?.key === key && Date.now() < cached.expiresAt) {
        close = cached.close;
      } else {
        const pendingKey = `${input.asset.id}:${key}`;
        let pending = this.inFlight.get(pendingKey);
        if (!pending) {
          pending = this.readClose(input.asset.id, window, input.now)
            .catch(() => null)
            .then((value) => {
              this.cache.delete(input.asset.id);
              this.cache.set(input.asset.id, {
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
        close = await pending;
      }
      return close ? price.minus(close).div(close).mul(100).toFixed(8) : null;
    } catch {
      // Invalid/missing baseline must not take the current price away.
      return null;
    }
  }

  private async readClose(assetId: string, window: BaselineWindow, now: Date) {
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
      row.sourceProvider !== window.provider ||
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
    return row.close;
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
      provider: BINANCE_CANDLE_SOURCE,
    };
  }
  if (input.asset.assetType !== 'domestic_stock') return null;
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
    provider: KIS_DOMESTIC_PERIOD_SOURCE,
  };
}
