/**
 * 공지 팝업 (2026-11-13): published notices an admin marked for a popup that
 * the signed-in member has not confirmed (GET /notices/popup, newest first).
 * Pure, so the selection rules run under `node --test`.
 */
export type PopupNotice = { id: string; title: string; summary: string; publishedAt: string | null };

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** The server's list, checked again: an entry missing any field is dropped, never guessed. */
export function parsePopupNotices(value: unknown): PopupNotice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const entry = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const id = text(entry.id);
    const title = text(entry.title);
    const summary = text(entry.summary);
    return id && title && summary
      ? [{ id, title, summary, publishedAt: typeof entry.publishedAt === 'string' ? entry.publishedAt : null }]
      : [];
  });
}

/** The one to show now: the newest the member has not confirmed in this run (one at a time, never stacked). */
export function nextPopupNotice(notices: readonly PopupNotice[], confirmed: ReadonlySet<string>): PopupNotice | null {
  return notices.find((notice) => !confirmed.has(notice.id)) ?? null;
}

type NavState = { index?: number; routes: ReadonlyArray<{ name: string; state?: NavState }> } | undefined;

/**
 * Normal app entry, not the middle of something: the top route is the tabs
 * and the open tab shows its first screen (Home, the market list, …). An
 * order screen, a detail, a chart, season join or any root screen over the
 * tabs is not — the popup waits until the member is back on a first screen.
 */
export function isAtTabRoot(root: NavState): boolean {
  const top = root?.routes[root.index ?? root.routes.length - 1];
  if (!top || top.name !== 'MainTabs') return false;
  const tabs = top.state;
  if (!tabs) return true;
  const stack = tabs.routes[tabs.index ?? 0]?.state;
  return !stack || (stack.index ?? 0) === 0;
}
