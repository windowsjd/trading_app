jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    Prisma: {
      Decimal,
    },
  };
});

import { buildSeasonRankingRows } from './portfolio-ranking.policy';

describe('portfolio ranking policy', () => {
  it('sorts by totalAssetKrw desc, returnRate desc, capturedAt asc, participant id asc', () => {
    const rows = buildSeasonRankingRows([
      {
        seasonParticipantId: 'sp-3',
        totalAssetKrw: '1000.00000000',
        returnRate: '1.00000000',
        capturedAt: new Date('2026-05-07T00:00:03.000Z'),
      },
      {
        seasonParticipantId: 'sp-2',
        totalAssetKrw: '1000.00000000',
        returnRate: '2.00000000',
        capturedAt: new Date('2026-05-07T00:00:02.000Z'),
      },
      {
        seasonParticipantId: 'sp-1',
        totalAssetKrw: '2000.00000000',
        returnRate: '0.00000000',
        capturedAt: new Date('2026-05-07T00:00:01.000Z'),
      },
      {
        seasonParticipantId: 'sp-0',
        totalAssetKrw: '1000.00000000',
        returnRate: '1.00000000',
        capturedAt: new Date('2026-05-07T00:00:03.000Z'),
      },
    ]);

    expect(rows).toEqual([
      {
        rank: 1,
        seasonParticipantId: 'sp-1',
        totalAssetKrw: '2000.00000000',
        returnRate: '0.00000000',
      },
      {
        rank: 2,
        seasonParticipantId: 'sp-2',
        totalAssetKrw: '1000.00000000',
        returnRate: '2.00000000',
      },
      {
        rank: 3,
        seasonParticipantId: 'sp-0',
        totalAssetKrw: '1000.00000000',
        returnRate: '1.00000000',
      },
      {
        rank: 4,
        seasonParticipantId: 'sp-3',
        totalAssetKrw: '1000.00000000',
        returnRate: '1.00000000',
      },
    ]);
  });
});
