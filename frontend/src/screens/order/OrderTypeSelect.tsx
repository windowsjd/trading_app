import LearningLock from '../../features/quest/LearningLock';
import QuestTarget from '../../features/quest/QuestTarget';
import React from 'react';
import { ScrollView, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import ActionPressable from '../../components/common/ActionPressable';
import InlineBottomSheet from '../../components/common/InlineBottomSheet';
import { SheetPortal } from '../../components/common/ScreenSheetHost';
import { TEST_IDS } from '../../constants/testIds';
import {
  ORDER_METHOD_LABEL,
  ORDER_METHOD_PLACEHOLDER,
  getAvailabilityLabel,
  isOrderMethodSelectable,
  type OrderMethod,
  type OrderMethodOption,
} from '../../features/order/orderMethods';

export type { OrderMethod } from '../../features/order/orderMethods';

/** Icon glyph and tint per method (font-safe glyphs, themed circle). */
const ICON: Record<OrderMethod, { glyph: string; tone: 'success' | 'info' | 'warning' | 'muted' }> = {
  market: { glyph: '→', tone: 'success' },
  limit: { glyph: '↓', tone: 'info' },
  conditional: { glyph: '◎', tone: 'info' },
  loc: { glyph: '◑', tone: 'warning' },
  protection: { glyph: '↕', tone: 'muted' },
};

/**
 * 주문방식: one full-width field under 매수/매도 that opens a bottom sheet
 * (reference video 1). The caller owns the method, its learning gates and the
 * draft reset; nothing is preselected, and a refused choice never changes the
 * field. A submit in flight disables the field.
 */
export default function OrderTypeSelect({ method, options, disabled, open, onOpen, onClose, onSelect, learningHints }: {
  method: OrderMethod | null;
  options: OrderMethodOption[];
  disabled: boolean;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onSelect: (method: OrderMethod) => void;
  /** Beginner learning locks per method, shown on the row. */
  learningHints?: Partial<Record<OrderMethod, string | null>>;
}) {
  const label = method ? ORDER_METHOD_LABEL[method] : ORDER_METHOD_PLACEHOLDER;
  return (
    <>
      <ActionPressable
        testID={TEST_IDS.order.typeSelect}
        accessibilityRole="button"
        accessibilityLabel={method ? `주문방식 ${label}, 변경` : ORDER_METHOD_PLACEHOLDER}
        accessibilityHint="주문방식 목록을 엽니다"
        accessibilityState={{ disabled, expanded: open }}
        disabled={disabled}
        onPress={onOpen}
        style={[styles.field, disabled && styles.disabled]}
      >
        <View style={styles.fieldCopy}>
          {method ? <Text style={styles.caption}>주문방식</Text> : null}
          <Text testID="order-type-select-value" style={[styles.fieldValue, !method && styles.placeholder]}>{label}</Text>
        </View>
        <Text style={styles.chevron} accessible={false} importantForAccessibility="no">▾</Text>
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
  const row = (
    <ActionPressable
      testID={`order-method-${option.method}`}
      accessibilityRole="radio"
      accessibilityLabel={[option.label, badge, option.description, reason, learningHint ? `학습 제한. ${learningHint}` : null].filter(Boolean).join(', ')}
      accessibilityState={{ selected, checked: selected, disabled: !selectable }}
      aria-selected={selected}
      disabled={!selectable}
      onPress={() => onSelect(option.method)}
      style={[styles.row, selected && styles.rowSelected]}
    >
      <View style={[styles.icon, styles[`${icon.tone}Icon`], !selectable && styles.dim]}>
        <Text style={[styles.iconText, styles[`${icon.tone}Glyph`]]}>{icon.glyph}</Text>
      </View>
      <View style={styles.rowCopy}>
        <View style={styles.titleLine}>
          <Text style={[styles.rowTitle, !selectable && styles.dimText]}>{option.label}</Text>
          {badge ? <Text testID={`order-method-${option.method}-badge`} style={styles.badge}>{badge}</Text> : null}
          {learningHint ? <LearningLock /> : null}
        </View>
        <Text style={styles.rowDescription}>{option.description}</Text>
        {reason ? <Text style={styles.reason}>{reason}</Text> : null}
      </View>
      {selected ? <Text style={styles.check} accessible={false} importantForAccessibility="no">✓</Text> : null}
    </ActionPressable>
  );
  // The beginner guide points into the sheet at the choice it asks for.
  return option.method === 'market' || option.method === 'limit'
    ? <QuestTarget id={option.method === 'market' ? 'order-method-market' : 'order-method-limit'}>{row}</QuestTarget>
    : row;
}

// Plain objects: the harnesses load this with minimal native mocks.
const styles = {
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 52,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: semantic.border,
    backgroundColor: semantic.raised,
  },
  disabled: { opacity: 0.5 },
  fieldCopy: { flex: 1, minWidth: 0, gap: 1 },
  caption: { fontSize: 11, lineHeight: 15, color: semantic.muted },
  fieldValue: { fontSize: 15, lineHeight: 21, fontWeight: '700', color: semantic.text },
  placeholder: { fontWeight: '600', color: semantic.secondary },
  chevron: { flexShrink: 0, fontSize: 13, lineHeight: 18, fontWeight: '600', color: semantic.secondary },
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
  iconText: { fontSize: 16, lineHeight: 20, fontWeight: '800' },
  successGlyph: { color: semantic.success },
  infoGlyph: { color: semantic.info },
  warningGlyph: { color: semantic.warning },
  mutedGlyph: { color: semantic.muted },
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
  rowDescription: { fontSize: 13, lineHeight: 18, color: semantic.secondary },
  reason: { fontSize: 12, lineHeight: 17, color: semantic.warning },
  check: { flexShrink: 0, fontSize: 20, lineHeight: 24, fontWeight: '700', color: semantic.info },
} as const;
