import { randomUUID } from "node:crypto";

export async function migrationSchema(db) {
  const { rows: [schema] } = await db.query(`
    SELECT to_regclass('"Category"') IS NOT NULL AS "hasCategory",
      EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'Customer'
          AND column_name = 'categoryId') AS "hasCategoryId",
      EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'Customer'
          AND column_name = 'category') AS "hasLegacyCategory"
  `);
  return schema;
}

export async function migrationInventory(db) {
  const schema = await migrationSchema(db);
  const hasRelation = schema.hasCategory && schema.hasCategoryId;
  const join = hasRelation ? 'LEFT JOIN "Category" k ON k."id" = c."categoryId"' : '';
  const category = schema.hasLegacyCategory ? 'c."category"' : 'k."name"';
  const { rows: [counts] } = await db.query(`
    SELECT count(*)::int AS "customers",
      count(*) FILTER (WHERE c."deletedAt" IS NOT NULL)::int AS "deletedCustomers",
      count(*) FILTER (WHERE ${category} IS NULL)::int AS "withoutCategory",
      count(DISTINCT ${category} COLLATE "C")::int AS "distinctCategories",
      count(*) FILTER (WHERE ${category} = '' OR
        ${category} ~ '(^[[:space:]]|[[:space:]]$|[[:space:]]{2,})')::int AS "unusualNames"
    FROM "Customer" c ${join}
  `);
  if (!hasRelation) return { ...schema, ...counts };
  const { rows: [relations] } = await db.query(`
    SELECT ${schema.hasLegacyCategory
      ? 'count(*) FILTER (WHERE c."category" IS NOT NULL AND c."categoryId" IS NULL)::int'
      : '0'} AS "unmapped",
      count(*) FILTER (WHERE c."categoryId" IS NOT NULL AND k."id" IS NULL)::int AS "invalidReferences",
      ${schema.hasLegacyCategory
        ? 'count(*) FILTER (WHERE c."category" COLLATE "C" IS DISTINCT FROM k."name")::int'
        : '0'} AS "mismatched"
    FROM "Customer" c LEFT JOIN "Category" k ON k."id" = c."categoryId"
  `);
  const categories = schema.hasLegacyCategory ? (await db.query(`
    SELECT count(*) FILTER (WHERE NOT EXISTS (
        SELECT 1 FROM "Category" k WHERE k."name" = c."category" COLLATE "C"
      ))::int AS "categoriesToCreate"
    FROM (SELECT DISTINCT "category" COLLATE "C" AS "category"
      FROM "Customer" WHERE "category" IS NOT NULL) c
  `)).rows[0] : { categoriesToCreate: 0 };
  const { rows: [catalog] } = await db.query('SELECT count(*)::int AS "catalogCategories" FROM "Category"');
  return { ...schema, ...counts, ...relations, ...categories, ...catalog };
}

export async function customerSnapshot(db, { version = 2, purpose = "backfill" } = {}) {
  const schema = await migrationSchema(db);
  if (version === 1 && !schema.hasLegacyCategory) {
    throw new Error("Eski v1 snapshot contract sonrası karşılaştırılamaz. Contract öncesi yeni --contract snapshot kullanın.");
  }
  if (purpose === "contract") await verifyCategories(db);
  const category = schema.hasLegacyCategory ? 'c."category"' : 'k."name"';
  const join = schema.hasCategory && schema.hasCategoryId
    ? 'LEFT JOIN "Category" k ON k."id" = c."categoryId"' : '';
  const { rows: customers } = await db.query(`
    SELECT c."id", ${category} AS "category",
      ${purpose === "contract" ? 'c."categoryId",' : ''}
      md5((to_jsonb(c) - 'categoryId' ${version === 1 ? '' : "- 'category'"})::text) AS "fingerprint"
    FROM "Customer" c ${join} ORDER BY c."id" COLLATE "C"
  `);
  // Include full-table digests so existing contacts and history are verified too.
  const { rows: [history] } = await db.query(`
    SELECT
      (SELECT md5(coalesce(string_agg(to_jsonb(t)::text, E'\\n' ORDER BY "id" COLLATE "C"), ''))
        FROM "CustomerContact" t) AS "contactsFingerprint",
      (SELECT md5(coalesce(string_agg(to_jsonb(t)::text, E'\\n' ORDER BY "id" COLLATE "C"), ''))
        FROM "ActivityLog" t) AS "activitiesFingerprint"
  `);
  return version === 1 ? { version, customers, ...history } : { version, purpose, customers, ...history };
}

export function assertSnapshotUnchanged(before, after) {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error("Müşteri/kategori değerleri, diğer müşteri alanları veya görüşme/faaliyet geçmişi değişmiş. Geçişi durdurun.");
  }
}

export async function verifyCategories(db, snapshot) {
  const inventory = await migrationInventory(db);
  if (!inventory.hasCategory || !inventory.hasCategoryId) {
    throw new Error("Önce eklemeli kategori migration'ı uygulanmalı.");
  }
  if (inventory.unmapped || inventory.invalidReferences || inventory.mismatched) {
    throw new Error(`Kategori doğrulaması başarısız: unmapped=${inventory.unmapped}, invalidReferences=${inventory.invalidReferences}, mismatched=${inventory.mismatched}.`);
  }
  if (snapshot) assertSnapshotUnchanged(snapshot, await customerSnapshot(db, snapshot));
  return inventory;
}

export async function assertContractReady(db, snapshot) {
  if (snapshot?.version !== 2 || snapshot?.purpose !== "contract") {
    throw new Error("Contract için yeni snapshot --contract alınmalı; önceki backfill snapshot'ını kullanmayın.");
  }
  return verifyCategories(db, snapshot);
}

export async function backfillCategories(db, { batchSize = 500, onBatch = () => {} } = {}) {
  if (!(await migrationSchema(db)).hasLegacyCategory) {
    throw new Error("Eski kategori sütunu kaldırılmış; backfill tekrar çalıştırılamaz.");
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new Error("Batch boyutu 1–500 arasında olmalı.");
  }
  let cursor = "";
  let processed = 0;
  while (true) {
    await db.query("BEGIN");
    let rows;
    try {
      ({ rows } = await db.query(`
        SELECT "id", "category" FROM "Customer"
        WHERE "id" COLLATE "C" > $1 COLLATE "C"
        ORDER BY "id" COLLATE "C" LIMIT $2 FOR UPDATE
      `, [cursor, batchSize]));
      if (!rows.length) {
        await db.query("COMMIT");
        break;
      }
      const names = [...new Set(rows.filter((row) => row.category !== null).map((row) => row.category))];
      if (names.length) {
        await db.query(`
          INSERT INTO "Category" ("id", "name")
          SELECT * FROM unnest($1::text[], $2::text[])
          ON CONFLICT ("name") DO NOTHING
        `, [names.map(() => randomUUID()), names]);
      }
      const ids = rows.map((row) => row.id);
      await db.query(`
        UPDATE "Customer" c SET "categoryId" = k."id"
        FROM "Category" k
        WHERE c."id" = ANY($1::text[]) AND k."name" = c."category" COLLATE "C"
          AND c."categoryId" IS DISTINCT FROM k."id"
      `, [ids]);
      await db.query(`
        UPDATE "Customer" SET "categoryId" = NULL
        WHERE "id" = ANY($1::text[]) AND "category" IS NULL AND "categoryId" IS NOT NULL
      `, [ids]);
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
    cursor = rows.at(-1).id;
    processed += rows.length;
    onBatch({ processed, batchSize: rows.length });
  }
  return processed;
}
