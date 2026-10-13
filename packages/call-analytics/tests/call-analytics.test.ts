import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Pool, type PoolClient } from "pg";
import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { SFNClient } from "@aws-sdk/client-sfn";
import { TranscribeClient } from "@aws-sdk/client-transcribe";
import { vector } from "@electric-sql/pglite/vector";
import { googleApi, googleJsonSchema, embedText, federationCredentials, structuredGenerate } from "../src/google";
import { chunkPages, publishDocument, searchKnowledge, existingDocument } from "../src/knowledge";
import { documentPages } from "../src/documents";
import { z } from "zod";
import type { GenerateContentParameters, EmbedContentParameters } from "@google/genai";
import { AwsClient } from "google-auth-library";
import { uploadSchema, analysisSchema } from "../src/contracts";
import { parseTranscript } from "../src/transcript";
import { validateAnalysis } from "../src/analysis";
import { claimRecording, completeRecording } from "../src/repository";
import { handler } from "../src/upload-api";
import { prepare, startTranscription, pollTranscription, analyze, terminalExecution } from "../src/workflow";

process.env.AWS_REGION = "eu-west-1";
delete process.env.AWS_PROFILE;
delete process.env.AWS_SESSION_TOKEN;
process.env.AWS_ACCESS_KEY_ID = "TESTKEY";
process.env.AWS_SECRET_ACCESS_KEY = "test-secret-for-local-signing-only";
process.env.DATABASE_URL = "postgresql://test:test@localhost/test";
process.env.RECORDINGS_BUCKET_NAME = "test-recordings";
process.env.GOOGLE_CLOUD_PROJECT = "e-aparat-crm";
process.env.GOOGLE_AUTH_MODE = "adc";
process.env.CALL_ANALYTICS_STATE_MACHINE_ARN = "arn:aws:states:eu-west-1:123456789012:stateMachine:test";
process.env.TRANSCRIBE_DATA_ROLE_ARN = "arn:aws:iam::123456789012:role/test";

const actor = { sub: "admin-id", email: "admin@example.com", name: "Temsilci" };
const upload = { customerId: "customer", fileName: "gorusme.mp3", fileSize: 1234, representativeName: "Temsilci" };
const analysis = {
  summary: "Müşteri 30 mm profil tapası arıyor.", customerNeeds: ["30 mm profil tapası"],
  outcome: "FOLLOW_UP", sentiment: "POSITIVE", sentimentReason: "Ürünü soruyor.",
  salesOpportunity: "MEDIUM", opportunityReason: "Adet henüz belirtilmedi.",
  representativeStrengths: ["İhtiyacı dinledi."], improvements: ["Adedi sormalı."], objections: [],
  nextActions: [{ action: "İstenen adedi sor.", owner: "REPRESENTATIVE", timing: null }],
  productRecommendations: [{ productName: "Profil tapası", productCode: "10.42.D.V1.5", reason: "30 mm profil için.", sourceIds: ["K1"], priceNote: "Güncel fiyatı doğrulayın." }],
  evidence: [{ text: "30 mm profil tapası", startSeconds: 0 }], uncertainties: ["İstenen adet bilinmiyor."]
};
const transcriptDocument = { results: { transcripts: [{ transcript: "30 mm profil tapası istiyorum." }], items: [
  { type: "pronunciation", start_time: "0", end_time: "0.3", alternatives: [{ content: "30", confidence: "0.9" }] },
  { type: "pronunciation", start_time: "0.3", end_time: "0.5", alternatives: [{ content: "mm", confidence: "0.8" }] },
  { type: "pronunciation", start_time: "0.5", end_time: "1", alternatives: [{ content: "profil", confidence: "0.9" }] },
  { type: "pronunciation", start_time: "1", end_time: "1.5", alternatives: [{ content: "tapası", confidence: "1" }] },
  { type: "pronunciation", start_time: "1.5", end_time: "2", alternatives: [{ content: "istiyorum", confidence: "0.9" }] },
  { type: "punctuation", alternatives: [{ content: "." }] }
], speaker_labels: { segments: [{ speaker_label: "spk_0", items: ["0", "0.3", "0.5", "1", "1.5"].map((start_time) => ({ start_time })) }] } } };

