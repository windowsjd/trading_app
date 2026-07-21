import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parsePublicBooleanFlag } from './publicFlags.ts';

const envSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'env.ts'),
  'utf8',
);

test('public boolean flag: only explicit true/1 enables', () => {
  assert.equal(parsePublicBooleanFlag('true'), true);
  assert.equal(parsePublicBooleanFlag('1'), true);
  assert.equal(parsePublicBooleanFlag('TRUE'), true);
  assert.equal(parsePublicBooleanFlag('True'), true);
  assert.equal(parsePublicBooleanFlag('  true  '), true);
});

test('public boolean flag: false, 0, undefined and junk are all off', () => {
  assert.equal(parsePublicBooleanFlag('false'), false);
  assert.equal(parsePublicBooleanFlag('0'), false);
  assert.equal(parsePublicBooleanFlag('False'), false);
  assert.equal(parsePublicBooleanFlag('FALSE'), false);
  assert.equal(parsePublicBooleanFlag(undefined), false);
  assert.equal(parsePublicBooleanFlag(''), false);
  assert.equal(parsePublicBooleanFlag('   '), false);
  // A client bundle has no bootstrap to fail, so an unrecognized value stays
  // fail-closed here; the backend rejects it at startup instead.
  assert.equal(parsePublicBooleanFlag('yes'), false);
  assert.equal(parsePublicBooleanFlag('tru'), false);
  assert.equal(parsePublicBooleanFlag('enabled'), false);
});

test('env.ts reads every EXPO_PUBLIC var with static dot notation', () => {
  // babel-preset-expo's inline-env-vars pass only rewrites member expressions
  // whose property is a literal name starting with EXPO_PUBLIC_. If any of
  // these regressed to a computed lookup the value would silently never reach
  // the bundle and the flag would read as unset in every build.
  for (const name of [
    'EXPO_PUBLIC_LIMIT_ORDER_ENABLED',
    'EXPO_PUBLIC_API_ORIGIN',
    'EXPO_PUBLIC_WS_BASE_URL',
  ]) {
    assert.match(
      envSource,
      new RegExp(`process\\.env\\?\\.${name}\\b`),
      `env.ts must read ${name} via static dot notation`,
    );
  }
});

test('env.ts contains no dynamic process.env key access', () => {
  const withoutComments = envSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  assert.doesNotMatch(
    withoutComments,
    /process\s*\.\s*env\s*\??\s*\[/,
    'env.ts must not index process.env with a computed key',
  );
  assert.doesNotMatch(
    withoutComments,
    /getRuntimeEnvValue/,
    'the key-taking env helper must stay removed',
  );
});

test('the limit order flag is derived from the shared parser', () => {
  assert.match(
    envSource,
    /export const LIMIT_ORDER_ENABLED = parsePublicBooleanFlag\(\s*RAW_LIMIT_ORDER_ENABLED,?\s*\)/,
  );
});
