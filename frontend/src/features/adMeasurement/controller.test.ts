import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AD_MEASUREMENT_CONSENT_VERSION, parseConsentRecord, type Tracking } from './consent.ts';
import { createAdMeasurement, type StartResult } from './controller.ts';

/**
 * The 광고 성과 측정 controller over a fake SDK and storage: what reaches the
 * Meta SDK (start/stop with the consent they act for, the iOS prompt) for each
 * stored choice, answer, failure and relaunch. A relaunch is a new controller
 * over the stored record: the SDK never starts by itself, so a launch begins
 * with it off. Assertions compare small values only (call lists, strings,
 * flags).
 */
const granted: Tracking = { status: 'granted', canAskAgain: false };
const denied: Tracking = { status: 'denied', canAskAgain: false };
const undetermined: Tracking = { status: 'undetermined', canAskAgain: true };

const DECIDED = '2026-11-20T00:00:00.000Z';
const NOW = '2026-11-21T03:00:00.000Z';
const stored = (choice: 'granted' | 'declined', sdkOn: boolean, version: string = AD_MEASUREMENT_CONSENT_VERSION) =>
  JSON.stringify({ choice, version, decidedAt: DECIDED, sdkOn });

type Options = {
  platform?: 'android' | 'ios' | 'unsupported';
  record?: string | null;
  tracking?: Tracking;
  prompted?: Tracking;
  available?: boolean;
  keepsWithdrawals?: boolean;
  readFails?: boolean;
  writeFails?: boolean;
  startFails?: boolean;
  startResult?: StartResult;
  stopFails?: boolean;
  stopKept?: boolean;
};

function setup(options: Options = {}) {
  const platform = options.platform ?? 'android';
  const h = {
    calls: [] as string[],
    record: options.record ?? null,
    tracking: options.tracking ?? null,
    writeFails: options.writeFails ?? false,
    startFails: options.startFails ?? false,
    startResult: options.startResult ?? ('started' as StartResult),
    stopFails: options.stopFails ?? false,
    stopKept: options.stopKept ?? true,
    /** A write or a stop that has not finished (the app may close meanwhile). */
    writeGate: null as Promise<void> | null,
    stopGate: null as Promise<void> | null,
  };
  const measurement = createAdMeasurement({
    platform,
    sdk: {
      available: () => options.available ?? true,
      keepsWithdrawals: options.keepsWithdrawals ?? platform === 'android',
      getTracking: async () => { h.calls.push('getTracking'); return h.tracking; },
      requestTracking: async () => { h.calls.push('requestTracking'); h.tracking = options.prompted ?? granted; return h.tracking; },
      start: async (consent) => {
        h.calls.push(`start:${consent}`);
        if (h.startFails) throw new Error('native failure');
        return h.startResult;
      },
      stop: async (consent) => {
        h.calls.push(`stop:${consent}`);
        if (h.stopGate) await h.stopGate;
        if (h.stopFails) throw new Error('native failure');
        return h.stopKept;
      },
    },
    readRecord: async () => { h.calls.push('read'); if (options.readFails) throw new Error('storage failure'); return h.record; },
    writeRecord: async (raw) => {
      h.calls.push('write');
      if (h.writeGate) await h.writeGate;
      if (h.writeFails) throw new Error('storage failure');
      h.record = raw;
    },
    now: () => new Date(NOW),
  });
  /** start/stop (with their consent) and the iOS prompt, in order. */
  const sdkCalls = () => h.calls.filter((call) => call.startsWith('start') || call.startsWith('stop') || call === 'requestTracking');
  const starts = () => h.calls.filter((call) => call.startsWith('start')).length;
  const saved = () => parseConsentRecord(h.record);
  return { h, measurement, sdkCalls, starts, saved, state: () => measurement.getState() };
}

/** The next app launch on the same device: only what was stored survives. */
const relaunch = (previous: { h: { record: string | null } }, options: Options = {}) => setup({ ...options, record: previous.h.record });

