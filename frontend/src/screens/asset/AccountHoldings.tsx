import { useQuestGuide } from '../../features/quest/QuestGuideProvider';
import { useTradingGuideFacts } from '../../features/quest/useTradingGuideFacts';
import QuestTarget from '../../features/quest/QuestTarget';
import QuestLimitReview from '../../features/quest/QuestLimitReview';
import { questGuideTarget } from '../../features/quest/questGuideBridge';
import { semantic } from '../../theme/tokens';
import React, { useState } from 'react';
import { StyleSheet, Text, View } from '../../theme/native';
import { useQuery } from '@tanstack/react-query';
import {
  getTradingAccountPositions,
  type TradingAccountDto,
} from '../../features/tradingAccount/api';
import { getAccountHoldings } from '../../features/tradingAccount/holdings';
import { getIntegrityErrorMessage } from '../../features/tradingAccount/integrityErrors';
import PositionAssetRow from '../../components/tradingAccount/PositionAssetRow';
import type { PositionItemDto } from '../../features/position/api';
import { QUERY_KEYS } from '../../constants/queryKeys';
import ActionPressable from '../../components/common/ActionPressable';
import SegmentedControl from '../../components/common/SegmentedControl';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import AdminDiagnosticPanel from '../../components/states/AdminDiagnosticPanel';
import TpSlButton from '../../features/conditional/tpsl/TpSlButton';
import TpSlSheet, { type TpSlTarget } from '../../features/conditional/tpsl/TpSlSheet';
import { getConditionalSellOrders } from '../../features/conditional/conditionalSellApi';
import { getOpenConditionalSellOrders } from '../../features/conditional/conditionalSellLists';
import { tpSlCountSummary } from '../../features/conditional/tpSlModel';
import PendingOrders from './PendingOrders';
import { OrderAsidePortal } from '../order/OrderAside';
import { HoldingSummaryCard } from '../order/StockOrderAside';

type Props = {
  accountId: string | null;
  account: TradingAccountDto | null;
  assetId: string;
  isFocused: boolean;
  // Kept for callers; the card's 손절가/익절가 inputs live in its bottom sheet.
  onInputFocus?: (input: View | null) => void;
  onInputBlur?: () => void;
  /** Order screen: a holding of another asset switches the order to it. */
  onSelectAsset?: (assetId: string) => void;
  /**
   * Stock order card (A-2): this asset's holding is drawn as 내 보유 in the
   * card's right column, with its 손절가/익절가 button and guide target; this
   * section then lists the account's OTHER holdings, so nothing shows twice.
   */
  currentInAside?: boolean;
};

