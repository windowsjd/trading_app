import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRewardedTestRun, type RewardedTestSdk, type RewardedTestState, type TestAdEvent } from './rewardedTest.ts';
import { GOOGLE_TEST_REWARDED_UNITS } from './rewardedTestConfig.ts';

function fixture() {
  const states: RewardedTestState[] = [];
  const ads: Array<{ callback?: (event: TestAdEvent) => void; loads: number; shows: number; disposals: number;
    load(): void; show(): Promise<void>; dispose(): void; emit(event: TestAdEvent): void }> = [];
  const h = { current: true, imports: 0, prepares: 0, privacy: 0, required: false, states, ads,
    importFailure: false, prepareFailure: false, loadFailure: false, showFailure: false };
  const sdk: RewardedTestSdk = {
    prepare: () => { h.prepares++; return h.prepareFailure ? Promise.reject(new Error('consent/init failed')) : Promise.resolve({ privacyOptionsRequired: h.required }); },
    create(unit) {
      assert.equal(unit, GOOGLE_TEST_REWARDED_UNITS.android);
      const ad = {
        callback: undefined as ((event: TestAdEvent) => void) | undefined, loads: 0, shows: 0, disposals: 0,
        listen(listener: (event: TestAdEvent) => void) { this.callback = listener; },
        load() { this.loads++; if (h.loadFailure) throw new Error('load failed'); },
        show() { this.shows++; return h.showFailure ? Promise.reject(new Error('show failed')) : Promise.resolve(); },
        dispose() { this.disposals++; },
        // Deliberately permits late callbacks after dispose, as a native queue can.
        emit(event: TestAdEvent) { this.callback?.(event); },
      };
      ads.push(ad); return ad;
    },
    showPrivacyOptions: () => { h.privacy++; return Promise.resolve(); },
  };
  const loadSdk = () => { h.imports++; return h.importFailure ? Promise.reject(new Error('missing native module')) : Promise.resolve(sdk); };
  const run = createRewardedTestRun({ unitId: GOOGLE_TEST_REWARDED_UNITS.android, loadSdk,
    isCurrent: () => h.current, onState: (state) => states.push(state) });
  return { h, sdk, run, phase: () => states.at(-1)?.phase };
}

test('manual load, ready, explicit show, opened, earned and closed are separate test states', async (t) => {
  const { h, run, phase } = fixture(); t.after(() => run.dispose());
  assert.equal(h.imports, 0, 'does not initialize at app/screen startup');
  await run.show(); assert.equal(h.ads.length, 0);
  await Promise.all([run.load(), run.load(), run.load()]);
  assert.equal(h.imports, 1); assert.equal(h.ads[0].loads, 1);
  assert.equal(phase(), 'loading');
  h.ads[0].emit('loaded'); assert.equal(phase(), 'ready'); assert.equal(h.ads[0].shows, 0);
  await Promise.all([run.show(), run.show(), run.show()]);
  assert.equal(h.ads[0].shows, 1); assert.equal(phase(), 'opening');
  h.ads[0].emit('opened'); assert.equal(phase(), 'showing');
  h.ads[0].emit('earned'); h.ads[0].emit('earned'); assert.equal(phase(), 'earned');
  assert.equal(h.states.filter((s) => s.phase === 'earned').length, 1);
  h.ads[0].emit('closed'); assert.equal(phase(), 'closed');
  await run.show(); assert.equal(h.ads[0].shows, 1, 'a consumed object never shows again');
  assert.equal(h.ads.length, 1, 'no automatic reload');
  await run.load(); assert.equal(h.ads.length, 2, 'manual retry creates a fresh object');
});

test('close before earned is dismissal; no opened event can never become a successful viewing', async (t) => {
  for (const opened of [true, false]) {
    const { h, run, phase } = fixture(); t.after(() => run.dispose());
    await run.load(); h.ads[0].emit('loaded'); await run.show();
    if (opened) h.ads[0].emit('opened');
    else h.ads[0].emit('earned');
    h.ads[0].emit('closed');
    assert.equal(phase(), opened ? 'dismissed' : 'show-error');
    assert.equal(h.states.some((state) => state.phase === 'closed'), false);
  }
});

