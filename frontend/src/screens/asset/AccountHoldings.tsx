import { semantic } from '../../theme/tokens';
import React, { useState } from 'react';
import { StyleSheet, Text, View } from '../../theme/native';
import { useQuery } from '@tanstack/react-query';
import Decimal from 'decimal.js';
import {
  getTradingAccountPositions,
  type TradingAccountDto,
} from '../../features/tradingAccount/api';
import { getAccountHoldings } from '../../features/tradingAccount/holdings';
import { getIntegrityErrorMessage } from '../../features/tradingAccount/integrityErrors';
import { getTradingAssetName } from '../../features/asset/tradingHeader';
import { getPositionDisplay } from '../../features/position/display';
import type { PositionItemDto } from '../../features/position/api';
import { QUERY_KEYS } from '../../constants/queryKeys';
import ActionPressable from '../../components/common/ActionPressable';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import AdminDiagnosticPanel from '../../components/states/AdminDiagnosticPanel';
import PendingOrders from './PendingOrders';

type Props = {
  accountId: string | null;
  account: TradingAccountDto | null;
  assetId: string;
  isFocused: boolean;
};

export default function AccountHoldings({
  accountId,
  account,
  assetId,
  isFocused,
}: Props) {
  const [filter, setFilter] = useState<'all' | 'current' | 'pending'>('all');
  const query = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.holdings(accountId ?? ''),
    queryFn: () =>
      getAccountHoldings(accountId ?? '', getTradingAccountPositions),
    enabled: !!accountId && filter !== 'pending',
  });
  // No previous-account placeholder; the envelope check also protects display
  // if a caller ever seeds the wrong account into this cache entry.
  const data =
    query.data?.tradingAccountId === accountId ? query.data : undefined;
  const integrityMessage = query.isError
    ? getIntegrityErrorMessage(query.error)
    : null;
  const positions = data?.positions ?? [];
  const visible =
    filter === 'current'
      ? positions.filter((position) => position.assetId === assetId)
      : positions;

  return (
    <View style={styles.section} testID="account-holdings">
      <View style={styles.header}>
        <Text style={styles.title} testID="holdings-count">
          {filter === 'pending' ? '대기 주문' : `보유 종목${data && !query.isError ? ` ${positions.length}` : ''}`}
        </Text>
        <View style={styles.filters}>
          {(['all', 'current', 'pending'] as const).map((value) => (
            <ActionPressable
              key={value}
              testID={`holdings-filter-${value}`}
              accessibilityRole="button"
              accessibilityState={{ selected: filter === value }}
              onPress={() => setFilter(value)}
              style={[styles.filter, filter === value && styles.selectedFilter]}
            >
              <Text
                style={[
                  styles.filterText,
                  filter === value && styles.selectedText,
                ]}
              >
                {value === 'all' ? '전체 보유' : value === 'current' ? '현재 종목' : '대기 목록'}
              </Text>
            </ActionPressable>
          ))}
        </View>
      </View>
      {!accountId ? (
        <InlineEmptyState
          title="계정이 없습니다."
          message="계정을 개설하면 보유 현황을 볼 수 있습니다."
        />
      ) : filter === 'pending' ? (
        <PendingOrders
          accountId={accountId}
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
          message=""
          title={
            filter === 'all'
              ? '보유 중인 종목이 없습니다.'
              : '현재 종목을 보유하고 있지 않습니다.'
          }
        />
      ) : (
        visible.map((position) => (
          <HoldingRow key={position.assetId} position={position} />
        ))
      )}
    </View>
  );
}

function HoldingRow({ position }: { position: PositionItemDto }) {
  const display = getPositionDisplay(position);
  const valuation = position.valuation;
  const values = [
    ['보유수량', display.quantity, null],
    ['평균단가', display.averageCost, null],
    ['현재가', display.currentPrice ?? '시세 조회 불가', null],
    ['평가금액', display.positionValueKrw, null],
    [
      '평가손익',
      display.unrealizedPnlKrw,
      valuation.state === 'unavailable' ? null : valuation.unrealizedPnlKrw,
    ],
    [
      '수익률',
      display.returnRate,
      valuation.state === 'unavailable' ? null : valuation.returnRate,
    ],
  ];
  return (
    <View style={styles.row} testID={`holding-${position.assetId}`}>
      <Text style={styles.pair}>
        {getTradingAssetName(position)} / {position.currencyCode}
      </Text>
      {values.map(([label, value, signed]) => (
        <View key={label} style={styles.metric}>
          <Text style={styles.label}>{label}</Text>
          <Text
            selectable
            style={[
              styles.value,
              signed !== null && new Decimal(signed).gt(0)
                ? styles.up
                : signed !== null && new Decimal(signed).lt(0)
                  ? styles.down
                  : null,
            ]}
          >
            {value}
          </Text>
        </View>
      ))}
      {display.priceNotice ? (
        <Text style={styles.notice}>{display.priceNotice}</Text>
      ) : null}
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
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  filter: {
    minWidth: 0,
    minHeight: 32,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 999,
    backgroundColor: semantic.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectedFilter: { backgroundColor: semantic.selected },
  filterText: { fontSize: 12, color: semantic.secondary, textAlign: 'center' },
  selectedText: { color: semantic.onAccent, fontWeight: '600' },
  row: {
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 12,
    padding: 14,
    gap: 12,
    minWidth: 0,
  },
  pair: { fontSize: 17, fontWeight: '700', color: semantic.text },
  // A long value moves below its label. It can then wrap across the full row;
  // neither native font scaling nor large KRW values require truncation.
  metric: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: 12,
    rowGap: 4,
  },
  label: { fontSize: 13, color: semantic.muted },
  value: {
    fontSize: 14,
    color: semantic.secondary,
    fontVariant: ['tabular-nums'],
    flexShrink: 1,
    maxWidth: '100%',
  },
  up: { color: semantic.rise },
  down: { color: semantic.fall },
  notice: { fontSize: 12, color: semantic.warning },
  retry: {
    alignSelf: 'flex-start',
    padding: 10,
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 8,
  },
});
