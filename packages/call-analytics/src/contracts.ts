import { z } from "zod";

export const MAX_AUDIO_BYTES = 200 * 1024 * 1024;
export const MAX_TRANSCRIPT_CHARACTERS = 100_000;
export const PROMPT_VERSION = "sales-call-tr-v2-google-neon";
export const recordingStatuses = ["UPLOADING", "QUEUED", "TRANSCRIBING", "ANALYZING", "COMPLETED", "FAILED"] as const;
export type RecordingStatus = typeof recordingStatuses[number];
export const statusLabels: Record<RecordingStatus, string> = {
  UPLOADING: "Yükleme bekleniyor", QUEUED: "Sırada", TRANSCRIBING: "Yazıya çevriliyor",
  ANALYZING: "Analiz ediliyor", COMPLETED: "Tamamlandı", FAILED: "İşlem başarısız"
};

export const mediaTypes = {
  mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", m4a: "audio/mp4",
  mp4: "video/mp4", ogg: "audio/ogg", webm: "audio/webm", amr: "audio/amr"
} as const;
export type MediaFormat = keyof typeof mediaTypes;

export const uploadSchema = z.object({
  customerId: z.string().min(1).max(100),
  fileName: z.string().min(1).max(255).refine((value) => !/[\x00-\x1f/\\]/.test(value), "Geçersiz dosya adı."),
  fileSize: z.number().int().min(1).max(MAX_AUDIO_BYTES, "Dosya en fazla 200 MB olabilir."),
  representativeName: z.string().trim().min(1).max(200),
  recordedAt: z.string().datetime({ offset: true }).nullable().optional(),
  speakerMode: z.enum(["diarization", "channels"]).default("diarization"),
  languageCode: z.enum(["tr-TR", "en-US", "de-DE"]).default("tr-TR")
}).strict().transform((value, context) => {
  const extension = value.fileName.split(".").at(-1)?.toLowerCase();
  if (!extension || !(extension in mediaTypes)) {
    context.addIssue({ code: "custom", message: "MP3, WAV, FLAC, M4A, MP4, OGG, WEBM veya AMR yükleyin." });
    return z.NEVER;
  }
  const mediaFormat = extension as MediaFormat;
  return { ...value, mediaFormat, contentType: mediaTypes[mediaFormat] };
});
export type UploadInput = z.input<typeof uploadSchema>;

const text = z.string().min(1).max(2400);
const evidenceSchema = z.object({
  text: z.string().min(1).max(500),
  startSeconds: z.number().min(0).nullable()
}).strict();
export const analysisSchema = z.object({
  summary: text,
  customerNeeds: z.array(text).max(12),
  outcome: z.enum(["SALE", "FOLLOW_UP", "NOT_INTERESTED", "UNCLEAR"]),
  sentiment: z.enum(["POSITIVE", "NEUTRAL", "NEGATIVE", "MIXED", "UNKNOWN"]),
  sentimentReason: text,
  salesOpportunity: z.enum(["HIGH", "MEDIUM", "LOW", "UNKNOWN"]),
  opportunityReason: text,
  representativeStrengths: z.array(text).max(10),
  improvements: z.array(text).max(10),
  objections: z.array(text).max(10),
  nextActions: z.array(z.object({
    action: text,
    owner: z.enum(["REPRESENTATIVE", "CUSTOMER", "COMPANY"]),
    timing: z.string().max(300).nullable()
  }).strict()).max(12),
  productRecommendations: z.array(z.object({
    productName: z.string().min(1).max(300),
    productCode: z.string().max(100).nullable(),
    reason: text,
    sourceIds: z.array(z.string().regex(/^K[1-9]\d*$/)).min(1).max(6),
    priceNote: z.string().max(500).nullable()
  }).strict()).max(8),
  evidence: z.array(evidenceSchema).max(10),
  uncertainties: z.array(text).max(10)
}).strict();
export type CallAnalysis = z.infer<typeof analysisSchema>;

export type CatalogSource = {
  id: string;
  uri: string;
  page: number | null;
  text: string;
  score: number | null;
  version: string | null;
  title?: string;
  kind?: "CATALOG" | "COMPANY";
};
export type TranscriptSegment = {
  speaker: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
};
export type Transcript = {
  text: string;
  segments: TranscriptSegment[];
  durationSeconds: number;
  averageConfidence: number | null;
};

export type RecordingSummary = {
  id: string;
  customerId: string;
  customer: { id: string; companyName: string };
  fileName: string;
  fileSize: number;
  representativeName: string;
  recordedAt: string | null;
  status: RecordingStatus;
  attempt: number;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
  durationSeconds: number | null;
  uploadedByName: string | null;
  uploadedByEmail: string | null;
};
export type RecordingDetail = RecordingSummary & {
  transcriptText: string | null;
  transcriptSegments: TranscriptSegment[] | null;
  averageConfidence: number | null;
  analysis: CallAnalysis | null;
  catalogSources: CatalogSource[] | null;
  modelId: string | null;
  promptVersion: string | null;
};
