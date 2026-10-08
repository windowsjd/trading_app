import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const fixtures = require('../../../../scripts/diagnostic-enforcement-fixtures.cjs');

it('detects obvious diagnostic bypasses in source fixtures', () => fixtures(ts, assert, 'frontend'));
