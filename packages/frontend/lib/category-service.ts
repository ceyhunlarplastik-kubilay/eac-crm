import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@/lib/generated/prisma/client";
import { ApiError } from "@/lib/api-error";

export const categoryCreateSchema = z.object({
  name: z.string().min(1).max(1000).refine((name) => name.trim().length > 0, {
    message: "Kategori adı gerekli."
  })
}).strict();

export type CategoryOption = { id: string; name: string };

// Native ON CONFLICT keeps concurrent creates safe inside the customer transaction.
// Do not normalize: existing names and their case/spacing must remain distinct.
export async function getOrCreateCategory(tx: Prisma.TransactionClient, name: string) {
  const rows = await tx.$queryRaw<CategoryOption[]>`
    INSERT INTO "Category" ("id", "name") VALUES (${randomUUID()}, ${name})
    ON CONFLICT ("name") DO UPDATE SET "name" = EXCLUDED."name"
    RETURNING "id", "name"
  `;
  return rows[0];
}

export async function resolveCustomerCategory(
  tx: Prisma.TransactionClient,
  input: { category?: string | null; categoryId?: string | null }
): Promise<{ categoryId?: string | null }> {
  const hasId = input.categoryId !== undefined;
  const hasName = input.category !== undefined;
  if (hasId && hasName) {
    throw new ApiError(400, "category ve categoryId birlikte gönderilemez.");
  }
  if (!hasId && !hasName) return {};
  if (hasId) {
    if (input.categoryId === null) return { categoryId: null };
    const category = await tx.category.findUnique({ where: { id: input.categoryId! } });
    if (!category) throw new ApiError(400, "Kategori bulunamadı.");
    return { categoryId: category.id };
  }
  if (input.category === null) return { categoryId: null };
  const category = await getOrCreateCategory(tx, input.category!);
  return { categoryId: category.id };
}

// CRUD creates reject duplicates; Excel alone uses the idempotent resolver above.
export async function createCategory(tx: Prisma.TransactionClient, name: string) {
  const rows = await tx.$queryRaw<CategoryOption[]>`
    INSERT INTO "Category" ("id", "name") VALUES (${randomUUID()}, ${name})
    ON CONFLICT ("name") DO NOTHING RETURNING "id", "name"
  `;
  if (!rows.length) throw new ApiError(409, "Bu kategori adı zaten kayıtlı.");
  return rows[0];
}

export function categoryMutationError(error: unknown): never {
  const failure = error as { code?: string; meta?: { code?: string } };
  if (failure?.code === "P2002" || failure?.code === "23505" || failure?.meta?.code === "23505") {
    throw new ApiError(409, "Bu kategori adı zaten kayıtlı.");
  }
  if (failure?.code === "P2003" || failure?.code === "23503" || failure?.meta?.code === "23503") {
    throw new ApiError(409, "Firmalara bağlı kategori silinemez. Önce firmaların kategorisini değiştirin.");
  }
  if (failure?.code === "P2025") throw new ApiError(404, "Kategori bulunamadı.");
  throw error;
}

export async function renameCategory(tx: Prisma.TransactionClient, id: string, name: string) {
  try {
    return await tx.category.update({
      where: { id }, data: { name }, include: { _count: { select: { customers: true } } }
    });
  } catch (error) {
    return categoryMutationError(error);
  }
}

export async function deleteCategory(tx: Prisma.TransactionClient, id: string) {
  if (await tx.customer.count({ where: { categoryId: id } })) {
    throw new ApiError(409, "Firmalara bağlı kategori silinemez. Önce firmaların kategorisini değiştirin.");
  }
  try {
    return await tx.category.delete({ where: { id } });
  } catch (error) {
    return categoryMutationError(error);
  }
}
