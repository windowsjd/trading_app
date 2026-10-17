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
    InquiryCategory: { bug: 'bug', wallet: 'wallet' },
    OperatorAuditResult: { success: 'success', failure: 'failure' },
    UserRole: { user: 'user', operator: 'operator', admin: 'admin' },
    Prisma: { PrismaClientKnownRequestError },
  };
});

import { HttpException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { OperatorInquiriesService } from './operator-inquiries.service';

type Answer = {
  inquiryId: string;
  answeredByUserId: string;
  idempotencyKey: string;
  content: string;
  answeredAt: Date;
};
type Audit = {
  action: string;
  result: 'success' | 'failure';
  targetId?: string | null;
  errorCode?: string | null;
  metadataJson?: unknown;
};

const operator = { userId: 'operator-1', role: 'operator' } as never;
const admin = { userId: 'admin-1', role: 'admin' } as never;

/* eslint-disable @typescript-eslint/require-await -- the in-memory fake mirrors Prisma's async client methods */
/** Inquiries + answers with the real unique `inquiry_id`, and a transaction
 * that discards its answer and audit writes when the callback throws. */
function createService() {
  const inquiries = [
    {
      id: 'inq-1',
      userId: 'user-a',
      category: 'bug',
      title: '첫 문의',
      content: '첫 번째 문의 본문입니다.',
      createdAt: new Date('2026-10-17T01:00:00.000Z'),
    },
    {
      id: 'inq-2',
      userId: 'user-b',
      category: 'wallet',
      title: '둘째 문의',
      content: '두 번째 문의 본문입니다.',
      createdAt: new Date('2026-10-17T02:00:00.000Z'),
    },
  ];
  const answers: Answer[] = [];
  const audits: Audit[] = [];
  const hooks: { beforeCreate?: () => void; failAudit?: boolean } = {};
  const present = (
    inquiry: (typeof inquiries)[number],
    staged: Answer[] = [],
  ) => {
    // A transaction reads its own uncommitted insert.
    const answer = [...answers, ...staged].find(
      (item) => item.inquiryId === inquiry.id,
    );
    return {
      id: inquiry.id,
      category: inquiry.category,
      title: inquiry.title,
      content: inquiry.content,
      createdAt: inquiry.createdAt,
      user: {
        id: inquiry.userId,
        nickname: `nick-${inquiry.userId}`,
        status: 'active',
      },
      answer: answer
        ? {
            content: answer.content,
            answeredAt: answer.answeredAt,
            answeredByUserId: answer.answeredByUserId,
            idempotencyKey: answer.idempotencyKey,
          }
        : null,
    };
  };
  const unique = () =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    });
  const client = (staged: { answers: Answer[]; audits: Audit[] } | null) => ({
    inquiry: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const row = inquiries.find((item) => item.id === where.id);
        return row ? present(row, staged?.answers) : null;
      }),
    },
    inquiryAnswer: {
      create: jest.fn(
        async ({ data }: { data: Omit<Answer, 'answeredAt'> }) => {
          hooks.beforeCreate?.();
          hooks.beforeCreate = undefined;
          const all = [...answers, ...(staged?.answers ?? [])];
          if (all.some((item) => item.inquiryId === data.inquiryId))
            throw unique();
          const row = {
            ...data,
            answeredAt: new Date('2026-10-17T03:00:00.000Z'),
          };
          (staged ?? { answers }).answers.push(row);
          return row;
        },
      ),
    },
  });
  const prisma = {
    ...client(null),
    inquiry: {
      ...client(null).inquiry,
      findMany: jest.fn(
        async ({
          where,
          take,
          skip,
        }: {
          where: { answer?: { is?: null; isNot?: null } };
          take: number;
          skip: number;
        }) =>
          inquiries
            .map((row) => present(row))
            .filter((row) =>
              where.answer && 'is' in where.answer
                ? !row.answer
                : where.answer && 'isNot' in where.answer
                  ? !!row.answer
                  : true,
            )
            .slice(skip, skip + take),
      ),
      count: jest.fn(async () => inquiries.length),
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const staged = { answers: [] as Answer[], audits: [] as Audit[] };
      const tx = { ...client(staged), stagedAudits: staged.audits };
      const result = await fn(tx);
      // Commit only after the callback returned.
      answers.push(...staged.answers);
      audits.push(...staged.audits);
      return result;
    }),
  };
  const audit = {
    recordSuccess: jest.fn(
      async (input: Omit<Audit, 'result'>, tx?: { stagedAudits: Audit[] }) => {
        if (tx && hooks.failAudit) throw new Error('audit insert failed');
        (tx?.stagedAudits ?? audits).push({ ...input, result: 'success' });
      },
    ),
    recordFailure: jest.fn(async (input: Omit<Audit, 'result'>) => {
      audits.push({ ...input, result: 'failure' });
    }),
  };
  const service = new OperatorInquiriesService(prisma as never, audit as never);
  return { service, prisma, answers, audits, hooks };
}

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