for (const failure of ['importFailure', 'prepareFailure', 'loadFailure', 'showFailure'] as const) {
  test(`${failure} stays optional, reports the correct error and never retries itself`, async (t) => {
    const { h, run, phase } = fixture(); t.after(() => run.dispose());
    h[failure] = true;
    await run.load();
    if (failure === 'showFailure') { h.ads[0].emit('loaded'); await run.show(); }
    assert.equal(phase(), failure === 'importFailure' || failure === 'prepareFailure' ? 'sdk-error' : failure === 'loadFailure' ? 'load-error' : 'show-error');
    assert.equal(h.imports, 1);
    assert.equal(h.ads.length <= 1, true);
  });
}

test('native errors during loading and presenting are distinct, and a stale loaded event cannot revive a failed ad', async (t) => {
  for (const showing of [true, false]) {
    const { h, run, phase } = fixture(); t.after(() => run.dispose());
    await run.load();
    if (showing) { h.ads[0].emit('loaded'); await run.show(); }
    h.ads[0].emit('error'); h.ads[0].emit('loaded');
    assert.equal(phase(), showing ? 'show-error' : 'load-error');
    assert.equal(h.ads[0].disposals > 0, true);
    assert.equal(h.imports, 1);
  }
});

test('unmount, hiding and account/session replacement ignore all queued callbacks and further actions', async () => {
  for (const disposed of [true, false]) {
    const { h, run } = fixture();
    await run.load(); h.ads[0].emit('loaded'); await run.show(); h.ads[0].emit('opened');
    if (disposed) run.dispose(); else h.current = false;
    const count = h.states.length;
    for (const event of ['earned', 'closed', 'error', 'loaded'] as const) h.ads[0].emit(event);
    await run.show(); await run.load();
    assert.equal(h.states.length, count);
    assert.equal(h.ads[0].shows, 1); assert.equal(h.imports, 1);
    run.dispose();
  }
});

test('unmount during SDK preparation cannot create or load an ad later', async () => {
  const { h, sdk } = fixture();
  let answer!: (sdk: RewardedTestSdk) => void;
  const pending = new Promise<RewardedTestSdk>((resolve) => { answer = resolve; });
  const run = createRewardedTestRun({ unitId: GOOGLE_TEST_REWARDED_UNITS.android, loadSdk: () => pending,
    isCurrent: () => true, onState: (state) => h.states.push(state) });
  const loading = run.load(); run.dispose(); answer(sdk); await loading;
  assert.equal(h.ads.length, 0); assert.equal(h.prepares, 0);
});

test('SDK, load and opening timeouts are errors, never a completion or an automatic retry', async () => {
  for (const stage of ['sdk', 'load', 'opening']) {
    const { h, sdk } = fixture();
    const run = createRewardedTestRun({ unitId: GOOGLE_TEST_REWARDED_UNITS.android,
      loadSdk: () => stage === 'sdk' ? new Promise(() => {}) : Promise.resolve(sdk),
      isCurrent: () => true, onState: (state) => h.states.push(state), timeoutMs: 10 });
    const pending = run.load();
    if (stage !== 'sdk') await pending;
    if (stage === 'opening') { h.ads[0].emit('loaded'); await run.show(); }
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(h.states.at(-1)?.phase, stage === 'sdk' ? 'sdk-error' : stage === 'load' ? 'load-error' : 'show-error');
    assert.equal(h.ads.length, stage === 'sdk' ? 0 : 1);
    run.dispose();
  }
});

test('production unit IDs cannot reach the SDK even through a direct controller call', async () => {
  let imports = 0;
  const states: RewardedTestState[] = [];
  const run = createRewardedTestRun({ unitId: 'ca-app-pub-7899930948413451/3165650506',
    loadSdk: () => { imports++; return Promise.reject(new Error('must not import')); },
    isCurrent: () => true, onState: (state) => states.push(state) });
  await run.load(); assert.equal(imports, 0); assert.equal(states.at(-1)?.phase, 'sdk-error'); run.dispose();
});

test('required privacy choices discard a prepared ad and require a fresh manual load', async (t) => {
  const { h, run, phase } = fixture(); t.after(() => run.dispose());
  h.required = true;
  await run.load(); h.ads[0].emit('loaded');
  assert.equal(h.states.at(-1)?.privacyOptionsRequired, true);
  await run.privacyOptions();
  assert.equal(h.privacy, 1); assert.equal(h.ads[0].disposals, 1); assert.equal(phase(), 'idle');
  await run.show(); assert.equal(h.ads[0].shows, 0);
});
