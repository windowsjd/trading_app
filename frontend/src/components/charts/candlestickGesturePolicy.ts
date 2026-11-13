// Pure gesture policy shared by the native and web chart adapters: when a drag
// belongs to the chart, how a tap and a long press drive the crosshair, and how
// wheel input maps to zoom. Keeping these decisions here means both platforms follow
// the same rules and the rules are unit-testable without rendering.

/** Two fingers moving together this far (mostly vertically) scale prices. */
export const HORIZONTAL_PAN_SLOP_PX = 10;
/** Hold this long without moving to enter crosshair mode on touch screens. */
export const LONG_PRESS_MS = 300;
/**
 * A one-finger drag that starts on the chart is the chart's after this many
 * pixels in ANY direction (2026-11-13): less than the platforms' own scroll
 * slop (Android ~8 dp, iOS ~10 pt), so the screen does not scroll under a drag
 * that began on the chart, while a drag that starts elsewhere scrolls as
 * before. Web pointers use the same distance.
 */
export const CHART_PAN_ACTIVATION_PX = 4;
/** A tap: lifted sooner than the long press, having moved no more than this. */
export const TAP_SLOP_PX = 8;
/**
 * While prices fit the visible candles automatically, a drag starts moving
 * prices too only once it has travelled this far vertically and is not
 * nearly horizontal — browsing history sideways keeps the automatic fit.
 * After a price-axis change (or once engaged) every drag moves both ways.
 */
export const VERTICAL_PAN_ENGAGE_PX = 12;

export function shouldEngageVerticalPan(dx: number, dy: number): boolean {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
  return Math.abs(dy) >= VERTICAL_PAN_ENGAGE_PX && Math.abs(dy) >= Math.abs(dx) * 0.5;
}

/**
 * What the pointer or finger says about the crosshair (2026-11-13):
 * - `hover`  a mouse over the chart (web) — follows it, never over a pinned one;
 * - `leave`  the mouse left / a drag began — clears only a hovering one;
 * - `scrub`  a long press moving — moves even a pinned one;
 * - `release` the long press lifted — it stays (pinned);
 * - `tap`    a simple tap or click — pins one there, or clears the pinned one shown.
 */
export type CrosshairInput =
  | { type: 'hover' | 'scrub' | 'tap'; point: CrosshairPoint }
  | { type: 'leave' | 'release' };

export type CrosshairMode = 'hover' | 'scrub' | 'pinned';
export type CrosshairState<A> = { anchor: A; mode: CrosshairMode } | null;

/**
 * The crosshair after an input. `anchorOf` turns a point into what the chart
 * stores (a candle and a price, so a pan or zoom never makes it point at
 * another date or price) and may refuse it (null). `shown`: the current one is
 * drawn now (a pinned one panned out of view is not, so a tap pins a new one).
 */
export function reduceCrosshair<A>(
  current: CrosshairState<A>,
  input: CrosshairInput,
  anchorOf: (point: CrosshairPoint) => A | null,
  shown: boolean,
): CrosshairState<A> {
  const at = (point: CrosshairPoint, mode: CrosshairMode): CrosshairState<A> => {
    const anchor = anchorOf(point);
    return anchor === null ? current : { anchor, mode };
  };
  switch (input.type) {
    case 'hover':
      return current?.mode === 'pinned' || current?.mode === 'scrub' ? current : at(input.point, 'hover');
    case 'leave':
      return current?.mode === 'hover' ? null : current;
    case 'scrub':
      return at(input.point, 'scrub');
    case 'release':
      return current?.mode === 'scrub' ? { ...current, mode: 'pinned' } : current;
    case 'tap':
      return current?.mode === 'pinned' && shown ? null : at(input.point, 'pinned');
  }
}

export type WheelIntent = 'zoom' | 'pan';

/**
 * Web wheel policy, applied ONLY to wheel events that land on the chart (the
 * listener is attached to the chart node, so everywhere else the page keeps
 * scrolling untouched):
 *  1. Shift + wheel → chart pan,
 *  2. horizontal input larger than vertical (trackpad swipe) → chart pan,
 *  3. any other vertical wheel → zoom.
 *
 * Ctrl/Cmd + wheel — what browsers report for a trackpad pinch — lands in (3)
 * as well, which is why the adapter always calls `preventDefault()`: the
 * browser's own page zoom must not fire over the chart.
 */
export function classifyWheelIntent(event: {
  deltaX?: number;
  deltaY?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}): WheelIntent {
  if (event.shiftKey) return 'pan';
  const deltaX = event.deltaX ?? 0;
  const deltaY = event.deltaY ?? 0;
  if (Math.abs(deltaX) > Math.abs(deltaY)) return 'pan';
  return 'zoom';
}

/**
 * What the chart does with a wheel event that landed on it:
 *  - `zoom` / `pan`  — handle it (and consume it),
 *  - `consume`       — swallow it WITHOUT touching the viewport,
 *  - `skip`          — not ours; leave the event completely alone.
 *
 * A wheel that arrives DURING a left-button drag is consumed: letting it open
 * a wheel session would have two gestures writing the viewport at once (a
 * second `onGestureStart` replacing the drag's snapshot mid-drag, then two
 * separate ends). Ignoring it must still `preventDefault`, or the page would
 * scroll away under a drag that is very much in progress.
 */
