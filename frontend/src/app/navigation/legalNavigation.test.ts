import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act } = require('../../../test/interactionTestHarness.cjs');
const {
  BaseNavigationContainer, StackRouter, createNavigationContainerRef,
  createNavigatorFactory, useNavigationBuilder,
} = require('@react-navigation/core');

// Run the actual stack declarations and document screen on Navigation's real
// core. Native transitions and unrelated screens are the only boundaries.
function app(stack: string, origin: string) {
  const h = interactionHarness();
  const ref = createNavigationContainerRef();
  let descriptors: any;
  let mounts = 0;
  let draft: string;
  let setDraft: (value: string) => void;
  function Origin({ route }: any) {
    const [value, setValue] = React.useState('');
    React.useEffect(() => { if (route.name === origin) mounts += 1; }, [route.name]);
    if (route.name === origin) { draft = value; setDraft = setValue; }
    return null;
  }
  const createStack = createNavigatorFactory((props: any) => {
    const built = useNavigationBuilder(StackRouter, props);
    descriptors = built.descriptors;
    return React.createElement(built.NavigationContent, null, built.state.routes.map((route: any) =>
      React.createElement(React.Fragment, { key: route.key }, built.descriptors[route.key].render())));
  });
  const mocks: Record<string, unknown> = {
    '@react-navigation/native-stack': { createNativeStackNavigator: () => createStack() },
    './stackScreenLayout': { stackScreenLayout: ({ children }: any) => children },
    '../../components/navigation/MainTabHeaderTitle': { mainTabHeaderTitle: () => undefined },
  };
  const path = `src/app/navigation/${stack}.tsx`;
  for (const [, name, source] of readFileSync(resolve(path), 'utf8').matchAll(/import (\w+) from '([^']+)';/g)) {
    if (name !== 'LegalDocumentScreen' && (source.includes('/screens/') || source === './RecordStack')) {
      mocks[source] = { __esModule: true, default: Origin };
    }
  }
  const Screen = h.load(path, mocks).default;
  const renderer = h.render(React.createElement(BaseNavigationContainer, { ref }, React.createElement(Screen)));
  act(() => ref.navigate(origin));
  act(() => setDraft('retained input and choices'));
  const originalKey = ref.getRootState().routes[ref.getRootState().index].key;
  return {
    ref, renderer, originalKey,
    retained: () => ({ draft, mounts }),
    options: () => descriptors[ref.getRootState().routes[ref.getRootState().index].key].options,
    headerBack: () => descriptors[ref.getRootState().routes[ref.getRootState().index].key].navigation.goBack(),
  };
}

describe('read-only legal documents on each existing stack', () => {
  for (const [stack, origin] of [['AuthStack', 'Signup'], ['MyStack', 'Settings'], ['ModesStack', 'Modes']]) {
    for (const document of ['terms', 'privacy']) {
      it(`${stack}: ${document} pushes over ${origin}, and every back path keeps the caller mounted`, (t) => {
        const a = app(stack, origin);
        t.after(() => act(() => a.renderer.unmount()));
        for (const back of ['button', 'header', 'system']) {
          act(() => a.ref.navigate('LegalDocument', { document }));
          const state = a.ref.getRootState();
          assert.equal(state.routes[state.index].name, 'LegalDocument');
          assert.equal(state.routes[state.index - 1].key, a.originalKey);
          assert.equal(a.options().title, document === 'privacy' ? '개인정보처리방침' : '이용약관');
          assert.equal(a.options().headerShown !== false, true);
          assert.equal(a.ref.canGoBack(), true);
          assert.equal(a.renderer.root.findAll((n: any) => typeof n.type === 'string' && n.props.testID === `legal-document-${document}`).length, 1);
          act(() => {
            if (back === 'button') a.renderer.root.findAll((n: any) => typeof n.type === 'string' && n.props.testID === 'legal-document-back')[0].props.onPress();
            else if (back === 'header') a.headerBack();
            else a.ref.goBack();
          });
          const returned = a.ref.getRootState();
          assert.equal(returned.routes[returned.index].key, a.originalKey);
          assert.deepEqual(a.retained(), { draft: 'retained input and choices', mounts: 1 });
          assert.equal(a.renderer.root.findAll((n: any) => typeof n.type === 'string' && n.props.testID === `legal-document-${document}`).length, 0);
        }
      });
    }
  }
});
