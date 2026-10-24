import type {
  ProjectFileUnreadableFailure,
  ProjectFileVersion,
  ProjectWritePrecondition,
} from "@bibcode/contracts";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@bibcode/client-runtime/state/runtime";
import type { DiffLineAnnotation, FileContents, LineAnnotation } from "@pierre/diffs";
import { Editor, type EditorOptions } from "@pierre/diffs/edit";

import { diskReloadEdits } from "./fileDiskReload";
import {
  FileSaveCoordinator,
  type FileSaveFlushResult,
  type FileSaveSettleResult,
  type FileSaveSnapshot,
} from "./fileSaveCoordinator";

export type FileEditorChangeHandler<LAnnotation> = (
  file: FileContents,
  lineAnnotations?: LineAnnotation<LAnnotation>[] | DiffLineAnnotation<LAnnotation>[],
) => void;

/** Why the document and the file on disk disagree in a way only the user can settle. */
export type FileDiskConflictReason = "changed" | "deleted" | "unreadable";

export interface FileDiskConflict {
  readonly reason: FileDiskConflictReason;
  /** False while a refused save waits for a check to report what the disk now holds. */
  readonly diskKnown: boolean;
  /** Why an `unreadable` file can no longer be opened; null for the other reasons. */
  readonly unreadable: ProjectFileUnreadableFailure | null;
}

export interface FileEditingSessionSnapshot {
  readonly save: FileSaveSnapshot;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly conflict: FileDiskConflict | null;
  /** The file is gone and nothing unsaved is left to show. */
  readonly deletedOnDisk: boolean;
}

/** The disk snapshot a session's file was read from. */
export interface FileDiskSnapshot {
  /** Absent when the server predates content versions: saves are then unguarded. */
  readonly version?: string | undefined;
  readonly contents: string;
}

export interface FileEditingSessionOptions<A, E> {
  readonly cwd: string;
  readonly relativePath: string;
  readonly debounceMs: number;
  /**
   * The disk state the document starts from. Its version turns on guarded saves and disk
   * reconciliation; without one the session saves unguarded, as before versions existed.
   */
  readonly base?: FileDiskSnapshot;
  /**
   * Writes `contents`. With a `precondition` the write must be refused when the disk is no
   * longer that state, and its success carries the committed `version`.
   */
  readonly persist: (
    relativePath: string,
    contents: string,
    precondition: ProjectWritePrecondition | null,
  ) => Promise<AtomCommandResult<A, E>>;
  readonly onPendingChange: (relativePath: string, pending: boolean) => void;
  readonly onConfirmed: (
    relativePath: string,
    contents: string,
    version: string | undefined,
  ) => void;
  readonly onConflictChange?: (relativePath: string, conflicted: boolean) => void;
}

/** What the disk held when a conflict was recorded; null until a check reports it. */
type ConflictDisk =
  | { readonly kind: "present"; readonly version: string; readonly contents: string }
  | { readonly kind: "missing" }
  | {
      readonly kind: "unreadable";
      readonly version: string;
      readonly failure: ProjectFileUnreadableFailure;
    };

type DiskBase =
  | { readonly kind: "present"; readonly version: string; readonly contents: string }
  | { readonly kind: "missing" };

interface ConflictState {
  readonly view: FileDiskConflict;
  readonly disk: ConflictDisk | null;
}

/** A disk read for reconciliation; its version is absent only from an older server. */
export interface FileDiskRead {
  readonly version?: string | undefined;
  readonly contents: string;
}

let nextSessionCacheKey = 0;

function createSessionCacheKey(cwd: string): string {
  nextSessionCacheKey += 1;
  return `${cwd}:file-editing-session:${nextSessionCacheKey}`;
}

/** The disk refusal a failed guarded write carries, if that is why it failed. */
function writeRefusal(result: AtomCommandResult<unknown, unknown>): "changed" | "deleted" | null {
  if (result._tag !== "Failure") return null;
  const failure = squashAtomCommandFailure(result) as { readonly failure?: unknown } | null;
  if (failure?.failure === "file_changed_on_disk") return "changed";
  if (failure?.failure === "file_missing_on_disk") return "deleted";
  return null;
}

