import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createChartHarness,
  elements,
} from '../../components/charts/chartIntegrationHarness.cjs';

test('Android slider: installed RNGH receiver handles taps, horizontal drag, edges and cancellation', () => {
  const h = createChartHarness();
  const changes: number[] = [];
  const slider = h.component('../../screens/order/QuantityRatioSlider.tsx', {
    value: 0,
    disabled: false,
    onChange: (ratio: number) => changes.push(ratio),
  });
  const control = () => elements(slider.render(), 'View')[0];
  const beforeLayout = h.attach(slider.render().props.gesture);
  beforeLayout.state(beforeLayout.handlers[0], 2, 4, { x: 50 });
  assert.deepEqual(changes, [], 'unmeasured track cannot invent a percentage');
  control().props.onLayout({ nativeEvent: { layout: { width: 220 } } });
  const events = h.attach(slider.render().props.gesture);
  const [pan, tap] = events.handlers;
  assert.equal(pan.config.activeOffsetXStart, -4);
  assert.equal(pan.config.failOffsetYStart, -8);
  events.state(tap, 0, 2, { x: 60 });
  events.state(tap, 2, 4, { x: 60 });
  events.state(tap, 4, 5, { x: 60 });
  assert.deepEqual(changes, [0.25]);
  events.state(pan, 0, 2, { x: 10 });
  events.state(pan, 2, 4, { x: 110 });
  events.update(pan, { x: 144 });
  events.update(pan, { x: -50 });
  events.update(pan, { x: 260 });
  events.state(pan, 4, 3, { x: 50 });
  assert.deepEqual(changes, [0.25, 0.5, 0.67, 0, 1]);
  events.state(tap, 0, 2, { x: 50 });
  events.state(tap, 2, 1, { x: 50 });
  assert.equal(
    changes.length,
    5,
    'failed tap/vertical scroll does not change quantity',
  );
  slider.props = { ...slider.props, value: 0.5 };
  assert.equal(control().props.accessibilityValue.now, 50);
  control().props.onAccessibilityAction({
    nativeEvent: { actionName: 'increment' },
  });
  control().props.onAccessibilityAction({
    nativeEvent: { actionName: 'decrement' },
  });
  assert.deepEqual(changes.slice(-2), [0.51, 0.49]);
  slider.props = { ...slider.props, value: 1 };
  control().props.onAccessibilityAction({
    nativeEvent: { actionName: 'increment' },
  });
  slider.props = { ...slider.props, value: 0 };
  control().props.onAccessibilityAction({
    nativeEvent: { actionName: 'decrement' },
  });
  assert.deepEqual(changes.slice(-2), [1, 0]);
  slider.props = { ...slider.props, disabled: true };
  control();
  // Even an event queued before pending began must consult current props.
  events.update(pan, { x: 50 });
  control().props.onAccessibilityAction({
    nativeEvent: { actionName: 'increment' },
  });
  assert.equal(changes.length, 9);
  assert.equal(control().props.accessibilityState.disabled, true);
  assert.equal(
    h.attach(slider.render().props.gesture).handlers[0].config.enabled,
    false,
  );
});
