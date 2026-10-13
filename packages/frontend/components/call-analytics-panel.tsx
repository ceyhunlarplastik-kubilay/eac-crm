"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, ChevronLeft, ChevronRight, FileAudio, Headphones, Loader2, Play, RefreshCcw, Search, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { MAX_AUDIO_BYTES, mediaTypes, statusLabels, uploadSchema, type CallAnalysis, type RecordingDetail, type RecordingStatus, type RecordingSummary } from "@eac-crm/call-analytics/contracts";

type CustomerOption = { id: string; companyName: string; city?: string | null };
const activeStatuses: RecordingStatus[] = ["QUEUED", "TRANSCRIBING", "ANALYZING"];
const date = (value: string | null) => value ? new Date(value).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul", dateStyle: "medium", timeStyle: "short" }) : "Tarih belirtilmedi";
const seconds = (value: number) => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store", headers: { "Content-Type": "application/json", ...init?.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "İşlem tamamlanamadı.");
  return data;
}

function uploadAudio(url: string, file: File, headers: Record<string, string>, onProgress: (value: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.timeout = 5 * 60 * 1000;
    for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);
    request.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100)); };
    request.onload = () => request.status >= 200 && request.status < 300 ? resolve() : reject(new Error("Ses yüklenemedi. Dosyayı yeniden yükleyin."));
    request.onerror = () => reject(new Error("Ses yüklenemedi. Bağlantınızı kontrol edin."));
    request.ontimeout = () => reject(new Error("Yükleme zaman aşımına uğradı. Daha küçük bir dosya deneyin."));
    request.send(file);
  });
}

