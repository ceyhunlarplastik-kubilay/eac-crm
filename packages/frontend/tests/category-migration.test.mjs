import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  assertContractReady, backfillCategories, customerSnapshot, migrationInventory, verifyCategories
} from "../scripts/category-migration-core.mjs";

async function migrate(db, name) {
  await db.exec(await readFile(new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url), "utf8"));
}

async function database(size) {
  const db = new PGlite();
  await migrate(db, "20260810225140_initial_migration");
  await db.query(`
    INSERT INTO "Customer" ("id", "dedupeKey", "companyName", "category", "deletedAt", "updatedAt", "lastContactedAt", "callCount")
    SELECT lpad(i::text, 6, '0'), 'dedupe_' || i, 'Firma ' || i,
      CASE i % 10 WHEN 0 THEN NULL WHEN 1 THEN '' WHEN 2 THEN ' '
        WHEN 3 THEN 'Kutu Profil' WHEN 4 THEN 'kutu profil' WHEN 5 THEN ' Kutu Profil '
        WHEN 6 THEN 'Kutu  Profil' WHEN 7 THEN '-' WHEN 8 THEN E'Kutu\\u00a0Profil' ELSE 'İnşaat' END,
      CASE WHEN i % 20 = 0 THEN '2026-01-01'::timestamp ELSE NULL END,
      '2026-01-02'::timestamp, CASE WHEN i % 7 = 0 THEN '2026-01-01'::timestamp ELSE NULL END,
      CASE WHEN i % 7 = 0 THEN 1 ELSE 0 END
    FROM generate_series(1, $1::int) i
  `, [size]);
  await migrate(db, "20260817000000_add_sent_sample_status");
  await migrate(db, "20260817010000_add_customer_contact_history");
  await db.query(`INSERT INTO "ActivityLog" ("id", "action", "summary", "changes")
    VALUES ('existing_activity', 'IMPORT', 'Eski faaliyet', '{"category":"Kutu Profil"}')`);
  return db;
}

test("5,000 customers: exact names, deleted rows, nulls, timestamps and history survive; rerun is idempotent", async () => {
  const db = await database(5000);
  try {
    const before = await customerSnapshot(db);
    assert.equal((await migrationInventory(db)).hasCategory, false);
    await migrate(db, "20261005000000_expand_customer_categories");
    const inventory = await migrationInventory(db);
    assert.equal(inventory.customers, 5000);
    assert.equal(inventory.deletedCustomers, 250);
    assert.equal(inventory.distinctCategories, 9);
    assert.equal(inventory.categoriesToCreate, 9);
    // Inventory/dry-run must not write anything.
    assert.equal((await db.query('SELECT count(*)::int AS n FROM "Category"')).rows[0].n, 0);
    const batches = [];
    assert.equal(await backfillCategories(db, { onBatch: (batch) => batches.push(batch) }), 5000);
    assert.equal(batches.length, 10);
    const result = await verifyCategories(db, before);
    assert.equal(result.unmapped, 0);
    assert.equal(result.mismatched, 0);
    assert.equal(result.catalogCategories, 9);
    const catalog = (await db.query('SELECT * FROM "Category" ORDER BY "id"')).rows;
    await backfillCategories(db);
    await verifyCategories(db, before);
    assert.deepEqual((await db.query('SELECT * FROM "Category" ORDER BY "id"')).rows, catalog);
    await assert.rejects(db.query('DELETE FROM "Category" WHERE "name" = $1', ["Kutu Profil"]), /foreign key/);
    await db.query('UPDATE "Customer" SET "categoryId" = NULL WHERE "id" = $1', ["000003"]);
    await assert.rejects(verifyCategories(db), /unmapped=1/);
    await backfillCategories(db);
    await verifyCategories(db, before);
    await db.query('UPDATE "Customer" SET "updatedAt" = now() WHERE "id" = $1', ["000003"]);
    await assert.rejects(verifyCategories(db, before), /değişmiş/);
  } finally {
    await db.close();
  }
});

test("a failed batch rolls back while earlier batches survive; rerunning resumes without data loss", async () => {
  const db = await database(4);
  try {
    await migrate(db, "20261005000000_expand_customer_categories");
    const before = await customerSnapshot(db);
    await db.exec(`CREATE FUNCTION fail_batch() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW."id" = '000004' THEN RAISE EXCEPTION 'simulated batch failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_batch BEFORE UPDATE ON "Customer" FOR EACH ROW EXECUTE FUNCTION fail_batch();`);
    await assert.rejects(backfillCategories(db, { batchSize: 2 }), /simulated batch failure/);
    const customers = (await db.query('SELECT "id", "categoryId" FROM "Customer" ORDER BY "id"')).rows;
    assert.ok(customers[0].categoryId);
    assert.ok(customers[1].categoryId);
    assert.equal(customers[2].categoryId, null);
    assert.equal(customers[3].categoryId, null);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM "Category"')).rows[0].n, 2);
    await db.exec('DROP TRIGGER fail_batch ON "Customer"; DROP FUNCTION fail_batch();');
    await backfillCategories(db, { batchSize: 2 });
    await verifyCategories(db, before);
  } finally {
    await db.close();
  }
});

test("contract preserves all 5,000 customers, exact category names, category IDs and history", async () => {
  const db = await database(5000);
  try {
    await migrate(db, "20261005000000_expand_customer_categories");
    const legacySnapshot = await customerSnapshot(db, { version: 1 });
    await backfillCategories(db);
    await verifyCategories(db, legacySnapshot);
    await assert.rejects(assertContractReady(db, legacySnapshot), /yeni snapshot/);
    const before = await customerSnapshot(db, { purpose: "contract" });
    await assertContractReady(db, before);
    await migrate(db, "20261005010000_contract_customer_categories");
    const result = await verifyCategories(db, before);
    assert.equal(result.hasLegacyCategory, false);
    assert.equal(result.customers, 5000);
    assert.equal(result.catalogCategories, 9);
    assert.equal(result.invalidReferences, 0);
    await assert.rejects(backfillCategories(db), /kaldırılmış/);
    // Changing even a category's ID must be detected by the contract snapshot.
    const row = (await db.query('SELECT * FROM "Category" WHERE "name" = $1', ["Kutu Profil"])).rows[0];
    await db.query('UPDATE "Category" SET "id" = $1 WHERE "id" = $2', ["replacement", row.id]);
    await assert.rejects(verifyCategories(db, before), /değişmiş/);
  } finally {
    await db.close();
  }
});

test("contract refuses unmapped or mismatched names and leaves the legacy column/data intact", async () => {
  const db = await database(4);
  try {
    await migrate(db, "20261005000000_expand_customer_categories");
    await assert.rejects(migrate(db, "20261005010000_contract_customer_categories"), /mappings differ/);
    await db.query("ROLLBACK");
    assert.equal((await migrationInventory(db)).hasLegacyCategory, true);
    await backfillCategories(db);
    await db.query('UPDATE "Category" SET "name" = $1 WHERE "name" = $2', ["Different", "Kutu Profil"]);
    await assert.rejects(migrate(db, "20261005010000_contract_customer_categories"), /mappings differ/);
    await db.query("ROLLBACK");
    assert.equal((await migrationInventory(db)).hasLegacyCategory, true);
    assert.equal((await db.query('SELECT "category" FROM "Customer" WHERE "id" = $1', ["000003"])).rows[0].category, "Kutu Profil");
  } finally {
    await db.close();
  }
});
