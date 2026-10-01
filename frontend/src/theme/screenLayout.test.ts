import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DESKTOP_CONTENT_MAX_WIDTH, getScreenContentStyle } from './screenLayout.ts';

test('web root content shares a centered 1120px cap without restricting the scroll viewport', () => {
  assert.equal(DESKTOP_CONTENT_MAX_WIDTH, 1120);
  assert.deepEqual(getScreenContentStyle('web'), {
    width: '100%', maxWidth: 1120, alignSelf: 'center',
  });
});

test('native screens keep their existing width and padding policies', () => {
  for (const platform of ['android', 'ios']) {
    assert.deepEqual(getScreenContentStyle(platform), {});
  }
});
