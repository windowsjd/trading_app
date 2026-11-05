import React, { useRef, useState } from 'react';
import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import ActionPressable from '../../components/common/ActionPressable';
import ErrorNotice from '../../components/states/ErrorNotice';
import { changeFriendship, type FriendAction, type FriendRelationship } from '../../features/friends/api';
import { refreshFriendship } from '../../features/friends/cache';
import { FRIEND_ACTION_BUSY, friendActionFailureMessage, friendCommandUser } from '../../features/friends/friendAction';
import { getApiErrorCode } from '../../services/api/errorMapper';

type User = { id: string; nickname: string; profileImageUrl: string | null };

/**
 * 친구 요청 on a user's season summary (2026-11-06), right under the tier card
 * and apart from it. The relationship is the server's for this user id
 * (GET /friends/relationships/:userId), read with the summary on every entry
 * and return; a nickname is never matched. none → 친구 요청, sent → 요청 보냄 ·
 * 수락 대기 중, received → 수락 / 거절, friend → 친구; the member's own summary
 * shows nothing, and a failed read is never "none" (다시 시도). Commands are the
 * 친구 screen's (changeFriendship + refreshFriendship): one at a time, buttons
 * held until the relationship is read again; a refusal says why after the
 * re-read. Accepting resets the summary, so the server decides again whether
 * the portfolio may show.
 */
export default function UserFriendAction({ user, relationship }: {
  user: User;
  relationship: UseQueryResult<FriendRelationship>;
}) {
  const client = useQueryClient();
  const [failure, setFailure] = useState<{ action: FriendAction['action']; cause: unknown } | null>(null);
  // A second tap before the busy state renders is dropped here.
  const running = useRef(false);
  const mutation = useMutation({
    mutationFn: changeFriendship,
    onSuccess: async (_data, change) => refreshFriendship(client, change),
    onError: async (cause, change) => {
      await refreshFriendship(client, change);
      setFailure({ action: change.action, cause });
    },
  });
  const data = relationship.data?.userId === user.id ? relationship.data : undefined;
  const target = data ? friendCommandUser(user, data) : null;
  const busy = mutation.isPending ? mutation.variables?.action ?? null : null;
  const act = (action: 'request' | 'accept' | 'reject') => {
    if (running.current || mutation.isPending || !target) return;
    running.current = true;
    setFailure(null);
    mutation.mutate({ action, user: target }, { onSettled: () => { running.current = false; } });
  };

  if (data?.relationship === 'self') return null;
  const failed = failure ? (
    <ErrorNotice error={failure.cause} message={friendActionFailureMessage(failure.action, getApiErrorCode(failure.cause))}
      testID="user-summary-friend-error" style={styles.error} />
  ) : null;

  // The latest read failed: unknown, never "none" — the last answer may be out of date.
  if (relationship.isError) {
    const gone = getApiErrorCode(relationship.error) === 'USER_NOT_FOUND';
    return (
      <View style={styles.box} testID="user-summary-friend">
        <ErrorNotice error={relationship.error} testID="user-summary-friend-unknown" style={styles.helper}
          message={gone ? '현재 친구 요청을 할 수 없는 사용자예요.' : '친구 관계를 확인하지 못했어요. 다시 시도해 주세요.'} />
        {gone ? null : (
          <ActionPressable testID="user-summary-friend-retry" accessibilityRole="button" accessibilityLabel="친구 관계 다시 확인"
            disabled={relationship.isFetching} aria-disabled={relationship.isFetching}
            accessibilityState={{ disabled: relationship.isFetching, busy: relationship.isFetching }} aria-busy={relationship.isFetching}
            onPress={() => void relationship.refetch({ cancelRefetch: false })} style={[styles.button, styles.neutral, styles.single]}>
            <Text style={styles.buttonText}>{relationship.isFetching ? '확인 중...' : '다시 시도'}</Text>
          </ActionPressable>
        )}
      </View>
    );
  }
  if (!data || !target) {
    return (
      <View style={styles.box} testID="user-summary-friend">
        <Text testID="user-summary-friend-loading" style={styles.helper}>친구 관계를 확인하고 있어요.</Text>
      </View>
    );
  }

  const button = (action: 'request' | 'accept' | 'reject', label: string, accessibilityLabel: string, primary: boolean) => {
    const disabled = busy !== null;
    return (
      <ActionPressable key={action} testID={`user-summary-friend-${action}`} accessibilityRole="button" accessibilityLabel={accessibilityLabel}
        disabled={disabled} aria-disabled={disabled} accessibilityState={{ disabled, busy: busy === action }} aria-busy={busy === action}
        onPress={() => act(action)} style={[styles.button, primary ? styles.primary : styles.neutral, disabled && styles.disabled]}>
        <Text style={[styles.buttonText, primary && styles.primaryText]}>{busy === action ? FRIEND_ACTION_BUSY[action] : label}</Text>
      </ActionPressable>
    );
  };
  return (
    <View style={styles.box} testID="user-summary-friend" accessibilityLiveRegion="polite">
      {data.relationship === 'none' ? (
        <View style={styles.actions}>{button('request', '친구 요청', `${user.nickname}님에게 친구 요청`, true)}</View>
      ) : data.relationship === 'sent' ? (
        <View style={styles.status} testID="user-summary-friend-sent">
          <Text style={styles.statusText}>요청 보냄 · 수락 대기 중</Text>
        </View>
      ) : data.relationship === 'received' ? (
        <>
          <Text testID="user-summary-friend-received" style={styles.helper}>{`${user.nickname}님이 친구 요청을 보냈어요.`}</Text>
          <View style={styles.actions}>
            {button('accept', '수락', `${user.nickname}님의 친구 요청 수락`, true)}
            {button('reject', '거절', `${user.nickname}님의 친구 요청 거절`, false)}
          </View>
        </>
      ) : (
        <View style={[styles.status, styles.friend]} testID="user-summary-friend-friend">
          <Text style={[styles.statusText, styles.friendText]}>친구</Text>
        </View>
      )}
      {failed}
    </View>
  );
}

// Plain objects: loaded by harnesses with minimal native mocks.
const styles = {
  box: { gap: 8, minWidth: 0 },
  helper: { fontSize: 14, lineHeight: 20, color: semantic.secondary, flexShrink: 1 },
  error: { fontSize: 13, lineHeight: 19, color: semantic.error, flexShrink: 1 },
  actions: { flexDirection: 'row', gap: 8, minWidth: 0 },
  button: { flex: 1, minHeight: 44, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 8 },
  single: { flex: 0, alignSelf: 'flex-start', minWidth: 120 },
  primary: { borderColor: semantic.secondaryActionSurface, backgroundColor: semantic.secondaryActionSurface },
  neutral: { borderColor: semantic.border, backgroundColor: semantic.raised },
  disabled: { opacity: 0.5 },
  buttonText: { fontSize: 15, lineHeight: 21, fontWeight: '700', color: semantic.text, textAlign: 'center', flexShrink: 1 },
  primaryText: { color: semantic.secondaryActionForeground },
  status: { minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: semantic.border, backgroundColor: semantic.raised,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 8 },
  friend: { borderColor: semantic.successSurface, backgroundColor: semantic.successSurface },
  statusText: { fontSize: 15, lineHeight: 21, fontWeight: '700', color: semantic.secondary, textAlign: 'center', flexShrink: 1 },
  friendText: { color: semantic.success },
} as const;
