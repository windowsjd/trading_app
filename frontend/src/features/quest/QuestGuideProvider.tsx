import { isTradingQuest, TRADING_GUIDE_STEPS } from './tradingGuideSteps';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { StackActions } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';
import { AppState, Keyboard, StyleSheet, View } from '../../theme/native';
import { useReducedMotion } from '../../theme/useReducedMotion';
import { rootNavigationRef } from '../../app/navigation/navigationRef';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { acknowledgeBeginnerQuest, getBeginnerQuestProgress } from '../tradingAccount/api';
import {
  getQuestGuideFacts,
  getQuestGuideVersion,
  setQuestGuideCommandSink,
  subscribeQuestGuide,
  type QuestGuideTargetId,
} from './questGuideBridge';
import {
  advanceGuide,
  claimGuideCommand,
  followGuideFocus,
  leaveGuideTab,
  observeGuideProgress,
  resolveGuideView,
  settleGuideVerification,
  startGuideSession,
  type FocusedGuideScreen,
  type GuideAction,
  type GuideSession,
} from './questGuideModel';
import type { BeginnerQuestKey, BeginnerQuests } from './questProgress';
import QuestGuideOverlay from './QuestGuideOverlay';

/** Long enough to read "퀘스트 완료!", short enough not to hold the user. */
const CELEBRATION_MS = 2100;
const REDUCED_CELEBRATION_MS = 1700;
const REPLAY_SUCCESS_MS = 1100;
/** The overlay fades over the tab switch underneath it. */
const LEAVE_MS = 260;
const HIGHLIGHT_MS = 8000;

export type QuestGuideStatus = Pick<GuideSession, 'accountId' | 'quest' | 'phase' | 'replay' | 'step' | 'orderId' | 'assetId' | 'positionId'> | null;

type QuestGuideContextValue = {
  active: QuestGuideStatus;
  /** Increments whenever the guide brings the user back to the quest list. */
  returnCount: number;
  /** A quest whose completion was just celebrated, for a brief list highlight. */
  justCompleted: BeginnerQuestKey | null;
  highlightedTarget: QuestGuideTargetId | null;
  /** The quest whose latest server progress is being read before its guide opens. */
  starting: BeginnerQuestKey | null;
  /**
   * Always a new guide. Where it begins comes from a fresh server read, so
   * steps the ledger already proves (a fill, an open order or position) are
   * reviewed, never repeated; a failed read starts nothing.
   */
  start: (quest: BeginnerQuestKey) => void;
};

const QuestGuideContext = createContext<QuestGuideContextValue | null>(null);

/** null outside a beginner account's MainTabs (no guide is offered there). */
export function useQuestGuide() {
  return useContext(QuestGuideContext);
}

/** 이체 is a bottom sheet over Wallet: its mounted form is the practice screen. */
const walletOrTransfer = (): FocusedGuideScreen => (getQuestGuideFacts('transfer') ? 'transfer' : 'wallet');

function readFocusedScreen(): FocusedGuideScreen {
  if (!rootNavigationRef.isReady()) return 'other';
  switch (rootNavigationRef.getCurrentRoute()?.name) {
    case 'Wallet': return walletOrTransfer();
    case 'WalletFx': return 'fx';
    case 'Guide': return 'quests';
    case 'Market': return 'market';
    case 'AssetDetail': return 'asset';
    case 'Order': return 'order';
    case 'Futures': return 'futures';
    default: return 'other';
  }
}

function readFocusedTab(): string | null {
  if (!rootNavigationRef.isReady()) return null;
  const tabs = rootNavigationRef.getRootState()?.routes.find(route => route.name === 'MainTabs')?.state;
  return tabs && typeof tabs.index === 'number' ? tabs.routes[tabs.index]?.name ?? null : null;
}

const openQuestList = () => rootNavigationRef.navigate('MainTabs', { screen: 'QuestTab', params: { screen: 'Guide', pop: true } });

