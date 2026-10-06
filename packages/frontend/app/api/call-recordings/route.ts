import { z } from "zod";
import { uploadSchema } from "@eac-crm/call-analytics/contracts";
import { requireAdmin, jsonError } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { requireCustomerWrites } from "@/lib/category-transition";
import { callRecordingApi } from "@/lib/call-recording-api";
import { callRecordingError } from "@/lib/call-recording-errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const params = new URL(request.url).searchParams;
    const query = z.object({
      customerId: z.string().min(1).max(100).optional(),
      page: z.coerce.number().int().min(1).max(10000).default(1)
    }).parse({ customerId: params.get("customerId") ?? undefined, page: params.get("page") ?? undefined });
    const where = { customerId: query.customerId, customer: { deletedAt: null } };
    const [recordings, total] = await Promise.all([
      prisma.callRecording.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 20, skip: (query.page - 1) * 20,
        select: { id: true, customerId: true, customer: { select: { id: true, companyName: true } }, fileName: true, fileSize: true,
          representativeName: true, recordedAt: true, status: true, attempt: true, errorMessage: true, createdAt: true,
          completedAt: true, durationSeconds: true, uploadedByName: true, uploadedByEmail: true } }),
      prisma.callRecording.count({ where })
    ]);
    return Response.json({ recordings, total, page: query.page, pageCount: Math.max(1, Math.ceil(total / 20)),
      configured: Boolean(process.env.CALL_RECORDING_API_URL) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(callRecordingError(error)); }
}

export async function POST(request: Request) {
  try {
    const { actor } = await requireAdmin();
    requireCustomerWrites();
    const raw = await request.json();
    uploadSchema.parse(raw);
    const result = await callRecordingApi("/recordings", "POST", { input: raw, actor });
    return Response.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(callRecordingError(error)); }
}
