import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function normalizeText(value: unknown) {
  if (value === null || value === undefined) return null;
  const normalized = String(value)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized || normalized === "-") return null;
  return normalized;
}

export function normalizeSearch(value: string) {
  return value
    .toLocaleLowerCase("tr-TR")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function buildDedupeKey(input: {
  companyName: string;
  city?: string | null;
  phone?: string | null;
  email?: string | null;
}) {
  const phone = input.phone?.replace(/\D/g, "") ?? "";
  const email = input.email?.toLocaleLowerCase("tr-TR") ?? "";
  return [
    normalizeSearch(input.companyName),
    normalizeSearch(input.city ?? ""),
    phone,
    email
  ]
    .filter(Boolean)
    .join("|");
}

export function toDateInputValue(value?: string | null) {
  if (!value) return "";
  return value.slice(0, 10);
}
