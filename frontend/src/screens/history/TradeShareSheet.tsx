import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PixelRatio, Platform, ScrollView, Text, View, useWindowDimensions } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import InlineBottomSheet from '../../components/common/InlineBottomSheet';
import { SheetPortal } from '../../components/common/ScreenSheetHost';
import SegmentedControl from '../../components/common/SegmentedControl';
import ActionPressable from '../../components/common/ActionPressable';
import ErrorNotice from '../../components/states/ErrorNotice';
import TradeShareCard, { SHARE_CARD_DESIGN, type ShareCardReadiness } from '../../components/share/TradeShareCard';
import ShareTargetIcon from '../../components/share/ShareTargetIcon';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { getMe } from '../../features/me/api';
import type { CompletedTrade } from '../../features/tradingAccount/api';
import { META_APP_ID } from '../../features/share/shareConfig';
import {
  SHARE_CAPTURE_SUPPORTED,
  captureShareCard,
  isShareAppInstalled,
  openShareSheet,
  saveToPhotos,
  shareToInstagramStory,
  shareToTelegram,
  type CapturedShareImage,
} from '../../features/share/shareImage';
import {
  SHARE_TARGETS,
  planShareTarget,
  shareOutcomeMessage,
  type ShareOutcome,
  type ShareTarget,
} from '../../features/share/shareTargets';
import {
  canShareReturnRate,
  describeShareCard,
  getTradeShareCard,
  resolveShareMetric,
  type ShareMetric,
} from '../../features/share/tradeShareDisplay';
import { getSessionGeneration, isCurrentSession } from '../../services/api/sessionOwnership';

type Action = ShareTarget | 'save';

