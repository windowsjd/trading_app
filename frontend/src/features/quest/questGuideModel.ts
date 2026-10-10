/**
 * The beginner quest spotlight, as pure data (no React, no react-native).
 *
 * A guide session only decides WHAT to point at and WHAT to say. It follows
 * the real Wallet screens through the facts they publish, so a step can never
 * claim a state the form is not in: a USD → KRW direction sends the guide back
 * to the direction step, a cleared amount back to the amount step, an
 * unavailable rate to the rate retry. Executing is always the user's own press
 * of the existing button; the guide has no command of its own.
 *
 * Completion is the server's: a session celebrates only after (1) it started
 * on a quest the server had NOT proven yet, (2) the screen reported its own
 * successful, matching command, and (3) a fresh server read proves the quest.
 */
import type {
  FxGuideFacts,
  QuestGuideCommand,
  QuestGuideScreen,
  QuestGuideTargetId,
  TransferGuideFacts,
  WalletGuideFacts,
} from './questGuideBridge.ts';
import type { BeginnerQuestKey, BeginnerQuests } from './questProgress.ts';
import { QUEST_CARDS, QUEST_GUIDE_COPY } from './questContent.ts';

export type FocusedGuideScreen = QuestGuideScreen | 'quests' | 'other';
export type GuidePhase = 'guiding' | 'verifying' | 'celebrating' | 'returning' | 'unconfirmed' | 'completedElsewhere';

export interface GuideSession {
  id: number;
  accountId: string;
  quest: BeginnerQuestKey;
  /** The server had already proven this quest at start: a review, never a celebration. */
  replay: boolean;
  /** 1-based step on the practice screen; the Wallet entry button is step 0. */
  step: number;
  phase: GuidePhase;
  /** Display copy of the adopted command's outcome. */
  summary: string | null;
}

export type GuideAction = 'next' | 'exit' | 'retry' | 'back';

export interface GuideCard {
  title: string;
  body: string;
  hint: string | null;
  tone: 'info' | 'warning';
  /** "2/6"-style position, or null for state messages. */
  stepLabel: string | null;
  next: 'enabled' | 'disabled' | null;
  busy: boolean;
  /** Secondary actions in display order. */
  actions: GuideAction[];
}

export type GuideView =
  | { kind: 'none' }
  | {
    kind: 'spotlight';
    /** Changes with the step's state (e.g. an amount becoming valid). */
    key: string;
    /** Same for one step on one set of targets: the card updates in place. */
    anchor: string;
    screen: QuestGuideScreen;
    step: number;
    targets: QuestGuideTargetId[];
    placement: 'auto' | 'top-right';
    card: GuideCard;
  }
  | { kind: 'message'; key: string; anchor: string; screen: QuestGuideScreen; card: GuideCard }
  | { kind: 'celebration'; key: string; quest: BeginnerQuestKey; title: string; summary: string | null; leaving: boolean };

export type GuideFacts = {
  wallet: WalletGuideFacts | null;
  fx: FxGuideFacts | null;
  transfer: TransferGuideFacts | null;
};

export const PRACTICE_SCREEN: Record<BeginnerQuestKey, 'fx' | 'transfer'> = { exchange: 'fx', transfer: 'transfer' };
export const VIEWPORT_TARGET: Record<QuestGuideScreen, QuestGuideTargetId> = {
  wallet: 'wallet-viewport',
  fx: 'fx-viewport',
  transfer: 'transfer-viewport',
};
/** Both quests: the Wallet entry button, then five steps on the practice screen. */
export const PRACTICE_STEPS = 5;
const TOTAL_STEPS = PRACTICE_STEPS + 1;
const NONE: GuideView = { kind: 'none' };
const copy = QUEST_GUIDE_COPY;

type CopyBlock = { title: string; body: string };