export type WheelHandling = 'zoom' | 'pan' | 'consume' | 'skip';

export function resolveWheelHandling(
  event: {
    deltaX?: number;
    deltaY?: number;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
  },
  state: { dragActive: boolean },
): WheelHandling {
  if (state.dragActive) return 'consume';
  // A no-op wheel neither zooms nor scrolls anything.
  if (!(event.deltaX ?? 0) && !(event.deltaY ?? 0)) return 'skip';
  return classifyWheelIntent(event);
}

/** Wheel delta → zoom factor (scroll up / pinch out = zoom in). */
export function wheelZoomScale(deltaY: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 1;
  return Math.min(Math.max(Math.exp(-deltaY * 0.002), 0.4), 2.5);
}

/** Two-finger distance ratio, bounded so one bad frame cannot explode zoom. */
export function pinchScale(
  currentDistance: number,
  startDistance: number,
): number {
  if (!Number.isFinite(currentDistance) || startDistance <= 0) return 1;
  return Math.min(Math.max(currentDistance / startDistance, 0.2), 5);
}

export type CrosshairPoint = { x: number; y: number };

/**
 * Is a touch still on the chart? Used to end crosshair mode when a long-press
 * scrub leaves the plot. An unknown container size never cancels (returning
 * `true`) — a missing measurement must not break scrubbing.
 */
export function isWithinChartBounds(
  point: CrosshairPoint,
  size: { width: number; height: number },
  slopPx = 0,
): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  const { width, height } = size;
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return true;
  }
  return (
    point.x >= -slopPx &&
    point.x <= width + slopPx &&
    point.y >= -slopPx &&
    point.y <= height + slopPx
  );
}

/** One gesture at a time owns the chart. */
export type ChartGestureType = 'pan' | 'pinch' | 'crosshair' | 'priceScale' | 'priceZoom';
export type ChartGestureOwner = ChartGestureType | 'none';

export type ChartTouch = { id: number; x: number; y: number };
export type TouchPair = readonly [ChartTouch, ChartTouch];

/** A pinch whose spread changes this much more vertically than horizontally
 * (within about 35° of vertical) zooms prices; any other pinch zooms time. */
export const VERTICAL_PINCH_RATIO = 1.4;

/** Lock one intention until lift. Distance change wins over mixed movement: a
 * pinch zooms time (X), or prices (Y) when the fingers spread or close
 * vertically. Y scaling by a drag requires both fingers moving together,
 * predominantly vertically. */
export function classifyTwoFingerGesture(start: TouchPair, current: TouchPair): 'pinch' | 'priceZoom' | 'priceScale' | null {
  if (start.some((touch, index) => touch.id !== current[index].id)) return null;
  const distance = (pair: TouchPair) => Math.hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y);
  const initialDistance = distance(start);
  const ratio = distance(current) / initialDistance;
  if (!Number.isFinite(ratio) || initialDistance < 8 || ratio <= 0) return null;
  if (Math.abs(Math.log(ratio)) >= 0.06) {
    const spread = (axis: 'x' | 'y') =>
      Math.abs(Math.abs(current[1][axis] - current[0][axis]) - Math.abs(start[1][axis] - start[0][axis]));
    return spread('y') > spread('x') * VERTICAL_PINCH_RATIO ? 'priceZoom' : 'pinch';
  }
  const dy0 = current[0].y - start[0].y;
  const dy1 = current[1].y - start[1].y;
  const dy = (dy0 + dy1) / 2;
  const dx = (current[0].x + current[1].x - start[0].x - start[1].x) / 2;
  return dy0 * dy1 > 0 && Math.abs(dy) > HORIZONTAL_PAN_SLOP_PX &&
    Math.abs(dy) > Math.abs(dx) * 1.2 &&
    Math.abs(dy0 - dy1) < Math.max(6, Math.abs(dy) * 0.35)
    ? 'priceScale' : null;
}

export type ChartGestureSession = {
  owner: () => ChartGestureOwner;
  isOwner: (type: ChartGestureType) => boolean;
  isCrosshairActive: () => boolean;
  /** Claim the chart; ignored (false) when another gesture already owns it. */
  begin: (type: ChartGestureType) => boolean;
  /** Explicit hand-off (crosshair → pinch): ends the current owner, then begins. */
  takeOver: (type: ChartGestureType) => boolean;
  /** Release; ignored (false) unless `type` is the current owner. */
  end: (type: ChartGestureType) => boolean;
  /** Long press armed crosshair mode. */
  startCrosshair: (point: CrosshairPoint) => boolean;
  /** Scrub while armed; ignored (false) when crosshair mode is not the owner. */
  moveCrosshair: (point: CrosshairPoint) => boolean;
};

