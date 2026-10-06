import { categoryCreateSchema, createCategory } from "@/lib/category-service";
import { requireCustomerWrites } from "@/lib/category-transition";
import { prisma } from "@/lib/prisma";
import { jsonError, requireAdmin } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAdmin();
    const rows = await prisma.category.findMany({
      orderBy: { name: "asc" }, include: { _count: { select: { customers: true } } }
    });
    const categories = rows.map(({ _count, ...category }) => ({
      ...category, customerCount: _count.customers
    }));
    categories.sort((a, b) => a.name.localeCompare(b.name, "tr-TR"));
    return Response.json({ categories });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    const { actor } = await requireAdmin();
    requireCustomerWrites();
    const { name } = categoryCreateSchema.parse(await request.json());
    const category = await prisma.$transaction(async (tx) => {
      const saved = await createCategory(tx, name);
      await tx.activityLog.create({
        data: {
          action: "CREATE", summary: `${saved.name} kategorisi oluşturuldu.`,
          changes: { categoryId: saved.id, category: saved.name },
          actorSub: actor.sub, actorEmail: actor.email, actorName: actor.name
        }
      });
      return saved;
    });
    return Response.json({ category: { ...category, customerCount: 0 } }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
