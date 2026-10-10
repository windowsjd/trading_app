import React, { useEffect, useRef, useState } from 'react';
import { Modal, StyleSheet, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { useReducedMotion } from '../../theme/useReducedMotion';
import ActionPressable from '../../components/common/ActionPressable';
import DisclosureTriangle from '../../components/common/DisclosureTriangle';
import { TEST_IDS } from '../../constants/testIds';

export type OrderType = 'market' | 'limit';

const OPTIONS = [
  { value: 'market', label: '시장가', testID: TEST_IDS.order.typeToggleMarket },
  { value: 'limit', label: '지정가', testID: TEST_IDS.order.typeToggleLimit },
] as const;
// The visual box is 2/3 of the former 44px tabs; the transparent band above
// and below keeps a 44px target and is pulled back out of the layout flow.
const TOUCH_BAND = 7;
const MENU_GAP = 4;
const EDGE = 8;
const MENU_MIN_WIDTH = 140;

type Rect = { x: number; y: number; width: number; height: number };

function measure(node: View | null, callback: (rect: Rect) => void) {
  if (typeof node?.measureInWindow !== 'function') return false;
  node.measureInWindow((x, y, width, height) => callback({ x, y, width, height }));
  return true;
}

/** Trigger and menu are measured in the same window, so status bar and
 * edge-to-edge offsets cancel out on every platform. */
export function placeOrderTypeMenu(anchor: Rect, frame: Rect, menuHeight: number) {
  const width = Math.min(Math.max(anchor.width, MENU_MIN_WIDTH), frame.width - EDGE * 2);
  const left = Math.min(Math.max(anchor.x - frame.x, EDGE), frame.width - width - EDGE);
  const below = anchor.y - frame.y + anchor.height + MENU_GAP;
  const above = anchor.y - frame.y - MENU_GAP - menuHeight;
  const maxTop = Math.max(EDGE, frame.height - menuHeight - EDGE);
  const top = below <= maxTop || above < EDGE ? Math.min(below, maxTop) : above;
  return { left, top, width };
}

/** One full-width button opens 시장가/지정가; the caller owns the order type. */
export default function OrderTypeSelect({ value, disabled, onChange }: {
  value: OrderType;
  disabled: boolean;
  onChange: (value: OrderType) => void;
}) {
  const reduced = useReducedMotion();
  const surfaceRef = useRef<View>(null);
  const rootRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Rect | null>(null);
  const [frame, setFrame] = useState<Rect | null>(null);
  const [menuHeight, setMenuHeight] = useState<number | null>(null);
  const label = OPTIONS.find((option) => option.value === value)?.label ?? '시장가';

  const close = () => {
    setOpen(false);
    setFrame(null);
    setMenuHeight(null);
  };
  // A submit that starts while the menu is open (or is being measured)
  // closes it; it never reopens on its own.
  const disabledRef = useRef(disabled);
  useEffect(() => {
    disabledRef.current = disabled;
    if (!disabled) return;
    setOpen(false);
    setFrame(null);
    setMenuHeight(null);
  }, [disabled]);

  const show = () => {
    if (disabled || open) return;
    // Without a native measurement (tests, unmounted host) the menu still
    // opens, centred instead of anchored.
    const opened = measure(surfaceRef.current, (rect) => {
      if (disabledRef.current) return;
      setAnchor(rect);
      setOpen(true);
    });
    if (!opened) {
      setAnchor(null);
      setOpen(true);
    }
  };
  const select = (next: OrderType) => {
    close();
    if (next !== value) onChange(next);
  };

  const placed = anchor && frame && menuHeight !== null
    ? placeOrderTypeMenu(anchor, frame, menuHeight)
    : null;
  const waiting = !!anchor && !placed;

  return (
    <>
      <ActionPressable
        testID={TEST_IDS.order.typeSelect}
        accessibilityRole="button"
        accessibilityLabel="주문 방식"
        accessibilityValue={{ text: label }}
        accessibilityHint="시장가 또는 지정가를 선택합니다"
        accessibilityState={{ disabled, expanded: open }}
        aria-expanded={open}
        disabled={disabled}
        style={styles.trigger}
        feedbackStyle={styles.triggerFeedback}
        onPress={show}
      >
        <View ref={surfaceRef} collapsable={false} style={styles.surface}>
          <Text style={styles.value}>{label}</Text>
          <DisclosureTriangle testID="order-type-select-triangle" direction="down" />
        </View>
      </ActionPressable>
      {open ? (
        <Modal
          transparent
          visible
          statusBarTranslucent
          animationType={reduced ? 'none' : 'fade'}
          onRequestClose={close}
        >
          <View
            ref={rootRef}
            collapsable={false}
            style={styles.root}
            onLayout={() => {
              measure(rootRef.current, setFrame);
            }}
          >
            <ActionPressable
              testID="order-type-menu-backdrop"
              accessible={false}
              importantForAccessibility="no"
              style={styles.backdrop}
              onPress={close}
            />
            <View
              testID="order-type-menu"
              accessibilityRole="menu"
              accessibilityViewIsModal
              onLayout={(event) => setMenuHeight(event.nativeEvent.layout.height)}
              style={[
                styles.menu,
                placed ?? styles.menuFallback,
                waiting && styles.menuMeasuring,
              ]}
            >
              {OPTIONS.map((option) => {
                const selected = option.value === value;
                return (
                  <ActionPressable
                    key={option.value}
                    testID={option.testID}
                    accessibilityRole="menuitem"
                    accessibilityLabel={option.label}
                    accessibilityState={{ selected, disabled }}
                    aria-selected={selected}
                    disabled={disabled}
                    style={[styles.option, selected && styles.optionSelected]}
                    onPress={() => select(option.value)}
                  >
                    <Text style={[styles.optionText, selected && styles.optionTextSelected]}>
                      {option.label}
                    </Text>
                    {selected ? <Text style={styles.check} accessible={false}>✓</Text> : null}
                  </ActionPressable>
                );
              })}
            </View>
          </View>
        </Modal>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    alignSelf: 'stretch',
    minWidth: 0,
    paddingVertical: TOUCH_BAND,
    marginVertical: -TOUCH_BAND,
  },
  triggerFeedback: {
    top: TOUCH_BAND,
    bottom: TOUCH_BAND,
    left: 0,
    right: 0,
    borderRadius: 8,
    backgroundColor: semantic.raised,
  },
  surface: {
    minHeight: 30,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: semantic.raised,
  },
  value: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: 13,
    fontWeight: '600',
    color: semantic.text,
  },
  root: { flex: 1 },
  backdrop: { ...StyleSheet.absoluteFillObject },
  menu: {
    position: 'absolute',
    paddingVertical: 4,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: semantic.border,
    backgroundColor: semantic.surface,
    shadowColor: '#000',
    shadowOpacity: 0.16,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  menuFallback: { left: 24, right: 24, top: '40%' },
  menuMeasuring: { opacity: 0 },
  option: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginHorizontal: 4,
    borderRadius: 8,
  },
  optionSelected: { backgroundColor: semantic.raised },
  optionText: { flexShrink: 1, fontSize: 14, fontWeight: '500', color: semantic.text },
  optionTextSelected: { fontWeight: '700' },
  check: { fontSize: 14, fontWeight: '700', color: semantic.text },
});
