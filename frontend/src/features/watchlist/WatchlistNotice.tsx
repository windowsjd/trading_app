import React from 'react';
import { Text, View } from '../../theme/native';
import ActionPressable from '../../components/common/ActionPressable';
import ErrorNotice from '../../components/states/ErrorNotice';
import { getApiErrorCode } from '../../services/api/errorMapper';
import type { WatchlistState } from './useWatchlist';
import { semantic } from '../../theme/tokens';

export default function WatchlistNotice({ state }: { state: WatchlistState }) {
  const error = state.query.error ?? state.userError ?? state.error;
  if (error)
    return (
      <View testID="watchlist-error" style={{ gap: 8 }}>
        <ErrorNotice
          error={error}
          style={{ color: semantic.warning }}
          message={
            state.query.isError || state.userError
              ? '관심종목을 확인하지 못했습니다. 다시 조회해주세요.'
              : getApiErrorCode(error) === 'WATCHLIST_LIMIT_REACHED'
                ? '관심종목은 최대 50개까지 등록할 수 있습니다.'
                : '관심종목 변경 결과를 확인하지 못했습니다. 목록을 다시 확인해주세요.'
          }
        />
        <ActionPressable
          accessibilityRole="button"
          onPress={() => void state.retry()}
          style={{ minHeight: 48, justifyContent: 'center' }}
        >
          <Text>관심종목 다시 조회</Text>
        </ActionPressable>
      </View>
    );
  if (!state.ready)
    return (
      <Text testID="watchlist-loading" accessibilityLiveRegion="polite">
        관심종목을 확인하는 중입니다.
      </Text>
    );
  return null;
}
