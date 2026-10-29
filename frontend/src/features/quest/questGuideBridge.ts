/**
 * The seam between the beginner quest guide and the EXISTING Wallet screens.
 *
 * Screens never import the guide's React tree. They hand it three things:
 *  - measurable views (`questGuideTarget`) for the spotlight to find;
 *  - plain facts about their own state (`publishQuestGuideFacts`), so the
 *    guide can follow the real form instead of guessing at it;
 *  - after THEIR OWN command succeeded, a description of that command
 *    (`claimQuestGuideCommand`);
 *  - optionally their own 이체 sheet (`registerQuestGuideFunding`), which the
 *    card's 이체하기 opens; money moves only by the sheet's own 이체하기.
 *
 * Nothing here can execute, retry or alter a financial command. With no guide
 * mounted (general/season accounts, tests, a beginner not following a quest)
 * every call is inert and the screens behave exactly as they do without it.
 * First completion requires the guide's fresh ledger-derived progress read.
 * A replay uses only this run's already committed command.
 *
 * This file stays React- and react-native-free so `node --test` and the
 * function-call screen harnesses can load it unchanged.
 */

export type TradeGuideScreen = 'market' | 'asset' | 'order' | 'futures' | 'holdings' | 'protection' | 'limitReview';
export type QuestGuideScreen = 'wallet' | 'fx' | 'transfer' | TradeGuideScreen;

export type QuestGuideTargetId =
  | 'market-viewport' | 'market-tabs' | 'market-assets' | 'market-list-header'
  | 'asset-viewport' | 'asset-price' | 'asset-buy' | 'asset-sell' | 'asset-holdings' | 'asset-protection'
  | 'protection-editor' | 'protection-submit' | 'limit-review'
  | 'order-viewport' | 'order-type' | 'order-method-market' | 'order-method-limit' | 'order-input' | 'order-preview' | 'order-submit'
  | 'futures-viewport' | 'futures-funding' | 'futures-instrument' | 'futures-direction'
  | 'futures-margin' | 'futures-input' | 'futures-submit' | 'futures-position'
  | 'futures-leverage-suggested'
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

export type TradeGuideFacts = { [S in TradeGuideScreen]: {
  screen: S; accountId: string; assetId?: string; assetType?: string;
  side?: string; orderType?: string; methodSheetOpen?: boolean; amountValid?: boolean; canExecute?: boolean;
  pending?: boolean; blocked?: boolean; holdingsVisible?: boolean;
  protectionEditing?: boolean; tpSlReady?: boolean; orderResolved?: boolean;
  direction?: string; leverage?: number; marginMode?: string; positionId?: string;
  positionDirection?: string;
  /** The futures leverage sheet open over the form (preset list or 직접 설정하기). */
  leverageSheet?: 'list' | 'custom';
  /**
   * The order form's own live balance check, as the form shows it: the
   * fee-included total is above the AVAILABLE balance. Absent while the
   * amount, price, fee or balance is unknown, invalid or enough.
   */
  insufficientBalance?: string;
  /** The paying wallet takes a USD transfer: 이체하기 opens the form's own sheet. */
  transferFunding?: boolean;
  /** The form's 이체 / 환전 sheet is open over it. */
  fundingOpen?: boolean;
  /** A futures position's 포지션 종료 or 손절가/익절가 sheet is open over the screen. */
  positionSheetOpen?: boolean;
} }[TradeGuideScreen];
export type QuestGuideFacts = WalletGuideFacts | FxGuideFacts | TransferGuideFacts | TradeGuideFacts;
type FactsFor<S extends QuestGuideScreen> = Extract<QuestGuideFacts, { screen: S }>;

/** A command the screen already committed; `summary` is display copy only. */
export type QuestGuideCommand =
  | { kind: 'fx'; accountId: string; fromCurrency: string; toCurrency: string; summary: string }
  | { kind: 'transfer'; accountId: string; source: string; destination: string; currency: string; summary: string }
  | { kind: 'spot'; accountId: string; orderId: string; assetId: string; assetType: string; side: string; orderType: string; summary: string }
  // A registered spot TP/SL (one stop-loss or take-profit is enough).
  | { kind: 'protection'; accountId: string; assetId: string; summary: string }
  | { kind: 'futures'; accountId: string; positionId: string; direction: string; operation: string; leverage: number; quantityAfter: string; summary: string };

type Listener = () => void;

const targets = new Map<QuestGuideTargetId, MeasurableNode>();
const refCallbacks = new Map<QuestGuideTargetId, (node: MeasurableNode | null) => (() => void) | undefined>();
const facts = new Map<QuestGuideScreen, QuestGuideFacts>();
const reveals = new Map<QuestGuideScreen, (node: QuestGuideMeasurable) => void>();
const fundings = new Map<QuestGuideScreen, () => void>();
const listeners = new Set<Listener>();
let version = 0;
let commandSink: ((command: QuestGuideCommand) => boolean) | null = null;
let commandSession: (() => number | null) | null = null;

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
 * The screen's own 이체 sheet, for the guide card's 이체하기 (the user's press).
 * Opening it moves no money: only the sheet's own 이체하기 does, with the
 * screen's guards. The returned disposer never removes a newer one.
 */
export function registerQuestGuideFunding(screen: QuestGuideScreen, open: () => void) {
  fundings.set(screen, open);
  return () => {
    if (fundings.get(screen) === open) fundings.delete(screen);
  };
}

/** Opens the screen's 이체 sheet; false when the screen offers none. */
export function openQuestGuideFunding(screen: QuestGuideScreen): boolean {
  const open = fundings.get(screen);
  open?.();
  return !!open;
}

/**
 * Reports a command that ALREADY succeeded for `accountId`. Returns true only
 * when an active guide for that account adopted it, i.e. the guide — not the
 * screen — will present the outcome (first completion also re-reads progress).
 */
export function claimQuestGuideCommand(command: QuestGuideCommand): boolean {
  return commandSink?.(command) ?? false;
}

/** Pin a user command to the guide that existed at submit, including retries. */
export function captureQuestGuideCommand(): (command: QuestGuideCommand) => boolean {
  const sink = commandSink;
  const session = commandSession?.() ?? null;
  return command => sink !== null && sink === commandSink &&
    session === (commandSession?.() ?? null) ? sink(command) : false;
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
  // Rows of the 주문방식 sheet float above the screen; scrolling it moves nothing they need.
  if (id === 'order-method-market' || id === 'order-method-limit') return;
  const node = getQuestGuideTarget(id);
  const reveal = reveals.get(screen);
  if (node && reveal) reveal(node);
}

/** Installs the adopting guide; the returned disposer never removes a newer one. */
export function setQuestGuideCommandSink(sink: (command: QuestGuideCommand) => boolean, readSession?: () => number | null) {
  commandSink = sink;
  commandSession = readSession ?? null;
  return () => {
    if (commandSink === sink) { commandSink = null; commandSession = null; }
  };
}