/** After the return, close the finished practice screen out of sight. */
function popWalletStackToRoot() {
  if (!rootNavigationRef.isReady()) return;
  const tabs = rootNavigationRef.getRootState()?.routes.find(route => route.name === 'MainTabs')?.state;
  for (const tab of ['WalletTab', 'MarketTab']) {
    const stack = tabs?.routes.find(route => route.name === tab)?.state;
    if (stack?.key && typeof stack.index === 'number' && stack.index > 0) rootNavigationRef.dispatch({ ...StackActions.popToTop(), target: stack.key });
  }
}

function openPractice(session: GuideSession) {
  if (!isTradingQuest(session.quest)) {
    rootNavigationRef.navigate('MainTabs', { screen: 'WalletTab', params: { screen: 'Wallet', pop: true } });
  } else if (session.quest === 'futuresLong' || session.quest === 'futuresShort') {
    rootNavigationRef.navigate('MainTabs', { screen: 'MarketTab', params: { screen: 'Futures', params: { accountId: session.accountId } } });
  } else if (session.assetId) {
    // Holdings, TP/SL and limit review steps live on the order screen of that asset.
    if (TRADING_GUIDE_STEPS[session.quest][session.step]?.screen === 'order') {
      rootNavigationRef.navigate('MainTabs', { screen: 'MarketTab', params: { screen: 'Order', params: {
        assetId: session.assetId, accountId: session.accountId, side: session.quest === 'marketSell' ? 'sell' : 'buy' }, pop: true } });
    } else {
      rootNavigationRef.navigate('MainTabs', { screen: 'MarketTab', params: { screen: 'AssetDetail', params: { assetId: session.assetId }, pop: true } });
    }
  } else {
    rootNavigationRef.navigate('MainTabs', { screen: 'MarketTab', params: { screen: 'Market', params: { assetType: session.quest === 'krStock' ? 'domestic_stock' : session.quest === 'usStock' ? 'us_stock' : 'crypto' }, pop: true } });
  }
}

/**
 * The beginner quest guide for ONE account. MainTabs mounts it keyed by the
 * accountId, so a switch or logout discards the session with the navigator.
 * It never sends a financial request: it navigates, points, and — after a
 * screen reports its own successful command — re-reads the server's
 * ledger-derived progress before celebrating anything.
 *
 * A guide lives only while the user stays in its practice tab: leaving for the
 * quest list or another tab ends it, and there is no resuming. Starting again
 * is a new guide placed by the server's progress, never by a remembered step.
 */
