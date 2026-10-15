import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import ActionPressable from '../../components/common/ActionPressable';
import CTAButton from '../../components/common/CTAButton';
import InlineBottomSheet from '../../components/common/InlineBottomSheet';
import { SheetPortal } from '../../components/common/ScreenSheetHost';
import QuestTarget from '../../features/quest/QuestTarget';
import { FUTURES_LEVERAGE_PRESETS, isFuturesLeverage } from '../../features/futures/orderSizing';
import OrderNumberInput, { orderInputStyle } from '../order/OrderNumberInput';
import QuantityRatioSlider from '../order/QuantityRatioSlider';

export type FuturesLeverageSheet = 'list' | 'custom' | null;

/**
 * 레버리지 for a new position: the field shows the chosen multiple (`10x`) and
 * opens the preset list; 직접 설정하기 at its end opens a second sheet for any
 * integer 1–100, applied only by 설정하기. Closing either sheet keeps the
 * previous leverage. The screen owns the value and the open sheet (a command
 * in flight closes it); an open position's leverage is fixed and not offered.
 */
export default function FuturesLeverageSelect({ leverage, onChange, disabled, sheet, onSheetChange }: {
  leverage: number;
  onChange: (leverage: number) => void;
  disabled: boolean;
  sheet: FuturesLeverageSheet;
  onSheetChange: (sheet: FuturesLeverageSheet) => void;
}) {
  const choose = (value: number) => {
    onSheetChange(null);
    onChange(value);
  };
  return (
    <View style={styles.group}>
      <Text style={styles.label}>레버리지</Text>
      <ActionPressable
        testID="futures-leverage-select"
        accessibilityRole="button"
        accessibilityLabel={`레버리지 ${leverage}배`}
        accessibilityHint="레버리지 배수 목록을 엽니다"
        accessibilityState={{ disabled, expanded: sheet !== null }}
        disabled={disabled}
        onPress={() => onSheetChange('list')}
        style={[styles.field, disabled && styles.disabled]}
      >
        <Text testID="futures-leverage-value" style={styles.fieldValue}>{leverage}x</Text>
        <Text style={styles.chevron} accessible={false}>▾</Text>
      </ActionPressable>
      <SheetPortal>
        <InlineBottomSheet testID="futures-leverage-sheet" title="레버리지" floating visible={sheet === 'list'} onClose={() => onSheetChange(null)}>
          <View style={styles.sheetBody}>
            <ScrollView testID="futures-leverage-list" style={styles.scroll} bounces={false}>
              <View accessibilityRole="radiogroup" accessibilityLabel="레버리지 배수" style={styles.list}>
                {FUTURES_LEVERAGE_PRESETS.map((value) => {
                  const selected = value === leverage;
                  const row = (
                    <ActionPressable
                      key={value}
                      testID={`futures-leverage-option-${value}`}
                      accessibilityRole="radio"
                      accessibilityLabel={`${value}배`}
                      accessibilityState={{ selected, checked: selected }}
                      aria-selected={selected}
                      onPress={() => choose(value)}
                      style={[styles.row, selected && styles.rowSelected]}
                    >
                      <Text style={[styles.rowText, selected && styles.rowTextSelected]}>{value}x</Text>
                      {selected ? <Text style={styles.check} accessible={false} importantForAccessibility="no">✓</Text> : null}
                    </ActionPressable>
                  );
                  // The beginner futures practice suggests a low 2x.
                  return value === 2 ? <QuestTarget key={value} id="futures-leverage-suggested">{row}</QuestTarget> : row;
                })}
              </View>
            </ScrollView>
            <CTAButton variant="secondary" testID="futures-leverage-custom" label="직접 설정하기" onPress={() => onSheetChange('custom')} />
          </View>
        </InlineBottomSheet>
      </SheetPortal>
      <SheetPortal>
        <InlineBottomSheet testID="futures-leverage-custom-sheet" title="레버리지 직접 설정" floating visible={sheet === 'custom'} onClose={() => onSheetChange(null)}>
          {/* Every opening (also one during the closing motion) starts a fresh draft. */}
          <CustomLeverage key={sheet === 'custom' ? 'open' : 'closed'} current={leverage} onApply={choose} />
        </InlineBottomSheet>
      </SheetPortal>
    </View>
  );
}

