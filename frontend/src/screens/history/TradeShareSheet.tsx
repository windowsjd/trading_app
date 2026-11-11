import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PixelRatio, ScrollView, Text, View, useWindowDimensions } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import InlineBottomSheet from '../../components/common/InlineBottomSheet';
import { SheetPortal } from '../../components/common/ScreenSheetHost';
import SegmentedControl from '../../components/common/SegmentedControl';
import ActionPressable from '../../components/common/ActionPressable';
import ErrorNotice from '../../components/states/ErrorNotice';
import TradeShareCard, { SHARE_CARD_DESIGN, type ShareCardReadiness } from '../../components/share/TradeShareCard';
import ShareActionIcon from '../../components/share/ShareActionIcon';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { getMe } from '../../features/me/api';
import type { CompletedTrade } from '../../features/tradingAccount/api';
import {
  SHARE_CAPTURE_SUPPORTED,
  captureShareCard,
  openShareSheet,
  saveToPhotos,
  type CapturedShareImage,
} from '../../features/share/shareImage';
import { shareOutcomeMessage, type ShareAction, type ShareOutcome } from '../../features/share/shareTargets';
import {
  canShareReturnRate,
  describeShareCard,
  getTradeShareCard,
  resolveShareMetric,
  type ShareMetric,
} from '../../features/share/tradeShareDisplay';
import { getSessionGeneration, isCurrentSession } from '../../services/api/sessionOwnership';

/**
 * 수익 공유: the card of one completed trade, its 수익금액/수익률 choice, 공유하기
 * (the system share sheet, where the user picks KakaoTalk, Instagram, Telegram
 * or any other app) and 이미지 저장. The choice is screen state only; nothing is
 * sent to the server. One action runs at a time, each on a capture of exactly
 * the card on screen; closing the sheet, leaving the screen or a session change
 * drops an action in flight before anything is shared.
 */
export default function TradeShareSheet({ accountId, trade, onClose }: {
  accountId: string;
  /** Open while set. */
  trade: CompletedTrade | null;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <SheetPortal>
      <InlineBottomSheet testID="trade-share-sheet" title="수익 공유" visible={!!trade} dismissible={!busy} onClose={onClose}>
        <ScrollView testID="trade-share-scroll" style={styles.scroll} contentContainerStyle={styles.content}>
          {trade ? <ShareBody key={`${accountId}:${trade.key}`} trade={trade} onBusyChange={setBusy} /> : null}
        </ScrollView>
      </InlineBottomSheet>
    </SheetPortal>
  );
}

