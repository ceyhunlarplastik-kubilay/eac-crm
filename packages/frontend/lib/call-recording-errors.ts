import { ApiError } from "@/lib/api-error";

export function callRecordingError(error: unknown) {
  if (error && typeof error === "object") {
    const prismaError = error as { code?: string; meta?: { modelName?: string; table?: string } };
    if (prismaError.code === "P2021" && (
      prismaError.meta?.modelName === "CallRecording" || prismaError.meta?.table?.includes("CallRecording")
    )) {
      return new ApiError(503,
        "Görüşme kayıtları için veritabanı kurulumu tamamlanmadı. Uygulamanın bağlı olduğu Neon branch'inde 20261006000000_add_call_recordings migration'ını uygulayın.");
    }
  }
  return error;
}
