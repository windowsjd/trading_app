/**
 * AdMob rewarded ads with server-side verification — real PostgreSQL
 * (2026-11-07). Run only against a disposable local test DB (guard below).
 *
 * Google is stood in for by a locally generated P-256 key served as the SSV
 * key file: this proves the session → signed callback → claim/reset chain on
 * the real transactions, not a real Google callback.
 *
 * Covers: a session binds member/account/purpose/command before the ad; a
 * claim before the callback is PENDING and writes nothing; the callback
 * redeems once (5,000,000 KRW, one ad_reward ledger row, initialCapital
 * untouched) and the app's call replays; duplicate and concurrent callbacks
 * with concurrent app claims pay once; no daily cap or cooldown (several ads
 * in a row); forged/unknown-key/test-key callbacks, another ad unit, another
 * user id, an expired session and a reused transaction id apply nothing; a
 * top-up session never resets and a reset session never pays; a reset
 * session resets once; a blocked reset is refused before the ad, and one
 * blocked at callback time stays redeemable once the blocker is gone; and
 * member deletion removes the sessions.
 */
import assert from 'node:assert/strict';
import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { GeneralAccountsService } from '../src/trading-accounts/general-accounts.service';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { GeneralExternalFundingService } from '../src/portfolio/general-external-funding.service';
import { GeneralAccountPerformanceService } from '../src/portfolio/general-account-performance.service';
import { AdRewardService } from '../src/ad-rewards/ad-reward.service';
import { GeneralAccountResetService } from '../src/ad-rewards/general-account-reset.service';
import { AdRewardVerificationRegistry } from '../src/ad-rewards/ad-reward-verifier';
import { AdMobRewardVerifier } from '../src/ad-rewards/admob-reward-verifier';
import { AdMobRewardSessionService } from '../src/ad-rewards/admob-reward-session.service';
import { AdMobSsvKeyStore } from '../src/ad-rewards/admob-ssv-keys';
import { ADMOB_SESSION_EXPIRY_GRACE_MS } from '../src/ad-rewards/admob.config';
import { purgeDeletionScope } from '../src/auth/account-deletion.purge';

const target = new URL(process.env.DATABASE_URL ?? 'http://invalid');
const disposableDatabase =
  target.pathname.endsWith('_test') ||
  (process.env.GITHUB_ACTIONS === 'true' && target.pathname === '/trading_app');
if (
  process.env.NODE_ENV !== 'test' ||
  process.env.ADMOB_SSV_DB_INTEGRATION !== '1' ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  !disposableDatabase
) {
  throw new Error(
    'Explicit opt-in and a local disposable test database are required.',
  );
}

const ANDROID_UNIT = 'ca-app-pub-7899930948413451/3165650506';
const IOS_UNIT = 'ca-app-pub-7899930948413451/8170740188';
const BANNER_UNIT = 'ca-app-pub-7899930948413451/9868671521';
Object.assign(process.env, {
  AD_REWARD_ENABLED: 'true',
  AD_REWARD_PROVIDER: 'admob',
  AD_REWARD_AMOUNT_KRW: '5000000',
  AD_REWARD_DAILY_MAX_COUNT: 'unlimited',
  AD_REWARD_DAILY_MAX_AMOUNT_KRW: 'unlimited',
  AD_REWARD_COOLDOWN_SECONDS: '0',
  AD_REWARD_DAY_TIME_ZONE: 'Asia/Seoul',
  ADMOB_REWARDED_AD_UNIT_ID_ANDROID: ANDROID_UNIT,
  ADMOB_REWARDED_AD_UNIT_ID_IOS: IOS_UNIT,
});

const db = new PrismaService();
const access = new TradingAccountAccessService(db);
const valuation = new PortfolioValuationService(db);
const funding = new GeneralExternalFundingService(db);
const performance = new GeneralAccountPerformanceService(
  db,
  valuation,
  funding,
);
const opens = new GeneralAccountsService(db, performance);
const registry = new AdRewardVerificationRegistry([
  new AdMobRewardVerifier(db),
]);
const ads = new AdRewardService(db, access, registry, performance);
const resets = new GeneralAccountResetService(
  db,
  access,
  registry,
  performance,
  valuation,
);