function committedVersion(result: AtomCommandResult<unknown, unknown>): string | undefined {
  if (result._tag !== "Success") return undefined;
  const value = result.value as { readonly version?: unknown } | null | undefined;
  return typeof value?.version === "string" ? value.version : undefined;
}

export class FileEditingSession<LAnnotation, A = unknown, E = unknown> {
  private readonly cwd: string;
  private currentRelativePath: string;
  private currentCacheKey: string;
  private readonly coordinator: FileSaveCoordinator<A, E>;
  private readonly unsubscribeCoordinator: () => void;
  private readonly listeners = new Set<() => void>();
  private readonly diskCheckListeners = new Set<() => void>();
  private editorChangeHandler: FileEditorChangeHandler<LAnnotation> | null = null;
  private editorInstance: Editor<LAnnotation> | null = null;
  private editorChangedDocument = false;
  private disposed = false;
  private snapshot!: FileEditingSessionSnapshot;
  /** Null when the server returned no version: nothing is guarded or reconciled. */
  private base: DiskBase | null;
  private conflict: ConflictState | null = null;
  private deletedOnDisk = false;
  /** The precondition of an Overwrite disk write, used instead of the base once. */
  private overwritePrecondition: ProjectWritePrecondition | null = null;
  /** Bumped when a save starts and when it ends; a disk check from another generation is stale. */
  private saveGeneration = 0;
  private savesInFlight = 0;
  /** Set around a disk reload, whose editor change is adopted instead of recorded. */
  private applyingDiskText = false;
  private composing = false;

  constructor(private readonly options: FileEditingSessionOptions<A, E>) {
    this.cwd = options.cwd;
    this.currentRelativePath = options.relativePath;
    this.currentCacheKey = createSessionCacheKey(options.cwd);
    this.base =
      options.base?.version === undefined
        ? null
        : { kind: "present", version: options.base.version, contents: options.base.contents };
    this.coordinator = new FileSaveCoordinator({
      debounceMs: options.debounceMs,
      persist: (contents) => this.persist(contents),
      onPendingChange: (pending) => options.onPendingChange(this.currentRelativePath, pending),
      onConfirmed: (contents) =>
        options.onConfirmed(
          this.currentRelativePath,
          contents,
          this.base?.kind === "present" ? this.base.version : undefined,
        ),
    });
    this.snapshot = this.readSnapshot();
    this.unsubscribeCoordinator = this.coordinator.subscribe(() => this.publish());
  }

  get relativePath(): string {
    return this.currentRelativePath;
  }

  get cacheKey(): string {
    return this.currentCacheKey;
  }

  /**
   * Contents a surface must show instead of the file query: the text the editor
   * document holds once the editor has changed it, or a change not saved yet.
   * Null when the file query should seed the document. Pierre shares rendered
   * lines between files with the same `cacheKey`, so pairing `cacheKey` with
   * contents read before the save landed can paint them over the edited document.
   */
  get retainedContents(): string | null {
    if (!this.editorChangedDocument && !this.coordinator.hasPendingWork()) return null;
    return this.coordinator.getLatestContents();
  }

  /**
   * The text this session's document holds while part of it is not yet saved
   * (pending, saving, failed, or paused), or null once the file holds all of it.
   * A view that shows the file must prefer this text: the file query still holds
   * what was read before these edits, and changing the file from it drops them.
   */
  get unsavedContents(): string | null {
    return this.coordinator.hasPendingWork() ? this.coordinator.getLatestContents() : null;
  }

  /**
   * The text this session's document holds: the latest edit, saved or not, else the disk text it
   * was read from. A surface shows this when the file query cannot seed the document, such as a
   * read cut short at the read limit.
   */
  get documentContents(): string {
    return this.localText();
  }

  /** Whether the server versions this file, so its disk state can be watched and guarded. */
  get watchesDisk(): boolean {
    return this.base !== null && !this.disposed;
  }

  get editor(): Editor<LAnnotation> {
    if (this.editorInstance === null) {
      this.editorInstance = this.createEditor();
      this.snapshot = this.readSnapshot();
    }
    return this.editorInstance;
  }