/**
 * 수익 공유: the card of one completed trade, its 수익금액/수익률 choice, the app
 * row (인스타그램 스토리 · 카카오톡 · 텔레그램 · 더보기) and 이미지 저장. The
 * choice is screen state only; nothing is sent to the server. One action runs
 * at a time, each on a fresh capture of exactly the card on screen; closing the
 * sheet, leaving the screen or a session change drops an action in flight
 * before anything is shared.
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
  const { width: windowWidth, height: windowHeight, fontScale } = useWindowDimensions();
  // Four apps across while a five-letter label fits its column; two by two at large text sizes.
  const targetWidth = 60 * fontScale <= (windowWidth - 44) / 4 ? '25%' : '50%';
  const me = useQuery({ queryKey: QUERY_KEYS.me, queryFn: getMe, staleTime: 60_000 });
  const [requested, setRequested] = useState<ShareMetric>('amount');
  const metric = resolveShareMetric(trade, requested);
  const card = useMemo(() => getTradeShareCard(trade, metric), [trade, metric]);
  const [readiness, setReadiness] = useState<ShareCardReadiness>('loading');
  const [running, setRunning] = useState<Action | null>(null);
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

  const run = useCallback(async (action: Action) => {
    if (lock.current || !profile) return;
    lock.current = true;
    setRunning(action);
    setStatus(null);
    const owner = getSessionGeneration();
    const current = () => alive.current && isCurrentSession(owner);
    const say = (outcome: ShareOutcome) => {
      const text = current() ? shareOutcomeMessage(outcome, action) : null;
      setStatus(text ? { text, error: !['opened', 'saved'].includes(outcome) } : null);
    };
    try {
      const plan = action === 'save' ? null : planShareTarget(action, Platform.OS, META_APP_ID);
      if (!SHARE_CAPTURE_SUPPORTED || plan?.kind === 'unsupported') return say('unsupported');
      if (plan?.kind === 'unconfigured') return say('unconfigured');
      const app = plan && 'app' in plan ? plan.app : null;
      if (app && !(await isShareAppInstalled(app))) return say('not_installed');
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
      if (plan?.kind === 'sheet' && plan.hint) setStatus({ text: plan.hint, error: false });
      const outcome =
        action === 'save' ? await saveToPhotos(image)
        : plan?.kind === 'instagram_story' ? await shareToInstagramStory(image, plan.appId)
        : plan?.kind === 'direct' ? await shareToTelegram(image)
        : await openShareSheet(image, plan?.kind === 'sheet' ? plan.hint : null);
      // A finished or dismissed share sheet needs no message (and the pick-an-app hint is done).
      if (outcome === 'shared' || outcome === 'cancelled') {
        if (current()) setStatus(null);
      } else say(outcome);
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
      <View style={styles.targets} accessibilityRole="toolbar" accessibilityLabel="공유할 앱">
        {SHARE_TARGETS.map(({ target, label, accessibilityLabel }) => (
          <ActionPressable key={target} testID={`trade-share-target-${target}`} accessibilityRole="button" accessibilityLabel={accessibilityLabel}
            accessibilityState={{ disabled: !actionsReady || !!running, busy: running === target }} aria-disabled={!actionsReady || !!running}
            aria-busy={running === target} disabled={!actionsReady || !!running} onPress={() => void run(target)}
            style={[styles.target, { width: targetWidth }, (!actionsReady || (running && running !== target)) && styles.dimmed]}>
            <ShareTargetIcon target={target} />
            {/* Words stay whole: 인스타그램 / 스토리 rather than a break inside a word. */}
            <Text style={styles.targetLabel}>{running === target ? '여는 중…' : label.split(' ').join('\n')}</Text>
          </ActionPressable>
        ))}
      </View>
      <ActionPressable testID="trade-share-save" accessibilityRole="button" accessibilityLabel="이미지 저장"
        accessibilityState={{ disabled: !actionsReady || !!running, busy: running === 'save' }} aria-disabled={!actionsReady || !!running}
        aria-busy={running === 'save'} disabled={!actionsReady || !!running} onPress={() => void run('save')}
        style={[styles.save, (!actionsReady || (running && running !== 'save')) && styles.dimmed]}>
        <ShareTargetIcon target="save" size={28} />
        <Text style={styles.saveText}>{running === 'save' ? '저장하는 중…' : '이미지 저장'}</Text>
      </ActionPressable>
      {status ? (
        <Text testID="trade-share-status" accessibilityLiveRegion="polite" style={status.error ? styles.error : styles.helper}>{status.text}</Text>
      ) : !SHARE_CAPTURE_SUPPORTED ? (
        <Text testID="trade-share-unsupported" style={styles.helper}>{shareOutcomeMessage('unsupported', 'more')}</Text>
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

// Plain objects: harnesses load sheets with minimal native mocks. Labels wrap
// at large font sizes instead of clipping; the card itself never scales text.
const styles = {
  scroll: { flexGrow: 0 },
  content: { paddingTop: 4, paddingBottom: 8 },
  body: { gap: 14, minWidth: 0 },
  preview: { alignSelf: 'center', overflow: 'hidden', borderRadius: 18, backgroundColor: '#011733' },
  targets: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 8 },
  target: { minWidth: 0, minHeight: 44, alignItems: 'center', gap: 6, paddingVertical: 6, paddingHorizontal: 2, borderRadius: 12 },
  targetLabel: { fontSize: 12, lineHeight: 17, fontWeight: '600', color: semantic.text, textAlign: 'center' },
  dimmed: { opacity: 0.45 },
  save: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 48, borderRadius: 12,
    borderWidth: 1, borderColor: semantic.border, backgroundColor: semantic.raised, paddingHorizontal: 16 },
  saveText: { fontSize: 15, lineHeight: 22, fontWeight: '700', color: semantic.text },
  helper: { fontSize: 13, lineHeight: 20, color: semantic.secondary },
  error: { fontSize: 13, lineHeight: 20, color: semantic.error },
  footnote: { fontSize: 12, lineHeight: 18, color: semantic.secondary },
  retry: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 10, backgroundColor: semantic.raised },
  retryText: { fontSize: 14, lineHeight: 21, fontWeight: '700', color: semantic.text },
} as const;