function card(block: CopyBlock, options: Partial<GuideCard> = {}): GuideCard {
  return {
    title: block.title,
    body: options.body ?? block.body,
    hint: options.hint ?? null,
    tone: options.tone ?? 'info',
    stepLabel: options.stepLabel ?? null,
    next: options.next ?? null,
    busy: options.busy ?? false,
    actions: options.actions ?? ['exit'],
  };
}

const stepLabel = (step: number) => `${step + 1}/${TOTAL_STEPS}`;

function spotlight(
  session: GuideSession,
  screen: QuestGuideScreen,
  step: number,
  variant: string,
  targets: QuestGuideTargetId[],
  guideCard: GuideCard,
  placement: 'auto' | 'top-right' = 'auto',
): GuideView {
  return {
    kind: 'spotlight',
    key: `${session.id}:${screen}:${step}:${variant}`,
    anchor: `${session.id}:${screen}:${step}:${targets.join(',')}`,
    screen,
    step,
    targets,
    placement,
    card: { ...guideCard, stepLabel: stepLabel(step) },
  };
}

function message(session: GuideSession, screen: QuestGuideScreen, variant: string, guideCard: GuideCard): GuideView {
  return { kind: 'message', key: `${session.id}:${screen}:message:${variant}`, anchor: `${session.id}:${screen}:message`, screen, card: guideCard };
}

const clampStep = (step: number) => Math.min(Math.max(Math.trunc(step) || 1, 1), PRACTICE_STEPS);

/** The furthest step the CURRENT form state supports. */
export function effectiveExchangeStep(step: number, fx: FxGuideFacts): number {
  const wanted = clampStep(step);
  if (wanted >= 2 && fx.fromCurrency !== 'KRW') return 1;
  if (wanted >= 3 && !fx.amountValid) return 2;
  return wanted;
}

export function effectiveTransferStep(step: number, transfer: TransferGuideFacts): number {
  const wanted = clampStep(step);
  if (wanted >= 2 && transfer.source !== 'securities') return 1;
  if (wanted >= 3 && transfer.destination !== 'crypto_spot') return 2;
  if (wanted >= 4 && !(transfer.amountValid && transfer.amountFits)) return 3;
  return wanted;
}

function entryView(session: GuideSession, wallet: WalletGuideFacts | null): GuideView {
  if (!wallet || wallet.accountId !== session.accountId) return NONE;
  if (wallet.actions === 'hidden') {
    return message(session, 'wallet', 'unavailable', card(copy.wallet.unavailable, { tone: 'warning' }));
  }
  if (wallet.actions === 'disabled') {
    return message(session, 'wallet', 'disabled', card(copy.wallet.disabled, { tone: 'warning' }));
  }
  const entry = copy[session.quest].entry;
  return spotlight(session, 'wallet', 0, 'entry',
    [session.quest === 'exchange' ? 'wallet-exchange' : 'wallet-transfer'],
    card(entry, { hint: entry.hint }), 'top-right');
}

