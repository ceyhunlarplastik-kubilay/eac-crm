import type { Prisma } from "@/lib/generated/prisma/client";

const reachStatuses = ["REACHED", "NOT_REACHED", "UNKNOWN"] as const;
const interestStatuses = [
  "INTERESTED",
  "NOT_INTERESTED",
  "UNKNOWN"
] as const;
const sampleStatuses = [
  "WILL_SEND",
  "WILL_NOT_SEND",
  "SENT",
  "UNKNOWN"
] as const;
const dateFields = [
  "lastContactedAt",
  "updatedAt",
  "createdAt",
  "shipmentDate"
] as const;

function value(searchParams: URLSearchParams, key: string) {
  const raw = searchParams.get(key)?.trim();
  return raw && raw !== "all" ? raw : undefined;
}

function enumValue<const T extends readonly string[]>(
  values: T,
  searchParams: URLSearchParams,
  key: string
) : T[number] | undefined {
  const raw = value(searchParams, key);
  return raw && values.includes(raw) ? (raw as T[number]) : undefined;
}

function booleanValue(searchParams: URLSearchParams, key: string) {
  const raw = value(searchParams, key);
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "unknown") return null;
  return undefined;
}

function dateBoundary(value: string | undefined, endOfDay = false) {
  if (!value) return undefined;
  const hasTime = value.includes("T");
  const hasZone = /(?:Z|[+-]\d{2}:\d{2})$/.test(value);
  const localValue = hasTime
    ? value
    : `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`;
  const parsed = new Date(hasZone ? localValue : `${localValue}+03:00`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function integerBoundary(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) || parsed < 0 ? undefined : parsed;
}

export function buildCustomerWhere(searchParams: URLSearchParams) {
  const query = value(searchParams, "q");
  const city = value(searchParams, "city");
  const category = value(searchParams, "category");
  const reached = enumValue(reachStatuses, searchParams, "reached");
  const interestStatus = enumValue(
    interestStatuses,
    searchParams,
    "interestStatus"
  );
  const sampleStatus = enumValue(sampleStatuses, searchParams, "sampleStatus");
  const catalogSent = booleanValue(searchParams, "catalogSent");
  const hasSuitableProductGroup = booleanValue(
    searchParams,
    "hasSuitableProductGroup"
  );
  const currentAccountInfoReceived = booleanValue(
    searchParams,
    "currentAccountInfoReceived"
  );
  const dateField =
    enumValue(dateFields, searchParams, "dateField") ?? "lastContactedAt";
  const dateFrom = dateBoundary(value(searchParams, "dateFrom"));
  const dateTo = dateBoundary(value(searchParams, "dateTo"), true);
  const callCountMin = integerBoundary(value(searchParams, "callCountMin"));
  const callCountMax = integerBoundary(value(searchParams, "callCountMax"));

  const where: Prisma.CustomerWhereInput = {
    deletedAt: null
  };

  if (city) where.city = city;
  if (category) where.category = category;
  if (reached) where.reached = reached;
  if (interestStatus) where.interestStatus = interestStatus;
  if (sampleStatus) where.sampleStatus = sampleStatus;
  if (catalogSent !== undefined) where.catalogSent = catalogSent;
  if (hasSuitableProductGroup !== undefined) {
    where.hasSuitableProductGroup = hasSuitableProductGroup;
  }
  if (currentAccountInfoReceived !== undefined) {
    where.currentAccountInfoReceived = currentAccountInfoReceived;
  }
  if (dateFrom || dateTo) {
    where[dateField] = {
      ...(dateFrom ? { gte: dateFrom } : {}),
      ...(dateTo ? { lte: dateTo } : {})
    };
  }
  if (callCountMin !== undefined || callCountMax !== undefined) {
    where.callCount = {
      ...(callCountMin !== undefined ? { gte: callCountMin } : {}),
      ...(callCountMax !== undefined ? { lte: callCountMax } : {})
    };
  }

  if (query) {
    where.OR = [
      { companyName: { contains: query, mode: "insensitive" } },
      { contactName: { contains: query, mode: "insensitive" } },
      { email: { contains: query, mode: "insensitive" } },
      { phone: { contains: query, mode: "insensitive" } },
      { mobilePhone: { contains: query, mode: "insensitive" } },
      { city: { contains: query, mode: "insensitive" } },
      { category: { contains: query, mode: "insensitive" } },
      { contactDetail: { contains: query, mode: "insensitive" } }
    ];
  }

  return where;
}

export function readPagination(searchParams: URLSearchParams) {
  const page = Math.max(Number.parseInt(searchParams.get("page") ?? "1", 10) || 1, 1);
  const requestedPageSize =
    Number.parseInt(searchParams.get("pageSize") ?? "25", 10) || 25;
  const pageSize = Math.min(Math.max(requestedPageSize, 10), 100);

  return {
    page,
    pageSize,
    skip: (page - 1) * pageSize
  };
}

export function hasCustomerFilters(searchParams: URLSearchParams) {
  return [
    "q",
    "city",
    "category",
    "reached",
    "interestStatus",
    "catalogSent",
    "hasSuitableProductGroup",
    "currentAccountInfoReceived",
    "sampleStatus",
    "callCountMin",
    "callCountMax",
    "dateFrom",
    "dateTo"
  ].some((key) => Boolean(value(searchParams, key)));
}
