import { TRADING_GUIDE_STEPS, isTradingQuest } from './tradingGuideSteps.ts';
import { canStartQuest } from './questProgress.ts';
import type { TradeGuideScreen, TradeGuideFacts } from './questGuideBridge.ts';
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
export type GuidePhase = 'guiding' | 'verifying' | 'celebrating' | 'replaySucceeded' | 'returning' | 'unconfirmed' | 'completedElsewhere';

export interface GuideSession {
  id: number;
  accountId: string;
  quest: BeginnerQuestKey;
  /** Already proven at start: practice again without repeating the completion reward. */
  replay: boolean;
  /** 1-based step on the practice screen; the Wallet entry button is step 0. */
  step: number;
  phase: GuidePhase;
  /** Display copy of the adopted command's outcome. */
  summary: string | null;
  orderId?: string;
  assetId?: string;
  positionId?: string;
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
  | { kind: 'celebration'; key: string; quest: BeginnerQuestKey; title: string; summary: string | null; leaving: boolean; replay: boolean };

export type GuideFacts = {
  practice?: Partial<Record<TradeGuideScreen, TradeGuideFacts | null>>;
  wallet: WalletGuideFacts | null;
  fx: FxGuideFacts | null;
  transfer: TransferGuideFacts | null;
};

export const PRACTICE_SCREEN: Record<'exchange' | 'transfer', 'fx' | 'transfer'> = { exchange: 'fx', transfer: 'transfer' };
export const VIEWPORT_TARGET: Record<QuestGuideScreen, QuestGuideTargetId> = {
  market: 'market-viewport', asset: 'asset-viewport', order: 'order-viewport', futures: 'futures-viewport',
  holdings: 'order-viewport', protection: 'order-viewport', limitReview: 'order-viewport',
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
  if (isTradingQuest(session.quest)) return NONE;
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
  if (session.phase === 'celebrating' || session.phase === 'replaySucceeded' || session.phase === 'returning') {
    return {
      kind: 'celebration',
      key: `${session.id}:celebration`,
      quest: session.quest,
      title: session.replay ? '실습을 완료했어요.' : QUEST_CARDS[session.quest].completed,
      summary: session.summary,
      leaving: session.phase === 'returning',
      replay: session.replay,
    };
  }
  if (isTradingQuest(session.quest)) return tradingGuideView(session, focused, facts);
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
function tradingGuideView(session: GuideSession, focused: FocusedGuideScreen, facts: GuideFacts): GuideView {
  if (!isTradingQuest(session.quest) || !['market', 'asset', 'order', 'futures'].includes(focused)) return NONE;
  const screen = focused as TradeGuideScreen;
  if (session.phase === 'verifying') return message(session, screen, 'verifying', card(copy.verifying, { busy: true, actions: [] }));
  if (session.phase === 'unconfirmed') return message(session, screen, 'unconfirmed', card(copy.unconfirmed, { actions: ['retry', 'back'], tone: 'warning' }));
  if (session.phase === 'completedElsewhere') return message(session, screen, 'elsewhere', card(copy.completedElsewhere, { actions: ['back', 'exit'] }));
  const steps = TRADING_GUIDE_STEPS[session.quest];
  let index = session.step;
  const protection = facts.practice?.protection;
  if (session.quest === 'protection' && index === 0 && protection?.accountId === session.accountId && protection.protectionEditing) index = 1;
  const step = steps[index];
  if (!step || step.screen !== focused) return NONE;
  const form = facts.practice?.[screen];
  if (!form || form.accountId !== session.accountId) return NONE;
  const wantedAssetType = session.quest === 'krStock' ? 'domestic_stock' : session.quest === 'usStock' ? 'us_stock' : 'crypto';
  if ((screen === 'asset' || screen === 'order') && form.assetType && form.assetType !== wantedAssetType) {
    return message(session, screen, 'wrong-market', card({ title: '실습 시장 확인', body: '이번 퀘스트의 시장에 해당하는 종목을 선택해 주세요. 퀘스트 목록으로 돌아가 다시 시작할 수 있어요.' }, { actions: ['back', 'exit'] }));
  }
  const holding = facts.practice?.holdings;
  const review = facts.practice?.limitReview;
  // Holdings are listed under the order form; without a visible holding the
  // practice quantity is prepared here with a normal market buy.
  if (screen === 'order' && ['protection', 'marketSell'].includes(session.quest) && ['asset-holdings', 'asset-protection'].includes(step.target)
    && holding?.accountId === session.accountId && holding.assetId === session.assetId && holding.holdingsVisible === false) {
    return message(session, screen, 'prepare-holding', card({ title: '실습 수량 준비', body: '아래 보유종목에서 현재 종목의 보유수량과 수익률을 확인해 주세요. 보유수량이 없다면 매수를 선택해 시장가로 다시 매수한 뒤 이어서 진행할 수 있어요.' }));
  }
  if (form.blocked) return message(session, screen, 'operationally-unavailable', card({ title: '거래 가능 상태 확인', body: '현재는 화면에 안내된 거래 제한이 적용돼요. 휴장·시세 미준비·운영 중지 상태를 확인해 주세요. 퀘스트 목록으로 돌아가 다른 실습을 선택할 수도 있어요.' }, { actions: ['back', 'exit'] }));
  let ready = !!step.next;
  let hint: string | null = null;
  // Only the order form's own steps depend on the chosen side and type.
  if (screen === 'order' && step.target.startsWith('order-')) {
    const wantedSide = session.quest === 'marketSell' ? 'sell' : 'buy';
    const wantedType = session.quest === 'limitBuy' ? 'limit' : 'market';
    if (form.side !== wantedSide || form.orderType !== wantedType) {
      return spotlight(session, screen, index, 'choose-order', ['order-type'], card({ title: '주문 방식 확인', body: `${wantedSide === 'buy' ? '매수' : '매도'} · ${wantedType === 'limit' ? '지정가' : '시장가'}를 선택해 주세요.` }));
    }
    if (step.target === 'order-input') ready = ready && form.amountValid === true;
  }
  if (step.target === 'asset-holdings' && session.orderId) ready = ready && holding?.accountId === session.accountId && holding.assetId === session.assetId && holding.holdingsVisible === true;
  if (step.target === 'limit-review') ready = ready && review?.accountId === session.accountId && review.orderResolved === true;
  if (step.target === 'protection-editor') ready = ready && protection?.tpSlReady === true;
  if (step.target === 'futures-direction') ready = ready && form.direction === (session.quest === 'futuresShort' ? 'short' : 'long');
  if (step.target === 'futures-margin') ready = ready && (form.leverage ?? 0) > 1;
  if (screen === 'futures' && session.step < 5 && form.positionId) {
    hint = '이 종목에는 포지션이 이미 있어요. 기존 포지션을 전량 종료하거나 다른 종목을 선택한 뒤 새 포지션으로 실습해 주세요. One-way 정책은 그대로 적용돼요.';
  }
  const view = spotlight(session, screen, index, ready ? 'ready' : 'practice', [step.target], card(step, { next: step.next ? ready ? 'enabled' : 'disabled' : null, hint }));
  if (view.kind === 'spotlight') view.card.stepLabel = `${index + 1}/${steps.length}`;
  return view;
}

export function startGuideSession(id: number, accountId: string, quest: BeginnerQuestKey, progress: BeginnerQuests | null): GuideSession | null {
  if (!accountId || !progress) return null;
  if (!canStartQuest(quest, progress)) return null;
  if (isTradingQuest(quest)) {
    const replay = progress[quest].completed;
    const saved = !replay ? progress[quest].steps[0].referenceId : null;
    const assetId = quest === 'limitBuy' ? progress.practice.limitAssetId : progress.practice.spotAssetId;
    const review = !!saved && ['marketBuy', 'limitBuy'].includes(quest);
    const positionId = quest === 'futuresLong' ? progress.practice.longPositionId : quest === 'futuresShort' ? progress.practice.shortPositionId : null;
    return { id, accountId, quest, replay, step: review ? 7 : positionId && !replay ? 5 : 0, phase: 'guiding', summary: null,
      ...(review ? { orderId: saved, assetId: assetId ?? undefined } : {}),
      ...(['protection', 'marketSell'].includes(quest) ? { assetId: progress.practice.spotAssetId ?? undefined } : {}),
      ...(positionId && !replay ? { positionId } : {}) };
  }
  return { id, accountId, quest, replay: progress[quest].completed, step: 1, phase: 'guiding', summary: null };
}

/** Returning to the Wallet root means the practice screen was closed: start it over. */
export function followGuideFocus(session: GuideSession, focused: FocusedGuideScreen): GuideSession {
  if (isTradingQuest(session.quest)) {
    if (session.phase !== 'guiding') return session;
    // The first step that lives on the order screen (marketSell: holdings; protection: all of it).
    const firstOrderStep = session.quest === 'marketSell' ? 1 : session.quest === 'protection' ? 0 : 3;
    if (focused === 'order' && session.step < firstOrderStep) return { ...session, step: firstOrderStep };
    if (focused === 'asset' && session.step === 0 && !['protection', 'marketSell'].includes(session.quest)) return { ...session, step: 1 };
    return session;
  }
  return session.phase === 'guiding' && focused === 'wallet' && session.step !== 1 ? { ...session, step: 1 } : session;
}

export function advanceGuide(session: GuideSession, fromStep: number): GuideSession {
  if (session.phase !== 'guiding') return session;
  return { ...session, step: isTradingQuest(session.quest) ? Math.min(fromStep + 1, TRADING_GUIDE_STEPS[session.quest].length - 1) : Math.min(clampStep(fromStep) + 1, PRACTICE_STEPS) };
}

/** The only commands that can complete each quest on the server. */
export function commandMatchesQuest(quest: BeginnerQuestKey, command: QuestGuideCommand): boolean {
  if (isTradingQuest(quest)) {
    if (quest === 'protection') return command.kind === 'protection' && command.bothLegs;
    if (quest === 'futuresLong' || quest === 'futuresShort') return command.kind === 'futures' && command.direction === (quest === 'futuresLong' ? 'long' : 'short') && command.leverage > 1;
    return command.kind === 'spot' && command.assetType === (quest === 'krStock' ? 'domestic_stock' : quest === 'usStock' ? 'us_stock' : 'crypto')
      && command.side === (quest === 'marketSell' ? 'sell' : 'buy') && command.orderType === (quest === 'limitBuy' ? 'limit' : 'market');
  }
  return quest === 'exchange'
    ? command.kind === 'fx' && command.fromCurrency === 'KRW' && command.toCurrency === 'USD'
    : command.kind === 'transfer' && command.currency === 'USD'
      && command.source === 'securities' && command.destination === 'crypto_spot';
}

/**
 * A screen's committed command. Only a matching command of THIS account and a
 * live session is adopted. First completion waits for ledger-derived progress;
 * a replay succeeds only on this run's committed command, never old progress.
 */
export function claimGuideCommand(session: GuideSession | null, accountId: string, command: QuestGuideCommand): {
  session: GuideSession | null;
  claimed: boolean;
} {
  if (!session || session.phase !== 'guiding' || session.accountId !== accountId || command.accountId !== accountId
    || !commandMatchesQuest(session.quest, command)) {
    return { session, claimed: false };
  }
  if (command.kind === 'spot' && ['marketBuy', 'limitBuy', 'krStock', 'usStock'].includes(session.quest)) {
    return { session: { ...session, step: 7, assetId: command.assetId, orderId: command.orderId, summary: command.summary }, claimed: true };
  }
  if (command.kind === 'protection' && session.assetId && command.assetId !== session.assetId) return { session, claimed: false };
  if (command.kind === 'futures') {
    if (command.operation === 'open') return { session: { ...session, step: 5, positionId: command.positionId, summary: command.summary }, claimed: true };
    if (!['close', 'reduce'].includes(command.operation) || command.quantityAfter !== '0.00000000' && Number(command.quantityAfter) !== 0 || command.positionId !== session.positionId) return { session, claimed: false };
  }
  return { session: { ...session, phase: session.replay ? 'replaySucceeded' : 'verifying', summary: command.summary }, claimed: true };
}

/** A fresh server read decides: celebrate only what the ledger proves. */
export function settleGuideVerification(session: GuideSession, progress: BeginnerQuests | null): GuideSession {
  if (session.phase !== 'verifying') return session;
  return { ...session, phase: progress?.[session.quest].completed ? session.replay ? 'replaySucceeded' : 'celebrating' : 'unconfirmed' };
}

/** Proven without this session's command (e.g. another device): no celebration. */
export function observeGuideProgress(session: GuideSession, progress: BeginnerQuests, commandPending: boolean): GuideSession {
  if (session.phase !== 'guiding' || session.orderId || session.positionId || session.replay || commandPending || !progress[session.quest].completed) return session;
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
