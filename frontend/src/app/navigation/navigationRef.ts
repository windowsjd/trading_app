import { createNavigationContainerRef } from '@react-navigation/native';

import type { AuthStackParamList, RootStackParamList } from './types';

/**
 * A navigator handle for the one caller that has no React context: the axios
 * session-expiry path (작업 10 §A-8).
 *
 * Every screen keeps using `useRootNavigation()`. This exists only so a
 * dead refresh token — discovered inside an interceptor, outside the tree —
 * can put the user back on the login screen instead of leaving them on a
 * financial screen whose session the server has already stopped honouring.
 */
export const rootNavigationRef =
  createNavigationContainerRef<RootStackParamList>();

export function resetToLoginFromRef() {
  if (!rootNavigationRef.isReady()) return;

  rootNavigationRef.reset({
    index: 0,
    routes: [{ name: 'AuthStack', params: { screen: 'Login' } }],
  });
}

/**
 * After a confirmed 회원탈퇴 the session is gone: the auth stack opens on the
 * deletion result instead of Login. Uses the container ref because the
 * deleting screen has usually unmounted by then.
 */
export function resetToMembershipDeletionResultFromRef(
  params: AuthStackParamList['MembershipDeletionResult'],
) {
  if (!rootNavigationRef.isReady()) return;
  rootNavigationRef.reset({
    index: 0,
    routes: [
      {
        name: 'AuthStack',
        params: { screen: 'MembershipDeletionResult', params },
      },
    ],
  });
}

export function isOnMembershipDeletionResult() {
  return (
    rootNavigationRef.isReady() &&
    rootNavigationRef.getCurrentRoute()?.name === 'MembershipDeletionResult'
  );
}
