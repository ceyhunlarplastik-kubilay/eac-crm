-- CreateEnum
CREATE TYPE "CustomerReachStatus" AS ENUM ('REACHED', 'NOT_REACHED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "InterestStatus" AS ENUM ('INTERESTED', 'NOT_INTERESTED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SampleStatus" AS ENUM ('WILL_SEND', 'WILL_NOT_SEND', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'IMPORT');

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "sequenceNumber" INTEGER,
    "companyName" TEXT NOT NULL,
    "website" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "city" TEXT,
    "category" TEXT,
    "contactName" TEXT,
    "mobilePhone" TEXT,
    "reached" "CustomerReachStatus" NOT NULL DEFAULT 'UNKNOWN',
    "callCount" INTEGER NOT NULL DEFAULT 0,
    "lastContactedAt" TIMESTAMP(3),
    "contactDetail" TEXT,
    "interestStatus" "InterestStatus" NOT NULL DEFAULT 'UNKNOWN',
    "catalogSent" BOOLEAN,
    "hasSuitableProductGroup" BOOLEAN,
    "currentAccountInfoReceived" BOOLEAN,
    "sampleStatus" "SampleStatus" NOT NULL DEFAULT 'UNKNOWN',
    "shipmentDate" TIMESTAMP(3),
    "sourceRowNumber" INTEGER,
    "sourceImportBatchId" TEXT,
    "createdByEmail" TEXT,
    "createdByName" TEXT,
    "updatedByEmail" TEXT,
    "updatedByName" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "totalRows" INTEGER NOT NULL,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "actorSub" TEXT,
    "actorEmail" TEXT,
    "actorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL,
    "customerId" TEXT,
    "importBatchId" TEXT,
    "action" "AuditAction" NOT NULL,
    "summary" TEXT NOT NULL,
    "changes" JSONB,
    "actorSub" TEXT,
    "actorEmail" TEXT,
    "actorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Customer_dedupeKey_key" ON "Customer"("dedupeKey");

-- CreateIndex
CREATE INDEX "Customer_companyName_idx" ON "Customer"("companyName");

-- CreateIndex
CREATE INDEX "Customer_city_idx" ON "Customer"("city");

-- CreateIndex
CREATE INDEX "Customer_category_idx" ON "Customer"("category");

-- CreateIndex
CREATE INDEX "Customer_updatedAt_idx" ON "Customer"("updatedAt");

-- CreateIndex
CREATE INDEX "Customer_deletedAt_idx" ON "Customer"("deletedAt");

-- CreateIndex
CREATE INDEX "ActivityLog_customerId_idx" ON "ActivityLog"("customerId");

-- CreateIndex
CREATE INDEX "ActivityLog_importBatchId_idx" ON "ActivityLog"("importBatchId");

-- CreateIndex
CREATE INDEX "ActivityLog_actorEmail_idx" ON "ActivityLog"("actorEmail");

-- CreateIndex
CREATE INDEX "ActivityLog_createdAt_idx" ON "ActivityLog"("createdAt");

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_sourceImportBatchId_fkey" FOREIGN KEY ("sourceImportBatchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
