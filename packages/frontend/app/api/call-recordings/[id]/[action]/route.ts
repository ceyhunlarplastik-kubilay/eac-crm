import { z } from "zod";
import { callRecordingApi } from "@/lib/call-recording-api";
import { requireAdmin, jsonError, ApiError } from "@/lib/session";
import { requireCustomerWrites } from "@/lib/category-transition";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string; action: string }> };

export async function POST(_request: Request, { params }: Context) {
  try {
    const { actor } = await requireAdmin();
    requireCustomerWrites();
    const { id, action } = await params;
    z.string().uuid().parse(id);
    if (!["dispatch", "retry"].includes(action)) throw new ApiError(404, "İşlem bulunamadı.");
    return Response.json(await callRecordingApi(`/recordings/${id}/${action}`, "POST", { actor }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}

export async function GET(_request: Request, { params }: Context) {
  try {
    await requireAdmin();
    const { id, action } = await params;
    z.string().uuid().parse(id);
    if (action !== "playback") throw new ApiError(404, "İşlem bulunamadı.");
    return Response.json(await callRecordingApi(`/recordings/${id}/playback`, "GET"), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}
