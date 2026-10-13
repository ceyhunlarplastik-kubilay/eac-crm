import "./environment";
import { parseArgs } from "node:util";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { S3Client, PutObjectCommand, GetObjectCommand, GetBucketTaggingCommand } from "@aws-sdk/client-s3";
import { databaseTarget, safeFailure } from "./environment";
import { database } from "../src/database";
import { chunkPages, existingDocument, publishDocument } from "../src/knowledge";
import { documentPages } from "../src/documents";
import { embedText, googleSettings } from "../src/google";

const { values } = parseArgs({ options: {
  stage: { type: "string" }, "expected-endpoint": { type: "string" }, file: { type: "string" }, "s3-key": { type: "string" }, version: { type: "string" },
  kind: { type: "string", default: "catalog" }, "source-key": { type: "string" }, title: { type: "string" },
  outputs: { type: "string", default: ".sst/outputs.json" }, apply: { type: "boolean", default: false }
} });
const MAX_BYTES = 50 * 1024 * 1024;
async function main() {
  const target = databaseTarget(values.stage, values["expected-endpoint"]);
  if (Boolean(values.file) === Boolean(values["s3-key"]) || !values.version?.trim() || !["catalog", "company"].includes(values.kind!)) {
    throw new Error("--file PATH veya --s3-key KEY, --version DÖNEM, --kind catalog|company gerekli. Varsayılan dry-run; yazmak için --apply.");
  }
  const outputs = JSON.parse(await readFile(resolve(values.outputs!), "utf8"));
  const bucket = outputs.salesCatalogBucket as string, region = outputs.callAnalyticsRegion as string;
  if (!bucket || !region) throw new Error("SST outputs eksik. Önce seçili stage için sst dev / deploy çalıştırın.");
  const s3 = new S3Client({ region });
  const tags = await s3.send(new GetBucketTaggingCommand({ Bucket: bucket }));
  const tag = (key: string) => tags.TagSet?.find((tag) => tag.Key === key)?.Value;
  if (tag("sst:stage") !== target.stage || tag("sst:app") !== "eac-crm") throw new Error("Bucket beklenen stage'e ait değil.");
  const name = basename(values.file ?? values["s3-key"]!), extension = extname(name).toLowerCase();
  if (![".pdf", ".txt", ".md"].includes(extension)) throw new Error("Yalnız PDF, .txt ve .md desteklenir.");
  let file: Uint8Array;
  if (values.file) {
    if ((await stat(resolve(values.file))).size > MAX_BYTES) throw new Error("En fazla 50 MB doküman yükleyin.");
    file = await readFile(resolve(values.file));
  } else {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: values["s3-key"] }));
    if (!object.Body || (object.ContentLength ?? 0) > MAX_BYTES) throw new Error("S3 dokümanı boş veya 50 MB sınırını aşıyor.");
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const part of object.Body as AsyncIterable<Uint8Array>) {
      bytes += part.length;
      if (bytes > MAX_BYTES) throw new Error("S3 dokümanı 50 MB sınırını aşıyor.");
      chunks.push(Buffer.from(part));
    }
    file = Buffer.concat(chunks);
  }
  if (!file.length || file.length > MAX_BYTES) throw new Error("Doküman boş veya 50 MB sınırını aşıyor.");
  const contentHash = createHash("sha256").update(file).digest("hex");
  const key = `${values.kind === "catalog" ? "catalogs" : "company"}/${contentHash}${extension}`;
  const input = {
    sourceKey: values["source-key"]?.trim() || name, title: values.title?.trim() || name,
    kind: values.kind === "catalog" ? "CATALOG" as const : "COMPANY" as const,
    version: values.version.trim(), sourceUri: `s3://${bucket}/${key}`, contentHash, embeddingModelId: googleSettings().embeddingModel
  };
  if ([input.sourceKey, input.title, input.version].some((field) => field.length > 200)) throw new Error("Ad, kaynak anahtarı ve sürüm en fazla 200 karakter olabilir.");
  const pieces = chunkPages(await documentPages(file, extension));
  console.log(JSON.stringify({ ...target, bucket, file: name, bytes: file.length, version: input.version, sourceKey: input.sourceKey, kind: input.kind, chunks: pieces.length, embeddingModel: input.embeddingModelId, dimensions: 768 }));
  if (!values.apply) { console.log("Dry-run: Google çağrısı ve S3/DB yazması yapılmadı."); return; }
  const existing = await existingDocument(input);
  if (existing?.active) { console.log(`Bu sürüm zaten aktif: ${existing.id}. Yeniden embedding üretilmedi.`); return; }
  const embeddings: number[][] = [];
  // API calls finish before publication. A failed import leaves the previous active version intact.
  for (const piece of pieces) {
    embeddings.push(await embedText(piece.text, "RETRIEVAL_DOCUMENT", input.title));
    if (embeddings.length % 10 === 0 || embeddings.length === pieces.length) console.log(`Embedding: ${embeddings.length}/${pieces.length}`);
  }
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: file,
    ContentType: extension === ".pdf" ? "application/pdf" : "text/plain; charset=utf-8", Metadata: { source_sha256: contentHash } }));
  const id = await publishDocument(input, pieces, embeddings);
  console.log(`Aktif doküman hazır: ${id}. Önceki sürüm geçmişte korundu.`);
}
main().catch((error) => { console.error(safeFailure(error)); process.exitCode = 1; })
  .finally(async () => { if (process.env.DATABASE_URL) await database().end(); });
