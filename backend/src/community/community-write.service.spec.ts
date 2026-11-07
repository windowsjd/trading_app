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
    Prisma: {
      PrismaClientKnownRequestError,
      TransactionIsolationLevel: { RepeatableRead: 'RepeatableRead' },
    },
    UserRole: { user: 'user', operator: 'operator', admin: 'admin' },
  };
});
jest.mock('./community-tier.reader', () => ({ CommunityTierReader: class {} }));
jest.mock('../auth/profile-image-storage.service', () => ({
  ProfileImageStorageService: class {},
}));
jest.mock('./community-photo-cleanup.service', () => ({
  CommunityPhotoCleanupService: class {},
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { CommunityWriteService, ensureAlias } from './community-write.service';
import { validateCommunityPhotos } from './community-photo.validation';
import { COMMUNITY_RULES_VERSION } from './community.policy';

/* eslint-disable @typescript-eslint/require-await -- the fake mirrors Prisma's async client */

const NOW = new Date('2026-11-07T12:00:00.000Z');
const ME = { userId: 'user-me', role: 'user' as const };
const jpeg = readFileSync(
  join(__dirname, '../../test/fixtures/profile-image.jpg'),
);
const photo = () => ({
  fieldname: 'photos',
  buffer: jpeg,
  size: jpeg.length,
  mimetype: 'image/jpeg',
});

type State = {
  consent: string | null;
  sanction: { reason: string; endsAt: Date | null } | null;
  recentPosts: number;
  duplicatePost: boolean;
  existingPost: Record<string, unknown> | null;
  /** id → row returned by the FOR SHARE/NO KEY UPDATE post selects */
  posts: Map<string, { userId: string; anonymous: boolean }>;
  comments: Map<string, Record<string, unknown>>;
  aliases: Map<string, number>;
  aliasMax: number;
  existingReport: boolean;
  createPostError: Error | null;
};

function harness(overrides: Partial<State> = {}) {
  const state: State = {
    consent: COMMUNITY_RULES_VERSION,
    sanction: null,
    recentPosts: 0,
    duplicatePost: false,
    existingPost: null,
    posts: new Map([
      ['post-1', { userId: 'user-author', anonymous: false }],
      ['post-anon', { userId: 'user-author', anonymous: true }],
      ['post-mine', { userId: ME.userId, anonymous: false }],
    ]),
    comments: new Map(),
    aliases: new Map(),
    aliasMax: 0,
    existingReport: false,
    createPostError: null,
    ...overrides,
  };
  const queryRaw = jest.fn(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?').replace(/\s+/g, ' ');
      if (sql.includes('extract(epoch'))
        return [{ epochMs: String(NOW.getTime()) }];
      if (sql.includes('FROM users')) return [{ id: values[0] }];
      if (sql.includes('MAX(alias_no)'))
        return [{ aliasNo: state.aliasMax + 1 }];
      if (sql.includes('FROM community_posts')) {
        const post = state.posts.get(values[0] as string);
        return post ? [{ id: values[0], userId: post.userId }] : [];
      }
      if (sql.includes('FROM community_comments')) {
        const comment = state.comments.get(values[0] as string);
        return comment ? [{ id: values[0], userId: comment.userId }] : [];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  );
  const tables = {
    $queryRaw: queryRaw,
    communityRuleConsent: {
      findUnique: jest.fn(async () =>
        state.consent ? { rulesVersion: state.consent, acceptedAt: NOW } : null,
      ),
      upsert: jest.fn(async () => ({
        rulesVersion: COMMUNITY_RULES_VERSION,
        acceptedAt: NOW,
      })),
    },
    communitySanction: {
      findFirst: jest.fn(async () => state.sanction),
    },
    asset: { findFirst: jest.fn(async () => ({ id: 'asset-1' })) },
    communityPost: {
      findUnique: jest.fn(async (args: { where: Record<string, unknown> }) => {
        if ('userId_clientRequestId' in args.where) return state.existingPost;
        const id = args.where.id as string;
        const post = state.posts.get(id);
        return post
          ? {
              id,
              ...post,
              deletedAt: null,
              hiddenBySanctionId: null,
              deletionKind: null,
            }
          : null;
      }),
      count: jest.fn(async () => state.recentPosts),
      findFirst: jest.fn(async () =>
        state.duplicatePost ? { id: 'dup' } : null,
      ),
      create: jest.fn(async () => {
        if (state.createPostError) throw state.createPostError;
        return { id: 'post-new' };
      }),
      update: jest.fn(),
    },
    communityPostPhoto: {
      createMany: jest.fn(),
      findMany: jest.fn(async () => []),
    },
    communityPostLike: {
      createMany: jest.fn(),
      deleteMany: jest.fn(),
      count: jest.fn(async () => 7),
    },
    communityComment: {
      count: jest.fn(async () => 0),
      findFirst: jest.fn(async () => null),
      findUnique: jest.fn(async (args: { where: Record<string, unknown> }) => {
        if ('userId_clientRequestId' in args.where) return null;
        return state.comments.get(args.where.id as string) ?? null;
      }),
      create: jest.fn(async () => ({ id: 'comment-new' })),
      update: jest.fn(),
    },
    communityPostAlias: {
      findUnique: jest.fn(
        async (args: { where: { postId_userId: { userId: string } } }) => {
          const aliasNo = state.aliases.get(args.where.postId_userId.userId);
          return aliasNo ? { aliasNo } : null;
        },
      ),
      create: jest.fn(),
    },
    communityCommentLike: {
      createMany: jest.fn(),
      deleteMany: jest.fn(),
      count: jest.fn(async () => 1),
    },
    communityReport: {
      findFirst: jest.fn(async () =>
        state.existingReport ? { reason: 'ABUSE', createdAt: NOW } : null,
      ),
      count: jest.fn(async () => 0),
      create: jest.fn(async () => ({ reason: 'ABUSE', createdAt: NOW })),
    },
  };
  const prisma = Object.assign(tables, {
    $transaction: jest.fn(async (fn: (tx: typeof tables) => unknown) =>
      fn(tables),
    ),
  });
  const read = {
    renderPost: jest.fn(async (_tx: unknown, _viewer: unknown, id: string) => ({
      id,
    })),
    renderComment: jest.fn(
      async (_tx: unknown, _viewer: unknown, id: string) => ({ id }),
    ),
  };
  const cleanups = {
    reserveUploads: jest.fn(async () => undefined),
    claimUploads: jest.fn(async () => true),
    enqueue: jest.fn(async () => undefined),
    processNow: jest.fn(async () => undefined),
  };
  const storage = {
    isConfigured: jest.fn(() => true),
    upload: jest.fn(async () => undefined),
  };
  const service = new CommunityWriteService(
    prisma as never,
    read as never,
    cleanups as never,
    storage as never,
  );
  return { service, prisma, read, cleanups, storage, state };
}

const payload = (fields: Record<string, unknown> = {}) => ({
  payload: JSON.stringify({
    clientRequestId: 'community_post_0123456789',
    category: 'free',
    body: '내일 시초가가 어떻게 나올까요?',
    anonymous: false,
    ...fields,
  }),
});

async function failure(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    const response = error.getResponse() as {
      error: { code: string; details?: Record<string, unknown> };
    };
    return {
      status: error.getStatus(),
      code: response.error.code,
      details: response.error.details,
    };
  }
  return { status: 0, code: 'NONE', details: undefined };
}

describe('CommunityWriteService', () => {
  it('refuses links and invitations before reading anything', async () => {
    const h = harness();
    const result = await failure(() =>
      h.service.createPost(
        ME,
        payload({ body: '오픈채팅 open.kakao.com/o/x' }),
        [],
      ),
    );
    expect(result.code).toBe('COMMUNITY_LINK_NOT_ALLOWED');
    expect(result.status).toBe(400);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a malformed payload', async () => {
    const h = harness();
    for (const body of [
      {},
      { payload: '{not json' },
      payload({ category: 'hot' }),
      payload({ anonymous: 'yes' }),
      payload({ body: '   ' }),
    ]) {
      const result = await failure(() => h.service.createPost(ME, body, []));
      expect(result.code).toBe('INVALID_COMMUNITY_POST');
    }
  });

  it('needs the current rules consent before any upload', async () => {
    const h = harness({ consent: '2020-01-01' });
    const result = await failure(() =>
      h.service.createPost(ME, payload(), [photo()]),
    );
    expect(result).toEqual({
      status: 403,
      code: 'COMMUNITY_RULES_NOT_ACCEPTED',
      details: undefined,
    });
    expect(h.cleanups.reserveUploads).not.toHaveBeenCalled();
    expect(h.storage.upload).not.toHaveBeenCalled();
  });

  it('refuses a restricted member with the restriction end', async () => {
    const until = new Date('2026-12-07T12:00:00.000Z');
    const h = harness({ sanction: { reason: 'ABUSE', endsAt: until } });
    const result = await failure(() => h.service.createPost(ME, payload(), []));
    expect(result.status).toBe(403);
    expect(result.code).toBe('COMMUNITY_RESTRICTED');
    expect(result.details?.until).toBe(until.toISOString());
    expect(result.details?.reason).toBe('ABUSE');
    const permanent = harness({ sanction: { reason: 'FLOOD', endsAt: null } });
    const forever = await failure(() =>
      permanent.service.setPostLike(ME, 'post-1', true),
    );
    expect(forever.code).toBe('COMMUNITY_RESTRICTED');
    expect(forever.details?.until === null).toBe(true);
  });

  it('rate-limits to five posts in ten minutes and refuses a repeated body', async () => {
    const limited = harness({ recentPosts: 5 });
    expect(
      (await failure(() => limited.service.createPost(ME, payload(), []))).code,
    ).toBe('COMMUNITY_RATE_LIMITED');
    const duplicate = harness({ duplicatePost: true });
    expect(
      (await failure(() => duplicate.service.createPost(ME, payload(), [])))
        .code,
    ).toBe('COMMUNITY_DUPLICATE_CONTENT');
  });

  it('uploads photos under a lease, then stores the post and its photos', async () => {
    const h = harness();
    const result = await h.service.createPost(ME, payload(), [
      photo(),
      photo(),
    ]);
    expect(result.data.replayed).toBe(false);
    const [, keys] = h.cleanups.reserveUploads.mock.calls[0] as unknown as [
      string,
      string[],
    ];
    expect(keys).toHaveLength(2);
    expect(
      keys.every((key) => /^community-images\/[0-9a-f-]{36}\.jpg$/.test(key)),
    ).toBe(true);
    expect(keys.some((key) => key.includes(ME.userId))).toBe(false);
    const uploads = h.storage.upload.mock.calls as unknown as [
      string,
      Buffer,
      string,
    ][];
    expect(uploads.map((call) => call[2])).toEqual([
      'public, max-age=3600',
      'public, max-age=3600',
    ]);
    expect(h.cleanups.claimUploads).toHaveBeenCalledTimes(1);
    const [[stored]] = h.prisma.communityPostPhoto.createMany.mock
      .calls as unknown as [
      [{ data: { position: number; objectKey: string }[] }],
    ];
    expect(stored.data.map((row) => row.position).join(',')).toBe('0,1');
    expect(stored.data.map((row) => row.objectKey)).toEqual(keys);
  });

  it('removes uploaded objects and answers 503 when a storage write fails', async () => {
    const h = harness();
    h.storage.upload.mockRejectedValueOnce(new Error('network'));
    const result = await failure(() =>
      h.service.createPost(ME, payload(), [photo()]),
    );
    expect(result).toEqual({
      status: 503,
      code: 'COMMUNITY_PHOTO_UPLOAD_FAILED',
      details: undefined,
    });
    expect(h.cleanups.processNow).toHaveBeenCalledTimes(1);
    expect(h.prisma.communityPost.create).not.toHaveBeenCalled();
  });

  it('replays the same request id and content without writing again', async () => {
    const h = harness({
      existingPost: {
        id: 'post-old',
        category: 'free',
        body: '내일 시초가가 어떻게 나올까요?',
        anonymous: false,
        assetId: null,
        deletedAt: null,
        hiddenBySanctionId: null,
        photos: [],
      },
    });
    const result = await h.service.createPost(ME, payload(), []);
    expect(result.data.replayed).toBe(true);
    expect(h.prisma.communityPost.create).not.toHaveBeenCalled();
    expect(h.cleanups.reserveUploads).not.toHaveBeenCalled();
    const conflict = await failure(() =>
      h.service.createPost(ME, payload({ body: '다른 본문' }), []),
    );
    expect(conflict.code).toBe('COMMUNITY_IDEMPOTENCY_CONFLICT');
  });

  it('answers a lost unique race with the winner and removes its own objects', async () => {
    const race = new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002',
      clientVersion: 'test',
    });
    const h = harness({ createPostError: race });
    let calls = 0;
    h.prisma.communityPost.findUnique.mockImplementation(
      async (args: { where: Record<string, unknown> }) => {
        if (!('userId_clientRequestId' in args.where)) return null;
        calls += 1;
        return calls === 1
          ? null
          : {
              id: 'post-winner',
              category: 'free',
              body: '내일 시초가가 어떻게 나올까요?',
              anonymous: false,
              assetId: null,
              deletedAt: null,
              hiddenBySanctionId: null,
              photos: [
                { sha256: validateCommunityPhotos([photo()])[0].sha256 },
              ],
            };
      },
    );
    const result = await h.service.createPost(ME, payload(), [photo()]);
    expect(result.data.replayed).toBe(true);
    expect(h.cleanups.processNow).toHaveBeenCalledTimes(1);
  });

  it('refuses liking your own post but lets you remove a like without consent', async () => {
    const own = harness();
    expect(
      (await failure(() => own.service.setPostLike(ME, 'post-mine', true)))
        .code,
    ).toBe('COMMUNITY_SELF_REACTION');
    const noConsent = harness({ consent: null });
    const result = await noConsent.service.setPostLike(ME, 'post-1', false);
    expect(result.data.liked).toBe(false);
    expect(result.data.likeCount).toBe(7);
  });

  it('forces the anonymous post author anonymous without a number', async () => {
    const h = harness();
    await h.service.createComment(
      { userId: 'user-author', role: 'user' },
      'post-anon',
      {
        clientRequestId: 'community_comment_000001',
        body: '글쓴이입니다',
        anonymous: false,
      },
    );
    const created = h.prisma.communityComment.create.mock.calls[0][0] as {
      data: { anonymous: boolean };
    };
    expect(created.data.anonymous).toBe(true);
    expect(h.prisma.communityPostAlias.create).not.toHaveBeenCalled();
  });

  it('numbers a new anonymous commenter max + 1 and reuses an existing number', async () => {
    const h = harness({ aliasMax: 2 });
    await h.service.createComment(ME, 'post-1', {
      clientRequestId: 'community_comment_000002',
      body: '익명으로',
      anonymous: true,
    });
    const [[alias]] = h.prisma.communityPostAlias.create.mock
      .calls as unknown as [[{ data: { aliasNo: number; userId: string } }]];
    expect(alias.data.aliasNo).toBe(3);
    expect(alias.data.userId).toBe(ME.userId);
    const again = harness({ aliases: new Map([[ME.userId, 1]]), aliasMax: 4 });
    const aliasNo = await ensureAlias(
      again.prisma as never,
      'post-1',
      ME.userId,
    );
    expect(aliasNo).toBe(1);
    expect(again.prisma.communityPostAlias.create).not.toHaveBeenCalled();
  });

  it('refuses a reply to a reply', async () => {
    const h = harness({
      comments: new Map([
        [
          'reply-1',
          {
            postId: 'post-1',
            parentCommentId: 'root-1',
            deletedAt: null,
            hiddenBySanctionId: null,
            userId: 'u',
          },
        ],
      ]),
    });
    const result = await failure(() =>
      h.service.createComment(ME, 'post-1', {
        clientRequestId: 'community_comment_000003',
        body: '답글의 답글',
        anonymous: false,
        parentCommentId: 'reply-1',
      }),
    );
    expect(result.code).toBe('INVALID_COMMUNITY_COMMENT');
  });

  it('refuses reporting your own post and replays an earlier report', async () => {
    const own = harness();
    expect(
      (
        await failure(() =>
          own.service.report(ME, {
            targetType: 'post',
            targetId: 'post-mine',
            reason: 'ABUSE',
          }),
        )
      ).code,
    ).toBe('COMMUNITY_SELF_REPORT');
    const earlier = harness({ existingReport: true });
    const result = await earlier.service.report(ME, {
      targetType: 'post',
      targetId: 'post-1',
      reason: 'FLOOD',
    });
    expect(result.data.replayed).toBe(true);
    expect(result.data.report.reason).toBe('ABUSE');
    expect(earlier.prisma.communityReport.create).not.toHaveBeenCalled();
    const invalid = await failure(() =>
      earlier.service.report(ME, {
        targetType: 'user',
        targetId: 'x',
        reason: 'ABUSE',
      }),
    );
    expect(invalid.code).toBe('INVALID_COMMUNITY_REPORT');
  });

  it('accepts only the current rules version and keeps the first acceptance', async () => {
    const h = harness({ consent: null });
    expect(
      (await failure(() => h.service.consent(ME, { rulesVersion: 'old' })))
        .code,
    ).toBe('INVALID_COMMUNITY_RULES_VERSION');
    await h.service.consent(ME, { rulesVersion: COMMUNITY_RULES_VERSION });
    expect(h.prisma.communityRuleConsent.upsert).toHaveBeenCalledTimes(1);
    const again = harness();
    await again.service.consent(ME, { rulesVersion: COMMUNITY_RULES_VERSION });
    expect(again.prisma.communityRuleConsent.upsert).not.toHaveBeenCalled();
  });
});
