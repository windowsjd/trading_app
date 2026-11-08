/**
 * AdMob rewarded ads with server-side verification — real PostgreSQL
 * (2026-11-07). Run only against a disposable local test database (guard below).
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
 * session resets once; a blocked reset is refused before the ad; and member
 * deletion removes the sessions.
 *
 * Server recovery (2026-11-08): a real PostgreSQL failure injected into the
 * payout/reset transaction AFTER the event was recorded (a trigger raising a
 * serialization failure on that account's ledger insert) rolls everything
 * back and leaves the session pending; once it is over, the worker alone —
 * app closed, Google's retries spent — pays 5,000,000 KRW or resets once,
 * with its Ops run recorded. Also: worker passes racing Google's callback and
 * the app's own call pay once; ads switched off pay nothing; a paid reward
 * whose bookkeeping was lost is replayed, never paid again; past 24 h the
 * server stops.
 *
 * Final refusals (2026-11-08, the second pass): a reset refused at callback
 * time — blocked, its ended epoch not valuable (a real valuation outage), ads
 * switched off, the account suspended — is NEVER run again once the cause is
 * gone: not by the worker, not by a re-sent callback, and not by the app's
 * 결과 확인 (that call only reads AD_REWARD_REDEMPTION_CLOSED). A refusal
 * whose record write FAILS (a trigger on ad_reward_sessions) leaves the
 * attempt's unsettled marker, and after the database recovers, the blocker
 * is gone and Google re-sends, a restarted server still never resets.
 * A write that changes 0 rows, a commit whose bookkeeping write fails, a
 * top-up during a valuation outage (pending → paid once), the app being told
 * "pending" (never "refused") while the server will still pay, a new ad
 * refused while an earlier reset is pending, and a member's explicit new
 * reset (new session, new ad) after a refusal resetting exactly once.
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
import { AdRewardPurpose, Prisma } from '../src/generated/prisma/client';
import { GeneralAccountsService } from '../src/trading-accounts/general-accounts.service';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { PortfolioValuationError } from '../src/portfolio/portfolio-valuation.policy';
import { GeneralExternalFundingService } from '../src/portfolio/general-external-funding.service';
import { GeneralAccountPerformanceService } from '../src/portfolio/general-account-performance.service';
import { AdRewardService } from '../src/ad-rewards/ad-reward.service';
import { GeneralAccountResetService } from '../src/ad-rewards/general-account-reset.service';
import { AdRewardVerificationRegistry } from '../src/ad-rewards/ad-reward-verifier';
import { AdMobRewardVerifier } from '../src/ad-rewards/admob-reward-verifier';
import { AdMobRewardSessionService } from '../src/ad-rewards/admob-reward-session.service';
import { AdMobRedemptionWorker } from '../src/ad-rewards/admob-redemption.worker';
import { AdMobSsvKeyStore } from '../src/ad-rewards/admob-ssv-keys';
import {
  ADMOB_REDEMPTION_OUTCOME_UNKNOWN,
  ADMOB_REDEMPTION_UNSETTLED,
  ADMOB_REDEMPTION_WINDOW_MS,
  ADMOB_SESSION_EXPIRY_GRACE_MS,
} from '../src/ad-rewards/admob.config';
import { OpsJobLockService } from '../src/ops/ops-job-lock.service';
import { OpsJobRunService } from '../src/ops/ops-job-run.service';
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

/**
 * Accounts whose valuation is down (the USD/KRW rate or a price cannot be
 * read right now). Everything else is the real valuation; the reset's own
 * catch turns this into GENERAL_ACCOUNT_RESET_UNAVAILABLE, a top-up's
 * boundary snapshot into a failed payout transaction.
 */
const valuationOutage = new Set<string>();

/** One server process: its own client and the production object graph. */
function server(db: PrismaService) {
  const access = new TradingAccountAccessService(db);
  const valuation = new PortfolioValuationService(db);
  const realValuation =
    valuation.calculateTradingAccountValuation.bind(valuation);
  valuation.calculateTradingAccountValuation = async (
    ...args: Parameters<
      PortfolioValuationService['calculateTradingAccountValuation']
    >
  ) => {
    if (valuationOutage.has(args[0]))
      throw new PortfolioValuationError(
        'FX_RATE_STALE',
        'USD/KRW FX rate snapshot is stale.',
      );
    return realValuation(...args);
  };
  const funding = new GeneralExternalFundingService(db);
  const performance = new GeneralAccountPerformanceService(
    db,
    valuation,
    funding,
  );
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
  const sessions = new AdMobRewardSessionService(
    db,
    ads,
    resets,
    registry,
    keys,
  );
  return {
    opens: new GeneralAccountsService(db, performance),
    ads,
    resets,
    sessions,
    // The production worker with the real Ops lease and run records (its
    // timer is never started here: each tick is called explicitly).
    worker: new AdMobRedemptionWorker(
      sessions,
      new OpsJobLockService(db),
      new OpsJobRunService(db),
    ),
  };
}

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

const db = new PrismaService();
const { opens, ads, resets, sessions, worker } = server(db);
const REDEMPTION_LOCK_KEY = 'ad_reward_redemption:current';

type Member = { userId: string; accountId: string };
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
/** A CLOSED answer: final, with the stored status and reason. */
async function rejectsClosed(
  work: Promise<unknown>,
  status: 'refused' | 'exhausted',
  reasonCode: string,
) {
  await assert.rejects(work, (caught: unknown) => {
    assert.equal(codeOf(caught), 'AD_REWARD_REDEMPTION_CLOSED');
    const response = (caught as HttpException).getResponse() as {
      error: { message: string; details?: Record<string, string> };
    };
    assert.deepEqual(response.error.details, { status, reasonCode });
    assert.equal(
      response.error.message,
      'This ad reward request was not applied and will not run again.',
    );
    return true;
  });
}
const money = (value: Prisma.Decimal | string | number) =>
  new Prisma.Decimal(value).toFixed(8);

