import { GOOGLE_TEST_REWARDED_UNITS } from './rewardedTestConfig.ts';

export type RewardedTestPhase = 'idle' | 'initializing' | 'loading' | 'ready' | 'opening' | 'showing' | 'earned'
  | 'closed' | 'dismissed' | 'sdk-error' | 'load-error' | 'show-error';
export type RewardedTestState = { phase: RewardedTestPhase; privacyOptionsRequired: boolean };
export type TestAdEvent = 'loaded' | 'opened' | 'earned' | 'closed' | 'error';
export interface TestRewardedAd {
  listen(listener: (event: TestAdEvent) => void): void;
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
}) {
  let state: RewardedTestState = { phase: 'idle', privacyOptionsRequired: false };
  let disposed = false, generation = 0, earned = false;
  let ad: TestRewardedAd | undefined, sdk: RewardedTestSdk | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const current = () => !disposed && input.isCurrent();
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const clearAd = () => { clearTimer(); ad?.dispose(); ad = undefined; };
  const publish = (phase: RewardedTestPhase) => {
    state = { ...state, phase };
    if (current()) input.onState(state);
  };
  const fail = (phase: 'sdk-error' | 'load-error' | 'show-error') => {
    generation++; clearAd(); publish(phase);
  };
  const busy = () => ['initializing', 'loading', 'ready', 'opening', 'showing', 'earned'].includes(state.phase);

  return {
    async load() {
      if (!current() || busy()) return;
      if (!Object.values(GOOGLE_TEST_REWARDED_UNITS).some((unit) => unit === input.unitId)) {
        fail('sdk-error'); return;
      }
      clearAd(); earned = false;
      const own = ++generation;
      publish('initializing');
      timer = setTimeout(() => fail('sdk-error'), input.timeoutMs ?? 45_000);
      try {
        const nextSdk = await input.loadSdk();
        if (!current() || own !== generation) return;
        const consent = await nextSdk.prepare();
        if (!current() || own !== generation) return;
        sdk = nextSdk;
        state = { ...state, privacyOptionsRequired: consent.privacyOptionsRequired };
        clearTimer();
        ad = sdk.create(input.unitId);
        ad.listen((event) => {
          if (!current() || own !== generation) return;
          if (event === 'loaded' && state.phase === 'loading') { clearTimer(); publish('ready'); }
          if (event === 'opened' && state.phase === 'opening') { clearTimer(); publish('showing'); }
          if (event === 'earned' && state.phase === 'showing' && !earned) {
            earned = true; publish('earned');
          }
          if (event === 'closed' && (state.phase === 'showing' || state.phase === 'earned')) {
            generation++; clearAd(); publish(earned ? 'closed' : 'dismissed');
          }
          if (event === 'closed' && state.phase === 'opening') fail('show-error');
          if (event === 'error') fail(['opening', 'showing', 'earned'].includes(state.phase) ? 'show-error' : 'load-error');
        });
        publish('loading');
        timer = setTimeout(() => fail('load-error'), input.timeoutMs ?? 45_000);
        ad.load();
      } catch { if (current() && own === generation) fail(state.phase === 'loading' ? 'load-error' : 'sdk-error'); }
    },
    async show() {
      if (!current() || state.phase !== 'ready' || !ad) return;
      const own = generation;
      const showing = ad;
      // Synchronous phase change consumes this ad before any promise or re-render.
      publish('opening');
      timer = setTimeout(() => fail('show-error'), input.timeoutMs ?? 45_000);
      try { await showing.show(); }
      catch { if (current() && own === generation) fail('show-error'); }
    },
    async privacyOptions() {
      if (!current() || (busy() && state.phase !== 'ready') || !sdk || !state.privacyOptionsRequired) return;
      clearAd();
      publish('initializing');
      const own = ++generation;
      timer = setTimeout(() => fail('sdk-error'), input.timeoutMs ?? 45_000);
      try { await sdk.showPrivacyOptions(); if (current() && own === generation) { clearTimer(); publish('idle'); } }
      catch { if (current() && own === generation) fail('sdk-error'); }
    },
    dispose() { disposed = true; generation++; clearAd(); },
  };
}
