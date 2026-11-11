import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PRESS_AFTER_TOUCH_MS, STATIONARY_TAP_SLOP, createStationaryTap } from './stationaryTap.ts';

const at = (pageX: number, pageY: number, id = 3) => ({ identifier: id, pageX, pageY, touches: [{ identifier: id, pageX, pageY }], changedTouches: [{ identifier: id, pageX, pageY }] });
const lifted = (pageX: number, pageY: number, id = 3) => ({ identifier: id, pageX, pageY, touches: [], changedTouches: [{ identifier: id, pageX, pageY }] });

describe('stationary tap (selection controls)', () => {
  it('Pressable selects first (native order): the touch end adds nothing — one gesture, one selection', () => {
    const tap = createStationaryTap<string>(() => 1000);
    tap.start('crypto', at(250, 1330));
    assert.equal(tap.press('crypto'), true);
    assert.equal(tap.end(lifted(251, 1331)), null);
    assert.equal(tap.pending, null, 'nothing left over for a later keyboard press');
  });

  it('Pressable showed the press but never selected (the HOT report): the stationary touch end selects', () => {
    let now = 1000;
    const tap = createStationaryTap<string>(() => now);
    tap.start('crypto', at(250, 1330));
    tap.move(at(252, 1328));
    tap.move(at(249, 1333));
    assert.equal(tap.end(lifted(251, 1332)), 'crypto');
    // Should the press still arrive for this gesture (the web's order), it is the same tap.
    now += 50;
    assert.equal(tap.press('crypto'), false);
    // A keyboard or screen-reader activation later is its own press.
    now += PRESS_AFTER_TOUCH_MS;
    assert.equal(tap.press('crypto'), true);
  });

  it('a press arriving after its touch end is not counted twice, but a later one, or another segment, is', () => {
    let now = 1000;
    const tap = createStationaryTap<string>(() => now);
    tap.start('a', at(10, 10));
    assert.equal(tap.end(lifted(10, 10)), 'a');
    now += PRESS_AFTER_TOUCH_MS + 1;
    assert.equal(tap.press('a'), true, 'too late to be that gesture');
    tap.start('a', at(10, 10));
    assert.equal(tap.end(lifted(10, 10)), 'a');
    assert.equal(tap.press('b'), true, 'another segment');
  });

  it('a scroll (the native view takes the touch), a slide or a second finger selects nothing', () => {
    const tap = createStationaryTap<string>(() => 1000);
    tap.start('a', at(10, 10));
    tap.cancel();
    assert.equal(tap.end(lifted(10, 10)), null, 'cancelled by the scroll view');
    tap.start('a', at(10, 10));
    tap.move(at(10 + STATIONARY_TAP_SLOP + 1, 10));
    assert.equal(tap.end(lifted(10, 10)), null, 'slid away and back');
    tap.start('a', at(10, 10));
    assert.equal(tap.end(lifted(10 + STATIONARY_TAP_SLOP + 1, 10)), null, 'lifted somewhere else');
    tap.start('a', at(10, 10));
    tap.move({ ...at(10, 10), touches: [{ identifier: 3, pageX: 10, pageY: 10 }, { identifier: 4, pageX: 200, pageY: 300 }] });
    assert.equal(tap.end(lifted(10, 10)), null, 'a second finger');
    tap.start('a', { ...at(10, 10), touches: [{ identifier: 3, pageX: 10, pageY: 10 }, { identifier: 4, pageX: 200, pageY: 300 }] });
    assert.equal(tap.end(lifted(10, 10)), null, 'started with two fingers');
    tap.start('a', at(10, 10));
    assert.equal(tap.end({ ...lifted(10, 10), touches: [{ identifier: 4, pageX: 200, pageY: 300 }] }), null, 'another finger still down');
    assert.equal(tap.end(lifted(10, 10)), null, 'an end without a start');
  });

  it('within the slop it is still a tap; a press Pressable makes after a short slide is respected', () => {
    const tap = createStationaryTap<string>(() => 1000);
    tap.start('a', at(10, 10));
    tap.move(at(10 + STATIONARY_TAP_SLOP, 10));
    assert.equal(tap.end(lifted(10, 10 + STATIONARY_TAP_SLOP / 2)), 'a');
    tap.start('a', at(10, 10));
    tap.move(at(40, 10));
    assert.equal(tap.press('a'), true, 'Pressable judged it a press (inside its own rectangle)');
    assert.equal(tap.end(lifted(40, 10)), null);
  });

  it('keyboard, screen reader and mouse presses (no touch) always select', () => {
    const tap = createStationaryTap<string>(() => 1000);
    assert.equal(tap.press('a'), true);
    assert.equal(tap.press('a'), true);
  });
});
