import type { ProjectFileVersion } from "@bibcode/contracts";

import type { FileDiskRead } from "./fileEditingSession";

/** How often the visible file's disk version is checked while the window is visible. */
export const FILE_DISK_POLL_INTERVAL_MS = 2_000;

/** The part of a `FileEditingSession` the watcher drives. */
export interface DiskWatchedSession {
  readonly relativePath: string;
  readonly watchesDisk: boolean;
  beginDiskCheck(): number | null;
  reconcileVersion(token: number, disk: ProjectFileVersion): "settled" | "read" | "stale";
  reconcileRead(token: number, read: FileDiskRead): void;
  subscribeDiskCheckRequests(listener: () => void): () => void;
}

export interface FileDiskWatcherOptions {
  readonly session: DiskWatchedSession;
  /** The disk version now, or null when the check failed (it is retried on the next tick). */
  readonly getVersion: (relativePath: string) => Promise<ProjectFileVersion | null>;
  /** Re-reads the file through its query, so every view shows the new text; null on failure. */
  readonly readFile: (relativePath: string) => Promise<FileDiskRead | null>;
  readonly intervalMs?: number;
  readonly document?: Pick<
    Document,
    "visibilityState" | "addEventListener" | "removeEventListener"
  >;
  readonly window?: Pick<Window, "addEventListener" | "removeEventListener">;
}

/**
 * Keeps the visible file's session in step with the disk: checks its version every two seconds
 * while the window is visible, and at once when the watcher starts (the file became visible),
 * the window regains focus or visibility, or the session asks (a save was refused, a turn ended).
 *
 * Checks never overlap; a request during one runs one more check after it.
 */
export class FileDiskWatcher {
  private readonly intervalMs: number;
  private readonly document: NonNullable<FileDiskWatcherOptions["document"]>;
  private readonly window: NonNullable<FileDiskWatcherOptions["window"]>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeRequests: (() => void) | null = null;
  private running = false;
  private rerun = false;
  private disposed = false;

  constructor(private readonly options: FileDiskWatcherOptions) {
    this.intervalMs = options.intervalMs ?? FILE_DISK_POLL_INTERVAL_MS;
    this.document = options.document ?? globalThis.document;
    this.window = options.window ?? globalThis.window;
  }

  start(): void {
    if (this.disposed || this.timer !== null || !this.options.session.watchesDisk) return;
    this.document.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.window.addEventListener("focus", this.handleFocus);
    this.unsubscribeRequests = this.options.session.subscribeDiskCheckRequests(this.handleRequest);
    this.timer = setInterval(() => void this.check(), this.intervalMs);
    void this.check();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribeRequests?.();
    this.unsubscribeRequests = null;
    this.document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.window.removeEventListener("focus", this.handleFocus);
  }

  /** Checks now, unless the window is hidden; resolves once this check (and any rerun) ends. */
  async check(): Promise<void> {
    if (this.disposed || this.document.visibilityState !== "visible") return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.rerun = false;
        await this.checkOnce();
      } while (this.rerun && !this.disposed);
    } finally {
      this.running = false;
    }
  }

  private readonly handleVisibilityChange = () => {
    if (this.document.visibilityState === "visible") void this.check();
  };

  private readonly handleFocus = () => void this.check();

  private readonly handleRequest = () => void this.check();

  private async checkOnce(): Promise<void> {
    const { session } = this.options;
    const token = session.beginDiskCheck();
    if (token === null) return;
    const relativePath = session.relativePath;
    const version = await this.options.getVersion(relativePath);
    if (version === null || this.disposed || session.relativePath !== relativePath) return;
    if (session.reconcileVersion(token, version) !== "read") return;
    const read = await this.options.readFile(relativePath);
    if (read === null || this.disposed || session.relativePath !== relativePath) return;
    session.reconcileRead(token, read);
  }
}
