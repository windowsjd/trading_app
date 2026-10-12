jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));
// The generated client's ESM specifiers are a Jest boundary (see other specs);
// the unique-violation error class is the real Prisma runtime one.
jest.mock('../generated/prisma/client', () => {
  const { PrismaClientKnownRequestError } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');
  return {
    InquiryCategory: {
      account: 'account',
      trading: 'trading',
      wallet: 'wallet',
      season_ranking: 'season_ranking',
      bug: 'bug',
      other: 'other',
    },
    Prisma: { PrismaClientKnownRequestError },
  };
});

import { HttpException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { INQUIRY_RATE_LIMIT, InquiriesService } from './inquiries.service';

type Row = {
  id: string;
  userId: string;
  clientRequestId: string;
  category: string;
  title: string;
  content: string;
  createdAt: Date;
};

/* eslint-disable @typescript-eslint/require-await -- the in-memory fake mirrors Prisma's async client methods */
/** In-memory inquiries table with the real unique key (userId, clientRequestId). */
function createService() {
  const rows: Row[] = [];
  let sequence = 0;
  const pick = (row: Row) => ({
    id: row.id,
    category: row.category,
    title: row.title,
    content: row.content,
    createdAt: row.createdAt,
  });
  const prisma = {
    inquiry: {
      findUnique: jest.fn(
        async ({
          where,
        }: {
          where: {
            userId_clientRequestId: { userId: string; clientRequestId: string };
          };
        }) => {
          const key = where.userId_clientRequestId;
          const row = rows.find(
            (item) =>
              item.userId === key.userId &&
              item.clientRequestId === key.clientRequestId,
          );
          return row ? pick(row) : null;
        },
      ),
      count: jest.fn(
        async ({
          where,
        }: {
          where: { userId: string; createdAt?: { gte: Date } };
        }) =>
          rows.filter(
            (row) =>
              row.userId === where.userId &&
              (!where.createdAt || row.createdAt >= where.createdAt.gte),
          ).length,
      ),
      create: jest.fn(
        async ({ data }: { data: Omit<Row, 'id' | 'createdAt'> }) => {
          if (
            rows.some(
              (row) =>
                row.userId === data.userId &&
                row.clientRequestId === data.clientRequestId,
            )
          ) {
            throw new Prisma.PrismaClientKnownRequestError(
              'Unique constraint failed',
              {
                code: 'P2002',
                clientVersion: 'test',
              },
            );
          }
          const row = {
            ...data,
            id: `inquiry-${++sequence}`,
            createdAt: new Date(Date.now() + sequence),
          };
          rows.push(row);
          return pick(row);
        },
      ),
      findMany: jest.fn(
        async ({
          where,
          take,
          skip,
        }: {
          where: { userId: string };
          take: number;
          skip: number;
        }) =>
          rows
            .filter((row) => row.userId === where.userId)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(skip, skip + take)
            .map(pick),
      ),
    },
  };
  const service = new InquiriesService(prisma as never);
  return { service, prisma, rows };
}

const body = (patch: Record<string, unknown> = {}) => ({
  clientRequestId: 'inquiry_0f8b2c1e-1111-4a5e-9c33-2b6f0a7d8e90',
  category: 'trading',
  title: '  주문 체결 문의  ',
  content: '시장가 주문이 체결된 가격을 확인하고 싶습니다.',
  ...patch,
});

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    const response = error.getResponse() as { error: { code: string } };
    return { status: error.getStatus(), code: response.error.code };
  }
  throw new Error('expected a rejection');
}

