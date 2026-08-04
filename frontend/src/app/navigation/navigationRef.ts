import { createNavigationContainerRef } from '@react-navigation/native';

import type { RootStackParamList } from './types';

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
