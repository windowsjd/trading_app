import React from 'react';
import TopNoticeBanner, { type BannerActionOutcome } from '../../components/common/TopNoticeBanner';
import type { FillNotice } from './fillTracker';

/** Visible time after the entrance; long enough to read the title and act. */
export const FILL_BANNER_VISIBLE_MS = 4000;
/** After a held 내역 보기: time to read why, end the guide and press again. */
export const FILL_BANNER_HELD_MS = 10_000;

/**
 * What 내역 보기 did. Only `opened` moved anywhere; the banner stays (and
 * says why) when an active beginner guide held the move or navigation is
 * not ready yet.
 */
export type FillHistoryOutcome = BannerActionOutcome;

const NOT_OPENED: Record<Exclude<FillHistoryOutcome, 'opened'>, string> = {
  held: '학습 안내 중이라 거래 내역을 열지 않았어요. 안내를 종료한 뒤 다시 눌러 주세요.',
  unavailable: '지금은 거래 내역을 열 수 없어요. 잠시 후 다시 눌러 주세요.',
};

/**
 * Non-blocking top banner for one real fill (reference video 2), in the app's
 * one top-banner place (TopNoticeBanner): it drops in, stays a few seconds
 * and leaves. Reduced Motion shows and hides it without movement.
 */
export default function OrderFillBanner({ notice, onDone, onOpenHistory }: {
  notice: FillNotice | null;
  onDone: () => void;
  onOpenHistory: (notice: FillNotice) => FillHistoryOutcome;
}) {
  // A folded condition-met notice is not a fill: the count then names none.
  const overflow = notice?.overflow ? `외 ${notice.overflow}건${notice.overflowMixed ? '' : ' 체결'}` : null;
  const detail = notice ? [notice.detail, overflow].filter(Boolean).join(' · ') || null : null;
  return (
    <TopNoticeBanner
      channel="order-fill"
      notice={notice ? { id: notice.id, title: notice.title, detail } : null}
      visibleMs={FILL_BANNER_VISIBLE_MS}
      heldMs={FILL_BANNER_HELD_MS}
      icon={{ glyph: '✓', tone: 'success' }}
      actionLabel="내역 보기"
      actionTestID="order-fill-banner-history"
      notOpened={NOT_OPENED}
      testID="order-fill-banner"
      onAction={() => (notice ? onOpenHistory(notice) : 'unavailable')}
      onDone={onDone}
    />
  );
}
