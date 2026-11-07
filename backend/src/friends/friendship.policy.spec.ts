import { readPortfolioAccess } from './friendship.policy';

type Target = {
  status: string;
  portfolioPublic: boolean;
  friendshipsLow: Array<{ id: string }>;
  friendshipsHigh: Array<{ id: string }>;
};

/** One user lookup; the fake returns the row as the database would after the filters. */
function prisma(target: Target | null) {
  return { user: { findUnique: jest.fn(() => Promise.resolve(target)) } };
}

const accepted = [{ id: 'friendship-1' }];
const target = (patch: Partial<Target> = {}): Target => ({
  status: 'active',
  portfolioPublic: true,
  friendshipsLow: [],
  friendshipsHigh: [],
  ...patch,
});

describe('readPortfolioAccess', () => {
  it('lets the owner read their own portfolio without a friendship or the sharing switch', async () => {
    for (const portfolioPublic of [true, false]) {
      const db = prisma(target({ portfolioPublic }));
      await expect(
        readPortfolioAccess(db as never, 'user-1', 'user-1'),
      ).resolves.toBe('available');
    }
  });

  it('keeps an inactive or missing owner unavailable', async () => {
    for (const status of ['suspended', 'deleted']) {
      await expect(
        readPortfolioAccess(
          prisma(target({ status })) as never,
          'user-1',
          'user-1',
        ),
      ).resolves.toBe('unavailable');
    }
    await expect(
      readPortfolioAccess(prisma(null) as never, 'user-1', 'user-1'),
    ).resolves.toBe('unavailable');
  });

  it('leaves every other viewer on the accepted-friendship and sharing rules', async () => {
    const cases: Array<[Target | null, string]> = [
      [target(), 'not_friend'],
      [target({ portfolioPublic: false }), 'not_friend'],
      [target({ friendshipsLow: accepted }), 'available'],
      [target({ friendshipsHigh: accepted }), 'available'],
      [target({ friendshipsLow: accepted, portfolioPublic: false }), 'private'],
      [
        target({ friendshipsLow: accepted, status: 'suspended' }),
        'unavailable',
      ],
      [null, 'unavailable'],
    ];
    for (const [row, access] of cases) {
      await expect(
        readPortfolioAccess(prisma(row) as never, 'viewer-1', 'user-1'),
      ).resolves.toBe(access);
    }
  });

  it('counts only accepted friendships with the viewer, in either direction', async () => {
    const db = prisma(target());
    await readPortfolioAccess(db as never, 'viewer-1', 'user-1');
    expect(db.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: {
        status: true,
        portfolioPublic: true,
        friendshipsLow: {
          where: { highUserId: 'viewer-1', status: 'accepted' },
          select: { id: true },
        },
        friendshipsHigh: {
          where: { lowUserId: 'viewer-1', status: 'accepted' },
          select: { id: true },
        },
      },
    });
  });
});
