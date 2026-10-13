import { randomUUID } from "node:crypto";
import { z } from "zod";
import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { database, transaction } from "./database";
import { uploadSchema } from "./contracts";
import { logActivity } from "./repository";

// The browser supplies the body later. Do not pre-sign an SDK checksum for an empty body.
const s3 = new S3Client({ maxAttempts: 3, requestChecksumCalculation: "WHEN_REQUIRED" });
const workflows = new SFNClient({ maxAttempts: 3 });
const actorSchema = z.object({ sub: z.string().min(1).max(200), email: z.string().email().nullable(), name: z.string().max(200).nullable() }).strict();
type HttpEvent = { body?: string; pathParameters?: { id?: string }; routeKey?: string };
class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
function requireWrites() {
  if (process.env.CUSTOMER_WRITES_PAUSED === "true") throw new HttpError(503, "Yazma işlemleri geçici olarak durduruldu.");
}
function body(event: HttpEvent) {
  if (!event.body || event.body.length > 5000) throw new HttpError(400, "Geçersiz istek.");
  try { return JSON.parse(event.body); } catch { throw new HttpError(400, "Geçersiz JSON."); }
}

async function create(event: HttpEvent) {
  requireWrites();
  const { input, actor } = z.object({ input: uploadSchema, actor: actorSchema }).strict().parse(body(event));
  const bucket = process.env.RECORDINGS_BUCKET_NAME;
  if (!bucket) throw new Error("Ses bucket yapılandırması eksik.");
  const id = randomUUID();
  const key = `audio/${id}/recording.${input.mediaFormat}`;
  const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({
    Bucket: bucket, Key: key, ContentType: input.contentType, ContentLength: input.fileSize,
    IfNoneMatch: "*"
  }), { expiresIn: 300, signableHeaders: new Set(["content-type", "content-length", "if-none-match"]) });
  await transaction(async (client) => {
    const { rows } = await client.query(`SELECT "id" FROM "Customer" WHERE "id" = $1 AND "deletedAt" IS NULL FOR KEY SHARE`, [input.customerId]);
    if (!rows.length) throw new HttpError(404, "Müşteri bulunamadı.");
    const recording = { customerId: input.customerId, uploadedBySub: actor.sub, uploadedByEmail: actor.email, uploadedByName: actor.name };
    await client.query(`INSERT INTO "CallRecording"
      ("id", "customerId", "fileName", "fileSize", "contentType", "mediaFormat", "s3Bucket", "s3Key",
       "representativeName", "recordedAt", "languageCode", "speakerMode", "uploadedBySub", "uploadedByEmail", "uploadedByName")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [id, input.customerId, input.fileName, input.fileSize, input.contentType, input.mediaFormat, bucket, key,
      input.representativeName, input.recordedAt ?? null, input.languageCode, input.speakerMode, actor.sub, actor.email, actor.name]);
    await logActivity(client, recording, "CREATE", "Görüşme kaydı yükleme başlatıldı", { recordingId: id, fileName: input.fileName });
  });
  return { recordingId: id, uploadUrl, expiresIn: 300, headers: { "Content-Type": input.contentType, "If-None-Match": "*" } };
}

async function loadRecording(id: string) {
  const { rows: [recording] } = await database().query(`SELECT r.* FROM "CallRecording" r
    JOIN "Customer" c ON c."id" = r."customerId" WHERE r."id" = $1 AND c."deletedAt" IS NULL`, [id]);
  if (!recording) throw new HttpError(404, "Görüşme kaydı bulunamadı.");
  if (recording.s3Bucket !== process.env.RECORDINGS_BUCKET_NAME) throw new HttpError(409, "Kayıt farklı bir ortama ait.");
  return recording;
}

async function dispatch(event: HttpEvent, retry: boolean) {
  requireWrites();
  const id = z.string().uuid().parse(event.pathParameters?.id);
  const { actor } = z.object({ actor: actorSchema }).strict().parse(body(event));
  const recording = await loadRecording(id);
  try {
    const object = await s3.send(new HeadObjectCommand({ Bucket: recording.s3Bucket, Key: recording.s3Key }));
    if (object.ContentLength !== recording.fileSize || object.ContentType !== recording.contentType) {
      throw new HttpError(400, "Yüklenen ses dosyası boyut veya tür açısından eşleşmiyor.");
    }
  } catch (error) {
    if (error instanceof Error && ["NotFound", "NoSuchKey"].includes(error.name)) throw new HttpError(409, "Ses dosyası yüklenmemiş. Yeni bir kayıt yükleyin.");
    throw error;
  }
  const attempt = await transaction(async (client) => {
    const { rows: [current] } = await client.query(`SELECT * FROM "CallRecording" WHERE "id" = $1 FOR UPDATE`, [id]);
    if (!current) throw new HttpError(404, "Görüşme kaydı bulunamadı.");
    if (!retry && ["TRANSCRIBING", "ANALYZING", "COMPLETED"].includes(current.status)) return null;
    if (retry && current.status !== "FAILED") throw new HttpError(409, "Sadece başarısız kayıt yeniden denenebilir.");
    if (!retry && !["UPLOADING", "QUEUED"].includes(current.status)) throw new HttpError(409, "Bu kayıt başlatılamaz.");
    const nextAttempt = current.attempt + (retry ? 1 : 0);
    await client.query(`UPDATE "CallRecording" SET "status" = 'QUEUED', "attempt" = $2,
      "workflowExecutionArn" = NULL, "errorCode" = NULL, "errorMessage" = NULL, "updatedAt" = now() WHERE "id" = $1`, [id, nextAttempt]);
    if (retry) await logActivity(client, { ...current, uploadedBySub: actor.sub, uploadedByEmail: actor.email, uploadedByName: actor.name },
      "UPDATE", "Görüşme analizi yeniden başlatıldı", { recordingId: id, attempt: nextAttempt });
    return nextAttempt as number;
  });
  if (attempt === null) return { dispatched: true };
  try {
    await workflows.send(new StartExecutionCommand({
      stateMachineArn: process.env.CALL_ANALYTICS_STATE_MACHINE_ARN,
      name: `call-${id}-a${attempt}`, input: JSON.stringify({ recordingId: id, attempt })
    }));
  } catch (error) {
    if (error instanceof Error && error.name === "ExecutionAlreadyExists") return { dispatched: true };
    await database().query(`UPDATE "CallRecording" SET "status" = 'FAILED', "errorCode" = 'DispatchFailed',
      "errorMessage" = 'Analiz başlatılamadı. Yeniden deneyin.', "updatedAt" = now()
      WHERE "id" = $1 AND "attempt" = $2 AND "status" = 'QUEUED' AND "workflowExecutionArn" IS NULL`, [id, attempt]);
    throw error;
  }
  return { dispatched: true };
}

async function playback(event: HttpEvent) {
  const recording = await loadRecording(z.string().uuid().parse(event.pathParameters?.id));
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: recording.s3Bucket, Key: recording.s3Key }), { expiresIn: 300 });
  return { url, expiresIn: 300 };
}

// All routes require IAM at API Gateway. Only the authenticated admin BFF is granted invoke access.
export async function handler(event: HttpEvent) {
  try {
    const result = event.routeKey === "POST /recordings" ? await create(event)
      : event.routeKey === "POST /recordings/{id}/dispatch" ? await dispatch(event, false)
      : event.routeKey === "POST /recordings/{id}/retry" ? await dispatch(event, true)
      : event.routeKey === "GET /recordings/{id}/playback" ? await playback(event)
      : null;
    if (!result) throw new HttpError(404, "Endpoint bulunamadı.");
    return { statusCode: 200, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(result) };
  } catch (error) {
    const status = error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : 500;
    if (status === 500) console.error("Recording API failed", { code: error instanceof Error ? error.name : "Unknown" });
    const message = error instanceof HttpError ? error.message : error instanceof z.ZodError
      ? error.issues.map((issue) => issue.message).join(", ") : "Görüşme işlemi tamamlanamadı.";
    return { statusCode: status, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify({ error: message }) };
  }
}