const db = new PGlite({ extensions: { vector } });
for (const migration of ["20260810225140_initial_migration", "20260817000000_add_sent_sample_status", "20260817010000_add_customer_contact_history", "20261005000000_expand_customer_categories", "20261005010000_contract_customer_categories"]) {
  await db.exec(await readFile(new URL(`../../frontend/prisma/migrations/${migration}/migration.sql`, import.meta.url), "utf8"));
}
await db.query(`INSERT INTO "Customer" ("id", "dedupeKey", "companyName", "updatedAt", "callCount") VALUES ('customer', 'unique-customer', 'Firma', '2026-01-01', 3)`);
await db.query(`INSERT INTO "CustomerContact" ("id", "customerId", "contactedAt", "note") VALUES ('contact', 'customer', '2026-01-01', 'Eski görüşme')`);
const beforeCustomers = await db.query(`SELECT * FROM "Customer"`);
const beforeContacts = await db.query(`SELECT * FROM "CustomerContact"`);
await db.exec(await readFile(new URL("../../frontend/prisma/migrations/20261006000000_add_call_recordings/migration.sql", import.meta.url), "utf8"));
await db.query(`INSERT INTO "CallRecording" ("id","customerId","fileName","fileSize","contentType","mediaFormat","s3Bucket","s3Key","representativeName","status","transcriptText","analysis","uploadedBySub")
  VALUES ('legacy-recording','customer','old.mp3',1234,'audio/mpeg','mp3','test-recordings','audio/legacy/old.mp3','Rep','COMPLETED','Eski transkript','{"summary":"Eski analiz"}','admin-id')`);
const beforeRecordings = await db.query(`SELECT * FROM "CallRecording"`);
await db.exec(await readFile(new URL("../../frontend/prisma/migrations/20261009000000_add_knowledge_vectors/migration.sql", import.meta.url), "utf8"));
const query = async (sql: string, values?: unknown[]) => {
  const result = await db.query(sql, values);
  return { ...result, rowCount: result.affectedRows ?? result.rows.length };
};
const client = { query, release() {} } as unknown as PoolClient;
const transaction = async <T>(operation: (client: PoolClient) => Promise<T>): Promise<T> => {
  await db.exec("BEGIN");
  try { const result = await operation(client); await db.exec("COMMIT"); return result; }
  catch (error) { await db.exec("ROLLBACK"); throw error; }
};
mock.method(Pool.prototype, "connect", async () => client);
mock.method(Pool.prototype, "query", query);
const s3Requests: unknown[] = [];
mock.method(S3Client.prototype, "send", async (command: { input: Record<string, unknown> }) => {
  s3Requests.push(command);
  if (command instanceof HeadObjectCommand) return { ContentLength: 1234, ContentType: "audio/mpeg" };
  if (command instanceof GetObjectCommand) return { ContentLength: 5000, Body: { transformToString: async () => JSON.stringify(transcriptDocument) } };
  throw new Error("Unexpected S3 request");
});
const executions: unknown[] = [];
mock.method(SFNClient.prototype, "send", async (command: { input: unknown }) => { executions.push(command.input); return { executionArn: "test" }; });
let createdId = "";

after(async () => { mock.restoreAll(); await db.close(); });

test("upload validation: exact media format, size limit, traversal and strict schema", () => {
  assert.equal(uploadSchema.parse(upload).contentType, "audio/mpeg");
  assert.equal(uploadSchema.parse({ ...upload, fileName: "GÖRÜŞME.M4A" }).mediaFormat, "m4a");
  for (const invalid of [{ fileName: "../x.mp3" }, { fileName: "x.exe" }, { fileSize: 0 }, { fileSize: 209715201 }, { contentType: "text/html" }, { customerId: "" }]) {
    assert.equal(uploadSchema.safeParse({ ...upload, ...invalid }).success, false);
  }
});

test("additive migration preserves customer data and contacts", async () => {
  assert.deepEqual((await db.query(`SELECT * FROM "Customer"`)).rows, beforeCustomers.rows);
  assert.deepEqual((await db.query(`SELECT * FROM "CustomerContact"`)).rows, beforeContacts.rows);
  assert.deepEqual((await db.query(`SELECT * FROM "CallRecording"`)).rows, beforeRecordings.rows);
});

