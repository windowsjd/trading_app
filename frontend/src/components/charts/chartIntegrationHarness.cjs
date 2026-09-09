// Node-only integration harness; no native view system is available here.
// Execute production TSX and the INSTALLED RNGH builders/JS event receiver.
// Host views and React hook scheduling are deterministic stand-ins. Native
// recognition/interception must still be verified on a device (see chart docs).
const { readFileSync, existsSync } = require('node:fs');
const { resolve, dirname, extname } = require('node:path');
const ts = require('typescript');
const React = require('react');

function createChartHarness(platform = 'android') {
  const cache = new Map();
  let current;
  const windowEvents = new Map();
  const window = {
    addEventListener: (name, fn) => windowEvents.set(name, fn),
    removeEventListener: (name) => windowEvents.delete(name),
  };
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const useMemo = (factory, deps) => {
    const index = current.index++;
    const old = current.slots[index];
    if (!old || !same(old.deps, deps)) current.slots[index] = { value: factory(), deps };
    return current.slots[index].value;
  };
  const react = {
    ...React,
    useMemo,
    useCallback: (fn, deps) => useMemo(() => fn, deps),
    useRef: (value) => useMemo(() => ({ current: value }), []),
    useId: () => useMemo(() => 'test-chart', []),
    useState(initial) {
      const instance = current;
      const index = instance.index++;
      if (!(index in instance.slots)) instance.slots[index] = typeof initial === 'function' ? initial() : initial;
      return [instance.slots[index], (update) => {
        instance.slots[index] = typeof update === 'function' ? update(instance.slots[index]) : update;
      }];
    },
    useEffect(effect, deps) {
      const instance = current;
      const index = instance.index++;
      const old = instance.slots[index];
      if (!old || !same(old.deps, deps)) {
        instance.effects.push(() => {
          old?.cleanup?.();
          instance.slots[index] = { deps, cleanup: effect() };
        });
      }
    },
  };
  const dimensions = { width: 360, height: 800 };
  const native = {
    View: 'View', Text: 'Text', Pressable: 'Pressable',
    StyleSheet: { create: (styles) => styles },
    Platform: { OS: platform },
    useWindowDimensions: () => dimensions,
  };
  const rnghRoot = resolve(dirname(require.resolve('react-native-gesture-handler/package.json')), 'src');
  function load(file) {
    file = resolve(file);
    if (!extname(file)) file = [file + '.ts', file + '.tsx', file + '.js'].find(existsSync);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    const localRequire = (name) => {
      if (name === 'react') return react;
      if (name === 'react-native') return native;
      if (name === 'react-native-svg') return {
        __esModule: true, default: 'svg', ClipPath: 'clipPath', Defs: 'defs',
        G: 'g', Line: 'line', Rect: 'rect', Text: 'text', Circle: 'circle', Path: 'path',
      };
      if (name === 'react-native-gesture-handler') return {
        GestureDetector: 'GestureDetector',
        Gesture: {
          Pan: () => new (load(resolve(rnghRoot, 'handlers/gestures/panGesture')).PanGesture)(),
          Pinch: () => new (load(resolve(rnghRoot, 'handlers/gestures/pinchGesture')).PinchGesture)(),
          LongPress: () => new (load(resolve(rnghRoot, 'handlers/gestures/longPressGesture')).LongPressGesture)(),
          Race: (...gestures) => new (load(resolve(rnghRoot, 'handlers/gestures/gestureComposition')).ComposedGesture)(...gestures),
          Simultaneous: (...gestures) => new (load(resolve(rnghRoot, 'handlers/gestures/gestureComposition')).SimultaneousGesture)(...gestures),
        },
      };
      if (name.startsWith('.')) return load(resolve(dirname(file), name));
      return require(name);
    };
    const code = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: file,
    }).outputText;
    new Function('require', 'module', 'exports', 'window', '__DEV__', code)(localRequire, module, module.exports, window, false);
    return module.exports;
  }
  function component(file, props) {
    const instance = { slots: [], index: 0, effects: [] };
    const Component = load(resolve(__dirname, file)).default;
    return {
      props,
      render() {
        current = instance;
        instance.index = 0;
        return Component(this.props);
      },
      flushEffects() { instance.effects.splice(0).forEach((effect) => effect()); },
      unmount() { instance.slots.forEach((slot) => slot?.cleanup?.()); },
    };
  }
  function attach(gesture) {
    gesture.initialize();
    gesture.prepare();
    const registry = load(resolve(rnghRoot, 'handlers/handlersRegistry'));
    const handlers = gesture.toGestureArray();
    handlers.forEach((handler) => registry.registerHandler(handler.handlerTag, handler));
    const receiver = load(resolve(rnghRoot, 'handlers/gestures/eventReceiver')).onGestureHandlerEvent;
    return {
      handlers,
      state(handler, oldState, state, fields = {}) {
        receiver({ handlerTag: handler.handlerTag, oldState, state, numberOfPointers: 1, x: 100, y: 100, translationX: 0, ...fields });
      },
      update(handler, fields) { receiver({ handlerTag: handler.handlerTag, ...fields }); },
    };
  }
  return { component, attach, dimensions, windowEvents };
}

function elements(node, type) {
  if (Array.isArray(node)) return node.flatMap((child) => elements(child, type));
  if (!React.isValidElement(node)) return [];
  return [...(type === undefined || node.type === type ? [node] : []), ...elements(node.props.children, type)];
}

module.exports = { createChartHarness, elements };
