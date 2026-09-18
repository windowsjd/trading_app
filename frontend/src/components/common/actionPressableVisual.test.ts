import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
// Use the installed web renderer AND Animated implementation. An identity
// createAnimatedComponent mock hid the original callback-style regression.
const web = require('react-native-web');
const { load } = require('../../../test/ledgerTestHarness.cjs');
const { interactionHarness, flatten, act } = require('../../../test/interactionTestHarness.cjs');
const ActionPressable = load(resolve('src/components/common/ActionPressable.tsx'), {
  'react-native': web,
}).default;

function rootMarkup(Component: unknown, style: unknown, pressed = false) {
  const markup = renderToStaticMarkup(React.createElement(Component, {
    style, onPress: () => {}, testOnly_pressed: pressed,
  }, React.createElement(web.Text, null, '실행')));
  return markup.slice(0, markup.indexOf('>'));
}

function rootStyle(Component: unknown, style: unknown, pressed = false) {
  const root = rootMarkup(Component, style, pressed);
  return Object.fromEntries(
    (root.match(/style="([^"]*)"/)?.[1] ?? '')
      .split(';').filter(Boolean).map((entry: string) => {
        const colon = entry.indexOf(':');
        return [entry.slice(0, colon), entry.slice(colon + 1)];
      }),
  );
}

describe('ActionPressable real React Native Web visual contract', () => {
  const fixtures = {
    CTA: { backgroundColor: '#111', borderRadius: 12, paddingVertical: 14 },
    account: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#e0e0e0', borderRadius: 12 },
    unselected: [
      { backgroundColor: '#fff', borderWidth: 1, borderColor: '#ddd' },
      false, null, undefined,
    ],
    selected: [
      { backgroundColor: '#fff', borderWidth: 1, borderColor: '#ddd' },
      false, null, { backgroundColor: '#111', borderColor: '#111' },
    ],
    layout: {
      backgroundColor: '#fff', borderWidth: 2, borderColor: '#123456',
      flex: 1, margin: 7, padding: 11, borderRadius: 14,
      shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 4, elevation: 4,
      transform: [{ translateX: 3 }, { rotate: '2deg' }],
    },
    stringTransform: { backgroundColor: '#111', transform: 'translateX(3px) rotate(2deg)' },
    callback: ({ pressed }: { pressed: boolean }) => [
      { padding: 14, borderWidth: 1, borderRadius: 12, borderColor: '#ddd' },
      { backgroundColor: pressed ? '#444' : '#111', opacity: pressed ? 0.8 : 1 },
      pressed && { borderColor: '#111' },
    ],
  };

  it('keeps classes compiled by StyleSheet.create on the actual web root', () => {
    const styles = web.StyleSheet.create({
      base: { ...fixtures.account },
      selected: { backgroundColor: '#111', borderColor: '#111' },
    });
    for (const active of [false, true]) {
      const style = [styles.base, null, active && styles.selected];
      const classes = (component: unknown) =>
        new Set((rootMarkup(component, style).match(/class="([^"]*)"/)?.[1] ?? '').split(' '));
      const expected = classes(web.Pressable);
      const actual = classes(ActionPressable);
      for (const name of expected) assert.ok(actual.has(name), `missing compiled root style ${name}`);
    }
  });

  for (const [name, style] of Object.entries(fixtures)) {
    for (const pressed of [false, true]) {
      it(`${name}, pressed=${pressed}: keeps every caller visual on the root DOM element`, () => {
        const expected = rootStyle(web.Pressable, style, pressed);
        const actual = rootStyle(ActionPressable, style, pressed);
        assert.ok(Object.keys(expected).length > 0);
        for (const [key, value] of Object.entries(expected)) {
          if (key === 'transform') {
            assert.ok(actual[key]?.startsWith(value), 'caller transforms stay in order');
          } else {
            assert.equal(actual[key], value, `root ${key}`);
          }
        }
      });
    }

    for (const platform of ['android', 'ios', 'web']) {
      it(`${platform}, ${name}: preserves visuals throughout press, release and cancel`, (t) => {
        const h = interactionHarness(platform);
        const renderer = h.render(React.createElement(h.ActionPressable, { style, onPress: () => {} }));
        t.after(() => act(() => renderer.unmount()));
        const button = () => renderer.root.findByType('Pressable');
        const event = { nativeEvent: { pageX: 130, pageY: 215 } };
        const check = (pressed: boolean, scale: number) => {
          const expected = flatten(typeof style === 'function' ? style({ pressed }) : style);
          const actual = flatten(button().props.style);
          for (const [key, value] of Object.entries(expected)) {
            if (key !== 'transform') assert.deepEqual(actual[key], value, key);
          }
          assert.deepEqual(actual.transform, typeof expected.transform === 'string'
            ? `${expected.transform} scale(${scale})`
            : [...(expected.transform ?? []), { scale }]);
        };
        check(false, 1);
        act(() => button().props.onPressIn(event));
        check(true, 1);
        act(() => h.animations.find((a: any) => a.options.toValue === 0.99).finish());
        check(true, 0.99);
        // Pressable also sends pressOut when a gesture leaves/cancels; no action.
        act(() => button().props.onPressOut(event));
        check(false, 0.99);
        h.finish();
        check(false, 1);
      });
    }
  }
});
