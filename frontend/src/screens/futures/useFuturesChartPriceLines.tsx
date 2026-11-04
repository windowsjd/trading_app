import { useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { QUERY_KEYS } from '../../constants/queryKeys';
import {
  getFuturesConditionalEntries,
  getFuturesLimitOrders,
  getFuturesPositions,
} from '../../features/futures/api';
import { getFuturesTpSlSettings } from '../../features/futures/tpSlApi';
import { getProtections } from '../../features/conditional/api';
import { futuresServerNow } from '../../features/futures/policy';
import { buildFuturesChartPriceLines } from '../../features/futures/futuresChartPriceLines';
import type { ChartPriceLine } from '../../components/charts/chartPriceLines';

/** A position's ROI is shown only while its read is fresh (5 s): the futures screen's cadence. */
const POSITION_REFRESH_MS = 2000;
/** The futures screen's lists' cadence. */
const LIST_REFRESH_MS = 4000;

const NO_LINES: ChartPriceLine[] = [];

/**
 * The bound account's lines for one contract's chart, from the futures
 * screen's own reads (same keys: one cache, refreshed by its order, cancel
 * and TP/SL invalidations). Nothing is read for a guest or an account that is
 * not the selected one, or while another screen is in front; the reads repeat
 * only while this contract has a position, an open limit entry or a watch.
 */
export function useFuturesChartPriceLines({ accountId, instrumentId, focused }: {
  /** The route's account when it is the selected one; null for a guest. */
  accountId: string | null;
  instrumentId: string;
  focused: boolean;
}): ChartPriceLine[] {
  const id = accountId ?? '';
  const enabled = !!accountId && focused;
  // Set after this render's lines are known; read by the next poll decision.
  const watching = useRef(false);
  const positions = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.futures.positions(id),
    queryFn: ({ signal }) => getFuturesPositions(id, signal),
    enabled,
    retry: false,
    refetchInterval: () => (enabled && watching.current ? POSITION_REFRESH_MS : false),
  });
  const limitOrders = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.futures.pending(id),
    queryFn: ({ signal }) => getFuturesLimitOrders(id, signal),
    enabled,
    retry: false,
    refetchInterval: (query) => (enabled && query.state.data?.orders.some((order) => order.instrumentId === instrumentId)
      ? LIST_REFRESH_MS : false),
  });
  const entries = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.futures.conditionalEntries(id, 'open'),
    queryFn: ({ signal }) => getFuturesConditionalEntries(id, 'open', signal),
    enabled,
    retry: false,
    refetchInterval: (query) => (enabled && query.state.data?.entries.some((entry) => entry.instrumentId === instrumentId)
      ? LIST_REFRESH_MS : false),
  });
  const tpSl = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.futures.tpSl(id, 'open'),
    queryFn: ({ signal }) => getFuturesTpSlSettings(id, 'open', signal),
    enabled,
    retry: false,
    refetchInterval: (query) => (enabled && query.state.data?.settings.some((setting) => setting.instrumentId === instrumentId)
      ? LIST_REFRESH_MS : false),
  });
  const own = <T extends { tradingAccountId: string }>(data: T | undefined, failed: boolean) =>
    accountId && !failed && data?.tradingAccountId === accountId ? data : undefined;
  const positionData = own(positions.data, positions.isError);
  // Old OCO groups are keyed by the underlying asset (the position card's read).
  const underlyingAssetId = positionData?.positions.find((position) => position.instrumentId === instrumentId)
    ?.instrument.underlying.assetId ?? '';
  const oco = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.protections.list(id, 'futures', underlyingAssetId),
    queryFn: ({ signal }) => getProtections(id, 'futures', underlyingAssetId, false, signal),
    enabled: enabled && !!underlyingAssetId,
    retry: false,
    refetchInterval: (query) => (enabled && query.state.data?.groups.some((group) => group.status === 'active')
      ? LIST_REFRESH_MS : false),
  });
  const limitData = own(limitOrders.data, limitOrders.isError);
  const entryData = own(entries.data, entries.isError);
  const tpSlData = own(tpSl.data, tpSl.isError);
  const ocoData = own(oco.data, oco.isError);
  // The ROI's freshness is judged on the read's server clock, rounded UP to
  // the second (never fresher than it is) so the lines rebuild once a second.
  const now = Math.ceil(futuresServerNow(positionData, Date.now()) / 1000) * 1000;
  const lines = useMemo(() => (!accountId ? NO_LINES : buildFuturesChartPriceLines({
    instrumentId,
    positions: positionData?.positions ?? [],
    evaluatedAt: positionData?.evaluatedAt,
    now,
    limitOrders: limitData?.orders ?? [],
    conditionalEntries: entryData?.entries ?? [],
    tpSl: tpSlData?.settings ?? [],
    protections: ocoData,
  })), [accountId, instrumentId, positionData, limitData, entryData, tpSlData, ocoData, now]);
  watching.current = lines.length > 0 ||
    !!entryData?.entries.some((entry) => entry.instrumentId === instrumentId && entry.state === 'triggered');
  return lines;
}
