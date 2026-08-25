import { z } from "zod";
import { normalizeSampleStatus } from "@/lib/customer-rules";
import { buildDedupeKey, normalizeText } from "@/lib/utils";

const nullableString = z.preprocess(
  normalizeText,
  z.string().max(1000).nullable()
);

const optionalNullableString = nullableString.optional();

const optionalBoolean = z
  .union([z.boolean(), z.null()])
  .optional()
  .transform((value) => value ?? null);

function emptyCellToNull(value: unknown) {
  const normalized = normalizeText(value);
  return normalized === null || normalized === "0" ? null : value;
}

const optionalInteger = z
  .preprocess(
    emptyCellToNull,
    z.union([z.null(), z.coerce.number().int().min(0)])
  )
  .optional()
  .transform((value) => value ?? null);

const optionalDate = z
  .preprocess((value) => {
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }

    return emptyCellToNull(value);
  }, z.union([z.null(), z.coerce.date()]))
  .optional()
  .transform((value) => {
    if (!value) return null;
    if (Number.isNaN(value.getTime())) return null;
    return value;
  });

export const reachStatusSchema = z.enum(["REACHED", "NOT_REACHED", "UNKNOWN"]);
export const interestStatusSchema = z.enum([
  "INTERESTED",
  "NOT_INTERESTED",
  "UNKNOWN"
]);
export const sampleStatusSchema = z.enum([
  "WILL_SEND",
  "WILL_NOT_SEND",
  "SENT",
  "UNKNOWN"
]);

const customerBaseSchema = z.object({
    sequenceNumber: optionalInteger,
    companyName: z.preprocess(
      normalizeText,
      z.string().min(1, "Firma adı gerekli").max(300)
    ),
    website: optionalNullableString,
    email: optionalNullableString,
    phone: optionalNullableString,
    city: optionalNullableString,
    category: optionalNullableString,
    contactName: optionalNullableString,
    mobilePhone: optionalNullableString,
    reached: reachStatusSchema.default("UNKNOWN"),
    callCount: z.coerce.number().int().min(0).default(0),
    lastContactedAt: optionalDate,
    contactDetail: optionalNullableString,
    interestStatus: interestStatusSchema.default("UNKNOWN"),
    catalogSent: optionalBoolean,
    hasSuitableProductGroup: optionalBoolean,
    currentAccountInfoReceived: optionalBoolean,
    sampleStatus: sampleStatusSchema.default("UNKNOWN"),
    shipmentDate: optionalDate,
    sourceRowNumber: optionalInteger,
    sourceImportBatchId: optionalNullableString
  });

export const customerCreateSchema = customerBaseSchema
  .transform((value) => {
    const normalized = normalizeSampleStatus(value);

    return {
      ...normalized,
      dedupeKey: buildDedupeKey(normalized)
    };
  });

export const customerUpdateSchema = customerBaseSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Güncellenecek alan bulunamadı"
  });

export type CustomerCreateInput = z.infer<typeof customerCreateSchema>;
