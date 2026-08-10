import type { RootNavigationProp } from './types';

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
