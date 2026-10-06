import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { database, transaction } from "./database";
import { PROMPT_VERSION, type MediaFormat, type Transcript } from "./contracts";
import type { analyzeCall } from "./analysis";

export type WorkflowJob = {
  id: string;
  customerId: string;
  s3Bucket: string;
  s3Key: string;
  fileSize: number;
  contentType: string;
  mediaFormat: MediaFormat;
  speakerMode: "channels" | "diarization";
  languageCode: "tr-TR" | "en-US" | "de-DE";
  attempt: number;
  workflowExecutionArn: string;
  transcribeJobName: string;
  transcriptS3Key: string;
  reuseTranscript: boolean;
};

export async function claimRecording(id: string, executionArn: string, expectedAttempt?: number, runTransaction = transaction) {
  return runTransaction(async (client) => {
    const { rows: [recording] } = await client.query(`SELECT * FROM "CallRecording" WHERE "id" = $1 FOR UPDATE`, [id]);
    if (!recording || (expectedAttempt !== undefined && recording.attempt !== expectedAttempt)) return null;
    if (recording.workflowExecutionArn === executionArn && ["TRANSCRIBING", "ANALYZING"].includes(recording.status)) {
      return { ...recording, reuseTranscript: recording.status === "ANALYZING" } as WorkflowJob;
    }
    if (!["UPLOADING", "QUEUED"].includes(recording.status)) return null;
    const jobName = `eac-call-${id}-a${recording.attempt}`;
    const reuseTranscript = Boolean(recording.transcriptText && recording.transcriptS3Key);
    const transcriptKey = reuseTranscript ? recording.transcriptS3Key : `transcripts/${id}/attempt-${recording.attempt}.json`;
    const { rows: [job] } = await client.query(`UPDATE "CallRecording" SET
      "status" = $5::"CallRecordingStatus", "workflowExecutionArn" = $2, "transcribeJobName" = $3,
      "transcriptS3Key" = $4, "uploadedAt" = COALESCE("uploadedAt", now()),
      "errorCode" = NULL, "errorMessage" = NULL, "updatedAt" = now()
      WHERE "id" = $1 RETURNING *`, [id, executionArn, jobName, transcriptKey, reuseTranscript ? "ANALYZING" : "TRANSCRIBING"]);
    return { ...job, reuseTranscript } as WorkflowJob;
  });
}

export async function saveTranscript(job: WorkflowJob, transcript: Transcript) {
  const result = await database().query(`UPDATE "CallRecording" SET
    "status" = 'ANALYZING', "transcriptText" = $3, "transcriptSegments" = $4::jsonb,
    "durationSeconds" = $5, "averageConfidence" = $6, "updatedAt" = now()
    WHERE "id" = $1 AND "workflowExecutionArn" = $2 AND "status" IN ('TRANSCRIBING', 'ANALYZING')`,
  [job.id, job.workflowExecutionArn, transcript.text, JSON.stringify(transcript.segments), transcript.durationSeconds, transcript.averageConfidence]);
  if (result.rowCount !== 1) throw new Error("Bu iş akışı artık etkin değil.");
}

export async function completeRecording(job: WorkflowJob, result: Awaited<ReturnType<typeof analyzeCall>>, runTransaction = transaction) {
  return runTransaction(async (client) => {
    const { rows: [recording] } = await client.query(`SELECT * FROM "CallRecording"
      WHERE "id" = $1 AND "workflowExecutionArn" = $2 FOR UPDATE`, [job.id, job.workflowExecutionArn]);
    if (!recording) throw new Error("Bu iş akışı artık etkin değil.");
    if (recording.status === "COMPLETED") return;
    if (recording.status !== "ANALYZING") throw new Error("Analiz kaydedilecek durumda değil.");
    await client.query(`UPDATE "CallRecording" SET "status" = 'COMPLETED',
      "analysis" = $3::jsonb, "catalogSources" = $4::jsonb, "modelId" = $5, "promptVersion" = $6,
      "inputTokens" = $7, "outputTokens" = $8, "completedAt" = now(), "updatedAt" = now(),
      "errorCode" = NULL, "errorMessage" = NULL WHERE "id" = $1 AND "workflowExecutionArn" = $2`,
    [job.id, job.workflowExecutionArn, JSON.stringify(result.analysis), JSON.stringify(result.sources), result.modelId, PROMPT_VERSION, result.inputTokens, result.outputTokens]);
    await logActivity(client, recording, "UPDATE", "Görüşme analizi tamamlandı", { recordingId: job.id, attempt: job.attempt });
  });
}

export async function failRecording(id: string, executionArn: string, code: string, message: string) {
  await database().query(`UPDATE "CallRecording" SET "status" = 'FAILED', "errorCode" = $3,
    "errorMessage" = $4, "updatedAt" = now() WHERE "id" = $1
    AND "workflowExecutionArn" = $2 AND "status" IN ('TRANSCRIBING', 'ANALYZING')`,
  [id, executionArn, code.slice(0, 100), message.slice(0, 1000)]);
}

export async function logActivity(client: PoolClient, recording: {
  customerId: string; uploadedBySub: string; uploadedByEmail: string | null; uploadedByName: string | null;
}, action: "CREATE" | "UPDATE", summary: string, changes: Record<string, unknown>) {
  await client.query(`INSERT INTO "ActivityLog"
    ("id", "customerId", "action", "summary", "changes", "actorSub", "actorEmail", "actorName")
    VALUES ($1, $2, $3::"AuditAction", $4, $5::jsonb, $6, $7, $8)`,
  [randomUUID(), recording.customerId, action, summary, JSON.stringify(changes), recording.uploadedBySub, recording.uploadedByEmail, recording.uploadedByName]);
}
