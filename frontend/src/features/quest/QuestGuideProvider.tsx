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
import { getBeginnerQuestProgress } from '../tradingAccount/api';
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
  observeGuideProgress,
  resolveGuideView,
  settleGuideVerification,
  startGuideSession,
  type FocusedGuideScreen,
  type GuideAction,
  type GuidePhase,
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

export type QuestGuideStatus = { quest: BeginnerQuestKey; phase: GuidePhase; replay: boolean } | null;

type QuestGuideContextValue = {
  active: QuestGuideStatus;
  /** Increments whenever the guide brings the user back to the quest list. */
  returnCount: number;
  /** A quest whose completion was just celebrated, for a brief list highlight. */
  justCompleted: BeginnerQuestKey | null;
  highlightedTarget: QuestGuideTargetId | null;
  start: (quest: BeginnerQuestKey, progress: BeginnerQuests) => void;
  resume: () => void;
  exit: () => void;
};

const QuestGuideContext = createContext<QuestGuideContextValue | null>(null);

/** null outside a beginner account's MainTabs (no guide is offered there). */
export function useQuestGuide() {
  return useContext(QuestGuideContext);
}

function readFocusedScreen(): FocusedGuideScreen {
  if (!rootNavigationRef.isReady()) return 'other';
  switch (rootNavigationRef.getCurrentRoute()?.name) {
    case 'Wallet': return 'wallet';
    case 'WalletFx': return 'fx';
    case 'WalletTransfer': return 'transfer';
    case 'Guide': return 'quests';
    default: return 'other';
  }
}

const openQuestList = () => rootNavigationRef.navigate('MainTabs', { screen: 'QuestTab', params: { screen: 'Guide', pop: true } });

/** After the return, close the finished practice screen out of sight. */
function popWalletStackToRoot() {
  if (!rootNavigationRef.isReady()) return;
  const tabs = rootNavigationRef.getRootState()?.routes.find(route => route.name === 'MainTabs')?.state;
  const wallet = tabs?.routes.find(route => route.name === 'WalletTab')?.state;
  if (wallet?.key && typeof wallet.index === 'number' && wallet.index > 0) {
    rootNavigationRef.dispatch({ ...StackActions.popToTop(), target: wallet.key });
  }
}

/**
 * The beginner quest guide for ONE account. MainTabs mounts it keyed by the
 * accountId, so a switch or logout discards the session with the navigator.
 * It never sends a financial request: it navigates, points, and — after a
 * screen reports its own successful command — re-reads the server's
 * ledger-derived progress before celebrating anything.
 */
export function QuestGuideProvider({ accountId, children }: { accountId: string; children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const reducedMotion = useReducedMotion();
  const [session, setSessionState] = useState<GuideSession | null>(null);
  const sessionRef = useRef<GuideSession | null>(null);
  const counter = useRef(0);
  const [focused, setFocused] = useState<FocusedGuideScreen>(readFocusedScreen);
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
    void fetchProgress().then(settle, () => settle(null));
  }, [fetchProgress, setSession]);

  useEffect(() => {
    const update = () => {
      const next = readFocusedScreen();
      setFocused(next);
      setSession(current => current ? followGuideFocus(current, next) : current);
    };
    update();
    return rootNavigationRef.addListener('state', update);
  }, [setSession]);

  useEffect(() => setQuestGuideCommandSink(command => {
    const outcome = claimGuideCommand(sessionRef.current, accountId, command);
    if (outcome.session !== sessionRef.current) setSession(outcome.session);
    if (outcome.claimed && outcome.session?.phase === 'verifying') verify(outcome.session.id);
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

  const start = useCallback((quest: BeginnerQuestKey, progress: BeginnerQuests) => {
    const next = startGuideSession(++counter.current, accountId, quest, progress);
    if (!next) return;
    Keyboard.dismiss();
    setJustCompleted(null);
    setSession(next);
    // Straight to the Wallet tab's main screen, closing a leftover practice screen.
    rootNavigationRef.navigate('MainTabs', { screen: 'WalletTab', params: { screen: 'Wallet', pop: true } });
  }, [accountId, setSession]);

  const resume = useCallback(() => {
    if (sessionRef.current) rootNavigationRef.navigate('MainTabs', { screen: 'WalletTab' });
  }, []);

  const exit = useCallback(() => setSession(null), [setSession]);

  const onAction = useCallback((action: GuideAction, step: number | null) => {
    const current = sessionRef.current;
    if (!current) return;
    if (action === 'next') {
      if (step === null) return;
      Keyboard.dismiss();
      setSession(advanceGuide(current, step));
    } else if (action === 'retry') {
      setSession({ ...current, phase: 'verifying' });
      verify(current.id);
    } else {
      setSession(null);
      if (action === 'back') openQuestList();
    }
  }, [setSession, verify]);

  const view = resolveGuideView(session, foreground ? focused : 'other', {
    wallet: getQuestGuideFacts('wallet'),
    fx: getQuestGuideFacts('fx'),
    transfer: getQuestGuideFacts('transfer'),
  });

  const activeQuest = session?.quest;
  const activeReplay = session?.replay;
  const highlightedTarget = foreground && view.kind === 'spotlight' ? view.targets[0] : null;
  const value = useMemo<QuestGuideContextValue>(() => ({
    active: activeQuest && phase && activeReplay !== undefined ? { quest: activeQuest, phase, replay: activeReplay } : null,
    returnCount,
    justCompleted,
    highlightedTarget,
    start,
    resume,
    exit,
  }), [activeQuest, activeReplay, exit, highlightedTarget, justCompleted, phase, resume, returnCount, start]);

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
