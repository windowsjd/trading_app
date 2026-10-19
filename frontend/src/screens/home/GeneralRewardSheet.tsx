import React, { useEffect, useState } from 'react';
import Svg, { Path } from 'react-native-svg';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ScrollView, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { useAppearance } from '../../theme/appearance';
import ActionPressable from '../../components/common/ActionPressable';
import CTAButton from '../../components/common/CTAButton';
import InlineBottomSheet from '../../components/common/InlineBottomSheet';
import { SheetPortal } from '../../components/common/ScreenSheetHost';
import ErrorNotice from '../../components/states/ErrorNotice';
import { QUERY_KEYS } from '../../constants/queryKeys';
import {
  claimAdReward,
  getAccountResetEligibility,
  getAdRewardEligibility,
  resetGeneralAccount,
  type TradingAccountDto,
} from '../../features/tradingAccount/api';
import {
  invalidateAfterAccountReset,
  invalidateAfterAdRewardClaim,
} from '../../features/tradingAccount/invalidation';
import {
  getRewardedAdProvider,
  type RewardedAdProvider,
  type RewardedAdPurpose,
} from '../../features/adRewards/rewardedAd';
import {
  classifyRewardCommandFailure,
  formatManwon,
  GENERAL_ACCOUNT_RESET_TARGET_KRW,
  rewardSheetState,
  type RewardAttempt,
} from '../../features/adRewards/rewardFlow';
import { createIdempotencyKey } from '../../utils/idempotency';

/** The general home's header entry to the 보상 sheet (gift icon + 보상). */
export function HomeRewardButton({ onPress }: { onPress: () => void }) {
  const { colors } = useAppearance();
  return (
    <ActionPressable testID="home-reward-button" style={buttonStyles.button} onPress={onPress}
      accessibilityRole="button" accessibilityLabel="보상, 가상자금 추가와 일반계정 초기화">
      <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden>
        <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={colors.text}
          strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" focusable={false}>
          <Path d="M20 12v9H4v-9M2 7h20v5H2zM12 21V7M12 7H7.5a2.5 2.5 0 1 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 1 0 0-5C13 2 12 7 12 7z" />
        </Svg>
      </View>
      <Text style={buttonStyles.label} maxFontSizeMultiplier={1.6}>보상</Text>
    </ActionPressable>
  );
}

type Step =
  | { kind: 'menu' }
  | { kind: 'confirm-reset' }
  | { kind: 'working'; purpose: RewardedAdPurpose }
  | { kind: 'uncertain'; attempt: RewardAttempt; failure: unknown }
  | { kind: 'refused'; purpose: RewardedAdPurpose; failure: unknown }
  | { kind: 'dismissed' }
  | { kind: 'done'; purpose: RewardedAdPurpose };

/**
 * 자금 관리 — the general account's two ad rewards (2026-10-20): 가상자금 추가
 * (the server's top-up, 5,000,000 KRW) or 일반계정 초기화 (back to 10,000,000
 * KRW after a separate confirmation). One watched ad redeems ONE of them: the
 * purpose is chosen before the ad, the provider's proof is sent with a fresh
 * idempotency key, and an answer that never arrived is re-checked with the
 * same key and proof (never re-paid, never reset twice).
 *
 * Without a rewarded-ad SDK (today) there is no provider: both actions stay
 * disabled under "광고 기능 준비 중" and nothing is sent — not even the
 * eligibility reads. The server also refuses every claim and reset while no
 * verifier is registered.
 *
 * An attempt whose answer never arrived survives closing the sheet (it is
 * re-checked with the same key when reopened, and the caches it may have
 * changed are refreshed); every other step starts over when the sheet hides.
 */
