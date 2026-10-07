import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
const { interactionHarness, React, act } = createRequire(import.meta.url)('../../../test/interactionTestHarness.cjs');

const error = (code: string) => ({ response: { status: 500, data: { error: { code,
  message: 'JWT_ACCESS_SECRET provider https://private.invalid req-private wallet_write 184927.543281',
  diagnostic: { requestId: 'req-private', failureStage: 'wallet_write' },
} } } });

describe('public authentication and general account errors', () => {
  for (const kind of ['Login', 'Signup']) it(`${kind} renders safe failure text before authentication`, () => {
    const h = interactionHarness();
    Object.assign(h.native, { SafeAreaView: 'SafeAreaView', TextInput: 'TextInput' });
    let mutation: any;
    const Screen = h.load(`src/screens/auth/${kind}Screen.tsx`, {
      '@tanstack/react-query': { useQueryClient: () => ({}), useMutation: (options: any) => { mutation = options; return { isPending: false }; } },
      '../../features/auth/api': {},
      '../../features/auth/session': {},
      '../../features/auth/useEnterApp': { useEnterApp: () => () => {} },
      '../../services/api/sessionOwnership': { SessionSupersededError: class extends Error {} },
    }).default;
    const renderer = h.render(React.createElement(Screen, { navigation: {} }));
    for (const code of ['AUTH_CONFIGURATION_ERROR', 'PRIVATE_UNKNOWN_CODE', 'INVALID_CREDENTIALS', 'NICKNAME_ALREADY_EXISTS']) {
      act(() => mutation.onError(error(code)));
      const text = JSON.stringify(renderer.toJSON());
      assert.doesNotMatch(text, /JWT_ACCESS_SECRET|private.invalid|req-private|wallet_write|184927|PRIVATE_UNKNOWN_CODE|백엔드|환경변수|콘솔|로그를/);
      assert.equal(renderer.root.findAllByProps({ testID: 'admin-diagnostic-toggle' }).length, 0);
      if (code === 'INVALID_CREDENTIALS') assert.match(text, /이메일 또는 비밀번호/);
      if (code === 'NICKNAME_ALREADY_EXISTS') assert.match(text, /이미 사용 중인 닉네임/);
    }
    act(() => renderer.unmount());
  });

  it('uses the real general-account mutation mapper for setup error text', () => {
    const h = interactionHarness(); h.native.SafeAreaView = 'SafeAreaView';
    let mutation: any;
    const useOpen = h.load('src/features/tradingAccount/useOpenGeneralAccount.ts', {
      '@tanstack/react-query': { useQueryClient: () => ({}), useMutation: (options: any) => { mutation = options; return { isPending: false, mutate() {} }; } },
      './api': {}, './generalAccountOpen': {},
      './TradingAccountContext': { useTradingAccount: () => ({ selectAccount() {} }) },
    });
    const Panel = h.load('src/components/tradingAccount/AccountSetupPanel.tsx', {
      '../../features/tradingAccount/useOpenGeneralAccount': useOpen,
      '../common/CTAButton': { default: 'CTAButton', __esModule: true },
    }).default;
    const renderer = h.render(React.createElement(Panel, { message: '계정을 열어주세요.', onOpened() {} }));
    act(() => mutation.onError(error('PRIVATE_UNKNOWN_CODE')));
    const text = JSON.stringify(renderer.toJSON());
    assert.match(text, /잠시 후 다시 시도/);
    assert.doesNotMatch(text, /PRIVATE_UNKNOWN_CODE|JWT_ACCESS_SECRET|private.invalid|req-private|wallet_write|184927/);
    act(() => renderer.unmount());
  });
});
