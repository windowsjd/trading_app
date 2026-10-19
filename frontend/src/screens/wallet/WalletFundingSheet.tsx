import React, { useCallback, useRef, useState } from 'react';
import InlineBottomSheet from '../../components/common/InlineBottomSheet';
import { SheetPortal } from '../../components/common/ScreenSheetHost';
import { questNavigationAllowed } from '../../features/quest/questNavigationGuard';
import type { UsdWalletScope } from '../../features/wallet/walletFunding';
import WalletTransferPanel, { type TransferDraft } from './WalletTransferSheet';
import WalletFxPanel from './WalletFxSheet';

/** What a screen asks to open: 이체 (into a wallet) or 환전 (in a direction). */
export type FundingRequest =
  | { kind: 'transfer'; destination?: UsdWalletScope; source?: UsdWalletScope }
  | { kind: 'fx'; fromCurrency?: 'KRW' | 'USD' };

type Open =
  | { kind: 'transfer'; draft: Partial<TransferDraft>; notice: string | null }
  | { kind: 'fx'; fromCurrency: 'KRW' | 'USD'; returnTo: TransferDraft | null };

const BACK_FROM_EXCHANGE = '환전이 완료되었습니다. 받은 금액을 확인한 뒤 이체하기를 다시 눌러주세요.';

function opened(request: FundingRequest): Open {
  return request.kind === 'fx'
    ? { kind: 'fx', fromCurrency: request.fromCurrency ?? 'KRW', returnTo: null }
    : { kind: 'transfer', draft: { source: request.source, destination: request.destination }, notice: null };
}

/**
 * The wallet's money-moving sheet (이체 / 환전) over the screen that asked for
 * it — the Wallet tab, or an order screen whose wallet needs money — one at a
 * time, never stacked. From a transfer whose 증권 USD wallet holds nothing,
 * 환전하기 › steps to 환전 (KRW → USD) in the same sheet and comes back to the
 * same transfer (wallets and amount kept, balances read again): nothing is
 * sent until 이체하기 is pressed again. Closing that 환전 also returns to it.
 * `closeOnSuccess`: an order screen goes back to its form after a completed
 * transfer or exchange; the Wallet keeps the receipt.
 */
export default function WalletFundingSheet({ request, visible, onClose, onGoMarket, closeOnSuccess = false, testID }: {
  request: FundingRequest | null;
  /** The host screen is in front (a sheet never stays over another screen). */
  visible: boolean;
  onClose: () => void;
  onGoMarket?: () => void;
  closeOnSuccess?: boolean;
  /** Prefix: `${testID}-transfer-sheet` / `${testID}-fx-sheet`. */
  testID: string;
}) {
  // Each request (a new object per press) starts its own sheet, read straight
  // from it: a step taken inside (환전 and back) or a busy flag belongs to the
  // request it was taken under, so a new press never shows the old one's state.
  const [step, setStep] = useState<{ request: FundingRequest; open: Open } | null>(null);
  const [busyFor, setBusyFor] = useState<FundingRequest | null>(null);
  const open = !request ? null : step?.request === request ? step.open : opened(request);
  const busy = !!request && busyFor === request;
  const setOpen = (next: Open) => { if (request) setStep({ request, open: next }); };
  // Stable per request: the panels report busy from effects keyed on it.
  const setBusy = useCallback((value: boolean) => setBusyFor(value ? request : null), [request]);
  // A new request is a new panel, never the last one's inputs.
  const sequence = useRef<{ request: FundingRequest | null; n: number }>({ request: null, n: 0 });
  if (sequence.current.request !== request) sequence.current = { request, n: sequence.current.n + 1 };
  const panelKey = (kind: Open['kind']) => `${kind}-${sequence.current.n}`;
  const close = () => {
    // An 환전 reached from a transfer goes back to that transfer.
    if (open?.kind === 'fx' && open.returnTo) setOpen({ kind: 'transfer', draft: open.returnTo, notice: null });
    else onClose();
  };
  const fx = open?.kind === 'fx';
  const returnTo = open?.kind === 'fx' ? open.returnTo : null;
  return (
    <SheetPortal>
      <InlineBottomSheet testID={`${testID}-${fx ? 'fx' : 'transfer'}-sheet`} title={fx ? '환전하기' : '이체하기'}
        visible={visible && !!open} dismissible={!busy} onClose={close}>
        {open?.kind === 'transfer' ? (
          <WalletTransferPanel key={panelKey('transfer')} initial={open.draft} notice={open.notice} onDone={onClose}
            onGoMarket={closeOnSuccess ? undefined : onGoMarket} onBusyChange={setBusy}
            onSucceeded={closeOnSuccess ? onClose : undefined}
            onExchange={(draft) => {
              // 환전 is its own guided practice: a quest that holds it says why.
              if (questNavigationAllowed('WalletFx')) setOpen({ kind: 'fx', fromCurrency: 'KRW', returnTo: draft });
            }} />
        ) : open?.kind === 'fx' ? (
          <WalletFxPanel key={panelKey('fx')} initialFromCurrency={open.fromCurrency} onBusyChange={setBusy}
            onDone={close} onGoMarket={closeOnSuccess ? undefined : onGoMarket}
            onExchanged={returnTo
              ? () => setOpen({ kind: 'transfer', draft: returnTo, notice: BACK_FROM_EXCHANGE })
              : closeOnSuccess ? () => onClose() : undefined} />
        ) : null}
      </InlineBottomSheet>
    </SheetPortal>
  );
}