function exchangeView(session: GuideSession, fx: FxGuideFacts | null): GuideView {
  if (!fx || fx.accountId !== session.accountId) return NONE;
  const c = copy.exchange;
  if (fx.blocked) return message(session, 'fx', 'blocked', card(c.blocked, { tone: 'warning' }));
  const step = effectiveExchangeStep(session.step, fx);
  if (step === 1) {
    const ok = fx.fromCurrency === 'KRW';
    return spotlight(session, 'fx', 1, ok ? 'ok' : 'wrong', ['fx-direction'], card(c.direction, {
      body: ok ? c.direction.body : c.direction.wrong,
      tone: ok ? 'info' : 'warning',
      next: ok ? 'enabled' : 'disabled',
    }));
  }
  if (step === 2) {
    return spotlight(session, 'fx', 2, fx.amountValid ? 'ok' : 'empty', ['fx-amount'], card(c.amount, {
      hint: fx.amountValid ? null : c.amount.hint,
      next: fx.amountValid ? 'enabled' : 'disabled',
    }));
  }
  if (fx.rate === 'loading') return message(session, 'fx', 'rate-loading', card(c.rateLoading, { busy: true }));
  if (fx.rate === 'unavailable') {
    return spotlight(session, 'fx', step, 'rate-unavailable', ['fx-rate-error'], card(c.rateUnavailable, { tone: 'warning' }));
  }
  if (step < 5 && !fx.previewReady) {
    return spotlight(session, 'fx', step, 'preview-unavailable', ['fx-preview'], card(c.previewUnavailable, { tone: 'warning' }));
  }
  if (step === 3) return spotlight(session, 'fx', 3, 'quote', ['fx-quote-title', 'fx-rate-row'], card(c.quote, { next: 'enabled' }));
  if (step === 4) return spotlight(session, 'fx', 4, 'fee', ['fx-fee-row', 'fx-net-row'], card(c.fee, { next: 'enabled' }));
  const variant = fx.pending ? 'pending' : fx.failed ? 'failed' : fx.canExecute ? 'ready' : 'unavailable';
  return spotlight(session, 'fx', 5, variant, ['fx-submit'], card(c.submit, {
    body: fx.pending ? c.submit.pending : fx.failed ? c.submit.failed : fx.canExecute ? c.submit.body : c.submit.unavailable,
    tone: variant === 'failed' || variant === 'unavailable' ? 'warning' : 'info',
    busy: fx.pending,
  }));
}

function transferView(session: GuideSession, transfer: TransferGuideFacts | null): GuideView {
  if (!transfer || transfer.accountId !== session.accountId) return NONE;
  const c = copy.transfer;
  if (transfer.blocked) return message(session, 'transfer', 'blocked', card(c.blocked, { tone: 'warning' }));
  // A matching success is adopted before this point; any other receipt is a different route.
  if (transfer.succeeded) return message(session, 'transfer', 'other-route', card(c.otherRoute, { tone: 'warning' }));
  const step = effectiveTransferStep(session.step, transfer);
  if (step === 1) {
    const ok = transfer.source === 'securities';
    return spotlight(session, 'transfer', 1, ok ? 'ok' : 'wrong', ['transfer-source'], card(c.source, {
      body: ok ? c.source.body : c.source.wrong, tone: ok ? 'info' : 'warning', next: ok ? 'enabled' : 'disabled',
    }));
  }
  if (step === 2) {
    const ok = transfer.destination === 'crypto_spot';
    return spotlight(session, 'transfer', 2, ok ? 'ok' : 'wrong', ['transfer-destination'], card(c.destination, {
      body: ok ? c.destination.body : c.destination.wrong, tone: ok ? 'info' : 'warning', next: ok ? 'enabled' : 'disabled',
    }));
  }
  if (step === 3) {
    if (transfer.nothingToSend) {
      return spotlight(session, 'transfer', 3, 'empty-wallet', ['transfer-amount', 'transfer-available'],
        card(c.amount, { body: c.amount.empty, tone: 'warning' }));
    }
    const ok = transfer.amountValid && transfer.amountFits;
    return spotlight(session, 'transfer', 3, ok ? 'ok' : 'invalid', ['transfer-amount'], card(c.amount, {
      hint: ok ? null : c.amount.hint, next: ok ? 'enabled' : 'disabled',
    }));
  }
  if (step === 4) {
    return spotlight(session, 'transfer', 4, 'review', ['transfer-amount', 'transfer-available'], card(c.review, { next: 'enabled' }));
  }
  const variant = transfer.pending ? 'pending' : transfer.failed ? 'failed' : transfer.canExecute ? 'ready' : 'unavailable';
  return spotlight(session, 'transfer', 5, variant, ['transfer-submit'], card(c.submit, {
    body: transfer.pending ? c.submit.pending : transfer.failed ? c.submit.failed
      : transfer.canExecute ? c.submit.body : c.submit.unavailable,
    tone: variant === 'failed' || variant === 'unavailable' ? 'warning' : 'info',
    busy: transfer.pending,
  }));
}