export default function AccountHoldings({
  accountId,
  account,
  assetId,
  isFocused,
  onSelectAsset,
  currentInAside = false,
}: Props) {
  const [filter, setFilter] = useState<'all' | 'current' | 'pending'>(currentInAside ? 'all' : 'current');
  const guide = useQuestGuide();
  const reviewOrderId = guide?.active?.quest === 'limitBuy' && guide.active.accountId === accountId && guide.active.assetId === assetId ? guide.active.orderId : undefined;
  const query = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.holdings(accountId ?? ''),
    queryFn: () =>
      getAccountHoldings(accountId ?? '', getTradingAccountPositions),
    // 내 보유 in the order card needs this read whatever the list shows.
    enabled: !!accountId && isFocused && (currentInAside || filter !== 'pending'),
    refetchInterval: isFocused ? 4000 : false,
  });
  // No previous-account placeholder; the envelope check also protects display
  // if a caller ever seeds the wrong account into this cache entry.
  const data =
    query.data?.tradingAccountId === accountId ? query.data : undefined;
  const integrityMessage = query.isError
    ? getIntegrityErrorMessage(query.error)
    : null;
  const positions = data?.positions ?? [];
  const visible = currentInAside
    ? positions.filter((position) => position.assetId !== assetId)
    : filter === 'current'
      ? positions.filter((position) => position.assetId === assetId)
      : positions;

  const ownPosition = (currentInAside ? positions : visible).find(p => p.assetId === assetId);
  // In the A-2 card 내 보유 is always on screen; otherwise the list must show it.
  const ownShown = currentInAside || filter !== 'pending';
  useTradingGuideFacts({ screen: 'holdings', accountId: accountId ?? '', assetId, holdingsVisible: isFocused && ownShown && !query.isError && !!ownPosition && ownPosition.valuation.state !== 'unavailable' }, isFocused);
  const tpSlScope = currentInAside && ownPosition ? [...visible, ownPosition] : visible;
  // Live independent 손절가/익절가 per holding (the count beside each button).
  const tpSlQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.conditionalSell.open(accountId ?? '', 'protection'),
    queryFn: ({ signal }) => getOpenConditionalSellOrders(accountId ?? '', 'protection', getConditionalSellOrders, signal),
    enabled: !!accountId && isFocused && ownShown && tpSlScope.some(isTpSlCandidate),
    // US-only holdings: one read learns the server's markets; keep polling
    // only while some visible holding can carry 손절가/익절가.
    refetchInterval: (query) => isFocused && (!query.state.data
      || tpSlScope.some((position) => isTpSlMarket(position, query.state.data?.capabilities.markets ?? null)))
      ? 4000 : false,
  });
  const tpSlRows = !tpSlQuery.isError && tpSlQuery.data?.tradingAccountId === accountId ? tpSlQuery.data.conditionalOrders : null;
  const tpSlMarkets = !tpSlQuery.isError && tpSlQuery.data?.tradingAccountId === accountId ? tpSlQuery.data.capabilities.markets : null;
  const [tpSlTarget, setTpSlTarget] = useState<TpSlTarget | null>(null);
  const tpSlSummary = (target: string) => tpSlRows
    ? tpSlCountSummary(tpSlRows.filter(row => row.assetId === target && (row.state === 'watching' || row.state === 'triggered')))
    : null;
  // 내 보유 (A-2): this asset's holding, drawn in the order card's right column.
  const ownTpSl = currentInAside && accountId && ownPosition && !query.isError && isTpSlMarket(ownPosition, tpSlMarkets) ? (
    <TpSlButton testID={`holding-${assetId}-tp-sl`} summary={tpSlSummary(assetId)}
      onPress={() => setTpSlTarget({ type: 'spot_holding', accountId, assetId })} />
  ) : null;
  const ownCard = currentInAside && accountId ? (
    <HoldingSummaryCard state={query.isError ? 'error' : !data ? 'loading' : 'ready'} position={ownPosition ?? null}
      onRetry={() => void query.refetch()} figuresRef={isFocused ? questGuideTarget('asset-holdings') : undefined}>
      {ownTpSl && isFocused ? <QuestTarget id="asset-protection">{ownTpSl}</QuestTarget> : ownTpSl}
    </HoldingSummaryCard>
  ) : null;

  return (
    <View style={styles.section} testID="account-holdings">
      {reviewOrderId && accountId ? <QuestLimitReview key={`${accountId}:${reviewOrderId}`} accountId={accountId} orderId={reviewOrderId} focused={isFocused} /> : null}
      {ownCard ? <OrderAsidePortal name="holding">{ownCard}</OrderAsidePortal> : null}
      <View style={styles.header}>
        <Text style={styles.title} testID="holdings-count">
          {filter === 'pending' ? '대기 주문'
            : `${currentInAside ? '다른 보유 종목' : '보유 종목'}${data && !query.isError ? ` ${currentInAside ? visible.length : positions.length}` : ''}`}
        </Text>
      </View>
      <SegmentedControl testID="holdings-filters" accessibilityLabel="보유 목록 보기" compact value={filter} onChange={setFilter}
        options={(currentInAside ? ['all', 'pending'] as const : ['current', 'all', 'pending'] as const).map(value => ({
          key: value,
          label: value === 'all' ? currentInAside ? '다른 보유' : '전체 보유' : value === 'current' ? '현재 종목' : '대기 목록',
          testID: `holdings-filter-${value}`,
        }))} />
      {!accountId ? (
        <InlineEmptyState
          title="계정이 없습니다."
          message="계정을 개설하면 보유 현황을 볼 수 있습니다."
        />
      ) : filter === 'pending' ? (
        <PendingOrders
          accountId={accountId}
          conditional
          isFocused={isFocused}
          seasonUi={account?.id === accountId && account.mode === 'season'}
        />
      ) : query.isError ? (
        <>
          <InlineEmptyState
            title={
              integrityMessage
                ? '보유 내역을 안전하게 표시할 수 없습니다.'
                : '보유 종목을 불러오지 못했습니다.'
            }
            message={integrityMessage ?? '잠시 후 다시 시도해주세요.'}
          />
          <ActionPressable
            testID="holdings-retry"
            accessibilityRole="button"
            style={styles.retry}
            onPress={() => void query.refetch()}
          >
            <Text style={styles.value}>보유 종목 다시 시도</Text>
          </ActionPressable>
          <AdminDiagnosticPanel error={query.error} />
        </>
      ) : !data ? (
        <SectionSkeleton lines={4} />
      ) : visible.length === 0 ? (
        <InlineEmptyState
          title={
            currentInAside
              ? '다른 보유 종목이 없습니다.'
              : filter === 'all'
                ? '보유 중인 종목이 없습니다.'
                : '현재 종목을 보유하고 있지 않습니다.'
          }
        />
      ) : (
        visible.map((position) => (
          <HoldingRow key={`${accountId}:${position.assetId}`} position={position} guideTarget={isFocused && position.assetId === assetId}
            tpSlSummary={tpSlSummary(position.assetId)}
            onTpSl={accountId && isTpSlMarket(position, tpSlMarkets) ? () => setTpSlTarget({ type: 'spot_holding', accountId, assetId: position.assetId }) : undefined}
            onSelect={onSelectAsset && position.assetId !== assetId ? () => onSelectAsset(position.assetId) : undefined} />
        ))
      )}
      <TpSlSheet target={isFocused && tpSlTarget?.accountId === accountId ? tpSlTarget : null} onClose={() => setTpSlTarget(null)} />
    </View>
  );
}

