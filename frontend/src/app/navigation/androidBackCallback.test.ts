import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

// The committed native project ships as is (EAS skips prebuild), so this
// activity is the app's real Back entry on Android.
const activity = readFileSync(resolve('android/app/src/main/java/com/nanghwa/tradingclass/MainActivity.kt'), 'utf8');
const reactActivity = readFileSync(resolve('node_modules/react-native/ReactAndroid/src/main/java/com/facebook/react/ReactActivity.java'), 'utf8');
const body = (source: string, signature: string) => {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, signature);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${signature}`);
};

describe('Android Back reaches JavaScript after the app was left once', () => {
  it("root cause (React Native 0.83): the default Back turns RN's own callback off for good", () => {
    // When this changes, React Native may have fixed it upstream: recheck MainActivity's callback.
    const fallback = body(reactActivity, 'public void invokeDefaultOnBackPressed()');
    assert.match(fallback, /mBackPressedCallback\.setEnabled\(false\)/);
    assert.doesNotMatch(fallback, /setEnabled\(true\)/);
    assert.match(reactActivity, /isAtLeastTargetSdk36\(this\)\)\s*\{\s*getOnBackPressedDispatcher\(\)\.addCallback\(this, mBackPressedCallback\)/);
  });

  it('MainActivity keeps its own callback, asked before React Native\'s, on except during the default', () => {
    const callback = body(activity, 'private val backToJavaScript = object : OnBackPressedCallback(true)');
    // Off while it asks React Native, so a Back React Native does not take reaches the default.
    assert.match(callback, /isEnabled = false\s*try \{\s*this@MainActivity\.onBackPressed\(\)\s*\} finally \{\s*isEnabled = true/);
    const create = body(activity, 'override fun onCreate(');
    assert.ok(create.indexOf('super.onCreate(') < create.indexOf('onBackPressedDispatcher.addCallback(this, backToJavaScript)'),
      'added after ReactActivity registers its callback, so the dispatcher asks this one first');
    const fallback = body(activity, 'override fun invokeDefaultOnBackPressed()');
    assert.match(fallback, /backToJavaScript\.isEnabled = false\s*try \{\s*super\.invokeDefaultOnBackPressed\(\)\s*\} finally \{\s*backToJavaScript\.isEnabled = true/,
      'the system default runs without this callback and the next Back goes to JavaScript again');
    assert.match(fallback, /Build\.VERSION\.SDK_INT <= Build\.VERSION_CODES\.R && moveTaskToBack\(false\)/, 'Android 11 and older still only move the task back');
  });
});