test("presigned PUT lasts 5 minutes, binds size/type and prevents replacing the audio", async () => {
  const result = await handler({ routeKey: "POST /recordings", body: JSON.stringify({ input: upload, actor }) });
  assert.equal(result.statusCode, 200);
  const data = JSON.parse(result.body);
  createdId = data.recordingId;
  const url = new URL(data.uploadUrl);
  assert.equal(url.searchParams.get("X-Amz-Expires"), "300");
  assert.match(url.pathname, new RegExp(`audio/${createdId}/recording.mp3`));
  assert.match(url.searchParams.get("X-Amz-SignedHeaders")!, /content-length/);
  assert.match(url.searchParams.get("X-Amz-SignedHeaders")!, /content-type/);
  assert.match(url.searchParams.get("X-Amz-SignedHeaders")!, /if-none-match/);
  assert.equal(url.searchParams.get("x-amz-checksum-crc32"), null);
  assert.equal(data.headers["If-None-Match"], "*");
  const { rows: [recording] } = await db.query<{ status: string; uploadedBySub: string }>(`SELECT * FROM "CallRecording" WHERE "id" = $1`, [createdId]);
  assert.equal(recording.status, "UPLOADING");
  assert.equal(recording.uploadedBySub, actor.sub);
  assert.equal(s3Requests.some((command) => command instanceof PutObjectCommand), false);
});

test("upload API refuses paused writes and nonexistent customers", async () => {
  process.env.CUSTOMER_WRITES_PAUSED = "true";
  assert.equal((await handler({ routeKey: "POST /recordings", body: JSON.stringify({ input: upload, actor }) })).statusCode, 503);
  process.env.CUSTOMER_WRITES_PAUSED = "false";
  assert.equal((await handler({ routeKey: "POST /recordings", body: JSON.stringify({ input: { ...upload, customerId: "missing" }, actor }) })).statusCode, 404);
});

