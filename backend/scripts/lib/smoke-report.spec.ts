import type { SmokeGitIdentity } from './smoke-git-identity';
import {
  buildNotRunReport,
  SMOKE_REPORT_SCHEMA_VERSION,
  SmokeReportInputError,
} from './smoke-report';

const identity: SmokeGitIdentity = {
  gitCommit: 'c'.repeat(40),
  gitBranch: 'main',
  gitDirty: false,
  capturedAt: '2026-07-15T00:00:00.000Z',
};

describe('buildNotRunReport', () => {
  it('records provider, reason, git identity, and result=not_run', () => {
    const createdAt = new Date('2026-07-15T01:02:03.000Z');
    const report = buildNotRunReport({
      identity,
      provider: 'kis-us',
      reason: 'US regular session closed',
      createdAt,
    });
    expect(report).toEqual({
      schemaVersion: SMOKE_REPORT_SCHEMA_VERSION,
      gitCommit: identity.gitCommit,
      gitBranch: 'main',
      gitDirty: false,
      provider: 'kis-us',
      result: 'not_run',
      reason: 'US regular session closed',
      createdAt: createdAt.toISOString(),
    });
    // A NOT_RUN artifact is never aggregated as a pass.
    expect(report.result).not.toBe('passed');
  });

  it('preserves gitDirty=true from the identity', () => {
    const report = buildNotRunReport({
      identity: { ...identity, gitDirty: true },
      provider: 'binance',
      reason: 'credentials unavailable',
    });
    expect(report.gitDirty).toBe(true);
  });

  it('rejects unknown providers and empty reasons', () => {
    expect(() =>
      buildNotRunReport({ identity, provider: 'kraken', reason: 'nope' }),
    ).toThrow(SmokeReportInputError);
    expect(() =>
      buildNotRunReport({ identity, provider: 'kis-krx', reason: '   ' }),
    ).toThrow(SmokeReportInputError);
  });
});
