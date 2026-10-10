import React, { useCallback, useEffect, useRef, useState } from 'react';
import Svg, { Path } from 'react-native-svg';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  Keyboard,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from '../../theme/native';
import { useSafeAreaInsets } from '../../theme/safeArea';
import { useAppearance } from '../../theme/appearance';
import { primaryGradient, semantic } from '../../theme/tokens';
import ActionPressable from '../../components/common/ActionPressable';
import TabBarIcon from '../../components/navigation/TabBarIcon';
import { getQuestGuideTarget, revealQuestGuideTarget, type QuestGuideMeasurable, type QuestGuideTargetId } from './questGuideBridge';
import { QUEST_CARDS, QUEST_GUIDE_COPY } from './questContent';
import {
  VIEWPORT_TARGET,
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

/** Re-measure often enough to follow scroll/keyboard settling, cheaply. */
const MEASURE_INTERVAL_MS = 160;
const HOLE_PADDING = 6;
const HOLE_RADIUS = 14;
/** Card padding (2×14), border (2×1) and the gap between text and actions. */
const CARD_CHROME = 40;
/** Gap between the quest label/title block and the instruction. */
const TEXT_GAP = 6;
/** Text the card shows at least before it scrolls: about two lines. */
const MIN_TEXT_HEIGHT = 48;

type Frame = { key: string; root: GuideRect; area: GuideRect; hole: GuideRect | null };

function measure(node: QuestGuideMeasurable | null): Promise<GuideRect | null> {
  return new Promise(resolve => {
    if (!node) {
      resolve(null);
      return;
    }
    try {
      node.measureInWindow((x, y, width, height) => resolve(
        [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0
          ? { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
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
 * keyboard keep working. The spotlight appears only once the target has been
 * laid out and holds still across two measurements; it hides while the target
 * moves (scroll, keyboard, navigation transitions) and follows it afterwards.
 */
export default function QuestGuideOverlay({ view, quest, reducedMotion, onAction }: {
  view: GuideView;
  quest: BeginnerQuestKey | null;
  reducedMotion: boolean;
  onAction: (action: GuideAction, step: number | null) => void;
}) {
  const rootRef = useRef<View>(null);
  const keyboardTop = useRef(Number.POSITIVE_INFINITY);
  const roomRequested = useRef(new Set<string>());
  const insets = useSafeAreaInsets();
  const [frame, setFrame] = useState<Frame | null>(null);
  const [keyboardRevision, setKeyboardRevision] = useState(0);

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
    let inFlight = false;
    let previous = '';
    let revealed = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const [root, viewport, ...parts] = await Promise.all([
          measure(rootRef.current as QuestGuideMeasurable | null),
          measure(getQuestGuideTarget(VIEWPORT_TARGET[screen])),
          ...targets.map(id => measure(getQuestGuideTarget(id))),
        ]);
        if (!active) return;
        if (!root || parts.some(part => !part)) {
          previous = '';
          setFrame(null);
          return;
        }
        const signature = JSON.stringify([root, viewport, parts, keyboardTop.current]);
        if (signature !== previous) {
          // Moving (layout, scroll, keyboard, transition): wait until it holds still.
          previous = signature;
          setFrame(current => current?.key === viewKey ? null : current);
          return;
        }
        const local = (rect: GuideRect) => ({ ...rect, x: rect.x - root.x, y: rect.y - root.y });
        let area = viewport
          ? local(viewport)
          : { x: 0, y: insets.top, width: root.width, height: Math.max(0, root.height - insets.top - insets.bottom) };
        const keyboard = keyboardTop.current - root.y;
        if (keyboard < area.y + area.height) area = { ...area, height: Math.max(0, keyboard - area.y) };
        let hole: GuideRect | null = null;
        const union = unionRects(parts.filter((part): part is GuideRect => !!part).map(local));
        if (union) {
          const visible = intersectRects(union, area);
          if ((!visible || !sameRect(visible, union)) && !revealed) {
            // Let the screen scroll its own content once, then measure again.
            revealed = true;
            previous = '';
            revealQuestGuideTarget(screen, targets[0]);
            return;
          }
          hole = visible ? intersectRects(inflateRect(visible, HOLE_PADDING), area) : null;
          if (!hole) {
            setFrame(null);
            return;
          }
        }
        const next: Frame = { key: viewKey, root, area, hole };
        setFrame(current => current && current.key === next.key && sameRect(current.root, next.root)
          && sameRect(current.area, next.area) && sameRect(current.hole, next.hole) ? current : next);
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const timer = setInterval(() => { void tick(); }, MEASURE_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [viewKey, screen, targetList, keyboardRevision, insets.top, insets.bottom]);

  if (view.kind === 'none') return null;
  if (view.kind === 'celebration') {
    return <QuestCelebration title={view.title} summary={view.summary} leaving={view.leaving} reducedMotion={reducedMotion} />;
  }
  const current = frame?.key === view.anchor ? frame : null;
  return (
    <View ref={rootRef} collapsable={false} pointerEvents="box-none" style={styles.root} testID="quest-guide-overlay">
      {current && quest ? (
        <GuideLayer
          key={view.anchor}
          frame={current}
          view={view}
          quest={quest}
          reducedMotion={reducedMotion}
          onAction={onAction}
          requestRoom={requestRoom}
        />
      ) : null}
    </View>
  );
}

function GuideLayer({ frame, view, quest, reducedMotion, onAction, requestRoom }: {
  frame: Frame;
  view: Extract<GuideView, { kind: 'spotlight' | 'message' }>;
  quest: BeginnerQuestKey;
  reducedMotion: boolean;
  onAction: (action: GuideAction, step: number | null) => void;
  requestRoom: () => boolean;
}) {
  const { colors, mode } = useAppearance();
  const appear = useRef(new Animated.Value(reducedMotion ? 1 : 0)).current;
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
  const cramped = compact;
  useEffect(() => {
    if (!cramped || roomSettled) return;
    if (!requestRoom()) {
      setRoomSettled(true);
      return;
    }
    const timer = setTimeout(() => setRoomSettled(true), 600);
    return () => clearTimeout(timer);
  }, [cramped, roomSettled, requestRoom]);

  const ready = placed !== null && (!cramped || roomSettled);
  useEffect(() => {
    if (!ready) return;
    if (reducedMotion) {
      appear.setValue(1);
      return;
    }
    const animation = Animated.timing(appear, { toValue: 1, duration: 180, easing: Easing.out(Easing.quad), useNativeDriver: native });
    animation.start();
    return () => animation.stop();
  }, [appear, native, ready, reducedMotion]);

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
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: appear }]} testID="quest-guide-spotlight">
          <Svg width={frame.root.width} height={frame.root.height} pointerEvents="none" focusable={false} aria-hidden>
            <Path d={dimPath(frame.root.width, frame.root.height, hole)} fill={mode === 'dark' ? 'rgba(0,0,0,0.62)' : 'rgba(16,24,40,0.5)'} fillRule="evenodd" />
          </Svg>
          <PulseRing hole={hole} color={ring} reducedMotion={reducedMotion} />
        </Animated.View>
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

function PulseRing({ hole, color, reducedMotion }: { hole: GuideRect; color: string; reducedMotion: boolean }) {
  const pulse = useRef(new Animated.Value(0)).current;
  const native = Platform.OS !== 'web';
  useEffect(() => {
    pulse.setValue(0);
    if (reducedMotion) return;
    // A few calm pulses per step, then a steady ring: noticeable, not nagging.
    const animation = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 650, easing: Easing.out(Easing.quad), useNativeDriver: native }),
      Animated.timing(pulse, { toValue: 0, duration: 550, easing: Easing.in(Easing.quad), useNativeDriver: native }),
    ]), { iterations: 4 });
    animation.start();
    return () => animation.stop();
  }, [native, pulse, reducedMotion]);
  const frameStyle = { left: hole.x, top: hole.y, width: hole.width, height: hole.height, borderRadius: Math.min(HOLE_RADIUS, hole.height / 2) };
  return (
    <>
      <Animated.View pointerEvents="none" style={[styles.ring, frameStyle, {
        borderColor: color,
        opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0, 0.5] }),
        transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.07] }) }],
      }]} />
      <View pointerEvents="none" testID="quest-guide-ring" style={[styles.ring, frameStyle, { borderColor: color }]} />
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
        {card.busy ? <ActivityIndicator size="small" color={semantic.info} /> : null}
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
});