/**
 * Chart gesture lifecycle as a tiny state machine, outside React state because
 * several recognizers read it synchronously mid-gesture.
 *
 * Native allows pinch alongside a race between chart pan and delayed crosshair
 * pan, so more than one recognizer can finalize for a single lift.
 * Routing every start/end through this owner model is what keeps
 * `onGestureStart`/`onGestureEnd` at exactly one call per real gesture: a
 * finalize from a recognizer that never owned the chart changes nothing.
 *
 * It lives here (not in the native adapter) so the rules are unit-tested
 * without rendering gesture-handler.
 */
export function createChartGestureSession(callbacks: {
  onGestureStart: () => void;
  onGestureEnd: () => void;
  onCrosshair: (input: CrosshairInput) => void;
}): ChartGestureSession {
  let owner: ChartGestureOwner = 'none';

  const begin = (type: ChartGestureType): boolean => {
    if (owner !== 'none') return false;
    owner = type;
    callbacks.onGestureStart();
    return true;
  };

  const end = (type: ChartGestureType): boolean => {
    if (owner !== type) return false;
    owner = 'none';
    // Leaving crosshair mode (lift, cancel, a pinch taking over) keeps the
    // crosshair where it was, pinned, exactly once (2026-11-13).
    if (type === 'crosshair') callbacks.onCrosshair({ type: 'release' });
    callbacks.onGestureEnd();
    return true;
  };

  return {
    owner: () => owner,
    isOwner: (type) => owner === type,
    isCrosshairActive: () => owner === 'crosshair',
    begin,
    takeOver(type) {
      if (owner === type) return false;
      if (owner !== 'none') end(owner);
      return begin(type);
    },
    end,
    startCrosshair(point) {
      if (!begin('crosshair')) return false;
      callbacks.onCrosshair({ type: 'scrub', point });
      return true;
    },
    moveCrosshair(point) {
      if (owner !== 'crosshair') return false;
      callbacks.onCrosshair({ type: 'scrub', point });
      return true;
    },
  };
}

/** Idle gap that closes a wheel zoom/pan session on web. */
export const WHEEL_SESSION_IDLE_MS = 120;
/** Bound on the accumulated wheel scale within one session. */
const WHEEL_SESSION_MAX_SCALE = 50;

export type WheelGestureSession = {
  isActive: () => boolean;
  /** One wheel notch of zoom; `step > 1` zooms in. */
  zoom: (step: number, focalX: number) => void;
  /** One wheel notch of pan, in pixels. */
  pan: (deltaPx: number) => void;
  /** Close the session now (idle timeout, mouse down, mouse leave). */
  end: () => boolean;
  /** Unmount: drop the pending idle timer without emitting callbacks. */
  dispose: () => void;
};

/**
 * A wheel burst is ONE gesture.
 *
 * Every wheel event fires its own `onGestureStart`/`onGestureEnd` pair would
 * be wrong: the chart snapshots its viewport on start, and a burst arrives
 * faster than React re-renders, so each event would re-zoom the SAME stale
 * snapshot and only one notch would ever stick. Instead the first event opens
 * a session (one snapshot), following events apply the ACCUMULATED scale/pan
 * against that snapshot, and the session closes after an idle gap.
 *
 * Timers are injectable so the debounce is testable without a DOM.
 */
export function createWheelGestureSession(options: {
  onGestureStart: () => void;
  onZoom: (scale: number, focalX: number) => void;
  onPan: (translationX: number, translationY: number) => void;
  onGestureEnd: () => void;
  idleMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): WheelGestureSession {
  const idleMs = options.idleMs ?? WHEEL_SESSION_IDLE_MS;
  const setTimer =
    options.setTimer ??
    ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let mode: 'zoom' | 'pan' | null = null;
  let scale = 1;
  let panPx = 0;
  let timer: unknown = null;

  const cancelTimer = () => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };

  const end = (): boolean => {
    cancelTimer();
    if (mode === null) return false;
    mode = null;
    scale = 1;
    panPx = 0;
    options.onGestureEnd();
    return true;
  };

  const armIdleTimer = () => {
    cancelTimer();
    timer = setTimer(() => {
      timer = null;
      end();
    }, idleMs);
  };

  const enter = (next: 'zoom' | 'pan') => {
    if (mode === next) return;
    end();
    mode = next;
    options.onGestureStart();
  };

  return {
    isActive: () => mode !== null,
    zoom(step, focalX) {
      if (!Number.isFinite(step) || step <= 0) return;
      enter('zoom');
      scale = Math.min(
        Math.max(scale * step, 1 / WHEEL_SESSION_MAX_SCALE),
        WHEEL_SESSION_MAX_SCALE,
      );
      options.onZoom(scale, focalX);
      armIdleTimer();
    },
    pan(deltaPx) {
      if (!Number.isFinite(deltaPx)) return;
      enter('pan');
      panPx += deltaPx;
      // A wheel pan is horizontal only; prices keep their fit.
      options.onPan(panPx, 0);
      armIdleTimer();
    },
    end,
    dispose() {
      cancelTimer();
      mode = null;
      scale = 1;
      panPx = 0;
    },
  };
}
