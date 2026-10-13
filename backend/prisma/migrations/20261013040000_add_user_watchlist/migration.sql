CREATE TABLE "watchlist_entries" (
    "user_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "watchlist_entries_pkey" PRIMARY KEY ("user_id", "asset_id"),
    CONSTRAINT "watchlist_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "watchlist_entries_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "watchlist_entries_user_id_created_at_asset_id_idx"
ON "watchlist_entries"("user_id", "created_at" DESC, "asset_id");
