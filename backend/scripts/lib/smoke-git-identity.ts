/**
 * Shared git identity for smoke artifacts (fixture, live, and report
 * scripts). Every artifact must prove WHICH code it validated:
 *
 * - gitCommit resolution order: a well-formed SMOKE_GIT_COMMIT env override,
 *   then `git rev-parse HEAD`. If neither yields a full 40-hex SHA the smoke
 *   MUST abort — an artifact with gitCommit=null proves nothing and a passed
 *   result without a commit is worthless as release evidence.
 * - gitDirty fails safe: when `git status` cannot be executed the tree is
 *   reported dirty, so a smoke never claims a clean tree it could not verify.
 * - Release smokes refuse to run on a dirty tree unless SMOKE_ALLOW_DIRTY=1
 *   is set explicitly; such runs record gitDirty=true in the artifact and
 *   are never valid release validation.
 */
import { execSync } from 'node:child_process';

export type SmokeGitIdentity = {
  gitCommit: string;
  gitBranch: string | null;
  gitDirty: boolean;
  capturedAt: string;
};

export class SmokeGitIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmokeGitIdentityError';
  }
}

export type SmokeGitExec = (command: string) => string;

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/iu;

const defaultExec: SmokeGitExec = (command) =>
  execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export function resolveSmokeGitIdentity(
  env: NodeJS.ProcessEnv = process.env,
  exec: SmokeGitExec = defaultExec,
): SmokeGitIdentity {
  const explicit = env.SMOKE_GIT_COMMIT?.trim();
  let gitCommit: string;
  if (explicit) {
    if (!FULL_SHA_PATTERN.test(explicit)) {
      throw new SmokeGitIdentityError(
        'SMOKE_GIT_COMMIT is set but is not a full 40-character commit SHA; refusing to start the smoke.',
      );
    }
    gitCommit = explicit.toLowerCase();
  } else {
    let resolved: string;
    try {
      resolved = exec('git rev-parse HEAD').trim();
    } catch {
      throw new SmokeGitIdentityError(
        'Cannot resolve the smoke git commit: SMOKE_GIT_COMMIT is unset and `git rev-parse HEAD` failed. A smoke artifact without commit traceability must not be produced.',
      );
    }
    if (!FULL_SHA_PATTERN.test(resolved)) {
      throw new SmokeGitIdentityError(
        '`git rev-parse HEAD` did not return a full commit SHA; refusing to start the smoke.',
      );
    }
    gitCommit = resolved.toLowerCase();
  }

  let gitBranch: string | null = null;
  try {
    const branch = exec('git rev-parse --abbrev-ref HEAD').trim();
    gitBranch = branch === '' ? null : branch;
  } catch {
    gitBranch = null;
  }

  // Fail safe: an unverifiable working-tree status counts as dirty.
  let gitDirty = true;
  try {
    gitDirty = exec('git status --porcelain').trim() !== '';
  } catch {
    gitDirty = true;
  }

  return {
    gitCommit,
    gitBranch,
    gitDirty,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Release-smoke dirty-tree policy: refuse to run on a dirty working tree.
 * SMOKE_ALLOW_DIRTY=1 is a development-only escape hatch; the artifact still
 * records gitDirty=true and such a run is never release validation.
 */
export function assertReleaseCleanTree(
  identity: SmokeGitIdentity,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!identity.gitDirty) return;
  if (env.SMOKE_ALLOW_DIRTY === '1') return;
  throw new SmokeGitIdentityError(
    'The working tree is dirty (or its status could not be verified); a release smoke must run from a clean checkout of the commit it claims to validate. Set SMOKE_ALLOW_DIRTY=1 only for development runs — dirty artifacts are never release validation.',
  );
}
