import { MAX_TRANSCRIPT_CHARACTERS, type Transcript, type TranscriptSegment } from "./contracts";

type TranscribeItem = {
  type?: string;
  start_time?: string;
  end_time?: string;
  speaker_label?: string;
  alternatives?: Array<{ content?: string; confidence?: string }>;
};
type TranscribeDocument = {
  results?: {
    transcripts?: Array<{ transcript?: string }>;
    items?: TranscribeItem[];
    speaker_labels?: { segments?: Array<{ speaker_label?: string; items?: TranscribeItem[] }> };
    channel_labels?: { channels?: Array<{ channel_label?: string; items?: TranscribeItem[] }> };
  };
};

export function parseTranscript(document: unknown): Transcript {
  const data = document as TranscribeDocument;
  const text = data.results?.transcripts?.map((item) => item.transcript ?? "").join(" ").trim() ?? "";
  if (!text) throw new Error("Ses kaydından anlaşılır konuşma çıkarılamadı.");
  if (text.length > MAX_TRANSCRIPT_CHARACTERS) {
    throw new Error("Görüşme analiz sınırını aşıyor. Kaydı daha kısa parçalara ayırın.");
  }
  const speakers = new Map<string, string>();
  for (const segment of data.results?.speaker_labels?.segments ?? []) {
    for (const item of segment.items ?? []) {
      if (item.start_time) speakers.set(item.start_time, segment.speaker_label ?? "unknown");
    }
  }
  const channels = data.results?.channel_labels?.channels;
  const words = channels?.length
    ? channels.flatMap((channel) => (channel.items ?? []).map((item) => ({ ...item, speaker_label: channel.channel_label })))
    : (data.results?.items ?? []);
  const segments: TranscriptSegment[] = [];
  const confidence: number[] = [];
  const lastBySpeaker = new Map<string, TranscriptSegment>();
  for (const item of words) {
    const content = item.alternatives?.[0]?.content;
    if (!content) continue;
    const speaker = item.speaker_label ?? speakers.get(item.start_time ?? "") ?? "unknown";
    if (item.type === "punctuation") {
      const segment = lastBySpeaker.get(speaker) ?? segments.at(-1);
      if (segment) segment.text += content;
      continue;
    }
    const start = Number(item.start_time);
    const end = Number(item.end_time);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    const probability = Number(item.alternatives?.[0]?.confidence);
    if (Number.isFinite(probability) && probability >= 0 && probability <= 1) confidence.push(probability);
    const previous = segments.at(-1);
    if (previous?.speaker === speaker && start - previous.endSeconds < 2 && previous.text.length < 700) {
      previous.text += ` ${content}`;
      previous.endSeconds = end;
      lastBySpeaker.set(speaker, previous);
    } else {
      const segment = { speaker, startSeconds: start, endSeconds: end, text: content };
      segments.push(segment);
      lastBySpeaker.set(speaker, segment);
    }
  }
  segments.sort((a, b) => a.startSeconds - b.startSeconds);
  const durationSeconds = segments.reduce((max, segment) => Math.max(max, segment.endSeconds), 0);
  if (durationSeconds > 7200) throw new Error("Görüşme en fazla 2 saat olabilir. Kaydı parçalara ayırın.");
  return {
    text, segments, durationSeconds,
    averageConfidence: confidence.length ? confidence.reduce((sum, value) => sum + value, 0) / confidence.length : null
  };
}

export function transcriptForPrompt(transcript: Transcript) {
  return transcript.segments.length
    ? transcript.segments.map((segment) => `[${segment.startSeconds.toFixed(1)}s][${segment.speaker}] ${segment.text}`).join("\n")
    : transcript.text;
}
