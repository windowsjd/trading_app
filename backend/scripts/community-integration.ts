/** Isolated PostgreSQL + real HTTP/guard integration for the community
 * (docs/community-api-contract.md); storage is an in-memory fake, no
 * financial writes. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { AccessTokenGuard } from '../src/auth/access-token.guard';
import {
  lockDeletionScope,
  purgeDeletionScope,
} from '../src/auth/account-deletion.purge';
import { databaseNow } from '../src/auth/profile-image-cleanup.service';
import { ProfileImageStorageService } from '../src/auth/profile-image-storage.service';
import { OperatorAuditService } from '../src/operator/operator-audit.service';
import { OperatorGuard } from '../src/operator/operator.guard';
import {
  CommunityController,
  OperatorCommunityController,
} from '../src/community/community.controller';
import { prepareCommunityAccountDeletion } from '../src/community/community-account-deletion';
import { CommunityModerationService } from '../src/community/community-moderation.service';
import { CommunityPhotoCleanupService } from '../src/community/community-photo-cleanup.service';
import { CommunityReadService } from '../src/community/community-read.service';
import { deleteCommunityRetentionBatch } from '../src/community/community-retention';
import {
  applyCommunitySanctionCarryover,
  communitySanctionEmailHash,
} from '../src/community/community-sanction-carryover';
import { CommunityTierReader } from '../src/community/community-tier.reader';
import { CommunityWriteService } from '../src/community/community-write.service';
import { COMMUNITY_RULES_VERSION } from '../src/community/community.policy';

const url = process.env.DATABASE_URL ?? '';
if (
  process.env.COMMUNITY_DB_INTEGRATION !== '1' ||
  process.env.NODE_ENV !== 'test' ||
  !/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)
) {
  throw new Error(
    'Requires COMMUNITY_DB_INTEGRATION=1 NODE_ENV=test and a loopback DATABASE_URL.',
  );
}
const db = new PrismaService();
const tag = randomUUID().slice(0, 8);
const userIds: string[] = [];
const emails: string[] = [];
let closeHttp: (() => Promise<void>) | undefined;
let assertions = 0;
function check(condition: unknown, message: string): asserts condition {
  assert.ok(condition, message);
  assertions++;
}

const jpeg = readFileSync('test/fixtures/profile-image.jpg');

/** In-memory bucket standing in for the S3-compatible storage. */
const objects = new Map<string, { bytes: Buffer; cacheControl: string }>();
/** Read through a call: an assertion on `.size` would narrow it to a literal. */
const objectCount = (): number => objects.size;
const storage = {
  isConfigured: () => true,
  requireConfigured: () => ({}),
  publicUrl: (key: string) => `https://cdn.test/${key}`,
  upload: async (key: string, bytes: Buffer, cacheControl: string) => {
    objects.set(key, { bytes, cacheControl });
  },
  delete: async (key: string) => {
    objects.delete(key);
  },
};

async function financialState() {
  const counts = await Promise.all([
    db.cashWallet.count(),
    db.walletTransaction.count(),
    db.order.count(),
    db.position.count(),
  ]);
  return counts.join(':');
}

const A = 0; // author
const B = 1;
const C = 2;
const D = 3;
const E = 4; // rate limit
const OP = 5; // operator
const ADMIN = 6;
const F = 7; // deletes the account
const G = 8; // second operator-free member

