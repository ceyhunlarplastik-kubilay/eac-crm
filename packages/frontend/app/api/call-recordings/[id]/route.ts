import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError, jsonError, requireAdmin } from "@/lib/session";
import { callRecordingError } from "@/lib/call-recording-errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const id = z.string().uuid().parse((await params).id);
    const recording = await prisma.callRecording.findFirst({ where: { id, customer: { deletedAt: null } },
      select: { id: true, customerId: true, customer: { select: { id: true, companyName: true } }, fileName: true,
        fileSize: true, representativeName: true, recordedAt: true, status: true, attempt: true, errorMessage: true,
        createdAt: true, completedAt: true, durationSeconds: true, uploadedByName: true, uploadedByEmail: true,
        transcriptText: true, transcriptSegments: true, averageConfidence: true, analysis: true, catalogSources: true,
        modelId: true, promptVersion: true } });
    if (!recording) throw new ApiError(404, "Görüşme kaydı bulunamadı.");
    return Response.json({ recording }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(callRecordingError(error)); }
}