describe('광고 성과 측정 at launch: the stored choice decides', () => {
  it('first launch without a choice: asks once and touches no SDK', async () => {
    const s = setup();
    await s.measurement.init();
    await s.measurement.init();
    assert.deepEqual(s.h.calls, ['read']);
    assert.equal(s.state().ready, true);
    assert.equal(s.state().prompt, 'launch');
    assert.equal(s.state().active, false);
  });

  it('declining keeps the SDK untouched, and a relaunch neither measures nor asks again', async () => {
    const s = setup();
    await s.measurement.init();
    assert.equal(await s.measurement.answer('declined'), 'saved');
    assert.deepEqual(s.sdkCalls(), []);
    assert.equal(s.saved()?.choice, 'declined');
    assert.equal(s.saved()?.sdkOn, false);
    assert.equal(s.saved()?.decidedAt, NOW);
    assert.equal(s.state().prompt, 'none');

    const next = relaunch(s);
    await next.measurement.init();
    assert.deepEqual(next.h.calls, ['read']);
    assert.equal(next.state().prompt, 'none');
  });

  it('a valid consent starts at once on a relaunch, for that consent, without a question', async () => {
    const s = setup({ record: stored('granted', true) });
    await s.measurement.init();
    assert.deepEqual(s.h.calls, ['read', `start:${DECIDED}`]);
    assert.equal(s.state().prompt, 'none');
    assert.equal(s.state().active, true);
  });

  it('a consent to an older notice measures nothing until the new one is agreed to', async () => {
    const s = setup({ record: stored('granted', true, '2026-01-01') });
    await s.measurement.init();
    // It may have run under the old notice: stopped (kept for that consent), never started.
    assert.deepEqual(s.sdkCalls(), [`stop:${DECIDED}`]);
    assert.equal(s.starts(), 0);
    assert.equal(s.state().prompt, 'launch');
    assert.equal(s.state().choice === null, true);
    assert.equal(s.saved()?.sdkOn, false);

    assert.equal(await s.measurement.answer('granted'), 'saved');
    assert.deepEqual(s.sdkCalls(), [`stop:${DECIDED}`, `start:${NOW}`]);
    assert.equal(s.state().active, true);
  });

  it('an unreadable choice starts nothing and asks nothing this session', async () => {
    const s = setup({ readFails: true });
    await s.measurement.init();
    // The stop (for no consent) also drops what the SDK kept from before.
    assert.deepEqual(s.sdkCalls(), ['stop:']);
    assert.equal(s.starts(), 0);
    assert.equal(s.state().prompt, 'none');
    assert.equal(s.state().active, false);
    assert.equal(s.state().ready, true);
  });

  it('a missing or damaged record counts as no choice: asked again, nothing measured', async () => {
    const records = [
      null,
      '',
      '{"choice":"granted"',
      '"granted"',
      JSON.stringify({ choice: 'granted', decidedAt: DECIDED, sdkOn: true }),
      JSON.stringify({ choice: 'yes', version: AD_MEASUREMENT_CONSENT_VERSION, decidedAt: DECIDED, sdkOn: true }),
      JSON.stringify({ choice: 'granted', version: AD_MEASUREMENT_CONSENT_VERSION, decidedAt: 20261120, sdkOn: true }),
    ];
    for (const record of records) {
      const s = setup({ record });
      await s.measurement.init();
      assert.equal(s.starts(), 0, String(record));
      assert.equal(s.state().prompt, 'launch', String(record));
      assert.equal(s.state().active, false, String(record));
    }
  });
});

