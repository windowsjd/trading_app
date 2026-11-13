import React, { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BackHandler, View } from '../../theme/native';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { SheetPortal } from '../../components/common/ScreenSheetHost';
import { rootNavigationRef } from '../../app/navigation/navigationRef';
import { useQuestGuide } from '../quest/QuestGuideProvider';
import { useEntryOverlaySlot } from '../entryOverlay/EntryOverlaySlot';
import type { MeDto } from '../me/api';
import { acknowledgeNotice, getPopupNotices } from './popupApi';
import { isAtTabRoot, nextPopupNotice, type PopupNotice } from './popupNotices';
import NoticePopupCard from './NoticePopupCard';

/** A short pause after the app settles (or the previous overlay closed) before the card appears. */
export const NOTICE_POPUP_DELAY_MS = 350;
const ACK_RETRY_MS = 5_000;

/** Confirmed in this app run, per member: never shown twice in a run even if the server write failed. */
const confirmedThisRun = new Map<string, Set<string>>();
const confirmedFor = (userId: string) => {
  let set = confirmedThisRun.get(userId);
  if (!set) confirmedThisRun.set(userId, (set = new Set()));
  return set;
};

const readAtTabRoot = () => !rootNavigationRef.isReady() || isAtTabRoot(rootNavigationRef.getRootState());

/** Whether the member is on a tab's first screen (normal app entry), followed live. */
function useAtTabRoot() {
  const [atRoot, setAtRoot] = useState(readAtTabRoot);
  useEffect(() => {
    const update = () => setAtRoot(readAtTabRoot());
    update();
    return rootNavigationRef.addListener('state', update);
  }, []);
  return atRoot;
}

/**
 * 공지 팝업 (2026-11-13) for the signed-in member, inside MainTabs: the
 * newest published notice marked for a popup that this member has not
 * confirmed (server state, so another device or a re-login does not show it
 * again), one at a time. Read once when the app is entered (MainTabs mounts);
 * it waits while a beginner guide is on screen, while the 업데이트 안내 holds
 * the entry slot, and until the member is on a tab's first screen — it never
 * covers an order or detail screen mid-task. 확인, closing (Android back)
 * and 자세히 보기 all confirm it; 자세히 보기 then opens the full notice in
 * 공지사항. A failed read or write shows nothing and blocks nothing.
 */
export default function NoticePopupHost({ enabled }: { enabled: boolean }) {
  // The session's `me` (seeded at sign-in): no member, no popup.
  const me = useQuery<MeDto>({ queryKey: QUERY_KEYS.me, enabled: false }).data;
  const userId = enabled ? (me?.id ?? null) : null;
  const guiding = !!useQuestGuide()?.active;
  const atRoot = useAtTabRoot();
  const popup = useQuery({
    queryKey: QUERY_KEYS.notices.popup(userId ?? ''),
    queryFn: ({ signal }) => getPopupNotices(signal),
    enabled: !!userId,
    // One read per app entry (sign-in / launch); logout clears the cache.
    staleTime: Infinity,
    retry: 1,
  });
  const [shown, setShown] = useState<PopupNotice | null>(null);
  const [, setConfirmedCount] = useState(0);
  const candidate = userId && popup.data ? nextPopupNotice(popup.data, confirmedFor(userId)) : null;
  const ready = !!candidate && !guiding && atRoot;
  const granted = useEntryOverlaySlot('notice', ready || !!shown);

  const candidateId = candidate?.id;
  useEffect(() => {
    if (!ready || !granted || shown || !candidate) return undefined;
    const timer = setTimeout(() => setShown(candidate), NOTICE_POPUP_DELAY_MS);
    return () => clearTimeout(timer);
    // The candidate object changes identity with every render of a new list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, granted, shown, candidateId]);

  const confirm = useCallback((notice: PopupNotice, openDetail: boolean) => {
    if (!userId) return;
    confirmedFor(userId).add(notice.id);
    setConfirmedCount((count) => count + 1);
    setShown(null);
    void acknowledgeNotice(notice.id).catch(() => {
      // One quiet retry; if it still fails, the next app entry shows it again.
      setTimeout(() => void acknowledgeNotice(notice.id).catch(() => undefined), ACK_RETRY_MS);
    });
    if (openDetail && rootNavigationRef.isReady())
      rootNavigationRef.navigate('MainTabs', {
        screen: 'MyTab',
        params: { screen: 'Notices', initial: false, params: { noticeId: notice.id, pushAt: Date.now() } },
      }, { pop: true });
  }, [userId]);

  useEffect(() => {
    if (!shown) return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      confirm(shown, false);
      return true;
    });
    return () => subscription.remove();
  }, [confirm, shown]);

  if (!shown) return null;
  return (
    <SheetPortal>
      <View testID="notice-popup" style={styles.layer}>
        <View pointerEvents="none" style={styles.dim} />
        <NoticePopupCard
          title={shown.title}
          summary={shown.summary}
          onDetail={() => confirm(shown, true)}
          onConfirm={() => confirm(shown, false)}
        />
      </View>
    </SheetPortal>
  );
}

// Plain objects: loaded by harnesses with minimal native mocks.
const styles = {
  layer: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', padding: 20 },
  dim: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)' },
} as const;
