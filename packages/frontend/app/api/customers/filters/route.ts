import { prisma } from "@/lib/prisma";
import { customerCategoryName } from "@/lib/category-transition";
import { jsonError, requireAdmin } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function uniqueSorted(values: Array<string | null>) {
  return [...new Set(values.filter(Boolean) as string[])].sort((a, b) =>
    a.localeCompare(b, "tr-TR")
  );
}

export async function GET() {
  try {
    await requireAdmin();

    const customers = await prisma.customer.findMany({
      where: { deletedAt: null },
      select: {
        city: true,
        category: true,
        categoryId: true,
      }
    });

    return Response.json({
      cities: uniqueSorted(customers.map((customer) => customer.city)),
      categories: uniqueSorted(customers.map(customerCategoryName)),
      categoryOptions: [...new Map(customers
        .filter((customer) => customer.category !== null)
        .map((customer) => [customer.category!.id, customer.category!])).values()]
        .sort((a, b) => a.name.localeCompare(b.name, "tr-TR")),
      reached: [
        { value: "REACHED", label: "Evet" },
        { value: "NOT_REACHED", label: "Hayır" },
        { value: "UNKNOWN", label: "Belirsiz" }
      ],
      interestStatus: [
        { value: "INTERESTED", label: "İlgilendi" },
        { value: "NOT_INTERESTED", label: "İlgilenmedi" },
        { value: "UNKNOWN", label: "Belirsiz" }
      ],
      boolean: [
        { value: "true", label: "Evet" },
        { value: "false", label: "Hayır" },
        { value: "unknown", label: "Belirsiz" }
      ],
      sampleStatus: [
        { value: "WILL_SEND", label: "Gönderilecek" },
        { value: "WILL_NOT_SEND", label: "Gönderilmeyecek" },
        { value: "SENT", label: "Gönderildi" },
        { value: "UNKNOWN", label: "Belirsiz" }
      ],
      pageSizes: [10, 25, 50, 100]
    });
  } catch (error) {
    return jsonError(error);
  }
}
