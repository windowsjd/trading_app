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

export function resetToSeasonJoin(navigation: RootNavigationProp) {
  navigation.reset({
    index: 0,
    routes: [{ name: 'SeasonJoin' }],
  });
}

/**
 * Where a user with NO trading account lands (작업 11 §3.3).
 *
 * The same screen as season join, under the name that says what it is for. It
 * offers both ways to start — open a general account, or join a season if one
 * is open — and it is reached because the user owns nothing, never because the
 * server happens to have no active season.
 */
export function resetToAccountSetup(navigation: RootNavigationProp) {
  resetToSeasonJoin(navigation);
}
