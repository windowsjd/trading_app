import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { QUERY_KEYS } from '../../constants/queryKeys';
import { useRootNavigation } from '../../app/navigation/navigationHooks';
import { logout as revokeSession } from './api';
import { endSession } from './session';
import { getRefreshToken } from '../../services/storage/tokenStorage';
import type { MeDto } from '../me/api';

/**
 * THE logout (작업 10 §B-12).
 *
 * This used to be copy-pasted into MyScreen and SettingsScreen. Two copies of a
 * teardown is two chances for them to drift, and they had already drifted in
 * the way that matters least visibly and most dangerously: neither cleared the
 * legacy financial cache, so `['wallet']`, `['positions']`, `['portfolio']`,
 * `['order']`, `['home','dashboard']`, `['record']` and `['ranking']` all
 * survived into the next user's session.
 *
 * The server revoke is best effort; the local teardown is not. A user who
 * pressed 로그아웃 on a shared device must end up logged out even if the network
 * is down — so the revoke sits in its own try/catch and the local clear runs in
 * `finally`.
 *
 * The userId is read from the cache BEFORE the clear, because it is the key
 * under which this user's account selection is stored and there is nowhere else
 * to get it afterwards.
 */
export function useLogout() {
  const queryClient = useQueryClient();
  const rootNavigation = useRootNavigation();

  return useCallback(async () => {
    const userId =
      queryClient.getQueryData<MeDto>(QUERY_KEYS.me)?.id ?? null;
    const refreshToken = await getRefreshToken();

    try {
      await revokeSession(refreshToken);
    } catch {
      // Best effort: the local session ends regardless.
    } finally {
      await endSession(queryClient, userId);
    }

    rootNavigation.reset({
      index: 0,
      routes: [{ name: 'AuthStack', params: { screen: 'Login' } }],
    });
  }, [queryClient, rootNavigation]);
}
