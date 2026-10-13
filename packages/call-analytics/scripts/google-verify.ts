import "./environment";
import { z } from "zod";
import { embedText, googleSettings, structuredGenerate } from "../src/google";
import { safeFailure } from "./environment";
import { analysisSchema } from "../src/contracts";
import { analysisSystemPrompt, validateAnalysis } from "../src/analysis";
import { parseTranscript, transcriptForPrompt } from "../src/transcript";
async function main() {
  const settings = googleSettings();
  const vector = await embedText("E-APARAT 30 mm profil tapası", "RETRIEVAL_QUERY");
  console.log(JSON.stringify({ project: settings.project, embeddingModel: settings.embeddingModel, location: settings.embeddingLocation, dimensions: vector.length }));
  const response = await structuredGenerate({ schema: z.object({ ok: z.boolean() }).strict(), system: "Return only the requested JSON with ok=true.", data: { test: "connection" }, maxTokens: 100 });
  if (!response.data.ok) throw new Error("Google JSON doğrulaması başarısız.");
  console.log(JSON.stringify({ analysisModel: settings.analysisModel, location: settings.analysisLocation, structuredOutput: "ok", inputTokens: response.inputTokens, outputTokens: response.outputTokens }));
  const text = "Müşteri: 30 mm profil tapası arıyorum, 500 adet gerekiyor. Temsilci: Ölçüyü ve güncel fiyatı doğrulayıp yarın size teklif göndereceğim.";
  const transcript = parseTranscript({ results: { transcripts: [{ transcript: text }], items: [
    { type: "pronunciation", start_time: "0", end_time: "10", alternatives: [{ content: text, confidence: "1" }] }
  ] } });
  const sources = [{ id: "K1", uri: "s3://example/catalog.pdf", page: 1, version: "TEST",
    kind: "CATALOG" as const, title: "Sentetik test", score: 1, text: "30 mm profil tapası. Ürün kodu TEST-30. Bu test dokümanında fiyat bulunmuyor." }];
  const call = await structuredGenerate({ schema: analysisSchema, system: analysisSystemPrompt, maxTokens: 4000,
    data: { customer: { companyName: "Sentetik test firması", category: null }, representativeName: "Test Temsilcisi",
      transcript: transcriptForPrompt(transcript), catalogSources: sources, analysisDate: "2026-10-09" } });
  const analysis = validateAnalysis(call.data, sources, transcript);
  console.log(JSON.stringify({ salesAnalysis: "validated", outcome: analysis.outcome, sources: sources.length,
    inputTokens: call.inputTokens, outputTokens: call.outputTokens }));
}
main().catch((error) => { console.error(safeFailure(error)); process.exitCode = 1; });
