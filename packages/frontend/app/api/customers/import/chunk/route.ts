import { z } from "zod";
import { requireCustomerWrites } from "@/lib/category-transition";
import { hydrateImportRows, importCustomerRows } from "@/lib/customer-import-service";
import { prisma } from "@/lib/prisma";
import { jsonError, requireAdmin } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 300;

const importChunkSchema = z.object({
  importBatchId: z.string().min(1),
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(150)
});

export async function POST(request: Request) {
  try {
    const { actor } = await requireAdmin();
    requireCustomerWrites();
    const parsed = importChunkSchema.parse(await request.json());
    const rows = hydrateImportRows(parsed.rows);

    const result = await importCustomerRows({
      prisma,
      rows,
      importBatchId: parsed.importBatchId,
      actor
    });

    return Response.json(result);
  } catch (error) {
    return jsonError(error);
  }
}