describe('광고 성과 측정 on Android', () => {
  it('agreeing saves the choice, marks the SDK on, then starts it once for that consent', async () => {
    const s = setup();
    await s.measurement.init();
    assert.equal(await s.measurement.answer('granted'), 'saved');
    assert.deepEqual(s.h.calls, ['read', 'write', 'write', `start:${NOW}`]);
    assert.equal(s.saved()?.choice, 'granted');
    assert.equal(s.saved()?.sdkOn, true);
    assert.equal(s.state().active, true);
    await s.measurement.answer('granted');
    assert.equal(s.starts(), 1);
  });

  it('withdrawing stops the SDK first, for the consent withdrawn, then saves the choice', async () => {
    const s = setup({ record: stored('granted', true) });
    await s.measurement.init();
    assert.equal(await s.measurement.answer('declined'), 'saved');
    assert.deepEqual(s.h.calls, ['read', `start:${DECIDED}`, `stop:${DECIDED}`, 'write']);
    assert.equal(s.saved()?.choice, 'declined');
    assert.equal(s.saved()?.sdkOn, false);
    assert.equal(s.state().active, false);
    assert.equal(s.state().choice, 'declined');
  });

  it('a relaunch right after a withdrawal measures nothing', async () => {
    const s = setup({ record: stored('granted', true) });
    await s.measurement.init();
    await s.measurement.answer('declined');
    const next = relaunch(s);
    await next.measurement.init();
    assert.deepEqual(next.h.calls, ['read']);
    assert.equal(next.state().choice, 'declined');
  });

  it('a stop that never completed (the app closed meanwhile) is repeated on the next launch', async () => {
    const s = setup({ record: stored('declined', true) });
    await s.measurement.init();
    assert.deepEqual(s.sdkCalls(), [`stop:${DECIDED}`]);
    assert.equal(s.starts(), 0);
    assert.equal(s.saved()?.sdkOn, false);
  });

  it('a stop the SDK could not keep for the next launches stays marked, so it is repeated', async () => {
    const s = setup({ record: stored('granted', true), stopKept: false });
    await s.measurement.init();
    assert.equal(await s.measurement.answer('declined'), 'saved');
    assert.equal(s.state().active, false);
    assert.equal(s.saved()?.choice, 'declined');
    assert.equal(s.saved()?.sdkOn, true);

    const next = relaunch(s);
    await next.measurement.init();
    assert.deepEqual(next.sdkCalls(), [`stop:${NOW}`]);
    assert.equal(next.starts(), 0);
    assert.equal(next.saved()?.sdkOn, false);
  });

  it('a repeated stop at launch that throws stays marked, so the next launch stops again', async () => {
    const s = setup({ record: stored('declined', true), stopFails: true });
    await s.measurement.init();
    assert.deepEqual(s.sdkCalls(), [`stop:${DECIDED}`]);
    assert.equal(s.starts(), 0);
    assert.equal(s.saved()?.sdkOn, true);
  });

  it('a repeated stop at launch that the SDK could not keep stays marked until one is kept', async () => {
    const s = setup({ record: stored('declined', true), stopKept: false });
    await s.measurement.init();
    assert.deepEqual(s.sdkCalls(), [`stop:${DECIDED}`]);
    assert.equal(s.saved()?.sdkOn, true);
    const next = relaunch(s);
    await next.measurement.init();
    assert.deepEqual(next.sdkCalls(), [`stop:${DECIDED}`]);
    assert.equal(next.starts(), 0);
    assert.equal(next.saved()?.sdkOn, false);
  });

  it('a stop that throws is not recorded as done: still on, still marked, said to the person', async () => {
    const s = setup({ record: stored('granted', true), stopFails: true });
    await s.measurement.init();
    assert.equal(await s.measurement.answer('declined'), 'stopFailed');
    assert.equal(s.state().active, true);
    assert.equal(s.state().choice, 'declined');
    assert.equal(s.saved()?.choice, 'declined');
    assert.equal(s.saved()?.sdkOn, true);

    // The next launch never starts it (the choice says no) and stops it again.
    const next = relaunch(s);
    await next.measurement.init();
    assert.deepEqual(next.sdkCalls(), [`stop:${NOW}`]);
    assert.equal(next.starts(), 0);
    assert.equal(next.saved()?.sdkOn, false);
  });

  it('closing the app before the stop or the save finishes still never measures on the next launch', async () => {
    // The app closes after the SDK kept the stop but before its answer arrived:
    // nothing was saved here, yet the SDK refuses that consent from then on.
    // (Closed before the SDK acted at all, the withdrawal reached no store.)
    const stopping = setup({ record: stored('granted', true) });
    await stopping.measurement.init();
    stopping.h.stopGate = new Promise(() => undefined);
    void stopping.measurement.answer('declined');
    await new Promise((done) => setImmediate(done));
    assert.equal(stopping.state().busy, true);
    assert.equal(stopping.state().active, true);
    const afterStop = relaunch(stopping, { startResult: 'withdrawn' });
    await afterStop.measurement.init();
    assert.equal(afterStop.state().active, false);
    assert.equal(afterStop.state().choice, 'declined');
    assert.equal(afterStop.saved()?.choice, 'declined');

    // Save still running when the app closes: the stop already held.
    const saving = setup({ record: stored('granted', true) });
    await saving.measurement.init();
    saving.h.writeGate = new Promise(() => undefined);
    void saving.measurement.answer('declined');
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(saving.sdkCalls(), [`start:${DECIDED}`, `stop:${DECIDED}`]);
    assert.equal(saving.state().active, false);
    const afterSave = relaunch(saving, { startResult: 'withdrawn' });
    await afterSave.measurement.init();
    assert.deepEqual(afterSave.sdkCalls(), [`start:${DECIDED}`]);
    assert.equal(afterSave.state().active, false);
    assert.equal(afterSave.saved()?.choice, 'declined');
  });

  it('a withdrawal that cannot be saved still stops, and holds through the SDK on the next launch', async () => {
    const s = setup({ record: stored('granted', true) });
    await s.measurement.init();
    s.h.writeFails = true;
    // The SDK keeps the withdrawal of that consent: it counts as made.
    assert.equal(await s.measurement.answer('declined'), 'saved');
    assert.deepEqual(s.sdkCalls(), [`start:${DECIDED}`, `stop:${DECIDED}`]);
    assert.equal(s.state().active, false);
    assert.equal(s.state().choice, 'declined');
    assert.equal(s.saved()?.choice, 'granted');

    // Storage works again: the stale consent is refused and saved as 동의하지 않음.
    const next = relaunch(s, { startResult: 'withdrawn' });
    await next.measurement.init();
    assert.deepEqual(next.sdkCalls(), [`start:${DECIDED}`]);
    assert.equal(next.state().active, false);
    assert.equal(next.state().choice, 'declined');
    assert.equal(next.state().prompt, 'none');
    assert.equal(next.saved()?.choice, 'declined');
    assert.equal(next.saved()?.decidedAt, NOW);

    // Storage still failing: refused again, nothing measured.
    const failing = relaunch(s, { startResult: 'withdrawn', writeFails: true });
    await failing.measurement.init();
    assert.equal(failing.state().active, false);
    assert.equal(failing.state().choice, 'declined');
  });

  it('when neither the save nor the SDK keeps a withdrawal, the person is told it failed', async () => {
    const s = setup({ record: stored('granted', true), stopKept: false });
    await s.measurement.init();
    s.h.writeFails = true;
    assert.equal(await s.measurement.answer('declined'), 'failed');
    assert.equal(s.state().active, false);
    assert.equal(s.state().choice, 'granted');

    const stopFailed = setup({ record: stored('granted', true), stopFails: true });
    await stopFailed.measurement.init();
    stopFailed.h.writeFails = true;
    assert.equal(await stopFailed.measurement.answer('declined'), 'failed');
    assert.equal(stopFailed.state().active, true);
    assert.equal(stopFailed.state().choice, 'granted');
  });

  it('agreeing again after a withdrawal in the same session measures from the next launch', async () => {
    const s = setup({ record: stored('granted', true) });
    await s.measurement.init();
    await s.measurement.answer('declined');
    // The SDK ran in this process and was stopped: it starts again only in a new one.
    s.h.startResult = 'nextLaunch';
    assert.equal(await s.measurement.answer('granted'), 'saved');
    assert.equal(s.state().active, false);
    assert.equal(s.state().deferred, true);
    assert.equal(s.saved()?.choice, 'granted');
    assert.equal(s.saved()?.sdkOn, true);

    const next = relaunch(s);
    await next.measurement.init();
    assert.deepEqual(next.sdkCalls(), [`start:${NOW}`]);
    assert.equal(next.state().active, true);
    assert.equal(next.state().deferred, false);
  });

  it('agreeing again in a later session measures at once', async () => {
    const s = setup({ record: stored('declined', false) });
    await s.measurement.init();
    assert.equal(await s.measurement.answer('granted'), 'saved');
    assert.deepEqual(s.sdkCalls(), [`start:${NOW}`]);
    assert.equal(s.state().active, true);
  });
});

