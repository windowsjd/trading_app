import type {
  EventArg,
  NavigationAction,
  NavigationProp,
  NavigatorScreenParams,
  ParamListBase,
  RouteProp,
} from '@react-navigation/native';

import type { EntryTab, MainTabParamList, MarketStackParamList } from './types';

/**
 * Opening a Market-tab screen from another tab (a holding on Home, Portfolio
 * or Wallet, a futures position).
 *
 * Without `initial: false`, a nested navigate into a Market tab that has not
 * been opened yet makes the target its stack's ONLY screen. An asset detail
 * opened that way had no back button (nothing under it in its stack) and no
 * tab bar (a detail hides it), and the 마켓 tab kept showing that detail
 * afterwards instead of the market list. With `initial: false` the Market
 * list is the stack's first screen and the target is pushed onto it, as when
 * the Market tab is already open.
 */
export function openInMarketTab<Name extends 'AssetDetail' | 'Futures'>(
  screen: Name,
  params: MarketStackParamList[Name],
): NavigatorScreenParams<MainTabParamList> {
  return {
    screen: 'MarketTab',
    params: { screen, params, initial: false } as NavigatorScreenParams<MarketStackParamList>,
  };
}

/**
 * MarketStack `screenListeners`: a screen opened from another tab with a
 * `returnTab` (an asset detail) goes back to that tab when it is closed with
 * back (the header button, Android back, the iOS swipe), so the user is on
 * the screen they came from. The detail itself leaves the Market stack as
 * usual, so the 마켓 tab keeps its own screens.
 *
 * Back only: a reset (logout, account switch) or the 마켓 tab's pop to top
 * removes the detail without the user going back anywhere.
 */
export function returnToEntryTab({ navigation, route }: {
  navigation: Pick<NavigationProp<ParamListBase>, 'getParent'>;
  route: RouteProp<ParamListBase>;
}) {
  return {
    beforeRemove: ({ data: { action } }: EventArg<'beforeRemove', true, { action: NavigationAction }>) => {
      const returnTab = (route.params as { returnTab?: EntryTab } | undefined)?.returnTab;
      const tabs = navigation.getParent();
      if (returnTab && (action.type === 'GO_BACK' || action.type === 'POP') && tabs?.isFocused()) tabs.navigate(returnTab);
    },
  };
}
