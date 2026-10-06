import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Prisma } from "@/lib/generated/prisma/client";
import { categoryCreateSchema, createCategory, deleteCategory, renameCategory, categoryMutationError, getOrCreateCategory, resolveCustomerCategory } from "@/lib/category-service";
import { customerCreateSchema, customerImportSchema, customerUpdateSchema } from "@/lib/customer-schema";
import { buildCustomerWhere, hasCustomerFilters } from "@/lib/customer-filters";
import { customerCategoryName, requireCustomerWrites } from "@/lib/category-transition";
import { parseCustomerWorkbook } from "@/lib/excel-import";
import { hydrateImportRows } from "@/lib/customer-import-service";
import { diffCustomer, serializeCustomer } from "@/lib/customer-service";
import ExcelJS from "exceljs";

const savedSource = process.env.CATEGORY_READ_SOURCE;
const savedPaused = process.env.CUSTOMER_WRITES_PAUSED;
beforeEach(() => {
  process.env.CATEGORY_READ_SOURCE = "legacy";
  process.env.CUSTOMER_WRITES_PAUSED = "false";
});
afterEach(() => {
  if (savedSource === undefined) delete process.env.CATEGORY_READ_SOURCE;
  else process.env.CATEGORY_READ_SOURCE = savedSource;
  if (savedPaused === undefined) delete process.env.CUSTOMER_WRITES_PAUSED;
  else process.env.CUSTOMER_WRITES_PAUSED = savedPaused;
});

test("category resolver preserves names, reuses concurrent creates, validates IDs and distinguishes omitted from null", async () => {
  const db = new PGlite();
  try {
    await db.exec(await readFile(new URL("../prisma/migrations/20260810225140_initial_migration/migration.sql", import.meta.url), "utf8"));
    await db.exec(await readFile(new URL("../prisma/migrations/20261005000000_expand_customer_categories/migration.sql", import.meta.url), "utf8"));
    const tx = {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.reduce((result, part, index) => result + (index ? `$${index}` : "") + part, "");
        return (await db.query(sql, values)).rows;
      },
      category: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          (await db.query('SELECT * FROM "Category" WHERE "id" = $1', [where.id])).rows[0] ?? null
      }
    } as unknown as Prisma.TransactionClient;
    const [first, second] = await Promise.all([
      getOrCreateCategory(tx, "Kutu Profil"), getOrCreateCategory(tx, "Kutu Profil")
    ]);
    assert.equal(first.id, second.id);
    const spaced = await getOrCreateCategory(tx, " Kutu Profil ");
    const lower = await getOrCreateCategory(tx, "kutu profil");
    assert.notEqual(first.id, spaced.id);
    assert.notEqual(first.id, lower.id);
    assert.deepEqual(await resolveCustomerCategory(tx, {}), {});
    assert.deepEqual(await resolveCustomerCategory(tx, { categoryId: first.id }), { categoryId: first.id });
    assert.deepEqual(await resolveCustomerCategory(tx, { categoryId: null }), { categoryId: null });
    assert.deepEqual(await resolveCustomerCategory(tx, { category: null }), { categoryId: null });
    assert.deepEqual(await resolveCustomerCategory(tx, { category: " Kutu Profil " }), { categoryId: spaced.id });
    await assert.rejects(resolveCustomerCategory(tx, { categoryId: "missing" }), /Kategori bulunamadı/);
    await assert.rejects(resolveCustomerCategory(tx, { categoryId: first.id, category: first.name }), /birlikte/);
    await db.query("BEGIN");
    await getOrCreateCategory(tx, "Rolled back");
    await db.query("ROLLBACK");
    assert.equal((await db.query('SELECT * FROM "Category" WHERE "name" = $1', ["Rolled back"])).rows.length, 0);
  } finally {
    await db.close();
  }
});

test("customer forms accept only IDs; Excel input alone preserves category names", () => {
  assert.equal(customerImportSchema.parse({ companyName: "Firma", category: " Kutu  Profil " }).category, " Kutu  Profil ");
  assert.equal(customerCreateSchema.parse({ companyName: "Firma", categoryId: null }).categoryId, null);
  assert.equal(customerUpdateSchema.safeParse({ category: "A", categoryId: "id" }).success, false);
  assert.equal(customerCreateSchema.safeParse({ companyName: "Firma", category: null, categoryId: null }).success, false);
  assert.equal(customerCreateSchema.safeParse({ companyName: "Firma", category: "Kutu Profil" }).success, false);
  assert.equal(customerUpdateSchema.safeParse({ category: "Kutu Profil" }).success, false);
  assert.deepEqual(customerUpdateSchema.parse({ companyName: "Yeni" }), { companyName: "Yeni" });
  assert.equal(categoryCreateSchema.safeParse({ name: "   " }).success, false);
  assert.equal(categoryCreateSchema.parse({ name: " Yeni " }).name, " Yeni ");
});

test("relation reads, name and ID filters, search and write pause remain valid after contract", () => {
  const customer = { category: { id: "id", name: "New" } };
  process.env.CATEGORY_READ_SOURCE = "legacy"; // Stale environment no longer affects reads.
  assert.equal(customerCategoryName(customer), "New");
  process.env.CATEGORY_READ_SOURCE = "relation";
  assert.equal(customerCategoryName(customer), "New");
  assert.equal(customerCategoryName({ category: null }), null);
  assert.equal(hasCustomerFilters(new URLSearchParams({ categoryId: "id" })), true);
  assert.equal(buildCustomerWhere(new URLSearchParams({ categoryId: "id" })).categoryId, "id");
  assert.deepEqual(buildCustomerWhere(new URLSearchParams({ category: " Kutu Profil " })).category,
    { is: { name: " Kutu Profil " } });
  const where = buildCustomerWhere(new URLSearchParams({ q: "kutu" }));
  assert.ok(JSON.stringify(where.OR).includes('"category":{"is":{"name"'));
  requireCustomerWrites();
  process.env.CUSTOMER_WRITES_PAUSED = "true";
  assert.throws(requireCustomerWrites, /Veri geçişi/);
});

