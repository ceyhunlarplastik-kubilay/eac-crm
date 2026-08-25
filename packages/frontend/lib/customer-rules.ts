export type SampleStatus = "WILL_SEND" | "WILL_NOT_SEND" | "SENT" | "UNKNOWN";

type SampleRuleInput = {
  hasSuitableProductGroup?: boolean | null;
  shipmentDate?: Date | string | null;
};

function hasValue(value: unknown) {
  return value !== null && value !== undefined && value !== "";
}

function pickRuleValue<T extends SampleRuleInput>(
  input: T,
  fallback: SampleRuleInput | undefined,
  key: keyof SampleRuleInput
) {
  return Object.prototype.hasOwnProperty.call(input, key)
    ? input[key]
    : fallback?.[key];
}

export function deriveSampleStatus(
  input: SampleRuleInput,
  fallback?: SampleRuleInput
): SampleStatus {
  const shipmentDate = pickRuleValue(input, fallback, "shipmentDate");
  if (hasValue(shipmentDate)) return "SENT";

  const hasSuitableProductGroup = pickRuleValue(
    input,
    fallback,
    "hasSuitableProductGroup"
  );

  if (hasSuitableProductGroup === true) return "WILL_SEND";
  if (hasSuitableProductGroup === false) return "WILL_NOT_SEND";
  return "UNKNOWN";
}

export function normalizeSampleStatus<T extends Record<string, unknown>>(
  input: T,
  fallback?: SampleRuleInput
) {
  return {
    ...input,
    sampleStatus: deriveSampleStatus(input, fallback)
  } as T & { sampleStatus: SampleStatus };
}
