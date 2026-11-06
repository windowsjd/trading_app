import type { NavigationAction, NavigationState, Router } from '@react-navigation/native';
import { questNavigationRouter } from '../../features/quest/questNavigationGuard.ts';

/**
 * Back on a tab's first screen (Android Back, 2026-11-06).
 *
 * The tabs keep the order they were visited in (`backBehavior: 'history'`),
 * so Back returns to the tab seen before this one. With no earlier tab left
 * (the history used up, or the tabs opened on another tab), every tab but
 * Home returns to Home; only Home lets Back leave the app, and
 * AndroidExitConfirm asks first. The previous `firstRoute` default sent every
 * tab straight to Home, whatever the user came from.
 */
export const MAIN_TABS_BACK_BEHAVIOR = 'history' as const;
export const HOME_TAB = 'HomeTab';

type TabHistory = { history?: { type: 'route'; key: string }[]; preloadedRouteKeys?: string[] };

/** Back with no earlier tab: Home, as the only entry of the history (no loop back to the tab left). */
export function backToHomeTab<State extends NavigationState, Action extends NavigationAction>(
  original: Router<State, Action>,
): Router<State, Action> {
  return {
    ...original,
    getStateForAction(state, action, options) {
      const next = original.getStateForAction(state, action, options);
      if (next !== null || action.type !== 'GO_BACK') return next;
      const home = state.routes.findIndex(route => route.name === HOME_TAB);
      if (home === -1 || home === state.index) return null;
      const key = state.routes[home].key;
      const { preloadedRouteKeys } = state as State & TabHistory;
      return {
        ...state,
        index: home,
        history: [{ type: 'route', key }],
        ...(preloadedRouteKeys ? { preloadedRouteKeys: preloadedRouteKeys.filter(preloaded => preloaded !== key) } : {}),
      };
    },
  };
}

/** MainTabs' `UNSTABLE_router`: Back to Home, then the beginner quest's hold on moves. */
export function mainTabsRouter<State extends NavigationState, Action extends NavigationAction>(
  original: Router<State, Action>,
): Partial<Router<State, Action>> {
  const back = backToHomeTab(original);
  return { ...back, ...questNavigationRouter(back) };
}
