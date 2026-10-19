-- 전체 알림 (docs/push-notifications-contract.md §6): one per-user master switch
-- beside the seven per-type switches. Additive only: existing and new rows read
-- as on, so applying this changes no one's delivery, and the per-type values are
-- never rewritten. A missing row still means every type on.
ALTER TABLE "notification_preferences" ADD COLUMN "all_enabled" BOOLEAN NOT NULL DEFAULT true;
