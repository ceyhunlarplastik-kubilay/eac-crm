"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { signOut } from "next-auth/react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  XAxis,
  YAxis
} from "recharts";
import {
  Building2,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Download,
  Filter,
  Loader2,
  LogOut,
  Plus,
  RefreshCcw,
  Save,
  Search,
  Tags,
  Trash2,
  Upload
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig
} from "@/components/ui/chart";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle
} from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { CategoryManager, type ManagedCategory } from "@/components/category-manager";
import {
  deriveSampleStatus as deriveRuleSampleStatus,
  type SampleStatus
} from "@/lib/customer-rules";
import { cn, toDateInputValue } from "@/lib/utils";

type Customer = {
  id: string;
  sequenceNumber: number | null;
  companyName: string;
  website: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  category: string | null;
  categoryId: string | null;
  contactName: string | null;
  mobilePhone: string | null;
  reached: "REACHED" | "NOT_REACHED" | "UNKNOWN";
  callCount: number;
  lastContactedAt: string | null;
  contactDetail: string | null;
  interestStatus: "INTERESTED" | "NOT_INTERESTED" | "UNKNOWN";
  catalogSent: boolean | null;
  hasSuitableProductGroup: boolean | null;
  currentAccountInfoReceived: boolean | null;
  sampleStatus: "WILL_SEND" | "WILL_NOT_SEND" | "SENT" | "UNKNOWN";
  shipmentDate: string | null;
  updatedByName: string | null;
  updatedByEmail: string | null;
  updatedAt: string;
  contacts?: ContactEntry[];
};

type ContactEntry = {
  id: string;
  contactedAt: string;
  note: string | null;
  actorName: string | null;
  actorEmail: string | null;
  createdAt: string;
};

type Stats = {
  totals: {
    customers: number;
    reached: number;
    interested: number;
    catalogSent: number;
    samplesToSend: number;
    samplesSent: number;
    activityCount: number;
    touchedCustomers: number;
  };
  byCity: Array<{ city: string; count: number }>;
  workByDay: Array<{ date: string; count: number }>;
  workByActor: Array<{ actor: string; count: number }>;
  recentActivity: Array<{
    id: string;
    action: string;
    summary: string;
    actorEmail: string | null;
    actorName: string | null;
    createdAt: string;
  }>;
};

type Option = {
  value: string;
  label: string;
};

type CategoryOption = { id: string; name: string; customerCount?: number };

type FilterOptions = {
  cities: string[];
  categories: string[];
  categoryOptions: CategoryOption[];
  reached: Option[];
  interestStatus: Option[];
  boolean: Option[];
  sampleStatus: Option[];
  pageSizes: number[];
};

type Pagination = {
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
};

type ImportRowPayload = Record<string, unknown>;

type ImportResult = {
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  skipped?: Array<{ rowNumber: number; reason: string }>;
};

type ImportStartResult = {
  importBatchId: string;
  totalRows: number;
  rows: ImportRowPayload[];
  skippedCount: number;
  skipped?: Array<{ rowNumber: number; reason: string }>;
};

type CustomerFilters = {
  city: string;
  category: string;
  reached: string;
  interestStatus: string;
  catalogSent: string;
  hasSuitableProductGroup: string;
  currentAccountInfoReceived: string;
  sampleStatus: string;
  callCountMin: string;
  callCountMax: string;
  dateField: "lastContactedAt" | "updatedAt" | "createdAt" | "shipmentDate";
  dateFrom: string;
  dateTo: string;
};

type FormState = {
  sequenceNumber: string;
  companyName: string;
  website: string;
  email: string;
  phone: string;
  city: string;
  categoryId: string;
  contactName: string;
  mobilePhone: string;
  reached: Customer["reached"];
  callCount: string;
  lastContactedAt: string;
  contactDetail: string;
  interestStatus: Customer["interestStatus"];
  catalogSent: string;
  hasSuitableProductGroup: string;
  currentAccountInfoReceived: string;
  sampleStatus: Customer["sampleStatus"];
  shipmentDate: string;
};

const emptyForm: FormState = {
  sequenceNumber: "",
  companyName: "",
  website: "",
  email: "",
  phone: "",
  city: "",
  categoryId: "",
  contactName: "",
  mobilePhone: "",
  reached: "UNKNOWN",
  callCount: "0",
  lastContactedAt: "",
  contactDetail: "",
  interestStatus: "UNKNOWN",
  catalogSent: "unknown",
  hasSuitableProductGroup: "unknown",
  currentAccountInfoReceived: "unknown",
  sampleStatus: "UNKNOWN",
  shipmentDate: ""
};

const emptyFilters: CustomerFilters = {
  city: "all",
  category: "all",
  reached: "all",
  interestStatus: "all",
  catalogSent: "all",
  hasSuitableProductGroup: "all",
  currentAccountInfoReceived: "all",
  sampleStatus: "all",
  callCountMin: "",
  callCountMax: "",
  dateField: "lastContactedAt",
  dateFrom: "",
  dateTo: ""
};

const dailyWorkChartConfig = {
  count: {
    label: "İşlem",
    color: "var(--chart-1)"
  }
} satisfies ChartConfig;

const cityChartConfig = {
  count: {
    label: "Müşteri",
    color: "var(--chart-2)"
  }
} satisfies ChartConfig;

const IMPORT_CHUNK_SIZE = 100;
const CONTACT_DETAIL_TEMPLATES = [
  "Katalog İletildi",
  "Uygun ürün grubu yok",
  "Firma kapanmış",
  "Mail olarak gönderildi",
  "Ulaşılamadı"
];

const defaultFilterOptions: FilterOptions = {
  cities: [],
  categories: [],
  categoryOptions: [],
  reached: [],
  interestStatus: [],
  boolean: [],
  sampleStatus: [],
  pageSizes: [10, 25, 50, 100]
};

function localDateTimeInput(date: Date) {
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16);
}

function toIsoDateParam(value: string) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function deriveFormSampleStatus(
  form: Pick<FormState, "hasSuitableProductGroup" | "shipmentDate">
): SampleStatus {
  return deriveRuleSampleStatus({
    hasSuitableProductGroup: selectToBoolean(form.hasSuitableProductGroup),
    shipmentDate: form.shipmentDate || null
  });
}

function applyFormAutomation(form: FormState): FormState {
  return {
    ...form,
    sampleStatus: deriveFormSampleStatus(form)
  };
}

function sampleAutomationToast(
  key: keyof FormState,
  previous: FormState,
  next: FormState,
  attemptedSampleStatus?: FormState["sampleStatus"]
) {
  const sampleStatus = deriveFormSampleStatus(next);

  if (key === "sampleStatus" && attemptedSampleStatus !== sampleStatus) {
    return {
      type: "warning" as const,
      title: "Numune durumu otomatik hesaplanıyor",
      description: `Excel formülüne göre Numune alanı ${sampleLabel(sampleStatus)} olarak tutuldu.`
    };
  }

  if (key === "shipmentDate" && previous.shipmentDate !== next.shipmentDate) {
    if (next.shipmentDate) {
      return {
        type: "info" as const,
        title: "Numune durumu güncellendi",
        description: "Gönderim tarihi girildiği için Numune Gönderildi olarak işaretlendi."
      };
    }

    if (previous.sampleStatus !== sampleStatus) {
      return {
        type: "info" as const,
        title: "Numune durumu güncellendi",
        description: `Gönderim tarihi kaldırıldı; Numune ${sampleLabel(sampleStatus)} olarak güncellendi.`
      };
    }
  }

  if (
    key === "hasSuitableProductGroup" &&
    previous.hasSuitableProductGroup !== next.hasSuitableProductGroup
  ) {
    if (next.shipmentDate) {
      return {
        type: "warning" as const,
        title: "Gönderim tarihi öncelikli",
        description: "Gönderim tarihi dolu olduğu için Numune Gönderildi olarak kalıyor."
      };
    }

    if (previous.sampleStatus !== sampleStatus) {
      return {
        type: "info" as const,
        title: "Numune durumu güncellendi",
        description: `Uygun Ürün seçimine göre Numune ${sampleLabel(sampleStatus)} olarak işaretlendi.`
      };
    }
  }

  return null;
}

