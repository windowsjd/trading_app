import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, it } from 'node:test';

import { toSeasonJoinViewState } from '../../features/season/mapper.ts';
import type { CurrentSeasonDto } from '../../models/dto/season.ts';

// Like accountLayout.test.ts, these check screen wiring without adding a
// native renderer. Eligibility itself is exercised in modeSelection.test.ts.
const switcher = readFileSync(new URL('./AccountSwitcher.tsx', import.meta.url), 'utf8');
const joinScreen = readFileSync(new URL('../../screens/season/SeasonJoinScreen.tsx', import.meta.url), 'utf8');

describe('AccountSwitcher season entry wiring', () => {
  it('uses the shared read-only season query and eligibility model without gating account selection on it', () => {
    assert.match(switcher, /queryKey: QUERY_KEYS\.season\.current,\s*queryFn: getCurrentSeason,\s*enabled: open/);
    assert.match(switcher, /buildModeSelectionModel\(\s*accounts,\s*seasonQuery\.isSuccess \? seasonQuery\.data : null/);
    assert.doesNotMatch(switcher, /if\s*\([^)]*seasonQuery\./);
    assert.match(switcher, /accounts\.map\(\(account\) => \([\s\S]*?account=\{account\}[\s\S]*?selectAccount\(account\.id\);\s*setOpen\(false\)/);
    assert.doesNotMatch(switcher, /\bjoinSeason\b|\buseMutation\b|\.mutate\(|apiClient\.(post|put|patch)/);
  });

  it('offers navigation only for an available season, closes the sheet first, and retains general start', () => {
    assert.match(switcher, /seasonJoin\.kind === 'available' \? \([\s\S]*?seasonJoin\.seasonName[\s\S]*?testID=\{TEST_IDS\.tradingAccount\.switcherSeasonJoin\}[\s\S]*?label="시즌 참가하기"[\s\S]*?setOpen\(false\);\s*rootNavigation\.navigate\('SeasonJoin'\)/);
    assert.match(switcher, /rootNavigation = useRootNavigation\(\)/);
    assert.match(switcher, /!hasGeneralAccount\(accounts\)[\s\S]*?onPress=\{startGeneral\.start\}/);
  });

  it('scrolls the title and all rows within the viewport and gives the offer full-width wrapping text', () => {
    assert.match(switcher, /<ScrollView\s*testID=\{TEST_IDS\.tradingAccount\.switcherSheet\}\s*style=\{\{ maxHeight: Math\.min\(480, height \* 0\.7\) \}\}/);
    const offer = switcher.slice(switcher.indexOf("{seasonJoin.kind === 'available'"), switcher.indexOf('{!hasGeneralAccount'));
    assert.doesNotMatch(offer, /numberOfLines|ellipsizeMode/);
    assert.match(offer, /현재 진행 중인 시즌입니다\./);
    assert.match(offer, /아직 참가하지 않았습니다\./);
    assert.match(switcher, /seasonJoinBox:\s*\{\s*flexDirection: 'column',\s*alignItems: 'stretch',\s*minWidth: 0/);
  });
});

describe('SeasonJoinScreen actions', () => {
  const active: CurrentSeasonDto = {
    id: 'season-1', name: 'Season 1', status: 'active', effectiveMode: 'active',
    startAt: '2026-07-01T00:00:00Z', endAt: '2026-09-30T00:00:00Z',
    initialCapitalKrw: '10000000', tradeFeeRate: '0.0005', fxFeeRate: '0.001',
    joined: false, joinedAt: null,
  };

  it('keeps explicit active-season joining and the no-account general entrance, with no browse shortcut', () => {
    assert.equal(toSeasonJoinViewState(active), 'season_active_not_joined_view');
    assert.match(joinScreen, /label=\{joinMutation\.isPending \? '참가 처리 중\.\.\.' : '시즌 참가하기'\}/);
    assert.match(joinScreen, /joinMutation\.mutate\(season\.id\)/);
    assert.doesNotMatch(joinScreen, /지금은 둘러보기/);
    assert.match(joinScreen, /!hasUsableAccount \? \([\s\S]*?setShowGeneralSetup\(true\)[\s\S]*?일반 투자 계정으로 시작하기/);
  });

  it('preserves home actions for missing, upcoming, ended, settled, and joined seasons', () => {
    for (const [season, expected] of [
      [null, 'season_not_configured_view'],
      [{ ...active, effectiveMode: 'upcoming' }, 'season_upcoming_view'],
      [{ ...active, effectiveMode: 'ended' }, 'season_ended_unsettled_view'],
      [{ ...active, effectiveMode: 'settled' }, 'season_settled_view'],
    ] as const) {
      assert.equal(toSeasonJoinViewState(season), expected);
      const start = joinScreen.indexOf(`if (viewState === '${expected}')`);
      assert.ok(start >= 0, `missing branch: ${expected}`);
      const end = joinScreen.indexOf('\n  if (', start + 1);
      const branch = joinScreen.slice(start, end);
      assert.match(branch, /actionLabel="홈으로 이동"/);
      assert.match(branch, /onAction=\{resetToHome\}/);
    }
    assert.equal(toSeasonJoinViewState({ ...active, joined: true }), 'season_join_success');
    assert.match(joinScreen, /viewState === 'season_join_success' \|\|[\s\S]*?label="홈으로 이동"\s*onPress=\{resetToHome\}/);
  });

  it('retains refetch, real season-account selection, and home navigation after joining or already-joined', () => {
    assert.match(joinScreen, /const refreshed = await refetchAccounts\(\);[\s\S]*?findAccountForSeason\([\s\S]*?selectAccount\(joinedAccount\.id\)/);
    assert.match(joinScreen, /await selectJoinedSeasonAccount\(result\.seasonId\);\s*resetToHome\(\)/);
    assert.match(joinScreen, /if \(code === ERROR_CODE\.SEASON_ALREADY_JOINED\) \{\s*await selectJoinedSeasonAccount\(seasonId\)/);
    assert.match(joinScreen, /if \(code === ERROR_CODE\.SEASON_ALREADY_JOINED\) \{\s*resetToHome\(\)/);
  });
});
