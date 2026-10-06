import { categoryCreateSchema, deleteCategory, renameCategory } from "@/lib/category-service";
import { requireCustomerWrites } from "@/lib/category-transition";
import { prisma } from "@/lib/prisma";
import { ApiError, jsonError, requireAdmin } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    const category = await prisma.category.findUnique({
      where: { id }, include: { _count: { select: { customers: true } } }
    });
    if (!category) throw new ApiError(404, "Kategori bulunamadı.");
    const { _count, ...data } = category;
    return Response.json({ category: { ...data, customerCount: _count.customers } });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { actor } = await requireAdmin();
    requireCustomerWrites();
    const { id } = await context.params;
    const { name } = categoryCreateSchema.parse(await request.json());
    const category = await prisma.$transaction(async (tx) => {
      const [before] = await tx.$queryRaw<Array<{ id: string; name: string }>>`
        SELECT "id", "name" FROM "Category" WHERE "id" = ${id} FOR UPDATE
      `;
      if (!before) throw new ApiError(404, "Kategori bulunamadı.");
      const { _count, ...saved } = await renameCategory(tx, id, name);
      if (before.name !== saved.name) {
        await tx.activityLog.create({
          data: {
            action: "UPDATE", summary: `${before.name} kategorisinin adı ${saved.name} olarak değiştirildi.`,
            changes: { categoryId: id, category: { before: before.name, after: saved.name } },
            actorSub: actor.sub, actorEmail: actor.email, actorName: actor.name
          }
        });
      }
      return { ...saved, customerCount: _count.customers };
    });
    return Response.json({ category });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { actor } = await requireAdmin();
    requireCustomerWrites();
    const { id } = await context.params;
    await prisma.$transaction(async (tx) => {
      const category = await deleteCategory(tx, id);
      await tx.activityLog.create({
        data: {
          action: "DELETE", summary: `${category.name} kategorisi silindi.`,
          changes: { categoryId: id, category: category.name },
          actorSub: actor.sub, actorEmail: actor.email, actorName: actor.name
        }
      });
    });
    return Response.json({ deleted: true });
  } catch (error) {
    return jsonError(error);
  }
}