describe('광고 성과 측정 on iOS', () => {
  it('agreeing asks 앱 추적 허용 once and measures only once it is allowed', async () => {
    const s = setup({ platform: 'ios', tracking: undetermined, prompted: granted });
    await s.measurement.init();
    assert.deepEqual(s.h.calls, ['read', 'getTracking']);
    await s.measurement.answer('granted');
    assert.deepEqual(s.sdkCalls(), ['requestTracking', `start:${NOW}`]);
    assert.equal(s.state().active, true);
  });

  it('a refused 앱 추적 허용 keeps the consent but measures nothing', async () => {
    const s = setup({ platform: 'ios', tracking: undetermined, prompted: denied });
    await s.measurement.init();
    assert.equal(await s.measurement.answer('granted'), 'saved');
    assert.deepEqual(s.sdkCalls(), ['requestTracking']);
    assert.equal(s.saved()?.choice, 'granted');
    assert.equal(s.saved()?.sdkOn, false);
    assert.equal(s.state().tracking?.status, 'denied');
    assert.equal(s.state().active, false);
  });

  it('never shows the system prompt on launch, on 동의하지 않음 or after a refusal', async () => {
    const declining = setup({ platform: 'ios', tracking: undetermined });
    await declining.measurement.init();
    await declining.measurement.answer('declined');
    assert.deepEqual(declining.sdkCalls(), []);

    const refused = setup({ platform: 'ios', tracking: denied });
    await refused.measurement.init();
    await refused.measurement.answer('granted');
    await refused.measurement.answer('granted');
    assert.deepEqual(refused.sdkCalls(), []);
  });

  it('follows 앱 추적 허용 changed in the system settings', async () => {
    const s = setup({ platform: 'ios', record: stored('granted', true), tracking: granted });
    await s.measurement.init();
    assert.deepEqual(s.sdkCalls(), [`start:${DECIDED}`]);
    s.h.tracking = denied;
    await s.measurement.refreshTracking();
    assert.deepEqual(s.sdkCalls(), [`start:${DECIDED}`, `stop:${DECIDED}`]);
    assert.equal(s.saved()?.sdkOn, false);
    s.h.tracking = granted;
    await s.measurement.refreshTracking();
    assert.deepEqual(s.sdkCalls(), [`start:${DECIDED}`, `stop:${DECIDED}`, `start:${DECIDED}`]);
    assert.equal(s.state().active, true);
  });

  it('a consent from before 앱 추적 허용 was refused starts nothing on launch', async () => {
    const s = setup({ platform: 'ios', record: stored('granted', false), tracking: denied });
    await s.measurement.init();
    assert.deepEqual(s.sdkCalls(), []);
    assert.equal(s.state().prompt, 'none');
  });

  it('withdrawing stops at once; a withdrawal that cannot be saved is said to have failed', async () => {
    const s = setup({ platform: 'ios', record: stored('granted', true), tracking: granted });
    await s.measurement.init();
    assert.equal(await s.measurement.answer('declined'), 'saved');
    assert.deepEqual(s.sdkCalls(), [`start:${DECIDED}`, `stop:${DECIDED}`]);
    assert.equal(s.state().active, false);
    assert.equal(s.saved()?.choice, 'declined');

    // A consent that never measured (앱 추적 not allowed) is withdrawn without a stop warning.
    const unmeasured = setup({ platform: 'ios', record: stored('granted', false), tracking: denied, stopFails: true });
    await unmeasured.measurement.init();
    assert.equal(await unmeasured.measurement.answer('declined'), 'saved');
    assert.equal(unmeasured.state().active, false);
    assert.equal(unmeasured.saved()?.choice, 'declined');

    // iOS keeps no withdrawal of its own: an unsaved one stops this session only.
    const failing = setup({ platform: 'ios', record: stored('granted', true), tracking: granted });
    await failing.measurement.init();
    failing.h.writeFails = true;
    assert.equal(await failing.measurement.answer('declined'), 'failed');
    assert.equal(failing.state().active, false);
    assert.equal(failing.state().choice, 'granted');
  });
});

