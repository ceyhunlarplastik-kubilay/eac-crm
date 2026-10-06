import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Pool, type PoolClient } from "pg";
import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { SFNClient } from "@aws-sdk/client-sfn";
import { TranscribeClient } from "@aws-sdk/client-transcribe";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { BedrockAgentRuntimeClient } from "@aws-sdk/client-bedrock-agent-runtime";
import { uploadSchema, analysisSchema } from "../src/contracts";
import { parseTranscript } from "../src/transcript";
import { validateAnalysis, bedrockToolSchema } from "../src/analysis";
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
process.env.BEDROCK_MODEL_ID = "eu.amazon.nova-lite-v1:0";
process.env.CATALOG_KNOWLEDGE_BASE_ID = "TESTKB1234";
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

const db = new PGlite();
for (const migration of ["20260810225140_initial_migration", "20260817000000_add_sent_sample_status", "20260817010000_add_customer_contact_history", "20261005000000_expand_customer_categories", "20261005010000_contract_customer_categories"]) {
  await db.exec(await readFile(new URL(`../../frontend/prisma/migrations/${migration}/migration.sql`, import.meta.url), "utf8"));
}
await db.query(`INSERT INTO "Customer" ("id", "dedupeKey", "companyName", "updatedAt", "callCount") VALUES ('customer', 'unique-customer', 'Firma', '2026-01-01', 3)`);
await db.query(`INSERT INTO "CustomerContact" ("id", "customerId", "contactedAt", "note") VALUES ('contact', 'customer', '2026-01-01', 'Eski görüşme')`);
const beforeCustomers = await db.query(`SELECT * FROM "Customer"`);
const beforeContacts = await db.query(`SELECT * FROM "CustomerContact"`);
await db.exec(await readFile(new URL("../../frontend/prisma/migrations/20261006000000_add_call_recordings/migration.sql", import.meta.url), "utf8"));
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
  assert.deepEqual(Object.keys(bedrockToolSchema(analysisSchema)).sort(), ["properties", "required", "type"]);
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
  const bedrockMock = mock.method(BedrockRuntimeClient.prototype, "send", async (command: { input: { toolConfig: { tools: Array<{ toolSpec: { name: string } }> } } }) => {
    const name = command.input.toolConfig.tools[0].toolSpec.name;
    return { stopReason: "tool_use", output: { message: { content: [{ toolUse: { name, input: name === "catalog_queries" ? { queries: ["30 mm profil tapası"] } : analysis } }] } }, usage: { inputTokens: 100, outputTokens: 50 } };
  });
  const retrievalMock = mock.method(BedrockAgentRuntimeClient.prototype, "send", async () => ({ retrievalResults: [
    { content: { text: "Profil tapası 10.42.D.V1.5 30 mm * 30 mm" }, location: { s3Location: { uri: "s3://catalogs/catalog.pdf" } }, score: 0.8, metadata: { catalog_version: "Haziran-Temmuz 2026" } }
  ] }));
  await analyze({ job }); await analyze({ job });
  const { rows: [result] } = await db.query<{ status: string; analysis: unknown; inputTokens: number }>(`SELECT * FROM "CallRecording" WHERE "id" = $1`, [createdId]);
  assert.equal(result.status, "COMPLETED"); assert.deepEqual(result.analysis, analysis); assert.equal(result.inputTokens, 200);
  assert.equal((await db.query(`SELECT * FROM "ActivityLog" WHERE "summary" = 'Görüşme analizi tamamlandı'`)).rows.length, 1);
  assert.deepEqual((await db.query(`SELECT * FROM "Customer"`)).rows, beforeCustomers.rows);
  assert.deepEqual((await db.query(`SELECT * FROM "CustomerContact"`)).rows, beforeContacts.rows);
  bedrockMock.mock.restore(); retrievalMock.mock.restore();
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
