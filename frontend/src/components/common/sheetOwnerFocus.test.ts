import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act } = require('../../../test/interactionTestHarness.cjs');
// The context the app's screens provide (@react-navigation/native re-exports core's).
const { NavigationContext } = require('@react-navigation/core');

/** A screen's navigation as far as focus goes: blur/focus as another tab or a pushed screen covers it. */
function screenNavigation() {
  const listeners = { focus: new Set<() => void>(), blur: new Set<() => void>() };
  let focused = true;
  return {
    isFocused: () => focused,
    addListener: (type: 'focus' | 'blur', listener: () => void) => { listeners[type].add(listener); return () => listeners[type].delete(listener); },
    set: (next: boolean) => act(() => { focused = next; listeners[next ? 'focus' : 'blur'].forEach((listener) => listener()); }),
  };
}

function setup() {
  const h = interactionHarness();
  const backListeners: Array<() => boolean> = [];
  h.native.BackHandler = { addEventListener: (_: string, listener: () => boolean) => {
    backListeners.push(listener);
    return { remove: () => backListeners.splice(backListeners.indexOf(listener), 1) };
  } };
  h.native.Keyboard = { dismiss: () => {} };
  const mocks = { '../../hooks/useKeyboardCover': { useKeyboardCover: () => 0 } };
  const host = h.load('src/components/common/ScreenSheetHost.tsx', mocks);
  const Sheet = h.load('src/components/common/InlineBottomSheet.tsx', { ...mocks, './ScreenSheetHost': host }).default;
  const navigation = screenNavigation();
  const counter = { set: (_: number) => {} };
  // State that lives inside the sheet (a form, a command in flight) must survive being covered.
  function Form() {
    const [value, setValue] = React.useState(0);
    counter.set = (next: number) => act(() => setValue(next));
    return React.createElement('Text', { testID: 'form-value' }, String(value));
  }
  function Screen() {
    return React.createElement(host.SheetPortal, null,
      React.createElement(Sheet, { visible: true, onClose: () => {}, testID: 'sheet', title: '주문방식' }, React.createElement(Form)));
  }
  const renderer = h.render(React.createElement(host.ScreenSheetHost, null,
    React.createElement(NavigationContext.Provider, { value: navigation }, React.createElement(Screen))));
  const root = () => renderer.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === 'sheet')[0];
  const hidden = () => [root().props.style].flat(Infinity).some((style: any) => style?.display === 'none');
  return { navigation, root, hidden, backListeners, counter, value: () => renderer.root.findAll((node: any) => node.props.testID === 'form-value')[0].props.children };
}

describe('a sheet follows its own screen being on screen', () => {
  it('covered by another tab or screen: drawn nowhere, takes no touch and no Back; on return the same sheet and state', () => {
    const s = setup();
    assert.equal(s.hidden(), false);
    assert.equal(s.root().props.pointerEvents, 'auto');
    assert.equal(s.backListeners.length, 1);
    s.counter.set(3);
    s.navigation.set(false);
    assert.equal(s.hidden(), true, 'not drawn over the screen that covers its own');
    assert.equal(s.root().props.pointerEvents, 'none');
    assert.equal(s.backListeners.length, 0, 'Back goes to the screen on top');
    assert.equal(s.value(), '3', 'still mounted: the form keeps its state');
    s.navigation.set(true);
    assert.equal(s.hidden(), false);
    assert.equal(s.root().props.pointerEvents, 'auto');
    assert.equal(s.backListeners.length, 1);
    assert.equal(s.value(), '3');
  });
});