async function run() {
  for (const [index, role] of (
    [
      'user',
      'user',
      'user',
      'user',
      'user',
      'operator',
      'admin',
      'user',
      'user',
    ] as const
  ).entries()) {
    const email = `${tag}-${index}@community.example.invalid`;
    const user = await db.user.create({
      data: {
        email,
        nickname: `community-${tag}-${index}`,
        passwordHash: 'test-only',
        role,
      },
    });
    userIds.push(user.id);
    emails.push(email);
  }
  const baseline = await financialState();
  const jwt = new JwtService();
  const config = new ConfigService({
    JWT_ACCESS_SECRET: 'community-integration-only-secret-with-32-plus-chars',
    JWT_ACCESS_TTL: '15m',
    REFRESH_TOKEN_TTL: '30d',
  });
  // tsx omits emitDecoratorMetadata; supply the constructor metadata tsc emits.
  Reflect.defineMetadata(
    'design:paramtypes',
    [CommunityReadService, CommunityWriteService],
    CommunityController,
  );
  Reflect.defineMetadata(
    'design:paramtypes',
    [CommunityModerationService],
    OperatorCommunityController,
  );
  const tiers = new CommunityTierReader();
  const audit = new OperatorAuditService(db);
  const cleanups = new CommunityPhotoCleanupService(db, storage as never);
  const reads = new CommunityReadService(db, tiers, storage as never);
  const writes = new CommunityWriteService(
    db,
    reads,
    cleanups,
    storage as never,
  );
  const moderation = new CommunityModerationService(db, audit, cleanups, tiers);
  const app = await Test.createTestingModule({
    controllers: [CommunityController, OperatorCommunityController],
    providers: [
      { provide: CommunityReadService, useValue: reads },
      { provide: CommunityWriteService, useValue: writes },
      { provide: CommunityModerationService, useValue: moderation },
      { provide: ProfileImageStorageService, useValue: storage },
      OperatorGuard,
    ],
  }).compile();
  const http = app.createNestApplication();
  http.useGlobalGuards(new AccessTokenGuard(jwt, db, new Reflector(), config));
  await http.init();
  closeHttp = () => http.close();
  const server = http.getHttpServer();
  const token = (who: number) =>
    jwt.sign(
      { sub: userIds[who] },
      { secret: config.get<string>('JWT_ACCESS_SECRET')! },
    );
  const api = (path: string) => `/api/v1${path}`;
  const get = (path: string, who: number) =>
    request(server).get(api(path)).auth(token(who), { type: 'bearer' });
  const post = (path: string, who: number, body: object = {}) =>
    request(server)
      .post(api(path))
      .auth(token(who), { type: 'bearer' })
      .send(body);
  const put = (path: string, who: number) =>
    request(server).put(api(path)).auth(token(who), { type: 'bearer' });
  const del = (path: string, who: number) =>
    request(server).delete(api(path)).auth(token(who), { type: 'bearer' });
  let requestSeq = 0;
  const requestId = (label: string) =>
    `community_${label}_${tag}_${++requestSeq}`;
  const write = (
    who: number,
    fields: Record<string, unknown> = {},
    photos: Buffer[] = [],
  ) => {
    let r = request(server)
      .post(api('/community/posts'))
      .auth(token(who), { type: 'bearer' })
      .field(
        'payload',
        JSON.stringify({
          clientRequestId: requestId('post'),
          category: 'free',
          body: `본문 ${tag} ${requestSeq}`,
          anonymous: false,
          ...fields,
        }),
      );
    for (const [index, bytes] of photos.entries())
      r = r.attach('photos', bytes, {
        filename: `p${index}.jpg`,
        contentType: 'image/jpeg',
      });
    return r;
  };
  const comment = (
    who: number,
    postId: string,
    fields: Record<string, unknown> = {},
  ) =>
    post(`/community/posts/${postId}/comments`, who, {
      clientRequestId: requestId('comment'),
      body: `댓글 ${tag} ${requestSeq}`,
      anonymous: false,
      ...fields,
    });

  // --- Guests, rules consent -------------------------------------------
  let r = await request(server).get(api('/community/bootstrap'));
  check(r.status === 401, 'guests (no token) cannot read the community');
  r = await get('/community/bootstrap', A);
  check(
    r.status === 200 &&
      r.body.data.rulesAccepted === false &&
      r.body.data.reasons.length === 7 &&
      r.body.data.reasons[6].code === 'OTHER' &&
      r.body.data.reasons[6].noteRequired === true &&
      r.body.data.me.userId === userIds[A] &&
      r.body.data.activeSanction === null,
    'bootstrap: rules not yet accepted, the seven reasons, me',
  );
  r = await write(A);
  check(
    r.status === 403 && r.body.error.code === 'COMMUNITY_RULES_NOT_ACCEPTED',
    'writing needs the rules consent',
  );
  r = await get('/community/posts', A);
  check(r.status === 200, 'reading does not');
  r = await post('/community/rules/consent', A, { rulesVersion: 'old' });
  check(
    r.status === 400 && r.body.error.code === 'INVALID_COMMUNITY_RULES_VERSION',
    'only the current version',
  );
  for (const who of [A, B, C, D, E, OP, ADMIN, F, G]) {
    r = await post('/community/rules/consent', who, {
      rulesVersion: COMMUNITY_RULES_VERSION,
    });
    check(
      r.status === 200 && r.body.data.rulesVersion === COMMUNITY_RULES_VERSION,
      `consent ${who}`,
    );
  }

  // --- Posts, photos, idempotency, links --------------------------------
  const publicPayload = {
    clientRequestId: requestId('public'),
    body: '마감 후 지정가가 걸렸는데 내일 시초가가 궁금해요',
  };
  r = await write(A, publicPayload, [jpeg, jpeg]);
  check(
    r.status === 201 && r.body.data.replayed === false,
    'public post with two photos',
  );
  const publicPost = r.body.data.post;
  check(
    publicPost.author.kind === 'public' &&
      publicPost.author.userId === userIds[A] &&
      publicPost.photos.length === 2 &&
      publicPost.photos.every((p: { url: string }) =>
        /^https:\/\/cdn\.test\/community-images\/[0-9a-f-]{36}\.jpg$/.test(
          p.url,
        ),
      ) &&
      publicPost.mine === true,
    'photos are served from random uuid keys',
  );
  check(objectCount() === 2, 'two objects stored');
  check(
    [...objects.values()].every(
      (o) => o.cacheControl === 'public, max-age=3600',
    ),
    'one-hour cache',
  );
  check(
    (await db.communityPhotoCleanup.count({
      where: { userId: userIds[A] },
    })) === 0,
    'the upload leases were consumed by the post',
  );
  r = await write(A, publicPayload, [jpeg, jpeg]);
  check(
    r.status === 201 &&
      r.body.data.replayed === true &&
      r.body.data.post.id === publicPost.id &&
      objectCount() === 2,
    'the same request id and content replays without uploading again',
  );
  r = await write(A, { ...publicPayload, body: '다른 본문' }, []);
  check(
    r.status === 409 && r.body.error.code === 'COMMUNITY_IDEMPOTENCY_CONFLICT',
    'different content under the same id',
  );
  r = await write(A, { body: '여기로 오세요 https://example.com' });
  check(
    r.status === 400 && r.body.error.code === 'COMMUNITY_LINK_NOT_ALLOWED',
    'links are refused',
  );
  r = await write(A, {}, [jpeg, jpeg, jpeg, jpeg, jpeg]);
  check(
    r.status === 400 && r.body.error.code === 'COMMUNITY_TOO_MANY_PHOTOS',
    'a fifth photo is refused',
  );
  r = await write(A, {}, [Buffer.alloc(2 * 1024 * 1024 + 1)]);
  check(
    r.status === 413 && r.body.error.code === 'COMMUNITY_PHOTO_TOO_LARGE',
    'a photo over 2 MiB is refused by the multipart limit',
  );
  r = await write(A, {}, [Buffer.from('not a jpeg')]);
  check(
    r.status === 400 && r.body.error.code === 'INVALID_COMMUNITY_PHOTO',
    'a non-JPEG is refused',
  );

  r = await write(A, {
    anonymous: true,
    body: '시즌 수익률이 계속 마이너스예요. 손절 기준 어떻게 잡으세요?',
  });
  check(
    r.status === 201 && r.body.data.post.author.kind === 'anonymous',
    'anonymous post',
  );
  const anonPost = r.body.data.post;

  // --- Anonymous numbers under concurrency ------------------------------
  const anonComments = await Promise.all(
    [B, C, D, B, C, D, B].map((who, index) =>
      comment(who, anonPost.id, {
        anonymous: true,
        body: `동시 익명 댓글 ${index} ${tag}`,
      }),
    ),
  );
  check(
    anonComments.every((res) => res.status === 201),
    'concurrent anonymous comments',
  );
  const aliasRows = await db.communityPostAlias.findMany({
    where: { postId: anonPost.id },
  });
  check(
    aliasRows.length === 3 &&
      new Set(aliasRows.map((row) => row.aliasNo)).size === 3 &&
      aliasRows.every((row) => row.aliasNo >= 1 && row.aliasNo <= 3),
    'three members got three distinct numbers 1..3',
  );
  const labelOf = new Map(
    aliasRows.map((row) => [row.userId, `익명${row.aliasNo}`]),
  );
  check(
    anonComments.every(
      (res, index) =>
        res.body.data.comment.author.label ===
        labelOf.get(userIds[[B, C, D, B, C, D, B][index]]),
    ),
    'the same member always has the same number on the post',
  );
  r = await comment(A, anonPost.id, {
    anonymous: false,
    body: '글쓴이 답변입니다',
  });
  check(
    r.status === 201 &&
      r.body.data.comment.author.kind === 'anonymous' &&
      r.body.data.comment.author.label === '익명' &&
      r.body.data.comment.author.isPostAuthor === true,
    'the anonymous post author is forced anonymous as 글쓴이',
  );
  const rootForReplies = anonComments[0].body.data.comment;
  r = await comment(C, anonPost.id, {
    parentCommentId: rootForReplies.id,
    body: '답글입니다',
    anonymous: true,
  });
  check(
    r.status === 201 &&
      r.body.data.comment.parentCommentId === rootForReplies.id,
    'a reply',
  );
  r = await comment(D, anonPost.id, {
    parentCommentId: r.body.data.comment.id,
    body: '답글의 답글',
  });
  check(
    r.status === 400 && r.body.error.code === 'INVALID_COMMUNITY_COMMENT',
    'no reply to a reply',
  );

  // --- No identity leaks to members; operator fields --------------------
  const secrets = (who: number) => [userIds[who], `community-${tag}-${who}`];
  for (const path of [
    '/community/posts',
    `/community/posts/${anonPost.id}`,
    `/community/posts/${anonPost.id}/comments`,
    `/community/posts/${anonPost.id}/comments?sort=likes`,
  ]) {
    r = await get(path, B);
    const json = JSON.stringify(r.body);
    check(r.status === 200, `read ${path}`);
    check(
      !secrets(A).some((s) => json.includes(s) && path.includes(anonPost.id)) &&
        !secrets(C).some((s) => json.includes(s)) &&
        !secrets(D).some((s) => json.includes(s)),
      `no anonymous author identity in ${path}`,
    );
    check(
      !json.includes('adminAuthor') && !json.includes('reportCount'),
      `no operator fields in ${path}`,
    );
  }
  r = await get(`/community/posts/${anonPost.id}`, OP);
  check(
    r.body.data.post.adminAuthor.userId === userIds[A],
    'operators see the real author on the detail',
  );
  r = await get('/community/posts', OP);
  check(
    r.body.data.posts.every(
      (p: Record<string, unknown>) =>
        !('adminAuthor' in p) && typeof p.reportCount === 'number',
    ),
    'the feed gives operators report counts but no authors',
  );
  r = await get(`/community/posts/${anonPost.id}/comments`, OP);
  check(
    r.body.data.comments.some(
      (c: { adminAuthor?: { userId: string } }) =>
        c.adminAuthor?.userId === userIds[C],
    ),
    'operators see anonymous commenters',
  );

  // --- Likes, HOT, sort ----------------------------------------------------
  r = await put(`/community/posts/${publicPost.id}/like`, B);
  check(r.status === 200 && r.body.data.likeCount === 1, 'like');
  r = await put(`/community/posts/${publicPost.id}/like`, B);
  check(
    r.status === 200 && r.body.data.likeCount === 1,
    'liking again is idempotent',
  );
  r = await put(`/community/posts/${publicPost.id}/like`, A);
  check(
    r.status === 409 && r.body.error.code === 'COMMUNITY_SELF_REACTION',
    'no self like',
  );
  r = await write(B, { body: `HOT 후보 ${tag}` });
  const hotCandidate = r.body.data.post;
  r = await write(C, { body: `좋아요만 둘 ${tag}` });
  const lukewarm = r.body.data.post;
  await put(`/community/posts/${hotCandidate.id}/like`, C);
  await comment(D, hotCandidate.id, { body: '좋은 글이네요' });
  await comment(B, hotCandidate.id, { body: '작성자 본인 댓글은 점수 밖' });
  await put(`/community/posts/${lukewarm.id}/like`, A);
  await put(`/community/posts/${lukewarm.id}/like`, B);
  r = await get('/community/posts?category=hot&limit=50', B);
  const hotIds = r.body.data.posts.map((p: { id: string }) => p.id);
  check(
    hotIds.includes(hotCandidate.id) &&
      !hotIds.includes(lukewarm.id) &&
      r.body.data.posts.every((p: { isHot: boolean }) => p.isHot === true) &&
      r.body.data.pagination.total <= 30,
    'HOT = 1 like + 2 × 1 comment by others ≥ 3; 2 likes are not enough',
  );
  r = await get(`/community/posts/${lukewarm.id}`, B);
  check(r.body.data.post.isHot === false, 'isHot false below the threshold');
  r = await get('/community/posts?category=hot&limit=3', B);
  check(r.body.data.posts.length <= 3, 'home preview: top three');
  // Sort: the second root comment gets more likes than the first.
  r = await write(D, { body: `정렬 확인 ${tag}` });
  const sortPost = r.body.data.post;
  const first = (await comment(A, sortPost.id, { body: '첫 댓글' })).body.data
    .comment;
  const second = (await comment(B, sortPost.id, { body: '둘째 댓글' })).body
    .data.comment;
  await comment(C, sortPost.id, {
    body: '첫 댓글의 답글',
    parentCommentId: first.id,
  });
  await put(`/community/comments/${first.id}/like`, C);
  await put(`/community/comments/${second.id}/like`, C);
  await put(`/community/comments/${second.id}/like`, D);
  r = await get(`/community/posts/${sortPost.id}/comments?sort=latest`, B);
  const latest = r.body.data.comments.map((c: { id: string }) => c.id);
  check(
    latest[0] === second.id && latest[1] === first.id && latest.length === 3,
    'latest: newest root first, replies after their root',
  );
  r = await get(`/community/posts/${sortPost.id}/comments?sort=likes`, B);
  check(
    r.body.data.comments[0].id === second.id &&
      r.body.data.comments[0].likeCount === 2,
    'likes: most liked root first',
  );
  r = await get(`/community/posts/${sortPost.id}/comments?sort=old`, B);
  check(
    r.status === 400 && r.body.error.code === 'INVALID_COMMUNITY_SORT',
    'unknown sort',
  );

  // --- Reports ----------------------------------------------------------
  r = await post('/community/reports', B, {
    targetType: 'post',
    targetId: publicPost.id,
    reason: 'AD_SPAM',
  });
  check(r.status === 201 && r.body.data.replayed === false, 'report');
  r = await post('/community/reports', B, {
    targetType: 'post',
    targetId: publicPost.id,
    reason: 'ABUSE',
  });
  check(
    r.status === 201 &&
      r.body.data.replayed === true &&
      r.body.data.report.reason === 'AD_SPAM',
    'a second report replays the first',
  );
  r = await post('/community/reports', A, {
    targetType: 'post',
    targetId: publicPost.id,
    reason: 'ABUSE',
  });
  check(
    r.status === 409 && r.body.error.code === 'COMMUNITY_SELF_REPORT',
    'no self report',
  );
  r = await get(`/community/posts/${publicPost.id}`, OP);
  check(r.body.data.post.reportCount === 1, 'operators see the report count');

  // --- Rate limit, duplicates ---------------------------------------------
  for (let index = 0; index < 5; index++) {
    r = await write(E, { body: `도배 확인 ${index} ${tag}` });
    check(r.status === 201, `post ${index + 1} of 5`);
  }
  r = await write(E, { body: `여섯 번째 ${tag}` });
  check(
    r.status === 429 && r.body.error.code === 'COMMUNITY_RATE_LIMITED',
    'the sixth post in ten minutes',
  );
  r = await write(G, { body: `중복 ${tag}` });
  r = await write(G, { body: `중복 ${tag}` });
  check(
    r.status === 409 && r.body.error.code === 'COMMUNITY_DUPLICATE_CONTENT',
    'the same text again within ten minutes',
  );

  // --- Sanctions: hide, 403, restore -------------------------------------
  r = await post(`/operator/community/users/${userIds[A]}/sanctions`, B, {
    reason: 'ABUSE',
    duration: '7d',
    hideContent: true,
  });
  check(
    r.status === 403 && r.body.error.code === 'OPERATOR_FORBIDDEN',
    'members cannot use the operator API',
  );
  r = await post(`/operator/community/users/${userIds[ADMIN]}/sanctions`, OP, {
    reason: 'ABUSE',
    duration: '7d',
    hideContent: false,
  });
  check(
    r.status === 403 &&
      r.body.error.code === 'COMMUNITY_SANCTION_TARGET_FORBIDDEN',
    'admins cannot be restricted',
  );
  r = await post(`/operator/community/users/${userIds[A]}/sanctions`, OP, {
    reason: 'OTHER',
    duration: '7d',
    hideContent: true,
  });
  check(
    r.status === 400 && r.body.error.code === 'INVALID_COMMUNITY_MODERATION',
    'OTHER needs a note',
  );
  r = await post(`/operator/community/users/${userIds[A]}/sanctions`, OP, {
    reason: 'ABUSE',
    duration: '7d',
    hideContent: true,
  });
  check(
    r.status === 201 &&
      r.body.data.hidden.posts >= 2 &&
      r.body.data.sanction.active === true,
    'restricted, content hidden',
  );
  const sanction = r.body.data.sanction;
  r = await post(`/operator/community/users/${userIds[A]}/sanctions`, OP, {
    reason: 'ABUSE',
    duration: '30d',
    hideContent: false,
  });
  check(
    r.status === 409 &&
      r.body.error.code === 'COMMUNITY_SANCTION_ALREADY_ACTIVE',
    'one active restriction',
  );
  r = await get(`/community/posts/${publicPost.id}`, B);
  check(r.status === 404, 'hidden posts are 404 for members');
  r = await write(A, { body: '제한 중 글쓰기' });
  check(
    r.status === 403 &&
      r.body.error.code === 'COMMUNITY_RESTRICTED' &&
      r.body.error.details.until === sanction.until,
    'a restricted member cannot write; the end is in the error',
  );
  r = await get('/community/bootstrap', A);
  check(
    r.body.data.activeSanction?.until === sanction.until,
    'bootstrap shows the restriction',
  );
  r = await get('/community/posts', A);
  check(r.status === 200, 'a restricted member can still read');
  r = await get(`/operator/community/users/${userIds[A]}`, OP);
  check(
    r.status === 200 &&
      r.body.data.activeSanction.id === sanction.id &&
      r.body.data.sanctionable === true &&
      r.body.data.stats.postCount >= 2,
    'operator account view',
  );
  r = await post(`/operator/community/sanctions/${sanction.id}/revoke`, OP);
  check(
    r.status === 200 &&
      r.body.data.restored.posts >= 2 &&
      r.body.data.replayed === false,
    'lifted, content restored',
  );
  r = await post(`/operator/community/sanctions/${sanction.id}/revoke`, OP);
  check(
    r.status === 200 && r.body.data.replayed === true,
    'lifting again replays',
  );
  r = await get(`/community/posts/${publicPost.id}`, B);
  check(r.status === 200, 'restored post visible again');

  // --- Operator removal, author deletion, photos ----------------------------
  r = await post(`/operator/community/posts/${publicPost.id}/remove`, OP, {});
  check(
    r.status === 400 && r.body.error.code === 'INVALID_COMMUNITY_MODERATION',
    'removal needs a reason',
  );
  r = await post(`/operator/community/posts/${publicPost.id}/remove`, OP, {
    reason: 'AD_SPAM',
  });
  check(
    r.status === 200 &&
      r.body.data.removal.deletionKind === 'operator' &&
      r.body.data.replayed === false,
    'removed',
  );
  check(objectCount() === 0, 'its photo objects were deleted at once');
  r = await post(`/operator/community/posts/${publicPost.id}/remove`, OP, {
    reason: 'ABUSE',
  });
  check(
    r.status === 200 &&
      r.body.data.replayed === true &&
      r.body.data.removal.reason === 'AD_SPAM',
    'removal replays',
  );
  r = await get(`/community/posts/${publicPost.id}`, OP);
  check(r.status === 404, 'removed posts are hidden for everyone');
  const stored = await db.communityPost.findUniqueOrThrow({
    where: { id: publicPost.id },
  });
  check(
    stored.body.includes('시초가') && stored.removedByUserId === userIds[OP],
    'the body is kept with the removal record',
  );
  r = await del(`/community/comments/${rootForReplies.id}`, B);
  check(
    r.status === 200 &&
      r.body.data.comment.deleted === true &&
      r.body.data.comment.body === null,
    'own comment deleted',
  );
  r = await get(`/community/posts/${anonPost.id}/comments`, D);
  check(
    r.body.data.comments.some(
      (c: { id: string; deleted: boolean }) =>
        c.id === rootForReplies.id && c.deleted,
    ) &&
      r.body.data.comments.some(
        (c: { parentCommentId: string | null; deleted: boolean }) =>
          c.parentCommentId === rootForReplies.id && !c.deleted,
      ),
    'its place stays and the reply under it is still shown',
  );
  const audits = await db.operatorAuditLog.findMany({
    where: { actorUserId: userIds[OP] },
  });
  check(
    [
      'operator.community.sanction.create',
      'operator.community.sanction.revoke',
      'operator.community.post.remove',
      'operator.community.user.get',
    ].every((action) =>
      audits.some((row) => row.action === action && row.result === 'success'),
    ) && audits.every((row) => !JSON.stringify(row).includes('시초가')),
    'operator writes are audited without any text',
  );

  // --- Account deletion: posts go, comments stay as 탈퇴계정, carryover ------
  // An earlier restriction hid one comment and then expired: expiry restores
  // nothing (decision 5), so that comment stays hidden.
  const hiddenLater = (await comment(F, sortPost.id, { body: '숨겨질 댓글' }))
    .body.data.comment;
  r = await post(`/operator/community/users/${userIds[F]}/sanctions`, OP, {
    reason: 'FLOOD',
    duration: '7d',
    hideContent: true,
  });
  check(
    r.status === 201 && r.body.data.hidden.comments === 1,
    'an earlier restriction hid a comment',
  );
  await db.communitySanction.update({
    where: { id: r.body.data.sanction.id },
    data: {
      createdAt: new Date(Date.now() - 10 * 86_400_000),
      endsAt: new Date(Date.now() - 3 * 86_400_000),
    },
  });
  r = await get('/community/bootstrap', F);
  check(r.body.data.activeSanction === null, 'expired: no longer restricted');
  check(
    (
      await db.communityComment.findUniqueOrThrow({
        where: { id: hiddenLater.id },
      })
    ).hiddenBySanctionId !== null,
    'expiry kept it hidden',
  );
  r = await write(F, { body: `탈퇴할 회원의 글 ${tag}` }, [jpeg]);
  const leavingPost = r.body.data.post;
  const othersComment = (
    await comment(B, leavingPost.id, { body: '사라질 댓글' })
  ).body.data.comment;
  const keptComment = (
    await comment(F, anonPost.id, { body: '남을 댓글', anonymous: true })
  ).body.data.comment;
  const replyToKept = (
    await comment(B, anonPost.id, {
      body: '남을 댓글의 답글',
      parentCommentId: keptComment.id,
    })
  ).body.data.comment;
  await put(`/community/posts/${hotCandidate.id}/like`, F);
  await post('/community/reports', F, {
    targetType: 'post',
    targetId: lukewarm.id,
    reason: 'FLOOD',
  });
  await put(`/community/comments/${keptComment.id}/like`, D);
  r = await post(`/operator/community/users/${userIds[F]}/sanctions`, OP, {
    reason: 'ABUSE',
    duration: '30d',
    hideContent: false,
  });
  const leavingSanction = r.body.data.sanction;
  check(
    r.status === 201 && leavingSanction.active === true,
    'the leaving member is restricted now',
  );
  // An in-flight upload lease of the member at deletion time.
  const leaseKey = `community-images/${randomUUID()}.jpg`;
  await cleanups.reserveUploads(userIds[F], [leaseKey]);
  const deletion = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userIds[F]} FOR NO KEY UPDATE`;
    const scope = await lockDeletionScope(tx, userIds[F]);
    const now = await databaseNow(tx);
    const receipt = await tx.accountDeletion.create({
      data: {
        requestKeyHash: createHash('sha256')
          .update(`${tag}-deletion`)
          .digest('hex'),
        channel: 'app',
        status: 'cleanup_pending',
        deletedAt: now,
      },
      select: { id: true },
    });
    const waiting = await prepareCommunityAccountDeletion(tx, {
      userId: userIds[F],
      email: emails[F],
      accountDeletionId: receipt.id,
      now,
    });
    const rows = await purgeDeletionScope(tx, {
      userId: userIds[F],
      email: emails[F],
      scope,
    });
    return { receipt: receipt.id, waiting, rows };
  });
  userIds[F] = `deleted-${tag}`; // the row is gone
  check(
    deletion.waiting === 2 && deletion.rows.users === 1,
    'deleted; the receipt waits on the post photo and the lease',
  );
  check(
    (await db.communityPost.count({ where: { id: leavingPost.id } })) === 0,
    "the member's post is gone",
  );
  check(
    (await db.communityComment.count({ where: { id: othersComment.id } })) ===
      0,
    'with the comments under it',
  );
  const kept = await db.communityComment.findUniqueOrThrow({
    where: { id: keptComment.id },
  });
  check(
    kept.userId === null && kept.body === '남을 댓글',
    'their comment elsewhere stays, unlinked',
  );
  r = await get(`/community/posts/${anonPost.id}/comments`, D);
  const keptView = r.body.data.comments.find(
    (c: { id: string }) => c.id === keptComment.id,
  );
  check(
    keptView.author.kind === 'deleted_member' &&
      keptView.author.label === '탈퇴계정' &&
      keptView.likeCount === 1 &&
      r.body.data.comments.some((c: { id: string }) => c.id === replyToKept.id),
    'shown as 탈퇴계정 with its like and the reply under it',
  );
  const converted = await db.communityComment.findUniqueOrThrow({
    where: { id: hiddenLater.id },
  });
  check(
    converted.deletionKind === 'operator' &&
      converted.hiddenBySanctionId === null &&
      converted.removalReason === 'FLOOD' &&
      converted.removedByUserId === userIds[OP] &&
      converted.userId === null,
    'a comment hidden by the expired restriction became its removal (never reappears)',
  );
  const carryovers = await db.communitySanctionCarryover.findMany({
    where: { emailHash: communitySanctionEmailHash(emails[F]) },
  });
  check(
    carryovers.length === 1 &&
      carryovers[0].reason === 'ABUSE' &&
      carryovers[0].endsAt?.toISOString() === leavingSanction.until &&
      carryovers[0].expiresAt.getTime() === carryovers[0].endsAt?.getTime(),
    'the ongoing restriction is kept by email hash only',
  );
  const linked = await db.communityPhotoCleanup.findMany({
    where: { accountDeletionId: deletion.receipt },
  });
  check(
    linked.length === 2 && linked.every((row) => row.userId === null),
    'photo objects linked to the receipt, member link cleared',
  );
  // The lease ends later; make it due and let the worker pass remove both.
  await db.communityPhotoCleanup.updateMany({
    where: { objectKey: leaseKey },
    data: { nextAttemptAt: new Date(Date.now() - 1000) },
  });
  await cleanups.runDue();
  const receipt = await db.accountDeletion.findUniqueOrThrow({
    where: { id: deletion.receipt },
  });
  check(
    receipt.status === 'completed',
    'the receipt completes when the community objects are gone',
  );

  // Signing up again with the same email re-applies the restriction.
  const returning = await db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: emails[F],
        nickname: `community-${tag}-back`,
        passwordHash: 'test-only',
      },
    });
    await applyCommunitySanctionCarryover(tx, {
      userId: user.id,
      email: emails[F],
      now: new Date(),
    });
    return user.id;
  });
  userIds.push(returning);
  const carried = await db.communitySanction.findFirstOrThrow({
    where: { userId: returning },
  });
  check(
    carried.carriedOver &&
      carried.createdByUserId === null &&
      carried.reason === 'ABUSE' &&
      carried.endsAt?.toISOString() === leavingSanction.until &&
      (await db.communitySanctionCarryover.count({
        where: { emailHash: communitySanctionEmailHash(emails[F]) },
      })) === 0,
    'same reason and end on the new account; the carryover is consumed',
  );

  // --- Retention ----------------------------------------------------------
  const old = (days: number) => new Date(Date.now() - days * 86_400_000);
  r = await write(G, { body: `오래된 삭제 글 ${tag}` });
  const oldDeleted = r.body.data.post;
  await comment(B, oldDeleted.id, { body: '오래된 글의 댓글' });
  await del(`/community/posts/${oldDeleted.id}`, G);
  r = await write(G, { body: `최근 삭제 글 ${tag}` });
  const recentDeleted = r.body.data.post;
  await del(`/community/posts/${recentDeleted.id}`, G);
  await db.communityPost.update({
    where: { id: oldDeleted.id },
    data: { deletedAt: old(31) },
  });
  await db.communityPost.update({
    where: { id: recentDeleted.id },
    data: { deletedAt: old(29) },
  });
  const erasable = (await comment(G, sortPost.id, { body: '지울 댓글' })).body
    .data.comment;
  await comment(B, sortPost.id, {
    body: '그 아래 답글',
    parentCommentId: erasable.id,
  });
  await del(`/community/comments/${erasable.id}`, G);
  await db.communityComment.update({
    where: { id: erasable.id },
    data: { deletedAt: old(31) },
  });
  const oldReport = await db.communityReport.create({
    data: {
      userId: userIds[C],
      postId: sortPost.id,
      reason: 'ABUSE',
      createdAt: old(366),
    },
  });
  const expired = await db.communitySanctionCarryover.create({
    data: {
      emailHash: communitySanctionEmailHash(`gone-${tag}@example.invalid`),
      reason: 'ABUSE',
      endsAt: old(1),
      sanctionedAt: old(8),
      expiresAt: old(1),
    },
  });
  const swept = await db.$transaction((tx) =>
    deleteCommunityRetentionBatch(tx, 500),
  );
  check(
    (await db.communityPost.count({ where: { id: oldDeleted.id } })) === 0 &&
      (await db.communityPost.count({ where: { id: recentDeleted.id } })) === 1,
    'an author-deleted post goes after 30 days, not before',
  );
  const erased = await db.communityComment.findUniqueOrThrow({
    where: { id: erasable.id },
  });
  check(
    erased.body === null && erased.userId === null && erased.erasedAt !== null,
    'a deleted comment is erased after 30 days, its place kept',
  );
  check(
    (await db.communityReport.count({ where: { id: oldReport.id } })) === 0,
    'reports go after a year',
  );
  check(
    (await db.communitySanctionCarryover.count({
      where: { id: expired.id },
    })) === 0,
    'expired carryovers go',
  );
  check(
    swept.communityPosts >= 1 && swept.communityComments >= 1,
    'counts reported',
  );

  check((await financialState()) === baseline, 'no financial row changed');
  console.log(`community PostgreSQL + HTTP ok (${assertions} assertions)`);
}

async function cleanup() {
  const ids = userIds.filter((id) => !id.startsWith('deleted-'));
  const posts = await db.communityPost.findMany({
    where: { userId: { in: ids } },
    select: { id: true },
  });
  const postIds = posts.map((p) => p.id);
  const comments = await db.communityComment.findMany({
    where: { OR: [{ postId: { in: postIds } }, { userId: { in: ids } }] },
    select: { id: true },
  });
  const commentIds = comments.map((c) => c.id);
  await db.communityCommentLike.deleteMany({
    where: { OR: [{ commentId: { in: commentIds } }, { userId: { in: ids } }] },
  });
  await db.communityPostLike.deleteMany({
    where: { OR: [{ postId: { in: postIds } }, { userId: { in: ids } }] },
  });
  await db.communityReport.deleteMany({
    where: {
      OR: [
        { postId: { in: postIds } },
        { commentId: { in: commentIds } },
        { userId: { in: ids } },
      ],
    },
  });
  await db.communityPostAlias.deleteMany({
    where: { OR: [{ postId: { in: postIds } }, { userId: { in: ids } }] },
  });
  await db.communityPostPhoto.deleteMany({
    where: { postId: { in: postIds } },
  });
  await db.communityComment.updateMany({
    where: { postId: { in: postIds } },
    data: { parentCommentId: null },
  });
  await db.communityComment.deleteMany({
    where: { OR: [{ postId: { in: postIds } }, { id: { in: commentIds } }] },
  });
  await db.communityPost.deleteMany({ where: { id: { in: postIds } } });
  await db.communitySanction.deleteMany({ where: { userId: { in: ids } } });
  await db.communityRuleConsent.deleteMany({ where: { userId: { in: ids } } });
  await db.communityPhotoCleanup.deleteMany({
    where: {
      OR: [
        { userId: { in: ids } },
        {
          objectKey: { startsWith: 'community-images/' },
          accountDeletionId: null,
        },
      ],
    },
  });
  await db.communitySanctionCarryover.deleteMany({
    where: { emailHash: { in: emails.map(communitySanctionEmailHash) } },
  });
  await db.operatorAuditLog.deleteMany({ where: { actorUserId: { in: ids } } });
  await db.communityPhotoCleanup.deleteMany({
    where: {
      accountDeletion: {
        requestKeyHash: createHash('sha256')
          .update(`${tag}-deletion`)
          .digest('hex'),
      },
    },
  });
  await db.accountDeletion.deleteMany({
    where: {
      requestKeyHash: createHash('sha256')
        .update(`${tag}-deletion`)
        .digest('hex'),
    },
  });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

run()
  .finally(async () => {
    if (closeHttp) await closeHttp();
    await cleanup();
    await db.$disconnect();
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
