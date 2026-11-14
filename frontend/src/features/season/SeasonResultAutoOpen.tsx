import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AppState } from '../../theme/native';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { rootNavigationRef } from '../../app/navigation/navigationRef';
import { useTradingAccount } from '../tradingAccount/TradingAccountContext';
import { useQuestGuide } from '../quest/QuestGuideProvider';
import { useEntryOverlaySlot } from '../entryOverlay/EntryOverlaySlot';
import { getMySeasonFinalResult } from '../record/api';
import type { MeDto } from '../me/api';
import {
  AUTO_OPEN_DELAY_MS,
  OPEN_GIVE_UP_MS,
  RESULT_RETRY_LIMIT,
  RESULT_RETRY_MS,
  SETTLEMENT_POLL_MS,
  awaitsSettlement,
  pendingResultAccount,
  canAutoOpen,
  hasFinalResultOnStack,
  isAtHomeRoot,
  seasonMayChange,
  unseenSettledSeason,
} from './seasonResultRules';

/** Opened by this in the app run, per member and season: never pushed twice, even when recording the view failed. */
const openedThisRun = new Set<string>();

const readRoot = () => (rootNavigationRef.isReady() ? rootNavigationRef.getRootState() : undefined);
const readPlaces = () => {
  const root = readRoot();
  return { atHome: !!root && isAtHomeRoot(root), resultOpen: hasFinalResultOnStack(root) };
};

/** Where the member is, followed live: Home's first screen, and whether a result screen is open. */
function useRootPlaces() {
  const [places, setPlaces] = useState(readPlaces);
  useEffect(() => {
    const update = () => setPlaces((current) => {
      const next = readPlaces();
      return current.atHome === next.atHome && current.resultOpen === next.resultOpen ? current : next;
    });
    update();
    return rootNavigationRef.addListener('state', update);
  }, []);
  return places;
}

/** Whether the app is in front (no reads are scheduled from the background). */
function useAppActive() {
  const [active, setActive] = useState(() => AppState.currentState !== 'background' && AppState.currentState !== 'inactive');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setActive(state === 'active'));
    return () => subscription.remove();
  }, []);
  return active;
}

/**
 * 시즌최종결과 자동 표시 (2026-11-14), inside MainTabs beside the 업데이트
 * 안내 and the 공지 팝업, for a signed-in member's owned pending season result.
 *
 * - While that season awaits settlement (`ended`), the owned list is re-read
 *   every 30 s with the app in front, independently of operating selection.
 *   Coming back to the front re-reads it at once.
 * - Once the server reports it settled with the result unseen (explicit
 *   null), the result is read; only a shown, unseen result of that very
 *   season may open — never before settlement, never a guess.
 * - It opens the existing 시즌최종결과 screen once per run, only on Home's
 *   first screen (never over an order, a chart or another screen), not while a
 *   beginner guide runs, and only through the one entry-overlay slot, so it
 *   never meets the 업데이트 안내 or the 공지 팝업 (it keeps the slot while
 *   the result is open). The screen records the view after showing it.
 * - Switching account or signing out cancels anything pending. A failed
 *   read shows nothing and blocks nothing; it is retried a few times.
 */
export default function SeasonResultAutoOpen({ enabled }: { enabled: boolean }) {
  const { selectedAccount, accounts = [], refetchAccounts } = useTradingAccount();
  const me = useQuery<MeDto>({ queryKey: QUERY_KEYS.me, enabled: false }).data;
  const userId = enabled ? (me?.id ?? null) : null;
  const account = userId ? pendingResultAccount(accounts, selectedAccount) : null;
  const guiding = !!useQuestGuide()?.active;
  const { atHome, resultOpen } = useRootPlaces();
  const appActive = useAppActive();

  // 1. Settlement watch: the selected season account, the app in front only.
  const waiting = appActive && awaitsSettlement(account);
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = setInterval(() => void refetchAccounts(), SETTLEMENT_POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, refetchAccounts]);

  // 2. The candidate and the server's result for it.
  const candidate = unseenSettledSeason(account);
  const key = candidate && userId ? `${userId}:${candidate.accountId}:${candidate.seasonId}` : null;
  const candidateSeasonId = candidate?.seasonId ?? '';
  const result = useQuery({
    queryKey: QUERY_KEYS.record.seasonFinalResult(candidateSeasonId),
    queryFn: () => getMySeasonFinalResult(candidateSeasonId),
    enabled: !!key && !openedThisRun.has(key),
    retry: 1,
    refetchInterval: (read) =>
      read.state.status === 'error' && read.state.errorUpdateCount < RESULT_RETRY_LIMIT && AppState.currentState === 'active'
        ? RESULT_RETRY_MS : false,
  });

  // Back to the front: whatever may have changed meanwhile is read again.
  // (Read during render, so a failure re-renders and the ref is current.)
  const resultFailed = result.isError;
  const latest = useRef({ account, key, refetchAccounts, resultFailed, refetchResult: result.refetch });
  latest.current = { account, key, refetchAccounts, resultFailed, refetchResult: result.refetch };
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      const current = latest.current;
      if (seasonMayChange(current.account)) void current.refetchAccounts();
      if (current.key && current.resultFailed) void current.refetchResult();
    });
    return () => subscription.remove();
  }, []);

  // 3. Open it once, at the safe place, holding the entry-overlay slot.
  const [opening, setOpening] = useState<{ key: string; shown: boolean } | null>(null);
  const ready = !!key && !!candidate && !openedThisRun.has(key) && canAutoOpen(result.data, candidate.seasonId) &&
    atHome && !resultOpen && !guiding && appActive;
  const granted = useEntryOverlaySlot('seasonResult', ready || !!opening);
  const seasonId = candidate?.seasonId;
  useEffect(() => {
    if (!ready || !granted || opening || !key || !seasonId) return undefined;
    const timer = setTimeout(() => {
      // At the moment of moving: still this member, account and season, still on Home.
      const root = readRoot();
      if (latest.current.key !== key || !root || !isAtHomeRoot(root) || hasFinalResultOnStack(root)) return;
      openedThisRun.add(key);
      setOpening({ key, shown: false });
      rootNavigationRef.navigate('SeasonFinalResult', { seasonId });
    }, AUTO_OPEN_DELAY_MS);
    return () => clearTimeout(timer);
  }, [ready, granted, opening, key, seasonId]);

  // The slot stays taken while the result is on screen and is given back when it closes.
  useEffect(() => {
    if (!opening) return undefined;
    if (resultOpen) {
      if (!opening.shown) setOpening({ ...opening, shown: true });
      return undefined;
    }
    if (opening.shown) {
      setOpening(null);
      return undefined;
    }
    const timer = setTimeout(() => setOpening(null), OPEN_GIVE_UP_MS);
    return () => clearTimeout(timer);
  }, [opening, resultOpen]);

  return null;
}