// "Google": a production key set and a separate test key set.
const google = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const googleTest = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const stranger = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const KEY_ID = '3335741209';
const TEST_KEY_ID = '1234567890';
const keyFile = (keyId: string, key: typeof google.publicKey) => ({
  keys: [
    {
      keyId: Number(keyId),
      base64: key.export({ type: 'spki', format: 'der' }).toString('base64'),
    },
  ],
});
const keys = new AdMobSsvKeyStore(
  (url) =>
    Promise.resolve(
      url === 'prod'
        ? keyFile(KEY_ID, google.publicKey)
        : keyFile(TEST_KEY_ID, googleTest.publicKey),
    ),
  () => Date.now(),
  { production: 'prod', test: 'test' },
);
const sessions = new AdMobRewardSessionService(db, ads, resets, registry, keys);

const users: Array<{ id: string; email: string }> = [];
const assets: string[] = [];
let checks = 0;
const pass = (label: string) => {
  checks += 1;
  console.log(`PASS AdMobSsv ${label}`);
};

function codeOf(caught: unknown): string {
  assert.equal(caught instanceof HttpException, true, String(caught));
  return (
    (caught as HttpException).getResponse() as { error: { code: string } }
  ).error.code;
}
async function rejectsCode(work: Promise<unknown>, code: string) {
  await assert.rejects(work, (caught: unknown) => {
    assert.equal(codeOf(caught), code);
    return true;
  });
}
const money = (value: Prisma.Decimal | string | number) =>
  new Prisma.Decimal(value).toFixed(8);

async function member() {
  const id = randomUUID();
  const email = `${id}@admob-ssv.example`;
  await db.user.create({
    data: {
      id,
      email,
      nickname: `ssv-${id.slice(0, 8)}`,
      passwordHash: 'test-only',
    },
  });
  users.push({ id, email });
  const accountId = (await opens.openGeneralAccount(id)).data.account.id;
  return { userId: id, accountId };
}
async function krw(accountId: string) {
  const wallet = await db.cashWallet.findFirstOrThrow({
    where: {
      tradingAccountId: accountId,
      walletScope: 'securities',
      currencyCode: 'KRW',
    },
    select: { balanceAmount: true },
  });
  return money(wallet.balanceAmount);
}
async function counts(accountId: string) {
  const [claims, rewardLedger, resetRows] = await Promise.all([
    db.adRewardClaim.count({ where: { tradingAccountId: accountId } }),
    db.walletTransaction.count({
      where: { tradingAccountId: accountId, txType: 'ad_reward' },
    }),
    db.generalAccountReset.count({ where: { tradingAccountId: accountId } }),
  ]);
  return { claims, rewardLedger, resetRows };
}
type Opened = Awaited<ReturnType<typeof sessions.createSession>>['data'];
async function open(
  m: { userId: string; accountId: string },
  purpose: 'funding' | 'account_reset',
  platform: 'android' | 'ios' = 'android',
) {
  const idempotencyKey = `${purpose === 'funding' ? 'ad_reward_claim' : 'account_reset'}_${randomUUID()}`;
  const opened = await sessions.createSession(m.userId, m.accountId, {
    purpose,
    platform,
    idempotencyKey,
  });
  return { ...opened.data, idempotencyKey };
}
const webSafe = (buffer: Buffer) =>
  buffer
    .toString('base64')
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '');
/** Google's callback for a session's ad (alphabetical params; signature and key_id last). */
function callback(
  session: Opened,
  {
    adUnit = (session.platform === 'ios' ? IOS_UNIT : ANDROID_UNIT).split(
      '/',
    )[1],
    userId = session.ssv.userId,
    transactionId = randomBytes(16).toString('hex'),
    signer = google.privateKey,
    keyId = KEY_ID,
  } = {},
) {
  const params: Record<string, string> = {
    ad_network: '5450213213286189855',
    ad_unit: adUnit,
    custom_data: session.ssv.customData,
    reward_amount: '1',
    reward_item: '가상 자금',
    timestamp: String(Date.now()),
    transaction_id: transactionId,
    user_id: userId,
  };
  const content = Object.keys(params)
    .sort()
    .map((name) => `${name}=${encodeURIComponent(params[name])}`)
    .join('&');
  const signature = sign(
    'sha256',
    Buffer.from(decodeURIComponent(content), 'utf8'),
    { key: signer, dsaEncoding: 'der' },
  );
  return {
    query: `${content}&signature=${webSafe(signature)}&key_id=${keyId}`,
    transactionId,
  };
}
const command = (s: { sessionId: string; idempotencyKey: string }) => ({
  provider: 'admob',
  proof: s.sessionId,
  idempotencyKey: s.idempotencyKey,
});

