export type DiffPayloadClassification = "unrenderable" | "large-text" | "renderable";

export interface DiffPayloadMeasurements {
  readonly byteLength: number;
  readonly longestLineLength: number;
}

export function classifyDiffPayload({
  byteLength,
  longestLineLength,
}: DiffPayloadMeasurements): DiffPayloadClassification {
  if (byteLength >= 70_000_000) return "unrenderable";
  if (byteLength >= 4_375_000 || longestLineLength > 5_000) return "large-text";
  return "renderable";
}
