import type { GitManagerMergePreview } from "@bibcode/contracts";

export interface MergePreviewSummary {
  readonly kind: GitManagerMergePreview["_tag"];
  readonly message: string;
  readonly mergeEnabled: boolean;
  readonly ahead: number;
  readonly behind: number;
}

export function summarizeMergePreview(preview: GitManagerMergePreview): MergePreviewSummary {
  const base = { ahead: preview.ahead, behind: preview.behind };
  switch (preview._tag) {
    case "clean":
      return {
        kind: preview._tag,
        message: `This will merge ${preview.ahead} commits from \`${preview.source}\` into \`${preview.current}\`.`,
        mergeEnabled: true,
        ...base,
      };
    case "conflicted":
      return {
        kind: preview._tag,
        message: `There will be ${preview.fileCount} conflicted files.`,
        mergeEnabled: true,
        ...base,
      };
    case "unrelated-histories":
      return {
        kind: preview._tag,
        message: "These branches have unrelated histories and cannot be merged.",
        mergeEnabled: false,
        ...base,
      };
  }
}

export function resolveMergeConfirmCopy(mode: "merge" | "squash"): {
  readonly title: string;
  readonly confirmLabel: string;
} {
  return mode === "merge"
    ? { title: "Merge into current branch", confirmLabel: "Merge" }
    : { title: "Squash and merge into current branch", confirmLabel: "Squash and Merge" };
}
