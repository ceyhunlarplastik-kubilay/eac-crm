import { ApiError } from "@/lib/api-error";

export function requireCustomerWrites() {
  if (process.env.CUSTOMER_WRITES_PAUSED === "true") {
    throw new ApiError(503, "Veri geçişi sürüyor. Lütfen kısa süre sonra tekrar deneyin.");
  }
}

export function customerCategoryName(customer: {
  category?: unknown;
}) {
  const relation = customer.category as { name: string } | null | undefined;
  return relation?.name ?? null;
}
