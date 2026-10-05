// Existing screen/navigation/account fixtures; image transport uses local HTTP.
import { apiClient as baseClient } from './rootTabsMocks';
export * from './rootTabsMocks';

async function local(path, options) {
  const response = await fetch(`/api/v1${path}`, options);
  const data = await response.json();
  if (!response.ok) throw new Error('Fixture image request failed');
  return { data };
}

export const apiClient = {
  async get(path, options) {
    if (path === '/me') return local(path);
    const result = await baseClient.get(path, options);
    if (path.startsWith('/ranking?')) {
      const me = (await local('/me')).data.data;
      // The first test rank is the current viewer; keep other rows unchanged.
      if (result.data.data.rankings?.[0]) {
        Object.assign(result.data.data.rankings[0], { userId: me.id, nickname: me.nickname, profileImageUrl: me.profileImageUrl });
      }
      if (result.data.data.myRanking?.state === 'available') {
        Object.assign(result.data.data.myRanking, { userId: me.id, profileImageUrl: me.profileImageUrl });
      }
    }
    return result;
  },
  post: (path, form) => local(path, { method: 'POST', body: form }),
  delete: (path) => local(path, { method: 'DELETE' }),
  patch: (path, data) => local(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
};
