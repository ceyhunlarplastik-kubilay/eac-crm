type Gcloud = (args: string[]) => Promise<string>;
type Resource = { name: string; state?: string };

export function federationResourceIds(stage: string) {
  if (stage !== "kubi" && stage !== "production") throw new Error("WIF stage kubi veya production olmalı.");
  const pool = `eac-crm-${stage}`, provider = "aws-provider";
  for (const id of [pool, provider]) {
    if (!/^[a-z0-9-]{4,32}$/.test(id) || id.startsWith("gcp-")) {
      throw new Error("Google WIF pool/provider kimliği 4–32 karakter olmalı ve gcp- ile başlayamaz.");
    }
  }
  return { pool, provider, serviceAccountId: `eac-crm-${stage}-analytics` };
}

// IAM get/describe can return PERMISSION_DENIED for a nonexistent child resource.
// Check the parent's list instead; an actual permission failure must still stop setup.
export async function ensureListedResource(
  gcloud: Gcloud, list: string[], id: string, create: string[]
) {
  const find = async () => {
    const resources: unknown = JSON.parse(await gcloud([...list, "--format=json"]));
    if (!Array.isArray(resources) || resources.some((resource) => !resource || typeof resource.name !== "string")) {
      throw new Error("Google kaynak listesi geçersiz; kurulum durduruldu.");
    }
    const resource = (resources as Resource[]).find((resource) => resource.name.split("/").at(-1) === id);
    if (resource?.state === "DELETED") {
      throw new Error(`${id} silinmiş durumda; yeniden oluşturmadan önce Google Cloud'da undelete ile geri alın.`);
    }
    return resource;
  };
  if (await find()) return;
  try { await gcloud(create); }
  catch (error) {
    // Another setup may have created it between the list and create calls.
    if (!(error instanceof Error) || !/\bALREADY_EXISTS\b/.test(error.message) || !await find()) throw error;
  }
}