export function QuestGuideProvider({ accountId, children }: { accountId: string; children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const reducedMotion = useReducedMotion();
  const [session, setSessionState] = useState<GuideSession | null>(null);
  const sessionRef = useRef<GuideSession | null>(null);
  const counter = useRef(0);
  const [focused, setFocused] = useState<FocusedGuideScreen>(readFocusedScreen);
  const [starting, setStarting] = useState<BeginnerQuestKey | null>(null);
  const focusedTab = useRef(readFocusedTab());
  const [returnCount, setReturnCount] = useState(0);
  const [justCompleted, setJustCompleted] = useState<BeginnerQuestKey | null>(null);
  const [foreground, setForeground] = useState(AppState.currentState == null || AppState.currentState === 'active');
  // Re-render on screen facts/targets; the view below is derived each render.
  useSyncExternalStore(subscribeQuestGuide, getQuestGuideVersion, getQuestGuideVersion);

  // The ref is the source of truth so callbacks fired from a screen's
  // mutation (outside render) always see the current session.
  const setSession = useCallback((update: GuideSession | null | ((current: GuideSession | null) => GuideSession | null)) => {
    const next = typeof update === 'function' ? update(sessionRef.current) : update;
    sessionRef.current = next;
    setSessionState(next);
  }, []);

  const fetchProgress = useCallback(() => queryClient.fetchQuery({
    queryKey: QUERY_KEYS.tradingAccount.quests(accountId),
    queryFn: () => getBeginnerQuestProgress(accountId),
    staleTime: 0,
    retry: 1,
  }), [accountId, queryClient]);

  const verify = useCallback((sessionId: number) => {
    const settle = (progress: BeginnerQuests | null) =>
      setSession(current => current?.id === sessionId ? settleGuideVerification(current, progress) : current);
    const current = sessionRef.current;
    const stepId = current?.quest === 'marketBuy' ? 'holdings_reviewed' : current?.quest === 'limitBuy' ? 'limit_result_reviewed' : null;
    const pending = current?.id === sessionId && current.orderId && stepId
      ? acknowledgeBeginnerQuest(accountId, stepId, current.orderId).then(progress => {
          queryClient.setQueryData(QUERY_KEYS.tradingAccount.quests(accountId), progress);
          return progress;
        }) : fetchProgress();
    void pending.then(settle, () => settle(null));
  }, [accountId, queryClient, fetchProgress, setSession]);

  useEffect(() => {
    const update = () => {
      const next = readFocusedScreen();
      const tab = readFocusedTab();
      // Only a tab switch can be a departure; moves inside one tab never are.
      const switched = tab !== focusedTab.current;
      focusedTab.current = tab;
      setFocused(next);
      setSession(current => {
        const kept = current && switched ? leaveGuideTab(current, tab) : current;
        return kept ? followGuideFocus(kept, next) : null;
      });
    };
    update();
    return rootNavigationRef.addListener('state', update);
  }, [setSession]);

  useEffect(() => setQuestGuideCommandSink(command => {
    const outcome = claimGuideCommand(sessionRef.current, accountId, command);
    if (outcome.session !== sessionRef.current) setSession(outcome.session);
    if (outcome.claimed && outcome.session?.phase === 'verifying') verify(outcome.session.id);
    // A claimed fill (step 7) is reviewed right below the order form: no navigation.
    return outcome.claimed;
  }, () => sessionRef.current?.id ?? null), [accountId, setSession, verify]);

  // Back from the background: re-read the server instead of trusting memory.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      setForeground(state === 'active');
      const current = sessionRef.current;
      if (state !== 'active' || !current) return;
      if (current.phase === 'verifying' || current.phase === 'unconfirmed') {
        setSession({ ...current, phase: 'verifying' });
        verify(current.id);
      } else if (current.phase === 'guiding' && !current.replay) {
        void fetchProgress().then(progress => {
          const pending = getQuestGuideFacts('fx')?.pending === true || getQuestGuideFacts('transfer')?.pending === true;
          setSession(latest => latest?.id === current.id ? observeGuideProgress(latest, progress, pending) : latest);
        }, () => undefined);
      }
    });
    return () => subscription.remove();
  }, [fetchProgress, setSession, verify]);

  const phase = session?.phase;
  const sessionId = session?.id;
  useEffect(() => {
    if (!foreground || (phase !== 'celebrating' && phase !== 'replaySucceeded') || sessionId === undefined) return;
    const timer = setTimeout(() => {
      const current = sessionRef.current;
      if (current?.id !== sessionId) return;
      setSession({ ...current, phase: 'returning' });
      if (!current.replay) setJustCompleted(current.quest);
      setReturnCount(count => count + 1);
      openQuestList();
    }, phase === 'replaySucceeded' ? REPLAY_SUCCESS_MS : reducedMotion ? REDUCED_CELEBRATION_MS : CELEBRATION_MS);
    return () => clearTimeout(timer);
  }, [foreground, phase, sessionId, reducedMotion, setSession]);

  useEffect(() => {
    if (!foreground || phase !== 'returning' || sessionId === undefined) return;
    const timer = setTimeout(() => {
      if (sessionRef.current?.id !== sessionId) return;
      setSession(current => current?.id === sessionId ? null : current);
      popWalletStackToRoot();
    }, LEAVE_MS);
    return () => clearTimeout(timer);
  }, [foreground, phase, sessionId, setSession]);

  useEffect(() => {
    if (!justCompleted) return;
    const timer = setTimeout(() => setJustCompleted(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [justCompleted]);

  // A start still reading progress when the account's guide goes away opens nothing.
  useEffect(() => () => { counter.current += 1; }, []);

  const start = useCallback((quest: BeginnerQuestKey) => {
    const id = ++counter.current;
    Keyboard.dismiss();
    setJustCompleted(null);
    setSession(null);
    setStarting(quest);
    const begin = (progress: BeginnerQuests | null) => {
      // A later start superseded this one, or the user left the list meanwhile.
      if (counter.current !== id) return;
      setStarting(null);
      const next = readFocusedScreen() === 'quests' ? startGuideSession(id, accountId, quest, progress) : null;
      if (!next) return;
      setSession(next);
      openPractice(next);
    };
    void fetchProgress().then(begin, () => begin(null));
  }, [accountId, fetchProgress, setSession]);

  // Opening/closing the transfer sheet changes no route; follow it like one
  // (closing it returns to the Wallet entry step, as leaving the page did).
  const effectiveFocus: FocusedGuideScreen = focused === 'wallet' || focused === 'transfer' ? walletOrTransfer() : focused;
  useEffect(() => {
    setSession(current => current ? followGuideFocus(current, effectiveFocus) : current);
  }, [effectiveFocus, setSession]);

  const onAction = useCallback((action: GuideAction, step: number | null) => {
    const current = sessionRef.current;
    if (!current) return;
    if (action === 'next') {
      if (step === null) return;
      Keyboard.dismiss();
      if (current.phase !== 'guiding') return;
      if (step === 7 && current.orderId && ['marketBuy', 'limitBuy', 'krStock', 'usStock'].includes(current.quest)) {
        setSession({ ...current, phase: 'verifying' });
        verify(current.id);
      } else setSession(advanceGuide(current, step));
    } else if (action === 'retry') {
      setSession({ ...current, phase: 'verifying' });
      verify(current.id);
    } else {
      setSession(null);
      if (action === 'back') openQuestList();
    }
  }, [setSession, verify]);

  const view = resolveGuideView(session, foreground ? effectiveFocus : 'other', {
    practice: { market: getQuestGuideFacts('market'), asset: getQuestGuideFacts('asset'), order: getQuestGuideFacts('order'), futures: getQuestGuideFacts('futures'),
      holdings: getQuestGuideFacts('holdings'), protection: getQuestGuideFacts('protection'), limitReview: getQuestGuideFacts('limitReview') },
    wallet: getQuestGuideFacts('wallet'),
    fx: getQuestGuideFacts('fx'),
    transfer: getQuestGuideFacts('transfer'),
  });

  const activeQuest = session?.quest;
  const activeReplay = session?.replay;
  const highlightedTarget = foreground && view.kind === 'spotlight' ? view.targets[0] : null;
  const value = useMemo<QuestGuideContextValue>(() => ({
    active: activeQuest && phase && activeReplay !== undefined && session ? { accountId, quest: activeQuest, phase, replay: activeReplay, step: session.step, orderId: session.orderId, assetId: session.assetId, positionId: session.positionId } : null,
    returnCount,
    justCompleted,
    highlightedTarget,
    starting,
    start,
  }), [accountId, session, activeQuest, activeReplay, highlightedTarget, justCompleted, phase, returnCount, starting, start]);

  return (
    <QuestGuideContext.Provider value={value}>
      <View style={styles.host}>
        {children}
        <QuestGuideOverlay view={view} quest={session?.quest ?? null} reducedMotion={reducedMotion} onAction={onAction} />
      </View>
    </QuestGuideContext.Provider>
  );
}

const styles = StyleSheet.create({
  host: { flex: 1 },
});