function ShareBody({ trade, onBusyChange }: { trade: CompletedTrade; onBusyChange: (busy: boolean) => void }) {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const me = useQuery({ queryKey: QUERY_KEYS.me, queryFn: getMe, staleTime: 60_000 });
  const [requested, setRequested] = useState<ShareMetric>('amount');
  const metric = resolveShareMetric(trade, requested);
  const card = useMemo(() => getTradeShareCard(trade, metric), [trade, metric]);
  const [readiness, setReadiness] = useState<ShareCardReadiness>('loading');
  const [running, setRunning] = useState<ShareAction | null>(null);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  const cardRef = useRef<View>(null);
  const lock = useRef(false);
  const alive = useRef(true);
  const capture = useRef<{ key: string; image: CapturedShareImage } | null>(null);
  useEffect(() => () => {
    alive.current = false;
  }, []);
  useEffect(() => {
    onBusyChange(running !== null);
    return () => onBusyChange(false);
  }, [onBusyChange, running]);

  const profile = me.data ?? null;
  // Exactly what is on screen: a changed figure, nickname or photo is a new image.
  const contentKey = JSON.stringify([trade.key, metric, profile?.id, profile?.nickname, profile?.profileImageUrl]);
  // The card's natural size is 1080 × 1920 device pixels; the preview shows it scaled.
  const cardWidth = SHARE_CARD_DESIGN.width / PixelRatio.get();
  const cardHeight = SHARE_CARD_DESIGN.height / PixelRatio.get();
  const previewHeight = Math.max(220, Math.min(460, windowHeight * 0.48, ((windowWidth - 64) * 16) / 9));
  const previewWidth = (previewHeight * 9) / 16;
  const scale = previewWidth / cardWidth;
  const rateAvailable = canShareReturnRate(trade);
  const actionsReady = SHARE_CAPTURE_SUPPORTED && !!profile && readiness === 'ready';

  const run = useCallback(async (action: ShareAction) => {
    if (lock.current || !profile) return;
    lock.current = true;
    setRunning(action);
    setStatus(null);
    const owner = getSessionGeneration();
    const current = () => alive.current && isCurrentSession(owner);
    const say = (outcome: ShareOutcome) => {
      const text = current() ? shareOutcomeMessage(outcome, action) : null;
      setStatus(text ? { text, error: outcome !== 'saved' } : null);
    };
    try {
      if (!SHARE_CAPTURE_SUPPORTED) return say('unsupported');
      let image = capture.current?.key === contentKey ? capture.current.image : null;
      if (!image) {
        try {
          image = await captureShareCard(cardRef);
        } catch {
          return say('capture_failed');
        }
        capture.current = { key: contentKey, image };
      }
      if (!current()) return;
      const outcome = action === 'save' ? await saveToPhotos(image) : await openShareSheet(image);
      // A finished or dismissed share sheet needs no message: closing it is not a failure.
      say(outcome);
    } catch {
      // The device layer answers outcomes; anything it throws is still a failure, never silence.
      say('failed');
    } finally {
      lock.current = false;
      if (alive.current) setRunning(null);
    }
  }, [contentKey, profile]);

  if (me.isPending)
    return <Text testID="trade-share-profile-loading" style={styles.helper}>프로필을 불러오고 있어요.</Text>;
  if (!profile)
    return (
      <View style={styles.body}>
        <ErrorNotice testID="trade-share-profile-error" error={me.error} message="프로필을 불러오지 못해 카드를 만들 수 없어요." style={styles.error} />
        <ActionPressable testID="trade-share-profile-retry" accessibilityRole="button" style={styles.retry} onPress={() => void me.refetch()}>
          <Text style={styles.retryText}>다시 시도</Text>
        </ActionPressable>
      </View>
    );

  return (
    <View style={styles.body} testID="trade-share-body">
      <View style={[styles.preview, { width: previewWidth, height: previewHeight }]}
        accessible accessibilityRole="image" accessibilityLabel={describeShareCard(card, profile.nickname)} testID="trade-share-preview">
        {/* Scaled from its top-left corner: the view the capture takes is this one, at its own size. */}
        <View style={{ width: cardWidth, height: cardHeight, transform: [
          { translateX: (-cardWidth * (1 - scale)) / 2 },
          { translateY: (-cardHeight * (1 - scale)) / 2 },
          { scale },
        ] }} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          <TradeShareCard key={profile.id} card={card} nickname={profile.nickname} profileImageUrl={profile.profileImageUrl}
            width={cardWidth} cardRef={cardRef} onReadinessChange={setReadiness} />
        </View>
      </View>
      <SegmentedControl testID="trade-share-metric" accessibilityLabel="공유할 값" value={metric}
        onChange={(next) => { if (!running) { setRequested(next); setStatus(null); } }}
        options={[
          { key: 'amount', label: '수익금액', testID: 'trade-share-metric-amount', disabled: !!running },
          { key: 'rate', label: '수익률', testID: 'trade-share-metric-rate', disabled: !!running || !rateAvailable },
        ]} />
      {rateAvailable ? null : (
        <Text testID="trade-share-rate-unavailable" style={styles.helper}>
          이 거래는 수익률을 계산할 기준 금액이 없어 수익금액만 공유할 수 있어요.
        </Text>
      )}
      <View style={styles.actions}>
        {ACTIONS.map(({ action, testID, label, busyLabel, accessibilityLabel }) => (
          <ActionPressable key={action} testID={testID} accessibilityRole="button" accessibilityLabel={accessibilityLabel}
            accessibilityState={{ disabled: !actionsReady || !!running, busy: running === action }} aria-disabled={!actionsReady || !!running}
            aria-busy={running === action} disabled={!actionsReady || !!running} onPress={() => void run(action)}
            style={[styles.action, action === 'share' && styles.primary, (!actionsReady || (running && running !== action)) && styles.dimmed]}>
            <ShareActionIcon action={action} />
            <Text style={[styles.actionText, action === 'share' && styles.primaryText]}>{running === action ? busyLabel : label}</Text>
          </ActionPressable>
        ))}
      </View>
      {status ? (
        <Text testID="trade-share-status" accessibilityLiveRegion="polite" style={status.error ? styles.error : styles.helper}>{status.text}</Text>
      ) : !SHARE_CAPTURE_SUPPORTED ? (
        <Text testID="trade-share-unsupported" style={styles.helper}>{shareOutcomeMessage('unsupported', 'share')}</Text>
      ) : readiness === 'failed' ? (
        <Text testID="trade-share-art-failed" style={styles.error}>카드 이미지를 불러오지 못했어요. 시트를 닫았다가 다시 열어 주세요.</Text>
      ) : readiness === 'loading' ? (
        <Text testID="trade-share-preparing" style={styles.helper}>카드를 준비하고 있어요.</Text>
      ) : null}
      <Text style={styles.footnote}>
        이미지는 이 기기에서만 만들어지고, 게시와 전송은 선택한 앱에서 직접 완료해요.
      </Text>
    </View>
  );
}

const ACTIONS: ReadonlyArray<{ action: ShareAction; testID: string; label: string; busyLabel: string; accessibilityLabel: string }> = [
  { action: 'share', testID: 'trade-share-open', label: '공유하기', busyLabel: '여는 중…', accessibilityLabel: '공유하기, 공유할 앱 선택' },
  { action: 'save', testID: 'trade-share-save', label: '이미지 저장', busyLabel: '저장하는 중…', accessibilityLabel: '이미지 저장' },
];

// Plain objects: harnesses load sheets with minimal native mocks. Labels wrap
// at large font sizes instead of clipping; the card itself never scales text.
const styles = {
  scroll: { flexGrow: 0 },
  content: { paddingTop: 4, paddingBottom: 8 },
  body: { gap: 14, minWidth: 0 },
  preview: { alignSelf: 'center', overflow: 'hidden', borderRadius: 18, backgroundColor: '#011733' },
  actions: { gap: 8 },
  dimmed: { opacity: 0.45 },
  action: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 48, borderRadius: 12,
    borderWidth: 1, borderColor: semantic.border, backgroundColor: semantic.raised, paddingHorizontal: 16, paddingVertical: 6 },
  primary: { borderColor: semantic.info },
  actionText: { flexShrink: 1, fontSize: 15, lineHeight: 22, fontWeight: '700', color: semantic.text, textAlign: 'center' },
  primaryText: { color: semantic.info },
  helper: { fontSize: 13, lineHeight: 20, color: semantic.secondary },
  error: { fontSize: 13, lineHeight: 20, color: semantic.error },
  footnote: { fontSize: 12, lineHeight: 18, color: semantic.secondary },
  retry: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 10, backgroundColor: semantic.raised },
  retryText: { fontSize: 14, lineHeight: 21, fontWeight: '700', color: semantic.text },
} as const;