  private createEditor(): Editor<LAnnotation> {
    const editorOptions: EditorOptions<LAnnotation> = {
      persistState: true,
      onAttach: () => {
        if (!this.disposed) this.publish();
      },
      onChange: (file, lineAnnotations) => {
        if (this.disposed) return;
        this.editorChangedDocument = true;
        // A reload's text is already on disk: adopt it rather than save it back.
        if (this.applyingDiskText) this.coordinator.adopt(file.contents);
        else this.coordinator.change(file.contents);
        this.editorChangeHandler?.(file, lineAnnotations);
        this.publish();
      },
    };
    return new Editor<LAnnotation>(editorOptions);
  }

  private readSnapshot(): FileEditingSessionSnapshot {
    return {
      save: this.coordinator.getSnapshot(),
      canUndo: this.editorInstance?.canUndo ?? false,
      canRedo: this.editorInstance?.canRedo ?? false,
      conflict: this.conflict?.view ?? null,
      deletedOnDisk: this.deletedOnDisk,
    };
  }

  private publish(): void {
    const next = this.readSnapshot();
    if (
      next.save === this.snapshot.save &&
      next.canUndo === this.snapshot.canUndo &&
      next.canRedo === this.snapshot.canRedo &&
      next.conflict === this.snapshot.conflict &&
      next.deletedOnDisk === this.snapshot.deletedOnDisk
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): FileEditingSessionSnapshot => this.snapshot;

  setEditorChangeHandler(handler: FileEditorChangeHandler<LAnnotation> | null): void {
    if (this.disposed) return;
    this.editorChangeHandler = handler;
  }

  /** An IME composition in the editor; a disk reload waits until it ends. */
  setComposing(composing: boolean): void {
    this.composing = composing;
  }

  async flush(): Promise<FileSaveFlushResult> {
    return this.coordinator.flush();
  }

  async settle(): Promise<FileSaveSettleResult> {
    return this.coordinator.settle();
  }

  setAutosaveEnabled(enabled: boolean): void {
    this.coordinator.setAutosaveEnabled(enabled);
  }

  pauseSaving(): void {
    this.coordinator.pauseSaving();
  }

  resumeSaving(): void {
    this.coordinator.resumeSaving();
  }

  discardPendingSave(): void {
    this.coordinator.discardPendingSave();
  }

  undo(): void {
    if (!this.editorInstance?.canUndo) return;
    this.editorInstance.undo();
    this.publish();
  }

  redo(): void {
    if (!this.editorInstance?.canRedo) return;
    this.editorInstance.redo();
    this.publish();
  }

  rename(relativePath: string): void {
    if (relativePath === this.currentRelativePath) return;
    const previousRelativePath = this.currentRelativePath;
    const pending = this.coordinator.hasPendingWork();
    const conflicted = this.conflict !== null;
    if (pending) this.options.onPendingChange(previousRelativePath, false);
    if (conflicted) this.options.onConflictChange?.(previousRelativePath, false);
    this.currentRelativePath = relativePath;
    if (pending) this.options.onPendingChange(relativePath, true);
    if (conflicted) this.options.onConflictChange?.(relativePath, true);
  }

  changeOutsideEditor(contents: string): void {
    if (this.disposed) return;
    this.discardEditor();
    this.coordinator.change(contents);
    this.publish();
  }

  /** Asks the disk watcher, when one is attached, to check the file now. */
  requestDiskCheck(): void {
    for (const listener of this.diskCheckListeners) listener();
  }

  readonly subscribeDiskCheckRequests = (listener: () => void): (() => void) => {
    if (this.disposed) return () => {};
    this.diskCheckListeners.add(listener);
    return () => {
      this.diskCheckListeners.delete(listener);
    };
  };

  /**
   * Starts a disk check: the token its results must carry, or null when no check may run now
   * (no versions, a save in flight, or saving paused by a rename or delete in progress).
   */
  beginDiskCheck(): number | null {
    return this.canReconcile() ? this.saveGeneration : null;
  }

  /**
   * Applies a version check. Returns "read" when the file's text has to be read to reconcile it,
   * and "stale" when a save started or ended since the check began: that save's result settles
   * the base, and the next check re-reads.
   */
  reconcileVersion(token: number, disk: ProjectFileVersion): "settled" | "read" | "stale" {
    if (!this.isCurrentCheck(token)) return "stale";
    const base = this.base!;
    switch (disk._tag) {
      case "missing":
        if (base.kind === "missing") return "settled";
        if (this.coordinator.hasPendingWork()) {
          this.recordConflict("deleted", { kind: "missing" });
        } else if (!this.composing) {
          // While composing, the editor holds text Pierre has not committed yet; the next check
          // after the composition records the deletion, as a conflict once that text lands.
          this.markDeletedOnDisk();
        }
        return "settled";
      case "unreadable":
        this.recordConflict("unreadable", {
          kind: "unreadable",
          version: disk.version,
          failure: disk.failure,
        });
        return "settled";
      case "present":
        if (base.kind === "present" && base.version === disk.version) {
          // The disk is back at the state the edits were based on: they are ordinary edits again.
          this.clearConflict();
          this.publish();
          return "settled";
        }
        if (
          this.conflict?.disk?.kind === "present" &&
          this.conflict.disk.version === disk.version
        ) {
          // The conflict already holds this version's text: settle it without reading the file.
          if (this.conflict.disk.contents === this.localText()) this.adoptBase(this.conflict.disk);
          return "settled";
        }
        return "read";
    }
  }

  /** Reconciles with a disk read made for the check that `token` started. */
  reconcileRead(token: number, read: FileDiskRead): void {
    if (!this.isCurrentCheck(token) || read.version === undefined) return;
    const disk = { kind: "present", version: read.version, contents: read.contents } as const;
    if (read.contents === this.localText()) {
      // Our own save, or the same edit made elsewhere.
      this.adoptBase(disk);
      return;
    }
    if (this.coordinator.hasPendingWork()) {
      this.recordConflict("changed", disk);
      return;
    }
    // Typing is about to land; the next check reloads or records a conflict once it has.
    if (this.composing) return;
    this.applyDiskText(disk);
  }

  /**
   * Resolves a conflict by taking the disk's text and discarding the local edits. With the
   * source editor attached the reload is one undo step, so Undo brings the edits back.
   */
  reloadFromDisk(): void {
    const disk = this.conflict?.disk;
    if (this.disposed || disk == null) return;
    if (disk.kind === "present") this.applyDiskText(disk);
    else if (disk.kind === "missing") this.markDeletedOnDisk();
  }

  /** Resolves a conflict by saving the document over the disk state the user was shown. */
  overwriteDisk(): void {
    const disk = this.conflict?.disk;
    if (this.disposed || this.conflict === null) return;
    if (disk == null) {
      this.requestDiskCheck();
      return;
    }
    const contents = this.localText();
    this.overwritePrecondition =
      disk.kind === "missing" ? { _tag: "missing" } : { _tag: "version", version: disk.version };
    this.clearConflict();
    // Mark the text unsaved even when it matches the last save, so the flush writes it.
    this.coordinator.change(contents);
    this.publish();
    void this.coordinator.flush();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.conflict !== null) this.options.onConflictChange?.(this.currentRelativePath, false);
    this.unsubscribeCoordinator();
    this.coordinator.dispose();
    const editor = this.editorInstance;
    this.editorInstance = null;
    this.editorChangeHandler = null;
    this.listeners.clear();
    this.diskCheckListeners.clear();
    editor?.cleanUp();
  }

