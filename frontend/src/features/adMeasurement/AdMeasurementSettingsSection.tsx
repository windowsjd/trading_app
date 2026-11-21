import React from 'react';
import { Linking, Platform, Switch, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { useAppearance } from '../../theme/appearance';
import ActionPressable from '../../components/common/ActionPressable';
import { measurementAllowed } from './consent';
import { adMeasurement, alertIfNotSaved, useAdMeasurement } from './adMeasurement';
import type { AdMeasurementState } from './controller';

/** The line under the switch: what is (and is not) sent right now. */
export function adMeasurementStatus(state: AdMeasurementState, platform: 'ios' | 'android'): string {
  if (!state.ready) return '확인 중입니다.';
  if (state.choice !== 'granted')
    return state.active
      ? '동의하지 않음 · 측정을 바로 중단하지 못했습니다. 앱을 다시 실행하면 측정하지 않습니다.'
      : '동의하지 않음 · Meta에 아무 정보도 보내지 않습니다.';
  if (platform === 'ios' && state.tracking?.status !== 'granted')
    return state.tracking?.status === 'undetermined'
      ? '동의함 · iOS 앱 추적 허용을 아직 선택하지 않아 측정하지 않습니다.'
      : '동의함 · iOS에서 앱 추적을 허용하지 않아 측정하지 않습니다. 허용하려면 iOS 설정을 여세요.';
  if (!state.active && measurementAllowed(platform, state.choice, state.tracking))
    return state.deferred
      ? '동의함 · 앱을 다시 실행하면 측정을 시작합니다.'
      : '동의함 · 측정을 시작하지 못했습니다. 앱을 다시 실행하면 다시 시도합니다.';
  return '동의함 · 앱 설치·실행 정보를 Meta에 보냅니다.';
}

/**
 * 설정 › 광고 성과 측정 (2026-11-21), in MY › 설정 and on the guest's 투자모드
 * tab: the device's current choice, withdrawn by turning the switch off
 * (at once, no extra step) and given by turning it on, which shows the full
 * notice first. On iOS a consent without 앱 추적 허용 measures nothing; the
 * system prompt is offered once while undecided, after that only the system
 * settings can change it.
 */
export default function AdMeasurementSettingsSection({ testID = 'settings-ad-measurement' }: { testID?: string }) {
  const state = useAdMeasurement();
  const { colors } = useAppearance();
  if (!state.supported) return null;
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';
  const granted = state.choice === 'granted';
  const tracking = state.tracking;
  const trackingAction = platform === 'ios' && granted && tracking?.status !== 'granted'
    ? (tracking?.status === 'undetermined' && tracking.canAskAgain ? 'request' : 'settings')
    : null;
  const disabled = !state.ready || state.busy;
  // RN Web selects the active thumb through a separate prop; native uses thumbColor.
  const activeSwitchColor = Platform.OS === 'web' ? { activeThumbColor: colors.secondaryActionForeground } : {};

  return (
    <View testID={testID} style={styles.card}>
      <View style={styles.switchRow}>
        <Text style={styles.title}>광고 성과 측정 (선택)</Text>
        <Switch
          {...activeSwitchColor}
          testID={`${testID}-switch`}
          accessibilityLabel="광고 성과 측정 동의"
          trackColor={{ false: colors.border, true: colors.secondaryActionSurface }}
          thumbColor={granted ? colors.secondaryActionForeground : colors.text}
          ios_backgroundColor={colors.border}
          value={granted}
          disabled={disabled}
          onValueChange={(on) => {
            if (on) adMeasurement.openSettingsPrompt();
            else void adMeasurement.answer('declined').then(alertIfNotSaved);
          }}
        />
      </View>
      <Text testID={`${testID}-status`} style={styles.helper}>{adMeasurementStatus(state, platform)}</Text>
      <Text style={styles.helper}>
        Meta 광고를 보고 앱을 설치했는지 측정합니다. 동의하지 않아도 모든 기능을 그대로 이용할 수 있습니다.
      </Text>
      {trackingAction ? (
        <ActionPressable testID={`${testID}-tracking`} accessibilityRole="button" disabled={disabled} style={styles.link}
          onPress={() => {
            if (trackingAction === 'request') void adMeasurement.answer('granted').then(alertIfNotSaved);
            else void Linking.openSettings();
          }}>
          <Text style={styles.linkText}>{trackingAction === 'request' ? 'iOS 앱 추적 허용 요청하기' : 'iOS 설정 열기'}</Text>
        </ActionPressable>
      ) : null}
      <ActionPressable testID={`${testID}-notice`} accessibilityRole="button" disabled={disabled} style={styles.link}
        onPress={() => adMeasurement.openSettingsPrompt()}>
        <Text style={styles.linkText}>동의 내용 보기</Text>
      </ActionPressable>
    </View>
  );
}

// Plain objects: screen harnesses load this with minimal react-native mocks.
const styles = {
  card: {
    borderWidth: 1, borderColor: semantic.border, borderRadius: 14, padding: 16, backgroundColor: semantic.surface, gap: 10,
  },
  switchRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12 },
  title: { flex: 1, minWidth: 0, fontSize: 18, lineHeight: 27, fontWeight: '700' as const },
  helper: { fontSize: 14, color: semantic.secondary, lineHeight: 20 },
  link: { minHeight: 44, justifyContent: 'center' as const, alignSelf: 'flex-start' as const },
  linkText: { fontSize: 14, lineHeight: 20, fontWeight: '600' as const, textDecorationLine: 'underline' as const },
};
