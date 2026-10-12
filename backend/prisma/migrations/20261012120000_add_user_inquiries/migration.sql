-- User support inquiries. Additive only: no financial table, row or ledger is touched.
CREATE TYPE "InquiryCategory" AS ENUM ('account', 'trading', 'wallet', 'season_ranking', 'bug', 'other');

CREATE TABLE "inquiries" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "client_request_id" TEXT NOT NULL,
    "category" "InquiryCategory" NOT NULL,
    "title" VARCHAR(100) NOT NULL,
    "content" VARCHAR(2000) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inquiries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inquiries_user_id_client_request_id_key" ON "inquiries"("user_id", "client_request_id");
CREATE INDEX "inquiries_user_id_created_at_id_idx" ON "inquiries"("user_id", "created_at", "id");

ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