test("S3 event claims one workflow, drops duplicate events and ignores transcript events", async () => {
  const input = { source: "aws.s3", detail: { bucket: { name: "test-recordings" }, object: { key: `audio/${createdId}/recording.mp3` } } };
  const executionArn = "arn:aws:states:eu-west-1:123456789012:execution:test:first";
  const job = await prepare({ input, executionArn });
  assert.ok(job);
  assert.equal(job.reuseTranscript, false);
  assert.match(job.transcriptS3Key, /^transcripts\//);
  assert.equal(await prepare({ input, executionArn: `${executionArn}-duplicate` }), null);
  assert.equal((await prepare({ input, executionArn }))?.transcribeJobName, job.transcribeJobName);
  assert.equal(await prepare({ input: { ...input, detail: { ...input.detail, object: { key: "transcripts/x.json" } } }, executionArn }), null);
  assert.equal(await prepare({ input: { ...input, detail: { ...input.detail, bucket: { name: "other-stage" } } }, executionArn }), null);
});

test("transcript parser preserves timestamps, speakers, punctuation and handles separate channels", () => {
  const transcript = parseTranscript(transcriptDocument);
  assert.equal(transcript.durationSeconds, 2);
  assert.equal(transcript.segments[0].speaker, "spk_0");
  assert.equal(transcript.segments[0].text, "30 mm profil tapası istiyorum.");
  assert.equal(transcript.averageConfidence, 0.9);
  const channels = parseTranscript({ results: { transcripts: [{ transcript: "Evet. Merhaba." }], channel_labels: { channels: [
    { channel_label: "ch_1", items: [{ type: "pronunciation", start_time: "1", end_time: "2", alternatives: [{ content: "Evet", confidence: "1" }] }, { type: "punctuation", alternatives: [{ content: "." }] }] },
    { channel_label: "ch_0", items: [{ type: "pronunciation", start_time: "0", end_time: "1", alternatives: [{ content: "Merhaba", confidence: "1" }] }, { type: "punctuation", alternatives: [{ content: "." }] }] }
  ] } } });
  assert.equal(channels.segments[0].speaker, "ch_0");
  assert.equal(channels.segments[1].text, "Evet.");
  assert.throws(() => parseTranscript({ results: { transcripts: [{ transcript: "" }] } }), /konuşma/);
  assert.throws(() => parseTranscript({ results: { transcripts: [{ transcript: "x".repeat(100001) }] } }), /sınırını/);
});

test("analysis validates catalog IDs, exact product codes, quotations and timestamps", () => {
  const sources = [{ id: "K1", text: "Profil tapası 10.42.D.V1.5 30 mm * 30 mm", uri: "s3://catalogs/catalog.pdf", page: 6, score: 0.8, version: "Haziran-Temmuz 2026" }];
  const transcript = parseTranscript(transcriptDocument);
  assert.equal(validateAnalysis(analysis, sources, transcript).outcome, "FOLLOW_UP");
  assert.throws(() => validateAnalysis({ ...analysis, productRecommendations: [{ ...analysis.productRecommendations[0], sourceIds: ["K99"] }] }, sources, transcript), /kaynak/);
  assert.throws(() => validateAnalysis({ ...analysis, productRecommendations: [{ ...analysis.productRecommendations[0], productCode: "MADE-UP" }] }, sources, transcript), /kodu/);
  assert.throws(() => validateAnalysis({ ...analysis, evidence: [{ text: "Sipariş tamamlandı", startSeconds: null }] }, sources, transcript), /alıntısı/);
  assert.throws(() => validateAnalysis({ ...analysis, evidence: [{ text: "30 mm", startSeconds: 500 }] }, sources, transcript), /süresini/);
  assert.equal(analysisSchema.safeParse({ ...analysis, satisfactionPercent: 85 }).success, false);
  assert.equal(googleJsonSchema(analysisSchema).additionalProperties, false);
});

test("Transcribe uses Turkish and job status polling; retries reuse the same job", async () => {
  const job = (await claimRecording(createdId, "arn:aws:states:eu-west-1:123456789012:execution:test:first", undefined, transaction))!;
  let starts = 0;
  const transcribeMock = mock.method(TranscribeClient.prototype, "send", async (command: { input: Record<string, unknown> }) => {
    if (command.input.Media) {
      starts++;
      assert.equal(command.input.LanguageCode, "tr-TR");
      assert.deepEqual(command.input.Settings, { ShowSpeakerLabels: true, MaxSpeakerLabels: 2 });
      assert.equal(command.input.TranscriptionJobName, job.transcribeJobName);
      if (starts > 1) throw Object.assign(new Error("Already exists"), { name: "ConflictException" });
      return {};
    }
    return { TranscriptionJob: { TranscriptionJobStatus: "COMPLETED" } };
  });
  await startTranscription({ job }); await startTranscription({ job });
  assert.deepEqual(await pollTranscription({ job }), { status: "COMPLETED" });
  transcribeMock.mock.restore();
});

test("full analysis pipeline reads S3, retrieves catalog, validates model output and saves once", async () => {
  const job = (await claimRecording(createdId, "arn:aws:states:eu-west-1:123456789012:execution:test:first", undefined, transaction))!;
  const embedding = Array.from({ length: 768 }, (_, index) => index === 0 ? 1 : 0);
  await publishDocument({ sourceKey: "test-catalog", title: "Katalog", kind: "CATALOG", version: "2026",
    sourceUri: "s3://catalogs/catalog.pdf", contentHash: "hash", embeddingModelId: "gemini-embedding-001" },
    [{ ordinal: 0, page: 6, text: "Profil tapası 10.42.D.V1.5 30 mm * 30 mm" }], [embedding]);
  let calls = 0;
  const generateMock = mock.method(googleApi, "generate", async (input: GenerateContentParameters) => {
    assert.equal(input.config?.responseMimeType, "application/json");
    return { candidates: [{ finishReason: "STOP" }], text: JSON.stringify(calls++ === 0 ? { queries: ["30 mm profil tapası"] } : analysis),
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 } };
  });
  const embeddingMock = mock.method(googleApi, "embed", async (input: EmbedContentParameters) => {
    assert.equal(input.config?.taskType, "RETRIEVAL_QUERY"); assert.equal(input.config?.autoTruncate, false);
    return { embeddings: [{ values: embedding, statistics: { truncated: false } }] };
  });
  await analyze({ job }); await analyze({ job });
  const { rows: [result] } = await db.query<{ status: string; analysis: unknown; inputTokens: number }>(`SELECT * FROM "CallRecording" WHERE "id" = $1`, [createdId]);
  assert.equal(result.status, "COMPLETED"); assert.deepEqual(result.analysis, analysis); assert.equal(result.inputTokens, 200);
  assert.equal((await db.query(`SELECT * FROM "ActivityLog" WHERE "summary" = 'Görüşme analizi tamamlandı'`)).rows.length, 1);
  assert.deepEqual((await db.query(`SELECT * FROM "Customer"`)).rows, beforeCustomers.rows);
  assert.deepEqual((await db.query(`SELECT * FROM "CustomerContact"`)).rows, beforeContacts.rows);
  generateMock.mock.restore(); embeddingMock.mock.restore();
});