async function member(): Promise<Member> {
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
type Opened = Awaited<ReturnType<typeof sessions.createSession>>['data'] & {
  idempotencyKey: string;
};
async function open(
  m: Member,
  purpose: 'funding' | 'account_reset',
  platform: 'android' | 'ios' = 'android',
): Promise<Opened> {
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
/**
 * The app's own call — POST …/ad-rewards/claim or …/account-reset exactly as
 * the controllers route it (memberCommand); its 결과 확인 is the same call.
 */
const app = {
  claim: (m: Member, s: Opened, via = sessions) =>
    via.memberCommand(
      AdRewardPurpose.funding,
      m.userId,
      m.accountId,
      command(s),
    ),
  reset: (m: Member, s: Opened, via = sessions) =>
    via.memberCommand(
      AdRewardPurpose.account_reset,
      m.userId,
      m.accountId,
      command(s),
    ),
};

/** A worker pass "this long from now" (the due scan only; attempts use the real clock). */
const after = (ms: number) => new Date(Date.now() + ms);
async function redemption(sessionId: string) {
  return db.adRewardSession.findUniqueOrThrow({
    where: { id: sessionId },
    select: {
      ssvTransactionId: true,
      redemptionStatus: true,
      redemptionAttemptCount: true,
      redemptionNextAttemptAt: true,
      redemptionErrorCode: true,
    },
  });
}
/** The attempt's time (backoff, or an unsettled attempt's lease) has passed. */
async function makeDue(sessionId: string) {
  await db.adRewardSession.update({
    where: { id: sessionId },
    data: { redemptionNextAttemptAt: new Date(Date.now() - 1_000) },
  });
}
/**
 * A real PostgreSQL failure inside this account's payout/reset transaction:
 * its ledger insert raises a serialization failure (40001, Prisma P2034)
 * after the wallet row already moved, so the whole transaction rolls back.
 * Only this account, only while `work` runs.
 */
async function withLedgerFault<T>(
  accountId: string,
  work: () => Promise<T>,
): Promise<T> {
  assert.match(accountId, /^[0-9a-f-]{36}$/u);
  const name = `admob_ssv_fault_${randomUUID().replace(/-/gu, '')}`;
  await db.$executeRawUnsafe(
    `CREATE FUNCTION "${name}"() RETURNS trigger LANGUAGE plpgsql AS $fault$
     BEGIN
       IF NEW."trading_account_id" = '${accountId}' THEN
         RAISE EXCEPTION 'injected outage' USING ERRCODE = '40001';
       END IF;
       RETURN NEW;
     END $fault$`,
  );
  await db.$executeRawUnsafe(
    `CREATE TRIGGER "${name}" BEFORE INSERT ON "wallet_transactions" FOR EACH ROW EXECUTE FUNCTION "${name}"()`,
  );
  try {
    return await work();
  } finally {
    await db.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS "${name}" ON "wallet_transactions"`,
    );
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${name}"()`);
  }
}
/**
 * A real PostgreSQL failure on the BOOKKEEPING write of one session: the
 * UPDATE that would settle it to `status` either fails (`fail`: a connection
 * failure SQLSTATE raised by a trigger) or changes 0 rows (`skip`: the
 * BEFORE trigger drops it). Only that session, only that status, only while
 * `work` runs.
 */
async function withSessionWriteFault<T>(
  sessionId: string,
  status: 'refused' | 'redeemed',
  mode: 'fail' | 'skip',
  work: () => Promise<T>,
): Promise<T> {
  assert.match(sessionId, /^[0-9a-f-]{36}$/u);
  const name = `admob_ssv_settle_fault_${randomUUID().replace(/-/gu, '')}`;
  await db.$executeRawUnsafe(
    `CREATE FUNCTION "${name}"() RETURNS trigger LANGUAGE plpgsql AS $fault$
     BEGIN
       IF NEW."id" = '${sessionId}' AND OLD."redemption_status" = 'pending'
          AND NEW."redemption_status" = '${status}' THEN
         ${mode === 'fail' ? `RAISE EXCEPTION 'injected outage' USING ERRCODE = '08006';` : 'RETURN NULL;'}
       END IF;
       RETURN NEW;
     END $fault$`,
  );
  await db.$executeRawUnsafe(
    `CREATE TRIGGER "${name}" BEFORE UPDATE ON "ad_reward_sessions" FOR EACH ROW EXECUTE FUNCTION "${name}"()`,
  );
  try {
    return await work();
  } finally {
    await db.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS "${name}" ON "ad_reward_sessions"`,
    );
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${name}"()`);
  }
}
async function latestRedemptionRun() {
  return db.opsJobRun.findFirstOrThrow({
    where: { jobName: 'ad_reward_redemption' },
    orderBy: { startedAt: 'desc' },
    select: { status: true, resultJson: true },
  });
}

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
  await rejectsCode(app.claim(a, s1), 'AD_REWARD_VERIFICATION_PENDING');
  assert.deepEqual(await counts(a.accountId), {
    claims: 0,
    rewardLedger: 0,
    resetRows: 0,
  });
  assert.equal(await krw(a.accountId), opening);
  // Not confirmed by Google: nothing for the server to redeem, ever — a
  // recovery pass (even "an hour later") never touches it.
  assert.equal((await redemption(s1.sessionId)).redemptionStatus, null);
  assert.equal((await sessions.redeemDueSessions(after(3_600_000))).due, 0);
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
  // Redeemed on arrival: settled, nothing left for the recovery worker.
  assert.equal(recorded.redemptionStatus, 'redeemed');
  assert.equal(recorded.redemptionNextAttemptAt === null, true);
  assert.equal(recorded.redemptionErrorCode === null, true);
  assert.equal(recorded.redemptionAttemptCount, 0);
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
  // The app's own call replays; Google re-sending the same callback is
  // answered from the record (nothing runs).
  const replay = (await app.claim(a, s1)) as Awaited<
    ReturnType<typeof ads.claim>
  >;
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
    app.claim(a, s2),
    app.claim(a, s2),
  ]);
  const callbackOutcomes = raced.slice(0, 3).map((result) => {
    assert.equal(result.status, 'fulfilled');
    const answer = (
      result as PromiseFulfilledResult<{ status: number; outcome: string }>
    ).value;
    assert.equal(answer.status, 200);
    return answer.outcome;
  });
  // Exactly one copy recorded the event and ran the command.
  assert.equal(
    callbackOutcomes.filter((outcome) => outcome === 'REDEEMED').length >= 1,
    true,
  );
  for (const outcome of callbackOutcomes)
    assert.equal(['REDEEMED', 'REDEMPTION_PENDING'].includes(outcome), true);
  for (const result of raced.slice(3)) {
    // An app call is a replay, or PENDING when it read before the commit.
    if (result.status === 'rejected')
      assert.equal(
        [
          'AD_REWARD_VERIFICATION_PENDING',
          'AD_REWARD_REDEMPTION_PENDING',
        ].includes(codeOf(result.reason)),
        true,
      );
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
  await rejectsCode(app.claim(a, s3), 'AD_REWARD_VERIFICATION_PENDING');
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
  await rejectsCode(app.claim(a, s3), 'AD_REWARD_VERIFICATION_PENDING');
  await db.adRewardSession.update({
    where: { id: s3.sessionId },
    data: {
      expiresAt: new Date(Date.now() - ADMOB_SESSION_EXPIRY_GRACE_MS - 1_000),
    },
  });
  await rejectsCode(app.claim(a, s3), 'AD_REWARD_VERIFICATION_FAILED');
  // The command's own verifier gives the same answer (one rule, two paths).
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
  await rejectsCode(app.claim(a, s5), 'AD_REWARD_VERIFICATION_FAILED');
  assert.deepEqual(await counts(a.accountId), before);
  pass(
    'forged / unknown-key / altered callbacks 403, a re-encoded foreign signature 400; test key, other unit, other user, expired session and a reused event apply nothing',
  );

  // ============================================== purposes never cross
  const c = await member();
  const topUp = await open(c, 'funding');
  await sessions.handleSsvCallback(callback(topUp).query);
  // The top-up session's proof offered for a reset (its own key, or a new one): no reset.
  await rejectsCode(app.reset(c, topUp), 'AD_REWARD_IDEMPOTENCY_CONFLICT');
  await rejectsCode(
    app.reset(c, { ...topUp, idempotencyKey: `account_reset_${randomUUID()}` }),
    'AD_REWARD_VERIFICATION_FAILED',
  );
  // A reset session confirmed by Google resets once…
  const balanceBeforeReset = await krw(c.accountId);
  assert.equal(balanceBeforeReset, '15000000.00000000');
  const resetSession = await open(c, 'account_reset');
  // …and its proof never pays a top-up.
  const resetEvent = callback(resetSession);
  await rejectsCode(
    app.claim(c, resetSession),
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
  assert.equal(
    (await redemption(resetSession.sessionId)).redemptionStatus,
    'redeemed',
  );
  await rejectsCode(
    app.claim(c, {
      ...resetSession,
      idempotencyKey: `ad_reward_claim_${randomUUID()}`,
    }),
    'AD_REWARD_VERIFICATION_FAILED',
  );
  const resetReplay = (await app.reset(c, resetSession)) as Awaited<
    ReturnType<typeof resets.reset>
  >;
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
  const blocker = (m: Member) =>
    db.conditionalBuyOrder.create({
      data: {
        tradingAccountId: m.accountId,
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
  const early = await blocker(d);
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
  const lateBlocker = await blocker(d);
  const lateEvent = callback(late);
  // Confirmed and recorded, but the reset is refused: nothing moves.
  assert.deepEqual(await sessions.handleSsvCallback(lateEvent.query), {
    status: 200,
    outcome: 'GENERAL_ACCOUNT_RESET_BLOCKED',
  });
  assert.equal(
    (await redemption(late.sessionId)).ssvTransactionId,
    lateEvent.transactionId,
  );
  assert.deepEqual(await counts(d.accountId), {
    claims: 0,
    rewardLedger: 0,
    resetRows: 0,
  });
  // A product-rule refusal is final: settled `refused`, and the app's call
  // reads it as CLOSED with its reason (a final refusal the app may show).
  const refusedRow = await redemption(late.sessionId);
  assert.equal(refusedRow.redemptionStatus, 'refused');
  assert.equal(refusedRow.redemptionErrorCode, 'GENERAL_ACCOUNT_RESET_BLOCKED');
  assert.equal(refusedRow.redemptionNextAttemptAt === null, true);
  await rejectsClosed(
    app.reset(d, late),
    'refused',
    'GENERAL_ACCOUNT_RESET_BLOCKED',
  );
  await clear(lateBlocker.id);
  // The blocker is gone, yet nothing resets the account: neither a recovery
  // pass (even hours later), nor the worker, nor Google re-sending, nor the
  // app's 결과 확인 (it only reads the result).
  assert.equal((await sessions.redeemDueSessions(after(7_200_000))).due, 0);
  await worker.tick();
  assert.deepEqual(await sessions.handleSsvCallback(lateEvent.query), {
    status: 200,
    outcome: 'REDEMPTION_REFUSED',
  });
  await rejectsClosed(
    app.reset(d, late),
    'refused',
    'GENERAL_ACCOUNT_RESET_BLOCKED',
  );
  assert.deepEqual(await counts(d.accountId), {
    claims: 0,
    rewardLedger: 0,
    resetRows: 0,
  });
  assert.equal(await krw(d.accountId), '10000000.00000000');
  // The member decides again: a new session (all gates re-checked) and a
  // new ad reset the account exactly once.
  const redo = await open(d, 'account_reset');
  assert.notEqual(redo.sessionId, late.sessionId);
  assert.equal(
    (await sessions.handleSsvCallback(callback(redo).query)).outcome,
    'REDEEMED',
  );
  assert.deepEqual(await counts(d.accountId), {
    claims: 1,
    rewardLedger: 0,
    resetRows: 1,
  });
  await rejectsClosed(
    app.reset(d, late),
    'refused',
    'GENERAL_ACCOUNT_RESET_BLOCKED',
  );
  pass(
    'a blocked reset is refused before the ad; blocked at callback time it is final — never run by the worker, a re-sent callback or the app\'s 결과 확인 once the blocker is gone; the member\'s new session resets once',
  );

  await serverRecovery(blocker, clear);
  await finalRefusals(blocker, clear);

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

type Blocker = (m: Member) => Promise<{ id: string }>;
type Clear = (id: string) => Promise<unknown>;

async function serverRecovery(blocker: Blocker, clear: Clear) {
  // ============================== top-up: outage after the recorded event
  const f = await member();
  const fOpening = await krw(f.accountId);
  const fCapital = (
    await db.tradingAccount.findUniqueOrThrow({ where: { id: f.accountId } })
  ).initialCapitalKrw.toFixed(8);
  const r1 = await open(f, 'funding');
  const r1Event = callback(r1);
  await withLedgerFault(f.accountId, async () => {
    // Google's call meets the outage; its retries (five, 1 s apart) are only
    // told where it stands — the server owns the recorded event now.
    assert.deepEqual(await sessions.handleSsvCallback(r1Event.query), {
      status: 503,
      outcome: 'REDEEM_FAILED',
    });
    for (let i = 0; i < 5; i += 1)
      assert.deepEqual(await sessions.handleSsvCallback(r1Event.query), {
        status: 200,
        outcome: 'REDEMPTION_PENDING',
      });
    // The app is told "pending", never "refused": the server will pay it.
    await rejectsCode(app.claim(f, r1), 'AD_REWARD_REDEMPTION_PENDING');
    // A recovery attempt during the outage fails too, and backs off.
    assert.equal((await sessions.redeemDueSessions(after(61_000))).retrying, 1);
  });
  let row = await redemption(r1.sessionId);
  assert.equal(row.ssvTransactionId, r1Event.transactionId);
  assert.equal(row.redemptionStatus, 'pending');
  assert.equal(row.redemptionAttemptCount, 1);
  assert.equal(row.redemptionErrorCode, 'REDEEM_FAILED');
  // Rolled back as a whole (the wallet had moved before the ledger insert).
  assert.deepEqual(await counts(f.accountId), {
    claims: 0,
    rewardLedger: 0,
    resetRows: 0,
  });
  assert.equal(await krw(f.accountId), fOpening);
  // Backing off: a pass right now runs nothing.
  assert.equal((await sessions.redeemDueSessions()).due, 0);
  // The outage is over and the app is closed — no app call, no callback:
  // the worker's next tick redeems it, once, and records its Ops run.
  await makeDue(r1.sessionId);
  await worker.tick();
  row = await redemption(r1.sessionId);
  assert.equal(row.redemptionStatus, 'redeemed');
  assert.equal(row.redemptionAttemptCount, 2);
  assert.equal(row.redemptionNextAttemptAt === null, true);
  assert.equal(row.redemptionErrorCode, null);
  assert.deepEqual(await counts(f.accountId), {
    claims: 1,
    rewardLedger: 1,
    resetRows: 0,
  });
  assert.equal(
    await krw(f.accountId),
    money(new Prisma.Decimal(fOpening).add(5_000_000)),
  );
  const claim = await db.adRewardClaim.findFirstOrThrow({
    where: { tradingAccountId: f.accountId },
  });
  assert.equal(claim.status, 'granted');
  assert.equal(claim.providerEventId, r1Event.transactionId);
  assert.equal(claim.idempotencyKey, r1.idempotencyKey);
  assert.equal(money(claim.rewardAmountKrw), '5000000.00000000');
  const ledger = await db.walletTransaction.findFirstOrThrow({
    where: { tradingAccountId: f.accountId, txType: 'ad_reward' },
  });
  assert.equal(ledger.referenceId, claim.id);
  assert.equal(money(ledger.amount), '5000000.00000000');
  assert.equal(
    (
      await db.tradingAccount.findUniqueOrThrow({ where: { id: f.accountId } })
    ).initialCapitalKrw.toFixed(8),
    fCapital,
  );
  const run = await latestRedemptionRun();
  assert.equal(run.status, 'succeeded');
  assert.equal((run.resultJson as { redeemed: number }).redeemed, 1);
  // Later deliveries replay: Google re-sending, the app's call, more passes.
  assert.deepEqual(await sessions.handleSsvCallback(r1Event.query), {
    status: 200,
    outcome: 'REDEEMED',
  });
  assert.equal(
    ((await app.claim(f, r1)) as Awaited<ReturnType<typeof ads.claim>>).data
      .duplicate,
    true,
  );
  assert.equal((await sessions.redeemDueSessions(after(7_200_000))).due, 0);
  assert.deepEqual(await counts(f.accountId), {
    claims: 1,
    rewardLedger: 1,
    resetRows: 0,
  });
  pass(
    'top-up: a DB failure after the recorded event rolls the payout back (the app told "pending"); afterwards the worker alone (app closed, Google retries spent) pays 5,000,000 KRW once',
  );

  // Already paid, but its bookkeeping lost (as if the settle write failed):
  // the worker replays the committed command and never pays again.
  await db.adRewardSession.update({
    where: { id: r1.sessionId },
    data: {
      redemptionStatus: 'pending',
      redemptionErrorCode: ADMOB_REDEMPTION_UNSETTLED,
      redemptionNextAttemptAt: new Date(Date.now() - 1_000),
    },
  });
  assert.equal((await sessions.redeemDueSessions()).redeemed, 1);
  assert.equal((await redemption(r1.sessionId)).redemptionStatus, 'redeemed');
  assert.deepEqual(await counts(f.accountId), {
    claims: 1,
    rewardLedger: 1,
    resetRows: 0,
  });
  assert.equal(
    await krw(f.accountId),
    money(new Prisma.Decimal(fOpening).add(5_000_000)),
  );
  pass('a paid reward run again by the worker replays; nothing is paid twice');

  // ================================ reset: outage in the middle of a reset
  const g = await member();
  const topUp = await open(g, 'funding');
  assert.equal(
    (await sessions.handleSsvCallback(callback(topUp).query)).outcome,
    'REDEEMED',
  );
  assert.equal(await krw(g.accountId), '15000000.00000000');
  const r2 = await open(g, 'account_reset');
  const r2Event = callback(r2);
  await withLedgerFault(g.accountId, async () => {
    assert.deepEqual(await sessions.handleSsvCallback(r2Event.query), {
      status: 503,
      outcome: 'REDEEM_FAILED',
    });
    // A transient database failure: pending — the app is not told "refused".
    await rejectsCode(app.reset(g, r2), 'AD_REWARD_REDEMPTION_PENDING');
  });
  assert.deepEqual(await counts(g.accountId), {
    claims: 1,
    rewardLedger: 1,
    resetRows: 0,
  });
  assert.equal(await krw(g.accountId), '15000000.00000000');
  row = await redemption(r2.sessionId);
  assert.equal(row.redemptionStatus, 'pending');
  assert.equal(row.redemptionErrorCode, 'REDEEM_FAILED');
  // While that reset is pending no new ad opens: it would wipe a new top-up
  // (or reset twice) when the server completes the first one.
  await rejectsCode(open(g, 'funding'), 'AD_REWARD_REDEMPTION_PENDING');
  await rejectsCode(open(g, 'account_reset'), 'AD_REWARD_REDEMPTION_PENDING');
  await makeDue(r2.sessionId);
  await worker.tick();
  assert.equal(await krw(g.accountId), '10000000.00000000');
  assert.deepEqual(await counts(g.accountId), {
    claims: 2,
    rewardLedger: 1,
    resetRows: 1,
  });
  assert.equal((await redemption(r2.sessionId)).redemptionStatus, 'redeemed');
  assert.equal(
    ((await app.reset(g, r2)) as Awaited<ReturnType<typeof resets.reset>>).data
      .duplicate,
    true,
  );
  assert.deepEqual(await sessions.handleSsvCallback(r2Event.query), {
    status: 200,
    outcome: 'REDEEMED',
  });
  assert.equal(
    await db.generalAccountReset.count({
      where: { tradingAccountId: g.accountId },
    }),
    1,
  );
  // Settled: new ads open again.
  assert.equal((await open(g, 'funding')).created, true);
  pass(
    'reset: a DB failure mid-reset rolls the whole reset back; no new ad opens while it is pending; afterwards the worker resets once (app closed), replays answer the same reset',
  );

  // ===================== concurrency: worker passes vs callback vs the app
  const h = await member();
  const hOpening = await krw(h.accountId);
  const pendingAfterOutage = async () => {
    const opened = await open(h, 'funding');
    const event = callback(opened);
    await withLedgerFault(h.accountId, async () => {
      assert.equal((await sessions.handleSsvCallback(event.query)).status, 503);
    });
    await makeDue(opened.sessionId);
    return { opened, event };
  };
  const r3 = await pendingAfterOutage();
  const raced3 = await Promise.allSettled([
    sessions.handleSsvCallback(r3.event.query),
    sessions.handleSsvCallback(r3.event.query),
    sessions.redeemDueSessions(),
    sessions.redeemDueSessions(),
    worker.tick(),
    app.claim(h, r3.opened),
  ]);
  for (const result of raced3.slice(0, 5))
    assert.equal(result.status, 'fulfilled');
  for (const result of raced3.slice(0, 2)) {
    const answer = (
      result as PromiseFulfilledResult<{ status: number; outcome: string }>
    ).value;
    assert.equal(answer.status, 200);
    assert.equal(
      ['REDEEMED', 'REDEMPTION_PENDING'].includes(answer.outcome),
      true,
    );
  }
  if (raced3[5].status === 'rejected')
    assert.equal(codeOf(raced3[5].reason), 'AD_REWARD_REDEMPTION_PENDING');
  assert.deepEqual(await counts(h.accountId), {
    claims: 1,
    rewardLedger: 1,
    resetRows: 0,
  });
  assert.equal(
    await krw(h.accountId),
    money(new Prisma.Decimal(hOpening).add(5_000_000)),
  );
  assert.equal(
    (await redemption(r3.opened.sessionId)).redemptionStatus,
    'redeemed',
  );
  const r4 = await pendingAfterOutage();
  const raced4 = await Promise.allSettled([
    app.claim(h, r4.opened),
    app.claim(h, r4.opened),
    sessions.redeemDueSessions(),
    sessions.redeemDueSessions(),
  ]);
  for (const result of raced4.slice(2))
    assert.equal(result.status, 'fulfilled');
  for (const result of raced4.slice(0, 2))
    if (result.status === 'rejected')
      assert.equal(codeOf(result.reason), 'AD_REWARD_REDEMPTION_PENDING');
  assert.deepEqual(await counts(h.accountId), {
    claims: 2,
    rewardLedger: 2,
    resetRows: 0,
  });
  assert.equal(
    await krw(h.accountId),
    money(new Prisma.Decimal(hOpening).add(10_000_000)),
  );
  assert.equal(
    (await redemption(r4.opened.sessionId)).redemptionStatus,
    'redeemed',
  );
  pass(
    "worker passes racing Google's callback and the app's own call: one claim, one ledger row, one credit",
  );

  // ======================= account status changed before the recovery
  const k = await member();
  const r5 = await open(k, 'funding');
  const r5Event = callback(r5);
  await withLedgerFault(k.accountId, async () => {
    assert.equal((await sessions.handleSsvCallback(r5Event.query)).status, 503);
  });
  await db.tradingAccount.update({
    where: { id: k.accountId },
    data: { status: 'suspended' },
  });
  await makeDue(r5.sessionId);
  assert.equal((await sessions.redeemDueSessions()).refused, 1);
  row = await redemption(r5.sessionId);
  assert.equal(row.redemptionStatus, 'refused');
  assert.equal(row.redemptionErrorCode, 'TRADING_ACCOUNT_NOT_ACTIVE');
  await db.tradingAccount.update({
    where: { id: k.accountId },
    data: { status: 'active' },
  });
  // Active again: nothing pays the refused command — no pass, no re-sent
  // callback, and the app's call reads it as closed.
  assert.equal((await sessions.redeemDueSessions(after(7_200_000))).due, 0);
  assert.deepEqual(await sessions.handleSsvCallback(r5Event.query), {
    status: 200,
    outcome: 'REDEMPTION_REFUSED',
  });
  await rejectsClosed(
    app.claim(k, r5),
    'refused',
    'TRADING_ACCOUNT_NOT_ACTIVE',
  );
  assert.deepEqual(await counts(k.accountId), {
    claims: 0,
    rewardLedger: 0,
    resetRows: 0,
  });
  pass(
    'an account suspended before the recovery: refused (TRADING_ACCOUNT_NOT_ACTIVE) and final — never paid after reactivation, the app reads it closed',
  );

  // ================================================ ads switched off
  const kBalance = await krw(k.accountId);
  const r6 = await open(k, 'funding');
  const r6Event = callback(r6);
  await withLedgerFault(k.accountId, async () => {
    assert.equal((await sessions.handleSsvCallback(r6Event.query)).status, 503);
  });
  process.env.AD_REWARD_ENABLED = 'false';
  try {
    await makeDue(r6.sessionId);
    await worker.tick();
    row = await redemption(r6.sessionId);
    assert.equal(row.redemptionStatus, 'pending', 'paused, not spent');
    assert.equal(row.redemptionAttemptCount, 0);
    // Forced anyway: the command refuses (503), nothing is paid; a top-up
    // owed for a confirmed ad stays pending for when ads are back.
    assert.equal((await sessions.redeemDueSessions()).retrying, 1);
    assert.deepEqual(await sessions.handleSsvCallback(r6Event.query), {
      status: 200,
      outcome: 'REDEMPTION_PENDING',
    });
    await rejectsCode(app.claim(k, r6), 'AD_REWARD_REDEMPTION_PENDING');
    row = await redemption(r6.sessionId);
    assert.equal(row.redemptionStatus, 'pending');
    assert.equal(row.redemptionErrorCode, 'AD_REWARD_DISABLED');
    assert.equal(await krw(k.accountId), kBalance);
    assert.deepEqual(await counts(k.accountId), {
      claims: 0,
      rewardLedger: 0,
      resetRows: 0,
    });
  } finally {
    process.env.AD_REWARD_ENABLED = 'true';
  }
  await makeDue(r6.sessionId);
  await worker.tick();
  assert.equal((await redemption(r6.sessionId)).redemptionStatus, 'redeemed');
  assert.equal(
    await krw(k.accountId),
    money(new Prisma.Decimal(kBalance).add(5_000_000)),
  );
  assert.deepEqual(await counts(k.accountId), {
    claims: 1,
    rewardLedger: 1,
    resetRows: 0,
  });
  pass(
    'ads switched off: the worker pauses and a forced top-up run is refused (AD_REWARD_DISABLED), nothing paid, the app told pending; back on, it pays once',
  );

  // ================================== the 24 h window after confirmation
  const r8 = await open(k, 'funding');
  const r8Event = callback(r8);
  await withLedgerFault(k.accountId, async () => {
    assert.equal((await sessions.handleSsvCallback(r8Event.query)).status, 503);
  });
  // Google confirmed it over a day ago (the server was down all that time).
  await db.adRewardSession.update({
    where: { id: r8.sessionId },
    data: {
      ssvVerifiedAt: new Date(Date.now() - ADMOB_REDEMPTION_WINDOW_MS - 60_000),
      redemptionNextAttemptAt: new Date(Date.now() - 1_000),
    },
  });
  await worker.tick();
  row = await redemption(r8.sessionId);
  assert.equal(row.redemptionStatus, 'exhausted');
  assert.equal(row.redemptionErrorCode, 'REDEEM_FAILED');
  assert.equal(row.redemptionNextAttemptAt === null, true);
  assert.equal((await latestRedemptionRun()).status, 'failed');
  assert.deepEqual(await sessions.handleSsvCallback(r8Event.query), {
    status: 200,
    outcome: 'REDEMPTION_EXHAUSTED',
  });
  await rejectsClosed(app.claim(k, r8), 'exhausted', 'REDEEM_FAILED');
  assert.deepEqual(await counts(k.accountId), {
    claims: 1,
    rewardLedger: 1,
    resetRows: 0,
  });
  // Past the window, a reward that DID commit (its bookkeeping lost) is
  // reported redeemed — never "unpaid" — and still not run again.
  await db.adRewardSession.update({
    where: { id: r6.sessionId },
    data: {
      ssvVerifiedAt: new Date(Date.now() - ADMOB_REDEMPTION_WINDOW_MS - 60_000),
      redemptionStatus: 'pending',
      redemptionErrorCode: ADMOB_REDEMPTION_UNSETTLED,
      redemptionNextAttemptAt: new Date(Date.now() - 1_000),
    },
  });
  assert.equal((await sessions.redeemDueSessions()).redeemed, 1);
  assert.equal((await redemption(r6.sessionId)).redemptionStatus, 'redeemed');
  assert.deepEqual(await counts(k.accountId), {
    claims: 1,
    rewardLedger: 1,
    resetRows: 0,
  });
  pass(
    'past 24 h after Google confirmed it, the server stops (exhausted, run recorded failed, the app reads it closed) without running the command; a committed one is reported redeemed',
  );
  void blocker;
  void clear;
}

/**
 * A reset the server refused is final, whatever happens afterwards; a
 * refusal whose record was lost never turns into a later reset; the app's
 * display follows the server (2026-11-08).
 */
async function finalRefusals(blocker: Blocker, clear: Clear) {
  // ================== the ended epoch cannot be valued (a valuation outage)
  const v = await member();
  const vTopUp = await open(v, 'funding');
  await sessions.handleSsvCallback(callback(vTopUp).query);
  assert.equal(await krw(v.accountId), '15000000.00000000');
  const unvalued = await open(v, 'account_reset');
  const unvaluedEvent = callback(unvalued);
  valuationOutage.add(v.accountId);
  try {
    // 503 GENERAL_ACCOUNT_RESET_UNAVAILABLE is a product answer about the
    // account, not a server outage: final at once.
    assert.deepEqual(await sessions.handleSsvCallback(unvaluedEvent.query), {
      status: 200,
      outcome: 'GENERAL_ACCOUNT_RESET_UNAVAILABLE',
    });
    const row = await redemption(unvalued.sessionId);
    assert.equal(row.redemptionStatus, 'refused');
    assert.equal(row.redemptionErrorCode, 'GENERAL_ACCOUNT_RESET_UNAVAILABLE');
    await rejectsClosed(
      app.reset(v, unvalued),
      'refused',
      'GENERAL_ACCOUNT_RESET_UNAVAILABLE',
    );
  } finally {
    valuationOutage.delete(v.accountId);
  }
  // The rate is back: the reset is resettable again, yet nothing resets it.
  assert.equal(
    (await resets.getEligibility(v.userId, v.accountId)).data.eligible,
    true,
  );
  assert.equal((await sessions.redeemDueSessions(after(7_200_000))).due, 0);
  await worker.tick();
  assert.deepEqual(await sessions.handleSsvCallback(unvaluedEvent.query), {
    status: 200,
    outcome: 'REDEMPTION_REFUSED',
  });
  await rejectsClosed(
    app.reset(v, unvalued),
    'refused',
    'GENERAL_ACCOUNT_RESET_UNAVAILABLE',
  );
  assert.equal(await krw(v.accountId), '15000000.00000000');
  assert.deepEqual(await counts(v.accountId), {
    claims: 1,
    rewardLedger: 1,
    resetRows: 0,
  });
  pass(
    'a reset refused because its epoch could not be valued (503 UNAVAILABLE) is final: once the valuation is back no worker pass, re-sent callback or app 결과 확인 resets it',
  );

  // A top-up during the same kind of outage is owed for a confirmed ad: the
  // app is told pending (never "refused") and the worker pays it once later.
  const vFunding = await open(v, 'funding');
  const vFundingEvent = callback(vFunding);
  valuationOutage.add(v.accountId);
  try {
    assert.deepEqual(await sessions.handleSsvCallback(vFundingEvent.query), {
      status: 503,
      outcome: 'REDEEM_FAILED',
    });
    await rejectsCode(app.claim(v, vFunding), 'AD_REWARD_REDEMPTION_PENDING');
    await makeDue(vFunding.sessionId);
    assert.equal((await sessions.redeemDueSessions()).retrying, 1);
  } finally {
    valuationOutage.delete(v.accountId);
  }
  await makeDue(vFunding.sessionId);
  await worker.tick();
  assert.equal(
    (await redemption(vFunding.sessionId)).redemptionStatus,
    'redeemed',
  );
  assert.equal(await krw(v.accountId), '20000000.00000000');
  assert.deepEqual(await counts(v.accountId), {
    claims: 2,
    rewardLedger: 2,
    resetRows: 0,
  });
  pass(
    'a top-up during a valuation outage stays pending (the app told pending, not refused) and is paid once afterwards',
  );

  // ===== the refusal is decided, its RECORD fails, then everything recovers
  const w = await member();
  const lost = await open(w, 'account_reset');
  const lostEvent = callback(lost);
  const lostBlocker = await blocker(w);
  await withSessionWriteFault(lost.sessionId, 'refused', 'fail', async () => {
    // Refused (blocked), but the refusal cannot be written: never "final"
    // for Google, and the attempt's marker stays on the row.
    assert.deepEqual(await sessions.handleSsvCallback(lostEvent.query), {
      status: 503,
      outcome: 'REDEMPTION_RECORD_FAILED',
    });
  });
  let row = await redemption(lost.sessionId);
  assert.equal(row.redemptionStatus, 'pending');
  assert.equal(row.redemptionErrorCode, ADMOB_REDEMPTION_UNSETTLED);
  // The app is not told "refused" (the server has not settled it) …
  await rejectsCode(app.reset(w, lost), 'AD_REWARD_REDEMPTION_PENDING');
  // … the database recovered, the blocker is gone, Google re-sends: no reset.
  await clear(lostBlocker.id);
  assert.equal(
    (await resets.getEligibility(w.userId, w.accountId)).data.eligible,
    true,
  );
  assert.deepEqual(await sessions.handleSsvCallback(lostEvent.query), {
    status: 200,
    outcome: 'REDEMPTION_PENDING',
  });
  // A restarted server (new process, new client) reads the same row once
  // the attempt's time is up: the outcome is unknown, so it is closed.
  const restartedDb = new PrismaService();
  await restartedDb.$connect();
  try {
    const restarted = server(restartedDb);
    await makeDue(lost.sessionId);
    await restarted.worker.tick();
    row = await redemption(lost.sessionId);
    assert.equal(row.redemptionStatus, 'refused');
    assert.equal(row.redemptionErrorCode, ADMOB_REDEMPTION_OUTCOME_UNKNOWN);
    assert.equal(row.redemptionNextAttemptAt === null, true);
    const run = await latestRedemptionRun();
    assert.equal(run.status, 'failed', 'Ops sees the lost outcome');
    assert.equal((run.resultJson as { unknown: number }).unknown, 1);
    assert.deepEqual(await restarted.sessions.handleSsvCallback(lostEvent.query), {
      status: 200,
      outcome: 'REDEMPTION_REFUSED',
    });
    await rejectsClosed(
      app.reset(w, lost, restarted.sessions),
      'refused',
      ADMOB_REDEMPTION_OUTCOME_UNKNOWN,
    );
    await restarted.worker.tick();
    assert.equal(
      (await restarted.sessions.redeemDueSessions(after(7_200_000))).due,
      0,
    );
  } finally {
    await restartedDb.$disconnect();
  }
  assert.equal(await krw(w.accountId), '10000000.00000000');
  assert.deepEqual(await counts(w.accountId), {
    claims: 0,
    rewardLedger: 0,
    resetRows: 0,
  });
  // Only the member's explicit new reset (a new session, a new ad) resets —
  // exactly once, with a new event.
  const explicit = await open(w, 'account_reset');
  const explicitEvent = callback(explicit);
  assert.notEqual(explicitEvent.transactionId, lostEvent.transactionId);
  assert.equal(
    (await sessions.handleSsvCallback(explicitEvent.query)).outcome,
    'REDEEMED',
  );
  assert.deepEqual(await counts(w.accountId), {
    claims: 1,
    rewardLedger: 0,
    resetRows: 1,
  });
  pass(
    'a refusal whose record write FAILED: after the DB recovers, the blocker is gone and Google re-sends, a restarted worker closes it (REDEMPTION_OUTCOME_UNKNOWN) without resetting; the app reads closed; only the member\'s new session resets, once',
  );

  // The same on the worker's attempt: pending after a transient failure, the
  // worker's attempt is refused (blocked) and that record fails too.
  const x = await member();
  // A balance off the reset target, so the reset writes ledger rows (where
  // the fault is injected).
  await sessions.handleSsvCallback(callback(await open(x, 'funding')).query);
  const xs = await open(x, 'account_reset');
  const xsEvent = callback(xs);
  await withLedgerFault(x.accountId, async () => {
    assert.equal((await sessions.handleSsvCallback(xsEvent.query)).status, 503);
  });
  const xBlocker = await blocker(x);
  await makeDue(xs.sessionId);
  await withSessionWriteFault(xs.sessionId, 'refused', 'fail', async () => {
    assert.equal((await sessions.redeemDueSessions()).unsettled, 1);
  });
  row = await redemption(xs.sessionId);
  assert.equal(row.redemptionStatus, 'pending');
  assert.equal(row.redemptionErrorCode, ADMOB_REDEMPTION_UNSETTLED);
  assert.equal(row.redemptionAttemptCount, 1);
  await clear(xBlocker.id);
  await makeDue(xs.sessionId);
  assert.equal((await sessions.redeemDueSessions()).unknown, 1);
  assert.equal(
    (await redemption(xs.sessionId)).redemptionErrorCode,
    ADMOB_REDEMPTION_OUTCOME_UNKNOWN,
  );
  assert.equal(await krw(x.accountId), '15000000.00000000');
  assert.deepEqual(await counts(x.accountId), {
    claims: 1,
    rewardLedger: 1,
    resetRows: 0,
  });
  pass(
    "the worker's own refusal whose record write failed: the next pass closes it without resetting (blocker gone)",
  );

  // ===== an outcome write that changes 0 rows is re-read, never assumed
  const y = await member();
  const ys = await open(y, 'account_reset');
  const ysEvent = callback(ys);
  const yBlocker = await blocker(y);
  await withSessionWriteFault(ys.sessionId, 'refused', 'skip', async () => {
    // The UPDATE matched nothing: the callback re-reads the row (still
    // pending) and says so instead of reporting a settled refusal.
    assert.deepEqual(await sessions.handleSsvCallback(ysEvent.query), {
      status: 200,
      outcome: 'REDEMPTION_PENDING',
    });
  });
  assert.equal(
    (await redemption(ys.sessionId)).redemptionErrorCode,
    ADMOB_REDEMPTION_UNSETTLED,
  );
  await clear(yBlocker.id);
  await makeDue(ys.sessionId);
  await worker.tick();
  assert.equal(
    (await redemption(ys.sessionId)).redemptionErrorCode,
    ADMOB_REDEMPTION_OUTCOME_UNKNOWN,
  );
  assert.deepEqual(await counts(y.accountId), {
    claims: 0,
    rewardLedger: 0,
    resetRows: 0,
  });
  pass(
    'an outcome write that changed 0 rows is re-read (the callback reports pending, not refused); the worker then closes it without resetting',
  );

  // ===== the money moved, the bookkeeping write failed: no second payout
  const z = await member();
  const zOpening = await krw(z.accountId);
  const zs = await open(z, 'funding');
  const zsEvent = callback(zs);
  await withSessionWriteFault(zs.sessionId, 'redeemed', 'fail', async () => {
    assert.deepEqual(await sessions.handleSsvCallback(zsEvent.query), {
      status: 200,
      outcome: 'REDEEMED',
    });
  });
  assert.equal(
    (await redemption(zs.sessionId)).redemptionErrorCode,
    ADMOB_REDEMPTION_UNSETTLED,
  );
  // The app reads the committed claim (a replay), not "pending".
  assert.equal(
    ((await app.claim(z, zs)) as Awaited<ReturnType<typeof ads.claim>>).data
      .duplicate,
    true,
  );
  await makeDue(zs.sessionId);
  await worker.tick();
  assert.equal((await redemption(zs.sessionId)).redemptionStatus, 'redeemed');
  assert.equal(
    await krw(z.accountId),
    money(new Prisma.Decimal(zOpening).add(5_000_000)),
  );
  assert.deepEqual(await counts(z.accountId), {
    claims: 1,
    rewardLedger: 1,
    resetRows: 0,
  });
  // The same for a reset: committed once, bookkeeping lost, replayed only.
  const zr = await open(z, 'account_reset');
  await withSessionWriteFault(zr.sessionId, 'redeemed', 'fail', async () => {
    assert.equal(
      (await sessions.handleSsvCallback(callback(zr).query)).outcome,
      'REDEEMED',
    );
  });
  await makeDue(zr.sessionId);
  await worker.tick();
  assert.equal((await redemption(zr.sessionId)).redemptionStatus, 'redeemed');
  assert.equal(await krw(z.accountId), '10000000.00000000');
  assert.deepEqual(await counts(z.accountId), {
    claims: 2,
    rewardLedger: 1,
    resetRows: 1,
  });
  pass(
    'a committed payout or reset whose bookkeeping write failed is replayed by the worker (settled redeemed): no second credit, no second reset',
  );

  // ================== ads switched off while a reset is being redeemed
  const o = await member();
  const os = await open(o, 'account_reset');
  const osEvent = callback(os);
  process.env.AD_REWARD_ENABLED = 'false';
  try {
    // A reset's answer of the command is final: AD_REWARD_DISABLED included.
    assert.deepEqual(await sessions.handleSsvCallback(osEvent.query), {
      status: 200,
      outcome: 'AD_REWARD_DISABLED',
    });
  } finally {
    process.env.AD_REWARD_ENABLED = 'true';
  }
  assert.equal((await redemption(os.sessionId)).redemptionStatus, 'refused');
  await worker.tick();
  assert.equal((await sessions.redeemDueSessions(after(7_200_000))).due, 0);
  assert.deepEqual(await sessions.handleSsvCallback(osEvent.query), {
    status: 200,
    outcome: 'REDEMPTION_REFUSED',
  });
  await rejectsClosed(app.reset(o, os), 'refused', 'AD_REWARD_DISABLED');
  assert.deepEqual(await counts(o.accountId), {
    claims: 0,
    rewardLedger: 0,
    resetRows: 0,
  });
  pass(
    'ads switched off while a reset is redeemed: refused (AD_REWARD_DISABLED) and never reset once ads are back on',
  );
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
  await db.opsJobRun.deleteMany({ where: { lockKey: REDEMPTION_LOCK_KEY } });
  await db.opsJobLock.deleteMany({ where: { lockKey: REDEMPTION_LOCK_KEY } });
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
