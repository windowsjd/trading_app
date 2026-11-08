import React, { useEffect, useRef, useState } from 'react';
import Svg, { Path } from 'react-native-svg';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ScrollView, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { useAppearance } from '../../theme/appearance';
import HomeHeaderButton from './HomeHeaderButton';
import CTAButton from '../../components/common/CTAButton';
import InlineBottomSheet from '../../components/common/InlineBottomSheet';
import { SheetPortal } from '../../components/common/ScreenSheetHost';
import ErrorNotice from '../../components/states/ErrorNotice';
import { QUERY_KEYS } from '../../constants/queryKeys';
import {
  claimAdReward,
  createAdRewardSession,
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
  type RewardedAdPhase,
  type RewardedAdProvider,
  type RewardedAdPurpose,
} from '../../features/adRewards/rewardedAd';
import {
  classifyRewardCommandFailure,
  forgetRewardAttempt,
  formatManwon,
  GENERAL_ACCOUNT_RESET_TARGET_KRW,
  rememberedRewardAttempt,
  rememberRewardAttempt,
  REWARD_CONFIRM_POLL_MS,
  REWARD_CONFIRM_WAIT_MS,
  rewardRefusalMessage,
  rewardSheetState,
  type RewardAttempt,
} from '../../features/adRewards/rewardFlow';
import { ensureAdsReady, showAdsPrivacyOptions } from '../../features/ads/adsRuntime';
import { getSessionGeneration, isCurrentSession } from '../../services/api/sessionOwnership';
import { createIdempotencyKey } from '../../utils/idempotency';

/** The general home's header entry to the 보상 sheet (gift icon + 보상). */
/** 보상 in Home's header (general accounts): the shared header button look (2026-11-07); the sheet is unchanged. */
export function HomeRewardButton({ onPress, iconOnly = false }: { onPress: () => void; iconOnly?: boolean }) {
  const { colors } = useAppearance();
  return (
    <HomeHeaderButton testID="home-reward-button" label="보상" accessibilityLabel="보상, 가상자금 추가와 일반계정 초기화"
      iconOnly={iconOnly} onPress={onPress}
      icon={(
        <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden>
          <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={colors.secondaryActionForeground}
            strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" focusable={false}>
            <Path d="M20 12v9H4v-9M2 7h20v5H2zM12 21V7M12 7H7.5a2.5 2.5 0 1 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 1 0 0-5C13 2 12 7 12 7z" />
          </Svg>
        </View>
      )} />
  );
}

type WorkingPhase = 'preparing' | RewardedAdPhase | 'confirming';
type AdFailure = 'consent' | 'load' | 'show' | 'busy';
type Step =
  | { kind: 'menu' }
  | { kind: 'confirm-reset' }
  | { kind: 'working'; purpose: RewardedAdPurpose; phase: WorkingPhase }
  /**
   * The ad was watched and its result is not final yet: Google's signed
   * confirmation has not reached the server (`confirmation`), or it did and
   * the server is still completing the command (`processing`). Either may
   * still be applied later; neither is a refusal.
   */
  | { kind: 'verifying'; attempt: RewardAttempt; stage: 'confirmation' | 'processing' }
  | { kind: 'uncertain'; attempt: RewardAttempt; failure: unknown }
  | { kind: 'refused'; purpose: RewardedAdPurpose; failure: unknown }
  | { kind: 'ad-failed'; reason: AdFailure }
  | { kind: 'dismissed' }
  | { kind: 'done'; purpose: RewardedAdPurpose };

