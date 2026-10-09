import ProtectionPanel from '../../features/conditional/ProtectionPanel';
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
import InlineEmptyState from '../../components/states/InlineEmptyState';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import AdminDiagnosticPanel from '../../components/states/AdminDiagnosticPanel';
import PendingOrders from './PendingOrders';

type Props = {
  accountId: string | null;
  account: TradingAccountDto | null;
  assetId: string;
  isFocused: boolean;
  onInputFocus?: (input: View | null) => void;
  onInputBlur?: () => void;
};

export default function AccountHoldings({
  accountId,
  account,
  assetId,
  isFocused,
  onInputFocus,
  onInputBlur,
}: Props) {
  const [filter, setFilter] = useState<'all' | 'current' | 'pending'>('current');
  const query = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.holdings(accountId ?? ''),
    queryFn: () =>
      getAccountHoldings(accountId ?? '', getTradingAccountPositions),
    enabled: !!accountId && isFocused && filter !== 'pending',
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
          {(['current', 'all', 'pending'] as const).map((value) => (
            <ActionPressable
              key={value}
              testID={`holdings-filter-${value}`}
              accessibilityRole="button"
              accessibilityState={{ selected: filter === value }}
              aria-pressed={filter === value}
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
          <HoldingRow key={`${accountId}:${position.assetId}`} accountId={accountId} position={position}
            onInputFocus={onInputFocus} onInputBlur={onInputBlur} />
        ))
      )}
    </View>
  );
}

function HoldingRow({ position, accountId, onInputFocus, onInputBlur }: {
  position: PositionItemDto; accountId: string;
  onInputFocus?: (input: View | null) => void; onInputBlur?: () => void;
}) {
  const [protection, setProtection] = useState(false);
  return (
    <View style={styles.row} testID={`holding-${position.assetId}`}>
      <PositionAssetRow position={position} testID={`spot-card-${position.assetId}`} />
      <ActionPressable accessibilityRole="button" testID={`holding-protection-${position.assetId}`} onPress={() => setProtection(!protection)} style={styles.retry}>
        <Text style={styles.value}>TP/SL 설정·관리</Text>
      </ActionPressable>
      {protection ? <ProtectionPanel accountId={accountId} assetId={position.assetId} positionId={position.positionId}
        domain="spot" currency={position.currencyCode} onInputFocus={onInputFocus} onInputBlur={onInputBlur} /> : null}
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
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, minWidth: 0, maxWidth: '100%' },
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
    backgroundColor: semantic.surface,
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 12,
    padding: 14,
    gap: 12,
    minWidth: 0,
  },
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
