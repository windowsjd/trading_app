import {
  assertReleaseCleanTree,
  resolveSmokeGitIdentity,
  SmokeGitIdentityError,
  type SmokeGitExec,
} from './smoke-git-identity';

const SHA = 'a'.repeat(40);

function gitExec(
  overrides: Partial<Record<string, string | Error>>,
): SmokeGitExec {
  const responses: Record<string, string | Error> = {
    'git rev-parse HEAD': `${SHA}\n`,
    'git rev-parse --abbrev-ref HEAD': 'main\n',
    'git status --porcelain': '',
    ...overrides,
  };
  return (command) => {
    const response = responses[command];
    if (response === undefined)
      throw new Error(`unexpected command ${command}`);
    if (response instanceof Error) throw response;
    return response;
  };
}

describe('resolveSmokeGitIdentity', () => {
  it('resolves commit, branch, and a clean tree from a normal repository', () => {
    const identity = resolveSmokeGitIdentity({}, gitExec({}));
    expect(identity).toMatchObject({
      gitCommit: SHA,
      gitBranch: 'main',
      gitDirty: false,
    });
    expect(new Date(identity.capturedAt).getTime()).not.toBeNaN();
  });

  it('prefers a well-formed SMOKE_GIT_COMMIT override', () => {
    const explicit = 'B'.repeat(40);
    const identity = resolveSmokeGitIdentity(
      { SMOKE_GIT_COMMIT: explicit },
      gitExec({}),
    );
    expect(identity.gitCommit).toBe(explicit.toLowerCase());
  });

  it('rejects a malformed SMOKE_GIT_COMMIT instead of falling back', () => {
    for (const invalid of ['abc123', `${SHA}0`, 'not-a-sha', 'g'.repeat(40)]) {
      expect(() =>
        resolveSmokeGitIdentity({ SMOKE_GIT_COMMIT: invalid }, gitExec({})),
      ).toThrow(SmokeGitIdentityError);
    }
  });

  it('aborts when the commit cannot be resolved at all', () => {
    const broken = gitExec({
      'git rev-parse HEAD': new Error('not a git repository'),
    });
    expect(() => resolveSmokeGitIdentity({}, broken)).toThrow(
      SmokeGitIdentityError,
    );
    expect(() => resolveSmokeGitIdentity({}, broken)).toThrow(
      /commit traceability/u,
    );
  });

  it('reports a dirty tree from git status output', () => {
    const identity = resolveSmokeGitIdentity(
      {},
      gitExec({ 'git status --porcelain': ' M src/app.ts\n' }),
    );
    expect(identity.gitDirty).toBe(true);
  });

  it('fails safe to dirty when the tree status cannot be verified', () => {
    const identity = resolveSmokeGitIdentity(
      { SMOKE_GIT_COMMIT: SHA },
      gitExec({
        'git status --porcelain': new Error('git unavailable'),
        'git rev-parse --abbrev-ref HEAD': new Error('git unavailable'),
      }),
    );
    expect(identity.gitDirty).toBe(true);
    expect(identity.gitBranch).toBeNull();
  });
});

describe('assertReleaseCleanTree', () => {
  const dirty = resolveSmokeGitIdentity(
    {},
    gitExec({ 'git status --porcelain': ' M src/app.ts\n' }),
  );
  const clean = resolveSmokeGitIdentity({}, gitExec({}));

  it('blocks a dirty working tree by default', () => {
    expect(() => assertReleaseCleanTree(dirty, {})).toThrow(
      SmokeGitIdentityError,
    );
    expect(() => assertReleaseCleanTree(dirty, {})).toThrow(
      /never release validation/u,
    );
  });

  it('allows a clean tree, and a dirty tree only with SMOKE_ALLOW_DIRTY=1', () => {
    expect(() => assertReleaseCleanTree(clean, {})).not.toThrow();
    expect(() =>
      assertReleaseCleanTree(dirty, { SMOKE_ALLOW_DIRTY: '1' }),
    ).not.toThrow();
    // Any other value is not an escape hatch.
    expect(() =>
      assertReleaseCleanTree(dirty, { SMOKE_ALLOW_DIRTY: 'true' }),
    ).toThrow(SmokeGitIdentityError);
  });
});
