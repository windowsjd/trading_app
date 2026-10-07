import { resolve } from 'node:path';
import ts from 'typescript';

const { runAudit } = require('../../../scripts/diagnostic-enforcement.cjs') as {
  runAudit: (root: string, scope: string) => unknown[];
};
const fixtures =
  require('../../../scripts/diagnostic-enforcement-fixtures.cjs') as (
    compiler: typeof ts,
    assertion: typeof import('node:assert/strict'),
  ) => void;

describe('production diagnostic source gate', () => {
  it('detects bypass fixtures and accepts approved HTTP/Ops paths', () => {
    fixtures(ts, require('node:assert/strict'));
  });
  it('rejects new Backend emitters outside diagnostic surfaces', () => {
    expect(runAudit(resolve(__dirname, '../../..'), 'backend')).toEqual([]);
  });
});
