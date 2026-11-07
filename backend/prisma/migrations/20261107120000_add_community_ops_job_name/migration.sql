-- Enum-only step of the community (docs/community-api-contract.md).
--
-- Kept SEPARATE from add_community, following the existing pattern:
-- PostgreSQL refuses to USE a value added by `ALTER TYPE ... ADD VALUE` in the
-- transaction that added it, and Prisma runs each migration file in one
-- transaction. Additive only: one value is added, no value is removed or
-- renamed, no row is read or written. The community's own enums are new
-- types and are created in add_community.

-- Ops lease/run name of the community photo cleanup worker.
ALTER TYPE "OpsJobName" ADD VALUE IF NOT EXISTS 'community_photo_cleanup';