test("category CRUD rejects duplicate names and deletion when even a soft-deleted customer refers to it", async () => {
  const db = new PGlite();
  try {
    for (const migration of ["20260810225140_initial_migration", "20261005000000_expand_customer_categories", "20261005010000_contract_customer_categories"]) {
      await db.exec(await readFile(new URL(`../prisma/migrations/${migration}/migration.sql`, import.meta.url), "utf8"));
    }
    const tx = {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
        (await db.query(strings.reduce((sql, part, index) => sql + (index ? `$${index}` : "") + part, ""), values)).rows,
      customer: { count: async ({ where }: { where: { categoryId: string } }) =>
        (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM "Customer" WHERE "categoryId" = $1', [where.categoryId])).rows[0].n },
      category: {
        update: async ({ where, data }: { where: { id: string }; data: { name: string } }) => {
          const row = (await db.query('UPDATE "Category" SET "name" = $1 WHERE "id" = $2 RETURNING *', [data.name, where.id])).rows[0];
          if (!row) throw { code: "P2025" };
          const count = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM "Customer" WHERE "categoryId" = $1', [where.id])).rows[0].n;
          return { ...row, _count: { customers: count } };
        },
        delete: async ({ where }: { where: { id: string } }) => {
          const row = (await db.query('DELETE FROM "Category" WHERE "id" = $1 RETURNING *', [where.id])).rows[0];
          if (!row) throw { code: "P2025" };
          return row;
        }
      }
    } as unknown as Prisma.TransactionClient;
    const category = await createCategory(tx, "Original");
    await assert.rejects(createCategory(tx, "Original"), /zaten kayıtlı/);
    const alternate = await createCategory(tx, "Alternate");
    await db.query(`INSERT INTO "Customer" ("id", "dedupeKey", "companyName", "categoryId", "deletedAt", "updatedAt")
      VALUES ('archived', 'archived', 'Archived company', $1, '2026-01-01', '2026-01-02')`, [category.id]);
    const renamed = await renameCategory(tx, category.id, "Renamed");
    assert.equal(renamed.id, category.id);
    assert.equal(renamed.name, "Renamed");
    assert.equal(renamed._count.customers, 1);
    assert.equal((await db.query<{ name: string }>('SELECT k."name" FROM "Customer" c JOIN "Category" k ON k."id" = c."categoryId"')).rows[0].name, "Renamed");
    await assert.rejects(deleteCategory(tx, category.id), /bağlı kategori silinemez/);
    await assert.rejects(renameCategory(tx, category.id, "Alternate"), /zaten kayıtlı/);
    await deleteCategory(tx, alternate.id);
    await assert.rejects(deleteCategory(tx, alternate.id), /Kategori bulunamadı/);
    await assert.rejects(renameCategory(tx, "missing", "Anything"), /Kategori bulunamadı/);
    assert.throws(() => categoryMutationError({ code: "P2003" }), /bağlı kategori silinemez/);
    assert.throws(() => categoryMutationError({ code: "P2002" }), /zaten kayıtlı/);
  } finally {
    await db.close();
  }
});

test("Excel keeps category names and accepts companies without any meeting date", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Firmalar");
  sheet.addRow(["Firma", "Kategori", "Görüşme Tarihi"]);
  sheet.addRow(["Firma A", " Kutu  Profil ", null]);
  sheet.addRow(["Firma B", "kutu profil", null]);
  sheet.addRow(["Firma C", null, null]);
  const file = new File([new Uint8Array(await workbook.xlsx.writeBuffer())], "firmalar.xlsx");
  const parsed = await parseCustomerWorkbook(file);
  assert.equal(parsed.skipped.length, 0);
  assert.equal(parsed.rows[0].category, " Kutu  Profil ");
  assert.equal(parsed.rows[1].category, "kutu profil");
  assert.equal(parsed.rows[2].category, null);
  assert.ok(parsed.rows.every((row) => row.lastContactedAt === null && row.callCount === 0));
  const wireRows = JSON.parse(JSON.stringify(parsed.rows));
  wireRows[0].dedupeKey = "untrusted-client-key";
  const hydrated = hydrateImportRows(wireRows);
  assert.equal(hydrated[0].dedupeKey, parsed.rows[0].dedupeKey);
  assert.equal(hydrated[0].category, " Kutu  Profil ");
  assert.ok(hydrated.every((row) => row.lastContactedAt === null));
});

test("customer serialization and audit keep readable names without leaking the relation object", () => {
  const before = { id: "customer", categoryId: "old", category: { id: "old", name: "Original" } };
  const after = { ...before, categoryId: "new", category: { id: "new", name: "New" } };
  assert.deepEqual(diffCustomer(before, { category: after.category }), {
    category: { before: "Original", after: "New" }
  });
  assert.deepEqual(diffCustomer(before, { category: { ...before.category } }), {});
  assert.deepEqual(diffCustomer(before, { category: null }), {
    category: { before: "Original", after: null }
  });
  assert.equal(serializeCustomer(after).category, "New");
  assert.equal(serializeCustomer(after).categoryId, "new");
});
