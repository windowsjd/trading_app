import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { getAccountDisplay } from '../../features/tradingAccount/accountDisplay.ts';
import { CAPABILITY_BLOCK_MESSAGE } from '../../features/tradingAccount/capabilities.ts';
import {
  ACCOUNT_INTEGRITY_TITLE,
  getAccountIntegrityMessage,
} from '../../features/tradingAccount/accountIntegrityGate.ts';
import {
  ACCOUNT_LIST_ERROR_MESSAGE,
  ACCOUNT_LIST_ERROR_TITLE,
  ACCOUNT_MISSING_MESSAGE,
  ACCOUNT_MISSING_TITLE,
} from '../../features/record/seasonAccountLookup.ts';

/**
 * Layout invariants for the account-scoped screens (작업 10 §B-8).
 *
 * There is no React renderer in this project (`node --test`, no Jest, no
 * testing-library), so these assert the two things that can be checked without
 * one, and that are exactly the two that broke in practice:
 *
 *  1. the DATA is never pre-truncated — a season name is user-supplied content
 *     of unbounded length, and shortening it in the model would make every
 *     screen lie regardless of its styles;
 *  2. the STYLES that keep long text readable are actually present — a status
 *     badge on a `flexShrink: 0` track, a wrapping title with `minWidth: 0`,
 *     and no `numberOfLines` on the messages that explain why a control is
 *     unavailable.
 *
 * Visual review at narrow widths and enlarged font scales is recorded in
 * HANDOVER.md; these lock in the properties that review depends on.
 */

const LONG_SEASON_NAME =
  '2026년 상반기 대한민국 모의투자 챔피언십 시즌 — 국내주식·미국주식·암호화폐 통합 리그';

function seasonAccount(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'season' as const,
    status: 'active' as const,
    openedAt: '2026-05-01T00:00:00.000Z',
    closedAt: null,
    season: {
      seasonId: 's1',
      seasonName: LONG_SEASON_NAME,
      seasonStatus: 'active' as const,
      startAt: '2026-05-01T00:00:00.000Z',
      endAt: '2026-05-31T00:00:00.000Z',
      seasonParticipantId: 'p1',
      participantStatus: 'active' as const,
      joinedAt: '2026-05-01T00:00:00.000Z',
    },
    ...overrides,
  };
}

/** Paths are given from `src/`; `npm test` runs with the frontend dir as cwd. */
function read(sourcePath: string) {
  return readFileSync(path.join(process.cwd(), 'src', sourcePath), 'utf8');
}

describe('long Korean content is never shortened in the model', () => {
  it('keeps a very long season name whole', () => {
    const display = getAccountDisplay(seasonAccount());

    assert.equal(display.title, LONG_SEASON_NAME);
    assert.ok(
      !display.title.includes('…') && !display.title.includes('...'),
      'truncation is a layout decision, never a data one',
    );
  });

  it('always produces a status label, including for closed and suspended', () => {
    // A missing "종료" badge makes a closed account read as live.
    for (const status of ['active', 'suspended', 'closed'] as const) {
      const display = getAccountDisplay(seasonAccount({ status }));
      assert.ok(display.statusLabel.length > 0);
      assert.equal(display.statusTone, status);
    }

    assert.notEqual(
      getAccountDisplay(seasonAccount({ status: 'closed' })).statusLabel,
      getAccountDisplay(seasonAccount({ status: 'active' })).statusLabel,
    );
  });

  it('gives the mode caption and the return-rate meaning separate strings', () => {
    // Two short lines fold better at narrow widths and large font scales than
    // one long sentence.
    const display = getAccountDisplay(seasonAccount());

    assert.ok(display.subtitle && display.subtitle.length > 0);
    assert.ok(display.returnRateLabel.length > 0);
    assert.notEqual(display.subtitle, display.returnRateLabel);
  });

  it('writes full capability messages rather than clipped hints', () => {
    for (const message of Object.values(CAPABILITY_BLOCK_MESSAGE)) {
      assert.ok(message.length >= 10, message);
      assert.ok(message.endsWith('.'), `${message} should be a full sentence`);
    }
  });
});

