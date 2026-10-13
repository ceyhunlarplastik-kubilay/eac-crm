import { GoogleGenAI, ThinkingLevel, type GenerateContentParameters, type EmbedContentParameters } from "@google/genai";
import type { GoogleAuthOptions } from "google-auth-library";
import { z } from "zod";
import { EMBEDDING_DIMENSIONS, normalizeVector } from "./knowledge";

export function googleSettings() {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project)) throw new Error("GOOGLE_CLOUD_PROJECT gerekli.");
  return {
    project,
    embeddingLocation: process.env.GOOGLE_CLOUD_LOCATION ?? "europe-west4",
    analysisLocation: process.env.GEMINI_LOCATION ?? "eu",
    embeddingModel: process.env.EMBEDDING_MODEL_ID ?? "gemini-embedding-001",
    analysisModel: process.env.GEMINI_MODEL_ID ?? "gemini-3.1-flash-lite"
  };
}

export function federationCredentials(raw: string) {
  const config = JSON.parse(raw);
  if (config.type !== "external_account" || config.subject_token_type !== "urn:ietf:params:aws:token-type:aws4_request"
    || config.token_url !== "https://sts.googleapis.com/v1/token"
    || !/^\/\/iam.googleapis.com\/projects\/\d+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+\/providers\/[a-z0-9-]+$/.test(config.audience)
    || !/^https:\/\/iamcredentials.googleapis.com\/v1\/projects\/-\/serviceAccounts\/[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com:generateAccessToken$/.test(config.service_account_impersonation_url)
    || config.credential_source?.environment_id !== "aws1"
    || config.credential_source?.regional_cred_verification_url !== "https://sts.{region}.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15") {
    throw new Error("Google AWS Workload Identity Federation yapılandırması geçersiz.");
  }
  // Lambda provides AWS_* credentials. Remove optional metadata/file/executable sources.
  return {
    type: config.type, audience: config.audience, subject_token_type: config.subject_token_type,
    token_url: config.token_url, service_account_impersonation_url: config.service_account_impersonation_url,
    credential_source: { environment_id: "aws1", regional_cred_verification_url: config.credential_source.regional_cred_verification_url }
  } as GoogleAuthOptions["credentials"];
}

const clients = new Map<string, GoogleGenAI>();
function google(location: string) {
  const { project } = googleSettings();
  const mode = process.env.GOOGLE_AUTH_MODE ?? "adc";
  const raw = process.env.GOOGLE_WIF_CONFIG;
  if (mode !== "adc" && mode !== "federation") throw new Error("GOOGLE_AUTH_MODE adc veya federation olmalı.");
  if (mode === "federation" && !raw) throw new Error("Google WIF yapılandırması eksik; kişisel ADC AWS'ye gönderilmez.");
  const key = `${project}:${location}:${mode}:${raw ?? ""}`;
  let client = clients.get(key);
  if (!client) {
    client = new GoogleGenAI({ vertexai: true, project, location,
      googleAuthOptions: { scopes: ["https://www.googleapis.com/auth/cloud-platform"],
        ...(mode === "federation" ? { credentials: federationCredentials(raw!) } : {}) },
      httpOptions: { apiVersion: "v1", timeout: 60_000, retryOptions: { attempts: 3 } }
    });
    clients.set(key, client);
  }
  return client;
}

// Mockable transport; production always uses authenticated Vertex AI, never the Developer API.
export const googleApi = {
  generate: (input: GenerateContentParameters) => google(googleSettings().analysisLocation).models.generateContent(input),
  embed: (input: EmbedContentParameters) => google(googleSettings().embeddingLocation).models.embedContent(input)
};

export function googleJsonSchema(schema: z.ZodType) {
  const { $schema: _, ...json } = z.toJSONSchema(schema, { target: "draft-7" });
  return json;
}

export async function structuredGenerate<T>(options: {
  schema: z.ZodType<T>; system: string; data: unknown; maxTokens: number;
}) {
  const model = googleSettings().analysisModel;
  const response = await googleApi.generate({ model, contents: JSON.stringify(options.data), config: {
    systemInstruction: options.system, temperature: 0, maxOutputTokens: options.maxTokens,
    responseMimeType: "application/json", responseJsonSchema: googleJsonSchema(options.schema),
    ...(model.startsWith("gemini-3") ? { thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } } : {})
  } });
  if (response.candidates?.[0]?.finishReason !== "STOP" || !response.text) {
    throw new Error("Google model geçerli, eksiksiz bir JSON sonucu üretemedi.");
  }
  return {
    data: options.schema.parse(JSON.parse(response.text)),
    inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: (response.usageMetadata?.candidatesTokenCount ?? 0) + (response.usageMetadata?.thoughtsTokenCount ?? 0)
  };
}

export async function embedText(text: string, taskType: "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT", title?: string) {
  if (!text.trim() || text.length > 1400) throw new Error("Embedding girdisi boş veya parça sınırını aşıyor.");
  const response = await googleApi.embed({ model: googleSettings().embeddingModel, contents: text, config: {
    taskType, outputDimensionality: EMBEDDING_DIMENSIONS, autoTruncate: false,
    ...(taskType === "RETRIEVAL_DOCUMENT" && title ? { title } : {})
  } });
  const embedding = response.embeddings?.[0];
  if (response.embeddings?.length !== 1 || embedding?.statistics?.truncated || !embedding?.values) {
    throw new Error("Google embedding eksik veya metin kesilmiş; doküman yayımlanmadı.");
  }
  return normalizeVector(embedding.values);
}
