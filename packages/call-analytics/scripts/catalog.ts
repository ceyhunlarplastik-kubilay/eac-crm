import { parseArgs } from "node:util";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createHash } from "node:crypto";
import { S3Client, PutObjectCommand, GetBucketTaggingCommand } from "@aws-sdk/client-s3";
import { BedrockAgentClient, StartIngestionJobCommand, GetIngestionJobCommand } from "@aws-sdk/client-bedrock-agent";

// No .env database credentials are loaded: this script uses the selected AWS profile.
const { values } = parseArgs({ options: {
  stage: { type: "string" }, file: { type: "string" }, version: { type: "string" },
  outputs: { type: "string", default: ".sst/outputs.json" }, apply: { type: "boolean", default: false }
} });

async function main() {
  if (!values.stage || !["kubi", "production"].includes(values.stage) || !values.file || !values.version) {
    throw new Error("--stage kubi|production --file PDF --version KATALOG_DONEMI gerekli. Varsayılan dry-run; yüklemek için --apply.");
  }
  const outputs = JSON.parse(await readFile(resolve(values.outputs!), "utf8")) as Record<string, string>;
  const bucket = outputs.salesCatalogBucket;
  const knowledgeBaseId = outputs.salesKnowledgeBaseId;
  const dataSourceId = outputs.salesCatalogDataSourceId;
  const region = outputs.callAnalyticsRegion;
  if (!bucket || !knowledgeBaseId || !dataSourceId || !region) throw new Error("SST outputs eksik. Önce seçili stage kaynaklarını deploy edin.");
  const filePath = resolve(values.file!);
  const fileStat = await stat(filePath);
  if (!filePath.toLowerCase().endsWith(".pdf") || fileStat.size > 50 * 1024 * 1024) throw new Error("En fazla 50 MB PDF yükleyin.");
  const file = await readFile(filePath);
  if (file.subarray(0, 5).toString() !== "%PDF-") throw new Error("Dosya geçerli bir PDF değil.");
  const hash = createHash("sha256").update(file).digest("hex");
  const key = `catalogs/${hash.slice(0, 16)}.pdf`;
  const s3 = new S3Client({ region });
  const tags = await s3.send(new GetBucketTaggingCommand({ Bucket: bucket }));
  const tag = (key: string) => tags.TagSet?.find((tag) => tag.Key === key)?.Value;
  if (tag("sst:stage") !== values.stage || tag("sst:app") !== "eac-crm") throw new Error("Bucket, beklenen eac-crm stage'ine ait değil. İşlem durduruldu.");
  console.log(JSON.stringify({ stage: values.stage, region, bucket, knowledgeBaseId, dataSourceId, file: basename(filePath), bytes: fileStat.size, version: values.version, key }));
  if (!values.apply) { console.log("Dry-run: PDF yüklenmedi, indeksleme başlatılmadı."); return; }
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: file, ContentType: "application/pdf" }));
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `${key}.metadata.json`, ContentType: "application/json",
    Body: JSON.stringify({ metadataAttributes: { catalog_version: values.version, document_title: basename(filePath), source_sha256: hash } }) }));
  const bedrock = new BedrockAgentClient({ region });
  const started = await bedrock.send(new StartIngestionJobCommand({ knowledgeBaseId, dataSourceId, description: `Catalog ${values.version}` }));
  const jobId = started.ingestionJob?.ingestionJobId;
  if (!jobId) throw new Error("İndeksleme işi başlatılamadı.");
  console.log(`Katalog yüklendi. İndeksleme işi: ${jobId}`);
  // Bound the wait and print progress. The AWS job continues if the terminal is closed.
  for (let attempt = 0; attempt < 120; attempt++) {
    const { ingestionJob: job } = await bedrock.send(new GetIngestionJobCommand({ knowledgeBaseId, dataSourceId, ingestionJobId: jobId }));
    console.log(JSON.stringify({ status: job?.status, statistics: job?.statistics }));
    if (job?.status === "COMPLETE") return;
    if (["FAILED", "STOPPED"].includes(job?.status ?? "")) throw new Error(`İndeksleme tamamlanmadı: ${job?.failureReasons?.join(", ") ?? job?.status}`);
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error(`İndeksleme sürüyor. Bedrock konsolunda ${jobId} işini kontrol edin; ses yüklemeden önce COMPLETE olmalı.`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : "Katalog yüklenemedi."); process.exitCode = 1; });
