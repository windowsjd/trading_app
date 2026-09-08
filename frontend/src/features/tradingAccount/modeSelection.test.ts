import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CurrentSeasonDto } from '../../models/dto/season.ts';
import type { SelectableAccount } from './accountSelection.ts';
import { buildModeSelectionModel, hasGeneralAccount } from './modeSelection.ts';

/**
 * What the mode-selection screen may OFFER, per user shape (작업 13 §3·§13).
 *
 * These are the product scenarios from the work order: season-only,
 * general-only, both, nothing, and past-seasons-only users must each see an
 * honest set of options — and never an auto-decision.
 */

const NOW = new Date('2026-08-10T05:00:00.000Z');

function seasonAccount(
  id: string,
  overrides: {
    status?: SelectableAccount['status'];
    seasonId?: string;
    seasonStatus?: string;
    participantStatus?: string;
    openedAt?: string;
  } = {},
): SelectableAccount {
  return {
    id,
    mode: 'season',
    status: overrides.status ?? 'active',
    openedAt: overrides.openedAt ?? '2026-07-01T00:00:00.000Z',
    closedAt: null,
    season: {
      seasonId: overrides.seasonId ?? `season-of-${id}`,
      seasonName: `시즌 ${id}`,
      seasonStatus: (overrides.seasonStatus ?? 'active') as never,
      startAt: '2026-07-01T00:00:00.000Z',
      endAt: '2026-09-30T00:00:00.000Z',
      seasonParticipantId: `sp-${id}`,
      participantStatus: (overrides.participantStatus ?? 'active') as never,
      joinedAt: '2026-07-01T00:00:00.000Z',
    },
  };
}

function generalAccount(
  id: string,
  overrides: { status?: SelectableAccount['status']; openedAt?: string } = {},
): SelectableAccount {
  return {
    id,
    mode: 'general',
    status: overrides.status ?? 'active',
    openedAt: overrides.openedAt ?? '2026-06-01T00:00:00.000Z',
    closedAt: null,
    season: null,
  };
}

function currentSeason(
  overrides: Partial<CurrentSeasonDto> = {},
): CurrentSeasonDto {
  return {
    id: 'season-1',
    name: 'Season 1',
    status: 'active',
    startAt: '2026-07-01T00:00:00.000Z',
    endAt: '2026-09-30T00:00:00.000Z',
    initialCapitalKrw: '10000000',
    tradeFeeRate: '0.0005',
    fxFeeRate: '0.001',
    joined: false,
    joinedAt: null,
    ...overrides,
  };
}

describe('buildModeSelectionModel — 일반 투자 column', () => {
  it('offers STARTING a general account to a season-only user (13.1)', () => {
    const model = buildModeSelectionModel(
      [seasonAccount('s1')],
      currentSeason({ joined: true }),
      NOW,
    );

    assert.deepEqual(model.general, { kind: 'start' });
    assert.deepEqual(
      model.seasonContinue.map((account) => account.id),
      ['s1'],
    );
  });

  it('offers the EXISTING general account, never a second one (13.2)', () => {
    const general = generalAccount('g1');
    const model = buildModeSelectionModel([general], null, NOW);

    assert.deepEqual(model.general, { kind: 'existing', account: general });
  });

  it('still offers a suspended or closed general account as itself', () => {
    const closed = generalAccount('g1', { status: 'closed' });
    const model = buildModeSelectionModel([closed], null, NOW);

    // One general account per user for life: "start another" would be a lie.
    assert.deepEqual(model.general, { kind: 'existing', account: closed });
  });

  it('prefers the active general account if several ever existed', () => {
    const active = generalAccount('g-active');
    const closed = generalAccount('g-closed', {
      status: 'closed',
      openedAt: '2026-07-15T00:00:00.000Z',
    });
    const model = buildModeSelectionModel([closed, active], null, NOW);

    assert.equal(
      model.general.kind === 'existing' ? model.general.account.id : null,
      'g-active',
    );
  });
});