test("retry reuses a saved transcript; obsolete executions cannot overwrite the result", async () => {
  const id = randomUUID();
  await db.query(`INSERT INTO "CallRecording" ("id", "customerId", "fileName", "fileSize", "contentType", "mediaFormat", "s3Bucket", "s3Key", "representativeName", "status", "transcriptText", "transcriptS3Key", "uploadedBySub")
    VALUES ($1, 'customer', 'retry.mp3', 1234, 'audio/mpeg', 'mp3', 'test-recordings', $2, 'Rep', 'FAILED', '30 mm', $3, 'admin-id')`, [id, `audio/${id}/recording.mp3`, `transcripts/${id}/attempt-1.json`]);
  assert.equal((await handler({ routeKey: "POST /recordings/{id}/retry", pathParameters: { id }, body: JSON.stringify({ actor }) })).statusCode, 200);
  const job = await claimRecording(id, "arn:aws:states:eu-west-1:123456789012:execution:test:retry", 2, transaction);
  assert.ok(job?.reuseTranscript);
  assert.equal(job.transcriptS3Key, `transcripts/${id}/attempt-1.json`);
  assert.equal(await claimRecording(id, "arn:aws:states:eu-west-1:123456789012:execution:test:old", 1, transaction), null);
  await terminalExecution({ detail: { executionArn: "arn:aws:states:eu-west-1:123456789012:execution:test:old", status: "TIMED_OUT" } });
  assert.equal((await db.query<{ status: string }>(`SELECT "status" FROM "CallRecording" WHERE "id" = $1`, [id])).rows[0].status, "ANALYZING");
  await assert.rejects(() => completeRecording({ ...job!, workflowExecutionArn: "obsolete" }, { analysis: analysisSchema.parse(analysis), sources: [], modelId: "model", inputTokens: 1, outputTokens: 1 }, transaction), /etkin değil/);
  await terminalExecution({ detail: { executionArn: job.workflowExecutionArn, status: "TIMED_OUT" } });
  assert.equal((await db.query<{ status: string }>(`SELECT "status" FROM "CallRecording" WHERE "id" = $1`, [id])).rows[0].status, "FAILED");
});

const testVector = (axis = 0) => Array.from({ length: 768 }, (_, index) => index === axis ? 1 : 0);
const knowledgeInput = (sourceKey: string, version = "v1", model = "gemini-embedding-001") => ({
  sourceKey, title: sourceKey, kind: "CATALOG" as const, version, sourceUri: `s3://catalogs/${sourceKey}.pdf`,
  contentHash: `${sourceKey}-${version}`, embeddingModelId: model
});

test("document publication is idempotent, keeps history, and rolls back failed replacements", async () => {
  const input = knowledgeInput("versioned");
  const piece = [{ ordinal: 0, page: 1, text: "Eski ürün OLD-01" }];
  const oldId = await publishDocument(input, piece, [testVector()]);
  assert.equal(await publishDocument(input, piece, [testVector()]), oldId);
  assert.equal((await existingDocument(input))?.active, true);
  const next = knowledgeInput("versioned", "v2");
  await assert.rejects(() => publishDocument(next, piece, [[1, 2]]), /768/);
  assert.equal((await existingDocument(input))?.active, true);
  assert.equal(await existingDocument(next), undefined);
  // Force a DB constraint failure after the previous version was deactivated; the transaction restores it.
  await assert.rejects(() => publishDocument(next, [{ ...piece[0], page: -1 }], [testVector()]));
  assert.equal((await existingDocument(input))?.active, true);
  const newId = await publishDocument(next, [{ ordinal: 0, page: 2, text: "Yeni ürün NEW-02" }], [testVector(1)]);
  assert.notEqual(newId, oldId);
  assert.equal((await existingDocument(input))?.active, false);
  assert.equal((await existingDocument(next))?.active, true);
  assert.equal((await db.query(`SELECT * FROM "KnowledgeChunk" WHERE "documentId"=$1`, [oldId])).rows.length, 1);
  await assert.rejects(() => db.query(`UPDATE "KnowledgeDocument" SET "active"=true WHERE "id"=$1`, [oldId]));
});

