import React from 'react';
import { View, Text, StyleSheet } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import type { FuturesPosition } from '../../features/futures/api';
import type { useFuturesHoldings } from '../../features/futures/useFuturesHoldings';
import { futuresHolding } from '../../features/futures/positionDisplay';
import FuturesPositionRow from './FuturesPositionRow';
import ErrorState from '../states/ErrorState';
import SectionSkeleton from '../states/SectionSkeleton';
import InlineEmptyState from '../states/InlineEmptyState';

type Props = { holdings: ReturnType<typeof useFuturesHoldings>; onOpen: (position: FuturesPosition) => void;
  limit?: number; testID?: string };
export default function FuturesPositionsSection({ holdings, onOpen, limit, testID = 'futures-positions' }: Props) {
  return <View testID={testID} style={styles.section}>
    <Text accessibilityRole="header" style={styles.title}>포지션</Text>
    {holdings.isError ? <ErrorState error={holdings.error} title="포지션을 불러오지 못했습니다." onRetry={() => void holdings.refetch()} />
      : !holdings.data ? <SectionSkeleton lines={2} />
        : holdings.data.positions.length === 0 ? <InlineEmptyState message="보유 중인 선물 포지션이 없습니다." />
          : holdings.data.positions.slice(0, limit).map(position => <FuturesPositionRow key={position.id}
            testID={`${testID}-${position.id}`} position={futuresHolding(position)} evaluatedAt={holdings.data.evaluatedAt}
            now={holdings.clock} onPress={() => onOpen(position)} />)}
  </View>;
}
const styles = StyleSheet.create({
  section: { minWidth: 0, gap: 4, marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderColor: semantic.border },
  title: { fontSize: 15, lineHeight: 23, fontWeight: '600' },
});
