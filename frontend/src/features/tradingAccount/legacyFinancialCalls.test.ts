import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

/**
 * The regression guard for account scope (작업 11 §12).
 *
 * Every legacy financial endpoint resolves the account IMPLICITLY — from the
 * caller's participant row in whatever season is current. That is precisely the
 * failure this work removes: a screen that names an account in its header and
 * then reads a different one from the server. The account-scoped surface exists
 * for all of them now, so a legacy call reappearing on a current financial
 * screen is a regression, not a style preference.
 *
 * It is checked by reading source text rather than by a lint plugin on purpose.
 * A lint rule would be a new tool to install, configure and maintain for one
 * rule; this is nine lines of `readFileSync` in the suite that already runs on
 * every commit, and it fails with the file and symbol named.
 *
 * WHAT IS DELIBERATELY STILL ALLOWED
 * ----------------------------------
 *  - `getCurrentSeason()` on screens that are ABOUT the season (may I join,
 *    what is the public season, which season does the leaderboard default to).
 *    It is banned only where it used to answer a question it cannot: app entry
 *    and per-account trading permission.
 *  - the season RECORD screens, which name an explicit `seasonId` and are about
 *    history rather than the selected account;
 *  - shared market data and the public FX rate, which have no account.
 */

const SRC = path.join(process.cwd(), 'src');

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(full);
    if (!/\.tsx?$/.test(entry.name)) return [];
    if (entry.name.endsWith('.test.ts')) return [];
    return [full];
  });
}

function relative(file: string) {
  return path.relative(SRC, file).replace(/\\/g, '/');
}

/**
 * Comments are stripped before scanning: this file is checking what the code
 * DOES, and the clearest explanation of why a legacy call was removed names
 * that call. A guard that fires on its own rationale trains people to delete
 * the rationale.
 */
function stripComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const ALL_SOURCES = listSourceFiles(SRC).map((file) => ({
  file: relative(file),
  text: stripComments(readFileSync(file, 'utf8')),
}));

/**
 * Legacy implicit-account financial reads and mutations. Each one has an
 * account-scoped replacement taking `accountId` as its first argument.
 */
const FORBIDDEN_SYMBOLS = [
  'getHomeDashboard',
  'getWallets',
  'getWalletTransactions',
  'getPositions',
  'getPositionForAsset',
  'getPositionQuantity',
  'getPortfolioOverview',
  'getPortfolioPositions',
  'getPortfolioEquity',
  'getMyOrders',
  'getOrderDetail',
  'quoteOrder',
  'createOrder',
  'cancelOrder',
  'quoteFx',
  'executeFx',
];

/** Screens whose subject genuinely IS the current/public season. */
const CURRENT_SEASON_ALLOWLIST = new Set([
  'features/season/api.ts',
  'screens/season/SeasonJoinScreen.tsx',
  'screens/ranking/RankingScreen.tsx',
  'screens/record/RecordSeasonListScreen.tsx',
  // Mode selection asks the ALLOWED question — "may this user join the current
  // season?" — to decide whether to offer 시즌 참가하기. The entry ROUTE
  // (home vs mode_selection, in features/auth/entry.ts) still never consults
  // the season, and neither does any per-account capability.
  'screens/entry/ModeSelectionScreen.tsx',
]);

describe('current financial screens never call a legacy implicit-account API', () => {
  it('defines no legacy financial request function anywhere', () => {
    // The strongest form of the rule: the functions do not exist, so no screen
    // can import one by accident and no future screen can revive one quietly.
    for (const symbol of FORBIDDEN_SYMBOLS) {
      const definitions = ALL_SOURCES.filter(({ text }) =>
        new RegExp(`export (async )?function ${symbol}\\b`).test(text),
      ).map(({ file }) => file);

      assert.deepEqual(
        definitions,
        [],
        `${symbol} is a legacy implicit-account call and must not be defined (found in ${definitions.join(', ')}). Use the account-scoped equivalent in features/tradingAccount/api.ts.`,
      );
    }
  });

  it('imports no legacy financial symbol', () => {
    const offenders: string[] = [];

    for (const { file, text } of ALL_SOURCES) {
      for (const match of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/g)) {
        const [, names, source] = match;
        if (!source.includes('features/') && !source.startsWith('../')) continue;

        for (const name of names.split(',').map((part) => part.trim().split(/\s+as\s+/)[0])) {
          if (FORBIDDEN_SYMBOLS.includes(name)) {
            offenders.push(`${file} imports ${name} from ${source}`);
          }
        }
      }
    }

    assert.deepEqual(offenders, [], offenders.join('\n'));
  });

  it('keeps getCurrentSeason out of app entry and per-account gating', () => {
    const importers = ALL_SOURCES.filter(
      ({ text }) => /\bgetCurrentSeason\b/.test(text),
    )
      .map(({ file }) => file)
      .filter((file) => !CURRENT_SEASON_ALLOWLIST.has(file));

    assert.deepEqual(
      importers,
      [],
      `getCurrentSeason() decides season participation only. It must not decide app entry or whether the SELECTED account can trade (found in ${importers.join(', ')}).`,
    );
  });

  it('reads every current financial screen through the account-scoped surface', () => {
    // The positive half: these screens must name an accountId. A screen that
    // silently stopped reading anything would pass the bans above.
    const FINANCIAL_SCREENS = [
      'screens/home/HomeScreen.tsx',
      'screens/home/GeneralAccountHome.tsx',
      'screens/home/SeasonAccountHome.tsx',
      'screens/home/PortfolioScreen.tsx',
      'screens/home/WalletTransactionsScreen.tsx',
      'screens/wallet/WalletFxScreen.tsx',
      'screens/order/OrderScreen.tsx',
      'screens/asset/AssetDetailScreen.tsx',
      'screens/record/RecordOrderListScreen.tsx',
    ];

    for (const screen of FINANCIAL_SCREENS) {
      const source = ALL_SOURCES.find(({ file }) => file === screen);
      assert.ok(source, `${screen} is missing; update this list if it moved.`);
      assert.match(
        source.text,
        /tradingAccount/,
        `${screen} must read the account-scoped surface.`,
      );
    }
  });
});
