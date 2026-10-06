-- Deploy the relation-only app with writes paused BEFORE this migration.
-- Abort rather than discard any category text that has not been mapped exactly.
BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE "Customer", "Category" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Customer" c LEFT JOIN "Category" k ON k."id" = c."categoryId"
    WHERE (c."categoryId" IS NOT NULL AND k."id" IS NULL)
       OR c."category" COLLATE "C" IS DISTINCT FROM k."name"
  ) THEN
    RAISE EXCEPTION 'Category mappings differ; refusing to remove legacy values';
  END IF;
END $$;

DROP INDEX "Customer_category_idx";
ALTER TABLE "Customer" DROP COLUMN "category";
COMMIT;
