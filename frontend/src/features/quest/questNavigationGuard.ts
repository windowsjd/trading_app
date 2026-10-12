import type { NavigationAction, NavigationState, PartialState, Router } from '@react-navigation/native';
import { guideAllowsRoute } from './questGuideModel.ts';
import type { BeginnerQuestKey } from './questProgress.ts';
/**
 * Holds a beginner on the active quest's practice path BEFORE a move happens.
 *
 * The navigators that users move through (root, tabs, Market and Wallet
 * stacks) route every action through `questNavigationRouter`. While a guide is
 * active, an action that would open a screen outside its quest returns the
 * unchanged state: nothing renders, nothing flashes and the form keeps its
 * input; the guide shows a short notice with 안내 종료 instead. Without a guide
 * (general and season accounts, a beginner not in a quest) it changes nothing.
 *
 * Never held back: returning to a screen that is already open (Back, a native
 * back gesture, a popped stack), sign-in and account entry (logout, session
 * expiry) and everything the guide itself opens. It cannot execute, cancel or
 * retry anything; a held move is simply not made.
 *
 * React- and react-native-free so `node --test` and the screen harnesses load it.
 */

/** Sign-in, account entry and the tab container itself are never held back. */
const ENTRY_ROUTES = new Set(['Splash', 'AuthStack', 'Login', 'Signup', 'ModeSelection', 'MainTabs']);

type Guard = { quest: BeginnerQuestKey; onBlocked: () => void };
let guard: Guard | null = null;

/** The active guide's quest, or null to lift its guard; another guide's guard is never lifted. */
export function setQuestNavigationGuard(onBlocked: () => void, quest: BeginnerQuestKey | null) {
  if (quest) guard = { quest, onBlocked };
  else if (guard?.onBlocked === onBlocked) guard = null;
}

function holds(names: readonly string[]): boolean {
  const active = guard;
  if (!active || names.every(name => ENTRY_ROUTES.has(name) || guideAllowsRoute(active.quest, name))) return false;
  // Routers may run during a navigator's render: tell the guide afterwards.
  void Promise.resolve().then(active.onBlocked);
  return true;
}

/** For a screen that opens without a route (the 이체 sheet): false, with the notice, when held. */
export function questNavigationAllowed(name: string): boolean {
  return !holds([name]);
}

type AnyRoute = { key?: string; name: string; params?: object; state?: { index?: number; routes: AnyRoute[] } };

/** The screens a route opens, outermost first: its own, then its nested state or `screen` params. */
function openedNames(route: AnyRoute): string[] {
  const names: string[] = [];
  for (let current: AnyRoute | undefined = route; current;) {
    names.push(current.name);
    const nested = current.state;
    const params = current.params as { screen?: unknown; params?: object } | undefined;
    current = nested?.routes.length ? nested.routes[nested.index ?? nested.routes.length - 1]
      : typeof params?.screen === 'string' ? { name: params.screen, params: params.params } : undefined;
  }
  return names;
}

function leavesQuest(state: NavigationState, next: NavigationState | PartialState<NavigationState>, action: NavigationAction): boolean {
  if (!guard) return false;
  const before = state.routes[state.index];
  const after = next.routes[next.index ?? next.routes.length - 1] as AnyRoute | undefined;
  // Same focus (params, a nested navigator's own move): that navigator decides.
  if (!after || (after.key !== undefined && after.key === before?.key)) return false;
  // Back to a screen already open: native gestures pop before JS hears of them.
  if (state.type !== 'tab' && state.routes.some(route => route.key === after.key)) return false;
  // A nested target travels in the action's params until its navigator renders.
  const params = (action.payload as { params?: { screen?: unknown } } | undefined)?.params;
  return holds(openedNames(typeof params?.screen === 'string' ? { ...after, params } : after));
}

/** `UNSTABLE_router` for the navigators users move through; see the file comment. */
export function questNavigationRouter<State extends NavigationState, Action extends NavigationAction>(
  original: Router<State, Action>,
): Partial<Router<State, Action>> {
  return {
    getStateForAction(state, action, options) {
      const next = original.getStateForAction(state, action, options);
      return next && next !== state && leavesQuest(state, next, action) ? state : next;
    },
  };
}
