import React from "react";
import { StyleSheet, Text, TextInput, View } from "../../theme/native";
import ActionPressable from "../../components/common/ActionPressable";
import { semantic } from "../../theme/tokens";
import { formatDisplayDecimal } from "../../utils/format";
import type { ProtectionLeg } from "./api";
import Decimal from "decimal.js";
export type LegDraft = {
  enabled: boolean;
  trigger: string;
  type: "market" | "limit";
  limit: string;
};
export type ProtectionDraft = { stop_loss: LegDraft; take_profit: LegDraft };
export const emptyProtection = (): ProtectionDraft => ({
  stop_loss: { enabled: false, trigger: "", type: "market", limit: "" },
  take_profit: { enabled: false, trigger: "", type: "market", limit: "" },
});
export const protectionLabel = {
  stop_loss: "손절 (Stop Loss)",
  take_profit: "익절 (Take Profit)",
};
export function draftLegs(draft: ProtectionDraft): ProtectionLeg[] {
  return (["stop_loss", "take_profit"] as const)
    .filter((kind) => draft[kind].enabled)
    .map((kind) => ({
      kind,
      triggerPrice: draft[kind].trigger.trim(),
      childOrderType: draft[kind].type,
      ...(draft[kind].type === "limit"
        ? { childLimitPrice: draft[kind].limit.trim() }
        : {}),
    }));
}
export function protectionInputError(draft: ProtectionDraft, entry?: { direction: "long" | "short"; limitPrice: string }) {
  const valid = (value: string) =>
    /^\d{1,16}(\.\d{1,8})?$/.test(value) && /[1-9]/.test(value);
  const legs = draftLegs(draft);
  if (legs.some(
    (leg) =>
      !valid(leg.triggerPrice) ||
      (leg.childOrderType === "limit" && !valid(leg.childLimitPrice ?? "")),
  )) return "조건 가격과 지정가를 올바르게 입력해주세요.";
  if (entry && valid(entry.limitPrice)) {
    for (const leg of legs) {
      const below = (entry.direction === "long") === (leg.kind === "stop_loss");
      const comparison = new Decimal(leg.triggerPrice).cmp(entry.limitPrice);
      if (below ? comparison >= 0 : comparison <= 0) {
        return `${entry.direction.toUpperCase()} ${leg.kind === "stop_loss" ? "손절가" : "익절가"}는 진입 지정가보다 ${below ? "낮아야" : "높아야"} 합니다.`;
      }
    }
  }
  return null;
}
export function ProtectionEditor({
  value,
  onChange,
  disabled = false,
  canLimit = true,
  onInputFocus,
  onInputBlur,
}: {
  value: ProtectionDraft;
  onChange: (draft: ProtectionDraft) => void;
  disabled?: boolean;
  canLimit?: boolean;
  onInputFocus?: (input: View | null) => void;
  onInputBlur?: () => void;
}) {
  return (
    <View style={styles.editor}>
      {(["stop_loss", "take_profit"] as const).map((kind) => {
        const leg = value[kind];
        const change = (patch: Partial<LegDraft>) =>
          onChange({ ...value, [kind]: { ...leg, ...patch } });
        return (
          <View key={kind} style={styles.leg}>
            <ActionPressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: leg.enabled, disabled }}
              disabled={disabled}
              onPress={() => change({ enabled: !leg.enabled })}
              testID={`protection-${kind}-toggle`}
              style={styles.choice}
            >
              <Text style={styles.label}>
                {leg.enabled ? "☑" : "☐"} {protectionLabel[kind]}
              </Text>
            </ActionPressable>
            {leg.enabled ? (
              <>
                <Text style={styles.text}>조건 가격 (Trigger)</Text>
                <PriceInput
                  label={`${protectionLabel[kind]} 조건 가격`}
                  value={leg.trigger}
                  onChange={(trigger) => change({ trigger })}
                  disabled={disabled}
                  onInputFocus={onInputFocus}
                  onInputBlur={onInputBlur}
                />
                <Text style={styles.text}>조건 충족 후 실행 주문</Text>
                <View style={styles.choices}>
                  {(["market", "limit"] as const).map((type) => (
                    <ActionPressable
                      key={type}
                      disabled={disabled || (type === "limit" && !canLimit)}
                      accessibilityRole="radio"
                      accessibilityState={{
                        selected: leg.type === type,
                        disabled: disabled || (type === "limit" && !canLimit),
                      }}
                      onPress={() => change({ type })}
                      style={[
                        styles.choice,
                        leg.type === type && styles.selected,
                      ]}
                      testID={`protection-${kind}-${type}`}
                    >
                      <Text style={styles.text}>
                        {type === "market" ? "시장가" : "지정가"}
                      </Text>
                    </ActionPressable>
                  ))}
                </View>
                {leg.type === "limit" ? (
                  <>
                    <Text style={styles.text}>실행 지정가 (Limit)</Text>
                    <PriceInput
                      label={`${protectionLabel[kind]} 실행 지정가`}
                      value={leg.limit}
                      onChange={(limit) => change({ limit })}
                      disabled={disabled}
                      onInputFocus={onInputFocus}
                      onInputBlur={onInputBlur}
                    />
                  </>
                ) : null}
              </>
            ) : null}
          </View>
        );
      })}
      <Text style={styles.hint}>
        조건 가격은 체결 가격이 아닙니다. 지정가는 조건 충족 후에도 체결되지
        않을 수 있습니다.
      </Text>
    </View>
  );
}
function PriceInput({
  label,
  value,
  onChange,
  disabled,
  onInputFocus,
  onInputBlur,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  onInputFocus?: (input: View | null) => void;
  onInputBlur?: () => void;
}) {
  const ref = React.useRef<TextInput>(null);
  return (
    <View style={styles.leg}>
      <TextInput
        ref={ref}
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        editable={!disabled}
        keyboardType="decimal-pad"
        style={styles.input}
        onFocus={() => onInputFocus?.(ref.current)}
        onBlur={onInputBlur}
        placeholder="가격 입력"
      />
      {value.length > 12 ? (
        <Text style={styles.hint}>입력값 {formatDisplayDecimal(value)}</Text>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  editor: { gap: 12, minWidth: 0 },
  leg: { gap: 8, minWidth: 0 },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  choice: {
    minHeight: 44,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: semantic.border,
    justifyContent: "center",
    minWidth: 0,
  },
  selected: { backgroundColor: semantic.surface },
  label: {
    fontSize: 15,
    fontWeight: "700",
    color: semantic.text,
    flexShrink: 1,
  },
  text: { fontSize: 14, color: semantic.text, flexShrink: 1 },
  hint: { fontSize: 12, color: semantic.secondary, flexShrink: 1 },
  input: {
    minHeight: 46,
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 8,
    padding: 10,
    color: semantic.text,
    fontSize: 16,
    minWidth: 0,
    width: "100%",
  },
});
