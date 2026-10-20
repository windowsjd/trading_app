import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { describeBuild } from './buildInfo.ts';

const require = createRequire(import.meta.url);
const withAppConfig = require('../../app.config.js') as (input: { config: Record<string, unknown> }) => { extra: Record<string, unknown> };

describe('build identification (MY › 설정 › 앱 정보)', () => {
  it('names an EAS build by its commit and profile; anything else is a 개발 빌드', () => {
    assert.equal(describeBuild({ commit: '367fbe5e7a9fa96aa7a7a46d44dc70cf1a4d8b1a', profile: 'preview', id: 'x' }), '빌드 367fbe5e · preview');
    assert.equal(describeBuild({ commit: '367FBE5E7A9F', profile: '' }), '빌드 367fbe5e');
    for (const build of [undefined, null, {}, { commit: '' }, { commit: 'not-a-sha' }, { commit: 12345678 }, 'abc1234']) {
      assert.equal(describeBuild(build), '개발 빌드', JSON.stringify(build));
    }
  });

  it('app.config.js stamps the EAS commit into extra.build and leaves other builds unstamped', () => {
    const base = { name: 'LeagueOfTrading', extra: { eas: { projectId: 'project' } } };
    const keys = ['EAS_BUILD_GIT_COMMIT_HASH', 'EAS_BUILD_PROFILE', 'EAS_BUILD_ID'] as const;
    const saved = keys.map((key) => process.env[key]);
    try {
      for (const key of keys) delete process.env[key];
      const unstamped = withAppConfig({ config: base }).extra;
      assert.deepEqual(unstamped.eas, { projectId: 'project' });
      assert.equal(unstamped.build === undefined, true);
      Object.assign(process.env, { EAS_BUILD_GIT_COMMIT_HASH: 'abcdef1234567', EAS_BUILD_PROFILE: 'preview', EAS_BUILD_ID: 'build-1' });
      const stamped = withAppConfig({ config: base });
      assert.deepEqual(stamped.extra.eas, { projectId: 'project' });
      assert.deepEqual(stamped.extra.build, { commit: 'abcdef1234567', profile: 'preview', id: 'build-1' });
      assert.equal(describeBuild(stamped.extra.build), '빌드 abcdef12 · preview');
    } finally {
      keys.forEach((key, index) => {
        if (saved[index] === undefined) delete process.env[key];
        else process.env[key] = saved[index];
      });
    }
  });
});
