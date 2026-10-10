/**
 * The seam between the beginner quest guide and the EXISTING Wallet screens.
 *
 * Screens never import the guide's React tree. They hand it three things:
 *  - measurable views (`questGuideTarget`) for the spotlight to find;
 *  - plain facts about their own state (`publishQuestGuideFacts`), so the
 *    guide can follow the real form instead of guessing at it;
 *  - after THEIR OWN command succeeded, a description of that command
 *    (`claimQuestGuideCommand`).
 *
 * Nothing here can execute, retry or alter a financial command. With no guide
 * mounted (general/season accounts, tests, a beginner not following a quest)
 * every call is inert and the screens behave exactly as they do without it.
 * Completion is never decided here: the guide re-reads the server's
 * ledger-derived progress after a claim.
 *
 * This file stays React- and react-native-free so `node --test` and the
 * function-call screen harnesses can load it unchanged.
 */

export type QuestGuideScreen = 'wallet' | 'fx' | 'transfer';

export type QuestGuideTargetId =
  | 'wallet-viewport'
  | 'wallet-exchange'
  | 'wallet-transfer'
  | 'fx-viewport'
  | 'fx-direction'
  | 'fx-amount'
  | 'fx-preview'
  | 'fx-quote-title'
  | 'fx-rate-row'
  | 'fx-fee-row'
  | 'fx-net-row'
  | 'fx-rate-error'
  | 'fx-submit'
  | 'transfer-viewport'
  | 'transfer-source'
  | 'transfer-destination'
  | 'transfer-amount'
  | 'transfer-available'
  | 'transfer-submit';

export interface QuestGuideMeasurable {
  measureInWindow(callback: (x: number, y: number, width: number, height: number) => void): void;
}

/** A ScrollView ref measures through its native scroll view. */
type MeasurableNode = QuestGuideMeasurable | { getNativeScrollRef(): QuestGuideMeasurable | null };

export type QuestActionState = 'enabled' | 'disabled' | 'hidden';
export type QuestWalletScope = 'securities' | 'crypto_spot' | 'crypto_futures';

export type WalletGuideFacts = {
  screen: 'wallet';
  accountId: string;
  /** The 환전하기/이체하기 quick actions share one capability gate. */
  actions: QuestActionState;
};

export type FxGuideFacts = {
  screen: 'fx';
  accountId: string;
  /** The account may not exchange (suspended/closed); the form is replaced. */
  blocked: boolean;
  fromCurrency: 'KRW' | 'USD';
  amountValid: boolean;
  rate: 'loading' | 'available' | 'unavailable';
  /** The fee/receive estimate rows are on screen. */
  previewReady: boolean;
  canExecute: boolean;
  pending: boolean;
  failed: boolean;
};

export type TransferGuideFacts = {
  screen: 'transfer';
  accountId: string;
  blocked: boolean;
  source: QuestWalletScope;
  destination: QuestWalletScope;
  amountValid: boolean;
  amountFits: boolean;
  /** The source wallet's transferable amount is known and zero. */
  nothingToSend: boolean;
  canExecute: boolean;
  pending: boolean;
  failed: boolean;
  succeeded: boolean;
};

export type QuestGuideFacts = WalletGuideFacts | FxGuideFacts | TransferGuideFacts;
type FactsFor<S extends QuestGuideScreen> = Extract<QuestGuideFacts, { screen: S }>;

/** A command the screen already committed; `summary` is display copy only. */
export type QuestGuideCommand =
  | { kind: 'fx'; accountId: string; fromCurrency: string; toCurrency: string; summary: string }
  | { kind: 'transfer'; accountId: string; source: string; destination: string; currency: string; summary: string };

type Listener = () => void;

const targets = new Map<QuestGuideTargetId, MeasurableNode>();
const refCallbacks = new Map<QuestGuideTargetId, (node: MeasurableNode | null) => (() => void) | undefined>();
const facts = new Map<QuestGuideScreen, QuestGuideFacts>();
const reveals = new Map<QuestGuideScreen, (node: QuestGuideMeasurable) => void>();
const listeners = new Set<Listener>();
let version = 0;
let commandSink: ((command: QuestGuideCommand) => boolean) | null = null;

function emit() {
  version += 1;
  for (const listener of [...listeners]) listener();
}

/**
 * A stable ref callback per target. React 19 calls the returned cleanup on
 * detach, so a remounted screen never has its new view removed by the old one.
 */
export function questGuideTarget(id: QuestGuideTargetId) {
  let callback = refCallbacks.get(id);
  if (!callback) {
    callback = (node: MeasurableNode | null) => {
      if (!node) return undefined;
      targets.set(id, node);
      emit();
      return () => {
        if (targets.get(id) !== node) return;
        targets.delete(id);
        emit();
      };
    };
    refCallbacks.set(id, callback);
  }
  return callback;
}

const sameFacts = (a: QuestGuideFacts | undefined, b: QuestGuideFacts | null) => {
  if (!a || !b) return a === undefined && b === null;
  const keys = Object.keys(a) as Array<keyof QuestGuideFacts>;
  return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key]);
};

/** Idempotent: publishing unchanged facts on every render notifies nobody. */
export function publishQuestGuideFacts<S extends QuestGuideScreen>(screen: S, value: FactsFor<S> | null) {
  if (sameFacts(facts.get(screen), value)) return;
  if (value) facts.set(screen, value);
  else facts.delete(screen);
  emit();
}

/** The screen's own scroll-into-view (it alone knows its scroll offset). */
export function registerQuestGuideReveal(screen: QuestGuideScreen, reveal: ((node: QuestGuideMeasurable) => void) | null) {
  if (reveal) reveals.set(screen, reveal);
  else reveals.delete(screen);
}

/**
 * Reports a command that ALREADY succeeded for `accountId`. Returns true only
 * when an active guide for that account adopted it, i.e. the guide — not the
 * screen — will present the outcome (after re-reading server progress).
 */
export function claimQuestGuideCommand(command: QuestGuideCommand): boolean {
  return commandSink?.(command) ?? false;
}

// Guide-side API (QuestGuideProvider).

export function subscribeQuestGuide(listener: Listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getQuestGuideVersion() {
  return version;
}

export function getQuestGuideFacts<S extends QuestGuideScreen>(screen: S): FactsFor<S> | null {
  return (facts.get(screen) as FactsFor<S> | undefined) ?? null;
}

export function getQuestGuideTarget(id: QuestGuideTargetId): QuestGuideMeasurable | null {
  const node = targets.get(id);
  if (!node) return null;
  return 'getNativeScrollRef' in node ? node.getNativeScrollRef() : node;
}

export function revealQuestGuideTarget(screen: QuestGuideScreen, id: QuestGuideTargetId) {
  const node = getQuestGuideTarget(id);
  const reveal = reveals.get(screen);
  if (node && reveal) reveal(node);
}

/** Installs the adopting guide; the returned disposer never removes a newer one. */
export function setQuestGuideCommandSink(sink: (command: QuestGuideCommand) => boolean) {
  commandSink = sink;
  return () => {
    if (commandSink === sink) commandSink = null;
  };
}
