import { availableRankings } from '../../src/features/ranking/fixtures';
const params = new URLSearchParams(location.search), tier = params.get('tier') ?? 'master';
const long = params.get('long') === '1', rankType = params.get('final') === '1' ? 'final' : 'daily';
const nickname = long ? '아주긴닉네임대한민국LongNickname'.repeat(3) : '트레이더';
const rows = ['123.45', '-12.34', '0', null].map((returnRate, i) => ({ ...availableRankings.rankings[0], rank: i + 1,
  userId: `row-${i}`, seasonParticipantId: `sp-${i}`, nickname, profileImageUrl: null,
  totalAssetKrw: long ? '1234567890123456.00000000' : '123456789', returnRate,
  provisionalTier: rankType === 'final' ? 'bronze' : tier, finalTier: rankType === 'final' ? tier : 'silver',
}));
const season = { ...availableRankings.season, status: rankType === 'final' ? 'settled' : 'active', joined: true };
export const transport = { requests: [] };
export const apiClient = { get: async path => {
  transport.requests.push(path);
  let data;
  if (path === '/me') data = { id: 'self', nickname: '내 트레이더', profileImageUrl: null };
  else if (path === '/seasons/current') data = season;
  else if (path.startsWith('/ranking?')) {
    const url = new URL(path, location.origin), scope = url.searchParams.get('scope');
    data = { ...availableRankings, season, rankType, rankings: scope === 'friends' ? rows.slice(0, 1) : rows,
      pagination: { limit: Number(url.searchParams.get('limit')), offset: 0, total: scope === 'friends' ? 1 : rows.length, returned: scope === 'friends' ? 1 : rows.length, nextOffset: null },
      myRanking: { ...availableRankings.myRanking, provisionalTier: rankType === 'final' ? 'bronze' : tier, finalTier: rankType === 'final' ? tier : 'silver' },
    };
  } else throw Error(`Unexpected read: ${path}`);
  return { data: { success: true, data } };
} };
export const useRootNavigation = () => ({ navigate: (...args) => { window.lastNavigation = args; } });
