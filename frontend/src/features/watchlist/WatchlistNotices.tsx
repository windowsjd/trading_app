import React from 'react';
import { StyleSheet, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import ActionPressable from '../../components/common/ActionPressable';
import ErrorNotice from '../../components/states/ErrorNotice';
import EmptyState from '../../components/states/EmptyState';
import WhaleLoader from '../../components/states/WhaleLoader';

/** A failed watchlist read: reviewed copy, the original error for admin
 * diagnostics, and a retry. Never rendered as an empty watchlist. */
export function WatchlistErrorNotice({ error, message, onRetry, testID }: {
  error: unknown;
  message: string;
  onRetry: () => void;
  testID?: string;
}) {
  return (
    <View style={styles.notice} testID={testID}>
      <ErrorNotice error={error} message={message} style={styles.noticeText} />
      <ActionPressable accessibilityRole="button" feedback="button" style={styles.retry} onPress={onRetry}>
        <Text style={styles.retryText}>다시 시도</Text>
      </ActionPressable>
    </View>
  );
}

/** The watchlist view with no rows: loading, failed and empty stay distinct. */
export function WatchlistEmptyState({ isLoading, isError, error, onRetry, marketLabel }: {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  marketLabel: string;
}) {
  if (isLoading) {
    return (
      <View style={styles.loading} testID="watchlist-loading">
        <WhaleLoader size={28} />
        <Text style={styles.noticeText}>관심종목을 불러오는 중입니다.</Text>
      </View>
    );
  }
  if (isError) {
    return (
      <WatchlistErrorNotice
        testID="watchlist-error"
        error={error}
        message="관심종목을 불러오지 못했습니다. 잠시 후 다시 시도해주세요."
        onRetry={onRetry}
      />
    );
  }
  return (
    <EmptyState
      title={`${marketLabel} 관심종목이 없습니다.`}
      message="종목 오른쪽의 별을 누르면 관심종목에 추가됩니다."
    />
  );
}

const styles = StyleSheet.create({
  notice: {
    gap: 8,
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: semantic.warningSurface,
  },
  noticeText: { fontSize: 13, lineHeight: 19, color: semantic.secondary },
  retry: {
    alignSelf: 'flex-start',
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: semantic.secondaryActionSurface,
  },
  retryText: { fontSize: 14, fontWeight: '700', color: semantic.secondaryActionForeground },
  loading: { alignItems: 'center', gap: 8, paddingVertical: 32 },
});
