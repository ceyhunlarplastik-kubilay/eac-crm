import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export function localGoogleCredentialPath(env: NodeJS.ProcessEnv = process.env, home = homedir()) {
  if (env.GOOGLE_APPLICATION_CREDENTIALS) return resolve(env.GOOGLE_APPLICATION_CREDENTIALS);
  const configDirectory = env.CLOUDSDK_CONFIG || resolve(home, ".config/gcloud");
  return resolve(configDirectory, "application_default_credentials.json");
}

export function googleAuthEnvironment(
  dev: boolean, wif: Record<string, unknown> | null,
  env: NodeJS.ProcessEnv = process.env, home = homedir()
): Record<string, string> {
  if (!dev) {
    if (!wif) throw new Error("Deploy için Google WIF yapılandırması gerekli.");
    return { GOOGLE_AUTH_MODE: "federation", GOOGLE_WIF_CONFIG: JSON.stringify(wif) };
  }
  const path = localGoogleCredentialPath(env, home);
  if (!existsSync(path)) {
    throw new Error("Yerel Google ADC dosyası bulunamadı. gcloud auth application-default login ile giriş yapın veya GOOGLE_APPLICATION_CREDENTIALS yolunu kontrol edin.");
  }
  // SST's local Worker receives Lambda environment values, not the shell's HOME.
  // Pass only the local path during dev; never read/upload the personal credential contents.
  return { GOOGLE_AUTH_MODE: "adc", GOOGLE_APPLICATION_CREDENTIALS: path };
}
