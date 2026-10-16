import { useSyncExternalStore } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

// One OS read and one subscription for the whole app. Every pressable and
// segment mounts with the known value instead of its own native round trip
// and a second render once that resolves.
let known: boolean | null = null;
// The OS cannot answer: no media query on this web host, or the native read failed.
let unanswered = false;
const listeners = new Set<() => void>();
let stop: (() => void) | null = null;

function update(value: boolean) {
  if (known === value) return;
  known = value;
  listeners.forEach(listener => listener());
}

function giveUp() {
  if (unanswered) return;
  unanswered = true;
  listeners.forEach(listener => listener());
}

function media() {
  return typeof window === 'undefined' || !window.matchMedia ? null : window.matchMedia('(prefers-reduced-motion: reduce)');
}

function start() {
  if (Platform.OS === 'web') {
    const query = media();
    if (!query) { giveUp(); return () => undefined; }
    update(query.matches);
    const listener = (event: MediaQueryListEvent) => update(event.matches);
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }
  let active = true;
  let changed = false;
  // A late initial read never overrides a live change.
  void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (active && !changed) update(value); })
    .catch(() => { if (active && !changed) giveUp(); });
  const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (value) => { changed = true; update(value); });
  return () => { active = false; subscription.remove(); };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!stop) stop = start();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { stop?.(); stop = null; }
  };
}

function snapshot() {
  // Web can read the preference synchronously before the first paint.
  if (known === null && Platform.OS === 'web') { const query = media(); if (query) known = query.matches; else unanswered = true; }
  // No motion until the OS preference is known, including read failures.
  return known ?? true;
}

function settledSnapshot() {
  snapshot();
  return known !== null || unanswered;
}

/** Shared OS setting for navigation and touch animations. */
export function useReducedMotion() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * Whether `useReducedMotion` already reports the OS answer. Before it does
 * (the first native read is asynchronous) it reports reduced as a default; a
 * failed read or a web host without the media query settles on that default.
 */
export function useReducedMotionSettled() {
  return useSyncExternalStore(subscribe, settledSnapshot, settledSnapshot);
}
