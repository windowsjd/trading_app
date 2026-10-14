import LearningLock from '../../features/quest/LearningLock';
import QuestTarget from '../../features/quest/QuestTarget';
import React from 'react';
import { ScrollView, Text, View, useWindowDimensions } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import ActionPressable from '../../components/common/ActionPressable';
import InlineBottomSheet from '../../components/common/InlineBottomSheet';
import { SheetPortal } from '../../components/common/ScreenSheetHost';
import { TEST_IDS } from '../../constants/testIds';
import {
  ORDER_METHOD_HINT,
  ORDER_METHOD_LABEL,
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

/** Sheet rows the beginner guide may point at (QUEST 03–06). */
const GUIDE_TARGET: Partial<Record<OrderMethod, 'order-method-market' | 'order-method-limit' | 'order-method-protection'>> = {
  market: 'order-method-market',
  limit: 'order-method-limit',
  protection: 'order-method-protection',
};

/** The hint's longest word plus the chevron, at font scale 1 (Hangul ≈ 1em). */
const HINT_WORD_WIDTH = 4 * 11 + 4 + 9;

/**
 * 주문방식: one full-width field under the side choice that opens a bottom
 * sheet (reference video 1). The caller owns the method (every new form starts
 * at 시장가), its learning gates and the draft reset; a refused choice never
 * changes the field. A submit in flight disables the field.
 *
 * The selected method reads on the left and a small 주문방식 선택하기 on the
 * right says it can be changed. Narrow columns and large fonts wrap the hint's
 * two words, then move the hint under the method — never cut either.
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
  const { fontScale } = useWindowDimensions();
  const label = ORDER_METHOD_LABEL[method];
  return (
    <>
      <ActionPressable
        testID={TEST_IDS.order.typeSelect}
        accessibilityRole="button"
        accessibilityLabel={`주문방식 ${label}, ${ORDER_METHOD_HINT}`}
        accessibilityHint="주문방식 목록을 엽니다"
        accessibilityState={{ disabled, expanded: open }}
        disabled={disabled}
        onPress={onOpen}
        style={[styles.field, disabled && styles.disabled]}
      >
        <Text testID="order-type-select-value" style={styles.fieldValue}>{label}</Text>
        {/* The basis is one word wide, so the words wrap before the hint
            leaves the method's line; it grows into the free space. */}
        <View style={[styles.hint, { flexBasis: HINT_WORD_WIDTH * fontScale }]} accessible={false} importantForAccessibility="no-hide-descendants">
          <View testID="order-type-select-hint" style={styles.hintWords}>
            {ORDER_METHOD_HINT.split(' ').map((word) => <Text key={word} style={styles.hintText}>{word}</Text>)}
          </View>
          <Text style={styles.chevron}>▾</Text>
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
  const target = GUIDE_TARGET[option.method];
  return target ? <QuestTarget id={target}>{row}</QuestTarget> : row;
}

// Plain objects: the harnesses load this with minimal native mocks.
const styles = {
  field: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    // Wrapped lines pack at the top by default; keep them centred in the field.
    alignContent: 'center',
    alignItems: 'center',
    columnGap: 8,
    rowGap: 2,
    minHeight: 52,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: semantic.border,
    backgroundColor: semantic.raised,
  },
  disabled: { opacity: 0.5 },
  fieldValue: { flexShrink: 1, maxWidth: '100%', fontSize: 15, lineHeight: 21, fontWeight: '700', color: semantic.text },
  hint: { flexGrow: 1, flexShrink: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4 },
  hintWords: { flexShrink: 1, minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', columnGap: 3 },
  hintText: { fontSize: 11, lineHeight: 15, fontWeight: '600', color: semantic.secondary, textAlign: 'right' },
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
