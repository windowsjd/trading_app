import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rewardedTestDiagnostic } from './rewardedTestDiagnostics.ts';

test('only received, allowlisted codes and literal message fragments survive sanitization', () => {
  const diagnostic = rewardedTestDiagnostic('ump-consent', {
    code: 'consent-update-failed',
    message: "Publisher misconfiguration: Failed to read publisher's account configuration. https://private.test?token=SECRET email=user@example.com deviceId=abc123",
    userInfo: { token: 'SECRET' }, stack: 'private-stack',
  });
  assert.equal(diagnostic.code, 'consent-update-failed'); assert.equal(diagnostic.codeSource, 'sdk');
  assert.match(diagnostic.detail, /Publisher misconfiguration/);
  assert.match(diagnostic.detail, /Failed to read publisher's account configuration/);
  assert.doesNotMatch(JSON.stringify(diagnostic), /SECRET|user@example|abc123|private-stack|https:/);
  assert.equal(diagnostic.detail.length <= 340, true);
  const native = rewardedTestDiagnostic('ad-load', { code: 'googleMobileAds/network-error', message: 'Network error: Authorization Bearer SECRET' });
  assert.equal(native.code, 'googleMobileAds/network-error'); assert.equal(native.codeSource, 'sdk');
  assert.doesNotMatch(native.detail, /SECRET|Bearer/);
});

test('unknown, oversized and hostile errors have explicit fallbacks, without stringifying or reading getters', () => {
  const hostile = { get code() { throw new Error('getter'); }, get message() { throw new Error('getter'); }, toString() { throw new Error('stringify'); } };
  for (const error of [undefined, null, hostile, 'arbitrary-private-secret',
    { code: 'secret-auth-token', message: 'email=user@example.com token=SECRET' },
    { code: 'X'.repeat(10000), message: 'Publisher misconfiguration' + 'X'.repeat(10000) }]) {
    const result = rewardedTestDiagnostic('ump-consent', error);
    assert.equal(result.codeSource, 'unavailable'); assert.match(result.code, /없음/);
    assert.match(result.detail, /설명이 없습니다/);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|user@example|private-secret|auth-token/);
  }
  const noMessage = rewardedTestDiagnostic('ump-consent', { code: 'consent-update-failed' });
  assert.match(noMessage.detail, /설명이 없습니다/, 'a code cannot manufacture a cause');
});