/** What the overlay shows for this session, focus and form state. */
export function resolveGuideView(session: GuideSession | null, focused: FocusedGuideScreen, facts: GuideFacts): GuideView {
  if (!session) return NONE;
  if (session.phase === 'celebrating' || session.phase === 'returning') {
    return {
      kind: 'celebration',
      key: `${session.id}:celebration`,
      quest: session.quest,
      title: QUEST_CARDS[session.quest].completed,
      summary: session.summary,
      leaving: session.phase === 'returning',
    };
  }
  const practice = PRACTICE_SCREEN[session.quest];
  // Other tabs (and the quest list, which shows its own state) pause the overlay.
  if (focused !== 'wallet' && focused !== practice) return NONE;
  const screen: QuestGuideScreen = focused;
  if (session.phase === 'verifying') {
    return message(session, screen, 'verifying', card(copy.verifying, { hint: session.summary, busy: true, actions: [] }));
  }
  if (session.phase === 'unconfirmed') {
    return message(session, screen, 'unconfirmed', card(copy.unconfirmed, {
      hint: session.summary, tone: 'warning', actions: ['retry', 'back'],
    }));
  }
  if (session.phase === 'completedElsewhere') {
    return message(session, screen, 'completed-elsewhere', card(copy.completedElsewhere, { actions: ['back', 'exit'] }));
  }
  if (focused === 'wallet') return entryView(session, facts.wallet);
  return session.quest === 'exchange' ? exchangeView(session, facts.fx) : transferView(session, facts.transfer);
}

/** Starting needs a known baseline; QUEST 02 also needs QUEST 01 proven. */
export function startGuideSession(id: number, accountId: string, quest: BeginnerQuestKey, progress: BeginnerQuests | null): GuideSession | null {
  if (!accountId || !progress) return null;
  if (quest === 'transfer' && !progress.exchange.completed) return null;
  return { id, accountId, quest, replay: progress[quest].completed, step: 1, phase: 'guiding', summary: null };
}

/** Returning to the Wallet root means the practice screen was closed: start it over. */
export function followGuideFocus(session: GuideSession, focused: FocusedGuideScreen): GuideSession {
  return session.phase === 'guiding' && focused === 'wallet' && session.step !== 1 ? { ...session, step: 1 } : session;
}

export function advanceGuide(session: GuideSession, fromStep: number): GuideSession {
  if (session.phase !== 'guiding') return session;
  return { ...session, step: Math.min(clampStep(fromStep) + 1, PRACTICE_STEPS) };
}

/** The only commands that can complete each quest on the server. */
export function commandMatchesQuest(quest: BeginnerQuestKey, command: QuestGuideCommand): boolean {
  return quest === 'exchange'
    ? command.kind === 'fx' && command.fromCurrency === 'KRW' && command.toCurrency === 'USD'
    : command.kind === 'transfer' && command.currency === 'USD'
      && command.source === 'securities' && command.destination === 'crypto_spot';
}

/**
 * A screen's committed command. Only a matching command of THIS account and a
 * live, non-review session is adopted; the session then waits for the server.
 * A review run ends on its matching command and the screen keeps its receipt.
 */
export function claimGuideCommand(session: GuideSession | null, accountId: string, command: QuestGuideCommand): {
  session: GuideSession | null;
  claimed: boolean;
} {
  if (!session || session.phase !== 'guiding' || session.accountId !== accountId || command.accountId !== accountId
    || !commandMatchesQuest(session.quest, command)) {
    return { session, claimed: false };
  }
  if (session.replay) return { session: null, claimed: false };
  return { session: { ...session, phase: 'verifying', summary: command.summary }, claimed: true };
}

/** A fresh server read decides: celebrate only what the ledger proves. */
export function settleGuideVerification(session: GuideSession, progress: BeginnerQuests | null): GuideSession {
  if (session.phase !== 'verifying') return session;
  return { ...session, phase: progress?.[session.quest].completed ? 'celebrating' : 'unconfirmed' };
}

