import { availableRankings } from '../../src/features/ranking/fixtures';
const params = new URLSearchParams(location.search), tier = params.get('tier') ?? 'master';
const long = params.get('long') === '1', rankType = params.get('final') === '1' ? 'final' : 'daily';
const nickname = long ? '아주긴닉네임대한민국LongNickname'.repeat(3) : '트레이더';
// row-2 is mine. `?myReturn=` (`none` = unavailable) and `?myTotal=` set its figures, which 내 순위 shows too.
const myReturn = params.get('myReturn') ?? '0', myTotal = params.get('myTotal');
const rows = ['123.45', '-12.34', myReturn === 'none' ? null : myReturn, null].map((returnRate, i) => ({
  ...availableRankings.rankings[0], rank: i + 1, userId: `row-${i}`, seasonParticipantId: `sp-${i}`, nickname, profileImageUrl: null,
  totalAssetKrw: i === 2 && myTotal ? myTotal : long ? '1234567890123456.00000000' : '123456789', returnRate,
  provisionalTier: rankType === 'final' ? 'bronze' : tier, finalTier: rankType === 'final' ? tier : 'silver',
}));
// myRanking is sp-2 (row-2, rank 3) with that row's figures; `?me=none` names a participant outside the list.
const mine = { rank: rows[2].rank, returnRate: rows[2].returnRate, totalAssetKrw: rows[2].totalAssetKrw,
  ...(params.get('me') === 'none' ? { seasonParticipantId: 'sp-none' } : {}) };
const season = { ...availableRankings.season, status: rankType === 'final' ? 'settled' : 'active', joined: true };
export const transport = { requests: [] };

// `?slot=5`: the 순위 안내 slot with all five messages (N = 100, me 31st gold,
// yesterday 35th). `&slotLong=1` lengthens nicknames and multiplies amounts by 1,000.
const slot = params.get('slot') === '5', slotLong = params.get('slotLong') === '1';
const won = (value) => `${slotLong ? `${value}000` : value}.00000000`;
const slotName = (name) => (slotLong ? `${name}아주긴닉네임LongNickname` : name);
const SLOT_PEOPLE = { 1: ['demiant', '10001962', 'master'], 2: ['second', '10001000', 'master'], 3: ['third', '10000500', 'master'],
  23: ['plat', '9972410', 'platinum'], 24: ['gold24', '9970000', 'gold'], 30: ['hana', '9958658', 'gold'], 31: ['mycroft', '9955269', 'gold'] };
const YESTERDAY = '2026-05-06', YESTERDAY_CAPTURED = '2026-05-06T14:55:00.000Z';
const slotSeason = { ...availableRankings.season, status: 'active', joined: true, initialCapitalKrw: won('10000000') };
function slotRanking(url) {
  const limit = Number(url.searchParams.get('limit')), offset = Number(url.searchParams.get('offset'));
  const pagination = { limit, offset, total: 100, returned: 0, nextOffset: null };
  const me = { ...availableRankings.myRanking, seasonParticipantId: 'sp-31', provisionalTier: 'gold', finalTier: null };
  if (url.searchParams.get('rankingDate') === YESTERDAY) {
    return { ...availableRankings, season: slotSeason, rankingDate: YESTERDAY, capturedAt: YESTERDAY_CAPTURED, rankings: [], pagination,
      myRanking: { ...me, rank: 35, totalAssetKrw: won('9900000'), rankingDate: YESTERDAY, capturedAt: YESTERDAY_CAPTURED } };
  }
  const rankings = Object.entries(SLOT_PEOPLE).map(([rank, [name, total, rowTier]]) => ({ ...availableRankings.rankings[0],
    rank: Number(rank), userId: `row-${rank}`, seasonParticipantId: `sp-${rank}`, nickname: rank === '31' ? name : slotName(name),
    profileImageUrl: null, totalAssetKrw: won(total), provisionalTier: rowTier, finalTier: null,
  })).filter((row) => row.rank > offset && row.rank <= offset + limit);
  return { ...availableRankings, season: slotSeason, rankings, pagination: { ...pagination, returned: rankings.length },
    myRanking: { ...me, rank: 31, totalAssetKrw: won('9955269') } };
}

export const apiClient = { get: async path => {
  transport.requests.push(path);
  let data;
  // `?meDelay=ms`: the profile arrives that long after the rest (a card laid out before it).
  if (path === '/me') {
    if (params.get('meDelay')) await new Promise(resolve => setTimeout(resolve, Number(params.get('meDelay'))));
    data = { id: 'self', nickname: long ? `내${nickname}` : '내 트레이더', profileImageUrl: null };
  } else if (path === '/seasons/current') data = slot ? slotSeason : season;
  else if (path.startsWith('/ranking?') && slot) data = slotRanking(new URL(path, location.origin));
  else if (path.startsWith('/ranking?')) {
    const url = new URL(path, location.origin), scope = url.searchParams.get('scope');
    data = { ...availableRankings, season, rankType, rankings: scope === 'friends' ? rows.slice(0, 1) : rows,
      pagination: { limit: Number(url.searchParams.get('limit')), offset: 0, total: scope === 'friends' ? 1 : rows.length, returned: scope === 'friends' ? 1 : rows.length, nextOffset: null },
      myRanking: { ...availableRankings.myRanking, ...mine, provisionalTier: rankType === 'final' ? 'bronze' : tier, finalTier: rankType === 'final' ? tier : 'silver' },
    };
  } else throw Error(`Unexpected read: ${path}`);
  return { data: { success: true, data } };
} };
export const useRootNavigation = () => ({ navigate: (...args) => { window.lastNavigation = args; } });