export default function GeneralRewardSheet({
  visible,
  account,
  onClose,
  provider = getRewardedAdProvider(),
}: {
  visible: boolean;
  account: TradingAccountDto;
  onClose: () => void;
  /** The device's rewarded-ad provider; null while no SDK is integrated. */
  provider?: RewardedAdProvider | null;
}) {
  const accountId = account.id;
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>({ kind: 'menu' });
  const funding = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.adRewardEligibility(accountId),
    queryFn: () => getAdRewardEligibility(accountId),
    enabled: visible && !!provider,
    retry: false,
  });
  const reset = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.accountResetEligibility(accountId),
    queryFn: () => getAccountResetEligibility(accountId),
    enabled: visible && !!provider,
    retry: false,
  });
  useEffect(() => {
    if (!visible) {
      setStep((current) => (current.kind === 'uncertain' || current.kind === 'working' ? current : { kind: 'menu' }));
    }
  }, [visible]);
  const state = rewardSheetState({ providerReady: !!provider, funding: funding.data, reset: reset.data });
  const busy = step.kind === 'working';
  const amount = state.funding.amountLabel;
  const target = formatManwon(reset.data?.targetKrwBalance ?? GENERAL_ACCOUNT_RESET_TARGET_KRW);

  const close = () => {
    if (busy) return;
    if (step.kind === 'uncertain') {
      // It may have committed: show what the server holds now, and keep the
      // attempt for the same-key re-check next time.
      void (step.attempt.purpose === 'funding'
        ? invalidateAfterAdRewardClaim(queryClient, accountId)
        : invalidateAfterAccountReset(queryClient, accountId));
    } else {
      setStep({ kind: 'menu' });
    }
    onClose();
  };

  const submit = async (attempt: RewardAttempt) => {
    setStep({ kind: 'working', purpose: attempt.purpose });
    const body = { provider: attempt.providerKey, proof: attempt.proof, idempotencyKey: attempt.idempotencyKey };
    try {
      if (attempt.purpose === 'funding') {
        await claimAdReward(accountId, body);
        await invalidateAfterAdRewardClaim(queryClient, accountId);
      } else {
        await resetGeneralAccount(accountId, body);
        await invalidateAfterAccountReset(queryClient, accountId);
      }
      setStep({ kind: 'done', purpose: attempt.purpose });
    } catch (failure) {
      if (classifyRewardCommandFailure(failure) === 'uncertain') {
        setStep({ kind: 'uncertain', attempt, failure });
        return;
      }
      setStep({ kind: 'refused', purpose: attempt.purpose, failure });
      void funding.refetch();
      void reset.refetch();
    }
  };

  const start = async (purpose: RewardedAdPurpose) => {
    if (!provider) return;
    const idempotencyKey = createIdempotencyKey(purpose === 'funding' ? 'ad_reward_claim' : 'account_reset');
    setStep({ kind: 'working', purpose });
    let outcome;
    try {
      outcome = await provider.show({ purpose, tradingAccountId: accountId, idempotencyKey });
    } catch {
      outcome = { status: 'unavailable' as const };
    }
    if (outcome.status !== 'completed') {
      setStep({ kind: 'dismissed' });
      return;
    }
    await submit({ purpose, idempotencyKey, proof: outcome.proof, providerKey: provider.key });
  };

  const resetBlocked = state.reset.blockers.length > 0;
  return (
    <SheetPortal>
      <InlineBottomSheet testID="home-reward-sheet" title="자금 관리" visible={visible}
        dismissible={!busy} onClose={close}>
        <ScrollView style={styles.scroll} bounces={false}>
          <View style={styles.body}>
            {step.kind === 'done' ? (
              <View testID="reward-done" style={styles.result}>
                <Text accessibilityRole="header" style={styles.resultTitle}>
                  {step.purpose === 'funding' ? `가상자금 ${amount}이 추가되었습니다.` : '일반계정을 초기화했습니다.'}
                </Text>
                <Text style={styles.description}>
                  {step.purpose === 'funding'
                    ? '증권 원화 지갑에서 확인할 수 있습니다. 광고 보상금은 투자수익이 아니라 투자원금에 더해집니다.'
                    : `가상자금 ${target}으로 다시 시작합니다. 과거 거래 기록은 그대로 남아 있습니다.`}
                </Text>
                <CTAButton testID="reward-done-close" label="확인" onPress={close} />
              </View>
            ) : step.kind === 'uncertain' ? (
              <View testID="reward-uncertain" style={styles.result}>
                <Text accessibilityRole="header" style={styles.resultTitle}>결과를 확인하지 못했습니다.</Text>
                <Text style={styles.description}>
                  같은 요청으로 다시 확인합니다. 이미 처리되었다면 다시 지급되거나 초기화되지 않습니다.
                </Text>
                <ErrorNotice error={step.failure} message="네트워크 상태를 확인한 뒤 결과를 다시 확인해주세요." />
                <CTAButton testID="reward-retry" label="결과 확인" onPress={() => void submit(step.attempt)} />
              </View>
            ) : step.kind === 'confirm-reset' ? (
              <View testID="reward-reset-confirm" style={styles.section}>
                <Text accessibilityRole="header" style={styles.sectionTitle}>일반계정을 초기화할까요?</Text>
                {[
                  '일반계정의 투자 상태가 초기화됩니다.',
                  `현재 가상자금이 ${target}으로 조정됩니다.`,
                  '보유 종목, 선물 포지션이나 미체결·조건 주문이 있으면 진행할 수 없습니다.',
                  '과거 거래 기록은 그대로 보존됩니다.',
                  '확인 후에는 되돌리기 어렵습니다.',
                ].map((line) => (
                  <View key={line} style={styles.bulletRow}>
                    <Text style={styles.bullet} accessible={false}>•</Text>
                    <Text style={styles.bulletText}>{line}</Text>
                  </View>
                ))}
                {state.notice ? <Text style={styles.notice}>{state.notice}</Text> : null}
                <View style={styles.confirmActions}>
                  <View style={styles.flex}>
                    <CTAButton testID="reward-reset-cancel" label="취소" variant="neutral"
                      onPress={() => setStep({ kind: 'menu' })} />
                  </View>
                  <View style={styles.flex}>
                    <CTAButton testID="reward-reset-run" label="광고 보고 초기화"
                      state={state.reset.canStart ? 'enabled' : 'disabled'}
                      onPress={() => void start('account_reset')} />
                  </View>
                </View>
              </View>
            ) : (
              <>
                {state.notice ? (
                  <View testID="reward-ad-notice" style={styles.noticeBox}>
                    <Text style={styles.noticeTitle}>{state.notice}</Text>
                    <Text style={styles.description}>광고 연동이 완료되면 이 화면에서 바로 이용할 수 있습니다.</Text>
                  </View>
                ) : null}
                {step.kind === 'dismissed' ? (
                  <Text testID="reward-dismissed" style={styles.notice}>광고 시청이 완료되지 않아 아무것도 처리하지 않았습니다.</Text>
                ) : null}
                {step.kind === 'refused' ? (
                  <View testID="reward-refused" style={styles.refused}>
                    <Text style={styles.errorTitle}>
                      {step.purpose === 'funding' ? '가상자금을 추가하지 못했습니다.' : '일반계정을 초기화하지 못했습니다.'}
                    </Text>
                    {/* The server's own reason (limit, cooldown, verification, …). */}
                    <ErrorNotice error={step.failure} style={styles.errorNotice} />
                  </View>
                ) : null}
                <View testID="reward-funding" style={styles.section}>
                  <Text accessibilityRole="header" style={styles.sectionTitle}>가상자금 {amount} 추가</Text>
                  <Text style={styles.description}>
                    보상형 광고를 시청하면 일반계정에 가상자금 {amount}이 추가됩니다.
                  </Text>
                  {state.funding.status ? <Text testID="reward-funding-status" style={styles.status}>{state.funding.status}</Text> : null}
                  {funding.isError ? (
                    <ErrorNotice error={funding.error} message="보상 정보를 불러오지 못했습니다." />
                  ) : null}
                  <CTAButton testID="reward-funding-start" label="광고 보고 받기"
                    state={busy && step.purpose === 'funding' ? 'loading' : state.funding.canStart && !busy ? 'enabled' : 'disabled'}
                    onPress={() => void start('funding')} />
                </View>
                <View testID="reward-reset" style={styles.section}>
                  <Text accessibilityRole="header" style={styles.sectionTitle}>일반계정 초기화</Text>
                  <Text style={styles.description}>
                    일반계정의 투자 상태를 초기화하고 가상자금 {target}으로 다시 시작합니다.
                  </Text>
                  {resetBlocked ? (
                    <View testID="reward-reset-blockers" style={styles.blockers}>
                      <Text style={styles.status}>초기화하려면 먼저 정리해주세요.</Text>
                      {state.reset.blockers.map((line) => (
                        <View key={line} style={styles.bulletRow}>
                          <Text style={styles.bullet} accessible={false}>•</Text>
                          <Text style={styles.bulletText}>{line}</Text>
                        </View>
                      ))}
                    </View>
                  ) : null}
                  {state.reset.status ? <Text style={styles.status}>{state.reset.status}</Text> : null}
                  {reset.isError ? (
                    <ErrorNotice error={reset.error} message="초기화 가능 여부를 확인하지 못했습니다." />
                  ) : null}
                  <CTAButton testID="reward-reset-start" label="초기화하기"
                    state={busy && step.purpose === 'account_reset' ? 'loading' : state.reset.canStart && !busy ? 'enabled' : 'disabled'}
                    onPress={() => setStep({ kind: 'confirm-reset' })} />
                </View>
              </>
            )}
          </View>
        </ScrollView>
      </InlineBottomSheet>
    </SheetPortal>
  );
}

