-- Forward repair after contract, before redeploying the dual-write app.
-- Pause writes first. This restores CURRENT category names. To recover names from
-- before a rename, use the contract snapshot/full backup and category audit logs.
BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE "Customer", "Category" IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "category" TEXT;
UPDATE "Customer" c SET "category" = k."name"
FROM "Category" k WHERE k."id" = c."categoryId";
UPDATE "Customer" SET "category" = NULL WHERE "categoryId" IS NULL;
CREATE INDEX IF NOT EXISTS "Customer_category_idx" ON "Customer"("category");
COMMIT;
