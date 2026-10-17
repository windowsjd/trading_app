-- Operator answers to support inquiries (docs/inquiries-contract.md). Additive
-- only: `inquiries` and its rows are unchanged, and an inquiry without an answer
-- row reads as 답변 대기. No financial table is touched.
CREATE TABLE "inquiry_answers" (
    "id" TEXT NOT NULL,
    "inquiry_id" TEXT NOT NULL,
    "answered_by_user_id" TEXT NOT NULL,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "content" VARCHAR(2000) NOT NULL,
    "answered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inquiry_answers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "inquiry_answers_content_not_blank" CHECK (btrim("content") <> '')
);

-- One official answer per inquiry: concurrent answers cannot both commit.
CREATE UNIQUE INDEX "inquiry_answers_inquiry_id_key" ON "inquiry_answers"("inquiry_id");

ALTER TABLE "inquiry_answers" ADD CONSTRAINT "inquiry_answers_inquiry_id_fkey" FOREIGN KEY ("inquiry_id") REFERENCES "inquiries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "inquiry_answers" ADD CONSTRAINT "inquiry_answers_answered_by_user_id_fkey" FOREIGN KEY ("answered_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
