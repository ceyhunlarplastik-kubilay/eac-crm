import "server-only";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { SignatureV4 } from "@smithy/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { Hash } from "@smithy/hash-node";
import { ApiError } from "@/lib/api-error";

export async function callRecordingApi(path: string, method: "GET" | "POST", payload?: unknown) {
  const apiUrl = process.env.CALL_RECORDING_API_URL;
  const region = process.env.CALL_ANALYTICS_REGION;
  if (!apiUrl || !region) throw new ApiError(503, "Görüşme analizi henüz yapılandırılmadı.");
  const url = new URL(path.replace(/^\//, ""), `${apiUrl.replace(/\/$/, "")}/`);
  const body = payload ? JSON.stringify(payload) : undefined;
  const signer = new SignatureV4({ credentials: defaultProvider(), region, service: "execute-api", sha256: Hash.bind(null, "sha256") });
  const request = await signer.sign(new HttpRequest({
    protocol: url.protocol, hostname: url.hostname, path: url.pathname, method,
    headers: { host: url.host, ...(body ? { "content-type": "application/json" } : {}) }, body
  }));
  const response = await fetch(url, {
    method, headers: request.headers, body, cache: "no-store", signal: AbortSignal.timeout(28_000)
  });
  let data: Record<string, unknown>;
  try { data = await response.json(); } catch { throw new ApiError(502, "Görüşme servisi yanıt vermedi."); }
  if (!response.ok) throw new ApiError(response.status, typeof data.error === "string" ? data.error : "Görüşme işlemi tamamlanamadı.");
  return data;
}
