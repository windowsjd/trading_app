import { HttpException } from '@nestjs/common';
import {
  assertBeginnerModeEnabled,
  isBeginnerModeEnabled,
  isStandaloneAccountMode,
} from './account-mode-policy';

describe('beginner activation boundary', () => {
  it.each([undefined, '', 'false', '1', 'TRUE', ' true'])(
    'stays disabled in every environment with flag %s',
    (flag) => {
      for (const NODE_ENV of [undefined, 'development', 'test', 'production'])
        expect(
          isBeginnerModeEnabled({ NODE_ENV, BEGINNER_MODE_ENABLED: flag }),
        ).toBe(false);
    },
  );
  it('opens for every environment, production included, only with explicit true', () => {
    for (const NODE_ENV of [undefined, 'development', 'test', 'production'])
      expect(
        isBeginnerModeEnabled({ NODE_ENV, BEGINNER_MODE_ENABLED: 'true' }),
      ).toBe(true);
  });
  it('gates only beginner exposure, leaving general and season policy intact', () => {
    const flag = process.env.BEGINNER_MODE_ENABLED;
    try {
      delete process.env.BEGINNER_MODE_ENABLED;
      expect(() => assertBeginnerModeEnabled('beginner')).toThrow(
        HttpException,
      );
      expect(() => assertBeginnerModeEnabled('general')).not.toThrow();
      expect(() => assertBeginnerModeEnabled('season')).not.toThrow();
    } finally {
      if (flag === undefined) delete process.env.BEGINNER_MODE_ENABLED;
      else process.env.BEGINNER_MODE_ENABLED = flag;
    }
  });
  it('shares only standalone financial rules with beginner', () => {
    expect(isStandaloneAccountMode('beginner')).toBe(true);
    expect(isStandaloneAccountMode('general')).toBe(true);
    expect(isStandaloneAccountMode('season')).toBe(false);
    expect(isStandaloneAccountMode(undefined)).toBe(false);
  });
});