const answerBody = (patch: Record<string, unknown> = {}) => ({
  content: '  확인 결과 정상 처리되었습니다.  ',
  idempotencyKey: 'answer-inq-1-a',
  ...patch,
});

describe('OperatorInquiriesService', () => {
  it('stores one answer with its success audit in the same transaction', async () => {
    const { service, answers, audits } = createService();
    const result = await service.answer(operator, 'inq-1', answerBody(), {
      requestId: 'req-1',
    });
    expect(result.data.replayed).toBe(false);
    expect(result.data.inquiry.status).toBe('answered');
    expect(result.data.inquiry.answer).toEqual({
      content: '확인 결과 정상 처리되었습니다.',
      answeredAt: '2026-10-17T03:00:00.000Z',
      answeredByUserId: 'operator-1',
    });
    expect(JSON.stringify(result.data.inquiry).includes('answer-inq-1-a')).toBe(
      false,
    );
    expect(answers).toHaveLength(1);
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'operator.inquiry.answer',
        result: 'success',
        targetId: 'inq-1',
        metadataJson: { answerLength: 17 },
      }),
    ]);
    // No inquiry text or answer text in any audit row.
    expect(JSON.stringify(audits).includes('정상 처리')).toBe(false);
    expect(JSON.stringify(audits).includes('문의 본문')).toBe(false);
  });

  it('replays the stored answer for the same operator, key and text', async () => {
    const { service, answers, audits } = createService();
    await service.answer(operator, 'inq-1', answerBody());
    const replay = await service.answer(operator, 'inq-1', answerBody());
    expect(replay.data.replayed).toBe(true);
    expect(replay.data.inquiry.answer?.content).toBe(
      '확인 결과 정상 처리되었습니다.',
    );
    expect(answers).toHaveLength(1);
    expect(audits.map((item) => item.action)).toEqual([
      'operator.inquiry.answer',
      'operator.inquiry.answer.replay',
    ]);
  });

  it('never overwrites: another operator or another request is a conflict', async () => {
    const { service, answers, audits } = createService();
    await service.answer(operator, 'inq-1', answerBody());
    expect(
      await rejection(
        service.answer(
          admin,
          'inq-1',
          answerBody({ content: '다른 답변입니다.' }),
        ),
      ),
    ).toEqual({ status: 409, code: 'INQUIRY_ALREADY_ANSWERED' });
    expect(
      await rejection(
        service.answer(
          operator,
          'inq-1',
          answerBody({ idempotencyKey: 'answer-inq-1-b' }),
        ),
      ),
    ).toEqual({ status: 409, code: 'INQUIRY_ALREADY_ANSWERED' });
    expect(
      await rejection(
        service.answer(operator, 'inq-1', answerBody({ content: '바뀐 답변' })),
      ),
    ).toEqual({ status: 409, code: 'INQUIRY_ANSWER_IDEMPOTENCY_CONFLICT' });
    expect(answers).toEqual([
      expect.objectContaining({
        answeredByUserId: 'operator-1',
        content: '확인 결과 정상 처리되었습니다.',
      }),
    ]);
    expect(
      audits
        .filter((item) => item.result === 'failure')
        .map((item) => [item.action, item.errorCode]),
    ).toEqual([
      ['operator.inquiry.answer.failed', 'INQUIRY_ALREADY_ANSWERED'],
      ['operator.inquiry.answer.failed', 'INQUIRY_ALREADY_ANSWERED'],
      ['operator.inquiry.answer.failed', 'INQUIRY_ANSWER_IDEMPOTENCY_CONFLICT'],
    ]);
  });

  it('a concurrent answer that commits first wins; the loser gets a conflict', async () => {
    const { service, answers, hooks } = createService();
    // Another admin's answer commits between this request's read and insert.
    hooks.beforeCreate = () =>
      answers.push({
        inquiryId: 'inq-1',
        answeredByUserId: 'admin-1',
        idempotencyKey: 'admin-key',
        content: '관리자 답변입니다.',
        answeredAt: new Date('2026-10-17T02:59:00.000Z'),
      });
    expect(
      await rejection(service.answer(operator, 'inq-1', answerBody())),
    ).toEqual({
      status: 409,
      code: 'INQUIRY_ALREADY_ANSWERED',
    });
    expect(answers.map((item) => item.answeredByUserId)).toEqual(['admin-1']);
  });

  it('a lost response retried while the first attempt commits replays it', async () => {
    const { service, answers, hooks } = createService();
    hooks.beforeCreate = () =>
      answers.push({
        inquiryId: 'inq-1',
        answeredByUserId: 'operator-1',
        idempotencyKey: 'answer-inq-1-a',
        content: '확인 결과 정상 처리되었습니다.',
        answeredAt: new Date('2026-10-17T02:59:00.000Z'),
      });
    const result = await service.answer(operator, 'inq-1', answerBody());
    expect(result.data.replayed).toBe(true);
    expect(answers).toHaveLength(1);
  });

  it('rolls the answer back when its success audit cannot be written', async () => {
    const { service, answers, audits, hooks } = createService();
    hooks.failAudit = true;
    await expect(
      service.answer(operator, 'inq-1', answerBody()),
    ).rejects.toThrow('audit insert failed');
    expect(answers).toHaveLength(0);
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'operator.inquiry.answer.failed',
        result: 'failure',
        errorCode: 'INQUIRY_ANSWER_FAILED',
      }),
    ]);
    const after = await service.get(operator, 'inq-1');
    expect(after.data.inquiry.status).toBe('pending');
  });

  it.each([
    ['no body', undefined],
    ['an array body', []],
    ['a missing key', { content: '정상 답변입니다.' }],
    ['an unsafe key', { content: '정상 답변입니다.', idempotencyKey: 'a b' }],
    ['a blank answer', { content: '   ', idempotencyKey: 'key-1' }],
    ['a one-character answer', { content: ' 네 ', idempotencyKey: 'key-1' }],
    ['a non-string answer', { content: 42, idempotencyKey: 'key-1' }],
    [
      'a too long answer',
      { content: 'x'.repeat(2001), idempotencyKey: 'key-1' },
    ],
    [
      'control characters',
      { content: '답변\u0000입니다', idempotencyKey: 'key-1' },
    ],
  ])('rejects %s without writing', async (_label, body) => {
    const { service, answers } = createService();
    expect(await rejection(service.answer(operator, 'inq-1', body))).toEqual({
      status: 400,
      code: 'INVALID_INQUIRY_ANSWER',
    });
    expect(answers).toHaveLength(0);
  });

  it('accepts exactly 2000 characters and multi-line text', async () => {
    const { service } = createService();
    const long = `첫 줄\n${'가'.repeat(1996)}`;
    const result = await service.answer(
      operator,
      'inq-1',
      answerBody({ content: long }),
    );
    expect(result.data.inquiry.answer?.content).toBe(long);
  });

  it('answers 404 for a missing inquiry and audits the failure', async () => {
    const { service, audits } = createService();
    expect(
      await rejection(service.answer(operator, 'missing', answerBody())),
    ).toEqual({
      status: 404,
      code: 'INQUIRY_NOT_FOUND',
    });
    expect(await rejection(service.get(operator, 'missing'))).toEqual({
      status: 404,
      code: 'INQUIRY_NOT_FOUND',
    });
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'operator.inquiry.answer.failed',
        errorCode: 'INQUIRY_NOT_FOUND',
      }),
    ]);
  });

  it('requires an actor (the guard normally rejects first)', async () => {
    const { service } = createService();
    expect(await rejection(service.list(undefined))).toEqual({
      status: 401,
      code: 'UNAUTHORIZED',
    });
    expect(
      await rejection(service.answer(undefined, 'inq-1', answerBody())),
    ).toEqual({
      status: 401,
      code: 'UNAUTHORIZED',
    });
  });

  it('lists by status: pending oldest first, answered latest first', async () => {
    const { service, prisma, audits } = createService();
    await service.answer(
      operator,
      'inq-2',
      answerBody({ idempotencyKey: 'k2' }),
    );
    const pending = await service.list(operator, { status: 'pending' });
    expect(pending.data.inquiries.map((item) => item.id)).toEqual(['inq-1']);
    expect(pending.data.inquiries[0].user).toEqual({
      id: 'user-a',
      nickname: 'nick-user-a',
      status: 'active',
    });
    const answered = await service.list(operator, { status: 'answered' });
    expect(answered.data.inquiries.map((item) => item.id)).toEqual(['inq-2']);
    const calls = prisma.inquiry.findMany.mock.calls as unknown as Array<
      [{ orderBy: unknown }]
    >;
    expect(calls[0][0].orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    expect(calls[1][0].orderBy).toEqual([
      { answer: { answeredAt: 'desc' } },
      { id: 'desc' },
    ]);
    await service.list(operator);
    expect(calls[2][0].orderBy).toEqual([
      { createdAt: 'desc' },
      { id: 'desc' },
    ]);
    expect(
      audits.filter((item) => item.action === 'operator.inquiries.list'),
    ).toHaveLength(3);
  });

  it.each([
    [{ status: 'closed' }, 'INVALID_INQUIRY_STATUS'],
    [{ limit: '0' }, 'INVALID_PAGINATION'],
    [{ limit: '51' }, 'INVALID_PAGINATION'],
    [{ offset: '-1' }, 'INVALID_PAGINATION'],
  ])('rejects list query %j', async (query, code) => {
    const { service } = createService();
    expect(await rejection(service.list(operator, query))).toEqual({
      status: 400,
      code,
    });
  });
});
