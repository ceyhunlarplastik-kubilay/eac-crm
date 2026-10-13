import { z } from "zod";
import { S3Client, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { TranscribeClient, StartTranscriptionJobCommand, GetTranscriptionJobCommand } from "@aws-sdk/client-transcribe";
import { database } from "./database";
import { claimRecording, completeRecording, failRecording, saveTranscript, type WorkflowJob } from "./repository";
import { parseTranscript } from "./transcript";
import { analyzeCall } from "./analysis";

const s3 = new S3Client({ maxAttempts: 3 });
const transcribe = new TranscribeClient({ maxAttempts: 3 });
const executionSchema = z.string().regex(/^arn:[\w-]+:states:[\w-]+:\d+:execution:/);
const idSchema = z.string().uuid();
type WorkflowInput = { input: Record<string, unknown>; executionArn: string };

export function recordingFromEvent(input: Record<string, unknown>): { id: string; attempt?: number } | null {
  if (input.recordingId) return { id: idSchema.parse(input.recordingId), attempt: z.number().int().positive().parse(input.attempt) };
  const event = input as { source?: string; detail?: { bucket?: { name?: string }; object?: { key?: string } } };
  if (event.source !== "aws.s3" || event.detail?.bucket?.name !== process.env.RECORDINGS_BUCKET_NAME) return null;
  const match = /^audio\/([0-9a-f-]{36})\/recording\.(mp3|wav|flac|m4a|mp4|ogg|webm|amr)$/.exec(event.detail?.object?.key ?? "");
  return match ? { id: idSchema.parse(match[1]) } : null;
}

export async function prepare(event: WorkflowInput) {
  executionSchema.parse(event.executionArn);
  const recording = recordingFromEvent(event.input);
  if (!recording) return null;
  const job = await claimRecording(recording.id, event.executionArn, recording.attempt);
  if (!job) return null; // Duplicate S3 delivery or an obsolete attempt.
  if (job.s3Bucket !== process.env.RECORDINGS_BUCKET_NAME || !job.s3Key.startsWith(`audio/${job.id}/`)) {
    throw new Error("Ses kaydı bu ortama ait değil.");
  }
  const object = await s3.send(new HeadObjectCommand({ Bucket: job.s3Bucket, Key: job.s3Key }));
  if (object.ContentLength !== job.fileSize || object.ContentType !== job.contentType) {
    throw new Error("Yüklenen dosyanın boyutu veya türü kayıtla eşleşmiyor.");
  }
  // State Machines carry only identifiers; never the transcript or customer data.
  return {
    id: job.id, customerId: job.customerId, s3Bucket: job.s3Bucket, s3Key: job.s3Key,
    fileSize: job.fileSize, contentType: job.contentType, mediaFormat: job.mediaFormat,
    speakerMode: job.speakerMode, languageCode: job.languageCode, attempt: job.attempt,
    workflowExecutionArn: job.workflowExecutionArn, transcribeJobName: job.transcribeJobName,
    transcriptS3Key: job.transcriptS3Key, reuseTranscript: job.reuseTranscript
  } satisfies WorkflowJob;
}

export async function startTranscription({ job }: { job: WorkflowJob }) {
  try {
    await transcribe.send(new StartTranscriptionJobCommand({
      TranscriptionJobName: job.transcribeJobName,
      LanguageCode: job.languageCode,
      MediaFormat: job.mediaFormat,
      Media: { MediaFileUri: `s3://${job.s3Bucket}/${job.s3Key}` },
      OutputBucketName: job.s3Bucket,
      OutputKey: job.transcriptS3Key,
      Settings: job.speakerMode === "channels"
        ? { ChannelIdentification: true }
        : { ShowSpeakerLabels: true, MaxSpeakerLabels: 2 },
      JobExecutionSettings: {
        AllowDeferredExecution: true,
        DataAccessRoleArn: process.env.TRANSCRIBE_DATA_ROLE_ARN
      }
    }));
  } catch (error) {
    // Retrying a Lambda invocation must not create or charge for a second job.
    if (!(error instanceof Error) || error.name !== "ConflictException") throw error;
  }
  return { started: true };
}

export async function pollTranscription({ job }: { job: WorkflowJob }) {
  const { TranscriptionJob: result } = await transcribe.send(new GetTranscriptionJobCommand({ TranscriptionJobName: job.transcribeJobName }));
  if (!result?.TranscriptionJobStatus) throw new Error("Transkripsiyon durumu alınamadı.");
  if (result.TranscriptionJobStatus === "FAILED") {
    throw new Error(`Ses yazıya çevrilemedi: ${result.FailureReason?.slice(0, 600) ?? "Transcribe hatası"}`);
  }
  return { status: result.TranscriptionJobStatus };
}

export async function analyze({ job }: { job: WorkflowJob }) {
  const { rows: [recording] } = await database().query(`SELECT r."status", r."representativeName", c."companyName", k."name" AS "category"
    FROM "CallRecording" r JOIN "Customer" c ON c."id" = r."customerId"
    LEFT JOIN "Category" k ON k."id" = c."categoryId"
    WHERE r."id" = $1 AND r."workflowExecutionArn" = $2`, [job.id, job.workflowExecutionArn]);
  if (!recording || !["TRANSCRIBING", "ANALYZING", "COMPLETED"].includes(recording.status)) throw new Error("Bu iş akışı artık etkin değil.");
  if (recording.status === "COMPLETED") return { completed: true };
  const object = await s3.send(new GetObjectCommand({ Bucket: job.s3Bucket, Key: job.transcriptS3Key }));
  if (!object.Body || (object.ContentLength ?? 0) > 20 * 1024 * 1024) throw new Error("Transkript okunamadı veya çok büyük.");
  const transcript = parseTranscript(JSON.parse(await object.Body.transformToString()));
  await saveTranscript(job, transcript);
  const result = await analyzeCall(transcript, { companyName: recording.companyName, category: recording.category }, recording.representativeName);
  await completeRecording(job, result);
  return { completed: true };
}

export async function failed(event: WorkflowInput) {
  const input = event.input as { job?: WorkflowJob; error?: { Error?: string; Cause?: string }; [key: string]: unknown };
  const recording = input.job ? { id: input.job.id } : recordingFromEvent(input);
  if (!recording) return { recorded: false };
  let message = "Görüşme işlenemedi. Kaydı yeniden deneyebilirsiniz.";
  try {
    const cause = JSON.parse(input.error?.Cause ?? "{}");
    if (typeof cause.errorMessage === "string") message = cause.errorMessage;
  } catch { /* Keep the public failure message; no raw execution data is exposed. */ }
  await failRecording(recording.id, event.executionArn, input.error?.Error ?? "ProcessingFailed", message);
  return { recorded: true };
}

// Timeout / aborted executions bypass a State Machine Catch, so EventBridge handles them.
export async function terminalExecution(event: { detail?: { executionArn?: string; status?: string } }) {
  const arn = event.detail?.executionArn;
  if (!arn || !["FAILED", "TIMED_OUT", "ABORTED"].includes(event.detail?.status ?? "")) return;
  await database().query(`UPDATE "CallRecording" SET "status" = 'FAILED', "errorCode" = $2,
    "errorMessage" = 'İş akışı tamamlanamadı. Kaydı yeniden deneyebilirsiniz.', "updatedAt" = now()
    WHERE "workflowExecutionArn" = $1 AND "status" IN ('TRANSCRIBING', 'ANALYZING')`, [arn, event.detail?.status]);
}
