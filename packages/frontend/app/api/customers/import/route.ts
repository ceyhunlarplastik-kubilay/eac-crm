import { parseCustomerWorkbook } from "@/lib/excel-import";
import { requireCustomerWrites } from "@/lib/category-transition";
import { prisma } from "@/lib/prisma";
import { jsonError, requireAdmin } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const { actor } = await requireAdmin();
    requireCustomerWrites();
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return Response.json({ error: "Excel dosyası gerekli." }, { status: 400 });
    }

    const parsed = await parseCustomerWorkbook(file);
    const batch = await prisma.importBatch.create({
      data: {
        fileName: file.name,
        totalRows: parsed.totalRows,
        skippedCount: parsed.skipped.length,
        actorSub: actor.sub,
        actorEmail: actor.email,
        actorName: actor.name
      }
    });

    return Response.json({
      importBatchId: batch.id,
      totalRows: parsed.totalRows,
      rows: parsed.rows,
      skippedCount: parsed.skipped.length,
      skipped: parsed.skipped.slice(0, 20)
    });
  } catch (error) {
    return jsonError(error);
  }
}
