import { isStandaloneAccountMode } from './account-mode-policy';

describe('standalone financial classification', () => {
  it('shares only standalone financial rules with beginner', () => {
    expect(isStandaloneAccountMode('beginner')).toBe(true);
    expect(isStandaloneAccountMode('general')).toBe(true);
    expect(isStandaloneAccountMode('season')).toBe(false);
    expect(isStandaloneAccountMode(undefined)).toBe(false);
  });
});
