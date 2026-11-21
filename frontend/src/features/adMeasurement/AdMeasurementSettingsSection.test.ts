import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import type { AdMeasurementState } from './controller.ts';

const require = createRequire(import.meta.url);
const React = require('react');
const { act, create } = require('react-test-renderer');
const { load } = require('../../../test/ledgerTestHarness.cjs');
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 설정 › 광고 성과 측정 over a fake controller: the switch shows the device's
 * choice, turning it on opens the notice first (never a silent consent),
 * turning it off withdraws at once, and on iOS a consent without 앱 추적 허용
 * says that nothing is measured. Small values only in assertions.
 */
const base: AdMeasurementState = { ready: true, supported: true, choice: null, tracking: null, active: false, deferred: false, prompt: 'none', busy: false };

function section(state: Partial<AdMeasurementState> = {}, platform = 'android') {
  const h = { calls: [] as string[], openedSettings: 0, alerts: 0, results: [] as string[], result: 'saved' };
  const module = load(resolve('src/features/adMeasurement/AdMeasurementSettingsSection.tsx'), {
    'react-native': {
      View: 'View', Text: 'Text', Switch: 'Switch', Platform: { OS: platform },
      Linking: { openSettings: async () => { h.openedSettings += 1; } },
    },
    '../../theme/tokens': { semantic: { border: 'border', surface: 'surface', secondary: 'secondary' } },
    './adMeasurement': {
      adMeasurement: {
        openSettingsPrompt: () => { h.calls.push('open'); },
        answer: async (choice: string) => { h.calls.push(`answer:${choice}`); return h.result; },
      },
      useAdMeasurement: () => ({ ...base, ...state }),
      alertIfNotSaved: (result: string) => { h.results.push(result); if (result === 'failed') h.alerts += 1; },
    },
  });
  let renderer: any;
  act(() => { renderer = create(React.createElement(module.default)); });
  const host = (testID: string) => renderer.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === testID)[0];
  return {
    h,
    status: module.adMeasurementStatus as (value: AdMeasurementState, os: 'ios' | 'android') => string,
    toggle: () => host('settings-ad-measurement-switch'),
    statusLine: () => String(host('settings-ad-measurement-status')?.props.children),
    tracking: () => host('settings-ad-measurement-tracking'),
    notice: () => host('settings-ad-measurement-notice'),
    trackingLabel: () => String(renderer.root.findAll((node: any) => node.type === 'Text')
      .map((node: any) => node.props.children).find((text: unknown) => typeof text === 'string' && text.startsWith('iOS '))),
    empty: () => renderer.toJSON() === null,
    unmount: () => act(() => renderer.unmount()),
  };
}

describe('설정 › 광고 성과 측정', () => {
  it('shows nothing where the build cannot measure', () => {
    const s = section({ supported: false });
    assert.equal(s.empty(), true);
    s.unmount();
  });

  it('off by default; turning it on opens the notice, never a silent consent', async () => {
    const s = section();
    assert.equal(s.toggle().props.value, false);
    assert.equal(s.statusLine(), '동의하지 않음 · Meta에 아무 정보도 보내지 않습니다.');
    await act(async () => { s.toggle().props.onValueChange(true); });
    assert.deepEqual(s.h.calls, ['open']);
    s.unmount();
  });

  it('turning it off withdraws at once and warns if that could not be saved', async () => {
    const s = section({ choice: 'granted', active: true });
    assert.equal(s.toggle().props.value, true);
    assert.equal(s.statusLine(), '동의함 · 앱 설치·실행 정보를 Meta에 보냅니다.');
    s.h.result = 'failed';
    await act(async () => { s.toggle().props.onValueChange(false); });
    assert.deepEqual(s.h.calls, ['answer:declined']);
    assert.equal(s.h.alerts, 1);
    s.unmount();
  });

  it('cannot be changed while the choice is read or a decision runs', () => {
    for (const state of [{ ready: false }, { busy: true }]) {
      const s = section(state);
      assert.equal(s.toggle().props.disabled, true, JSON.stringify(state));
      s.unmount();
    }
  });

  it('opens the notice again from 동의 내용 보기', async () => {
    const s = section({ choice: 'declined' });
    await act(async () => { s.notice().props.onPress(); });
    assert.deepEqual(s.h.calls, ['open']);
    s.unmount();
  });

  it('iOS: a consent without 앱 추적 허용 measures nothing and says how to change it', async () => {
    const refused = section({ choice: 'granted', tracking: { status: 'denied', canAskAgain: false } }, 'ios');
    assert.equal(refused.statusLine().includes('측정하지 않습니다'), true);
    assert.equal(refused.trackingLabel(), 'iOS 설정 열기');
    await act(async () => { refused.tracking().props.onPress(); });
    assert.equal(refused.h.openedSettings, 1);
    assert.deepEqual(refused.h.calls, []);
    refused.unmount();

    const undecided = section({ choice: 'granted', tracking: { status: 'undetermined', canAskAgain: true } }, 'ios');
    assert.equal(undecided.trackingLabel(), 'iOS 앱 추적 허용 요청하기');
    await act(async () => { undecided.tracking().props.onPress(); });
    assert.deepEqual(undecided.h.calls, ['answer:granted']);
    undecided.unmount();
  });

  it('iOS with both allowed, and Android, offer no system step', () => {
    for (const [state, os] of [[{ choice: 'granted', tracking: { status: 'granted', canAskAgain: false }, active: true }, 'ios'],
      [{ choice: 'granted', active: true }, 'android']] as const) {
      const s = section(state, os);
      assert.equal(s.tracking() === undefined, true, os);
      assert.equal(s.statusLine(), '동의함 · 앱 설치·실행 정보를 Meta에 보냅니다.');
      s.unmount();
    }
  });

  it('says when an allowed measurement could not start', () => {
    const s = section();
    assert.equal(s.status({ ...base, choice: 'granted', active: false }, 'android'), '동의함 · 측정을 시작하지 못했습니다. 앱을 다시 실행하면 다시 시도합니다.');
    assert.equal(s.status({ ...base, ready: false }, 'android'), '확인 중입니다.');
    s.unmount();
  });

  it('says when a consent given again in this session measures from the next launch', () => {
    const s = section({ choice: 'granted', deferred: true });
    assert.equal(s.toggle().props.value, true);
    assert.equal(s.statusLine(), '동의함 · 앱을 다시 실행하면 측정을 시작합니다.');
    s.unmount();
  });

  it('never says nothing is sent while a withdrawn measurement has not confirmed its stop', async () => {
    const s = section({ choice: 'declined', active: true });
    assert.equal(s.toggle().props.value, false);
    assert.equal(s.statusLine(), '동의하지 않음 · 측정을 바로 중단하지 못했습니다. 앱을 다시 실행하면 측정하지 않습니다.');
    s.unmount();

    const withdrawing = section({ choice: 'granted', active: true });
    withdrawing.h.result = 'stopFailed';
    await act(async () => { withdrawing.toggle().props.onValueChange(false); });
    assert.deepEqual(withdrawing.h.results, ['stopFailed']);
    withdrawing.unmount();
  });
});
