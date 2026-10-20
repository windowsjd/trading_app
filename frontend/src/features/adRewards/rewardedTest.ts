import { GOOGLE_TEST_REWARDED_UNITS } from './rewardedTestConfig.ts';
import { internalTestFailure, rewardedTestDiagnostic, type RewardedTestDiagnostic, type RewardedTestStage } from './rewardedTestDiagnostics.ts';

export type RewardedTestPhase = 'idle' | 'initializing' | 'loading' | 'ready' | 'opening' | 'showing' | 'earned'
  | 'closed' | 'dismissed' | 'sdk-error' | 'load-error' | 'show-error';
export type RewardedTestState = { phase: RewardedTestPhase; privacyOptionsRequired: boolean; diagnostic?: RewardedTestDiagnostic };
export type TestAdEvent = 'loaded' | 'opened' | 'earned' | 'closed' | 'error';
export interface TestRewardedAd {
  listen(listener: (event: TestAdEvent, error?: unknown) => void): void;
  load(): void;
  show(): Promise<void>;
  dispose(): void;
}
export interface RewardedTestSdk {
  prepare(): Promise<{ privacyOptionsRequired: boolean }>;
  create(unitId: string): TestRewardedAd;
  showPrivacyOptions(): Promise<void>;
}

/** Test observations only. No proof, purpose, claim callback or financial API. */
export function createRewardedTestRun(input: {
  unitId: string;
  loadSdk: () => Promise<RewardedTestSdk>;
  onState: (state: RewardedTestState) => void;
  isCurrent: () => boolean;
  timeoutMs?: number;
  /** Opt in only after the native development/preview configuration gate. */
  diagnosticsEnabled?: boolean;
}) {
  let state: RewardedTestState = { phase: 'idle', privacyOptionsRequired: false };
  let disposed = false, generation = 0, earned = false;
  let ad: TestRewardedAd | undefined, sdk: RewardedTestSdk | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const current = () => !disposed && input.isCurrent();
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const clearAd = () => { clearTimer(); ad?.dispose(); ad = undefined; };
  const publish = (phase: RewardedTestPhase) => {
    state = { phase, privacyOptionsRequired: state.privacyOptionsRequired };
    if (current()) input.onState(state);
  };
  const fail = (phase: 'sdk-error' | 'load-error' | 'show-error', stage: RewardedTestStage, error?: unknown) => {
    generation++; clearAd();
    state = { phase, privacyOptionsRequired: state.privacyOptionsRequired,
      ...(input.diagnosticsEnabled ? { diagnostic: rewardedTestDiagnostic(stage, error) } : {}) };
    if (current()) input.onState(state);
  };
  const timeout = (phase: 'sdk-error' | 'load-error' | 'show-error', stage: RewardedTestStage) =>
    fail(phase, stage, internalTestFailure(stage, 'DIAG_TIMEOUT', '앱의 대기 제한시간을 초과했습니다. SDK에서 수신한 오류 코드는 없습니다.'));
  const busy = () => ['initializing', 'loading', 'ready', 'opening', 'showing', 'earned'].includes(state.phase);

  return {
    async load() {
      if (!current() || busy()) return;
      if (!Object.values(GOOGLE_TEST_REWARDED_UNITS).some((unit) => unit === input.unitId)) {
        fail('sdk-error', 'ad-creation', internalTestFailure('ad-creation', 'DIAG_TEST_UNIT_REJECTED', 'Google 공식 테스트 광고 단위가 아니므로 요청하지 않았습니다.')); return;
      }
      clearAd(); earned = false;
      const own = ++generation;
      publish('initializing');
      timer = setTimeout(() => timeout('sdk-error', 'sdk-timeout'), input.timeoutMs ?? 45_000);
      let stage: RewardedTestStage = 'native-module';
      try {
        const nextSdk = await input.loadSdk();
        if (!current() || own !== generation) return;
        stage = 'sdk-preparation';
        const consent = await nextSdk.prepare();
        if (!current() || own !== generation) return;
        sdk = nextSdk;
        state = { ...state, privacyOptionsRequired: consent.privacyOptionsRequired };
        clearTimer();
        stage = 'ad-creation';
        ad = sdk.create(input.unitId);
        ad.listen((event, error) => {
          if (!current() || own !== generation) return;
          if (event === 'loaded' && state.phase === 'loading') { clearTimer(); publish('ready'); }
          if (event === 'opened' && state.phase === 'opening') { clearTimer(); publish('showing'); }
          if (event === 'earned' && state.phase === 'showing' && !earned) {
            earned = true; publish('earned');
          }
          if (event === 'closed' && (state.phase === 'showing' || state.phase === 'earned')) {
            generation++; clearAd(); publish(earned ? 'closed' : 'dismissed');
          }
          if (event === 'closed' && state.phase === 'opening') fail('show-error', 'ad-show');
          if (event === 'error') {
            const showing = ['opening', 'showing', 'earned'].includes(state.phase);
            fail(showing ? 'show-error' : 'load-error', showing ? 'ad-show' : 'ad-load', error);
          }
        });
        stage = 'ad-load';
        publish('loading');
        timer = setTimeout(() => timeout('load-error', 'ad-load'), input.timeoutMs ?? 45_000);
        ad.load();
      } catch (error) { if (current() && own === generation) fail(state.phase === 'loading' ? 'load-error' : 'sdk-error', stage, error); }
    },
    async show() {
      if (!current() || state.phase !== 'ready' || !ad) return;
      const own = generation;
      const showing = ad;
      // Synchronous phase change consumes this ad before any promise or re-render.
      publish('opening');
      timer = setTimeout(() => timeout('show-error', 'ad-show'), input.timeoutMs ?? 45_000);
      try { await showing.show(); }
      catch (error) { if (current() && own === generation) fail('show-error', 'ad-show', error); }
    },
    async privacyOptions() {
      if (!current() || (busy() && state.phase !== 'ready') || !sdk || !state.privacyOptionsRequired) return;
      clearAd();
      publish('initializing');
      const own = ++generation;
      timer = setTimeout(() => timeout('sdk-error', 'privacy-options'), input.timeoutMs ?? 45_000);
      try { await sdk.showPrivacyOptions(); if (current() && own === generation) { clearTimer(); publish('idle'); } }
      catch (error) { if (current() && own === generation) fail('sdk-error', 'privacy-options', error); }
    },
    dispose() { disposed = true; generation++; clearAd(); },
  };
}
