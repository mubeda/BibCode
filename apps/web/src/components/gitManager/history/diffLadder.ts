export type DiffPayloadClassification = "unrenderable" | "large-text" | "image" | "renderable";

export interface DiffPayloadMeasurements {
  readonly byteLength: number;
  readonly longestLineLength: number;
  readonly kind?: "image";
}

export function classifyDiffPayload({
  byteLength,
  longestLineLength,
  kind,
}: DiffPayloadMeasurements): DiffPayloadClassification {
  if (byteLength >= 70_000_000) return "unrenderable";
  if (kind === "image") return "image";
  if (byteLength >= 4_375_000 || longestLineLength > 5_000) return "large-text";
  return "renderable";
}