  private canReconcile(): boolean {
    return (
      !this.disposed &&
      this.base !== null &&
      this.savesInFlight === 0 &&
      !this.coordinator.isSavingPaused()
    );
  }

  private isCurrentCheck(token: number): boolean {
    return this.canReconcile() && token === this.saveGeneration;
  }

  /** The document's text: the latest edit, adopted or not, else what was read. */
  private localText(): string {
    const latest = this.coordinator.getLatestContents();
    if (latest !== null) return latest;
    return this.base?.kind === "present" ? this.base.contents : "";
  }

  private async persist(contents: string): Promise<AtomCommandResult<A, E>> {
    const precondition = this.writePrecondition();
    this.saveGeneration += 1;
    this.savesInFlight += 1;
    let result: AtomCommandResult<A, E>;
    try {
      result = await this.options.persist(this.currentRelativePath, contents, precondition);
    } finally {
      this.savesInFlight -= 1;
      this.saveGeneration += 1;
    }
    if (this.disposed || precondition === null) return result;
    this.overwritePrecondition = null;
    const version = committedVersion(result);
    if (version !== undefined) {
      this.base = { kind: "present", version, contents };
      this.deletedOnDisk = false;
      return result;
    }
    const refusal = writeRefusal(result);
    if (refusal !== null) {
      // What the disk holds now is unknown until a check reports it.
      this.recordConflict(refusal, null);
      this.requestDiskCheck();
    }
    return result;
  }

