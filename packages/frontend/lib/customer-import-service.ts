import type { Prisma, PrismaClient } from "@/lib/generated/prisma/client";
import { customerImportSchema, type CustomerImportInput, type CustomerCreateInput } from "@/lib/customer-schema";
import { diffCustomer } from "@/lib/customer-service";
import type { Actor } from "@/lib/session";
import { resolveCustomerCategory } from "@/lib/category-service";
import { requireCustomerWrites } from "@/lib/category-transition";

function toJson(value: unknown) {
  return JSON.parse(JSON.stringify(value));
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return "Satır kaydedilemedi.";
}

function hydrateDate(value: unknown) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function hydrateImportRows(rows: Array<Record<string, unknown>>) {
  return rows.map((row) => customerImportSchema.parse({
    ...row,
    lastContactedAt: hydrateDate(row.lastContactedAt),
    shipmentDate: hydrateDate(row.shipmentDate)
  }));
}

function withMinimumCallCount(row: CustomerImportInput) {
  const { category: _categoryName, ...data } = row;
  return {
    ...data,
    callCount: row.lastContactedAt ? Math.max(row.callCount ?? 0, 1) : row.callCount
  };
}

function dateRangeForDay(date: Date) {
  const start = new Date(date);
  start.setUTCHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  return { start, end };
}

async function recordImportedContact(
  tx: Prisma.TransactionClient,
  customerId: string,
  data: CustomerCreateInput,
  actor: Actor
) {
  if (!data.lastContactedAt) return;

  const { start, end } = dateRangeForDay(data.lastContactedAt);
  const duplicate = await tx.customerContact.findFirst({
    where: {
      customerId,
      contactedAt: {
        gte: start,
        lt: end
      }
    }
  });

  if (duplicate) return;

  await tx.customerContact.create({
    data: {
      customerId,
      contactedAt: data.lastContactedAt,
      note: data.contactDetail,
      actorSub: actor.sub,
      actorEmail: actor.email,
      actorName: actor.name
    }
  });
}

export async function importCustomerRows({
  prisma,
  rows,
  importBatchId,
  actor
}: {
  prisma: PrismaClient;
  rows: CustomerImportInput[];
  importBatchId: string;
  actor: Actor;
}) {
  requireCustomerWrites();
  let createdCount = 0;
  let updatedCount = 0;
  const skipped: Array<{ rowNumber: number; reason: string }> = [];

  for (const row of rows) {
    try {
      const result = await prisma.$transaction(async (tx) => {
        const category = await resolveCustomerCategory(tx, row);
        const existing = await tx.customer.findUnique({
          where: { dedupeKey: row.dedupeKey },
          include: { category: true }
        });

        if (existing) {
          const data = {
            ...withMinimumCallCount(row),
            ...category,
            sourceImportBatchId: importBatchId,
            updatedByEmail: actor.email,
            updatedByName: actor.name,
            deletedAt: null
          };
          const customer = await tx.customer.update({
            where: { id: existing.id },
            data,
            include: { category: true }
          });

          await recordImportedContact(tx, customer.id, data, actor);

          await tx.activityLog.create({
            data: {
              customerId: customer.id,
              importBatchId,
              action: "IMPORT",
              summary: `${customer.companyName} Excel import ile güncellendi.`,
              changes: toJson(diffCustomer(existing, {
                ...data,
                ...("categoryId" in category ? { category: customer.category } : {})
              })),
              actorSub: actor.sub,
              actorEmail: actor.email,
              actorName: actor.name
            }
          });

          return "update" as const;
        }

        const data = { ...withMinimumCallCount(row), ...category };
        const customer = await tx.customer.create({
          data: {
            ...data,
            sourceImportBatchId: importBatchId,
            createdByEmail: actor.email,
            createdByName: actor.name,
            updatedByEmail: actor.email,
            updatedByName: actor.name
          },
          include: { category: true }
        });

        await recordImportedContact(tx, customer.id, data, actor);

        await tx.activityLog.create({
          data: {
            customerId: customer.id,
            importBatchId,
            action: "IMPORT",
            summary: `${customer.companyName} Excel import ile oluşturuldu.`,
            changes: toJson({ ...data, category: customer.category?.name ?? null }),
            actorSub: actor.sub,
            actorEmail: actor.email,
            actorName: actor.name
          }
        });

        return "create" as const;
      });

      if (result === "update") updatedCount += 1;
      if (result === "create") createdCount += 1;
    } catch (error) {
      skipped.push({
        rowNumber: row.sourceRowNumber ?? 0,
        reason: `${row.companyName}: ${errorMessage(error)}`
      });
    }
  }

  await prisma.importBatch.update({
    where: { id: importBatchId },
    data: {
      createdCount: { increment: createdCount },
      updatedCount: { increment: updatedCount },
      skippedCount: { increment: skipped.length }
    }
  });

  return {
    createdCount,
    updatedCount,
    skippedCount: skipped.length,
    skipped
  };
}
