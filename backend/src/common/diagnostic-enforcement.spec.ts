import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const fixtures =
  require('../../../scripts/diagnostic-enforcement-fixtures.cjs') as (
    compiler: typeof ts,
    assertion: typeof import('node:assert/strict'),
    scope: 'backend' | 'frontend',
  ) => void;

describe('production diagnostic source gate', () => {
  it('detects bypass fixtures and accepts approved HTTP/Ops paths', () => {
    fixtures(ts, require('node:assert/strict'), 'backend');
  });
  it('keeps the three common bootstrap registrations independently of diff analysis', () => {
    // Two fixed wiring files only, not a repository audit. Runtime filter/role
    // behavior is exercised by foundation tests and the real AppModule E2E.
    const main = readFileSync(resolve(__dirname, '../main.ts'), 'utf8');
    const module = readFileSync(resolve(__dirname, '../app.module.ts'), 'utf8');
    expect(main).toMatch(/\.use\(adminDiagnosticRequestMiddleware\)/);
    expect(main).toMatch(/\.useLogger\(new AdminDiagnosticLogger\(\)\)/);
    expect(module).toMatch(
      /provide:\s*APP_FILTER,\s*useClass:\s*GlobalHttpExceptionFilter/,
    );
  });
});
