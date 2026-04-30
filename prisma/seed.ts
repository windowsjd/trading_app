import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  PrismaClient,
  UserStatus,
  SeasonStatus,
  ParticipantStatus,
  CurrencyCode,
  WalletTransactionDirection,
  WalletTransactionReferenceType,
  WalletTransactionType,
} from "../src/generated/prisma/client";

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL as string,
});

const prisma = new PrismaClient({
  adapter,
});

const DEV_JOINED_AT = new Date("2026-03-30T00:00:00Z");
const DEV_INITIAL_CAPITAL_KRW = "10000000.00000000";
const ZERO_AMOUNT = "0.00000000";

async function main() {
  const user = await prisma.user.upsert({
    where: { email: "dev1@example.com" },
    update: {
      nickname: "dev_trader_01",
      status: UserStatus.active,
    },
    create: {
      id: "usr_dev_001",
      email: "dev1@example.com",
      passwordHash: "dev_only_hash",
      nickname: "dev_trader_01",
      status: UserStatus.active,
    },
  });

  const season = await prisma.season.upsert({
    where: { id: "sea_2026_s1" },
    update: {
      name: "Season 1",
      status: SeasonStatus.active,
      startAt: new Date("2026-03-30T00:00:00Z"),
      endAt: new Date("2026-04-12T14:59:00Z"),
      initialCapitalKrw: DEV_INITIAL_CAPITAL_KRW,
      tradeFeeRate: "0.001000",
      fxFeeRate: "0.001000",
    },
    create: {
      id: "sea_2026_s1",
      name: "Season 1",
      status: SeasonStatus.active,
      startAt: new Date("2026-03-30T00:00:00Z"),
      endAt: new Date("2026-04-12T14:59:00Z"),
      initialCapitalKrw: DEV_INITIAL_CAPITAL_KRW,
      tradeFeeRate: "0.001000",
      fxFeeRate: "0.001000",
    },
  });

  const seasonParticipant = await prisma.seasonParticipant.upsert({
    where: {
      seasonId_userId: {
        seasonId: season.id,
        userId: user.id,
      },
    },
    update: {
      joinedAt: DEV_JOINED_AT,
      participantStatus: ParticipantStatus.active,
      initialCapitalKrw: DEV_INITIAL_CAPITAL_KRW,
      totalAssetKrw: DEV_INITIAL_CAPITAL_KRW,
      totalReturnRate: ZERO_AMOUNT,
      maxDrawdown: ZERO_AMOUNT,
      currentRank: null,
      finalRank: null,
      finalTier: null,
    },
    create: {
      id: "sp_dev_001",
      seasonId: season.id,
      userId: user.id,
      joinedAt: DEV_JOINED_AT,
      participantStatus: ParticipantStatus.active,
      initialCapitalKrw: DEV_INITIAL_CAPITAL_KRW,
      totalAssetKrw: DEV_INITIAL_CAPITAL_KRW,
      totalReturnRate: ZERO_AMOUNT,
      maxDrawdown: ZERO_AMOUNT,
    },
  });

  const krwWallet = await prisma.cashWallet.upsert({
    where: {
      seasonParticipantId_currencyCode: {
        seasonParticipantId: seasonParticipant.id,
        currencyCode: CurrencyCode.KRW,
      },
    },
    update: {
      balanceAmount: DEV_INITIAL_CAPITAL_KRW,
    },
    create: {
      id: "wal_krw_dev_001",
      seasonParticipantId: seasonParticipant.id,
      currencyCode: CurrencyCode.KRW,
      balanceAmount: DEV_INITIAL_CAPITAL_KRW,
    },
  });

  await prisma.cashWallet.upsert({
    where: {
      seasonParticipantId_currencyCode: {
        seasonParticipantId: seasonParticipant.id,
        currencyCode: CurrencyCode.USD,
      },
    },
    update: {
      balanceAmount: ZERO_AMOUNT,
    },
    create: {
      id: "wal_usd_dev_001",
      seasonParticipantId: seasonParticipant.id,
      currencyCode: CurrencyCode.USD,
      balanceAmount: ZERO_AMOUNT,
    },
  });

  await prisma.walletTransaction.upsert({
    where: {
      id: "wtx_initial_grant_dev_001",
    },
    update: {
      seasonParticipantId: seasonParticipant.id,
      walletId: krwWallet.id,
      currencyCode: CurrencyCode.KRW,
      direction: WalletTransactionDirection.credit,
      txType: WalletTransactionType.initial_grant,
      referenceType: WalletTransactionReferenceType.season_join,
      referenceId: seasonParticipant.id,
      amount: DEV_INITIAL_CAPITAL_KRW,
      balanceAfter: DEV_INITIAL_CAPITAL_KRW,
      occurredAt: seasonParticipant.joinedAt,
    },
    create: {
      id: "wtx_initial_grant_dev_001",
      seasonParticipantId: seasonParticipant.id,
      walletId: krwWallet.id,
      currencyCode: CurrencyCode.KRW,
      direction: WalletTransactionDirection.credit,
      txType: WalletTransactionType.initial_grant,
      referenceType: WalletTransactionReferenceType.season_join,
      referenceId: seasonParticipant.id,
      amount: DEV_INITIAL_CAPITAL_KRW,
      balanceAfter: DEV_INITIAL_CAPITAL_KRW,
      occurredAt: seasonParticipant.joinedAt,
    },
  });

  console.log("seed completed");
  console.log({
    userId: user.id,
    seasonId: season.id,
    seasonParticipantId: seasonParticipant.id,
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
