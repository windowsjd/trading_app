import type { RootNavigationProp } from './types';
import type { CurrentSeasonDto } from '../../models/dto/season';
import { toSeasonEntryRoute } from '../../features/season/mapper';

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

export function resetToSeasonEntry(
  navigation: RootNavigationProp,
  season: CurrentSeasonDto | null | undefined,
) {
  if (toSeasonEntryRoute(season) === 'season_join') {
    resetToSeasonJoin(navigation);
    return;
  }

  resetToHome(navigation);
}
