import React, { useCallback, useEffect, useRef, useState } from 'react';
import Svg, { Path } from 'react-native-svg';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Keyboard,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from '../../theme/native';
import { useSafeAreaInsets } from '../../theme/safeArea';
import { useAppearance } from '../../theme/appearance';
import { primaryGradient, semantic } from '../../theme/tokens';
import ActionPressable from '../../components/common/ActionPressable';
import TabBarIcon from '../../components/navigation/TabBarIcon';
import {
  getQuestGuideTarget,
  revealQuestGuideTarget,
  type QuestGuideMeasurable,
  type QuestGuideScreen,
  type QuestGuideTargetId,
} from './questGuideBridge';
import { QUEST_CARDS, QUEST_GUIDE_COPY } from './questContent';
import {
  HEADER_TARGET,
  VIEWPORT_TARGET,
  clipBelow,
  inflateRect,
  intersectRects,
  placeGuideCard,
  sameRect,
  unionRects,
  type GuideAction,
  type GuideCard,
  type GuideRect,
  type GuideView,
} from './questGuideModel';
import type { BeginnerQuestKey } from './questProgress';
import QuestCelebration from './QuestCelebration';
import WhaleLoader from '../../components/states/WhaleLoader';

/** Re-measure a target that holds still: cheap, and enough to notice a move. */
const MEASURE_INTERVAL_MS = 160;
/** While a target settles in or moves (scroll, keyboard), follow it closely. */
const FOLLOW_INTERVAL_MS = 48;
/** The one fade-in of a step; afterwards the highlight holds still. */
const APPEAR_MS = 220;
/** A list is highlighted below its header only while a row's height of it remains. */
const MIN_LIST_HEIGHT = 48;
const HOLE_PADDING = 6;
const HOLE_RADIUS = 14;
/** Card padding (2×14), border (2×1) and the gap between text and actions. */
const CARD_CHROME = 40;
/** Gap between the quest label/title block and the instruction. */
const TEXT_GAP = 6;
/** Text the card shows at least before it scrolls: about two lines. */
const MIN_TEXT_HEIGHT = 48;
/** The bottom tab bar's height, grown with larger text as MainTabs does. */
const tabBarHeight = (fontScale: number) => 49 + Math.ceil(14 * Math.max(0, fontScale - 1));
const DIM_LIGHT = 'rgba(16,24,40,0.5)';
const DIM_DARK = 'rgba(0,0,0,0.62)';

type Frame = { key: string; screen: QuestGuideScreen; root: GuideRect; area: GuideRect; hole: GuideRect | null };

/** Sub-pixel measurement noise is not a move. */
const sameFrame = (a: Frame, b: Frame) => a.key === b.key && a.screen === b.screen
  && sameRect(a.root, b.root) && sameRect(a.area, b.area) && sameRect(a.hole, b.hole);