async function run() {
  await db.$connect();

  // ============================================================ top-up
  const a = await member();
  const opening = await krw(a.accountId);
  const initialCapital = (
    await db.tradingAccount.findUniqueOrThrow({ where: { id: a.accountId } })
  ).initialCapitalKrw.toFixed(8);
  const s1 = await open(a, 'funding');
  assert.equal(s1.created, true);
  assert.equal(s1.purpose, 'funding');
  assert.equal(s1.ssv.customData, s1.sessionId);
  assert.match(s1.ssv.userId, /^[0-9a-f]{32}$/u);
  // Same command key: the same session (an app retry never opens a second one).
  const again = await sessions.createSession(a.userId, a.accountId, {
    purpose: 'funding',
    platform: 'android',
    idempotencyKey: s1.idempotencyKey,
  });
  assert.equal(again.data.sessionId, s1.sessionId);
  assert.equal(again.data.created, false);
  await rejectsCode(
    sessions.createSession(a.userId, a.accountId, {
      purpose: 'account_reset',
      platform: 'android',
      idempotencyKey: s1.idempotencyKey,
    }),
    'AD_REWARD_IDEMPOTENCY_CONFLICT',
  );
  // The app's claim before Google's callback: pending, nothing written.
  await rejectsCode(
    ads.claim(a.userId, a.accountId, command(s1)),
    'AD_REWARD_VERIFICATION_PENDING',
  );
  assert.deepEqual(await counts(a.accountId), {
    claims: 0,
    rewardLedger: 0,
    resetRows: 0,
  });
  assert.equal(await krw(a.accountId), opening);
  // Google's callback records the event and redeems the command itself.
  const cb1 = callback(s1);
  assert.deepEqual(await sessions.handleSsvCallback(cb1.query), {
    status: 200,
    outcome: 'REDEEMED',
  });
  const recorded = await db.adRewardSession.findUniqueOrThrow({
    where: { id: s1.sessionId },
  });
  assert.equal(recorded.ssvTransactionId, cb1.transactionId);
  assert.equal(
    await krw(a.accountId),
    money(new Prisma.Decimal(opening).add(5_000_000)),
  );
  assert.deepEqual(await counts(a.accountId), {
    claims: 1,
    rewardLedger: 1,
    resetRows: 0,
  });
  const claim = await db.adRewardClaim.findFirstOrThrow({
    where: { tradingAccountId: a.accountId },
  });
  assert.equal(claim.status, 'granted');
  assert.equal(claim.provider, 'admob');
  assert.equal(claim.providerEventId, cb1.transactionId);
  assert.equal(claim.idempotencyKey, s1.idempotencyKey);
  assert.equal(money(claim.rewardAmountKrw), '5000000.00000000');
  assert.equal(
    (
      await db.tradingAccount.findUniqueOrThrow({ where: { id: a.accountId } })
    ).initialCapitalKrw.toFixed(8),
    initialCapital,
    'an ad reward is external funding, never the initial capital',
  );
  // The app's own call replays; Google re-sending the same callback replays.
  const replay = await ads.claim(a.userId, a.accountId, command(s1));
  assert.equal(replay.data.duplicate, true);
  assert.equal(replay.data.claimId, claim.id);
  assert.deepEqual(await sessions.handleSsvCallback(cb1.query), {
    status: 200,
    outcome: 'REDEEMED',
  });
  assert.deepEqual(await counts(a.accountId), {
    claims: 1,
    rewardLedger: 1,
    resetRows: 0,
  });
  // A second, different event for the same (already confirmed) session pays nothing.
  assert.deepEqual(await sessions.handleSsvCallback(callback(s1).query), {
    status: 200,
    outcome: 'SESSION_ALREADY_CONFIRMED',
  });
  assert.deepEqual(await counts(a.accountId), {
    claims: 1,
    rewardLedger: 1,
    resetRows: 0,
  });
  pass(
    'top-up: pending before the callback (nothing written), one 5,000,000 KRW ad_reward credit on it, app and Google retries replay',
  );

  // Concurrent: three copies of Google's callback and two app claims at once.
  const s2 = await open(a, 'funding');
  const cb2 = callback(s2);
  const raced = await Promise.allSettled([
    sessions.handleSsvCallback(cb2.query),
    sessions.handleSsvCallback(cb2.query),
    sessions.handleSsvCallback(cb2.query),
    ads.claim(a.userId, a.accountId, command(s2)),
    ads.claim(a.userId, a.accountId, command(s2)),
  ]);
  for (const result of raced.slice(0, 3)) {
    assert.equal(result.status, 'fulfilled');
    assert.equal(
      (result as PromiseFulfilledResult<{ status: number }>).value.status,
      200,
    );
  }
  for (const result of raced.slice(3)) {
    // An app call is a success/replay, or PENDING when it read before the record.
    if (result.status === 'rejected')
      assert.equal(codeOf(result.reason), 'AD_REWARD_VERIFICATION_PENDING');
  }
  assert.deepEqual(await counts(a.accountId), {
    claims: 2,
    rewardLedger: 2,
    resetRows: 0,
  });
  assert.equal(
    await krw(a.accountId),
    money(new Prisma.Decimal(opening).add(10_000_000)),
  );
  pass(
    'concurrent duplicate callbacks and app claims: one claim, one ledger row, one credit',
  );

  // No daily cap, no cooldown: three more ads in a row, all paid the same day.
  for (let i = 0; i < 3; i += 1) {
    const next = await open(a, 'funding', i % 2 ? 'ios' : 'android');
    assert.equal(
      (await sessions.handleSsvCallback(callback(next).query)).outcome,
      'REDEEMED',
    );
  }
  assert.deepEqual(await counts(a.accountId), {
    claims: 5,
    rewardLedger: 5,
    resetRows: 0,
  });
  assert.equal(
    await krw(a.accountId),
    money(new Prisma.Decimal(opening).add(25_000_000)),
  );
  const eligibility = (await ads.getEligibility(a.userId, a.accountId)).data;
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.grantedCountToday, 5);
  assert.equal(eligibility.remainingCountToday, null, 'unlimited, not 0');
  assert.equal(eligibility.remainingAmountTodayKrw, null);
  assert.equal(eligibility.nextEligibleAt, null, 'no cooldown');
  pass(
    'unlimited daily count/amount and no cooldown: consecutive ads each pay 5,000,000 KRW (Android and iOS units)',
  );

  // =================================================== refused callbacks
  const before = await counts(a.accountId);
  const s3 = await open(a, 'funding');
  const unrecorded = async () =>
    assert.equal(
      (
        await db.adRewardSession.findUniqueOrThrow({
          where: { id: s3.sessionId },
        })
      ).ssvTransactionId,
      null,
    );
  assert.equal(
    (
      await sessions.handleSsvCallback(
        callback(s3, { signer: stranger.privateKey }).query,
      )
    ).status,
    403,
  );
  assert.equal(
    (await sessions.handleSsvCallback(callback(s3, { keyId: '999' }).query))
      .status,
    403,
  );
  assert.equal(
    (
      await sessions.handleSsvCallback(
        callback(s3).query.replace('reward_amount=1', 'reward_amount=9'),
      )
    ).status,
    403,
  );
  // A real Google signature for ANOTHER unit's ad (an attacker's own unit,
  // custom data carrying this session and our unit), re-encoded so the raw
  // query would read our unit: refused before any key is read.
  {
    const ours = ANDROID_UNIT.split('/')[1];
    const rest = `reward_amount=1&reward_item=x&timestamp=${Date.now()}&transaction_id=${randomBytes(16).toString('hex')}&user_id=${s3.ssv.userId}`;
    const signedByGoogle = `ad_network=5450213213286189855&ad_unit=9999999999&custom_data=${s3.ssv.customData}&ad_unit=${ours}&${rest}`;
    const signature = webSafe(
      sign('sha256', Buffer.from(signedByGoogle, 'utf8'), {
        key: google.privateKey,
        dsaEncoding: 'der',
      }),
    );
    for (const forged of [
      `ad_network%3D5450213213286189855%26ad_unit=9999999999&custom_data=${s3.ssv.customData}&ad_unit=${ours}&${rest}`,
      `ad_network=5450213213286189855%26ad_unit%3D9999999999&custom_data=${s3.ssv.customData}&ad_unit=${ours}&${rest}`,
    ]) {
      assert.equal(decodeURIComponent(forged), signedByGoogle);
      assert.equal(
        (
          await sessions.handleSsvCallback(
            `${forged}&signature=${signature}&key_id=${KEY_ID}`,
          )
        ).status,
        400,
      );
    }
  }
  // Google's testing tool (test key): acknowledged, never applied.
  assert.deepEqual(
    await sessions.handleSsvCallback(
      callback(s3, { signer: googleTest.privateKey, keyId: TEST_KEY_ID }).query,
    ),
    { status: 200, outcome: 'TEST_KEY_ACKNOWLEDGED' },
  );
  // Signed, but not this session's ad: another unit (iOS's, the banner's), another user id.
  for (const adUnit of [IOS_UNIT.split('/')[1], BANNER_UNIT.split('/')[1]])
    assert.deepEqual(
      await sessions.handleSsvCallback(callback(s3, { adUnit }).query),
      { status: 200, outcome: 'AD_UNIT_MISMATCH' },
    );
  assert.deepEqual(
    await sessions.handleSsvCallback(
      callback(s3, { userId: 'f'.repeat(32) }).query,
    ),
    { status: 200, outcome: 'USER_MISMATCH' },
  );
  assert.equal(
    (await sessions.handleSsvCallback('ad_unit=1&signature=x')).status,
    400,
  );
  await unrecorded();
  assert.deepEqual(await counts(a.accountId), before);
  await rejectsCode(
    ads.claim(a.userId, a.accountId, command(s3)),
    'AD_REWARD_VERIFICATION_PENDING',
  );
  // Expired before any confirmation: a late callback is not recorded; the
  // claim stays pending through the grace (a callback that passed its check
  // may still be committing), then it is final.
  await db.adRewardSession.update({
    where: { id: s3.sessionId },
    data: {
      createdAt: new Date(Date.now() - 3_600_000),
      expiresAt: new Date(Date.now() - 1_000),
    },
  });
  assert.deepEqual(await sessions.handleSsvCallback(callback(s3).query), {
    status: 200,
    outcome: 'SESSION_EXPIRED',
  });
  await unrecorded();
  await rejectsCode(
    ads.claim(a.userId, a.accountId, command(s3)),
    'AD_REWARD_VERIFICATION_PENDING',
  );
  await db.adRewardSession.update({
    where: { id: s3.sessionId },
    data: {
      expiresAt: new Date(Date.now() - ADMOB_SESSION_EXPIRY_GRACE_MS - 1_000),
    },
  });
  await rejectsCode(
    ads.claim(a.userId, a.accountId, command(s3)),
    'AD_REWARD_VERIFICATION_FAILED',
  );
  // One Google event can confirm one session only.
  const s4 = await open(a, 'funding');
  assert.deepEqual(
    await sessions.handleSsvCallback(
      callback(s4, { transactionId: cb1.transactionId }).query,
    ),
    { status: 200, outcome: 'TRANSACTION_ALREADY_USED' },
  );
  assert.deepEqual(await counts(a.accountId), before);
  // Another member's session id under this member's command: refused.
  const b = await member();
  const s5 = await open(b, 'funding');
  await rejectsCode(
    ads.claim(a.userId, a.accountId, command(s5)),
    'AD_REWARD_VERIFICATION_FAILED',
  );
  assert.deepEqual(await counts(a.accountId), before);
  pass(
    'forged / unknown-key / altered callbacks 403, a re-encoded foreign signature 400; test key, other unit, other user, expired session and a reused event apply nothing',
  );

  // ============================================== purposes never cross
  const c = await member();
  const topUp = await open(c, 'funding');
  await sessions.handleSsvCallback(callback(topUp).query);
  // The top-up session's proof offered for a reset (its own key, or a new one): no reset.
  await rejectsCode(
    resets.reset(c.userId, c.accountId, command(topUp)),
    'AD_REWARD_IDEMPOTENCY_CONFLICT',
  );
  await rejectsCode(
    resets.reset(c.userId, c.accountId, {
      provider: 'admob',
      proof: topUp.sessionId,
      idempotencyKey: `account_reset_${randomUUID()}`,
    }),
    'AD_REWARD_VERIFICATION_FAILED',
  );
  // A reset session confirmed by Google resets once…
  const balanceBeforeReset = await krw(c.accountId);
  assert.equal(balanceBeforeReset, '15000000.00000000');
  const resetSession = await open(c, 'account_reset');
  // …and its proof never pays a top-up.
  const resetEvent = callback(resetSession);
  await rejectsCode(
    ads.claim(c.userId, c.accountId, command(resetSession)),
    'AD_REWARD_VERIFICATION_PENDING',
  );
  assert.deepEqual(await sessions.handleSsvCallback(resetEvent.query), {
    status: 200,
    outcome: 'REDEEMED',
  });
  assert.equal(await krw(c.accountId), '10000000.00000000');
  assert.deepEqual(await counts(c.accountId), {
    claims: 2,
    rewardLedger: 1,
    resetRows: 1,
  });
  await rejectsCode(
    ads.claim(c.userId, c.accountId, {
      provider: 'admob',
      proof: resetSession.sessionId,
      idempotencyKey: `ad_reward_claim_${randomUUID()}`,
    }),
    'AD_REWARD_VERIFICATION_FAILED',
  );
  const resetReplay = await resets.reset(
    c.userId,
    c.accountId,
    command(resetSession),
  );
  assert.equal(resetReplay.data.duplicate, true);
  assert.deepEqual(await sessions.handleSsvCallback(resetEvent.query), {
    status: 200,
    outcome: 'REDEEMED',
  });
  assert.deepEqual(await counts(c.accountId), {
    claims: 2,
    rewardLedger: 1,
    resetRows: 1,
  });
  pass(
    'purposes never cross: a top-up session never resets, a reset session resets once and never pays',
  );

  // ============================================ reset blocked (before/after)
  const d = await member();
  const asset = await db.asset.create({
    data: {
      symbol: `SSV${randomUUID().replace(/-/gu, '').slice(0, 12).toUpperCase()}`,
      name: 'admob-ssv-integration',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
      isActive: true,
    },
    select: { id: true },
  });
  assets.push(asset.id);
  const blocker = () =>
    db.conditionalBuyOrder.create({
      data: {
        tradingAccountId: d.accountId,
        assetId: asset.id,
        triggerCondition: 'at_or_below',
        triggerPrice: '90',
        executionType: 'market',
        amount: '10',
        currencyCode: 'USD',
        idempotencyKey: randomUUID(),
        requestHash: 'fixture',
      },
      select: { id: true },
    });
  const clear = (id: string) =>
    db.conditionalBuyOrder.update({
      where: { id },
      data: { status: 'canceled', endedAt: new Date() },
    });
  const early = await blocker();
  await rejectsCode(open(d, 'account_reset'), 'GENERAL_ACCOUNT_RESET_BLOCKED');
  assert.equal(
    await db.adRewardSession.count({
      where: { tradingAccountId: d.accountId },
    }),
    0,
    'no ad for a reset that would be refused',
  );
  await clear(early.id);
  const late = await open(d, 'account_reset');
  const lateBlocker = await blocker();
  const lateEvent = callback(late);
  // Confirmed and recorded, but the reset is refused: nothing moves, the ad stays redeemable once.
  assert.deepEqual(await sessions.handleSsvCallback(lateEvent.query), {
    status: 200,
    outcome: 'GENERAL_ACCOUNT_RESET_BLOCKED',
  });
  assert.equal(
    (
      await db.adRewardSession.findUniqueOrThrow({
        where: { id: late.sessionId },
      })
    ).ssvTransactionId,
    lateEvent.transactionId,
  );
  assert.deepEqual(await counts(d.accountId), {
    claims: 0,
    rewardLedger: 0,
    resetRows: 0,
  });
  await rejectsCode(
    resets.reset(d.userId, d.accountId, command(late)),
    'GENERAL_ACCOUNT_RESET_BLOCKED',
  );
  await clear(lateBlocker.id);
  const done = await resets.reset(d.userId, d.accountId, command(late));
  assert.equal(done.data.reset, true);
  assert.deepEqual(await counts(d.accountId), {
    claims: 1,
    rewardLedger: 0,
    resetRows: 1,
  });
  pass(
    'a blocked reset is refused before the ad; blocked at callback time it moves nothing and stays redeemable once',
  );

  // ============================================== member deletion
  const e = await member();
  await open(e, 'funding');
  await deleteMember(e.userId);
  assert.equal(
    await db.adRewardSession.count({ where: { userId: e.userId } }),
    0,
  );
  pass("member deletion removes the member's ad sessions");

  console.log(`admob ssv DB integration passed (${checks} checks)`);
}

async function deleteMember(userId: string) {
  const member = users.find((row) => row.id === userId)!;
  const accountIds = (
    await db.tradingAccount.findMany({
      where: { userId },
      select: { id: true },
    })
  ).map((row) => row.id);
  await db.$transaction((tx) =>
    purgeDeletionScope(tx, {
      userId,
      email: member.email,
      scope: { accountIds, participants: [], seasonStatus: new Map() },
    }),
  );
  users.splice(users.indexOf(member), 1);
}

async function cleanup() {
  for (const member of [...users]) await deleteMember(member.id);
  await db.asset.deleteMany({ where: { id: { in: assets } } });
}

run()
  .finally(async () => {
    try {
      await cleanup();
    } finally {
      await db.$disconnect();
    }
  })
  .catch((failure: unknown) => {
    console.error(failure);
    process.exitCode = 1;
  });