describe('buildModeSelectionModel — 시즌 투자 column', () => {
  it('offers continuing the season the user is competing in, without a join CTA', () => {
    const model = buildModeSelectionModel(
      [seasonAccount('s1', { seasonId: 'season-1' })],
      currentSeason({ id: 'season-1', joined: true }),
      NOW,
    );

    assert.deepEqual(
      model.seasonContinue.map((account) => account.id),
      ['s1'],
    );
    assert.deepEqual(model.seasonJoin, { kind: 'none' });
    assert.deepEqual(model.seasonPast, []);
  });

  it('offers JOINING an active season the user has not joined (13.2·13.4)', () => {
    const general = generalAccount('g1');
    const model = buildModeSelectionModel(
      [general],
      currentSeason(),
      NOW,
    );

    assert.deepEqual(model.seasonJoin, {
      kind: 'available',
      seasonId: 'season-1',
      seasonName: 'Season 1',
    });
    assert.deepEqual(model.seasonContinue, []);
    assert.deepEqual(model.general, { kind: 'existing', account: general });
  });

  it('offers no join when there is no season at all', () => {
    const model = buildModeSelectionModel([generalAccount('g1')], null, NOW);

    assert.deepEqual(model.seasonJoin, { kind: 'none' });
  });

  it('offers no join for an upcoming or ended season', () => {
    const upcoming = buildModeSelectionModel(
      [],
      currentSeason({
        startAt: '2026-09-01T00:00:00.000Z',
        endAt: '2026-12-01T00:00:00.000Z',
      }),
      NOW,
    );
    const ended = buildModeSelectionModel(
      [],
      currentSeason({
        status: 'ended',
        startAt: '2026-01-01T00:00:00.000Z',
        endAt: '2026-02-01T00:00:00.000Z',
      }),
      NOW,
    );

    assert.deepEqual(upcoming.seasonJoin, { kind: 'none' });
    assert.deepEqual(ended.seasonJoin, { kind: 'none' });
  });

  it('offers no join when the owned list already holds that season — even if the season answer is stale', () => {
    const model = buildModeSelectionModel(
      [seasonAccount('s1', { seasonId: 'season-1' })],
      // Server says not joined (stale), but the account list knows better.
      currentSeason({ id: 'season-1', joined: false }),
      NOW,
    );

    assert.deepEqual(model.seasonJoin, { kind: 'none' });
  });

  it('does not offer joining when membership is known but the account list is stale', () => {
    const model = buildModeSelectionModel(
      [generalAccount('g1')],
      currentSeason({ joined: true }),
      NOW,
    );
    assert.deepEqual(model.seasonJoin, { kind: 'none' });
  });

  it('honours server effective mode and expired dates despite an active status', () => {
    for (const overrides of [
      { effectiveMode: 'upcoming' },
      { effectiveMode: 'ended' },
      { effectiveMode: 'settled' },
      { effectiveStatus: 'ended' },
      { endAt: '2026-08-01T00:00:00.000Z' },
      { status: 'settled' },
    ] satisfies Partial<CurrentSeasonDto>[]) {
      const general = generalAccount('g1');
      const model = buildModeSelectionModel([general], currentSeason(overrides), NOW);
      assert.deepEqual(model.seasonJoin, { kind: 'none' });
      assert.deepEqual(model.general, { kind: 'existing', account: general });
    }
  });

  it('keeps general and past accounts available when the season lookup has no usable result', () => {
    const general = generalAccount('g1');
    const past = seasonAccount('old', { status: 'closed', seasonStatus: 'settled' });
    for (const unavailable of [null, undefined]) {
      const model = buildModeSelectionModel([general, past], unavailable, NOW);
      assert.deepEqual(model.seasonJoin, { kind: 'none' });
      assert.deepEqual(model.general, { kind: 'existing', account: general });
      assert.deepEqual(model.seasonPast, [past]);
    }
  });

  it('offers the current season alongside past accounts without fabricating an account or shortening its name', () => {
    const past = seasonAccount('old', { status: 'closed', seasonStatus: 'settled' });
    const accounts = [generalAccount('g1'), past];
    const before = structuredClone(accounts);
    const name = '대한민국 모의투자 챔피언십 국내주식 미국주식 암호화폐 통합 시즌 '.repeat(4);
    const model = buildModeSelectionModel(accounts, currentSeason({ name }), NOW);
    assert.deepEqual(model.seasonJoin, {
      kind: 'available', seasonId: 'season-1', seasonName: name,
    });
    assert.deepEqual(model.seasonPast, [past]);
    assert.deepEqual(accounts, before);
  });

  it('shows both options to a user holding general + active season (13.3), deciding nothing', () => {
    const general = generalAccount('g1');
    const season = seasonAccount('s1', { seasonId: 'season-1' });
    const model = buildModeSelectionModel(
      [general, season],
      currentSeason({ id: 'season-1', joined: true }),
      NOW,
    );

    assert.equal(model.general.kind, 'existing');
    assert.deepEqual(
      model.seasonContinue.map((account) => account.id),
      ['s1'],
    );
    assert.deepEqual(model.seasonJoin, { kind: 'none' });
  });
});

describe('buildModeSelectionModel — past seasons (13.5)', () => {
  it('lists ended/settled season accounts as history, never as "continue"', () => {
    const past = seasonAccount('s-old', {
      status: 'closed',
      seasonStatus: 'settled',
      participantStatus: 'rewarded',
      openedAt: '2026-01-01T00:00:00.000Z',
    });
    const model = buildModeSelectionModel(
      [past, generalAccount('g1')],
      null,
      NOW,
    );

    assert.deepEqual(model.seasonContinue, []);
    assert.deepEqual(
      model.seasonPast.map((account) => account.id),
      ['s-old'],
    );
  });

  it('treats an ended-but-unsettled season account as past, not as a live start', () => {
    const endedSeason = seasonAccount('s-ended', { seasonStatus: 'ended' });
    const model = buildModeSelectionModel([endedSeason], null, NOW);

    assert.deepEqual(model.seasonContinue, []);
    assert.deepEqual(
      model.seasonPast.map((account) => account.id),
      ['s-ended'],
    );
    // The user can still REACH their history without opening anything new.
    assert.deepEqual(model.general, { kind: 'start' });
  });

  it('treats an excluded participant as not competing', () => {
    const excluded = seasonAccount('s-x', { participantStatus: 'excluded' });
    const model = buildModeSelectionModel([excluded], null, NOW);

    assert.deepEqual(model.seasonContinue, []);
    assert.deepEqual(
      model.seasonPast.map((account) => account.id),
      ['s-x'],
    );
  });
});

describe('hasGeneralAccount', () => {
  it('is false only when NO general account exists in any status', () => {
    assert.equal(hasGeneralAccount([]), false);
    assert.equal(hasGeneralAccount([seasonAccount('s1')]), false);
    assert.equal(hasGeneralAccount([generalAccount('g1')]), true);
    assert.equal(
      hasGeneralAccount([generalAccount('g1', { status: 'closed' })]),
      true,
    );
  });
});
