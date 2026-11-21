import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AD_MEASUREMENT_CONSENT_VERSION, parseConsentRecord, type Tracking } from './consent.ts';
import { createAdMeasurement } from './controller.ts';

/**
 * The 광고 성과 측정 controller over a fake SDK and storage: what reaches the
 * Meta SDK (start/stop, the iOS prompt) for each stored choice, answer and
 * failure. Assertions compare small values only (call lists, strings, flags).
 */
const granted: Tracking = { status: 'granted', canAskAgain: false };
const denied: Tracking = { status: 'denied', canAskAgain: false };
const undetermined: Tracking = { status: 'undetermined', canAskAgain: true };

const stored = (choice: 'granted' | 'declined', sdkOn: boolean, version: string = AD_MEASUREMENT_CONSENT_VERSION) =>
  JSON.stringify({ choice, version, decidedAt: '2026-11-20T00:00:00.000Z', sdkOn });

type Options = {
  platform?: 'android' | 'ios' | 'unsupported';
  record?: string | null;
  tracking?: Tracking;
  prompted?: Tracking;
  available?: boolean;
  readFails?: boolean;
  writeFails?: boolean;
  startFails?: boolean;
  stopFails?: boolean;
};

function setup(options: Options = {}) {
  const h = {
    calls: [] as string[],
    record: options.record ?? null,
    tracking: options.tracking ?? null,
    writeFails: options.writeFails ?? false,
    startFails: options.startFails ?? false,
  };
  const measurement = createAdMeasurement({
    platform: options.platform ?? 'android',
    sdk: {
      available: () => options.available ?? true,
      getTracking: async () => { h.calls.push('getTracking'); return h.tracking; },
      requestTracking: async () => { h.calls.push('requestTracking'); h.tracking = options.prompted ?? granted; return h.tracking; },
      start: async () => { h.calls.push('start'); if (h.startFails) throw new Error('native failure'); },
      stop: async () => { h.calls.push('stop'); if (options.stopFails) throw new Error('native failure'); },
    },
    readRecord: async () => { h.calls.push('read'); if (options.readFails) throw new Error('storage failure'); return h.record; },
    writeRecord: async (raw) => { h.calls.push('write'); if (h.writeFails) throw new Error('storage failure'); h.record = raw; },
    now: () => new Date('2026-11-21T03:00:00.000Z'),
  });
  const sdkCalls = () => h.calls.filter((call) => call === 'start' || call === 'stop' || call === 'requestTracking');
  const saved = () => parseConsentRecord(h.record);
  return { h, measurement, sdkCalls, saved, state: () => measurement.getState() };
}

describe('광고 성과 측정 before any choice', () => {
  it('asks once on the first launch and touches no SDK', async () => {
    const s = setup();
    await s.measurement.init();
    await s.measurement.init();
    assert.deepEqual(s.h.calls, ['read']);
    assert.equal(s.state().ready, true);
    assert.equal(s.state().prompt, 'launch');
    assert.equal(s.state().active, false);
  });

  it('declining keeps the SDK untouched and is not asked again', async () => {
    const s = setup();
    await s.measurement.init();
    assert.equal(await s.measurement.answer('declined'), 'saved');
    assert.deepEqual(s.sdkCalls(), []);
    assert.equal(s.saved()?.choice, 'declined');
    assert.equal(s.saved()?.sdkOn, false);
    assert.equal(s.saved()?.decidedAt, '2026-11-21T03:00:00.000Z');
    assert.equal(s.state().prompt, 'none');

    const next = setup({ record: s.h.record });
    await next.measurement.init();
    assert.deepEqual(next.h.calls, ['read']);
    assert.equal(next.state().prompt, 'none');
  });

  it('asks again when the stored choice answered an older notice', async () => {
    const s = setup({ record: stored('granted', true, '2026-01-01') });
    await s.measurement.init();
    // Measured under the old notice: stopped until the new one is answered.
    assert.deepEqual(s.sdkCalls(), ['stop']);
    assert.equal(s.state().prompt, 'launch');
    assert.equal(s.state().choice === null, true);
  });
});

