jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../operator/operator-audit.service', () => ({
  OperatorAuditService: class {},
}));

import { HttpException } from '@nestjs/common';
import {
  ImportantNoticesService,
  POPUP_NOTICE_LIMIT,
  noticeSourceKey,
  parseNoticeSections,
} from './important-notices.service';

const operator = { userId: 'op-1', role: 'operator' as const };
const context = { requestId: 'r1', ipAddress: '127.0.0.1', userAgent: 'test' };
const sections = [
  { heading: '점검 안내', paragraphs: ['10월 20일 02:00–03:00 점검합니다.'] },
];

async function errorCode(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException)
      return (error.getResponse() as { error: { code: string } }).error.code;
    throw error;
  }
  return null;
}

function notice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'notice-1',
    title: '서버 점검',
    summary: '10월 20일 새벽 점검이 있어요.',
    sections,
    status: 'draft',
    idempotencyKey: 'k1',
    createdByUserId: 'op-1',
    publishedByUserId: null,
    publishedAt: null,
    withdrawnByUserId: null,
    withdrawnAt: null,
    fanoutCursor: null,
    fanoutCompletedAt: null,
    createdAt: new Date('2026-10-17T00:00:00.000Z'),
    updatedAt: new Date('2026-10-17T00:00:00.000Z'),
    showPopup: false,
    ...overrides,
  };
}

function harness(
  state: { row?: ReturnType<typeof notice> | null; transitions?: number } = {},
) {
  const audits: Array<Record<string, unknown>> = [];
  const failures: Array<Record<string, unknown>> = [];
  const skips: unknown[] = [];
  let row = state.row === undefined ? null : state.row;
  const tx = {
    importantNotice: {
      findUnique: jest.fn(async () => row),
      findUniqueOrThrow: jest.fn(async () => row),
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        row = notice({ ...args.data });
        return row;
      }),
      updateMany: jest.fn(
        async (args: {
          where: { status: string };
          data: Record<string, unknown>;
        }) => {
          if (!row || row.status !== args.where.status) return { count: 0 };
          row = { ...row, ...args.data };
          return { count: 1 };
        },
      ),
    },
    pushNotification: {
      updateMany: jest.fn(async (args: unknown) => {
        skips.push(args);
        return { count: 2 };
      }),
    },
  };
  // Member popup reads and confirmations (2026-11-13): one row per
  // (user, notice), duplicates skipped like ON CONFLICT DO NOTHING.
  const acknowledgements = new Map<string, Date>();
  const popupQueries: unknown[] = [];
  const prisma = {
    $transaction: jest.fn(async (run: (client: typeof tx) => unknown) =>
      run(tx),
    ),
    importantNotice: {
      ...tx.importantNotice,
      findMany: jest.fn((args: unknown) => {
        popupQueries.push(args);
        return Promise.resolve(
          row && row.status === 'published' && row.showPopup ? [row] : [],
        );
      }),
    },
    importantNoticeAcknowledgement: {
      createMany: jest.fn(
        (args: {
          data: Array<{ userId: string; noticeId: string }>;
          skipDuplicates: boolean;
        }) => {
          expect(args.skipDuplicates).toBe(true);
          let count = 0;
          for (const { userId, noticeId } of args.data) {
            const key = `${userId}|${noticeId}`;
            if (acknowledgements.has(key)) continue;
            acknowledgements.set(
              key,
              new Date(Date.UTC(2026, 10, 13, 0, 0, acknowledgements.size)),
            );
            count += 1;
          }
          return Promise.resolve({ count });
        },
      ),
      findUniqueOrThrow: jest.fn(
        (args: {
          where: { userId_noticeId: { userId: string; noticeId: string } };
        }) => {
          const { userId, noticeId } = args.where.userId_noticeId;
          const at = acknowledgements.get(`${userId}|${noticeId}`);
          return at
            ? Promise.resolve({ acknowledgedAt: at })
            : Promise.reject(new Error('not found'));
        },
      ),
    },
  };
  const audit = {
    recordSuccess: jest.fn(
      async (input: Record<string, unknown>, client: unknown) => {
        // Written with the change, in the same transaction.
        expect(client).toBe(tx);
        audits.push(input);
      },
    ),
    recordFailure: jest.fn(async (input: Record<string, unknown>) => {
      failures.push(input);
    }),
  };
  return {
    service: new ImportantNoticesService(prisma as never, audit as never),
    audits,
    failures,
    skips,
    acknowledgements,
    popupQueries,
    prisma,
    current: () => row,
  };
}

