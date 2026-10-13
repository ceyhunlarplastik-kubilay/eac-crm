import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(".env"), quiet: true });
config({ path: resolve("packages/frontend/.env"), override: true, quiet: true });

export function databaseTarget(stage: string | undefined, expected: string | undefined) {
  if (!stage || !["kubi", "production"].includes(stage) || !expected) throw new Error("--stage kubi|production ve --expected-endpoint NEON_HOST gerekli.");
  const canonical = (host: string) => host.toLowerCase().replace(/-pooler(?=\.)/, "");
  const runtime = new URL(process.env.DATABASE_URL ?? "");
  const direct = new URL(process.env.DIRECT_URL || process.env.DATABASE_URL || "");
  if (![runtime, direct].every((url) => ["postgres:", "postgresql:"].includes(url.protocol) && canonical(url.hostname) === canonical(expected)) || runtime.pathname !== direct.pathname) {
    throw new Error("DATABASE_URL / DIRECT_URL beklenen Neon branch'ine ait değil. İşlem durduruldu.");
  }
  return { stage, endpoint: canonical(runtime.hostname), database: runtime.pathname };
}

// Authentication SDK errors may contain HTTP headers; never print the full error object.
export function safeFailure(error: unknown) {
  if (error && typeof error === "object" && ("status" in error || "response" in error)) {
    const value = error as { status?: number; response?: { status?: number } };
    return `Google / AWS isteği başarısız (HTTP ${value.status ?? value.response?.status ?? "bilinmiyor"}). Proje, API, IAM ve kota ayarlarını kontrol edin.`;
  }
  return error instanceof Error ? error.message : "İşlem başarısız.";
}
