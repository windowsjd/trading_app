import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { it } from 'node:test';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const { runAudit } = require('../../../../scripts/diagnostic-enforcement.cjs');
const fixtures = require('../../../../scripts/diagnostic-enforcement-fixtures.cjs');

it('detects new diagnostic bypasses in AST fixtures', () => fixtures(ts, assert));
it('keeps new Frontend error presentation attached to the original error', () => {
  assert.deepEqual(runAudit(resolve(import.meta.dirname, '../../../..'), 'frontend'), []);
});
