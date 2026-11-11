/**
 * An account switch starts the bottom tabs the user is NOT looking at over at
 * their first screen (2026-11-10).
 *
 * MainTabs keys its navigator by the selected account so a switch discards the
 * previous account's tabs, but React Navigation restores a re-keyed navigator
 * from the root route's saved state: every stack the previous account left
 * open came back. An 주문 screen is bound to its account by its route
 * (`accountId`), so the 마켓 tab of the new account still held the old
 * account's order form, which correctly refused to trade ("선택한 계정이
 * 변경되었습니다."). Worse, a beginner quest that then opened its practice in
 * that tab (`initial: false`, an order or detail over the market list) never
 * got there: a stack mounting with restored state counts nested navigation
 * params as used without applying them (@react-navigation/core 7.17), so the
 * quest landed on the old account's order screen.
 *
 * Only the focused tab keeps its screens (the switcher itself lives on it:
 * Home, 내 자산, 지갑 원장 follow the selection). The others lose their saved
 * state AND their nested navigation params, which a fresh stack would replay.
 * Must be applied in the same event as the selection change, before the
 * re-keyed navigator mounts: afterwards its mount effect writes the restored
 * state back.
 */

type SavedRoute = { key?: string; name: string; params?: object; state?: SavedState };
type SavedState = { index?: number; routes: SavedRoute[] };

/** The root state with every unfocused tab of MainTabs cleared; null when nothing changes. */
export function withBackgroundTabsRestarted<S extends SavedState>(root: S): S | null {
  const at = root.routes.findIndex((route) => route.name === 'MainTabs');
  const tabs = root.routes[at]?.state;
  if (!tabs) return null;
  const focused = tabs.index ?? 0;
  let changed = false;
  const routes = tabs.routes.map((route, index) => {
    if (index === focused || (route.state === undefined && route.params === undefined)) return route;
    changed = true;
    const { state: _state, params: _params, ...fresh } = route;
    return fresh;
  });
  if (!changed) return null;
  return { ...root, routes: root.routes.map((route, index) => (index === at ? { ...route, state: { ...tabs, routes } } : route)) };
}

type NavigationLike = {
  getParent?: () => NavigationLike | undefined;
  getState?: () => unknown;
  reset?: (state: never) => void;
};

/** Applies `withBackgroundTabsRestarted` to the root navigator reached from any screen's navigation. */
export function restartBackgroundTabs(navigation: NavigationLike | null | undefined) {
  let root = navigation;
  while (root?.getParent?.()) root = root.getParent();
  const state = root?.getState?.() as SavedState | undefined;
  if (!root?.reset || !state?.routes) return;
  const next = withBackgroundTabsRestarted(state);
  if (next) root.reset(next as never);
}
