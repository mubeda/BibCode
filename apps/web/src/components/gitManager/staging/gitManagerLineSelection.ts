export type GitManagerLineSelectionType = "all" | "partial" | "none";

export interface GitManagerLineSelection {
  readonly type: GitManagerLineSelectionType;
  readonly diverging: ReadonlySet<number>;
  readonly selectable: ReadonlySet<number> | null;
  readonly basis: "all" | "none";
}

export function createLineSelection(
  kind: "all" | "none",
  selectable: Iterable<number> | null = null,
): GitManagerLineSelection {
  const selection: GitManagerLineSelection = {
    type: kind,
    diverging: new Set(),
    selectable: selectable === null ? null : new Set(selectable),
    basis: kind,
  };
  return { ...selection, type: resolveSelectionType(selection) };
}

export function withToggleLine(
  selection: GitManagerLineSelection,
  index: number,
): GitManagerLineSelection {
  return withLineSelection(selection, index, !isLineSelected(selection, index));
}

export function isLineSelected(selection: GitManagerLineSelection, index: number): boolean {
  if (selection.selectable !== null && !selection.selectable.has(index)) return false;
  const defaultSelected = selection.basis === "all";
  return selection.diverging.has(index) ? !defaultSelected : defaultSelected;
}

function withDiverging(
  selection: GitManagerLineSelection,
  diverging: ReadonlySet<number>,
): GitManagerLineSelection {
  const next: GitManagerLineSelection = {
    ...selection,
    diverging,
  };
  return { ...next, type: resolveSelectionType(next) };
}

export function withLineSelection(
  selection: GitManagerLineSelection,
  index: number,
  selected: boolean,
): GitManagerLineSelection {
  const diverging = new Set(selection.diverging);
  const defaultSelected = selection.basis === "all";
  if (selected === defaultSelected) diverging.delete(index);
  else diverging.add(index);
  return withDiverging(selection, diverging);
}

export function withRangeSelection(
  selection: GitManagerLineSelection,
  from: number,
  to: number,
  selected: boolean,
): GitManagerLineSelection {
  const diverging = new Set(selection.diverging);
  const defaultSelected = selection.basis === "all";
  const start = Math.max(0, Math.min(from, to));
  const end = Math.max(from, to);
  for (let index = start; index <= end; index += 1) {
    if (selection.selectable !== null && !selection.selectable.has(index)) continue;
    if (selected === defaultSelected) diverging.delete(index);
    else diverging.add(index);
  }
  return withDiverging(selection, diverging);
}

export function withSelectAll(selection: GitManagerLineSelection): GitManagerLineSelection {
  return {
    ...selection,
    type: selection.selectable?.size === 0 ? "none" : "all",
    diverging: new Set(),
    basis: "all",
  };
}

export function withSelectNone(selection: GitManagerLineSelection): GitManagerLineSelection {
  return {
    ...selection,
    type: "none",
    diverging: new Set(),
    basis: "none",
  };
}

export function resolveSelectionType(
  selection: GitManagerLineSelection,
): GitManagerLineSelectionType {
  if (selection.selectable === null) {
    return selection.diverging.size === 0 ? selection.basis : "partial";
  }
  if (selection.selectable.size === 0) return "none";

  let selectedCount = 0;
  for (const index of selection.selectable) {
    if (isLineSelected(selection, index)) selectedCount += 1;
  }
  if (selectedCount === 0) return "none";
  return selectedCount === selection.selectable.size ? "all" : "partial";
}

export interface GitManagerWireSelection {
  readonly path: string;
  readonly selectedLines: ReadonlyArray<number>;
  readonly baseGeneration: number;
}

export function toWireSelection(
  selection: GitManagerLineSelection,
  path: string,
  generation: number,
): GitManagerWireSelection {
  const candidates = selection.selectable ?? selection.diverging;
  const selectedLines: number[] = [];
  for (const index of candidates) {
    if (Number.isSafeInteger(index) && index >= 0 && isLineSelected(selection, index)) {
      selectedLines.push(index);
    }
  }
  selectedLines.sort((left, right) => left - right);
  return { path, selectedLines, baseGeneration: generation };
}

export interface GitManagerSelectionMutationFailure {
  readonly selection: GitManagerLineSelection;
  readonly message: string;
  readonly retry: false;
  readonly stale: boolean;
}

export function resolveSelectionMutationFailure(
  selection: GitManagerLineSelection,
  error: unknown,
): GitManagerSelectionMutationFailure {
  const candidate =
    error !== null && typeof error === "object" ? (error as Record<string, unknown>) : null;
  const message =
    typeof candidate?.message === "string" && candidate.message.trim().length > 0
      ? candidate.message
      : "Git could not apply the selected lines.";
  return {
    selection,
    message,
    retry: false,
    stale: candidate?.code === "stale-selection",
  };
}