describe('ImportantNoticesService', () => {
  it('validates the app notice shape', () => {
    expect(parseNoticeSections(sections)).toEqual(sections);
    expect(parseNoticeSections([])).toBe(null);
    expect(parseNoticeSections([{ heading: '', paragraphs: ['a'] }])).toBe(
      null,
    );
    expect(parseNoticeSections([{ heading: 'h', paragraphs: [] }])).toBe(null);
    expect(
      parseNoticeSections([{ heading: 'h', paragraphs: ['x'.repeat(2001)] }]),
    ).toBe(null);
  });

  it('creates an audited draft and replays the same key', async () => {
    const h = harness();
    const body = {
      title: '서버 점검',
      summary: '요약',
      sections,
      idempotencyKey: 'k1',
    };
    const created = await h.service.create(operator, body, context);
    expect(created.data.notice.status).toBe('draft');
    expect(h.audits[0]).toMatchObject({
      action: 'operator.notice.create',
      targetType: 'important_notice',
      actorUserId: 'op-1',
    });
    const replay = await h.service.create(operator, body, context);
    expect(replay.data.notice.id).toBe(created.data.notice.id);
    expect(h.audits).toHaveLength(1);
    expect(
      await errorCode(
        h.service.create(operator, { ...body, summary: '다른 내용' }, context),
      ),
    ).toBe('NOTICE_IDEMPOTENCY_CONFLICT');
  });

  it('refuses incomplete notices', async () => {
    const h = harness();
    expect(
      await errorCode(
        h.service.create(
          operator,
          { title: 't', summary: 's', sections: [] },
          context,
        ),
      ),
    ).toBe('INVALID_NOTICE');
    expect(h.failures).toEqual([
      expect.objectContaining({
        action: 'operator.notice.create.failed',
        errorCode: 'INVALID_NOTICE',
      }),
    ]);
  });

  it('publishes only with explicit confirmation and only once', async () => {
    const h = harness({ row: notice() });
    expect(
      await errorCode(h.service.publish(operator, 'notice-1', {}, context)),
    ).toBe('NOTICE_PUBLISH_CONFIRMATION_REQUIRED');
    expect(h.current()?.status).toBe('draft');
    const published = await h.service.publish(
      operator,
      'notice-1',
      { confirm: true },
      context,
    );
    expect(published.data.notice.status).toBe('published');
    expect(h.current()?.publishedByUserId).toBe('op-1');
    expect(h.audits.map((audit) => audit.action)).toEqual([
      'operator.notice.publish',
    ]);
    expect(
      await errorCode(
        h.service.publish(operator, 'notice-1', { confirm: true }, context),
      ),
    ).toBe('NOTICE_ALREADY_PUBLISHED');
    expect(h.failures.map((failure) => failure.action)).toEqual([
      'operator.notice.publish.failed',
    ]);
  });

  it('withdraws a published notice and stops its unsent pushes', async () => {
    const h = harness({
      row: notice({
        status: 'published',
        publishedAt: new Date(),
        publishedByUserId: 'op-1',
      }),
    });
    await h.service.withdraw(operator, 'notice-1', context);
    expect(h.current()?.status).toBe('withdrawn');
    expect(h.skips).toEqual([
      {
        where: {
          type: 'important_notice',
          sourceKey: noticeSourceKey('notice-1'),
          status: 'pending',
        },
        data: { status: 'skipped', skipReason: 'source_withdrawn' },
      },
    ]);
  });

  it('reports a missing notice', async () => {
    const h = harness({ row: null });
    expect(
      await errorCode(
        h.service.publish(operator, 'missing', { confirm: true }, context),
      ),
    ).toBe('NOTICE_NOT_FOUND');
  });

  it('creates a popup notice only from a strict boolean, as part of its replay', async () => {
    const h = harness();
    const body = {
      title: '서버 점검',
      summary: '요약',
      sections,
      idempotencyKey: 'k2',
      showPopup: true,
    };
    const created = await h.service.create(operator, body, context);
    expect(created.data.notice.showPopup).toBe(true);
    expect(h.current()?.showPopup).toBe(true);
    expect(h.audits[0]).toMatchObject({
      metadataJson: { sectionCount: 1, showPopup: true },
    });
    // The same key must carry the same choice.
    expect(
      await errorCode(
        h.service.create(operator, { ...body, showPopup: false }, context),
      ),
    ).toBe('NOTICE_IDEMPOTENCY_CONFLICT');
    for (const showPopup of ['true', 1, null])
      expect(
        await errorCode(
          harness().service.create(
            operator,
            { ...body, idempotencyKey: 'k3', showPopup },
            context,
          ),
        ),
      ).toBe('INVALID_NOTICE');
    // Without the field: no popup, exactly as before the column existed.
    const plain = harness();
    const { showPopup: _omitted, ...withoutPopup } = body;
    void _omitted;
    const old = await plain.service.create(operator, withoutPopup, context);
    expect(old.data.notice.showPopup).toBe(false);
  });

  it('lists only published popup notices the caller has not confirmed', async () => {
    const member = { userId: 'member-1', role: 'user' as const };
    const h = harness({
      row: notice({
        status: 'published',
        showPopup: true,
        publishedAt: new Date('2026-11-13T00:00:00.000Z'),
      }),
    });
    const listed = await h.service.listPopupFor(member);
    expect(listed.data.notices).toEqual([
      {
        id: 'notice-1',
        title: '서버 점검',
        summary: '10월 20일 새벽 점검이 있어요.',
        publishedAt: '2026-11-13T00:00:00.000Z',
      },
    ]);
    expect(h.popupQueries[0]).toEqual({
      where: {
        status: 'published',
        showPopup: true,
        acknowledgements: { none: { userId: 'member-1' } },
      },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take: POPUP_NOTICE_LIMIT,
      select: { id: true, title: true, summary: true, publishedAt: true },
    });
    expect(await errorCode(h.service.listPopupFor(undefined))).toBe(
      'UNAUTHORIZED',
    );
  });

  it('records one confirmation per member and notice, whatever the retries', async () => {
    const member = { userId: 'member-1', role: 'user' as const };
    const other = { userId: 'member-2', role: 'user' as const };
    const h = harness({
      row: notice({ status: 'published', showPopup: true }),
    });
    const first = await h.service.acknowledge(member, 'notice-1');
    const retry = await h.service.acknowledge(member, 'notice-1');
    expect(retry.data).toEqual(first.data);
    expect(h.acknowledgements.size).toBe(1);
    // Another member keeps their own state.
    const theirs = await h.service.acknowledge(other, 'notice-1');
    expect(theirs.data.acknowledgedAt).not.toBe(first.data.acknowledgedAt);
    expect([...h.acknowledgements.keys()]).toEqual([
      'member-1|notice-1',
      'member-2|notice-1',
    ]);
    expect(await errorCode(h.service.acknowledge(undefined, 'notice-1'))).toBe(
      'UNAUTHORIZED',
    );
  });

  it('confirms only a published (or since withdrawn) notice', async () => {
    const member = { userId: 'member-1', role: 'user' as const };
    expect(
      await errorCode(
        harness({ row: notice() }).service.acknowledge(member, 'notice-1'),
      ),
    ).toBe('NOTICE_NOT_FOUND');
    expect(
      await errorCode(
        harness({ row: null }).service.acknowledge(member, 'missing'),
      ),
    ).toBe('NOTICE_NOT_FOUND');
    const odd = harness({ row: notice({ status: 'published' }) });
    expect(
      await errorCode(odd.service.acknowledge(member, `x/${'y'.repeat(80)}`)),
    ).toBe('NOTICE_NOT_FOUND');
    expect(odd.prisma.importantNotice.findUnique).not.toHaveBeenCalled();
    const withdrawn = harness({ row: notice({ status: 'withdrawn' }) });
    await withdrawn.service.acknowledge(member, 'notice-1');
    expect(withdrawn.acknowledgements.size).toBe(1);
  });

  it('requires an authenticated operator context', async () => {
    const h = harness();
    expect(await errorCode(h.service.create(undefined, {}, context))).toBe(
      'UNAUTHORIZED',
    );
  });
});