test("hybrid search excludes inactive versions and other models, and ranks exact codes", async () => {
  const exact = knowledgeInput("exact-code");
  await publishDocument(exact, [{ ordinal: 0, page: 7, text: "PRECISIONCODE77 özel bağlantı ürünü" }], [testVector(2)]);
  await publishDocument(knowledgeInput("other-model", "v1", "different-embedding-model"),
    [{ ordinal: 0, page: 1, text: "PRECISIONCODE77 yanlış model" }], [testVector()]);
  const results = await searchKnowledge("PRECISIONCODE77", testVector(), "gemini-embedding-001");
  assert.equal(results[0].text, "PRECISIONCODE77 özel bağlantı ürünü");
  assert.equal(results[0].page, 7); assert.equal(results[0].version, "v1"); assert.equal(results[0].title, "exact-code");
  assert.equal(results.some((source) => source.text.includes("OLD-01") || source.text.includes("yanlış model")), false);
  assert.deepEqual(await searchKnowledge("anything", testVector(), "unindexed-model"), []);
});

test("chunking preserves page provenance, overlap, and rejects unreadable or oversized documents", async () => {
  const pages = [{ page: 3, text: "Ürün A 30 mm. ".repeat(180) }, { page: 4, text: "Ürün B" }];
  const chunks = chunkPages(pages);
  assert.ok(chunks.length > 2); assert.equal(chunks.at(-1)?.page, 4);
  assert.equal(chunks.every((piece, index) => piece.ordinal === index && piece.text.length <= 1200), true);
  assert.ok(chunks[0].text.includes(chunks[1].text.slice(0, 100)));
  assert.throws(() => chunkPages([{ page: 1, text: " \n " }]), /OCR/);
  assert.throws(() => chunkPages([{ page: null, text: "x".repeat(2_000_001) }]), /2 milyon/);
  assert.deepEqual(await documentPages(Buffer.from("Numune politikasını satış ekibi doğrular."), ".md"),
    [{ page: null, text: "Numune politikasını satış ekibi doğrular." }]);
  await assert.rejects(() => documentPages(Buffer.from("not a pdf"), ".pdf"), /PDF/);
});

test("PDF extractor reads pages and text using the actual PDF parser", async () => {
  const stream = "BT /F1 12 Tf 40 700 Td (Product CODE-30) Tj 0 -20 Td (Size 30 mm) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = "%PDF-1.4\n", offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const pages = await documentPages(Buffer.from(pdf), ".pdf");
  assert.equal(pages.length, 1); assert.equal(pages[0].page, 1);
  assert.match(pages[0].text, /Product CODE-30\nSize 30 mm/);
});

test("Google embedding uses document/query task types and refuses truncated/invalid vectors", async () => {
  const api = mock.method(googleApi, "embed", async (input: EmbedContentParameters) => {
    assert.equal(typeof input.contents, "string");
    assert.equal(input.config?.outputDimensionality, 768); assert.equal(input.config?.autoTruncate, false);
    assert.equal(input.config?.taskType, "RETRIEVAL_DOCUMENT"); assert.equal(input.config?.title, "Katalog");
    return { embeddings: [{ values: testVector(), statistics: { truncated: false } }] };
  });
  try { assert.equal((await embedText("Ürün", "RETRIEVAL_DOCUMENT", "Katalog")).length, 768); }
  finally { api.mock.restore(); }
  const truncated = mock.method(googleApi, "embed", async () => ({ embeddings: [{ values: testVector(), statistics: { truncated: true } }] }));
  try { await assert.rejects(() => embedText("Ürün", "RETRIEVAL_QUERY"), /kesilmiş/); }
  finally { truncated.mock.restore(); }
  const invalid = mock.method(googleApi, "embed", async () => ({ embeddings: [{ values: Array(768).fill(0) }] }));
  try { await assert.rejects(() => embedText("Ürün", "RETRIEVAL_QUERY"), /geçersiz/); }
  finally { invalid.mock.restore(); }
});

