-- Additive: existing customers, categories and contact history remain intact.
CREATE TYPE "CallRecordingStatus" AS ENUM ('UPLOADING', 'QUEUED', 'TRANSCRIBING', 'ANALYZING', 'COMPLETED', 'FAILED');

CREATE TABLE "CallRecording" (
  "id" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "fileSize" INTEGER NOT NULL,
  "contentType" TEXT NOT NULL,
  "mediaFormat" TEXT NOT NULL,
  "s3Bucket" TEXT NOT NULL,
  "s3Key" TEXT NOT NULL,
  "representativeName" TEXT NOT NULL,
  "recordedAt" TIMESTAMP(3),
  "languageCode" TEXT NOT NULL DEFAULT 'tr-TR',
  "speakerMode" TEXT NOT NULL DEFAULT 'diarization',
  "status" "CallRecordingStatus" NOT NULL DEFAULT 'UPLOADING',
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "workflowExecutionArn" TEXT,
  "transcribeJobName" TEXT,
  "transcriptS3Key" TEXT,
  "transcriptText" TEXT,
  "transcriptSegments" JSONB,
  "durationSeconds" DOUBLE PRECISION,
  "averageConfidence" DOUBLE PRECISION,
  "analysis" JSONB,
  "catalogSources" JSONB,
  "modelId" TEXT,
  "promptVersion" TEXT,
  "inputTokens" INTEGER,
  "outputTokens" INTEGER,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "uploadedBySub" TEXT NOT NULL,
  "uploadedByEmail" TEXT,
  "uploadedByName" TEXT,
  "uploadedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CallRecording_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CallRecording_fileSize_check" CHECK ("fileSize" > 0 AND "fileSize" <= 209715200),
  CONSTRAINT "CallRecording_attempt_check" CHECK ("attempt" > 0),
  CONSTRAINT "CallRecording_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CallRecording_s3Key_key" ON "CallRecording"("s3Key");
CREATE INDEX "CallRecording_customerId_createdAt_idx" ON "CallRecording"("customerId", "createdAt");
CREATE INDEX "CallRecording_status_updatedAt_idx" ON "CallRecording"("status", "updatedAt");