function customerToForm(customer: Customer): FormState {
  return {
    sequenceNumber: customer.sequenceNumber?.toString() ?? "",
    companyName: customer.companyName,
    website: customer.website ?? "",
    email: customer.email ?? "",
    phone: customer.phone ?? "",
    city: customer.city ?? "",
    categoryId: customer.categoryId ?? "",
    contactName: customer.contactName ?? "",
    mobilePhone: customer.mobilePhone ?? "",
    reached: customer.reached,
    callCount: customer.callCount.toString(),
    lastContactedAt: toDateInputValue(customer.lastContactedAt),
    contactDetail: customer.contactDetail ?? "",
    interestStatus: customer.interestStatus,
    catalogSent: booleanToSelect(customer.catalogSent),
    hasSuitableProductGroup: booleanToSelect(customer.hasSuitableProductGroup),
    currentAccountInfoReceived: booleanToSelect(customer.currentAccountInfoReceived),
    sampleStatus: customer.sampleStatus,
    shipmentDate: toDateInputValue(customer.shipmentDate)
  };
}

function booleanToSelect(value: boolean | null) {
  if (value === true) return "true";
  if (value === false) return "false";
  return "unknown";
}

function selectToBoolean(value: string) {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function optionalString(value: string) {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function optionalNumber(value: string) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function formToPayload(form: FormState) {
  return {
    sequenceNumber: optionalNumber(form.sequenceNumber),
    companyName: form.companyName.trim(),
    website: optionalString(form.website),
    email: optionalString(form.email),
    phone: optionalString(form.phone),
    city: optionalString(form.city),
    categoryId: form.categoryId || null,
    contactName: optionalString(form.contactName),
    mobilePhone: optionalString(form.mobilePhone),
    reached: form.reached,
    callCount: Number.parseInt(form.callCount, 10) || 0,
    lastContactedAt: form.lastContactedAt ? new Date(form.lastContactedAt).toISOString() : null,
    contactDetail: optionalString(form.contactDetail),
    interestStatus: form.interestStatus,
    catalogSent: selectToBoolean(form.catalogSent),
    hasSuitableProductGroup: selectToBoolean(form.hasSuitableProductGroup),
    currentAccountInfoReceived: selectToBoolean(form.currentAccountInfoReceived),
    sampleStatus: deriveFormSampleStatus(form),
    shipmentDate: form.shipmentDate ? new Date(form.shipmentDate).toISOString() : null
  };
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  let data: unknown = null;

  if (body && (contentType.includes("application/json") || /^[\[{]/.test(body.trim()))) {
    try {
      data = JSON.parse(body);
    } catch {
      throw new Error("Sunucudan geçersiz JSON yanıtı geldi.");
    }
  }

  if (!response.ok) {
    const error =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : response.status === 504
          ? "İstek zaman aşımına uğradı. HTTP 504"
        : `İstek tamamlanamadı. HTTP ${response.status}`;
    throw new Error(error);
  }

  if (!data) {
    throw new Error("Sunucu beklenen JSON yanıtını döndürmedi.");
  }

  return data as T;
}

const statusBadgeClassNames = {
  success: "border-emerald-200 bg-emerald-50 text-emerald-700",
  danger: "border-rose-200 bg-rose-50 text-rose-700",
  warning: "border-amber-200 bg-amber-50 text-amber-800",
  info: "border-sky-200 bg-sky-50 text-sky-700",
  neutral: "border-slate-200 bg-slate-100 text-slate-600"
};

function reachBadge(status: Customer["reached"]) {
  if (status === "REACHED") {
    return <Badge className={statusBadgeClassNames.success}>Ulaşıldı</Badge>;
  }
  if (status === "NOT_REACHED") {
    return <Badge className={statusBadgeClassNames.danger}>Ulaşılamadı</Badge>;
  }
  return <Badge className={statusBadgeClassNames.neutral}>Belirsiz</Badge>;
}

function interestBadge(status: Customer["interestStatus"]) {
  if (status === "INTERESTED") {
    return <Badge className={statusBadgeClassNames.info}>İlgilendi</Badge>;
  }
  if (status === "NOT_INTERESTED") {
    return <Badge className={statusBadgeClassNames.danger}>İlgilenmedi</Badge>;
  }
  return <Badge className={statusBadgeClassNames.neutral}>Belirsiz</Badge>;
}

function sampleLabel(status: Customer["sampleStatus"]) {
  if (status === "WILL_SEND") return "Gönderilecek";
  if (status === "WILL_NOT_SEND") return "Gönderilmeyecek";
  if (status === "SENT") return "Gönderildi";
  return "Belirsiz";
}

function sampleBadge(status: Customer["sampleStatus"]) {
  if (status === "SENT") {
    return <Badge className={statusBadgeClassNames.success}>Gönderildi</Badge>;
  }
  if (status === "WILL_SEND") {
    return <Badge className={statusBadgeClassNames.warning}>Gönderilecek</Badge>;
  }
  if (status === "WILL_NOT_SEND") {
    return <Badge className={statusBadgeClassNames.neutral}>Gönderilmeyecek</Badge>;
  }
  return <Badge className={statusBadgeClassNames.neutral}>Belirsiz</Badge>;
}

function callCountBadge(count: number) {
  const className =
    count > 0
      ? "border-teal-200 bg-teal-50 text-teal-700"
      : statusBadgeClassNames.neutral;

  return <Badge className={className}>{count.toLocaleString("tr-TR")}</Badge>;
}

function recentContactDates(customer: Customer) {
  const contactDates = (customer.contacts ?? [])
    .map((contact) => contact.contactedAt)
    .filter(Boolean)
    .slice(0, 2);

  if (contactDates.length > 0) return contactDates;
  return customer.lastContactedAt ? [customer.lastContactedAt] : [];
}

function recentContactDateBadges(customer: Customer) {
  const dates = recentContactDates(customer);

  if (!dates.length) {
    return <Badge className={statusBadgeClassNames.neutral}>Yok</Badge>;
  }

  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      {dates.map((date, index) => (
        <Badge
          key={`${customer.id}-${date}-${index}`}
          className={
            index === 0
              ? "whitespace-nowrap border-teal-200 bg-teal-50 text-[11px] text-teal-700"
              : "whitespace-nowrap border-sky-200 bg-sky-50 text-[11px] text-sky-700"
          }
        >
          {formatDate(date)}
        </Badge>
      ))}
    </div>
  );
}

function contactDetailPreview(detail: string | null) {
  if (!detail) {
    return <span className="text-xs text-muted-foreground">Yok</span>;
  }

  return (
    <span className="block max-w-56 truncate text-xs text-foreground" title={detail}>
      {detail}
    </span>
  );
}

function formatDate(value: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(new Date(value));
}

function formatDateTime(value: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

export function DashboardShell({
  user
}: {
  user: { name: string; email: string };
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [filterOptions, setFilterOptions] =
    useState<FilterOptions>(defaultFilterOptions);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<CustomerFilters>(emptyFilters);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    pageSize: 25,
    total: 0,
    pageCount: 1
  });
  const [selected, setSelected] = useState<Customer | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [customerDrawerOpen, setCustomerDrawerOpen] = useState(false);
  const [activityDrawerOpen, setActivityDrawerOpen] = useState(false);
  const [newCustomerDialogOpen, setNewCustomerDialogOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exportingReport, setExportingReport] = useState(false);
  const [addingContact, setAddingContact] = useState(false);
  const [deletingContactId, setDeletingContactId] = useState<string | null>(null);
  const [newContactDate, setNewContactDate] = useState("");
  const [rangeStart, setRangeStart] = useState(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return localDateTimeInput(start);
  });
  const [rangeEnd, setRangeEnd] = useState(() => localDateTimeInput(new Date()));

  const activeFilterCount = useMemo(
    () => {
      const selectFilterCount = [
        filters.city,
        filters.category,
        filters.reached,
        filters.interestStatus,
        filters.catalogSent,
        filters.hasSuitableProductGroup,
        filters.currentAccountInfoReceived,
        filters.sampleStatus
      ].filter((value) => value !== "all").length;
      const dateFilterCount = filters.dateFrom || filters.dateTo ? 1 : 0;
      const callCountFilterCount = filters.callCountMin || filters.callCountMax ? 1 : 0;
      return (
        selectFilterCount +
        dateFilterCount +
        callCountFilterCount +
        (query.trim() ? 1 : 0)
      );
    },
    [filters, query]
  );

  function appendCustomerFilters(
    params: URLSearchParams,
    sourceFilters = filters,
    sourceQuery = query
  ) {
    if (sourceQuery.trim()) params.set("q", sourceQuery.trim());

    for (const [key, value] of Object.entries(sourceFilters)) {
      if (!value || value === "all") continue;
      if (key === "dateField" && !sourceFilters.dateFrom && !sourceFilters.dateTo) {
        continue;
      }
      params.set(key === "category" ? "categoryId" : key, value);
    }
  }

  async function loadFilters() {
    const [data, catalog] = await Promise.all([
      fetchJson<FilterOptions>("/api/customers/filters"),
      fetchJson<{ categories: CategoryOption[] }>("/api/categories")
    ]);
    setFilterOptions(data);
    setCategories(catalog.categories);
  }

  function selectCategory(categoryId: string) {
    setForm((current) => ({ ...current, categoryId }));
  }

  async function createCategory(name: string, selectNewCategory = true) {
    setCreatingCategory(true);
    try {
      const { category } = await fetchJson<{ category: CategoryOption }>("/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
      setCategories((current) => [...current.filter((item) => item.id !== category.id), category]
        .sort((a, b) => a.name.localeCompare(b.name, "tr-TR")));
      if (selectNewCategory) setForm((current) => ({ ...current, categoryId: category.id }));
      toast.success(selectNewCategory ? "Kategori oluşturuldu ve seçildi" : "Kategori oluşturuldu");
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Kategori oluşturulamadı.");
      return false;
    } finally {
      setCreatingCategory(false);
    }
  }

  async function renameCategory(id: string, name: string) {
    try {
      const { category } = await fetchJson<{ category: CategoryOption }>(`/api/categories/${encodeURIComponent(id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name })
      });
      setCategories((current) => current.map((item) => item.id === id ? category : item)
        .sort((a, b) => a.name.localeCompare(b.name, "tr-TR")));
      setFilterOptions((current) => ({ ...current,
        categoryOptions: current.categoryOptions.map((item) => item.id === id ? category : item)
          .sort((a, b) => a.name.localeCompare(b.name, "tr-TR"))
      }));
      setCustomers((current) => current.map((item) => item.categoryId === id ? { ...item, category: name } : item));
      setSelected((current) => current?.categoryId === id ? { ...current, category: name } : current);
      toast.success("Kategori adı güncellendi");
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Kategori güncellenemedi.");
      return false;
    }
  }

  async function deleteCategory(category: ManagedCategory) {
    if (!window.confirm(`${category.name} kategorisi silinsin mi?`)) return false;
    try {
      await fetchJson(`/api/categories/${encodeURIComponent(category.id)}`, { method: "DELETE" });
      setCategories((current) => current.filter((item) => item.id !== category.id));
      setForm((current) => current.categoryId === category.id ? { ...current, categoryId: "" } : current);
      toast.success("Kategori silindi");
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Kategori silinemedi.");
      return false;
    }
  }

  async function loadCustomers(
    nextPage = pagination.page,
    nextPageSize = pagination.pageSize,
    sourceFilters = filters,
    sourceQuery = query
  ) {
    const params = new URLSearchParams();
    appendCustomerFilters(params, sourceFilters, sourceQuery);
    params.set("page", String(nextPage));
    params.set("pageSize", String(nextPageSize));

    const data = await fetchJson<{ customers: Customer[]; pagination: Pagination }>(
      `/api/customers?${params.toString()}`
    );
    setCustomers(data.customers);
    setPagination(data.pagination);
  }

  async function loadStats(sourceFilters = filters, sourceQuery = query) {
    const params = new URLSearchParams();
    const start = toIsoDateParam(rangeStart);
    const end = toIsoDateParam(rangeEnd);
    if (start) params.set("start", start);
    if (end) params.set("end", end);
    appendCustomerFilters(params, sourceFilters, sourceQuery);
    const data = await fetchJson<Stats>(`/api/stats?${params.toString()}`);
    setStats(data);
  }

  async function refresh(
    nextPage = pagination.page,
    nextPageSize = pagination.pageSize,
    sourceFilters = filters,
    sourceQuery = query
  ) {
    setLoading(true);
    try {
      await Promise.all([
        loadCustomers(nextPage, nextPageSize, sourceFilters, sourceQuery),
        loadStats(sourceFilters, sourceQuery)
      ]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        await Promise.all([loadFilters(), loadCustomers(1), loadStats()]);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function updateFilter<K extends keyof CustomerFilters>(key: K, value: CustomerFilters[K]) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  async function applyFilters(openActivityDrawer = false) {
    await refresh(1, pagination.pageSize);
    if (openActivityDrawer) setActivityDrawerOpen(true);
  }

  async function refreshActivityStats() {
    setLoading(true);
    try {
      await loadStats();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "İşlem istatistikleri güncellenemedi."
      );
    } finally {
      setLoading(false);
    }
  }

  async function clearFilters() {
    const nextFilters = emptyFilters;
    const nextQuery = "";
    setQuery("");
    setFilters(nextFilters);
    setPagination((current) => ({ ...current, page: 1 }));
    setLoading(true);
    try {
      await Promise.all([
        loadCustomers(1, pagination.pageSize, nextFilters, nextQuery),
        loadStats(nextFilters, nextQuery)
      ]);
    } finally {
      setLoading(false);
    }
  }

  function updateForm<K extends keyof FormState>(key: K, value: FormState[K]) {
    const nextForm = applyFormAutomation({ ...form, [key]: value });
    const feedback = sampleAutomationToast(
      key,
      form,
      nextForm,
      key === "sampleStatus" ? (value as FormState["sampleStatus"]) : undefined
    );

    setForm(nextForm);

    if (feedback?.type === "warning") {
      toast.warning(feedback.title, { description: feedback.description });
    } else if (feedback) {
      toast.info(feedback.title, { description: feedback.description });
    }
  }

  function applyCustomerUpdate(customer: Customer) {
    setSelected(customer);
    setForm(applyFormAutomation(customerToForm(customer)));
    setCustomers((current) =>
      current.map((item) => (item.id === customer.id ? customer : item))
    );
  }

  async function addCustomerContact() {
    if (!selected) return;
    if (!newContactDate) {
      toast.error("Görüşme tarihi seçilmedi.");
      return;
    }

    setAddingContact(true);
    try {
      const data = await fetchJson<{ customer: Customer }>(
        `/api/customers/${selected.id}/contacts`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contactedAt: newContactDate,
            note: optionalString(form.contactDetail)
          })
        }
      );

      applyCustomerUpdate(data.customer);
      setNewContactDate("");
      toast.success("Görüşme tarihi eklendi");
      await loadStats();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Görüşme tarihi eklenemedi."
      );
    } finally {
      setAddingContact(false);
    }
  }

  async function deleteCustomerContact(contact: ContactEntry) {
    if (!selected) return;

    const confirmed = window.confirm(
      `${formatDate(contact.contactedAt)} görüşme tarihi silinsin mi?`
    );
    if (!confirmed) return;

    setDeletingContactId(contact.id);
    try {
      const data = await fetchJson<{ customer: Customer }>(
        `/api/customers/${encodeURIComponent(selected.id)}/contacts/${encodeURIComponent(contact.id)}`,
        { method: "DELETE" }
      );

      applyCustomerUpdate(data.customer);
      toast.success("Görüşme tarihi silindi");
      await loadStats();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Görüşme tarihi silinemedi."
      );
    } finally {
      setDeletingContactId(null);
    }
  }

  async function submitCustomer(
    event: React.FormEvent<HTMLFormElement>,
    mode: "create" | "update"
  ) {
    event.preventDefault();
    if (mode === "update" && !selected) return;
    setSaving(true);

    try {
      const payload = formToPayload(form);
      const url = mode === "update" ? `/api/customers/${selected?.id}` : "/api/customers";
      const method = mode === "update" ? "PATCH" : "POST";

      const data = await fetchJson<{ customer: Customer }>(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      toast.success(mode === "update" ? "Müşteri güncellendi" : "Müşteri oluşturuldu");
      setSelected(data.customer);
      setForm(applyFormAutomation(customerToForm(data.customer)));
      if (mode === "create") {
        setNewCustomerDialogOpen(false);
        setForm(emptyForm);
      }
      await loadFilters();
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Kayıt tamamlanamadı.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteCustomer() {
    if (!selected) return;
    const confirmed = window.confirm(`${selected.companyName} kaydı silinsin mi?`);
    if (!confirmed) return;

    setSaving(true);
    try {
      await fetchJson(`/api/customers/${selected.id}`, { method: "DELETE" });
      toast.success("Müşteri silindi");
      setSelected(null);
      setForm(emptyForm);
      setCustomerDrawerOpen(false);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Silme tamamlanamadı.");
    } finally {
      setSaving(false);
    }
  }

  async function importExcel(file: File) {
    setImporting(true);
    const importToastId = "excel-import";
    try {
      toast.loading("Excel dosyası okunuyor", {
        id: importToastId,
        description: "Satırlar import için hazırlanıyor."
      });

      const formData = new FormData();
      formData.append("file", file);
      const startResult = await fetchJson<ImportStartResult>("/api/customers/import", {
        method: "POST",
        body: formData
      });

      let createdCount = 0;
      let updatedCount = 0;
      let skippedCount = startResult.skippedCount;
      const skipped = [...(startResult.skipped ?? [])];
      const rowCount = startResult.rows.length;

      for (let index = 0; index < rowCount; index += IMPORT_CHUNK_SIZE) {
        const chunk = startResult.rows.slice(index, index + IMPORT_CHUNK_SIZE);
        const processed = Math.min(index + chunk.length, rowCount);

        toast.loading("Excel import devam ediyor", {
          id: importToastId,
          description: `${processed.toLocaleString("tr-TR")} / ${rowCount.toLocaleString("tr-TR")} satır işleniyor.`
        });

        const chunkResult = await fetchJson<ImportResult>("/api/customers/import/chunk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            importBatchId: startResult.importBatchId,
            rows: chunk
          })
        });

        createdCount += chunkResult.createdCount;
        updatedCount += chunkResult.updatedCount;
        skippedCount += chunkResult.skippedCount;
        skipped.push(...(chunkResult.skipped ?? []));
      }

      const skippedPreview = skipped
        .slice(0, 3)
        .map((item) => `${item.rowNumber}. satır: ${item.reason}`)
        .join(" | ");

      const toastOptions = {
        id: importToastId,
        description: skippedPreview
          ? `${createdCount} yeni, ${updatedCount} güncel, ${skippedCount} atlandı. ${skippedPreview}`
          : `${createdCount} yeni, ${updatedCount} güncel, ${skippedCount} atlandı.`
      };

      if (skippedCount > 0) {
        toast.warning("Excel import tamamlandı, bazı satırlar atlandı", toastOptions);
      } else {
        toast.success("Excel import tamamlandı", toastOptions);
      }
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Import tamamlanamadı.", {
        id: importToastId
      });
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function exportReport() {
    setExportingReport(true);
    try {
      const params = new URLSearchParams();
      appendCustomerFilters(params);
      const start = toIsoDateParam(rangeStart);
      const end = toIsoDateParam(rangeEnd);
      if (start) params.set("start", start);
      if (end) params.set("end", end);

      const response = await fetch(`/api/reports/customers?${params.toString()}`);
      if (!response.ok) {
        const contentType = response.headers.get("content-type") ?? "";
        const body = await response.text();
        if (contentType.includes("application/json")) {
          const data = JSON.parse(body) as { error?: string };
          throw new Error(data.error ?? "Rapor indirilemedi.");
        }
        throw new Error(`Rapor indirilemedi. HTTP ${response.status}`);
      }

      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const filename =
        disposition.match(/filename="([^"]+)"/)?.[1] ??
        `eaparat-crm-rapor-${new Date().toISOString().slice(0, 10)}.xlsx`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast.success("Rapor indirildi");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Rapor indirilemedi.");
    } finally {
      setExportingReport(false);
    }
  }

  return (
    <main className="min-h-screen px-4 py-5 lg:px-6">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className="mx-auto flex max-w-[1500px] flex-col gap-5"
      >
        <header className="flex flex-col gap-3 border-b pb-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <Building2 className="h-5 w-5" />
              </div>
              <h1 className="text-2xl font-semibold tracking-normal">EAPARAT CRM</h1>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{user.name} · {user.email}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => void refresh()} disabled={loading}>
              <RefreshCcw className={loading ? "animate-spin" : ""} />
              Yenile
            </Button>
            <Button variant="ghost" onClick={() => signOut()}>
              <LogOut />
              Çıkış
            </Button>
          </div>
        </header>

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-7">
          <MetricCard label="Müşteri" value={stats?.totals.customers ?? 0} />
          <MetricCard label="Ulaşıldı" value={stats?.totals.reached ?? 0} />
          <MetricCard label="İlgilendi" value={stats?.totals.interested ?? 0} />
          <MetricCard label="Katalog" value={stats?.totals.catalogSent ?? 0} />
          <MetricCard label="Numune" value={stats?.totals.samplesToSend ?? 0} />
          <MetricCard label="Gönderildi" value={stats?.totals.samplesSent ?? 0} />
          <MetricCard label="İşlem" value={stats?.totals.activityCount ?? 0} />
        </section>

        <section className="flex min-w-0 flex-col gap-5">
          <Card>
            <CardHeader>
              <CardTitle>Şehir Dağılımı</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer config={cityChartConfig} className="h-72 w-full">
                <BarChart
                  accessibilityLayer
                  data={stats?.byCity ?? []}
                  layout="vertical"
                  margin={{ left: 18 }}
                >
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" allowDecimals={false} />
                  <YAxis dataKey="city" type="category" width={88} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="count" fill="var(--color-count)" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ChartContainer>
            </CardContent>
          </Card>

          <section className="rounded-lg border bg-card">
              <div className="space-y-3 border-b p-4">
                <div className="flex flex-col gap-2 xl:flex-row xl:items-center">
                  <div className="relative min-w-0 flex-1">
                    <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      className="h-11 pl-9 text-base"
                      placeholder="Firma, şehir, kişi, email veya telefon"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void applyFilters();
                      }}
                    />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" onClick={() => void applyFilters(true)}>
                    <Search />
                    Ara
                  </Button>
	                    <Button variant="ghost" onClick={() => void clearFilters()}>
	                      <Filter />
	                      Temizle
	                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => void exportReport()}
                      disabled={exportingReport}
                    >
                      {exportingReport ? <Loader2 className="animate-spin" /> : <Download />}
                      Rapor
                    </Button>
	                  <input
	                    ref={fileInputRef}
                    className="hidden"
                    type="file"
                    accept=".xlsx,.xls"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void importExcel(file);
                    }}
                  />
                  <Button
                    variant="outline"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={importing}
                  >
                    {importing ? <Loader2 className="animate-spin" /> : <Upload />}
                    Excel
                  </Button>
                  <Button variant="outline" onClick={() => {
                    void loadFilters().then(() => setCategoryManagerOpen(true)).catch((error) => {
                      toast.error(error instanceof Error ? error.message : "Kategoriler yüklenemedi.");
                    });
                  }}>
                    <Tags /> Kategoriler
                  </Button>
                  <Button
                    onClick={() => {
                      setSelected(null);
                      setForm(emptyForm);
                      setNewContactDate("");
                      setNewCustomerDialogOpen(true);
                    }}
                  >
                    <Plus />
                    Yeni
                  </Button>
                  </div>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
                  <SelectField
                    label="Şehir"
                    value={filters.city}
                    onValueChange={(value) => updateFilter("city", value)}
                    options={filterOptions.cities.map((cityName) => ({
                      value: cityName,
                      label: cityName
                    }))}
                  />
                  <SelectField
                    label="Kategori"
                    value={filters.category}
                    onValueChange={(value) => updateFilter("category", value)}
                    options={filterOptions.categoryOptions.map((category) => ({
                      value: category.id,
                      label: category.name || "(Boş kategori adı)"
                    }))}
                  />
                  <SelectField
                    label="Ulaşıldı"
                    value={filters.reached}
                    onValueChange={(value) => updateFilter("reached", value)}
                    options={filterOptions.reached}
                  />
                  <SelectField
                    label="Durum"
                    value={filters.interestStatus}
                    onValueChange={(value) => updateFilter("interestStatus", value)}
                    options={filterOptions.interestStatus}
                  />
                  <SelectField
                    label="Katalog"
                    value={filters.catalogSent}
                    onValueChange={(value) => updateFilter("catalogSent", value)}
                    options={filterOptions.boolean}
                  />
                  <SelectField
                    label="Uygun Ürün"
                    value={filters.hasSuitableProductGroup}
                    onValueChange={(value) =>
                      updateFilter("hasSuitableProductGroup", value)
                    }
                    options={filterOptions.boolean}
                  />
                  <SelectField
                    label="Cari"
                    value={filters.currentAccountInfoReceived}
                    onValueChange={(value) =>
                      updateFilter("currentAccountInfoReceived", value)
                    }
                    options={filterOptions.boolean}
                  />
                  <SelectField
                    label="Numune"
                    value={filters.sampleStatus}
                    onValueChange={(value) => updateFilter("sampleStatus", value)}
                    options={filterOptions.sampleStatus}
                  />
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                  <SelectField
                    label="Tarih alanı"
                    value={filters.dateField}
                    onValueChange={(value) =>
                      updateFilter(
                        "dateField",
                        value as CustomerFilters["dateField"]
                      )
                    }
                    options={[
                      { value: "lastContactedAt", label: "Görüşme tarihi" },
                      { value: "updatedAt", label: "Son işlem" },
                      { value: "createdAt", label: "Oluşturma" },
                      { value: "shipmentDate", label: "Gönderim tarihi" }
                    ]}
                    includeAll={false}
                  />
                  <div>
	                    <Label className="mb-1 block">Başlangıç</Label>
	                    <Input
	                      type="datetime-local"
	                      value={filters.dateFrom}
	                      onChange={(event) => updateFilter("dateFrom", event.target.value)}
	                    />
                  </div>
                  <div>
	                    <Label className="mb-1 block">Bitiş</Label>
	                    <Input
	                      type="datetime-local"
	                      value={filters.dateTo}
	                      onChange={(event) => updateFilter("dateTo", event.target.value)}
	                    />
                  </div>
                  <div>
                    <Label className="mb-1 block">Görüşme min</Label>
                    <Input
                      type="number"
                      min="0"
                      inputMode="numeric"
                      value={filters.callCountMin}
                      onChange={(event) =>
                        updateFilter("callCountMin", event.target.value)
                      }
                    />
                  </div>
                  <div>
                    <Label className="mb-1 block">Görüşme max</Label>
                    <Input
                      type="number"
                      min="0"
                      inputMode="numeric"
                      value={filters.callCountMax}
                      onChange={(event) =>
                        updateFilter("callCountMax", event.target.value)
                      }
                    />
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>
                    {activeFilterCount
                      ? `${activeFilterCount} filtre aktif`
                      : "Tüm müşteriler listeleniyor"}
                  </span>
                  <span>
                    {pagination.total.toLocaleString("tr-TR")} kayıt
                  </span>
                </div>
              </div>

              <Table className="min-w-[920px] table-fixed text-xs [&_td]:px-1.5 [&_td]:py-1.5 [&_th]:px-1.5">
                <TableHeader className="bg-muted/70">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-12 whitespace-nowrap text-center">Sıra</TableHead>
                    <TableHead className="w-[28%] whitespace-nowrap">Firma / İletişim</TableHead>
                    <TableHead className="w-24 whitespace-nowrap">Durum</TableHead>
                    <TableHead className="w-14 whitespace-nowrap text-center">Görüşme</TableHead>
                    <TableHead className="w-28 whitespace-nowrap">Son görüşmeler</TableHead>
                    <TableHead className="w-24 whitespace-nowrap">İlgilenme</TableHead>
                    <TableHead className="w-28 whitespace-nowrap">Numune</TableHead>
                    <TableHead className="w-[22%] whitespace-nowrap">Görüşme detayı</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {customers.map((customer, index) => (
                    <TableRow
                      key={customer.id}
                      data-state={selected?.id === customer.id ? "selected" : undefined}
                      className={cn(
                        "cursor-pointer border-border/70 odd:bg-white even:bg-slate-50/70",
                        "hover:bg-teal-50/80 data-[state=selected]:bg-teal-50",
                        "data-[state=selected]:shadow-[inset_3px_0_0_var(--primary)]"
                      )}
                    onClick={() => {
                      setSelected(customer);
                      setForm(applyFormAutomation(customerToForm(customer)));
                      setNewContactDate("");
                      setCustomerDrawerOpen(true);
                    }}
                    >
                      <TableCell className="text-center">
                        <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-md bg-muted px-2 text-xs font-semibold text-muted-foreground">
                          {((pagination.page - 1) * pagination.pageSize + index + 1).toLocaleString("tr-TR")}
                        </span>
                      </TableCell>
                      <TableCell className="min-w-0">
                        <div className="min-w-0 space-y-1">
                          <div className="truncate font-medium text-foreground">
                            {customer.companyName}
                          </div>
                          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                            <span className="inline-flex max-w-32 items-center rounded-md bg-muted/70 px-2 py-0.5 font-medium">
                              <span className="truncate">{customer.city ?? "Şehir yok"}</span>
                            </span>
                            <span className="min-w-0 truncate">
                              {customer.contactName ?? "Yetkili yok"}
                            </span>
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {customer.email ?? customer.phone ?? "-"}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>{reachBadge(customer.reached)}</TableCell>
                      <TableCell className="text-center">
                        {callCountBadge(customer.callCount)}
                      </TableCell>
                      <TableCell>{recentContactDateBadges(customer)}</TableCell>
                      <TableCell>{interestBadge(customer.interestStatus)}</TableCell>
                      <TableCell>{sampleBadge(customer.sampleStatus)}</TableCell>
                      <TableCell>{contactDetailPreview(customer.contactDetail)}</TableCell>
                    </TableRow>
                  ))}
	                  {!customers.length && (
	                    <TableRow>
	                      <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
	                        {loading ? "Yükleniyor..." : "Kayıt bulunamadı."}
	                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
              <div className="flex flex-col gap-3 border-t p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-sm text-muted-foreground">
                  {pagination.total > 0
                    ? `${((pagination.page - 1) * pagination.pageSize + 1).toLocaleString("tr-TR")} - ${Math.min(
                        pagination.page * pagination.pageSize,
                        pagination.total
                      ).toLocaleString("tr-TR")} / ${pagination.total.toLocaleString("tr-TR")}`
                    : "0 kayıt"}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="w-28">
                    <Select
                      value={String(pagination.pageSize)}
                      onValueChange={(value) => {
                        const nextPageSize = Number.parseInt(value, 10);
                        setPagination((current) => ({
                          ...current,
                          page: 1,
                          pageSize: nextPageSize
                        }));
                        void refresh(1, nextPageSize);
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {filterOptions.pageSizes.map((pageSize) => (
                          <SelectItem key={pageSize} value={String(pageSize)}>
                            {pageSize} satır
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pagination.page <= 1 || loading}
                    onClick={() => {
                      const nextPage = Math.max(pagination.page - 1, 1);
                      setPagination((current) => ({ ...current, page: nextPage }));
                      void refresh(nextPage, pagination.pageSize);
                    }}
                  >
                    <ChevronLeft />
                    Önceki
                  </Button>
                  <span className="min-w-24 text-center text-sm">
                    {pagination.page} / {pagination.pageCount}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pagination.page >= pagination.pageCount || loading}
                    onClick={() => {
                      const nextPage = Math.min(
                        pagination.page + 1,
                        pagination.pageCount
                      );
                      setPagination((current) => ({ ...current, page: nextPage }));
                      void refresh(nextPage, pagination.pageSize);
                    }}
                  >
                    Sonraki
                    <ChevronRight />
                  </Button>
                </div>
              </div>
            </section>
          </section>

        <Drawer
          direction="right"
          shouldScaleBackground={false}
          open={activityDrawerOpen}
          onOpenChange={setActivityDrawerOpen}
        >
          <DrawerContent side="right" className="sm:max-w-2xl">
            <DrawerHeader className="border-b">
              <DrawerTitle>Günlük İşlemler</DrawerTitle>
              <DrawerDescription>
                {activeFilterCount
                  ? `${activeFilterCount} filtre aktif`
                  : "Tüm müşteriler"}{" "}
                · {(stats?.totals.activityCount ?? 0).toLocaleString("tr-TR")} işlem
              </DrawerDescription>
            </DrawerHeader>
            <ActivityDrawerContent
              stats={stats}
              loading={loading}
              rangeStart={rangeStart}
              rangeEnd={rangeEnd}
              onRangeStartChange={setRangeStart}
              onRangeEndChange={setRangeEnd}
              onRefresh={() => void refreshActivityStats()}
            />
          </DrawerContent>
        </Drawer>

        <Drawer open={customerDrawerOpen} onOpenChange={setCustomerDrawerOpen}>
          <DrawerContent>
            <DrawerHeader>
              <DrawerTitle>{selected?.companyName ?? "Müşteri Kaydı"}</DrawerTitle>
              <DrawerDescription>
                {selected?.city ?? "Müşteri detayları"}
              </DrawerDescription>
            </DrawerHeader>
            <div className="overflow-y-auto px-4 pb-4 sm:px-6">
              {selected && (
                <div className="mb-4 grid gap-3 rounded-md border bg-muted/30 p-3 text-sm sm:grid-cols-2">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-muted-foreground">
                      Son işlem yapan
                    </div>
                    <div className="mt-1 truncate font-medium">
                      {selected.updatedByName ?? selected.updatedByEmail ?? "-"}
                    </div>
                    {selected.updatedByName && selected.updatedByEmail && (
                      <div className="truncate text-xs text-muted-foreground">
                        {selected.updatedByEmail}
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="text-xs font-medium text-muted-foreground">
                      Son işlem tarihi
                    </div>
                    <div className="mt-1 font-medium">{formatDateTime(selected.updatedAt)}</div>
                  </div>
                </div>
              )}
              <CustomerForm
                form={form}
                categories={categories}
                creatingCategory={creatingCategory}
                onCategorySelect={selectCategory}
                onCategoryCreate={createCategory}
                contacts={selected?.contacts ?? []}
                newContactDate={newContactDate}
                addingContact={addingContact}
                deletingContactId={deletingContactId}
                saving={saving}
                submitLabel="Kaydet"
                onSubmit={(event) => void submitCustomer(event, "update")}
                onDelete={() => void deleteCustomer()}
                onNewContactDateChange={setNewContactDate}
                onAddContact={() => void addCustomerContact()}
                onDeleteContact={(contact) => void deleteCustomerContact(contact)}
                updateForm={updateForm}
              />
              <div className="mt-3 flex justify-end">
                <DrawerClose asChild>
                  <Button type="button" variant="outline">
                    Kapat
                  </Button>
                </DrawerClose>
              </div>
            </div>
          </DrawerContent>
        </Drawer>

        <Dialog
          open={newCustomerDialogOpen}
          onOpenChange={(open) => {
            setNewCustomerDialogOpen(open);
            if (!open) setForm(emptyForm);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Yeni Müşteri</DialogTitle>
              <DialogDescription>
                Excel takip tablosundaki alanlarla uyumlu yeni müşteri kaydı.
              </DialogDescription>
            </DialogHeader>
            <CustomerForm
              form={form}
              categories={categories}
              creatingCategory={creatingCategory}
              onCategorySelect={selectCategory}
              onCategoryCreate={createCategory}
              contacts={[]}
              newContactDate=""
              addingContact={false}
              saving={saving}
              submitLabel="Oluştur"
              onSubmit={(event) => void submitCustomer(event, "create")}
              updateForm={updateForm}
            />
          </DialogContent>
        </Dialog>
        <CategoryManager
          open={categoryManagerOpen}
          onOpenChange={setCategoryManagerOpen}
          categories={categories.map((category) => ({ ...category, customerCount: category.customerCount ?? 0 }))}
          onCreate={(name) => createCategory(name, false)}
          onRename={renameCategory}
          onDelete={deleteCategory}
        />
      </motion.div>
    </main>
  );
}

function ActivityDrawerContent({
  stats,
  loading,
  rangeStart,
  rangeEnd,
  onRangeStartChange,
  onRangeEndChange,
  onRefresh
}: {
  stats: Stats | null;
  loading: boolean;
  rangeStart: string;
  rangeEnd: string;
  onRangeStartChange: (value: string) => void;
  onRangeEndChange: (value: string) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5 pt-4 sm:px-6">
      <div className="flex flex-col gap-5">
        <section className="rounded-lg border bg-card p-4">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <CalendarClock className="h-4 w-4 shrink-0 text-muted-foreground" />
              <h2 className="truncate text-base font-semibold">Günlük İşlem</h2>
            </div>
            <Badge variant="secondary">
              {(stats?.totals.touchedCustomers ?? 0).toLocaleString("tr-TR")} müşteri
            </Badge>
          </div>
          <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
            <div>
              <Label className="mb-1 block">Başlangıç</Label>
              <Input
                type="datetime-local"
                value={rangeStart}
                onChange={(event) => onRangeStartChange(event.target.value)}
              />
            </div>
            <div>
              <Label className="mb-1 block">Bitiş</Label>
              <Input
                type="datetime-local"
                value={rangeEnd}
                onChange={(event) => onRangeEndChange(event.target.value)}
              />
            </div>
            <Button
              variant="outline"
              className="self-end"
              onClick={onRefresh}
              disabled={loading}
            >
              {loading ? <Loader2 className="animate-spin" /> : <RefreshCcw />}
              Güncelle
            </Button>
          </div>
          <ChartContainer config={dailyWorkChartConfig} className="h-72 w-full">
            <BarChart accessibilityLayer data={stats?.workByDay ?? []}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="date" tickLine={false} axisLine={false} />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(value) => `Gün: ${value}`}
                  />
                }
              />
              <Bar dataKey="count" fill="var(--color-count)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ChartContainer>
        </section>

        <section className="rounded-lg border bg-card p-4">
          <h2 className="mb-3 text-base font-semibold">Kullanıcı Özeti</h2>
          <div className="space-y-2">
            {(stats?.workByActor ?? []).map((item) => (
              <div
                key={item.actor}
                className="flex items-center justify-between gap-3 rounded-md bg-muted/60 px-3 py-2"
              >
                <span className="truncate text-sm">{item.actor}</span>
                <Badge>{item.count.toLocaleString("tr-TR")}</Badge>
              </div>
            ))}
            {!stats?.workByActor.length && (
              <p className="text-sm text-muted-foreground">Seçili aralıkta işlem yok.</p>
            )}
          </div>
        </section>

        <section className="rounded-lg border bg-card p-4">
          <h2 className="mb-3 text-base font-semibold">Son İşlemler</h2>
          <div className="space-y-3">
            {(stats?.recentActivity ?? []).map((activity) => (
              <div key={activity.id} className="border-b pb-3 last:border-0 last:pb-0">
                <div className="flex items-center justify-between gap-3">
                  <Badge variant={activity.action === "DELETE" ? "destructive" : "secondary"}>
                    {activity.action}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {formatDate(activity.createdAt)}
                  </span>
                </div>
                <p className="mt-1 text-sm">{activity.summary}</p>
                <p className="text-xs text-muted-foreground">
                  {activity.actorName ?? activity.actorEmail ?? "-"}
                </p>
              </div>
            ))}
            {!stats?.recentActivity.length && (
              <p className="text-sm text-muted-foreground">Kayıt yok.</p>
            )}
          </div>
        </section>

        <div className="flex justify-end">
          <DrawerClose asChild>
            <Button type="button" variant="outline">
              Kapat
            </Button>
          </DrawerClose>
        </div>
      </div>
    </div>
  );
}

function CustomerForm({
  form,
  categories,
  creatingCategory,
  onCategorySelect,
  onCategoryCreate,
  contacts,
  newContactDate,
  addingContact,
  deletingContactId,
  saving,
  submitLabel,
  onSubmit,
  onDelete,
  onNewContactDateChange,
  onAddContact,
  onDeleteContact,
  updateForm
}: {
  form: FormState;
  categories: CategoryOption[];
  creatingCategory: boolean;
  onCategorySelect: (id: string) => void;
  onCategoryCreate: (name: string) => Promise<boolean>;
  contacts: ContactEntry[];
  newContactDate?: string;
  addingContact?: boolean;
  deletingContactId?: string | null;
  saving: boolean;
  submitLabel: string;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onDelete?: () => void;
  onNewContactDateChange?: (value: string) => void;
  onAddContact?: () => void;
  onDeleteContact?: (contact: ContactEntry) => void;
  updateForm: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
}) {
  const [newCategoryName, setNewCategoryName] = useState("");
  const [showNewCategory, setShowNewCategory] = useState(false);
  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Sıra">
          <Input
            value={form.sequenceNumber}
            onChange={(event) => updateForm("sequenceNumber", event.target.value)}
          />
        </Field>
        <Field label="Kategori">
          <div className="space-y-2">
            <Select
              value={form.categoryId || "no-category"}
              onValueChange={(value) => onCategorySelect(value === "no-category" ? "" : value)}
              disabled={saving || creatingCategory}
            >
              <SelectTrigger className="w-full"><SelectValue placeholder="Kategori seç" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="no-category">Kategori yok</SelectItem>
                {categories.map((category) => (
                  <SelectItem key={category.id} value={category.id}>
                    {category.name || "(Boş kategori adı)"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="button" variant="outline" size="sm"
              disabled={saving || creatingCategory}
              onClick={() => setShowNewCategory((current) => !current)}>
              <Plus /> Yeni kategori
            </Button>
            {showNewCategory && (
              <div className="flex gap-2">
                <Input aria-label="Yeni kategori adı" value={newCategoryName}
                  onChange={(event) => setNewCategoryName(event.target.value)}
                  disabled={creatingCategory} maxLength={1000} placeholder="Kategori adı" />
                <Button type="button" disabled={creatingCategory || !newCategoryName.trim()}
                  onClick={async () => {
                    if (await onCategoryCreate(newCategoryName)) {
                      setNewCategoryName("");
                      setShowNewCategory(false);
                    }
                  }}>
                  {creatingCategory ? <Loader2 className="animate-spin" /> : "Ekle"}
                </Button>
              </div>
            )}
          </div>
        </Field>
        <Field label="Firma" className="sm:col-span-2">
          <Input
            value={form.companyName}
            onChange={(event) => updateForm("companyName", event.target.value)}
            required
          />
        </Field>
        <Field label="Web" className="sm:col-span-2">
          <Input
            value={form.website}
            onChange={(event) => updateForm("website", event.target.value)}
          />
        </Field>
        <Field label="Email">
          <Input
            type="email"
            value={form.email}
            onChange={(event) => updateForm("email", event.target.value)}
          />
        </Field>
        <Field label="Telefon">
          <Input
            value={form.phone}
            onChange={(event) => updateForm("phone", event.target.value)}
          />
        </Field>
        <Field label="Şehir">
          <Input
            value={form.city}
            onChange={(event) => updateForm("city", event.target.value)}
          />
        </Field>
        <Field label="Yetkili">
          <Input
            value={form.contactName}
            onChange={(event) => updateForm("contactName", event.target.value)}
          />
        </Field>
        <Field label="Cep">
          <Input
            value={form.mobilePhone}
            onChange={(event) => updateForm("mobilePhone", event.target.value)}
          />
        </Field>
        <Field label="Görüşme">
          <Input
            type="number"
            min="0"
            value={form.callCount}
            onChange={(event) => updateForm("callCount", event.target.value)}
          />
        </Field>
        <Field label="Ulaşıldı">
          <Select
            value={form.reached}
            onValueChange={(value) =>
              updateForm("reached", value as Customer["reached"])
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="UNKNOWN">Belirsiz</SelectItem>
              <SelectItem value="REACHED">Evet</SelectItem>
              <SelectItem value="NOT_REACHED">Hayır</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="İlgilenme">
          <Select
            value={form.interestStatus}
            onValueChange={(value) =>
              updateForm("interestStatus", value as Customer["interestStatus"])
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="UNKNOWN">Belirsiz</SelectItem>
              <SelectItem value="INTERESTED">İlgilendi</SelectItem>
              <SelectItem value="NOT_INTERESTED">İlgilenmedi</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Son Görüşme Tarihi">
          <DateInputWithPicker
            value={form.lastContactedAt}
            onChange={(value) => updateForm("lastContactedAt", value)}
          />
        </Field>
        {onAddContact && onNewContactDateChange && (
          <div className="sm:col-span-2 rounded-md border bg-muted/30 p-3">
            <Label className="mb-2 block">Yeni Görüşme Tarihi</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <DateInputWithPicker
                value={newContactDate ?? ""}
                onChange={onNewContactDateChange}
                disabled={addingContact}
              />
              <Button
                type="button"
                onClick={onAddContact}
                disabled={saving || addingContact || !newContactDate}
              >
                {addingContact ? <Loader2 className="animate-spin" /> : <Plus />}
                Ekle
              </Button>
            </div>
          </div>
        )}
        {(contacts.length > 0 || onDeleteContact) && (
          <div className="sm:col-span-2 rounded-md border bg-muted/30 p-3">
            <div className="mb-2 text-sm font-medium">Görüşme Tarihleri</div>
            {contacts.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {contacts.map((contact) => {
                  const deleting = deletingContactId === contact.id;

                  return (
                    <div
                      key={contact.id}
                      className="inline-flex items-center overflow-hidden rounded-md border border-teal-200 bg-teal-50 text-teal-700"
                      title={contact.actorName ?? contact.actorEmail ?? undefined}
                    >
                      <span className="px-2 py-1 text-xs font-medium">
                        {formatDate(contact.contactedAt)}
                      </span>
                      {onDeleteContact && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 rounded-none border-l border-teal-200 text-teal-700 hover:bg-rose-50 hover:text-rose-700"
                          onClick={() => onDeleteContact(contact)}
                          disabled={saving || Boolean(deletingContactId)}
                          aria-label="Görüşme tarihini sil"
                        >
                          {deleting ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Kayıtlı görüşme tarihi yok.
              </p>
            )}
          </div>
        )}
        <Field label="Katalog">
          <TriSelect
            value={form.catalogSent}
            onChange={(value) => updateForm("catalogSent", value)}
          />
        </Field>
        <Field label="Uygun Ürün">
          <TriSelect
            value={form.hasSuitableProductGroup}
            onChange={(value) => updateForm("hasSuitableProductGroup", value)}
          />
        </Field>
        <Field label="Cari Bilgi">
          <TriSelect
            value={form.currentAccountInfoReceived}
            onChange={(value) => updateForm("currentAccountInfoReceived", value)}
          />
        </Field>
        <Field label="Numune">
          <Select
            value={form.sampleStatus}
            onValueChange={(value) =>
              updateForm("sampleStatus", value as Customer["sampleStatus"])
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="UNKNOWN">Belirsiz</SelectItem>
              <SelectItem value="WILL_SEND">Gönderilecek</SelectItem>
              <SelectItem value="WILL_NOT_SEND">Gönderilmeyecek</SelectItem>
              <SelectItem value="SENT">Gönderildi</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Gönderim">
          <DateInputWithPicker
            value={form.shipmentDate}
            onChange={(value) => updateForm("shipmentDate", value)}
          />
        </Field>
        <Field label="Görüşme Detayı" className="sm:col-span-2">
          <div className="mb-2 flex flex-wrap gap-2">
            {CONTACT_DETAIL_TEMPLATES.map((template) => (
              <Button
                key={template}
                type="button"
                variant={form.contactDetail === template ? "secondary" : "outline"}
                size="sm"
                onClick={() => updateForm("contactDetail", template)}
              >
                {template}
              </Button>
            ))}
          </div>
          <Textarea
            value={form.contactDetail}
            onChange={(event) => updateForm("contactDetail", event.target.value)}
          />
        </Field>
      </div>

      <div className="flex items-center justify-between gap-2">
        <Button type="submit" disabled={saving || creatingCategory}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />}
          {submitLabel}
        </Button>
        {onDelete && (
          <Button
            type="button"
            variant="destructive"
            onClick={onDelete}
            disabled={saving}
          >
            <Trash2 />
            Sil
          </Button>
        )}
      </div>
    </form>
  );
}

function MetricCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        <div className="mt-2 text-2xl font-semibold">{value.toLocaleString("tr-TR")}</div>
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  className,
  children
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <Label className="mb-1 block">{label}</Label>
      {children}
    </div>
  );
}

function DateInputWithPicker({
  value,
  onChange,
  disabled
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  function openPicker() {
    const input = inputRef.current;
    if (!input) return;

    input.focus({ preventScroll: true });

    if (typeof input.showPicker === "function") {
      try {
        input.showPicker();
        return;
      } catch {
        // Some browser/dialog combinations reject showPicker even from a click.
      }
    }

    input.click();
  }

  return (
    <div className="flex min-w-0 flex-1 gap-2">
      <Input
        ref={inputRef}
        type="date"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      <Button
        type="button"
        variant="outline"
        size="icon"
        onClick={openPicker}
        disabled={disabled}
        aria-label="Takvimi aç"
      >
        <CalendarClock />
      </Button>
    </div>
  );
}

function TriSelect({
  value,
  onChange
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="unknown">Belirsiz</SelectItem>
        <SelectItem value="true">Evet</SelectItem>
        <SelectItem value="false">Hayır</SelectItem>
      </SelectContent>
    </Select>
  );
}

function SelectField({
  label,
  value,
  onValueChange,
  options,
  includeAll = true
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: Option[];
  includeAll?: boolean;
}) {
  return (
    <div className="min-w-0">
      <Label className="mb-1 block">{label}</Label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {includeAll && <SelectItem value="all">Tümü</SelectItem>}
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
