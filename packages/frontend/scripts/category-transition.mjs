import { config } from "dotenv";
import { Client } from "pg";
import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { assertContractReady, assertSnapshotUnchanged, backfillCategories, customerSnapshot, migrationInventory, verifyCategories } from "./category-migration-core.mjs";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: resolve(packageDir, "../../.env"), quiet: true });
config({ path: resolve(packageDir, ".env"), override: true, quiet: true });

function endpoint(url) {
  try {
    const parsed = new URL(url);
    return { endpoint: parsed.hostname.replace(/-pooler(?=\.)/, ""), database: parsed.pathname };
  } catch {
    throw new Error("Veritabanı bağlantısı eksik veya geçersiz.");
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      stage: { type: "string" },
      "expected-endpoint": { type: "string" },
      output: { type: "string" },
      snapshot: { type: "string" },
      apply: { type: "boolean", default: false },
      contract: { type: "boolean", default: false },
      "writes-paused": { type: "boolean", default: false }
    }
  });
  const [command] = positionals;
  if (positionals.length !== 1 || !["inspect", "snapshot", "backfill", "verify", "deploy"].includes(command)) {
    throw new Error("Komut: inspect | snapshot [--contract] --output PATH | backfill [--apply --writes-paused --snapshot PATH] | verify [--snapshot PATH] | deploy [--writes-paused --snapshot PATH]. Her komutta --stage kubi|production --expected-endpoint HOST gerekli.");
  }
  if (!["kubi", "production"].includes(values.stage) || !values["expected-endpoint"]) {
    throw new Error("--stage kubi|production ve Neon'da doğruladığınız --expected-endpoint HOST gerekli.");
  }
  const runtime = endpoint(process.env.DATABASE_URL);
  const direct = endpoint(process.env.DIRECT_URL?.trim() || process.env.DATABASE_URL);
  const expected = values["expected-endpoint"].replace(/-pooler(?=\.)/, "");
  if (runtime.endpoint !== direct.endpoint || runtime.database !== direct.database || direct.endpoint !== expected) {
    throw new Error("DATABASE_URL, DIRECT_URL ve beklenen endpoint aynı veritabanını göstermiyor. İşlem durduruldu.");
  }
  console.log(JSON.stringify({ stage: values.stage, endpoint: direct.endpoint, database: direct.database, command }));
  if (command === "snapshot" && !values.output) throw new Error("Snapshot için --output PATH gerekli.");
  if (command === "backfill" && values.apply && (!values["writes-paused"] || !values.snapshot)) {
    throw new Error("Backfill uygulamak için yazmaları durdurup --writes-paused ve --snapshot PATH verin.");
  }
  const client = new Client({
    connectionString: process.env.DIRECT_URL?.trim() || process.env.DATABASE_URL,
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
    application_name: `eac-category-${values.stage}-${command}`
  });
  try {
    await client.connect();
    const snapshot = values.snapshot ? JSON.parse(await readFile(resolve(values.snapshot), "utf8")) : undefined;
    if (snapshot && (snapshot.stage !== values.stage || snapshot.endpoint !== direct.endpoint || snapshot.database !== direct.database)) {
      throw new Error("Snapshot farklı stage veya veritabanına ait.");
    }
    if (command === "deploy") {
      const { rows: [tables] } = await client.query(`SELECT
        to_regclass('"Customer"') IS NOT NULL AS "hasCustomers",
        to_regclass('"_prisma_migrations"') IS NOT NULL AS "hasMigrations"`);
      const applied = tables.hasMigrations && (await client.query(`
        SELECT 1 FROM "_prisma_migrations"
        WHERE "migration_name" = '20261005010000_contract_customer_categories'
          AND "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL
      `)).rows.length > 0;
      if (tables.hasCustomers && !applied) {
        if (!values["writes-paused"] || !snapshot) {
          throw new Error("Contract migration'ı bekliyor. Yazmaları durdurup yeni --contract snapshot alın; deploy için --writes-paused --snapshot PATH gerekli.");
        }
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        console.log(JSON.stringify(await assertContractReady(client, snapshot.data)));
        await client.query("COMMIT");
      }
      const child = spawn(resolve(packageDir, "../../node_modules/.bin/prisma"), ["migrate", "deploy"], {
        cwd: packageDir, env: process.env, stdio: "inherit"
      });
      await new Promise((accept, reject) => {
        child.on("error", reject);
        child.on("exit", (code) => code === 0 ? accept() : reject(new Error(`Migration başarısız: ${code}`)));
      });
    } else if (command === "snapshot") {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const data = await customerSnapshot(client, { purpose: values.contract ? "contract" : "backfill" });
      await client.query("COMMIT");
      await writeFile(resolve(values.output), JSON.stringify({
        stage: values.stage, endpoint: direct.endpoint, database: direct.database,
        capturedAt: new Date().toISOString(), data
      }, null, 2), { flag: "wx", mode: 0o600 });
      console.log(`Snapshot kaydedildi: ${data.customers.length} müşteri. Bu dosya tam veritabanı yedeği değildir.`);
    } else if (command === "verify") {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      console.log(JSON.stringify(await verifyCategories(client, snapshot?.data)));
      await client.query("COMMIT");
    } else {
      const inventory = await migrationInventory(client);
      console.log(JSON.stringify(inventory));
      if (command === "backfill" && values.apply) {
        if (!inventory.hasCategory || !inventory.hasCategoryId) throw new Error("Önce eklemeli migration'ı uygulayın.");
        await client.query("SELECT pg_advisory_lock(510052026)");
        const before = await customerSnapshot(client, snapshot.data);
        // Validate before writing, not just after finishing.
        assertSnapshotUnchanged(snapshot.data, before);
        await backfillCategories(client, { onBatch: (batch) => console.log(JSON.stringify(batch)) });
        console.log(JSON.stringify(await verifyCategories(client, snapshot.data)));
        await client.query("SELECT pg_advisory_unlock(510052026)");
      } else if (command === "backfill") {
        console.log("Dry-run tamamlandı. Veri değiştirilmedi.");
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Kategori geçişi başarısız.");
  process.exitCode = 1;
});
