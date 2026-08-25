import { prisma } from "@/lib/prisma";
import { buildDedupeKey } from "@/lib/utils";
import type { Actor } from "@/lib/session";

type CustomerData = {
  dedupeKey?: string;
  sequenceNumber?: number | null;
  companyName?: string;
  website?: string | null;
  email?: string | null;
  phone?: string | null;
  city?: string | null;
  category?: string | null;
  contactName?: string | null;
  mobilePhone?: string | null;
  reached?: "REACHED" | "NOT_REACHED" | "UNKNOWN";
  callCount?: number;
  lastContactedAt?: Date | null;
  contactDetail?: string | null;
  interestStatus?: "INTERESTED" | "NOT_INTERESTED" | "UNKNOWN";
  catalogSent?: boolean | null;
  hasSuitableProductGroup?: boolean | null;
  currentAccountInfoReceived?: boolean | null;
  sampleStatus?: "WILL_SEND" | "WILL_NOT_SEND" | "SENT" | "UNKNOWN";
  shipmentDate?: Date | null;
  sourceRowNumber?: number | null;
  sourceImportBatchId?: string | null;
};

const trackedFields = [
  "sequenceNumber",
  "companyName",
  "website",
  "email",
  "phone",
  "city",
  "category",
  "contactName",
  "mobilePhone",
  "reached",
  "callCount",
  "lastContactedAt",
  "contactDetail",
  "interestStatus",
  "catalogSent",
  "hasSuitableProductGroup",
  "currentAccountInfoReceived",
  "sampleStatus",
  "shipmentDate"
] as const;

export const customerContactInclude = {
  contacts: {
    orderBy: [{ contactedAt: "desc" as const }, { createdAt: "desc" as const }],
    take: 20
  }
};

function comparable(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  return value ?? null;
}

function serializeDate(value: unknown) {
  return value instanceof Date ? value.toISOString() : value;
}

export function diffCustomer(before: Record<string, unknown>, after: CustomerData) {
  const changes: Record<string, { before: unknown; after: unknown }> = {};

  for (const field of trackedFields) {
    if (!(field in after)) continue;

    const previous = comparable(before[field]);
    const next = comparable(after[field]);

    if (previous !== next) {
      changes[field] = {
        before: previous,
        after: next
      };
    }
  }

  return changes;
}

export function serializeCustomer(customer: Record<string, unknown>) {
  return {
    ...customer,
    lastContactedAt: serializeDate(customer.lastContactedAt),
    shipmentDate: serializeDate(customer.shipmentDate),
    createdAt: serializeDate(customer.createdAt),
    updatedAt: serializeDate(customer.updatedAt),
    deletedAt: serializeDate(customer.deletedAt),
    contacts: Array.isArray(customer.contacts)
      ? customer.contacts.map((contact) => {
          const item = contact as Record<string, unknown>;
          return {
            ...item,
            contactedAt: serializeDate(item.contactedAt),
            createdAt: serializeDate(item.createdAt)
          };
        })
      : customer.contacts
  };
}

export function actorFields(actor: Actor, mode: "create" | "update") {
  if (mode === "create") {
    return {
      createdByEmail: actor.email,
      createdByName: actor.name,
      updatedByEmail: actor.email,
      updatedByName: actor.name
    };
  }

  return {
    updatedByEmail: actor.email,
    updatedByName: actor.name
  };
}

export async function writeActivity(input: {
  customerId?: string | null;
  importBatchId?: string | null;
  action: "CREATE" | "UPDATE" | "DELETE" | "IMPORT";
  summary: string;
  changes?: Record<string, unknown>;
  actor: Actor;
}) {
  const changes =
    input.changes === undefined
      ? undefined
      : JSON.parse(JSON.stringify(input.changes));

  return prisma.activityLog.create({
    data: {
      customerId: input.customerId ?? null,
      importBatchId: input.importBatchId ?? null,
      action: input.action,
      summary: input.summary,
      changes,
      actorSub: input.actor.sub,
      actorEmail: input.actor.email,
      actorName: input.actor.name
    }
  });
}

export function rebuildDedupeKey(existing: Record<string, unknown>, patch: CustomerData) {
  const companyName = String(patch.companyName ?? existing.companyName ?? "");
  return buildDedupeKey({
    companyName,
    city: (patch.city ?? existing.city) as string | null | undefined,
    phone: (patch.phone ?? existing.phone) as string | null | undefined,
    email: (patch.email ?? existing.email) as string | null | undefined
  });
}
