import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { MarketCalendarMarket } from './market-calendar.types';
import {
  applyMarketSessionOverrideSnapshot,
  getMarketSessionOverrideStoreStatus,
  markMarketSessionOverrideStoreRequired,
  recordMarketSessionOverrideRefreshFailure,
  type MarketSessionOverrideEntry,
  type MarketSessionOverrideKind,
} from './market-session-override.store';

/**
 * Multi-instance propagation is bounded polling: every instance reloads the
 * active-override snapshot at this interval, so an operator mutation made on
 * one instance is visible on every other instance within at most
 * REFRESH_INTERVAL + one query round-trip (~60s). The mutating instance
 * refreshes immediately after its transaction commits.
 */
export const MARKET_SESSION_OVERRIDE_REFRESH_INTERVAL_MS = 60_000;
/** Faster retry cadence while the initial (cold-start) load has not succeeded. */
export const MARKET_SESSION_OVERRIDE_COLD_RETRY_INTERVAL_MS = 5_000;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const TIME_PATTERN = /^\d{6}$/u;
const OVERRIDE_KINDS: readonly MarketSessionOverrideKind[] = [
  'regular',
  'closed',
  'custom',
];

export type MarketSessionOverrideChangeListener = (
  changedMarkets: readonly MarketCalendarMarket[],
) => void;

type OverrideRow = {
  market: string;
  localDate: string;
  overrideType: string;
  openTime: string | null;
  closeTime: string | null;
  reason: string;
};