test("Google structured output rejects partial, malformed and extra-field responses", async () => {
  for (const [finishReason, text] of [["MAX_TOKENS", '{"ok":true}'], ["STOP", "invalid json"], ["STOP", '{"ok":true,"extra":1}']]) {
    const api = mock.method(googleApi, "generate", async () => ({ candidates: [{ finishReason }], text }));
    try { await assert.rejects(() => structuredGenerate({ schema: z.object({ ok: z.boolean() }).strict(), system: "test", data: {}, maxTokens: 100 })); }
    finally { api.mock.restore(); }
  }
});

test("WIF accepts only AWS federation, removes metadata sources and rejects credential keys", () => {
  const config = { type: "external_account", subject_token_type: "urn:ietf:params:aws:token-type:aws4_request",
    audience: "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/eac-crm-kubi/providers/aws-provider",
    token_url: "https://sts.googleapis.com/v1/token",
    service_account_impersonation_url: "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/eac-crm-kubi-analytics@e-aparat-crm.iam.gserviceaccount.com:generateAccessToken",
    credential_source: { environment_id: "aws1", url: "http://169.254.169.254/", region_url: "http://169.254.169.254/",
      regional_cred_verification_url: "https://sts.{region}.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15" } };
  const cleaned = federationCredentials(JSON.stringify(config)) as Record<string, unknown>;
  assert.deepEqual(cleaned.credential_source, { environment_id: "aws1", regional_cred_verification_url: config.credential_source.regional_cred_verification_url });
  assert.throws(() => federationCredentials(JSON.stringify({ ...config, type: "service_account" })), /geçersiz/);
  assert.throws(() => federationCredentials(JSON.stringify({ ...config, token_url: "https://attacker.example/token" })), /geçersiz/);
  assert.throws(() => federationCredentials(JSON.stringify({ ...config, subject_token_type: "access_token" })), /geçersiz/);
});

test("company knowledge can inform analysis but cannot justify a product recommendation", async () => {
  await publishDocument({ ...knowledgeInput("company"), kind: "COMPANY" }, [{ ordinal: 0, page: null, text: "Numune politikasını temsilci doğrular." }], [testVector(3)]);
  const sources = await searchKnowledge("Numune", testVector(3), "gemini-embedding-001");
  assert.equal(sources[0].kind, "COMPANY");
  assert.throws(() => validateAnalysis({ ...analysis, productRecommendations: [{ ...analysis.productRecommendations[0], productCode: null }] },
    [{ ...sources[0], id: "K1" }], parseTranscript(transcriptDocument)), /şirket politikası/);
});

test("Google AWS authentication signs Lambda environment credentials without metadata requests", async () => {
  const credentials = federationCredentials(JSON.stringify({ type: "external_account",
    subject_token_type: "urn:ietf:params:aws:token-type:aws4_request",
    audience: "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/eac-crm-kubi/providers/aws-provider",
    token_url: "https://sts.googleapis.com/v1/token",
    service_account_impersonation_url: "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/eac-crm-kubi-analytics@e-aparat-crm.iam.gserviceaccount.com:generateAccessToken",
    credential_source: { environment_id: "aws1", regional_cred_verification_url: "https://sts.{region}.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15" }
  }));
  const client = new AwsClient(credentials as ConstructorParameters<typeof AwsClient>[0]);
  // retrieveSubjectToken only signs the request; token exchange is deliberately not performed.
  const token = JSON.parse(decodeURIComponent(await client.retrieveSubjectToken()));
  assert.equal(new URL(token.url).hostname, "sts.eu-west-1.amazonaws.com");
  assert.equal(token.method, "POST");
  assert.ok(token.headers.some((header: { key: string }) => header.key === "x-goog-cloud-target-resource"));
});
