// Pure gesture policy shared by the native and web chart adapters: when a drag
// counts as a horizontal chart pan (rather than a page scroll), and how wheel
// input maps to zoom. Keeping these decisions here means both platforms follow
// the same rules and the rules are unit-testable without rendering.

/** Horizontal distance before the chart claims a one-finger drag. */
export const HORIZONTAL_PAN_SLOP_PX = 10;
/** Hold this long without moving to enter crosshair mode on touch screens. */
export const LONG_PRESS_MS = 300;
/** Movement past this during the hold cancels the pending long press. */
export const LONG_PRESS_MOVE_SLOP_PX = 10;

/**
 * A one-finger drag belongs to the chart only when it is clearly horizontal:
 * small tremors and vertical drags stay with the parent ScrollView so the
 * detail screen keeps scrolling.
 */
export function isHorizontalPanIntent(
  dx: number,
  dy: number,
  slopPx: number = HORIZONTAL_PAN_SLOP_PX,
): boolean {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
  return Math.abs(dx) > slopPx && Math.abs(dx) > Math.abs(dy) * 1.2;
}

export type WheelIntent = 'zoom' | 'pan' | 'page-scroll';

/**
 * Web wheel policy:
 *  - Ctrl/Cmd + wheel (also what browsers send for a trackpad pinch) → zoom,
 *  - Shift + wheel or a horizontal wheel → chart pan,
 *  - plain vertical wheel → left to the page so the detail page still scrolls.
 */
export function classifyWheelIntent(event: {
  deltaX?: number;
  deltaY?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}): WheelIntent {
  if (event.ctrlKey || event.metaKey) return 'zoom';
  const deltaX = event.deltaX ?? 0;
  const deltaY = event.deltaY ?? 0;
  if (event.shiftKey) return 'pan';
  if (Math.abs(deltaX) > Math.abs(deltaY)) return 'pan';
  return 'page-scroll';
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

export type CrosshairSession = {
  isActive: () => boolean;
  /** Long press armed crosshair mode. */
  start: (point: CrosshairPoint) => void;
  /** Scrub while armed; ignored (returns false) when not. */
  move: (point: CrosshairPoint) => boolean;
  /**
   * Leave crosshair mode. Safe to call from EVERY recognizer that can end it
   * (long-press finalize, pan finalize, pinch begin) — only the first call
   * after a `start` does anything, so the chart never gets a stray clear or a
   * doubled gesture-end.
   */
  end: () => boolean;
};

/**
 * Crosshair mode as a tiny state machine, outside React state because several
 * recognizers read it synchronously mid-gesture.
 *
 * It lives here (not in the native adapter) so the "a lift always ends the
 * crosshair, no matter which recognizer saw it" rule is unit-tested without
 * rendering gesture-handler.
 */
export function createCrosshairSession(callbacks: {
  onCrosshair: (point: CrosshairPoint | null) => void;
  onGestureEnd: () => void;
}): CrosshairSession {
  let active = false;
  return {
    isActive: () => active,
    start(point) {
      active = true;
      callbacks.onCrosshair(point);
    },
    move(point) {
      if (!active) return false;
      callbacks.onCrosshair(point);
      return true;
    },
    end() {
      if (!active) return false;
      active = false;
      callbacks.onCrosshair(null);
      callbacks.onGestureEnd();
      return true;
    },
  };
}