function measure(node: QuestGuideMeasurable | null): Promise<GuideRect | null> {
  return new Promise(resolve => {
    if (!node) {
      resolve(null);
      return;
    }
    try {
      node.measureInWindow((x, y, width, height) => resolve(
        [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0
          ? { x, y, width, height }
          : null,
      ));
    } catch {
      resolve(null);
    }
  });
}

/** Even-odd path: the whole overlay minus one rounded rectangle. */
function dimPath(width: number, height: number, hole: GuideRect) {
  const r = Math.min(HOLE_RADIUS, hole.width / 2, hole.height / 2);
  const { x, y } = hole;
  const right = x + hole.width;
  const bottom = y + hole.height;
  return `M0 0H${width}V${height}H0Z M${x + r} ${y}H${right - r}A${r} ${r} 0 0 1 ${right} ${y + r}V${bottom - r}`
    + `A${r} ${r} 0 0 1 ${right - r} ${bottom}H${x + r}A${r} ${r} 0 0 1 ${x} ${bottom - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
}

/**
 * Draws the current guide step over the MainTabs tree.
 *
 * Every layer is visual only (`pointerEvents="none"`) except the step card:
 * the highlighted control receives the user's own press exactly as without
 * the guide, nothing is disabled or enabled here, and scrolling, typing and the
 * keyboard keep working. A step appears once its target has been laid out and
 * holds still across two measurements (not mid-transition), fading in once.
 * From then on it stays up and follows the target through scrolling, the
 * keyboard and layout changes; only a target that is gone (another screen,
 * unmounted, scrolled out of sight) takes the highlight down.
 *
 * `notice` shows that a move was held for the guide, with 안내 종료 right in it:
 * it is the way out even while no step card is on screen.
 */
export default function QuestGuideOverlay({ view, quest, reducedMotion, notice = false, onAction }: {
  view: GuideView;
  quest: BeginnerQuestKey | null;
  reducedMotion: boolean;
  notice?: boolean;
  onAction: (action: GuideAction, step: number | null) => void;
}) {
  const rootRef = useRef<View>(null);
  const keyboardTop = useRef(Number.POSITIVE_INFINITY);
  const roomRequested = useRef(new Set<string>());
  const insets = useSafeAreaInsets();
  const [frame, setFrame] = useState<Frame | null>(null);
  const [keyboardRevision, setKeyboardRevision] = useState(0);
  // The last step that appeared: showing it again (a target that briefly went
  // away) must not replay its fade-in.
  const shownAnchor = useRef<string | null>(null);

  useEffect(() => {
    const update = (top: number) => {
      keyboardTop.current = top;
      setKeyboardRevision(value => value + 1);
    };
    const show = Keyboard.addListener('keyboardDidShow', event => update(event.endCoordinates.screenY));
    const change = Platform.OS === 'ios'
      ? Keyboard.addListener('keyboardWillChangeFrame', event => update(event.endCoordinates.screenY))
      : null;
    const hide = Keyboard.addListener('keyboardDidHide', () => update(Number.POSITIVE_INFINITY));
    return () => { show.remove(); change?.remove(); hide.remove(); };
  }, []);

  const measuring = view.kind === 'spotlight' || view.kind === 'message';
  const viewKey = measuring ? view.anchor : null;
  const screen = measuring ? view.screen : null;
  const targetList = view.kind === 'spotlight' ? view.targets.join(',') : '';
  const firstTarget = view.kind === 'spotlight' ? view.targets[0] : null;
  const headerTarget = view.kind === 'spotlight' && view.targets.length === 1 ? HEADER_TARGET[view.targets[0]] ?? null : null;

  // Once per step: before shrinking a card that does not fit, let the screen
  // scroll the control toward the top to make room for it.
  const requestRoom = useCallback(() => {
    if (!viewKey || !screen || !firstTarget || roomRequested.current.has(viewKey)) return false;
    roomRequested.current.add(viewKey);
    revealQuestGuideTarget(screen, firstTarget);
    return true;
  }, [viewKey, screen, firstTarget]);

  useEffect(() => {
    if (!viewKey || !screen) {
      setFrame(null);
      return;
    }
    const targets = targetList ? targetList.split(',') as QuestGuideTargetId[] : [];
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last: Frame | null = null;
    let revealed = false;
    // Resolves whether the target held still since the previous measurement.
    const follow = async (): Promise<boolean> => {
      const [root, viewport, header, ...parts] = await Promise.all([
        measure(rootRef.current as QuestGuideMeasurable | null),
        measure(getQuestGuideTarget(VIEWPORT_TARGET[screen])),
        measure(headerTarget ? getQuestGuideTarget(headerTarget) : null),
        ...targets.map(id => measure(getQuestGuideTarget(id))),
      ]);
      if (!active) return true;
      if (!root || parts.some(part => !part)) {
        // Gone (another screen, unmounted): never leave a stale highlight.
        last = null;
        setFrame(null);
        return true;
      }
      const local = (rect: GuideRect) => ({ ...rect, x: rect.x - root.x, y: rect.y - root.y });
      let area = viewport
        ? local(viewport)
        : { x: 0, y: insets.top, width: root.width, height: Math.max(0, root.height - insets.top - insets.bottom) };
      const keyboard = keyboardTop.current - root.y;
      if (keyboard < area.y + area.height) area = { ...area, height: Math.max(0, keyboard - area.y) };
      let hole: GuideRect | null = null;
      let union = unionRects(parts.filter((part): part is GuideRect => !!part).map(local));
      if (union && header) union = clipBelow(union, local(header), MIN_LIST_HEIGHT);
      if (union) {
        const visible = intersectRects(union, area);
        if ((!visible || !sameRect(visible, union)) && !revealed) {
          // Let the screen scroll its own content once, then measure again.
          revealed = true;
          last = null;
          revealQuestGuideTarget(screen, targets[0]);
          return false;
        }
        hole = visible ? intersectRects(inflateRect(visible, HOLE_PADDING), area) : null;
        if (!hole) {
          last = null;
          setFrame(null);
          return true;
        }
      }
      const next: Frame = { key: viewKey, screen, root, area, hole };
      const still = last !== null && sameFrame(last, next);
      last = next;
      setFrame(current => current?.key === viewKey
        // Shown: a real move is followed at once, noise is ignored, nothing blinks.
        ? sameFrame(current, next) ? current : next
        // Not shown yet: appear once the target holds still (after a transition).
        : still ? next : current);
      return still;
    };
    const run = async () => {
      const still = await follow();
      if (active) timer = setTimeout(() => { void run(); }, still ? MEASURE_INTERVAL_MS : FOLLOW_INTERVAL_MS);
    };
    void run();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [viewKey, screen, targetList, headerTarget, keyboardRevision, insets.top, insets.bottom]);

  const held = notice ? <HeldNotice onExit={() => onAction('exit', null)} /> : null;
  if (view.kind === 'none') return held ? <View pointerEvents="box-none" style={styles.root}>{held}</View> : null;
  if (view.kind === 'celebration') {
    return <QuestCelebration key={view.key} title={view.title} summary={view.summary} leaving={view.leaving} replay={view.replay} reducedMotion={reducedMotion} />;
  }
  const current = frame?.key === view.anchor ? frame : null;
  // From one step to the next on the same screen the dim stays up (closed
  // until the next target is measured) instead of blinking off and back.
  const dim = view.kind === 'spotlight' ? current ?? (frame?.screen === view.screen ? frame : null) : null;
  const fadeIn = !reducedMotion && shownAnchor.current !== view.anchor;
  return (
    <View ref={rootRef} collapsable={false} pointerEvents="box-none" style={styles.root} testID="quest-guide-overlay">
      {dim && quest ? <SpotlightDim root={dim.root} hole={current?.hole ?? null} fadeIn={fadeIn} /> : null}
      {current && quest ? (
        <GuideLayer
          key={view.anchor}
          frame={current}
          view={view}
          quest={quest}
          fadeIn={fadeIn}
          shownAnchor={shownAnchor}
          onAction={onAction}
          requestRoom={requestRoom}
        />
      ) : null}
      {held}
    </View>
  );
}

/** A short notice above the tab bar, never a modal: only 안내 종료 takes touches, the screen below keeps the rest. */
function HeldNotice({ onExit }: { onExit: () => void }) {
  const { colors } = useAppearance();
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  // Announced once per appearance; repeated held moves only keep it up.
  useEffect(() => { AccessibilityInfo.announceForAccessibility(QUEST_GUIDE_COPY.held); }, []);
  return (
    <View pointerEvents="box-none" style={[styles.noticeRow, { bottom: insets.bottom + tabBarHeight(fontScale) + 12 }]}>
      <View testID="quest-guide-notice" accessibilityLiveRegion="polite" pointerEvents="box-none"
        style={[styles.notice, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View pointerEvents="none" style={styles.noticeTextBox}><Text style={styles.noticeText}>{QUEST_GUIDE_COPY.held}</Text></View>
        <ActionPressable testID="quest-guide-notice-exit" accessibilityRole="button" accessibilityLabel={ACTION_LABEL.exit}
          onPress={onExit} style={styles.textButton}>
          <Text style={styles.noticeAction}>{ACTION_LABEL.exit}</Text>
        </ActionPressable>
      </View>
    </View>
  );
}

/** The dimmed screen around the highlighted control; it fades in once, then holds. */
function SpotlightDim({ root, hole, fadeIn }: { root: GuideRect; hole: GuideRect | null; fadeIn: boolean }) {
  const { mode } = useAppearance();
  const initial = useRef(fadeIn).current;
  const appear = useRef(new Animated.Value(initial ? 0 : 1)).current;
  const native = Platform.OS !== 'web';
  useEffect(() => {
    if (!initial) return;
    const animation = Animated.timing(appear, { toValue: 1, duration: APPEAR_MS, easing: Easing.out(Easing.quad), useNativeDriver: native });
    animation.start();
    return () => animation.stop();
  }, [appear, initial, native]);
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: appear }]} testID="quest-guide-spotlight">
      <Svg width={root.width} height={root.height} pointerEvents="none" focusable={false} aria-hidden>
        {hole
          ? <Path d={dimPath(root.width, root.height, hole)} fill={mode === 'dark' ? DIM_DARK : DIM_LIGHT} fillRule="evenodd" />
          : <Path d={`M0 0H${root.width}V${root.height}H0Z`} fill={mode === 'dark' ? DIM_DARK : DIM_LIGHT} />}
      </Svg>
    </Animated.View>
  );
}

function GuideLayer({ frame, view, quest, fadeIn, shownAnchor, onAction, requestRoom }: {
  frame: Frame;
  view: Extract<GuideView, { kind: 'spotlight' | 'message' }>;
  quest: BeginnerQuestKey;
  /** Read once, when the step mounts. */
  fadeIn: boolean;
  shownAnchor: React.MutableRefObject<string | null>;
  onAction: (action: GuideAction, step: number | null) => void;
  requestRoom: () => boolean;
}) {
  const { colors, mode } = useAppearance();
  const initial = useRef(fadeIn).current;
  const appear = useRef(new Animated.Value(initial ? 0 : 1)).current;
  // Natural heights (the quest label + title, the instruction, the actions),
  // measured independently of any maxHeight cap.
  const [headHeight, setHeadHeight] = useState<number | null>(null);
  const [textHeight, setTextHeight] = useState<number | null>(null);
  const [actionsHeight, setActionsHeight] = useState<number | null>(null);
  const [roomSettled, setRoomSettled] = useState(false);
  const native = Platform.OS !== 'web';
  const ring = mode === 'dark' ? '#70AFFF' : primaryGradient.colors[0];
  const hole = view.kind === 'spotlight' ? frame.hole : null;
  const cardWidth = Math.max(0, Math.min(360, frame.area.width - 24));
  const placement = view.kind === 'spotlight' ? view.placement : 'auto';
  const measured = headHeight !== null && textHeight !== null && actionsHeight !== null;
  const full = measured
    ? placeGuideCard({ area: frame.area, hole, placement,
      card: { width: cardWidth, height: headHeight + TEXT_GAP + textHeight + actionsHeight + CARD_CHROME } })
    : null;
  // Too tall as it is: drop the quest label and title, keep the instruction,
  // and only then let the instruction scroll inside the card.
  const compact = full !== null && (full.maxHeight !== null || full.overlaps);
  const placed = compact
    ? placeGuideCard({ area: frame.area, hole, placement, card: {
      width: cardWidth,
      height: textHeight + actionsHeight + CARD_CHROME,
      minHeight: Math.min(textHeight, MIN_TEXT_HEIGHT) + actionsHeight + CARD_CHROME,
    } })
    : full;

  // A card never sits on the control it explains. When it does not fit as it
  // is, the screen may scroll the control up once to make room; the card is
  // shown (compact, scrolling its own text if still needed) after that settles.
  // Once shown it stays: a later move (the user's own scroll) is followed, not
  // answered with another scroll or a hidden card.
  const cramped = compact;
  const placedOnce = useRef(false);
  if (placed !== null && (!cramped || roomSettled)) placedOnce.current = true;
  const ready = placed !== null && placedOnce.current;
  useEffect(() => {
    if (!cramped || roomSettled || placedOnce.current) return;
    if (!requestRoom()) {
      setRoomSettled(true);
      return;
    }
    const timer = setTimeout(() => setRoomSettled(true), 600);
    return () => clearTimeout(timer);
  }, [cramped, roomSettled, requestRoom]);

  const anchor = view.anchor;
  useEffect(() => {
    if (!ready) return;
    shownAnchor.current = anchor;
    if (!initial) return;
    const animation = Animated.timing(appear, { toValue: 1, duration: APPEAR_MS, easing: Easing.out(Easing.quad), useNativeDriver: native });
    animation.start();
    return () => animation.stop();
  }, [anchor, appear, initial, native, ready, shownAnchor]);

  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(`${view.card.title}. ${view.card.body}`);
  }, [view.card.title, view.card.body]);

  const onActionsLayout = (event: LayoutChangeEvent) => {
    const height = Math.ceil(event.nativeEvent.layout.height);
    setActionsHeight(previous => previous !== null && Math.abs(previous - height) < 1 ? previous : height);
  };
  const keep = (setter: React.Dispatch<React.SetStateAction<number | null>>) => (event: LayoutChangeEvent) => {
    const next = Math.ceil(event.nativeEvent.layout.height);
    setter(previous => previous !== null && Math.abs(previous - next) < 1 ? previous : next);
  };

  return (
    <>
      {hole ? (
        // A steady ring: it fades in with the card, then never pulses or blinks.
        <Animated.View pointerEvents="none" testID="quest-guide-ring" style={[styles.ring, {
          left: hole.x, top: hole.y, width: hole.width, height: hole.height,
          borderRadius: Math.min(HOLE_RADIUS, hole.height / 2), borderColor: ring, opacity: appear,
        }]} />
      ) : null}
      <Animated.View
        testID="quest-guide-card"
        accessibilityLiveRegion="polite"
        style={[styles.card, {
          width: cardWidth,
          left: placed?.x ?? frame.area.x + 12,
          top: placed?.y ?? frame.area.y + 12,
          maxHeight: placed?.maxHeight ?? undefined,
          opacity: ready ? appear : 0,
          backgroundColor: colors.surface,
          borderColor: view.card.tone === 'warning' ? colors.warning : colors.border,
        }]}
      >
        <GuideCardContent card={view.card} quest={quest} compact={compact} scrolls={placed?.maxHeight != null}
          onHeadLayout={keep(setHeadHeight)} onTextLayout={keep(setTextHeight)} onActionsLayout={onActionsLayout}
          onAction={action => onAction(action, view.kind === 'spotlight' ? view.step : null)} />
      </Animated.View>
    </>
  );
}

const ACTION_LABEL: Record<Exclude<GuideAction, 'next'>, string> = {
  exit: QUEST_GUIDE_COPY.actions.exit,
  retry: QUEST_GUIDE_COPY.actions.retry,
  back: QUEST_GUIDE_COPY.actions.back,
};

function GuideCardContent({ card, quest, compact, scrolls, onHeadLayout, onTextLayout, onActionsLayout, onAction }: {
  card: GuideCard;
  quest: BeginnerQuestKey;
  compact: boolean;
  scrolls: boolean;
  onHeadLayout: (event: LayoutChangeEvent) => void;
  onTextLayout: (event: LayoutChangeEvent) => void;
  onActionsLayout: (event: LayoutChangeEvent) => void;
  onAction: (action: GuideAction) => void;
}) {
  const { colors } = useAppearance();
  const meta = QUEST_CARDS[quest];
  // The instruction keeps its full size and wording. In a tight spot the quest
  // label, title and step counter give way first (one row of actions), then
  // the instruction scrolls inside the card while the actions stay visible.
  return (
    <>
      <ScrollView testID="quest-guide-text" style={styles.text} contentContainerStyle={styles.textContent}
        scrollEnabled={scrolls} showsVerticalScrollIndicator={scrolls}>
        {compact ? null : (
          <View style={styles.textContent} onLayout={onHeadLayout} testID="quest-guide-head">
            <View style={styles.header}>
              <TabBarIcon name="quest" size={16} color={colors.info} focused />
              <Text style={styles.eyebrow}>{meta.number} · {meta.title}</Text>
              {card.stepLabel ? <Text style={styles.step} testID="quest-guide-step">{card.stepLabel}</Text> : null}
            </View>
            <Text style={styles.title} accessibilityRole="header">{card.title}</Text>
          </View>
        )}
        <View style={styles.textContent} onLayout={onTextLayout} testID="quest-guide-instruction">
          <Text style={[styles.body, card.tone === 'warning' && styles.warning]} testID="quest-guide-body">{card.body}</Text>
          {card.hint ? <Text style={styles.hint}>{card.hint}</Text> : null}
        </View>
      </ScrollView>
      <View style={styles.actions} onLayout={onActionsLayout} testID="quest-guide-actions">
        {card.busy ? <WhaleLoader size={20} /> : null}
        {card.actions.map(action => (
          <ActionPressable key={action} testID={`quest-guide-${action}`} accessibilityRole="button"
            accessibilityLabel={ACTION_LABEL[action as Exclude<GuideAction, 'next'>]}
            onPress={() => onAction(action)} style={styles.textButton}>
            <Text style={styles.textButtonLabel}>{ACTION_LABEL[action as Exclude<GuideAction, 'next'>]}</Text>
          </ActionPressable>
        ))}
        {card.next ? (
          <ActionPressable testID="quest-guide-next" feedback="button" primary={card.next === 'enabled'}
            accessibilityRole="button" accessibilityLabel={QUEST_GUIDE_COPY.actions.next}
            accessibilityState={{ disabled: card.next === 'disabled' }} disabled={card.next === 'disabled'}
            onPress={() => onAction('next')} style={[styles.nextButton, card.next === 'disabled' && styles.disabled]}>
            <Text style={styles.nextLabel}>{QUEST_GUIDE_COPY.actions.next}</Text>
          </ActionPressable>
        ) : null}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  root: { ...StyleSheet.absoluteFillObject, zIndex: 20, elevation: 20 },
  ring: { position: 'absolute', borderWidth: 3 },
  card: {
    position: 'absolute',
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    gap: 10,
    shadowColor: '#000000',
    shadowOpacity: 0.18,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  eyebrow: { flex: 1, minWidth: 0, fontSize: 12, lineHeight: 18, fontWeight: '700', color: semantic.info },
  step: { flexShrink: 0, fontSize: 12, lineHeight: 18, fontWeight: '700', color: semantic.muted },
  text: { flexGrow: 0, flexShrink: 1 },
  textContent: { gap: 6 },
  title: { fontSize: 16, lineHeight: 24, fontWeight: '700', color: semantic.text },
  body: { fontSize: 15, lineHeight: 23, color: semantic.text },
  warning: { color: semantic.warning },
  hint: { fontSize: 13, lineHeight: 20, color: semantic.secondary },
  actions: { flexShrink: 0, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 8 },
  textButton: { minHeight: 44, minWidth: 44, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
  textButtonLabel: { fontSize: 14, lineHeight: 21, fontWeight: '600', color: semantic.secondary, textAlign: 'center' },
  nextButton: {
    minHeight: 44,
    minWidth: 72,
    paddingHorizontal: 18,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: primaryGradient.colors[0],
  },
  disabled: { opacity: 0.45 },
  nextLabel: { fontSize: 15, lineHeight: 22, fontWeight: '700', color: primaryGradient.foreground, textAlign: 'center' },
  noticeRow: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  notice: {
    maxWidth: 420,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    columnGap: 4,
    paddingLeft: 16,
    paddingRight: 4,
    paddingVertical: 4,
    borderWidth: 1,
    borderRadius: 14,
    shadowColor: '#000000',
    shadowOpacity: 0.18,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  noticeTextBox: { flexShrink: 1 },
  noticeText: { paddingVertical: 8, fontSize: 14, lineHeight: 21, fontWeight: '600', color: semantic.text },
  noticeAction: { fontSize: 14, lineHeight: 21, fontWeight: '700', color: semantic.info, textAlign: 'center' },
});