export function CallAnalyticsPanel({ user, configured, initialCustomer = null }: {
  user: { name: string; email: string }; configured: boolean; initialCustomer?: CustomerOption | null;
}) {
  const [customer, setCustomer] = useState<CustomerOption | null>(initialCustomer);
  const [search, setSearch] = useState("");
  const [matches, setMatches] = useState<CustomerOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [representativeName, setRepresentativeName] = useState(user.name);
  const [recordedAt, setRecordedAt] = useState("");
  const [speakerMode, setSpeakerMode] = useState<"diarization" | "channels">("diarization");
  const [languageCode, setLanguageCode] = useState<"tr-TR" | "en-US" | "de-DE">("tr-TR");
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [recordings, setRecordings] = useState<RecordingSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [filterCustomer, setFilterCustomer] = useState(Boolean(initialCustomer));
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RecordingDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [tab, setTab] = useState<"analysis" | "transcript">("analysis");
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    if (customer || search.trim().length < 2) { setMatches([]); setSearchError(null); setSearching(false); return; }
    setSearching(true);
    const timer = setTimeout(() => {
      void json<{ customers: CustomerOption[] }>(`/api/customers?q=${encodeURIComponent(search.trim())}&pageSize=20`, { signal: controller.signal })
        .then((data) => { setMatches(data.customers); setSearchError(null); })
        .catch((error) => { if (!controller.signal.aborted) setSearchError(error.message); })
        .finally(() => { if (!controller.signal.aborted) setSearching(false); });
    }, 300);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [customer, search]);

  const customerId = filterCustomer ? customer?.id : undefined;
  useEffect(() => { setPage(1); }, [customerId]);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (customerId) params.set("customerId", customerId);
      const data = await json<{ recordings: RecordingSummary[]; total: number; pageCount: number }>(`/api/call-recordings?${params}`, { signal });
      setRecordings(data.recordings); setTotal(data.total); setPageCount(data.pageCount); setListError(null);
    } catch (error) { if (!signal?.aborted) setListError(error instanceof Error ? error.message : "Kayıtlar yüklenemedi."); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, [customerId, page]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);
  useEffect(() => {
    if (!recordings.some((recording) => activeStatuses.includes(recording.status) || recording.status === "UPLOADING")) return;
    const interval = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 5000);
    return () => clearInterval(interval);
  }, [recordings, refresh]);
  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    let interval: ReturnType<typeof setInterval> | undefined;
    setDetail(null); setDetailError(null); setAudioUrl(null); setTab("analysis");
    const load = async () => {
      try {
        const data = await json<{ recording: RecordingDetail }>(`/api/call-recordings/${selectedId}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setDetail(data.recording); setDetailError(null);
        if (!activeStatuses.includes(data.recording.status) && data.recording.status !== "UPLOADING") clearInterval(interval);
      } catch (error) { if (!controller.signal.aborted) setDetailError(error instanceof Error ? error.message : "Analiz yüklenemedi."); }
    };
    interval = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 5000);
    void load();
    return () => { controller.abort(); clearInterval(interval); };
  }, [selectedId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!customer || !file) { toast.error("Müşteri ve ses dosyası seçin."); return; }
    const input = { customerId: customer.id, fileName: file.name, fileSize: file.size, representativeName,
      recordedAt: recordedAt ? new Date(recordedAt).toISOString() : null, speakerMode, languageCode };
    const parsed = uploadSchema.safeParse(input);
    if (!parsed.success) { toast.error(parsed.error.issues[0].message); return; }
    setUploading(true); setProgress(0);
    let recordingId: string | undefined;
    try {
      const result = await json<{ recordingId: string; uploadUrl: string; headers: Record<string, string> }>("/api/call-recordings", { method: "POST", body: JSON.stringify(input) });
      recordingId = result.recordingId;
      await uploadAudio(result.uploadUrl, file, result.headers, setProgress);
      // S3/EventBridge starts the main flow. This idempotent dispatch also repairs delayed event delivery.
      try { await json(`/api/call-recordings/${result.recordingId}/dispatch`, { method: "POST" }); }
      catch { toast.info("Ses yüklendi. Analiz başlamazsa kayıttaki Başlat düğmesini kullanın."); }
      toast.success("Ses kaydı yüklendi. Analiz hazırlanıyor.");
      setFile(null); if (fileInput.current) fileInput.current.value = "";
      setSelectedId(result.recordingId); setPage(1); await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Ses yüklenemedi.");
      if (recordingId) { setSelectedId(recordingId); await refresh(); }
    } finally { setUploading(false); }
  }
  async function run(action: "retry" | "dispatch") {
    if (!detail) return;
    setWorking(true);
    try {
      await json(`/api/call-recordings/${detail.id}/${action}`, { method: "POST" });
      const data = await json<{ recording: RecordingDetail }>(`/api/call-recordings/${detail.id}`);
      setDetail(data.recording);
      // Restart the status subscription, including when a failed row was terminal before retry.
      setSelectedId(null); setTimeout(() => setSelectedId(detail.id), 0);
      await refresh(); toast.success("Analiz başlatıldı.");
    } catch (error) { toast.error(error instanceof Error ? error.message : "İşlem başlatılamadı."); }
    finally { setWorking(false); }
  }
  async function listen() {
    if (!detail) return;
    setWorking(true);
    try { const result = await json<{ url: string }>(`/api/call-recordings/${detail.id}/playback`); setAudioUrl(result.url); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Ses açılmadı."); }
    finally { setWorking(false); }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-[1500px] flex-col gap-5 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
        <div className="flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Headphones className="size-6" /></span>
          <div><h1 className="text-2xl font-semibold tracking-tight">Görüşme Analizleri</h1><p className="mt-1 text-sm text-muted-foreground">Müşteri ihtiyacını anlayın, sonraki satış adımını belirleyin.</p></div>
        </div>
        <Button variant="outline" asChild><Link href="/"><ArrowLeft /> Müşteriler</Link></Button>
      </header>
      {!configured && <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">Görüşme analizi henüz etkinleştirilmedi. Yapılandırma tamamlandığında ses yükleyebilirsiniz.</div>}
      <div className="grid items-start gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
        <aside className="space-y-5">
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Upload className="size-4 text-primary" /> Yeni görüşme</CardTitle><p className="text-sm text-muted-foreground">Bir müşteri seçin ve telefon kaydını yükleyin.</p></CardHeader>
            <CardContent><form onSubmit={(event) => void submit(event)} className="space-y-4">
              <fieldset disabled={uploading || !configured} className="space-y-4 disabled:opacity-70">
                <div className="space-y-1.5"><Label htmlFor="call-customer">Müşteri</Label>
                  {customer ? <div className="flex items-center justify-between gap-2 rounded-md border bg-primary/5 p-2.5"><span className="min-w-0 text-sm font-medium">{customer.companyName}</span><Button size="icon" variant="ghost" type="button" aria-label="Müşteri seçimini temizle" onClick={() => { setCustomer(null); setSearch(""); }}><X /></Button></div>
                    : <><div className="relative"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" /><Input id="call-customer" autoComplete="off" placeholder="Firma adı ile arayın…" className="pl-9" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
                      {searching && <p className="text-xs text-muted-foreground">Müşteriler aranıyor…</p>}
                      {searchError && <p role="alert" className="text-xs text-destructive">{searchError}</p>}
                      {matches.length > 0 && <div className="max-h-48 overflow-y-auto rounded-md border bg-background">{matches.map((item) => <button type="button" className="block w-full border-b p-2.5 text-left text-sm last:border-b-0 hover:bg-muted" key={item.id} onClick={() => { setCustomer(item); setMatches([]); }}><span className="block font-medium">{item.companyName}</span>{item.city && <span className="text-xs text-muted-foreground">{item.city}</span>}</button>)}</div>}
                      {!searching && !searchError && search.trim().length >= 2 && matches.length === 0 && <p className="text-xs text-muted-foreground">Eşleşen müşteri bulunamadı.</p>}</>}
                </div>
                <div className="space-y-1.5"><Label htmlFor="call-representative">Müşteri temsilcisi</Label><Input id="call-representative" required maxLength={200} value={representativeName} onChange={(event) => setRepresentativeName(event.target.value)} /></div>
                <div className="space-y-1.5"><Label htmlFor="call-date">Görüşme tarihi <span className="font-normal text-muted-foreground">(isteğe bağlı)</span></Label><Input id="call-date" type="datetime-local" value={recordedAt} onChange={(event) => setRecordedAt(event.target.value)} /></div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5"><Label htmlFor="call-language">Kayıt dili</Label><select id="call-language" value={languageCode} onChange={(event) => setLanguageCode(event.target.value as typeof languageCode)} className="h-9 w-full rounded-md border bg-background px-2 text-sm"><option value="tr-TR">Türkçe</option><option value="en-US">İngilizce</option><option value="de-DE">Almanca</option></select></div>
                  <div className="space-y-1.5"><Label htmlFor="call-speakers">Ses düzeni</Label><select id="call-speakers" value={speakerMode} onChange={(event) => setSpeakerMode(event.target.value as typeof speakerMode)} className="h-9 w-full rounded-md border bg-background px-2 text-sm"><option value="diarization">Ortak ses kanalı</option><option value="channels">Ayrı iki kanal</option></select></div>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">“Ayrı iki kanal” yalnızca müşteri ve temsilcinin ayrı kanallara kaydedildiği dosyalar içindir.</p>
                <div className="space-y-2 rounded-lg border border-dashed bg-muted/20 p-3">
                  <Label htmlFor="call-file" className="flex items-center gap-2"><FileAudio className="size-4 text-primary" /> Ses dosyası</Label>
                  <input ref={fileInput} id="call-file" type="file" accept={Object.keys(mediaTypes).map((extension) => `.${extension}`).join(",")} className="w-full text-xs file:mr-2 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-sm" onChange={(event) => { const next = event.target.files?.[0] ?? null; if (next && next.size > MAX_AUDIO_BYTES) { toast.error("Dosya en fazla 200 MB olabilir."); event.target.value = ""; return; } setFile(next); }} />
                  <p className="text-xs leading-relaxed text-muted-foreground">MP3, WAV, FLAC, M4A, MP4, OGG, WEBM, AMR · En fazla 200 MB ve 2 saat</p>
                  {file && <p className="break-all text-xs font-medium">{file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB</p>}
                </div>
                <Button type="submit" className="w-full" disabled={!customer || !file}><Upload /> Yükle ve analiz et</Button>
              </fieldset>
              {uploading && <div role="status" aria-live="polite" className="space-y-2"><p className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" /> Ses yükleniyor · %{progress}</p><progress className="h-2 w-full accent-primary" max={100} value={progress} /></div>}
              <p className="text-xs leading-relaxed text-muted-foreground">Analiz bu müşteri kaydına eklenir. Görüşme değerlendirmesini satış takibinde kullanabilirsiniz.</p>
            </form></CardContent>
          </Card>
          <Card>
            <CardHeader><div className="flex items-center justify-between gap-2"><CardTitle className="text-base">Görüşme kayıtları <span className="ml-1 text-xs font-normal text-muted-foreground">{total}</span></CardTitle><Button size="icon" variant="ghost" aria-label="Kayıtları yenile" onClick={() => void refresh()} disabled={loading}><RefreshCcw className={cn(loading && "animate-spin")} /></Button></div>
              {customer && <label className="flex cursor-pointer items-center gap-2 pt-2 text-xs text-muted-foreground"><input type="checkbox" checked={filterCustomer} onChange={(event) => setFilterCustomer(event.target.checked)} /> Yalnızca seçilen müşteri</label>}
            </CardHeader>
            <CardContent>
              {listError ? <p role="alert" className="text-sm text-destructive">{listError}</p> : loading ? <p className="py-4 text-sm text-muted-foreground">Kayıtlar yükleniyor…</p> : recordings.length === 0 ? <p className="py-4 text-sm text-muted-foreground">Henüz görüşme kaydı yok.</p> : <div className="max-h-[480px] space-y-2 overflow-y-auto">{recordings.map((recording) => <button key={recording.id} type="button" onClick={() => setSelectedId(recording.id)} className={cn("w-full rounded-lg border p-3 text-left transition-colors hover:bg-muted/40", selectedId === recording.id && "border-primary bg-primary/5")}>
                <div className="truncate text-sm font-semibold">{recording.customer.companyName}</div><div className="mt-1 truncate text-xs text-muted-foreground">{recording.fileName}</div><div className="mt-2 flex flex-wrap items-center justify-between gap-2"><Status status={recording.status} /><span className="text-[11px] text-muted-foreground">{date(recording.recordedAt ?? recording.createdAt)}</span></div>
              </button>)}</div>}
              {pageCount > 1 && <div className="mt-3 flex items-center justify-between gap-2"><Button variant="outline" size="icon" aria-label="Önceki kayıt sayfası" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft /></Button><span className="text-xs text-muted-foreground">{page} / {pageCount}</span><Button variant="outline" size="icon" aria-label="Sonraki kayıt sayfası" disabled={page >= pageCount} onClick={() => setPage((value) => value + 1)}><ChevronRight /></Button></div>}
            </CardContent>
          </Card>
        </aside>
        <section className="min-w-0" aria-live="polite">
          {!selectedId ? <Card className="flex min-h-[450px] items-center justify-center"><div className="max-w-md px-6 py-16 text-center"><span className="mx-auto flex size-16 items-center justify-center rounded-full bg-primary/10"><Headphones className="size-7 text-primary" /></span><h2 className="mt-5 text-xl font-semibold">Her görüşmeden bir sonraki adıma</h2><p className="mt-3 text-sm leading-relaxed text-muted-foreground">Bir ses kaydı yükleyin veya listeden görüşme seçin. Müşteri ihtiyaçları, itirazlar, katalogdan ürün önerileri ve satış için takip adımları burada görünecek.</p><div className="mt-6 flex flex-wrap justify-center gap-2"><Badge variant="secondary">Görüşme özeti</Badge><Badge variant="secondary">Ürün eşleştirme</Badge><Badge variant="secondary">Satış takibi</Badge></div></div></Card>
            : detailError ? <Card><CardContent className="pt-4"><p role="alert" className="text-sm text-destructive">{detailError}</p></CardContent></Card>
            : !detail ? <Card><CardContent className="flex items-center gap-2 py-10"><Loader2 className="size-4 animate-spin" /> Görüşme yükleniyor…</CardContent></Card>
            : <Card>
              <CardHeader className="border-b"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="mb-2"><Status status={detail.status} /></div><h2 className="break-words text-xl font-semibold">{detail.customer.companyName}</h2><p className="mt-1 text-sm text-muted-foreground">{detail.representativeName} · {date(detail.recordedAt ?? detail.createdAt)}{detail.durationSeconds !== null && ` · ${seconds(detail.durationSeconds)}`}</p><p className="mt-1 break-all text-xs text-muted-foreground">{detail.fileName}</p></div>
                <div className="flex flex-wrap gap-2">{detail.status !== "UPLOADING" && <Button size="sm" variant="outline" onClick={() => void listen()} disabled={working}><Play /> Kaydı dinle</Button>}{detail.status === "FAILED" && <Button size="sm" onClick={() => void run("retry")} disabled={working}>{working ? <Loader2 className="animate-spin" /> : <RefreshCcw />} Yeniden dene</Button>}{detail.status === "UPLOADING" && <Button size="sm" onClick={() => void run("dispatch")} disabled={working}>Analizi başlat</Button>}</div></div>
                {audioUrl && <audio ref={audio} controls src={audioUrl} className="mt-3 w-full" onError={() => toast.error("Ses bağlantısı geçersiz veya süresi doldu. Kaydı dinle düğmesini tekrar kullanın.")} />}
                <div role="tablist" aria-label="Görüşme içeriği" className="mt-3 flex gap-1"><Button role="tab" aria-selected={tab === "analysis"} variant={tab === "analysis" ? "secondary" : "ghost"} onClick={() => setTab("analysis")}>Analiz</Button><Button role="tab" aria-selected={tab === "transcript"} variant={tab === "transcript" ? "secondary" : "ghost"} onClick={() => setTab("transcript")}>Konuşma metni</Button></div>
              </CardHeader>
              <CardContent className="space-y-5 pt-5">
                {detail.status === "FAILED" && <div role="alert" className="rounded-md border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">{detail.errorMessage ?? "Görüşme işlenemedi."}</div>}
                {activeStatuses.includes(detail.status) && <div className="flex items-center gap-3 rounded-md bg-primary/5 p-4 text-sm"><Loader2 className="size-5 shrink-0 animate-spin text-primary" /><div><p className="font-medium">{statusLabels[detail.status]}</p><p className="mt-1 text-xs text-muted-foreground">Hazır olduğunda sonuçlar otomatik olarak güncellenir. Bu sayfadan ayrılabilirsiniz.</p></div></div>}
                {detail.status === "UPLOADING" && <p className="text-sm text-muted-foreground">Ses dosyasının yüklenmesi bekleniyor. Yükleme tamamlandıysa analizi başlatabilirsiniz.</p>}
                {tab === "transcript" ? <div className="space-y-3"><p className="text-xs leading-relaxed text-muted-foreground">Konuşmacı etiketleri otomatik ayrılır; temsilci veya müşteri kimliği olarak doğrulanmış değildir.</p>{detail.transcriptSegments?.length ? detail.transcriptSegments.map((segment, index) => <div key={index} className="rounded-md border p-3"><button type="button" disabled={!audioUrl} className="mb-1 text-xs font-medium text-primary disabled:text-muted-foreground" onClick={() => { if (audio.current) { audio.current.currentTime = segment.startSeconds; void audio.current.play(); } }}>{seconds(segment.startSeconds)} · {segment.speaker}</button><p className="text-sm leading-relaxed">{segment.text}</p></div>) : <p className="whitespace-pre-wrap text-sm leading-relaxed">{detail.transcriptText ?? "Konuşma metni henüz hazır değil."}</p>}</div>
                  : detail.analysis ? <AnalysisView detail={detail} analysis={detail.analysis} onSeek={(timestamp) => { if (audio.current && timestamp !== null) { audio.current.currentTime = timestamp; void audio.current.play(); } }} />
                  : detail.status === "COMPLETED" ? <p className="text-sm text-muted-foreground">Bu kayıt için analiz bulunamadı.</p> : null}
              </CardContent>
            </Card>}
        </section>
      </div>
    </main>
  );
}

function Status({ status }: { status: RecordingStatus }) {
  return <Badge variant={status === "FAILED" ? "destructive" : status === "COMPLETED" ? "default" : "secondary"} className="gap-1">{status === "COMPLETED" && <CheckCircle2 className="size-3" />}{activeStatuses.includes(status) && <Loader2 className="size-3 animate-spin" />}{statusLabels[status]}</Badge>;
}
function Points({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return <div><h3 className="mb-2 text-sm font-semibold">{title}</h3><ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">{items.map((item, index) => <li key={index}>{item}</li>)}</ul></div>;
}
function AnalysisView({ detail, analysis, onSeek }: { detail: RecordingDetail; analysis: CallAnalysis; onSeek: (timestamp: number | null) => void }) {
  const sentiment = { POSITIVE: "Olumlu", NEUTRAL: "Nötr", NEGATIVE: "Olumsuz", MIXED: "Karışık", UNKNOWN: "Belirsiz" };
  const opportunity = { HIGH: "Yüksek", MEDIUM: "Orta", LOW: "Düşük", UNKNOWN: "Belirsiz" };
  const outcome = { SALE: "Satış / anlaşma", FOLLOW_UP: "Takip gerekiyor", NOT_INTERESTED: "İlgilenmiyor", UNCLEAR: "Sonuç belirsiz" };
  const owner = { REPRESENTATIVE: "Temsilci", CUSTOMER: "Müşteri", COMPANY: "Firma" };
  return <div className="space-y-6">
    <div><div className="mb-3 flex flex-wrap gap-2"><Badge>{outcome[analysis.outcome]}</Badge><Badge variant="secondary">Müşteri yaklaşımı: {sentiment[analysis.sentiment]}</Badge><Badge variant="secondary">Satış fırsatı: {opportunity[analysis.salesOpportunity]}</Badge></div><h3 className="mb-2 text-sm font-semibold">Görüşme özeti</h3><p className="text-sm leading-relaxed">{analysis.summary}</p></div>
    <div className="grid gap-4 rounded-lg bg-muted/30 p-4 md:grid-cols-2"><div><h3 className="mb-1 text-xs font-semibold text-muted-foreground">Müşteri yaklaşımı</h3><p className="text-sm leading-relaxed">{analysis.sentimentReason}</p></div><div><h3 className="mb-1 text-xs font-semibold text-muted-foreground">Satış fırsatı</h3><p className="text-sm leading-relaxed">{analysis.opportunityReason}</p></div></div>
    <Points title="Müşterinin ihtiyaçları" items={analysis.customerNeeds} /><Points title="İtirazlar ve çekinceler" items={analysis.objections} />
    <div className="grid gap-5 border-t pt-5 md:grid-cols-2"><Points title="Temsilcinin güçlü yönleri" items={analysis.representativeStrengths} /><Points title="Gelişim ve kaçırılan fırsatlar" items={analysis.improvements} /></div>
    <div><h3 className="mb-3 text-sm font-semibold">Satış için sonraki adımlar</h3>{analysis.nextActions.length ? <ol className="space-y-2">{analysis.nextActions.map((item, index) => <li key={index} className="flex gap-3 rounded-lg border p-3"><span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{index + 1}</span><div><p className="text-sm leading-relaxed">{item.action}</p><p className="mt-1 text-xs text-muted-foreground">{owner[item.owner]}{item.timing && ` · ${item.timing}`}</p></div></li>)}</ol> : <p className="text-sm text-muted-foreground">Belirgin bir takip adımı çıkarılamadı.</p>}</div>
    <div className="border-t pt-5"><h3 className="mb-3 text-sm font-semibold">Katalogdan ürün önerileri</h3>{analysis.productRecommendations.length ? <div className="space-y-3">{analysis.productRecommendations.map((product, index) => <div key={index} className="rounded-lg border p-4"><div className="flex flex-wrap items-center gap-2"><h4 className="text-sm font-semibold">{product.productName}</h4>{product.productCode && <Badge variant="secondary">{product.productCode}</Badge>}</div><p className="mt-2 text-sm leading-relaxed text-muted-foreground">{product.reason}</p>{product.priceNote && <p className="mt-2 text-xs leading-relaxed text-amber-800">{product.priceNote}</p>}<p className="mt-2 text-xs text-muted-foreground">Kaynak: {product.sourceIds.join(", ")}</p></div>)}</div> : <p className="text-sm text-muted-foreground">Mevcut bilgilerle katalogdan doğrulanmış bir ürün önerisi çıkarılamadı.</p>}</div>
    <Points title="Netleştirilmesi gerekenler" items={analysis.uncertainties} />
    {analysis.evidence.length > 0 && <div><h3 className="mb-3 text-sm font-semibold">Görüşmeden dayanaklar</h3><div className="space-y-2">{analysis.evidence.map((item, index) => <blockquote key={index} className="border-l-2 border-primary/40 pl-3 text-sm italic leading-relaxed">“{item.text}”{item.startSeconds !== null && <button type="button" className="ml-2 text-xs font-medium not-italic text-primary" onClick={() => onSeek(item.startSeconds)}>{seconds(item.startSeconds)}</button>}</blockquote>)}</div></div>}
    {detail.catalogSources?.length ? <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">Kaynak dokümanlar ({detail.catalogSources.length})</summary><div className="mt-3 space-y-3">{detail.catalogSources.map((source) => <div key={source.id} className="rounded-md bg-muted/30 p-3"><p className="text-xs font-semibold">{source.id} · {source.title ?? decodeURIComponent(source.uri.split("/").at(-1) ?? "Doküman")}{source.page && ` · PDF sayfa ${source.page}`}{source.version && ` · ${source.version}`}</p><p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">{source.text}</p></div>)}</div></details> : null}
    <p className="border-t pt-3 text-xs leading-relaxed text-muted-foreground">Bu değerlendirme otomatik transkripsiyon ve yapay zekâ yorumuna dayanır. Ürün, fiyat ve satış taahhütlerini görüşme ve güncel katalogla doğrulayın.</p>
  </div>;
}