/** Proven without this session's command (e.g. another device): no celebration. */
export function observeGuideProgress(session: GuideSession, progress: BeginnerQuests, commandPending: boolean): GuideSession {
  if (session.phase !== 'guiding' || session.replay || commandPending || !progress[session.quest].completed) return session;
  return { ...session, phase: 'completedElsewhere' };
}

export type GuideRect = { x: number; y: number; width: number; height: number };

export function unionRects(rects: GuideRect[]): GuideRect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map(rect => rect.x));
  const top = Math.min(...rects.map(rect => rect.y));
  const right = Math.max(...rects.map(rect => rect.x + rect.width));
  const bottom = Math.max(...rects.map(rect => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function intersectRects(a: GuideRect, b: GuideRect): GuideRect | null {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}

export function sameRect(a: GuideRect | null, b: GuideRect | null, tolerance = 1): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance
    && Math.abs(a.width - b.width) <= tolerance && Math.abs(a.height - b.height) <= tolerance;
}

export function inflateRect(rect: GuideRect, by: number): GuideRect {
  return { x: rect.x - by, y: rect.y - by, width: rect.width + by * 2, height: rect.height + by * 2 };
}

/**
 * Where the step card goes: inside `area` (the visible screen region above any
 * keyboard), never on the highlighted control. When the card is taller than
 * the room on either side, it takes the roomier side with `maxHeight` and its
 * text scrolls inside it; only when not even `minHeight` (the actions and a
 * couple of lines) fits does it fall back to `overlaps`.
 */
export function placeGuideCard(input: {
  area: GuideRect;
  hole: GuideRect | null;
  card: { width: number; height: number; minHeight?: number };
  placement: 'auto' | 'top-right';
}): { x: number; y: number; maxHeight: number | null; overlaps: boolean } {
  const { area, hole, card } = input;
  const gutter = 12;
  const gap = 12;
  const minHeight = Math.min(card.height, card.minHeight ?? card.height);
  const minX = area.x + gutter;
  const maxX = Math.max(minX, area.x + area.width - gutter - card.width);
  const clampX = (x: number) => Math.min(Math.max(x, minX), maxX);
  const top = area.y + gutter;
  const bottom = area.y + area.height - gutter;
  const clampY = (y: number, height = card.height) => Math.min(Math.max(y, top), Math.max(top, bottom - height));
  const at = (x: number, y: number, maxHeight: number | null = null) => ({
    x, y, maxHeight,
    overlaps: !!hole && !!intersectRects({ x, y, width: card.width, height: maxHeight ?? card.height }, hole),
  });
  if (!hole) {
    const room = bottom - top;
    return card.height <= room
      ? at(clampX(area.x + (area.width - card.width) / 2), clampY(bottom - card.height))
      : at(clampX(area.x + (area.width - card.width) / 2), top, Math.max(minHeight, room));
  }
  if (input.placement === 'top-right') {
    const corner = at(maxX, top);
    if (!corner.overlaps && top + card.height <= bottom) return corner;
  }
  const x = clampX(hole.x + hole.width / 2 - card.width / 2);
  const below = hole.y + hole.height + gap;
  const roomBelow = bottom - below;
  const roomAbove = hole.y - gap - top;
  if (card.height <= roomBelow && (card.height > roomAbove || roomBelow >= roomAbove)) return at(x, below);
  if (card.height <= roomAbove) return at(x, hole.y - gap - card.height);
  // Too tall for either side: the roomier side, with the text scrolling inside.
  const room = Math.max(roomBelow, roomAbove);
  if (room >= minHeight) return roomBelow >= roomAbove ? at(x, below, roomBelow) : at(x, top, roomAbove);
  return at(x, clampY(roomBelow >= roomAbove ? below : hole.y - gap - card.height));
}