// Plain objects: screen harnesses load this with minimal react-native mocks.
const buttonStyles = {
  button: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 4, minHeight: 44, minWidth: 44,
    paddingHorizontal: 10, borderRadius: 999, justifyContent: 'center' as const },
  label: { fontSize: 14, fontWeight: '700' as const, color: semantic.text },
};

const styles = {
  scroll: { flexGrow: 0, flexShrink: 1 },
  body: { gap: 12, paddingBottom: 8 },
  noticeBox: { gap: 4, padding: 12, borderRadius: 12, backgroundColor: semantic.raised },
  noticeTitle: { fontSize: 15, lineHeight: 22, fontWeight: '700' as const, color: semantic.text },
  notice: { fontSize: 13, lineHeight: 19, color: semantic.secondary },
  errorNotice: { fontSize: 13, lineHeight: 19, color: semantic.warning },
  refused: { gap: 2 },
  errorTitle: { fontSize: 14, lineHeight: 21, fontWeight: '700' as const, color: semantic.warning },
  section: { gap: 8, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: semantic.border, backgroundColor: semantic.surface },
  sectionTitle: { fontSize: 17, lineHeight: 24, fontWeight: '700' as const, color: semantic.text },
  description: { fontSize: 14, lineHeight: 21, color: semantic.secondary },
  status: { fontSize: 13, lineHeight: 19, color: semantic.text },
  blockers: { gap: 4 },
  bulletRow: { flexDirection: 'row' as const, gap: 6, minWidth: 0 },
  bullet: { fontSize: 14, lineHeight: 21, color: semantic.secondary },
  bulletText: { flex: 1, minWidth: 0, fontSize: 14, lineHeight: 21, color: semantic.text },
  confirmActions: { flexDirection: 'row' as const, gap: 10, paddingTop: 4 },
  flex: { flex: 1, minWidth: 0 },
  result: { gap: 10, padding: 4 },
  resultTitle: { fontSize: 18, lineHeight: 26, fontWeight: '700' as const, color: semantic.text },
};