describe('InquiriesService', () => {
  it('requires an authenticated author for create and list', async () => {
    const { service, prisma } = createService();
    expect(await rejection(service.create(undefined, body()))).toEqual({
      status: 401,
      code: 'UNAUTHORIZED',
    });
    expect(await rejection(service.listMine(undefined))).toEqual({
      status: 401,
      code: 'UNAUTHORIZED',
    });
    expect(prisma.inquiry.create).not.toHaveBeenCalled();
  });

  it('stores a trimmed inquiry and reports a real, non-replayed receipt', async () => {
    const { service, rows } = createService();
    const result = await service.create('user-1', body());
    expect(result.data.replayed).toBe(false);
    expect(result.data.inquiry).toMatchObject({
      category: 'trading',
      title: '주문 체결 문의',
    });
    expect(typeof result.data.inquiry.createdAt).toBe('string');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: 'user-1',
      title: '주문 체결 문의',
    });
  });

  it.each([
    ['missing request id', { clientRequestId: undefined }],
    ['short request id', { clientRequestId: 'abc' }],
    ['unsafe request id', { clientRequestId: 'inquiry 123456789' }],
    ['unknown category', { category: 'refund' }],
    ['non-string category', { category: 3 }],
    ['short title', { title: ' a ' }],
    ['long title', { title: 'x'.repeat(101) }],
    ['non-string title', { title: ['title'] }],
    ['short content', { content: '짧아요' }],
    ['long content', { content: 'x'.repeat(2001) }],
    ['control characters', { content: '정상적인 문의 내용입니다\u0007' }],
  ])('rejects %s without writing', async (_label, patch) => {
    const { service, prisma } = createService();
    expect(await rejection(service.create('user-1', body(patch)))).toEqual({
      status: 400,
      code: 'INVALID_INQUIRY',
    });
    expect(prisma.inquiry.create).not.toHaveBeenCalled();
  });

  it('accepts the exact length limits and multi-line content', async () => {
    const { service } = createService();
    const result = await service.create(
      'user-1',
      body({ title: 'x'.repeat(100), content: `첫 줄\n${'y'.repeat(1990)}` }),
    );
    expect(result.data.inquiry.title).toHaveLength(100);
  });

  it('returns the stored inquiry for a resubmitted request id and never files twice', async () => {
    const { service, rows } = createService();
    const first = await service.create('user-1', body());
    const again = await service.create(
      'user-1',
      body({ title: '주문 체결 문의' }),
    );
    expect(again.data).toEqual({ inquiry: first.data.inquiry, replayed: true });
    expect(rows).toHaveLength(1);
  });

  it('rejects a different inquiry under a used request id', async () => {
    const { service, rows } = createService();
    await service.create('user-1', body());
    expect(
      await rejection(
        service.create(
          'user-1',
          body({ content: '다른 내용의 문의를 같은 키로 보냅니다.' }),
        ),
      ),
    ).toEqual({ status: 409, code: 'INQUIRY_IDEMPOTENCY_CONFLICT' });
    expect(rows).toHaveLength(1);
  });

  it('keeps request ids per user: another user may reuse the same id', async () => {
    const { service, rows } = createService();
    await service.create('user-1', body());
    const other = await service.create('user-2', body());
    expect(other.data.replayed).toBe(false);
    expect(rows.map((row) => row.userId)).toEqual(['user-1', 'user-2']);
  });

  it('a concurrent insert of the same request id resolves to the stored row', async () => {
    const { service, prisma } = createService();
    const original = prisma.inquiry.findUnique.getMockImplementation()!;
    // The first lookup misses (race), the insert then hits the unique key.
    prisma.inquiry.findUnique.mockImplementationOnce(async () => null);
    await service.create('user-1', body());
    prisma.inquiry.findUnique
      .mockImplementationOnce(async () => null)
      .mockImplementation(original);
    const raced = await service.create('user-1', body());
    expect(raced.data.replayed).toBe(true);
  });

  it('limits new inquiries per user window but still answers replays', async () => {
    const { service, rows } = createService();
    for (let index = 0; index < INQUIRY_RATE_LIMIT.count; index++) {
      await service.create(
        'user-1',
        body({ clientRequestId: `inquiry_rate_${index}` }),
      );
    }
    expect(
      await rejection(
        service.create(
          'user-1',
          body({ clientRequestId: 'inquiry_rate_over' }),
        ),
      ),
    ).toEqual({ status: 429, code: 'INQUIRY_RATE_LIMITED' });
    const replay = await service.create(
      'user-1',
      body({ clientRequestId: 'inquiry_rate_0' }),
    );
    expect(replay.data.replayed).toBe(true);
    expect(rows).toHaveLength(INQUIRY_RATE_LIMIT.count);
    expect(
      (
        await service.create(
          'user-2',
          body({ clientRequestId: 'inquiry_rate_other' }),
        )
      ).data.replayed,
    ).toBe(false);
  });

  it('lists only the caller’s inquiries, newest first, with pagination', async () => {
    const { service } = createService();
    await service.create(
      'user-1',
      body({ clientRequestId: 'inquiry_list_1', title: '첫 번째 문의' }),
    );
    await service.create(
      'user-2',
      body({ clientRequestId: 'inquiry_list_2', title: '다른 사용자 문의' }),
    );
    await service.create(
      'user-1',
      body({ clientRequestId: 'inquiry_list_3', title: '두 번째 문의' }),
    );
    const page = await service.listMine('user-1', { limit: '1' });
    expect(page.data.items.map((item) => item.title)).toEqual(['두 번째 문의']);
    expect(page.data.pagination).toEqual({
      limit: 1,
      offset: 0,
      total: 2,
      returned: 1,
      nextOffset: 1,
    });
    const all = await service.listMine('user-1');
    expect(all.data.items.map((item) => item.title)).toEqual([
      '두 번째 문의',
      '첫 번째 문의',
    ]);
  });

  it.each([['0'], ['51'], ['-1'], ['1.5'], ['abc']])(
    'rejects limit %s',
    async (limit) => {
      const { service } = createService();
      expect(await rejection(service.listMine('user-1', { limit }))).toEqual({
        status: 400,
        code: 'INVALID_PAGINATION',
      });
    },
  );
});
