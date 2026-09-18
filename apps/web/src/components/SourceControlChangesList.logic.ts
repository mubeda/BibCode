import { splitFilePath, type WorkingTreeFile } from "./SourceControlPanel.logic";

/**
 * One folder's worth of pending changes. `directory` is the repo-relative
 * directory the files live in, or `null` for files at the repository root;
 * `label` is what the folder header renders.
 */
export interface SourceControlFolderGroup {
  readonly directory: string | null;
  readonly label: string;
  readonly files: WorkingTreeFile[];
}

/** Header label for files that sit directly in the repository root. */
export const ROOT_FOLDER_LABEL = "/";

const collator = new Intl.Collator(undefined, { numeric: true });

/**
 * Groups working-tree files by their directory for the folder view. Root files
 * come first, then directories in path order, so a folder header always sits
 * directly above the files it contains. File order inside a group is the order
 * the server reported.
 */
export function groupFilesByDirectory(
  files: readonly WorkingTreeFile[],
): ReadonlyArray<SourceControlFolderGroup> {
  const byDirectory = new Map<string, WorkingTreeFile[]>();
  for (const file of files) {
    const key = splitFilePath(file.path).dir ?? "";
    const existing = byDirectory.get(key);
    if (existing) existing.push(file);
    else byDirectory.set(key, [file]);
  }
  return [...byDirectory.entries()]
    .sort(([left], [right]) => {
      if (left === right) return 0;
      if (left === "") return -1;
      if (right === "") return 1;
      return collator.compare(left, right);
    })
    .map(([directory, groupFiles]) => ({
      directory: directory === "" ? null : directory,
      label: directory === "" ? ROOT_FOLDER_LABEL : directory,
      files: groupFiles,
    }));
}

/** Tri-state of a folder header checkbox over the files it covers. */
export type FolderCheckboxState = "all" | "none" | "mixed";

/**
 * Whether all, none, or some of a folder's files are checked (staged) or
 * selected. An empty folder never renders, so it reports "none".
 */
export function folderCheckboxState(
  files: readonly WorkingTreeFile[],
  isChecked: (file: WorkingTreeFile) => boolean,
): FolderCheckboxState {
  let checked = 0;
  for (const file of files) {
    if (isChecked(file)) checked += 1;
  }
  if (checked === 0) return "none";
  return checked === files.length ? "all" : "mixed";
}

/**
 * How a folder header names its target in accessible labels: the directory
 * itself, or the repository root for files with no directory.
 */
export function folderActionTarget(group: SourceControlFolderGroup): string {
  return group.directory ?? "the repository root";
}

/** "1 file" / "3 files", for a folder header's accessible name. */
export function fileCountLabel(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`;
}
