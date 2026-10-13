import "./environment";
import { parseArgs } from "node:util";
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { S3Client, GetBucketTaggingCommand } from "@aws-sdk/client-s3";
import { federationCredentials, googleSettings } from "../src/google";
import { safeFailure } from "./environment";
import { ensureListedResource, federationResourceIds } from "./google-resources";

const run = promisify(execFile);
const { values } = parseArgs({ options: { stage: { type: "string" }, outputs: { type: "string", default: ".sst/outputs.json" }, apply: { type: "boolean", default: false } } });
async function gcloud(args: string[]) {
  try { return (await run("gcloud", [...args, "--quiet"], { maxBuffer: 2_000_000 })).stdout; }
  catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? "");
    throw new Error(`gcloud ${args.slice(0, 3).join(" ")} başarısız: ${stderr.slice(-2000)}`);
  }
}
async function main() {
  const stage = values.stage;
  if (!stage || !["kubi", "production"].includes(stage)) throw new Error("--stage kubi|production gerekli. Varsayılan dry-run; kurulum için --apply.");
  const { pool, provider, serviceAccountId } = federationResourceIds(stage);
  const { project } = googleSettings();
  const outputs = JSON.parse(await readFile(resolve(values.outputs!), "utf8"));
  const roleArn = outputs.callAnalysisRoleArn as string;
  const match = /^arn:aws:iam::(\d{12}):role\/(.+)$/.exec(roleArn ?? "");
  if (!match || outputs.googleCloudProject !== project || !outputs.salesCatalogBucket || !outputs.callAnalyticsRegion) {
    throw new Error("Güncel stage çıktıları gerekli. Önce sst dev --stage ile kaynakları güncelleyin.");
  }
  const account = match[1], role = match[2].split("/").at(-1)!;
  const tags = await new S3Client({ region: outputs.callAnalyticsRegion }).send(new GetBucketTaggingCommand({ Bucket: outputs.salesCatalogBucket }));
  if (tags.TagSet?.find((tag) => tag.Key === "sst:stage")?.Value !== stage
    || tags.TagSet?.find((tag) => tag.Key === "sst:app")?.Value !== "eac-crm") throw new Error("SST outputs beklenen stage'e ait değil.");
  const serviceAccount = `${serviceAccountId}@${project}.iam.gserviceaccount.com`;
  const path = resolve(`.local/google/wif-${stage}.json`);
  console.log(JSON.stringify({ stage, project, roleArn, pool, provider, serviceAccount, output: path }));
  if (!values.apply) { console.log("Dry-run: Google kaynak veya IAM değişikliği yapılmadı."); return; }
  await gcloud(["services", "enable", "aiplatform.googleapis.com", "iam.googleapis.com", "iamcredentials.googleapis.com", "sts.googleapis.com", `--project=${project}`]);
  const number = (await gcloud(["projects", "describe", project, "--format=value(projectNumber)"])).trim();
  if (!/^\d+$/.test(number)) throw new Error("Google proje numarası bulunamadı.");
  await ensureListedResource(gcloud, ["iam", "service-accounts", "list", `--project=${project}`], serviceAccount,
    ["iam", "service-accounts", "create", serviceAccountId, `--project=${project}`, "--display-name=E-APARAT call analytics"]);
  await ensureListedResource(gcloud, ["iam", "workload-identity-pools", "list", "--location=global", `--project=${project}`, "--show-deleted"], pool,
    ["iam", "workload-identity-pools", "create", pool, "--location=global", `--project=${project}`, `--display-name=E-APARAT ${stage}`]);
  const providerFlags = [provider, `--workload-identity-pool=${pool}`, "--location=global", `--project=${project}`, `--account-id=${account}`,
    "--attribute-mapping=google.subject=assertion.arn,attribute.account=assertion.account,attribute.aws_role=assertion.arn.extract('assumed-role/{role_name}/')",
    `--attribute-condition=assertion.account == '${account}' && attribute.aws_role == '${role}'`];
  const list = ["iam", "workload-identity-pools", "providers", "list", `--workload-identity-pool=${pool}`, "--location=global", `--project=${project}`, "--show-deleted"];
  await ensureListedResource(gcloud, list, provider, ["iam", "workload-identity-pools", "providers", "create-aws", ...providerFlags]);
  // Refresh the exact role condition if SST has replaced the generated Lambda role.
  await gcloud(["iam", "workload-identity-pools", "providers", "update-aws", ...providerFlags]);
  for (const roleName of ["roles/aiplatform.user", "roles/serviceusage.serviceUsageConsumer"]) {
    await gcloud(["projects", "add-iam-policy-binding", project, `--member=serviceAccount:${serviceAccount}`, `--role=${roleName}`, "--condition=None"]);
  }
  await gcloud(["iam", "service-accounts", "add-iam-policy-binding", serviceAccount, `--project=${project}`,
    "--role=roles/iam.workloadIdentityUser",
    `--member=principalSet://iam.googleapis.com/projects/${number}/locations/global/workloadIdentityPools/${pool}/attribute.aws_role/${role}`]);
  await mkdir(resolve(".local/google"), { recursive: true });
  await gcloud(["iam", "workload-identity-pools", "create-cred-config",
    `projects/${number}/locations/global/workloadIdentityPools/${pool}/providers/${provider}`,
    "--aws", `--service-account=${serviceAccount}`, `--output-file=${path}`]);
  federationCredentials(await readFile(path, "utf8"));
  console.log("WIF hazır. SST deploy bu stage dosyasını otomatik okuyacak; kişisel ADC veya servis hesabı anahtarı yüklenmedi.");
}
main().catch((error) => { console.error(safeFailure(error)); process.exitCode = 1; });
