import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  AD_MEASUREMENT_CONSENT_VERSION,
  AD_MEASUREMENT_NOTICE,
  adMeasurementNoticeText,
  currentChoice,
  measurementAllowed,
  measurementPlatform,
  parseConsentRecord,
  serializeConsentRecord,
  shouldRequestTracking,
  type Tracking,
} from './consent.ts';

/** The notice revision a stored choice answers; its words are pinned to it. */
const PINNED = { version: '2026-11-21', sha256: 'e7ed2c0a84727bf924b1a36dc6a72465c66016d1d3b5f24c3671ef9e19b5377d' } as const;

const granted: Tracking = { status: 'granted', canAskAgain: false };
const denied: Tracking = { status: 'denied', canAskAgain: false };
const undetermined: Tracking = { status: 'undetermined', canAskAgain: true };

describe('광고 성과 측정 consent record', () => {
  it('reads back exactly what it stored', () => {
    const record = { choice: 'granted' as const, version: AD_MEASUREMENT_CONSENT_VERSION, decidedAt: '2026-11-21T01:02:03.000Z', sdkOn: true };
    assert.deepEqual(parseConsentRecord(serializeConsentRecord(record)), record);
  });

  it('treats anything else as no record at all', () => {
    for (const raw of [null, undefined, '', 'not json', '[]', '"granted"', '{}', '{"choice":"yes","version":"2026-11-21","decidedAt":"x"}',
      '{"choice":"granted","decidedAt":"x"}', '{"choice":"granted","version":"2026-11-21"}', '{"choice":"granted","version":1,"decidedAt":"x"}'])
      assert.equal(parseConsentRecord(raw) === null, true, String(raw));
  });

  it('keeps the native marker only when it is exactly true', () => {
    const raw = (sdkOn: unknown) => JSON.stringify({ choice: 'declined', version: AD_MEASUREMENT_CONSENT_VERSION, decidedAt: 'x', sdkOn });
    assert.equal(parseConsentRecord(raw(true))?.sdkOn, true);
    for (const value of [false, 'true', 1, null, undefined]) assert.equal(parseConsentRecord(raw(value))?.sdkOn, false, String(value));
  });

  it('counts a choice made for another notice revision as undecided', () => {
    const record = (version: string) => ({ choice: 'granted' as const, version, decidedAt: 'x', sdkOn: false });
    assert.equal(currentChoice(record(AD_MEASUREMENT_CONSENT_VERSION)), 'granted');
    assert.equal(currentChoice({ ...record(AD_MEASUREMENT_CONSENT_VERSION), choice: 'declined' }), 'declined');
    assert.equal(currentChoice(record('2026-01-01')), null);
    assert.equal(currentChoice(null), null);
  });
});

describe('광고 성과 측정 policy', () => {
  it('measures on Android only after the consent', () => {
    assert.equal(measurementAllowed('android', 'granted', null), true);
    assert.equal(measurementAllowed('android', 'declined', null), false);
    assert.equal(measurementAllowed('android', null, null), false);
  });

  it('measures on iOS only with the consent and 앱 추적 허용 both', () => {
    assert.equal(measurementAllowed('ios', 'granted', granted), true);
    for (const tracking of [denied, undetermined, null]) assert.equal(measurementAllowed('ios', 'granted', tracking), false, JSON.stringify(tracking));
    for (const choice of ['declined', null] as const) assert.equal(measurementAllowed('ios', choice, granted), false, String(choice));
  });

  it('never measures where there is no native SDK', () => {
    assert.equal(measurementPlatform('web'), 'unsupported');
    assert.equal(measurementPlatform('windows'), 'unsupported');
    assert.equal(measurementPlatform('ios'), 'ios');
    assert.equal(measurementPlatform('android'), 'android');
    assert.equal(measurementAllowed('unsupported', 'granted', granted), false);
  });

  it('asks iOS for 앱 추적 허용 only while undecided, never on Android', () => {
    assert.equal(shouldRequestTracking('ios', undetermined), true);
    assert.equal(shouldRequestTracking('ios', { status: 'undetermined', canAskAgain: false }), false);
    for (const tracking of [granted, denied, null]) assert.equal(shouldRequestTracking('ios', tracking), false, JSON.stringify(tracking));
    assert.equal(shouldRequestTracking('android', undetermined), false);
  });
});

describe('광고 성과 측정 notice', () => {
  it('pins its words to the revision a stored choice answers', () => {
    assert.equal(AD_MEASUREMENT_CONSENT_VERSION, PINNED.version);
    assert.equal(createHash('sha256').update(adMeasurementNoticeText().join('\n')).digest('hex'), PINNED.sha256,
      'notice changed: raise AD_MEASUREMENT_CONSENT_VERSION (every device is asked again)');
  });

  it('says who receives what, why, where and for how long', () => {
    assert.deepEqual(AD_MEASUREMENT_NOTICE.rows.map((row) => row.label), ['받는 자', '목적', '항목', '이전 국가', '보유 기간']);
    assert.equal(AD_MEASUREMENT_NOTICE.rows[0].value, 'Meta Platforms, Inc.');
    const items = AD_MEASUREMENT_NOTICE.rows[2].value;
    for (const item of ['앱 설치·실행·종료 기록', 'Android 광고 ID', 'IDFA', '임의 식별자', 'IP 주소', '설치 리퍼러'])
      assert.equal(items.includes(item), true, item);
  });

  it('names what is never sent and that refusing costs nothing', () => {
    for (const item of ['이메일', '닉네임', '회원 ID', '잔액', '수익률', '포트폴리오', '주문', '체결', '거래 기록', '지갑', '원장', '시즌'])
      assert.equal(AD_MEASUREMENT_NOTICE.excluded.includes(item), true, item);
    assert.equal(AD_MEASUREMENT_NOTICE.refusal.includes('동의하지 않아도 모든 기능을 그대로 이용할 수 있습니다'), true);
    assert.equal(AD_MEASUREMENT_NOTICE.refusal.includes('언제든 철회'), true);
    // iOS: the system prompt follows the consent, and both are needed.
    assert.equal(AD_MEASUREMENT_NOTICE.ios.includes('두 가지를 모두 허용한 경우에만 측정'), true);
  });
});
