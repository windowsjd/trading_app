import type { RootNavigationProp } from './types';
import { setGuestBrowsing } from '../../features/auth/guestBrowsing.ts';

const homeRoute = {
  name: 'MainTabs' as const,
  params: {
    screen: 'HomeTab' as const,
    params: { screen: 'Home' as const },
  },
};

const loginRoute = {
  name: 'AuthStack' as const,
  params: { screen: 'Login' as const },
};

export function resetToLogin(navigation: RootNavigationProp) {
  navigation.reset({
    index: 0,
    routes: [loginRoute],
  });
}

export function resetToHome(navigation: RootNavigationProp) {
  navigation.reset({
    index: 0,
    routes: [homeRoute],
  });
}

/**
 * Where EVERY fresh authentication lands (작업 13 §2): the screen that asks
 * which investment mode this session is about — 일반 투자 or 시즌 투자.
 *
 * A reset, not a push: mode selection replaces the auth flow rather than
 * stacking on it, so back does not return the user to a login form they have
 * already passed. It also serves the "owns nothing yet" state — the screen
 * offers opening a general account and joining a season — so there is no
 * separate account-setup entry route any more.
 */
export function resetToModeSelection(navigation: RootNavigationProp) {
  navigation.reset({
    index: 0,
    routes: [{ name: 'ModeSelection' }],
  });
}

/**
 * A guest's 로그인 or 회원가입 (2026-10-30): guest browsing ends and the auth
 * stack becomes the root. 회원가입 opens over 로그인, so back returns to the
 * login screen and its 「로그인 없이 둘러보기」. A sign-in from there takes
 * the usual entry (mode selection), never back into the guest tabs.
 */
export function leaveGuestBrowsing(
  navigation: RootNavigationProp,
  screen: 'Login' | 'Signup',
) {
  setGuestBrowsing(false);
  navigation.reset({
    index: 0,
    routes: [
      {
        name: 'AuthStack',
        state: screen === 'Signup'
          ? { index: 1, routes: [{ name: 'Login' }, { name: 'Signup' }] }
          : { index: 0, routes: [{ name: 'Login' }] },
      },
    ],
  });
}