/** Starts from the current leverage; only 설정하기 applies the draft. */
function CustomLeverage({ current, onApply }: { current: number; onApply: (leverage: number) => void }) {
  const [draft, setDraft] = useState(String(current));
  const value = /^\d{1,3}$/u.test(draft) ? Number(draft) : NaN;
  const valid = isFuturesLeverage(value);
  const set = (next: number) => setDraft(String(Math.min(100, Math.max(1, next))));
  return (
    <View style={styles.custom} testID="futures-leverage-custom-body">
      <Text style={styles.helper}>현재 {current}x · 1~100배 정수로 설정할 수 있습니다.</Text>
      <View style={styles.stepper}>
        <StepButton testID="futures-leverage-decrease" label="레버리지 1배 줄이기" glyph="−" disabled={!valid || value <= 1} onPress={() => set(value - 1)} />
        <View style={styles.inputGroup}>
          <OrderNumberInput
            testID="futures-leverage-input"
            accessibilityLabel="레버리지 배수"
            value={draft}
            onChangeText={setDraft}
            keyboardType="number-pad"
            maxLength={3}
            style={[styles.input, styles.inputCentered]}
          />
        </View>
        <Text style={styles.unit} accessible={false}>x</Text>
        <StepButton testID="futures-leverage-increase" label="레버리지 1배 늘리기" glyph="+" disabled={!valid || value >= 100} onPress={() => set(value + 1)} />
      </View>
      <QuantityRatioSlider
        testID="futures-leverage-slider"
        accessibilityLabel="레버리지 배수"
        steps={99}
        valueText={(step) => `${step + 1}배`}
        stepLabel="1배"
        value={valid ? (value - 1) / 99 : 0}
        disabled={false}
        onChange={(ratio) => set(Math.round(ratio * 99) + 1)}
      />
      <View style={styles.scale} accessible={false} importantForAccessibility="no-hide-descendants">
        <Text style={styles.scaleText}>1x</Text>
        <Text style={styles.scaleText}>100x</Text>
      </View>
      {!valid ? (
        <Text testID="futures-leverage-error" accessibilityLiveRegion="polite" style={styles.error}>
          레버리지는 1~100 사이의 정수로 입력해주세요.
        </Text>
      ) : null}
      <CTAButton testID="futures-leverage-apply" label="설정하기" state={valid ? 'enabled' : 'disabled'} onPress={() => { if (valid) onApply(value); }} />
    </View>
  );
}

function StepButton({ testID, label, glyph, disabled, onPress }: {
  testID: string; label: string; glyph: string; disabled: boolean; onPress: () => void;
}) {
  return (
    <ActionPressable testID={testID} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}
      disabled={disabled} onPress={onPress} style={[styles.step, disabled && styles.disabled]}>
      <Text style={styles.stepText}>{glyph}</Text>
    </ActionPressable>
  );
}

const styles = StyleSheet.create({
  group: { gap: 4, minWidth: 0 },
  label: { fontSize: 12, color: semantic.muted },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: 8,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: semantic.border,
    backgroundColor: semantic.raised,
    minWidth: 0,
  },
  disabled: { opacity: 0.5 },
  fieldValue: { flexShrink: 1, fontSize: 15, lineHeight: 21, fontWeight: '700', color: semantic.text, fontVariant: ['tabular-nums'] },
  chevron: { flexShrink: 0, fontSize: 13, lineHeight: 18, fontWeight: '600', color: semantic.secondary },
  sheetBody: { flexShrink: 1, gap: 8, minHeight: 0 },
  scroll: { flexGrow: 0, flexShrink: 1 },
  list: { gap: 2, paddingBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 14 },
  rowSelected: { backgroundColor: semantic.raised },
  rowText: { flex: 1, minWidth: 0, fontSize: 16, lineHeight: 22, fontWeight: '600', color: semantic.text, fontVariant: ['tabular-nums'] },
  rowTextSelected: { fontWeight: '800' },
  check: { flexShrink: 0, fontSize: 20, lineHeight: 24, fontWeight: '700', color: semantic.info },
  custom: { gap: 12, paddingBottom: 4, minWidth: 0 },
  helper: { fontSize: 13, lineHeight: 19, color: semantic.secondary },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
  inputGroup: { flex: 1, minWidth: 0 },
  input: { ...orderInputStyle },
  inputCentered: { textAlign: 'center', fontWeight: '700' },
  unit: { fontSize: 16, fontWeight: '700', color: semantic.secondary },
  step: { width: 48, height: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: semantic.raised, borderWidth: 1, borderColor: semantic.border },
  stepText: { fontSize: 22, lineHeight: 26, fontWeight: '700', color: semantic.text },
  scale: { flexDirection: 'row', justifyContent: 'space-between', marginTop: -6 },
  scaleText: { fontSize: 11, color: semantic.muted, fontVariant: ['tabular-nums'] },
  error: { fontSize: 12, lineHeight: 18, color: semantic.error },
});