  private writePrecondition(): ProjectWritePrecondition | null {
    if (this.overwritePrecondition !== null) return this.overwritePrecondition;
    if (this.base === null) return null;
    return this.base.kind === "present"
      ? { _tag: "version", version: this.base.version }
      : { _tag: "missing" };
  }

  private recordConflict(reason: FileDiskConflictReason, disk: ConflictDisk | null): void {
    const wasConflicted = this.conflict !== null;
    const diskKnown = disk !== null;
    const unreadable = disk?.kind === "unreadable" ? disk.failure : null;
    const current = this.conflict?.view;
    const view =
      current?.reason === reason &&
      current.diskKnown === diskKnown &&
      current.unreadable === unreadable
        ? current
        : { reason, diskKnown, unreadable };
    this.conflict = { view, disk };
    this.coordinator.holdForConflict();
    if (!wasConflicted) this.options.onConflictChange?.(this.currentRelativePath, true);
    this.publish();
  }

  private clearConflict(): void {
    if (this.conflict === null) return;
    this.conflict = null;
    this.coordinator.releaseConflict();
    this.options.onConflictChange?.(this.currentRelativePath, false);
  }

  private adoptBase(disk: { readonly version: string; readonly contents: string }): void {
    this.base = { kind: "present", version: disk.version, contents: disk.contents };
    this.deletedOnDisk = false;
    if (this.coordinator.hasPendingWork()) this.coordinator.adopt(disk.contents);
    this.clearConflict();
    this.publish();
  }

  /**
   * Rules 3 and 4 of the design: an attached editor takes the disk text as one undo step of
   * character-level edits, so carets and comment annotations stay put; a detached one is dropped
   * and the next attach seeds from the file query, which already holds the disk text.
   */
  private applyDiskText(disk: { readonly version: string; readonly contents: string }): void {
    const editor = this.editorInstance;
    let applied = false;
    if (editor !== null && editor.getFile() !== undefined) {
      this.applyingDiskText = true;
      try {
        editor.applyEdits(diskReloadEdits(editor.getText(), disk.contents), true, true);
        applied = editor.getText() === disk.contents;
      } catch (error) {
        console.error("[file-editing-session] disk reload into the editor failed", error);
      } finally {
        this.applyingDiskText = false;
      }
    }
    if (!applied) {
      this.discardEditor();
      this.coordinator.adopt(disk.contents);
    } else if (this.coordinator.hasPendingWork()) {
      // No edit was needed (the editor already held the disk text), so no change was adopted.
      this.coordinator.adopt(disk.contents);
    }
    this.base = { kind: "present", version: disk.version, contents: disk.contents };
    this.deletedOnDisk = false;
    this.clearConflict();
    this.publish();
  }

  /** The file is gone and the user has nothing unsaved in it: show that instead of stale text. */
  private markDeletedOnDisk(): void {
    this.discardEditor();
    if (this.coordinator.hasPendingWork()) this.coordinator.discardPendingSave();
    this.base = { kind: "missing" };
    this.deletedOnDisk = true;
    this.clearConflict();
    this.publish();
  }

  /** Drops the editor's document so the next attach seeds it from the file query. */
  private discardEditor(): void {
    this.editorInstance?.cleanUp();
    this.editorInstance = null;
    this.editorChangedDocument = false;
    this.currentCacheKey = createSessionCacheKey(this.cwd);
  }
}