describe('광고 성과 측정 fails closed', () => {
  it('a consent that cannot be saved is not acted on', async () => {
    const s = setup({ writeFails: true });
    await s.measurement.init();
    assert.equal(await s.measurement.answer('granted'), 'failed');
    assert.deepEqual(s.sdkCalls(), []);
    assert.equal(s.state().prompt, 'none');
    assert.equal(s.state().choice === null, true);
  });

  it('a start that throws leaves the measurement off and is tried again on the next launch', async () => {
    const s = setup({ startFails: true });
    await s.measurement.init();
    assert.equal(await s.measurement.answer('granted'), 'saved');
    assert.equal(s.starts(), 1);
    assert.equal(s.state().active, false);
    assert.equal(s.state().busy, false);
    assert.equal(s.saved()?.sdkOn, true);

    const next = relaunch(s);
    await next.measurement.init();
    assert.deepEqual(next.sdkCalls(), [`start:${NOW}`]);
    assert.equal(next.state().active, true);
  });

  it('a start that cannot be marked first is not made', async () => {
    const s = setup({ record: stored('granted', false), writeFails: true });
    await s.measurement.init();
    assert.equal(s.starts(), 0);
    assert.equal(s.state().active, false);
  });

  it('a build without the SDK never asks and never calls it', async () => {
    for (const options of [{ available: false }, { platform: 'unsupported' as const }]) {
      const s = setup(options);
      await s.measurement.init();
      assert.equal(await s.measurement.answer('granted'), 'failed');
      s.measurement.openSettingsPrompt();
      assert.deepEqual(s.h.calls, []);
      assert.equal(s.state().supported, false);
      assert.equal(s.state().prompt, 'none');
    }
  });
});

describe('광고 성과 측정 prompts', () => {
  it('설정 opens the sheet to agree; closing it changes nothing', async () => {
    const s = setup({ record: stored('declined', false) });
    await s.measurement.init();
    s.measurement.openSettingsPrompt();
    assert.equal(s.state().prompt, 'settings');
    s.measurement.closePrompt();
    assert.equal(s.state().prompt, 'none');
    assert.equal(s.saved()?.choice, 'declined');
  });

  it('the launch question cannot be closed without an answer', async () => {
    const s = setup();
    await s.measurement.init();
    s.measurement.closePrompt();
    assert.equal(s.state().prompt, 'launch');
  });

  it('decisions run one at a time, in order', async () => {
    const s = setup();
    await s.measurement.init();
    const [first, second] = await Promise.all([s.measurement.answer('granted'), s.measurement.answer('declined')]);
    assert.equal(first, 'saved');
    assert.equal(second, 'saved');
    assert.deepEqual(s.sdkCalls(), [`start:${NOW}`, `stop:${NOW}`]);
    assert.equal(s.saved()?.choice, 'declined');
  });
});
