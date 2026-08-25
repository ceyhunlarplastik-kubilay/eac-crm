CREATE TABLE "CustomerContact" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "contactedAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "actorSub" TEXT,
    "actorEmail" TEXT,
    "actorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerContact_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CustomerContact_customerId_idx" ON "CustomerContact"("customerId");
CREATE INDEX "CustomerContact_contactedAt_idx" ON "CustomerContact"("contactedAt");

ALTER TABLE "CustomerContact"
ADD CONSTRAINT "CustomerContact_customerId_fkey"
FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "CustomerContact" (
    "id",
    "customerId",
    "contactedAt",
    "note",
    "actorEmail",
    "actorName",
    "createdAt"
)
SELECT
    'backfill_' || "id",
    "id",
    "lastContactedAt",
    'Mevcut son görüşme tarihi',
    "updatedByEmail",
    "updatedByName",
    "updatedAt"
FROM "Customer"
WHERE "lastContactedAt" IS NOT NULL;