/** Holdings whose market may offer independent 손절가/익절가 (the list read). */
function isTpSlCandidate(position: Pick<PositionItemDto, 'assetType'>) {
  return position.assetType === 'domestic_stock' || position.assetType === 'crypto' || position.assetType === 'us_stock';
}

/**
 * Independent 손절가/익절가: KRX stocks and crypto Spot; US stocks only while
 * the server lists US (Tiingo prices, 2026-10-17), never on a guess.
 */
function isTpSlMarket(position: Pick<PositionItemDto, 'assetType'>, markets: readonly string[] | null) {
  if (position.assetType === 'domestic_stock' || position.assetType === 'crypto') return true;
  return position.assetType === 'us_stock' && !!markets?.includes('US');
}

/**
 * One holding with its 손절가/익절가 설정 (the bottom sheet of this holding);
 * existing OCO protections stay viewable and cancelable under 대기 목록 › TP/SL.
 */
function HoldingRow({ position, guideTarget, tpSlSummary, onTpSl, onSelect }: {
  guideTarget: boolean;
  position: PositionItemDto;
  tpSlSummary: string | null;
  onTpSl?: () => void;
  onSelect?: () => void;
}) {
  // The summary is the item's touch surface (to the card's edges).
  // With the 손절가/익절가 button below, the touch surface stops above it.
  const summary = <PositionAssetRow position={position} testID={`spot-card-${position.assetId}`} onPress={onSelect}
    style={onSelect ? onTpSl ? [styles.pressableSummary, styles.pressableAboveAction] : styles.pressableSummary : undefined}
    accessibilityHint={onSelect ? '이 종목의 주문 화면으로 전환합니다' : undefined} />;
  const tpSl = onTpSl ? <TpSlButton testID={`holding-${position.assetId}-tp-sl`} summary={tpSlSummary} onPress={onTpSl} /> : null;
  return (
    <View style={styles.row} testID={`holding-${position.assetId}`}>
      {guideTarget ? <QuestTarget id="asset-holdings">{summary}</QuestTarget> : summary}
      {tpSl && guideTarget ? <QuestTarget id="asset-protection">{tpSl}</QuestTarget> : tpSl}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    borderTopWidth: 1,
    borderColor: semantic.border,
    paddingTop: 16,
    marginTop: 8,
    gap: 12,
  },
  title: { fontSize: 18, fontWeight: '700', color: semantic.text },
  header: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
  },
  row: {
    backgroundColor: semantic.surface,
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 12,
    padding: 14,
    gap: 12,
    minWidth: 0,
  },
  pressableSummary: {
    margin: -14,
    paddingHorizontal: 14,
    paddingVertical: 20,
    borderRadius: 12,
  },
  pressableAboveAction: { marginBottom: 0, paddingBottom: 8, borderBottomLeftRadius: 0, borderBottomRightRadius: 0 },
  value: {
    fontSize: 14,
    color: semantic.secondary,
    fontVariant: ['tabular-nums'],
    flexShrink: 1,
    maxWidth: '100%',
  },
  retry: {
    backgroundColor: semantic.raised,
    alignSelf: 'flex-start',
    padding: 10,
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 8,
  },
});
