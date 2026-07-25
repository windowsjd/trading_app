/**
 * Injection token for the ticker delivery counters exposed by
 * `AssetTickerGateway`. Declared standalone (no Prisma/gateway imports) so
 * readiness can consume the metrics with a TYPE-only import and never pull the
 * realtime module graph into its own module load.
 */
export const TICKER_FANOUT_METRICS = Symbol('TICKER_FANOUT_METRICS');

export type TickerFanoutMetrics = {
  clients: number;
  sent: number;
  coalesced: number;
  dropped: number;
  pendingTickers: number;
  clientsWithPendingTickers: number;
  maxPendingTickersPerClient: number;
  pendingTickerLimitPerClient: number;
};

export interface TickerFanoutMetricsSource {
  getTickerFanoutMetrics(): TickerFanoutMetrics;
}