const PHASE_TEXT: Record<WorkingPhase, string> = {
  preparing: '광고를 준비하고 있어요.',
  loading: '광고를 불러오고 있어요.',
  showing: '광고를 시청하고 있어요.',
  earned: '광고를 시청하고 있어요.',
  confirming: '광고 시청을 확인하고 있어요.',
};
const AD_FAILURE_TEXT: Record<AdFailure, string> = {
  consent: '광고 개인정보 선택에 따라 지금은 광고를 표시할 수 없어요.',
  load: '광고를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.',
  show: '광고를 표시하지 못했어요. 다시 시도해 주세요.',
  busy: '다른 광고가 표시되고 있어요. 잠시 후 다시 시도해 주세요.',
};
const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * 자금 관리 — the general account's two ad rewards (2026-10-20): 가상자금 추가
 * (the server's top-up, 5,000,000 KRW) or 일반계정 초기화 (back to 10,000,000
 * KRW after a separate confirmation). One watched ad redeems ONE of them.
 *
 * With AdMob (2026-11-07): the server first opens a session for the chosen
 * command (purpose + a fresh idempotency key) — refusing it when the command
 * could not succeed now — then the rewarded ad is shown with that session's
 * server-side verification options. Watching it to the end only lets the app
 * ASK: the server pays or resets once Google's signed callback confirmed the
 * session (it does so by itself when the callback arrives, even if the app
 * closed, and its recovery worker completes it after a temporary failure).
 * From then on the same-key call only READS the server's result (2026-11-08):
 * "not confirmed yet" or "still being completed" is asked again with the same
 * key for a while, then shown as 확인 대기 with a 결과 확인 button — it may
 * still be applied later; an answer that never arrived is re-checked the same
 * way; a closed command is a final refusal with its reason. So 결과 확인 is
 * never a new consent: redoing a refused reset is a new ad after its own
 * confirmation. Such an attempt survives closing the sheet and re-mounting it
 * for the same sign-in and account.
 * Without a provider (web, Expo Go, an unknown build) or a server that can
 * verify ads, both actions stay disabled and nothing is sent.
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
  /** AdMob on a native build; null on web/Expo Go/unknown builds. */
  provider?: RewardedAdProvider | null;
}) {
  const accountId = account.id;
  const queryClient = useQueryClient();
  // One sign-in and account: an attempt never moves to another account.
  const [scope] = useState(() => ({ key: `${getSessionGeneration()}:${accountId}`, generation: getSessionGeneration() }));
  const [step, setStep] = useState<Step>(() => {
    const open = rememberedRewardAttempt(scope.key);
    return open ? { kind: 'verifying', attempt: open, stage: 'confirmation' } : { kind: 'menu' };
  });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const current = () => alive.current && isCurrentSession(scope.generation);
  // Synchronous guard: a second tap before the next render starts nothing.
  const running = useRef(false);
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
  // Google's privacy options entry, when its consent (UMP) asks for one.
  const [privacyRequired, setPrivacyRequired] = useState(false);
  useEffect(() => {
    if (!visible || !provider) return undefined;
    let live = true;
    ensureAdsReady().then((readiness) => { if (live) setPrivacyRequired(readiness.privacyOptionsRequired); }, () => undefined);
    return () => { live = false; };
  }, [visible, provider]);
  useEffect(() => {
    if (!visible) {
      setStep((now) => (now.kind === 'uncertain' || now.kind === 'working' || now.kind === 'verifying' ? now : { kind: 'menu' }));
    }
  }, [visible]);
  const state = rewardSheetState({ providerReady: !!provider, funding: funding.data, reset: reset.data });
  const busy = step.kind === 'working';
  const amount = state.funding.amountLabel;
  const target = formatManwon(reset.data?.targetKrwBalance ?? GENERAL_ACCOUNT_RESET_TARGET_KRW);

  const refreshMoney = (purpose: RewardedAdPurpose) => (purpose === 'funding'
    ? invalidateAfterAdRewardClaim(queryClient, accountId)
    : invalidateAfterAccountReset(queryClient, accountId));

  const close = () => {
    if (busy) return;
    if (step.kind === 'uncertain' || step.kind === 'verifying') {
      // It may commit (or has): show what the server holds now, and keep the
      // attempt for the same-key re-check next time.
      void refreshMoney(step.attempt.purpose);
    } else {
      setStep({ kind: 'menu' });
    }
    onClose();
  };

  /** The same command (key, proof) until the server answers it. */
  const submit = async (attempt: RewardAttempt) => {
    if (running.current) return;
    running.current = true;
    rememberRewardAttempt(scope.key, attempt);
    setStep({ kind: 'working', purpose: attempt.purpose, phase: 'confirming' });
    const body = { provider: attempt.providerKey, proof: attempt.proof, idempotencyKey: attempt.idempotencyKey };
    const deadline = Date.now() + REWARD_CONFIRM_WAIT_MS;
    try {
      for (;;) {
        try {
          if (attempt.purpose === 'funding') await claimAdReward(accountId, body);
          else await resetGeneralAccount(accountId, body);
          forgetRewardAttempt(scope.key, attempt);
          await refreshMoney(attempt.purpose);
          if (current()) setStep({ kind: 'done', purpose: attempt.purpose });
          return;
        } catch (failure) {
          const outcome = classifyRewardCommandFailure(failure);
          if (!current()) return;
          if (outcome === 'pending' || outcome === 'processing') {
            if (Date.now() < deadline) {
              await wait(REWARD_CONFIRM_POLL_MS);
              if (!current()) return;
              continue;
            }
            setStep({ kind: 'verifying', attempt, stage: outcome === 'processing' ? 'processing' : 'confirmation' });
            return;
          }
          if (outcome === 'uncertain') {
            setStep({ kind: 'uncertain', attempt, failure });
            return;
          }
          forgetRewardAttempt(scope.key, attempt);
          setStep({ kind: 'refused', purpose: attempt.purpose, failure });
          void funding.refetch();
          void reset.refetch();
          return;
        }
      }
    } finally {
      running.current = false;
    }
  };

  const start = async (purpose: RewardedAdPurpose) => {
    if (!provider || running.current) return;
    running.current = true;
    const idempotencyKey = createIdempotencyKey(purpose === 'funding' ? 'ad_reward_claim' : 'account_reset');
    let attempt: RewardAttempt | null = null;
    setStep({ kind: 'working', purpose, phase: 'preparing' });
    try {
      // The server fixes member, account, purpose and command before the ad.
      let session;
      try {
        session = await createAdRewardSession(accountId, { purpose, platform: provider.platform, idempotencyKey });
      } catch (failure) {
        // No ad was shown and nothing can have moved: the server's reason (a
        // blocked reset, a cap, ads off) or a failed request.
        if (current()) setStep({ kind: 'refused', purpose, failure });
        void funding.refetch();
        void reset.refetch();
        return;
      }
      if (!current()) return;
      const outcome = await provider.show({
        ssv: session.ssv,
        onPhase: (phase) => { if (current()) setStep({ kind: 'working', purpose, phase }); },
      }).catch(() => ({ status: 'unavailable' as const, reason: 'load' as const }));
      // Watched to the end: kept for this sign-in and account even if Home
      // re-mounted the sheet during the ad, so the next opening asks again.
      if (outcome.status === 'earned' && isCurrentSession(scope.generation)) {
        attempt = { purpose, idempotencyKey, proof: session.sessionId, providerKey: provider.key };
        rememberRewardAttempt(scope.key, attempt);
      }
      if (!current()) return;
      if (outcome.status === 'dismissed') { setStep({ kind: 'dismissed' }); return; }
      if (outcome.status === 'unavailable') { setStep({ kind: 'ad-failed', reason: outcome.reason }); return; }
    } finally {
      running.current = false;
    }
    if (attempt && current()) await submit(attempt);
  };

  // Reopened on an attempt still awaiting Google — this sheet's, or one an
  // earlier mount kept (Home re-mounted it during the ad): ask the server
  // again, once per opening (never a loop while the sheet stays open).
  const submitRef = useRef(submit);
  submitRef.current = submit;
  const wasVisible = useRef(visible);
  useEffect(() => {
    const opened = visible && !wasVisible.current;
    wasVisible.current = visible;
    if (!opened) return;
    const open = step.kind === 'verifying' ? step.attempt : step.kind === 'menu' ? rememberedRewardAttempt(scope.key) : null;
    if (open) void submitRef.current(open);
  }, [visible, step, scope.key]);

  const openPrivacy = () => {
    void showAdsPrivacyOptions().then((readiness) => { if (current()) setPrivacyRequired(readiness.privacyOptionsRequired); }, () => undefined);
  };

  const resetBlocked = state.reset.blockers.length > 0;
  const working = step.kind === 'working' ? step : null;
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
            ) : step.kind === 'verifying' ? (
              <View testID="reward-verifying" style={styles.result} accessibilityLiveRegion="polite">
                <Text accessibilityRole="header" style={styles.resultTitle}>
                  {step.stage === 'processing' ? '광고 시청은 확인됐고, 처리를 마무리하고 있어요.' : '광고 시청 확인을 기다리고 있어요.'}
                </Text>
                <Text style={styles.description}>
                  {step.stage === 'processing'
                    ? step.attempt.purpose === 'funding'
                      ? `처리가 끝나면 가상자금 ${amount}이 자동으로 추가돼요. 시간이 걸릴 수 있고, 같은 광고로 두 번 지급되지 않아요.`
                      : '처리가 끝나면 일반계정이 자동으로 초기화돼요. 그 사이 주문이나 보유 종목이 생기면 초기화되지 않으며, 같은 광고로 두 번 초기화되지 않아요.'
                    : step.attempt.purpose === 'funding'
                      ? `Google의 시청 확인이 도착하면 가상자금 ${amount}이 자동으로 추가돼요. 같은 광고로 두 번 지급되지 않아요.`
                      : 'Google의 시청 확인이 도착하면 일반계정이 자동으로 초기화돼요. 같은 광고로 두 번 초기화되지 않아요.'}
                </Text>
                {/* Reads the server's result only: never a second ad or a new consent. */}
                <CTAButton testID="reward-verify-check" label="결과 확인" onPress={() => void submit(step.attempt)} />
              </View>
            ) : step.kind === 'uncertain' ? (
              <View testID="reward-uncertain" style={styles.result}>
                <Text accessibilityRole="header" style={styles.resultTitle}>결과를 확인하지 못했습니다.</Text>
                <Text style={styles.description}>
                  같은 요청으로 다시 확인합니다. 결과는 나중에 반영될 수 있으며, 이미 처리되었다면 다시 지급되거나 초기화되지 않습니다.
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
                {working ? (
                  <Text testID="reward-working" style={styles.status} accessibilityLiveRegion="polite">{PHASE_TEXT[working.phase]}</Text>
                ) : null}
                {step.kind === 'dismissed' ? (
                  <Text testID="reward-dismissed" style={styles.notice}>광고 시청이 완료되지 않아 아무것도 처리하지 않았습니다.</Text>
                ) : null}
                {step.kind === 'ad-failed' ? (
                  <Text testID="reward-ad-failed" style={styles.notice} accessibilityLiveRegion="polite">
                    {AD_FAILURE_TEXT[step.reason]} 가상자금과 계정은 그대로예요.
                  </Text>
                ) : null}
                {step.kind === 'refused' ? (
                  <View testID="reward-refused" style={styles.refused}>
                    <Text style={styles.errorTitle}>
                      {step.purpose === 'funding' ? '가상자금을 추가하지 못했습니다.' : '일반계정을 초기화하지 못했습니다.'}
                    </Text>
                    {/* The server's own reason (limit, blocked reset, verification, …);
                        for a command the server closed, the stored reason. */}
                    <ErrorNotice error={step.failure} message={rewardRefusalMessage(step.failure)} style={styles.errorNotice} />
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
                    state={working?.purpose === 'funding' ? 'loading' : state.funding.canStart && !busy ? 'enabled' : 'disabled'}
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
                    state={working?.purpose === 'account_reset' ? 'loading' : state.reset.canStart && !busy ? 'enabled' : 'disabled'}
                    onPress={() => setStep({ kind: 'confirm-reset' })} />
                </View>
                {privacyRequired ? (
                  <CTAButton testID="reward-ads-privacy" label="광고 개인정보 선택" variant="neutral"
                    state={busy ? 'disabled' : 'enabled'} onPress={openPrivacy} />
                ) : null}
              </>
            )}
          </View>
        </ScrollView>
      </InlineBottomSheet>
    </SheetPortal>
  );
}

// Plain objects: screen harnesses load this with minimal react-native mocks.
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
