import React, { useEffect, useRef, useState } from 'react';
import { Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import CTAButton from '../../components/common/CTAButton';
import { createRewardedTestRun, type RewardedTestState } from '../../features/adRewards/rewardedTest';
import { getRewardedTestUnit, loadRewardedTestSdk } from '../../features/adRewards/rewardedTestSdk';
import { getSessionGeneration, isCurrentSession } from '../../services/api/sessionOwnership';
import { REWARDED_TEST_STAGES } from '../../features/adRewards/rewardedTestDiagnostics';

const messages: Record<RewardedTestState['phase'], string> = {
  idle: '테스트 광고를 불러와 준비되면 직접 시청할 수 있습니다.',
  initializing: '광고 SDK와 개인정보 선택을 확인하고 있습니다.', loading: '테스트 광고를 불러오고 있습니다.',
  ready: '테스트 광고가 준비되었습니다.', opening: '테스트 광고 표시를 요청하고 있습니다.', showing: '테스트 광고 표시 중입니다.',
  earned: '테스트 광고 보상 이벤트를 수신했습니다. 광고를 닫으면 화면으로 돌아옵니다.',
  closed: '테스트 광고 시청 완료', dismissed: '광고가 시청 완료 전에 종료되었습니다.',
  'sdk-error': '광고 SDK를 준비하지 못했습니다. 최신 테스트 빌드와 네트워크·개인정보 설정을 확인해주세요.',
  'load-error': '테스트 광고를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.',
  'show-error': '테스트 광고를 표시하지 못했습니다. 다시 불러와주세요.',
};

/** Separate from verified funding/reset: a local test event is never a proof. */
export default function RewardedTestPanel() {
  const unitId = getRewardedTestUnit();
  return unitId ? <RewardedTestRun unitId={unitId} /> : null;
}

function RewardedTestRun({ unitId }: { unitId: string }) {
  const [state, setState] = useState<RewardedTestState>({ phase: 'idle', privacyOptionsRequired: false });
  const run = useRef<ReturnType<typeof createRewardedTestRun> | null>(null);
  useEffect(() => {
    const session = getSessionGeneration();
    const current = createRewardedTestRun({ unitId, loadSdk: loadRewardedTestSdk,
      diagnosticsEnabled: getRewardedTestUnit() === unitId,
      onState: setState, isCurrent: () => isCurrentSession(session) });
    run.current = current;
    return () => { current.dispose(); run.current = null; };
  }, [unitId]);
  const busy = ['initializing', 'loading', 'ready', 'opening', 'showing', 'earned'].includes(state.phase);
  return (
    <View testID="reward-test-panel" style={styles.panel}>
      <Text style={styles.title} accessibilityRole="header">보상형 테스트 광고</Text>
      <Text style={styles.description}>Google 테스트 광고입니다. 시청해도 가상자금 지급이나 계정 초기화는 실행되지 않습니다.</Text>
      <Text testID="reward-test-status" style={styles.status} accessibilityLiveRegion="polite">{messages[state.phase]}</Text>
      {getRewardedTestUnit() === unitId && state.diagnostic ? (
        <View testID="reward-test-diagnostic" style={styles.diagnostic} accessibilityLiveRegion="polite">
          <Text style={styles.title}>{state.phase === 'sdk-error' ? '광고 SDK 준비 실패' : '테스트 광고 실행 실패'}</Text>
          <Text style={styles.status}>실패 단계: {REWARDED_TEST_STAGES[state.diagnostic.stage]}</Text>
          <Text style={styles.status}>{state.diagnostic.codeSource === 'internal' ? '앱 내부 진단 코드' : 'SDK 오류 코드'}: {state.diagnostic.code}</Text>
          <Text style={styles.status}>상세: {state.diagnostic.detail}</Text>
        </View>
      ) : null}
      <CTAButton testID="reward-test-load" label="테스트 광고 불러오기"
        state={busy ? 'disabled' : 'enabled'} onPress={() => void run.current?.load()} />
      <CTAButton testID="reward-test-show" label="테스트 광고 시청"
        state={state.phase === 'ready' ? 'enabled' : 'disabled'} onPress={() => void run.current?.show()} />
      {state.privacyOptionsRequired ? <CTAButton testID="reward-test-privacy" label="광고 개인정보 선택"
        variant="neutral" state={busy && state.phase !== 'ready' ? 'disabled' : 'enabled'} onPress={() => void run.current?.privacyOptions()} /> : null}
    </View>
  );
}

const styles = {
  panel: { minWidth: 0, alignSelf: 'stretch' as const, gap: 8, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: semantic.border, backgroundColor: semantic.surface },
  diagnostic: { minWidth: 0, gap: 6, paddingVertical: 8 },
  title: { fontSize: 17, lineHeight: 24, fontWeight: '700' as const, color: semantic.text },
  description: { fontSize: 14, lineHeight: 21, color: semantic.secondary },
  status: { flexShrink: 1, minWidth: 0, fontSize: 13, lineHeight: 20, color: semantic.text },
};
