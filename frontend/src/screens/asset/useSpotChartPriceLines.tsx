import { useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { QUERY_KEYS } from '../../constants/queryKeys';
import {
  findAccountPosition,
  getTradingAccountOrders,
  getTradingAccountPositions,
} from '../../features/tradingAccount/api';
import { getAccountPendingOrders } from '../../features/record/accountOrders';
import { getProtections } from '../../features/conditional/api';
import { getConditionalBuyOrders } from '../../features/conditional/conditionalBuyApi';
import { getOpenConditionalBuyOrders } from '../../features/conditional/conditionalBuyLists';
import { getConditionalSellOrders } from '../../features/conditional/conditionalSellApi';
import { getOpenConditionalSellOrders } from '../../features/conditional/conditionalSellLists';
import { buildSpotChartPriceLines } from '../../features/asset/spotChartPriceLines';
import type { ChartPriceLine } from '../../components/charts/chartPriceLines';

/** While a line can still change under the chart, its reads repeat this often. */
export const CHART_PRICE_LINES_REFRESH_MS = 4000;

const NO_LINES: ChartPriceLine[] = [];
const live = (row: { assetId: string; state: string }, assetId: string) =>
  row.assetId === assetId && (row.state === 'watching' || row.state === 'triggered');

/**
 * The selected account's lines for one asset's spot chart. The reads are the
 * order screen's own (same keys and requests: one cache, and the order and
 * cancel invalidations already refresh them); none runs for a guest or an
 * unconfirmed selection, or while another screen is in front. They repeat
 * only while this asset has a holding, an open order or a live condition —
 * a fill, trigger or expiry changes those without the app's own action.
 */
export function useSpotChartPriceLines({ accountId, assetId, currencyCode, focused }: {
  /** The selected account, or null (a guest, or a selection being changed). */
  accountId: string | null;
  assetId: string;
  /** The candles' own currency. */
  currencyCode: string | null | undefined;
  focused: boolean;
}): ChartPriceLine[] {
  const id = accountId ?? '';
  const enabled = !!accountId && focused;
  // Set after this render's lines are known; read by the next poll decision.
  const watching = useRef(false);
  const poll = () => (enabled && watching.current ? CHART_PRICE_LINES_REFRESH_MS : false);
  const position = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.positions(id, { assetId, limit: 20 }),
    queryFn: () => getTradingAccountPositions(id, { assetId, limit: 20, offset: 0 }),
    enabled,
    refetchInterval: poll,
  });
  const pending = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.pendingOrders(id),
    queryFn: () => getAccountPendingOrders(id, getTradingAccountOrders),
    enabled,
    refetchInterval: poll,
  });
  const buys = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.conditionalBuy.open(id),
    queryFn: ({ signal }) => getOpenConditionalBuyOrders(id, getConditionalBuyOrders, signal),
    enabled,
    refetchInterval: (query) => (enabled && query.state.data?.conditionalOrders.some((row) => live(row, assetId))
      ? CHART_PRICE_LINES_REFRESH_MS : false),
  });
  const conditions = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.conditionalSell.open(id, 'condition'),
    queryFn: ({ signal }) => getOpenConditionalSellOrders(id, 'condition', getConditionalSellOrders, signal),
    enabled,
    refetchInterval: (query) => (enabled && query.state.data?.conditionalOrders.some((row) => live(row, assetId))
      ? CHART_PRICE_LINES_REFRESH_MS : false),
  });
  const protections = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.conditionalSell.open(id, 'protection'),
    queryFn: ({ signal }) => getOpenConditionalSellOrders(id, 'protection', getConditionalSellOrders, signal),
    enabled,
    refetchInterval: (query) => (enabled && query.state.data?.conditionalOrders.some((row) => live(row, assetId))
      ? CHART_PRICE_LINES_REFRESH_MS : false),
  });
  const oco = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.protections.list(id, 'spot', assetId),
    queryFn: ({ signal }) => getProtections(id, 'spot', assetId, false, signal),
    enabled,
    retry: false,
    refetchInterval: (query) => (enabled && query.state.data?.groups.some((group) => group.status === 'active')
      ? CHART_PRICE_LINES_REFRESH_MS : false),
  });

  // Only an answer for this account is ever drawn (the key holds it too).
  const own = <T extends { tradingAccountId: string }>(data: T | undefined) =>
    accountId && data?.tradingAccountId === accountId ? data : undefined;
  const positionData = own(position.data);
  const pendingData = own(pending.data);
  const buyData = own(buys.data);
  const conditionData = own(conditions.data);
  const protectionData = own(protections.data);
  const ocoData = oco.isError ? undefined : own(oco.data);
  const lines = useMemo(() => (!accountId ? NO_LINES : buildSpotChartPriceLines({
    assetId,
    currencyCode,
    position: findAccountPosition(positionData, assetId),
    pendingOrders: pendingData?.items ?? [],
    conditionalBuys: buyData?.conditionalOrders ?? [],
    conditionalSells: [...(conditionData?.conditionalOrders ?? []), ...(protectionData?.conditionalOrders ?? [])],
    protections: ocoData,
  })), [accountId, assetId, currencyCode, positionData, pendingData, buyData, conditionData, protectionData, ocoData]);
  // A just-triggered condition has no line yet but is about to change.
  watching.current = lines.length > 0 ||
    [buyData, conditionData, protectionData].some((data) => data?.conditionalOrders.some((row) => live(row, assetId)));
  return lines;
}