describe('the styles long text depends on are present', () => {
  it('AccountSwitcher: badge on its own non-shrinking track, title wraps', () => {
    const source = read('components/tradingAccount/AccountSwitcher.tsx');

    // The text column may give way; the badge column never does. (RN flexbox
    // shrinks by default, so `flex: 1, flexShrink: 1` is the idiom here rather
    // than the web's `minWidth: 0`.)
    assert.match(source, /triggerTextColumn:\s*\{[^}]*flexShrink:\s*1/s);
    assert.match(source, /triggerBadgeColumn:\s*\{[^}]*flexShrink:\s*0/s);
    assert.match(source, /rowBadgeColumn:\s*\{[^}]*flexShrink:\s*0/s);
    // A cap, not the overflow strategy.
    assert.match(source, /numberOfLines=\{3\}/);
    assert.ok(
      !/numberOfLines=\{1\}/.test(source),
      'one ellipsised line would hide which account is selected',
    );
  });

  it('AccountSwitcher: the start-general row wraps its copy and its error whole', () => {
    const source = read('components/tradingAccount/AccountSwitcher.tsx');

    // The action row reuses the wrapping text column; the trailing action
    // (spinner or "시작") sits on the non-shrinking badge track.
    assert.match(source, /startRow:\s*\{[^}]*flexDirection:\s*'row'/s);
    assert.match(source, /startError:\s*\{[^}]*lineHeight/s);
    // An offer, not an account: no synthetic id and no fake account row.
    assert.match(source, /switcherStartGeneral/);
    assert.ok(
      !/switcherOption\(\s*['"`]/.test(source),
      'the start CTA must not borrow a hard-coded account-row testID',
    );
  });

  it('ModeSelectionScreen: every option wraps; the page scrolls', () => {
    const source = read('screens/entry/ModeSelectionScreen.tsx');

    // Centred while it fits, scrolling when it does not — same discipline as
    // the setup panel: this is the first screen after login and its copy is
    // long Korean sentences plus a user-supplied season name.
    assert.match(source, /ScrollView/);
    assert.match(source, /content:\s*\{[^}]*flexGrow:\s*1/s);
    // The general card's title shares a row with the status badge: the title
    // wraps, the badge never shrinks away.
    assert.match(source, /cardHeaderTitle:\s*\{[^}]*flexShrink:\s*1/s);
    assert.match(source, /badge:\s*\{[^}]*flexShrink:\s*0/s);
    // Past-season rows: name wraps beside a non-shrinking action label.
    assert.match(source, /pastRowText:\s*\{[^}]*minWidth:\s*0/s);
    assert.match(source, /pastRowAction:\s*\{[^}]*flexShrink:\s*0/s);
    // Errors and body copy carry lineHeight and are never clipped to a line.
    assert.match(source, /errorText:\s*\{[^}]*lineHeight/s);
    assert.match(source, /cardBody:\s*\{[^}]*lineHeight/s);
    assert.ok(
      !/numberOfLines=\{/.test(source),
      'mode selection may not cut a season name or an error message',
    );
  });

  it('OrderScreen: the bound-account header wraps and keeps its badge', () => {
    const source = read('screens/order/OrderScreen.tsx');

    assert.match(source, /accountTitle:\s*\{[^}]*minWidth:\s*0/s);
    assert.match(source, /accountBadge:\s*\{[^}]*flexShrink:\s*0/s);
    assert.ok(
      !/numberOfLines=\{/.test(source),
      'nothing on the order screen may be cut to one line',
    );
  });

  it('AssetDetailScreen: the account badge cannot be shrunk away', () => {
    const source = read('screens/asset/AssetDetailScreen.tsx');

    assert.match(source, /accountBadge:\s*\{[^}]*flexShrink:\s*0/s);
    assert.ok(!/numberOfLines=\{/.test(source));
  });

  it('GeneralAccountHome: amounts wrap and the asset row keeps both columns', () => {
    const source = read('screens/home/GeneralAccountHome.tsx');

    // A ten-plus digit total wraps instead of running off the screen.
    assert.match(source, /big:\s*\{[^}]*flexShrink:\s*1/s);
    assert.match(source, /big:\s*\{[^}]*lineHeight/s);
    // A long asset name wraps; the amount keeps its own track.
    assert.match(source, /positionName:\s*\{[^}]*minWidth:\s*0/s);
    assert.match(source, /positionValue:\s*\{[^}]*flexShrink:\s*0/s);
    assert.ok(!/numberOfLines=\{/.test(source));
  });

  it('SeasonAccountHome: season name, amounts and the rank pair all wrap', () => {
    const source = read('screens/home/SeasonAccountHome.tsx');

    // A user-supplied season name is unbounded; it wraps rather than truncating.
    assert.match(source, /seasonName:\s*\{[^}]*lineHeight/s);
    assert.match(source, /big:\s*\{[^}]*flexShrink:\s*1/s);
    assert.match(source, /big:\s*\{[^}]*lineHeight/s);
    // Rank and tier sit in a two-up row: each half must be allowed to wrap
    // inside itself instead of pushing the other card off screen.
    assert.match(source, /flex:\s*\{[^}]*minWidth:\s*0/s);
    assert.match(source, /positionName:\s*\{[^}]*minWidth:\s*0/s);
    assert.match(source, /positionValue:\s*\{[^}]*flexShrink:\s*0/s);
    assert.ok(!/numberOfLines=\{/.test(source));
  });

  it('AccountSetupPanel: the only screen a user with nothing sees, scrolls', () => {
    const source = read('components/tradingAccount/AccountSetupPanel.tsx');

    // Centred while it fits, scrolling when it does not — the copy here is long
    // and at large font scales `flex: 1` + centring would clip it.
    assert.match(source, /ScrollView/);
    assert.match(source, /content:\s*\{[^}]*flexGrow:\s*1/s);
    assert.match(source, /title:\s*\{[^}]*lineHeight/s);
    assert.match(source, /message:\s*\{[^}]*lineHeight/s);
    assert.match(source, /error:\s*\{[^}]*lineHeight/s);
    assert.ok(!/numberOfLines=\{/.test(source));
  });

  it('error and blocked screens scroll instead of clipping a long message', () => {
    for (const path of [
      'components/states/ErrorState.tsx',
      'components/states/BlockedState.tsx',
    ]) {
      const source = read(path);
      assert.match(source, /ScrollView/);
      assert.match(source, /flexGrow:\s*1/);
      assert.match(source, /lineHeight/);
      assert.ok(
        !/numberOfLines=\{/.test(source),
        `${path}: an error message must never be shown in part`,
      );
    }
  });

  it('CTA buttons wrap a long Korean label instead of cutting it', () => {
    const source = read('components/common/CTAButton.tsx');

    assert.match(source, /paddingHorizontal/);
    assert.match(source, /textAlign:\s*'center'/);
    assert.ok(!/numberOfLines=\{/.test(source));
  });

  it('capability and integrity notices wrap in the FX screen', () => {
    const source = read('screens/wallet/WalletFxScreen.tsx');

    assert.match(source, /blockedMessage:\s*\{[^}]*lineHeight/s);
    assert.ok(!/numberOfLines=\{/.test(source));
  });

  it('RecordOrderList: a long asset name wraps beside its amount, not through it', () => {
    const source = read('screens/record/RecordOrderListScreen.tsx');

    // The name column may wrap and give way; the amount column never shrinks.
    assert.match(source, /rowNameColumn:\s*\{[^}]*flex:\s*1/s);
    assert.match(source, /rowNameColumn:\s*\{[^}]*minWidth:\s*0/s);
    assert.match(source, /alignEnd:\s*\{[^}]*flexShrink:\s*0/s);
    // The season name doubles as this screen's heading.
    assert.match(source, /accountHeader:\s*\{[^}]*lineHeight/s);
    // 취소 중... and 주문 취소 are different lengths; the button wraps either.
    assert.match(source, /cancelButtonText:\s*\{[^}]*lineHeight/s);
    assert.ok(!/numberOfLines=\{/.test(source));
  });

  it('MyScreen: a long nickname or email wraps', () => {
    const source = read('screens/my/MyScreen.tsx');

    assert.match(source, /title:\s*\{[^}]*lineHeight/s);
    assert.match(source, /helper:\s*\{[^}]*lineHeight/s);
    assert.ok(!/numberOfLines=\{/.test(source));
  });

  it('inline section notices wrap their full sentence', () => {
    const source = read('components/states/InlineEmptyState.tsx');

    assert.match(source, /message:\s*\{[^}]*lineHeight/s);
    assert.ok(!/numberOfLines=\{/.test(source));
  });
});

/**
 * The fail-closed copy added in 작업 12 (§3 · §5). These messages are the ONLY
 * thing standing between a user and a screen that quietly reports damaged money
 * as zero, so they are long by necessity — and every one of them renders inside
 * `ErrorState`, which scrolls and never truncates (asserted above).
 */
describe('fail-closed copy is complete, plain, and never claims absence', () => {
  it('the integrity message names the failed sections and denies "0"', () => {
    const message = getAccountIntegrityMessage(['지갑', '보유 종목']);

    assert.ok(message.includes('지갑'));
    assert.ok(message.includes('보유 종목'));
    // The whole point: this is not an empty account.
    assert.match(message, /0이라는 뜻이 아닙니다/);
    assert.match(message, /고객센터/);
    assert.ok(!message.includes('…') && !message.includes('...'));
  });

  it('the integrity message never reads as an empty state or a 준비 중 notice', () => {
    for (const sections of [['순위'], ['지갑'], ['자산 추이'], []]) {
      const message = getAccountIntegrityMessage(sections);

      assert.ok(!/데이터가 없습니다/.test(message), message);
      assert.ok(!/준비 중/.test(message), message);
      assert.ok(message.endsWith('.'), message);
    }
  });

  it('the fail-closed title says the data cannot be shown, not that it is empty', () => {
    assert.match(ACCOUNT_INTEGRITY_TITLE, /안전하게 표시할 수 없습니다/);
    // "데이터가 없습니다" and "준비 중" are the two readings this must not have.
    assert.ok(!/데이터가 없습니다|준비 중/.test(ACCOUNT_INTEGRITY_TITLE));
  });

  it('account-list failure and a missing season account read differently', () => {
    assert.notEqual(ACCOUNT_LIST_ERROR_TITLE, ACCOUNT_MISSING_TITLE);
    assert.notEqual(ACCOUNT_LIST_ERROR_MESSAGE, ACCOUNT_MISSING_MESSAGE);

    // The missing-account copy must not be mistaken for "you made no trades".
    assert.match(ACCOUNT_MISSING_MESSAGE, /거래 내역이 없다는 뜻이 아니라/);
    assert.match(ACCOUNT_MISSING_MESSAGE, /계정 연결/);
    // The list-failure copy points at the thing that actually failed.
    assert.match(ACCOUNT_LIST_ERROR_MESSAGE, /계정 목록/);

    for (const message of [ACCOUNT_LIST_ERROR_MESSAGE, ACCOUNT_MISSING_MESSAGE]) {
      assert.ok(message.endsWith('.'), message);
      assert.ok(!message.includes('…') && !message.includes('...'), message);
    }
  });

  it('every fail-closed string is a full sentence a user can report', () => {
    const strings = [
      ACCOUNT_INTEGRITY_TITLE,
      ACCOUNT_LIST_ERROR_TITLE,
      ACCOUNT_LIST_ERROR_MESSAGE,
      ACCOUNT_MISSING_TITLE,
      ACCOUNT_MISSING_MESSAGE,
      getAccountIntegrityMessage(['지갑']),
    ];

    for (const value of strings) {
      assert.ok(value.length >= 10, value);
      assert.ok(value.endsWith('.'), value);
      // No placeholder or debug residue reaching a user.
      assert.ok(!/undefined|null|\{\{/.test(value), value);
    }
  });
});

describe('an account switch cannot leave the previous account on screen', () => {
  it('WalletFxScreen gates every FX callback on the request scope', () => {
    const source = read('screens/wallet/WalletFxScreen.tsx');

    // Success/error handlers compare the RESPONSE's scope, not a render
    // closure, before touching quote/success/error state.
    assert.match(source, /isFxQuoteResponseCurrent\(variables\.scope/);
    assert.match(source, /isFxResponseInScope\(variables\.scope/);
    // Cache invalidation is keyed by the account that actually moved.
    assert.match(
      source,
      /invalidateAfterFx\(\s*queryClient,\s*variables\.scope\.accountId/s,
    );
    assert.ok(
      !/invalidateAfterFx\(queryClient, accountId/.test(source),
      'invalidating the CURRENT selection would refresh the wrong account',
    );
    // The success sheet is bound to successData, which the scope gate owns.
    assert.match(source, /visible=\{!!successData\}/);
  });
});
