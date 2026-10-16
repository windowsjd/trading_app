import LearningLock from '../../features/quest/LearningLock';
import QuestTarget from '../../features/quest/QuestTarget';
import React from 'react';
import Svg, { Path } from 'react-native-svg';
import { ScrollView, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { useAppearance } from '../../theme/appearance';
import ActionPressable from '../../components/common/ActionPressable';
import DisclosureTriangle from '../../components/common/DisclosureTriangle';
import InlineBottomSheet from '../../components/common/InlineBottomSheet';
import { SheetPortal } from '../../components/common/ScreenSheetHost';
import { TEST_IDS } from '../../constants/testIds';
import {
  ORDER_METHOD_LABEL,
  getAvailabilityLabel,
  isOrderMethodSelectable,
  type OrderMethod,
  type OrderMethodOption,
} from '../../features/order/orderMethods';

export type { OrderMethod } from '../../features/order/orderMethods';

/**
 * One line icon and tint per method, drawn in a themed circle: 시장가 a
 * lightning bolt (now), 지정가 a target (the chosen price), 조건주문 a bell
 * (alert at the watch price), LOC a clock (the regular-session close). 24-unit
 * paths, stroked in the method's tone from the appearance palette (SVG props
 * take real colors, not the StyleSheet's semantic sentinels).
 */
const ICON: Record<OrderMethod, { path: string; tone: 'success' | 'info' | 'warning' | 'muted' }> = {
  market: { path: 'M13.5 2.5 5 13.5h6.5L10.5 21.5 19 10.5h-6.5l1-8z', tone: 'success' },
  limit: {
    path: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M12 7.5a4.5 4.5 0 1 0 0 9a4.5 4.5 0 1 0 0-9z M12 11.5a.5.5 0 1 0 0 1a.5.5 0 1 0 0-1z',
    tone: 'info',
  },
  conditional: { path: 'M6 9.5a6 6 0 0 1 12 0c0 5.5 2.5 7.5 2.5 7.5h-17S6 15 6 9.5z M10 20.5a2 2 0 0 0 4 0', tone: 'info' },
  loc: { path: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M12 7.5V12l3 2', tone: 'warning' },
};

/** Sheet rows the beginner guide may point at (QUEST 03, 05, 06). */
const GUIDE_TARGET: Partial<Record<OrderMethod, 'order-method-market' | 'order-method-limit'>> = {
  market: 'order-method-market',
  limit: 'order-method-limit',
};

/**
 * 주문방식: one full-width field under the side choice that opens a bottom
 * sheet (reference video 1). The caller owns the method (every new form starts
 * at 시장가), its learning gates and the draft reset; a refused choice never
 * changes the field. A submit in flight disables the field.
 *
 * The selected method reads on the left and a large ▼ on the right says the
 * field opens a list. The sheet lists names, availability and operating
 * reasons only; how each method fills lives in 전체 > 공지사항.
 */
export default function OrderTypeSelect({ method, options, disabled, open, onOpen, onClose, onSelect, learningHints }: {
  method: OrderMethod;
  options: OrderMethodOption[];
  disabled: boolean;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onSelect: (method: OrderMethod) => void;
  /** Beginner learning locks per method, shown on the row. */
  learningHints?: Partial<Record<OrderMethod, string | null>>;
}) {
  const label = ORDER_METHOD_LABEL[method];
  return (
    <>
      <ActionPressable
        testID={TEST_IDS.order.typeSelect}
        accessibilityRole="button"
        accessibilityLabel={`주문방식 ${label}`}
        accessibilityHint="주문방식 목록을 엽니다"
        accessibilityState={{ disabled, expanded: open }}
        disabled={disabled}
        onPress={onOpen}
        style={[styles.field, disabled && styles.disabled]}
      >
        <Text testID="order-type-select-value" style={styles.fieldValue}>{label}</Text>
        <View style={styles.chevron} accessible={false} importantForAccessibility="no-hide-descendants">
          <DisclosureTriangle testID="order-type-select-chevron" direction="down" color={semantic.text} large />
        </View>
      </ActionPressable>
      <SheetPortal>
        <InlineBottomSheet testID="order-method-sheet" title="주문방식" floating visible={open} onClose={onClose}>
          {/* Small screens and large fonts scroll the list inside the sheet's max height. */}
          <ScrollView testID="order-method-list" style={styles.scroll} bounces={false}>
            <View accessibilityRole="radiogroup" accessibilityLabel="주문방식" style={styles.list}>
              {options.map((option) => (
                <MethodRow key={option.method} option={option} selected={option.method === method}
                  learningHint={learningHints?.[option.method] ?? null} onSelect={onSelect} />
              ))}
            </View>
          </ScrollView>
        </InlineBottomSheet>
      </SheetPortal>
    </>
  );
}

function MethodRow({ option, selected, learningHint, onSelect }: {
  option: OrderMethodOption;
  selected: boolean;
  learningHint: string | null;
  onSelect: (method: OrderMethod) => void;
}) {
  const selectable = isOrderMethodSelectable(option);
  const badge = getAvailabilityLabel(option.availability);
  const reason = option.availability.state === 'unavailable' ? option.availability.reason : null;
  const icon = ICON[option.method];
  const { colors } = useAppearance();
  const row = (
    <ActionPressable
      testID={`order-method-${option.method}`}
      accessibilityRole="radio"
      accessibilityLabel={[option.label, badge, reason, learningHint ? `학습 제한. ${learningHint}` : null].filter(Boolean).join(', ')}
      accessibilityState={{ selected, checked: selected, disabled: !selectable }}
      aria-selected={selected}
      disabled={!selectable}
      onPress={() => onSelect(option.method)}
      style={[styles.row, selected && styles.rowSelected]}
    >
      <View testID={`order-method-${option.method}-icon`} style={[styles.icon, styles[`${icon.tone}Icon`], !selectable && styles.dim]}>
        <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={colors[icon.tone]} strokeWidth={2}
          strokeLinecap="round" strokeLinejoin="round" focusable={false} aria-hidden>
          <Path d={icon.path} />
        </Svg>
      </View>
      <View style={styles.rowCopy}>
        <View style={styles.titleLine}>
          <Text style={[styles.rowTitle, !selectable && styles.dimText]}>{option.label}</Text>
          {badge ? <Text testID={`order-method-${option.method}-badge`} style={styles.badge}>{badge}</Text> : null}
          {learningHint ? <LearningLock /> : null}
        </View>
        {reason ? <Text style={styles.reason}>{reason}</Text> : null}
      </View>
      {selected ? <Text style={styles.check} accessible={false} importantForAccessibility="no">✓</Text> : null}
    </ActionPressable>
  );
  // The beginner guide points into the sheet at the choice it asks for.
  const target = GUIDE_TARGET[option.method];
  return target ? <QuestTarget id={target}>{row}</QuestTarget> : row;
}

// Plain objects: the harnesses load this with minimal native mocks.
const styles = {
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: 12,
    minHeight: 52,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: semantic.border,
    backgroundColor: semantic.raised,
  },
  disabled: { opacity: 0.5 },
  fieldValue: { flex: 1, minWidth: 0, fontSize: 15, lineHeight: 21, fontWeight: '700', color: semantic.text },
  // A fixed touch-free box keeps the triangle centred at every font scale.
  chevron: { flexShrink: 0, width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  scroll: { flexGrow: 0, flexShrink: 1 },
  list: { gap: 2, paddingBottom: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 56,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 14,
  },
  rowSelected: { backgroundColor: semantic.raised },
  icon: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  successIcon: { backgroundColor: semantic.successSurface },
  infoIcon: { backgroundColor: semantic.infoSurface },
  warningIcon: { backgroundColor: semantic.warningSurface },
  mutedIcon: { backgroundColor: semantic.raised },
  dim: { opacity: 0.45 },
  rowCopy: { flex: 1, minWidth: 0, gap: 2 },
  titleLine: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 6, rowGap: 2 },
  rowTitle: { fontSize: 16, lineHeight: 22, fontWeight: '700', color: semantic.text },
  dimText: { color: semantic.muted },
  badge: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '700',
    color: semantic.secondary,
    backgroundColor: semantic.raised,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  reason: { fontSize: 12, lineHeight: 17, color: semantic.warning },
  check: { flexShrink: 0, fontSize: 20, lineHeight: 24, fontWeight: '700', color: semantic.info },
} as const;
