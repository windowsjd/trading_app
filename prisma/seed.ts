import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  PrismaClient,
  UserStatus,
  SeasonStatus,
  ParticipantStatus,
  CurrencyCode,
} from "../src/generated/prisma/client";

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL as string,
});

const prisma = new PrismaClient({
  adapter,
});

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
      initialCapitalKrw: "10000000.00000000",
      tradeFeeRate: "0.001000",
      fxFeeRate: "0.001000",
    },
    create: {
      id: "sea_2026_s1",
      name: "Season 1",
      status: SeasonStatus.active,
      startAt: new Date("2026-03-30T00:00:00Z"),
      endAt: new Date("2026-04-12T14:59:00Z"),
      initialCapitalKrw: "10000000.00000000",
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
      participantStatus: ParticipantStatus.active,
      initialCapitalKrw: "10000000.00000000",
      totalAssetKrw: "10000000.00000000",
      totalReturnRate: "0.00000000",
      maxDrawdown: "0.00000000",
      currentRank: null,
      finalRank: null,
      finalTier: null,
    },
    create: {
      id: "sp_dev_001",
      seasonId: season.id,
      userId: user.id,
      joinedAt: new Date(),
      participantStatus: ParticipantStatus.active,
      initialCapitalKrw: "10000000.00000000",
      totalAssetKrw: "10000000.00000000",
      totalReturnRate: "0.00000000",
      maxDrawdown: "0.00000000",
    },
  });

  await prisma.cashWallet.upsert({
    where: {
      seasonParticipantId_currencyCode: {
        seasonParticipantId: seasonParticipant.id,
        currencyCode: CurrencyCode.KRW,
      },
    },
    update: {
      balanceAmount: "10000000.00000000",
    },
    create: {
      id: "wal_krw_dev_001",
      seasonParticipantId: seasonParticipant.id,
      currencyCode: CurrencyCode.KRW,
      balanceAmount: "10000000.00000000",
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
      balanceAmount: "0.00000000",
    },
    create: {
      id: "wal_usd_dev_001",
      seasonParticipantId: seasonParticipant.id,
      currencyCode: CurrencyCode.USD,
      balanceAmount: "0.00000000",
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