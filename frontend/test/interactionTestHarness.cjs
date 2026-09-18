// Real components + React reconciliation. Only native measurement, hosts and
// animation clocks are controlled; interactions never wait for this clock.
const React = require('react');
const { create, act } = require('react-test-renderer');
const { resolve } = require('node:path');
const { load } = require('./ledgerTestHarness.cjs');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const flatten = (style) => Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : style || {};

function interactionHarness(platform = 'android') {
  const h = { animations: [], measures: [], delayedMeasure: false, bounds: [0, 0, 200, 60, 100, 200] };
  class Value {
    constructor(value) { this.value = value; this.listeners = new Map(); this.listenerId = 0; }
    setValue(value) {
      this.stopAnimation(); this.value = value;
      this.listeners.forEach((callback) => callback({ value }));
    }
    addListener(callback) { const id = String(++this.listenerId); this.listeners.set(id, callback); return id; }
    removeListener(id) { this.listeners.delete(id); }
    stopAnimation() { this.animation?.stop(); }
    interpolate(config) { return { value: this, ...config }; }
  }
  function Pressable({ children, style, onPressIn, onPressOut, onPress, disabled, ...props }) {
    const [pressed, setPressed] = React.useState(false);
    return React.createElement('Pressable', {
      ...props, disabled, style: typeof style === 'function' ? style({ pressed }) : style,
      onPress: disabled ? undefined : onPress,
      onPressIn: (event) => { if (!disabled) { setPressed(true); onPressIn?.(event); } },
      onPressOut: (event) => { if (!disabled) { setPressed(false); onPressOut?.(event); } },
    }, typeof children === 'function' ? children({ pressed }) : children);
  }
  h.native = {
    Pressable, View: 'View', Text: 'Text', Modal: 'Modal', ScrollView: 'ScrollView', ActivityIndicator: 'ActivityIndicator',
    StyleSheet: { create: (s) => s, flatten, absoluteFillObject: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 } },
    Platform: { OS: platform }, Easing: { out: (fn) => fn, quad: (n) => n * n },
    processColor: (color) => {
      if (!color || !color.startsWith('#')) return null;
      const hex = color.slice(1);
      return (0xff000000 | parseInt(hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex, 16)) >>> 0;
    },
    useWindowDimensions: () => h.dimensions,
    Animated: { Value, View: 'AnimatedView', timing: (value, options) => {
      const animation = {
        value, options,
        start: (callback) => { value.stopAnimation(); value.animation = animation; animation.callback = callback; h.animations.push(animation); },
        stop: () => { value.animation = null; animation.callback?.({ finished: false }); },
        finish: () => { if (value.animation !== animation) return; value.animation = null; value.setValue(options.toValue); animation.callback?.({ finished: true }); },
      };
      return animation;
    } },
  };
  h.dimensions = { width: 320, height: 568, fontScale: 2 };
  h.insets = { top: 24, bottom: 34 };
  h.load = (file, mocks = {}) => load(resolve(file), { 'react-native': h.native, ...mocks });
  h.ActionPressable = h.load('src/components/common/ActionPressable.tsx').default;
  h.render = (element) => {
    let renderer;
    act(() => { renderer = create(element, { createNodeMock: (node) => node.type === 'Pressable' ? {
      measure: (callback) => { if (h.delayedMeasure) h.measures.push(callback); else callback(...h.bounds); },
    } : null }); });
    return renderer;
  };
  h.finish = () => act(() => {
    for (let index = 0; index < h.animations.length; index++) {
      h.animations[index].finish();
    }
  });
  return h;
}

module.exports = { interactionHarness, flatten, React, act };
