/**
 * Common schema pieces for live-smoke report artifacts, including the
 * NOT_RUN report used when a provider smoke could not be executed (market
 * closed, missing entitlement, missing credentials). A smoke that did not
 * run must be recorded as result=not_run — never as passed.
 */
import type { SmokeGitIdentity } from './smoke-git-identity';

export const SMOKE_REPORT_SCHEMA_VERSION = 1;

export const SMOKE_REPORT_PROVIDERS = ['binance', 'kis-krx', 'kis-us'] as const;
export type SmokeReportProvider = (typeof SMOKE_REPORT_PROVIDERS)[number];

export type SmokeReportResult = 'passed' | 'failed' | 'not_run';

export type SmokeNotRunReport = {
  schemaVersion: number;
  gitCommit: string;
  gitBranch: string | null;
  gitDirty: boolean;
  provider: SmokeReportProvider;
  result: 'not_run';
  reason: string;
  createdAt: string;
};

export class SmokeReportInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmokeReportInputError';
  }
}

export function buildNotRunReport(input: {
  identity: SmokeGitIdentity;
  provider: string;
  reason: string;
  createdAt?: Date;
}): SmokeNotRunReport {
  if (!SMOKE_REPORT_PROVIDERS.includes(input.provider as SmokeReportProvider)) {
    throw new SmokeReportInputError(
      `--provider must be one of: ${SMOKE_REPORT_PROVIDERS.join(', ')}.`,
    );
  }
  const reason = input.reason?.trim();
  if (!reason) {
    throw new SmokeReportInputError(
      'A NOT_RUN report requires a non-empty --reason explaining why the smoke did not run.',
    );
  }
  return {
    schemaVersion: SMOKE_REPORT_SCHEMA_VERSION,
    gitCommit: input.identity.gitCommit,
    gitBranch: input.identity.gitBranch,
    gitDirty: input.identity.gitDirty,
    provider: input.provider as SmokeReportProvider,
    result: 'not_run',
    reason,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
  };
}
