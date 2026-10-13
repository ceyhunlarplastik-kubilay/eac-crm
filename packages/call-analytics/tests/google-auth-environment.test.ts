import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { localGoogleCredentialPath, googleAuthEnvironment } from "../../../infra/google-auth";

const directory = await mkdtemp(resolve(tmpdir(), "eac-google-auth-"));
const path = resolve(directory, ".config/gcloud/application_default_credentials.json");
await mkdir(resolve(directory, ".config/gcloud"), { recursive: true });
await writeFile(path, JSON.stringify({ type: "authorized_user", client_id: "test-client", client_secret: "test-secret", refresh_token: "test-refresh" }));
after(async () => { await rm(directory, { recursive: true, force: true }); });

async function isolatedGoogleClient(env: Record<string, string>) {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { GoogleAuth } = require(workerData.authLibrary);
    new GoogleAuth({ projectId: 'e-aparat-crm' }).getClient()
      .then(client => parentPort.postMessage({ loaded: true, clientType: client.constructor.name }))
      .catch(error => parentPort.postMessage({ loaded: false, error: error.message }));
  `, { eval: true, env: { METADATA_SERVER_DETECTION: "none", ...env }, workerData: {
    authLibrary: import.meta.resolve("google-auth-library").replace(/^file:\/\//, "")
  } });
  try {
    return await new Promise<{ loaded: boolean; clientType?: string; error?: string }>((resolve, reject) => {
      worker.once("message", resolve); worker.once("error", reject);
      worker.once("exit", (code) => { if (code !== 0) reject(new Error(`Worker exited: ${code}`)); });
    });
  } finally { await worker.terminate(); }
}

test("SST-like worker reproduces missing ADC without inherited shell environment", async () => {
  const result = await isolatedGoogleClient({ GOOGLE_AUTH_MODE: "adc", SST_LIVE: "true", SST_DEV: "true" });
  assert.equal(result.loaded, false);
  assert.match(result.error!, /Could not load the default credentials/);
});

test("explicit dev credential path lets the actual Google SDK load ADC without HOME", async () => {
  const env = googleAuthEnvironment(true, null, {}, directory);
  assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, path);
  assert.equal(Object.hasOwn(env, "GOOGLE_WIF_CONFIG"), false);
  assert.equal((await isolatedGoogleClient({ ...env, SST_LIVE: "true", SST_DEV: "true" })).loaded, true);
});

test("deploy environment includes only federation even if local ADC variables are present", () => {
  const wif = { type: "external_account", audience: "test-federation" };
  assert.deepEqual(googleAuthEnvironment(false, wif, { GOOGLE_APPLICATION_CREDENTIALS: path }, directory), {
    GOOGLE_AUTH_MODE: "federation", GOOGLE_WIF_CONFIG: JSON.stringify(wif)
  });
  assert.throws(() => googleAuthEnvironment(false, null), /WIF/);
});

test("ADC path respects explicit credentials and Cloud SDK config, and fails early when missing", () => {
  assert.equal(localGoogleCredentialPath({ GOOGLE_APPLICATION_CREDENTIALS: path, CLOUDSDK_CONFIG: directory }, "unused"), path);
  assert.equal(localGoogleCredentialPath({ CLOUDSDK_CONFIG: directory }, "unused"), resolve(directory, "application_default_credentials.json"));
  assert.throws(() => googleAuthEnvironment(true, null, {}, resolve(directory, "missing-home")), /ADC dosyası/);
});
