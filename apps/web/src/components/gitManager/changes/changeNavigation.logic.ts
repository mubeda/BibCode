/** Where Next change (+1) or Previous change (-1) goes from the current change. */
export type ChangeStep =
  | { readonly kind: "change"; readonly index: number }
  | { readonly kind: "file"; readonly fileIndex: number; readonly edge: "first" | "last" }
  | { readonly kind: "stop" };

export interface ChangeStepInput {
  readonly fileIndex: number;
  readonly fileCount: number;
  /** The change last visited in the file; -1 before any. */
  readonly changeIndex: number;
  readonly changeCount: number;
  readonly direction: 1 | -1;
}

/**
 * Walks the changes of the selected file, then continues into the next or previous file of the
 * list. The list does not wrap: it stops at its first and last change.
 */
export function resolveChangeStep(input: ChangeStepInput): ChangeStep {
  const { fileIndex, fileCount, changeIndex, changeCount, direction } = input;
  const index = changeIndex + direction;
  if (index >= 0 && index < changeCount) return { kind: "change", index };
  const next = fileIndex + direction;
  if (next < 0 || next >= fileCount) return { kind: "stop" };
  return { kind: "file", fileIndex: next, edge: direction === 1 ? "first" : "last" };
}