describe('광고 성과 측정 on Android', () => {
  it('agreeing saves the choice, marks the SDK on, then starts it once', async () => {
    const s = setup();
    await s.measurement.init();
    assert.equal(await s.measurement.answer('granted'), 'saved');
    assert.deepEqual(s.h.calls, ['read', 'write', 'write', 'start']);
    assert.equal(s.saved()?.choice, 'granted');
    assert.equal(s.saved()?.sdkOn, true);
    assert.equal(s.state().active, true);
    await s.measurement.answer('granted');
    assert.deepEqual(s.sdkCalls(), ['start']);
  });

  it('a later launch with the consent starts at once, without a question', async () => {
    const s = setup({ record: stored('granted', true) });
    await s.measurement.init();
    assert.deepEqual(s.h.calls, ['read', 'start']);
    assert.equal(s.state().prompt, 'none');
    assert.equal(s.state().active, true);
  });

  it('withdrawing stops the SDK and clears the marker', async () => {
    const s = setup({ record: stored('granted', true) });
    await s.measurement.init();
    assert.equal(await s.measurement.answer('declined'), 'saved');
    assert.deepEqual(s.sdkCalls(), ['start', 'stop']);
    assert.equal(s.saved()?.choice, 'declined');
    assert.equal(s.saved()?.sdkOn, false);
    assert.equal(s.state().active, false);
  });

  it('a stop that never completed is repeated on the next launch', async () => {
    const s = setup({ record: stored('declined', true) });
    await s.measurement.init();
    assert.deepEqual(s.sdkCalls(), ['stop']);
    assert.equal(s.saved()?.sdkOn, false);
  });

  it('a stop that throws stays marked, so the next launch stops again', async () => {
    const s = setup({ record: stored('declined', true), stopFails: true });
    await s.measurement.init();
    assert.deepEqual(s.sdkCalls(), ['stop']);
    assert.equal(s.saved()?.sdkOn, true);
  });
});

describe('광고 성과 측정 on iOS', () => {
  it('agreeing asks 앱 추적 허용 once and measures only once it is allowed', async () => {
    const s = setup({ platform: 'ios', tracking: undetermined, prompted: granted });
    await s.measurement.init();
    assert.deepEqual(s.h.calls, ['read', 'getTracking']);
    await s.measurement.answer('granted');
    assert.deepEqual(s.sdkCalls(), ['requestTracking', 'start']);
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
    assert.deepEqual(s.sdkCalls(), ['start']);
    s.h.tracking = denied;
    await s.measurement.refreshTracking();
    assert.deepEqual(s.sdkCalls(), ['start', 'stop']);
    assert.equal(s.saved()?.sdkOn, false);
    s.h.tracking = granted;
    await s.measurement.refreshTracking();
    assert.deepEqual(s.sdkCalls(), ['start', 'stop', 'start']);
    assert.equal(s.state().active, true);
  });

  it('a consent from before 앱 추적 허용 was refused starts nothing on launch', async () => {
    const s = setup({ platform: 'ios', record: stored('granted', false), tracking: denied });
    await s.measurement.init();
    assert.deepEqual(s.sdkCalls(), []);
    assert.equal(s.state().prompt, 'none');
  });
});

describe('광고 성과 측정 fails closed', () => {
  it('an unreadable choice starts nothing and asks nothing this session', async () => {
    const s = setup({ readFails: true });
    await s.measurement.init();
    assert.deepEqual(s.sdkCalls(), ['stop']);
    assert.equal(s.state().prompt, 'none');
    assert.equal(s.state().active, false);
  });

  it('a consent that cannot be saved is not acted on', async () => {
    const s = setup({ writeFails: true });
    await s.measurement.init();
    assert.equal(await s.measurement.answer('granted'), 'failed');
    assert.deepEqual(s.sdkCalls(), []);
    assert.equal(s.state().prompt, 'none');
    assert.equal(s.state().choice === null, true);
  });

  it('a withdrawal that cannot be saved still stops the SDK for this session', async () => {
    const s = setup({ record: stored('granted', true) });
    await s.measurement.init();
    s.h.writeFails = true;
    assert.equal(await s.measurement.answer('declined'), 'failed');
    assert.deepEqual(s.sdkCalls(), ['start', 'stop']);
    assert.equal(s.state().active, false);
  });

  it('a start that throws leaves the measurement off', async () => {
    const s = setup({ startFails: true });
    await s.measurement.init();
    assert.equal(await s.measurement.answer('granted'), 'saved');
    assert.deepEqual(s.sdkCalls(), ['start']);
    assert.equal(s.state().active, false);
    assert.equal(s.state().busy, false);
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
    assert.deepEqual(s.sdkCalls(), ['start', 'stop']);
    assert.equal(s.saved()?.choice, 'declined');
  });
});