@Injectable()
export class MarketSessionOverrideLoaderService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(MarketSessionOverrideLoaderService.name);
  private timer: NodeJS.Timeout | null = null;
  private inFlightRefresh: Promise<boolean> | null = null;
  private queuedRefresh: Promise<boolean> | null = null;
  private destroyed = false;
  private readonly changeListeners =
    new Set<MarketSessionOverrideChangeListener>();
  // Behavioral fingerprint of the last applied snapshot, per market. Reason
  // and audit fields are excluded on purpose: only schedule-affecting changes
  // should invalidate downstream candle caches.
  private lastFingerprints: Map<MarketCalendarMarket, string> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    markMarketSessionOverrideStoreRequired();
    const loaded = await this.refreshNow('startup');
    if (!loaded) {
      // Loud, structured, and fail-closed: until the first load succeeds the
      // store stays not-ready, so stock calendars report calendar_unavailable
      // rather than silently serving static-only schedules.
      this.logger.error(
        JSON.stringify({
          event: 'market_session_override_cold_start_load_failed',
          effect:
            'stock market calendar fail-closed (calendar_unavailable) until first successful load',
          retryIntervalMs: MARKET_SESSION_OVERRIDE_COLD_RETRY_INTERVAL_MS,
        }),
      );
    }
    this.scheduleNext();
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.inFlightRefresh?.catch(() => undefined);
    await this.queuedRefresh?.catch(() => undefined);
  }

  /**
   * Registers a listener invoked with the affected markets whenever a refresh
   * applies a snapshot whose schedule-affecting content changed. Returns an
   * unsubscribe function.
   */
  onOverridesChanged(
    listener: MarketSessionOverrideChangeListener,
  ): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /**
   * Loads the active overrides and applies them to the store. Refreshes are
   * serialized: every call resolves with the outcome of a DB read that
   * STARTED at or after the call, so a mutation committed before calling
   * refreshNow() is always observed by the load whose result is returned —
   * even when a polling refresh (which may have read a pre-commit snapshot)
   * is already in flight. Callers arriving while a refresh is running all
   * share ONE queued follow-up refresh, so concurrent mutations cause at
   * most one extra DB query instead of a query per caller.
   *
   * Returns true only when that (post-call) snapshot load succeeded and was
   * applied to the store. On failure the last-known-good snapshot (if any)
   * is kept and a structured warning is logged.
   */
  refreshNow(
    trigger: 'startup' | 'poll' | 'operator_mutation' | 'test',
  ): Promise<boolean> {
    if (!this.inFlightRefresh) {
      const run = this.refreshOnce(trigger).finally(() => {
        if (this.inFlightRefresh === run) this.inFlightRefresh = null;
      });
      this.inFlightRefresh = run;
      return run;
    }
    if (!this.queuedRefresh) {
      // Chained AFTER the in-flight refresh settles (its finally above runs
      // first, clearing inFlightRefresh), so the recursive call starts a
      // fresh DB read. queuedRefresh is cleared synchronously before that
      // read starts: a caller can only join the queue while the queued read
      // has not begun, which preserves the started-after-call guarantee.
      this.queuedRefresh = this.inFlightRefresh
        .catch(() => false)
        .then(() => {
          this.queuedRefresh = null;
          return this.refreshNow(trigger);
        });
    }
    return this.queuedRefresh;
  }

  private async refreshOnce(trigger: string): Promise<boolean> {
    try {
      const rows = (await this.prisma.marketSessionOverride.findMany({
        where: { isActive: true },
        select: {
          market: true,
          localDate: true,
          overrideType: true,
          openTime: true,
          closeTime: true,
          reason: true,
        },
      })) as OverrideRow[];

      const entries: MarketSessionOverrideEntry[] = [];
      for (const row of rows) {
        const entry = this.toEntry(row);
        if (entry) {
          entries.push(entry);
        } else {
          // DB CHECK constraints make this unreachable short of manual
          // tampering; skip the row rather than poisoning the snapshot.
          this.logger.warn(
            JSON.stringify({
              event: 'market_session_override_row_invalid',
              market: row.market,
              localDate: row.localDate,
            }),
          );
        }
      }

      const fingerprints = this.buildFingerprints(entries);
      const changedMarkets = this.diffMarkets(fingerprints);
      applyMarketSessionOverrideSnapshot(entries, new Date());
      this.lastFingerprints = fingerprints;
      if (changedMarkets.length > 0) {
        this.notifyChanged(changedMarkets);
      }
      return true;
    } catch (error) {
      recordMarketSessionOverrideRefreshFailure(new Date());
      const status = getMarketSessionOverrideStoreStatus();
      this.logger.warn(
        JSON.stringify({
          event: 'market_session_override_refresh_failed',
          trigger,
          storeLoaded: status.loaded,
          effect: status.loaded
            ? 'keeping last-known-good override snapshot'
            : 'store not ready; stock calendar remains fail-closed',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return false;
    }
  }

  private scheduleNext(): void {
    if (this.destroyed) return;
    const delay = getMarketSessionOverrideStoreStatus().loaded
      ? MARKET_SESSION_OVERRIDE_REFRESH_INTERVAL_MS
      : MARKET_SESSION_OVERRIDE_COLD_RETRY_INTERVAL_MS;
    this.timer = setTimeout(() => {
      void this.refreshNow('poll')
        .catch(() => false)
        .finally(() => this.scheduleNext());
    }, delay);
    this.timer.unref?.();
  }

  private toEntry(row: OverrideRow): MarketSessionOverrideEntry | null {
    const market =
      row.market === 'KRX' || row.market === 'US' ? row.market : null;
    const overrideType = OVERRIDE_KINDS.find(
      (kind) => kind === row.overrideType,
    );
    if (!market || !overrideType || !DATE_PATTERN.test(row.localDate)) {
      return null;
    }
    if (overrideType === 'custom') {
      if (
        !row.openTime ||
        !row.closeTime ||
        !TIME_PATTERN.test(row.openTime) ||
        !TIME_PATTERN.test(row.closeTime) ||
        row.openTime >= row.closeTime
      ) {
        return null;
      }
      return {
        market,
        localDate: row.localDate,
        overrideType,
        openTime: row.openTime,
        closeTime: row.closeTime,
        reason: row.reason,
      };
    }
    return {
      market,
      localDate: row.localDate,
      overrideType,
      openTime: null,
      closeTime: null,
      reason: row.reason,
    };
  }

  private buildFingerprints(
    entries: readonly MarketSessionOverrideEntry[],
  ): Map<MarketCalendarMarket, string> {
    const parts = new Map<MarketCalendarMarket, string[]>();
    for (const entry of entries) {
      const list = parts.get(entry.market) ?? [];
      list.push(
        `${entry.localDate}|${entry.overrideType}|${entry.openTime ?? ''}|${entry.closeTime ?? ''}`,
      );
      parts.set(entry.market, list);
    }
    const fingerprints = new Map<MarketCalendarMarket, string>();
    for (const market of ['KRX', 'US'] as const) {
      fingerprints.set(market, (parts.get(market) ?? []).sort().join(';'));
    }
    return fingerprints;
  }

  private diffMarkets(
    next: Map<MarketCalendarMarket, string>,
  ): MarketCalendarMarket[] {
    // First load has nothing to diff against; listeners subscribe for change
    // propagation, not initial state.
    if (!this.lastFingerprints) return [];
    const changed: MarketCalendarMarket[] = [];
    for (const market of ['KRX', 'US'] as const) {
      if (this.lastFingerprints.get(market) !== next.get(market)) {
        changed.push(market);
      }
    }
    return changed;
  }

  private notifyChanged(markets: readonly MarketCalendarMarket[]): void {
    for (const listener of this.changeListeners) {
      try {
        listener(markets);
      } catch (error) {
        this.logger.warn(
          JSON.stringify({
            event: 'market_session_override_change_listener_failed',
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  }
}
