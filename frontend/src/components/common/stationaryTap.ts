/**
 * A selection control's tap, judged from the touch's own native coordinates
 * (2026-11-11, 홈 HOT 카테고리).
 *
 * On the user's Android device (Fabric, a native-stack screen, Home's
 * ScrollView) a press on Home showed its pressed state but never called
 * `onPress` — for the HOT tabs and for 자세히 보기 alike — while the page did
 * not move (no scroll took the touch) and nothing remounted. What remains in
 * between is Pressability's own gate: it keeps a press only while the touch
 * stays inside the rectangle `measure()` reads from the shadow tree (plus
 * 20–30dp), and on new-architecture Android that rectangle can disagree with
 * where the view is drawn (react-native-screens #2219: onPressIn/onPressOut
 * fire, onPress does not; react-native PR #51835: Pressability measures stale
 * shadow-tree layout). A finger that never moved is then "outside" and the
 * release activates nothing.
 *
 * A reversible choice (a segment) does not need that rectangle: the touch
 * that started on it, ended (not cancelled, the native ScrollView did not take
 * it), with one finger and within a few dp of where it started, is a tap on
 * it. Both page positions come from the same native event stream, so no
 * shadow-tree measurement is involved. Pressability's `onPress` still selects
 * (keyboard, screen readers, the web), and one gesture selects once.
 *
 * Never for commands (orders, transfers): those keep Pressability's
 * slide-away-to-cancel and its blocking rules.
 */

/** dp a stationary tap may wander; Android's ScrollView takes a touch after 8dp vertically. */
export const STATIONARY_TAP_SLOP = 10;
/** Pressability's onPress right after a touch end it already answered belongs to that gesture. */
export const PRESS_AFTER_TOUCH_MS = 700;

// RN types a touch identifier as a string; Android sends a number.
type TouchId = number | string;
type TouchPoint = { identifier?: TouchId; pageX?: number; pageY?: number };
export type TapTouchEvent = {
  identifier?: TouchId;
  pageX?: number;
  pageY?: number;
  touches?: readonly TouchPoint[];
  changedTouches?: readonly TouchPoint[];
};

type Gesture<K> = {
  key: K;
  id: TouchId | undefined;
  x: number;
  y: number;
  valid: boolean;
  /** Selected by this gesture already (by onPress or by its touch end). */
  committed: boolean;
  committedAt: number;
  ended: boolean;
};

const point = (event: TapTouchEvent, id: TouchId | undefined): { identifier?: TouchId; x: number; y: number } | null => {
  const changed = event.changedTouches?.find((touch) => touch.identifier === id) ?? event.changedTouches?.[0];
  const source = changed ?? event;
  return typeof source.pageX === 'number' && typeof source.pageY === 'number'
    ? { identifier: source.identifier, x: source.pageX, y: source.pageY }
    : null;
};

/**
 * One control's tracker. `start/move/end/cancel` follow its touch events;
 * `press` wraps Pressability's onPress. `end` and `press` return whether this
 * call should select (each gesture selects at most once).
 */
export function createStationaryTap<K>(now: () => number = () => Date.now()) {
  let gesture: Gesture<K> | null = null;
  const moved = (event: TapTouchEvent) => {
    if (!gesture) return true;
    const at = point(event, gesture.id);
    return !at || Math.hypot(at.x - gesture.x, at.y - gesture.y) > STATIONARY_TAP_SLOP;
  };
  return {
    start(key: K, event: TapTouchEvent) {
      const at = point(event, event.identifier ?? event.changedTouches?.[0]?.identifier);
      const fingers = event.touches?.length ?? 1;
      gesture = at ? { key, id: at.identifier ?? event.identifier, x: at.x, y: at.y,
        valid: fingers <= 1, committed: false, committedAt: 0, ended: false } : null;
    },
    move(event: TapTouchEvent) {
      if (gesture && !gesture.ended && moved(event)) gesture.valid = false;
      if (gesture && (event.touches?.length ?? 1) > 1) gesture.valid = false;
    },
    /** The finger lifted: select here unless Pressability already did, or it was not a stationary tap. */
    end(event: TapTouchEvent): K | null {
      const current = gesture;
      if (!current || current.ended) return null;
      current.ended = true;
      const lifted = (event.touches?.length ?? 0) === 0;
      if (current.committed || !current.valid || !lifted || moved(event)) {
        // Selected by onPress already, or not a tap: this gesture is over.
        gesture = null;
        return null;
      }
      current.committed = true;
      current.committedAt = now();
      return current.key;
    },
    cancel() {
      gesture = null;
    },
    /** Pressability's onPress for `key`: false when this gesture's touch end has just selected it. */
    press(key: K): boolean {
      const current = gesture;
      if (current && current.committed && current.ended && current.key === key && now() - current.committedAt < PRESS_AFTER_TOUCH_MS) {
        gesture = null;
        return false;
      }
      if (current && !current.ended && current.key === key) {
        // The usual order on native: onPress (responder release) before onTouchEnd.
        current.committed = true;
        current.committedAt = now();
      } else {
        gesture = null;
      }
      return true;
    },
    /** For tests and diagnostics. */
    get pending() {
      return gesture ? { key: gesture.key, valid: gesture.valid, committed: gesture.committed, ended: gesture.ended } : null;
    },
  };
}

export type StationaryTap<K> = ReturnType<typeof createStationaryTap<K>>;
