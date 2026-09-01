import { type GitManagerLineSelection, isLineSelected } from "./gitManagerLineSelection";

export interface GitManagerPartialDiscardDialogCopy {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
}

function selectedLineCount(selection: GitManagerLineSelection): number {
  const candidates = selection.selectable ?? selection.diverging;
  let count = 0;
  for (const index of candidates) {
    if (isLineSelected(selection, index)) count += 1;
  }
  return count;
}

export function resolvePartialDiscardDialogCopy(
  selection: GitManagerLineSelection,
  path: string,
): GitManagerPartialDiscardDialogCopy {
  const count = selectedLineCount(selection);
  const noun = count === 1 ? "line" : "lines";
  return {
    title: `Discard ${count} selected ${noun} from ${path}?`,
    description: `This permanently removes the ${count} selected working-tree ${noun} from ${path}. These changes cannot be recovered.`,
    confirmLabel: `Discard ${count} ${noun}`,
  };
}
