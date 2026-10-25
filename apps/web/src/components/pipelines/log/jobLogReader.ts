/**
 * Reads one job's log in byte windows and feeds them to the parser. It owns the read
 * budget the design states for a log:
 *
 * - opening reads the tail (`?at=` reads the window at that line instead), then, while
 *   a running job's answer fills a window, at most three catch-up reads;
 * - a running job is followed by a `follow` read at the loaded end 5 s after the last
 *   read, while the page is visible; a job with no output yet re-reads its tail;
 * - `too_large_live` keeps the loaded head and reads nothing until the job finishes;
 * - when the job turns terminal, one final read, then nothing;
 * - Load earlier reads the window before the loaded start, up to 16 MiB in all.
 *
 * Only one read is in flight at a time. Framework-free: the hook binds it to React.
 */
import type {
  PipelinesJobLog,
  PipelinesLogFrom,
  PipelinesLogUnavailableReason,
  PipelinesRefresh,
  PullRequestsOperationError,
} from "@bibcode/contracts";
import type { JobLogLayout } from "./jobLog.parse";
import type { JobLogEngine } from "./jobLogEngine";

/** A chunk this large probably stopped at the server's window (512,000 or 1 MiB bytes). */
export const LOG_FULL_WINDOW = 500_000;
/** Reads after the opening one while a running job's log still fills a window. */
export const LOG_CATCH_UP_READS = 3;
/** How often a running job's log is followed. */
export const LOG_FOLLOW_MS = 5_000;
/** The most log text one job view keeps. */
export const LOG_CLIENT_CAP = 16 * 1024 * 1024;

/**
 * Whether a finished log has text after the loaded window (a line link opens on a window in
 * the middle) that the page may still hold: reads stop at `LOG_CLIENT_CAP` either way.
 */
export function readerCanLoadLater(state: JobLogReaderState, live: boolean): boolean {
  const { range, complete, phase, busy, laterExhausted } = state;
  return (
    range !== null &&
    range.end - range.start < LOG_CLIENT_CAP &&
    !complete &&
    !live &&
    phase === "done" &&
    !busy &&
    !laterExhausted
  );
}

export interface LogReadInput {
  readonly from: PipelinesLogFrom;
  readonly refresh: PipelinesRefresh;
}

export type LogReadAnswer =
  | { readonly _tag: "answer"; readonly log: PipelinesJobLog }
  | {
      readonly _tag: "failure";
      readonly error: PullRequestsOperationError | null;
      readonly message: string;
    }
  | { readonly _tag: "interrupted" };

export type JobLogPhase =
  | "opening"
  | "catching_up"
  /** A running job: the next follow read waits for `tick`. */
  | "following"
  /** A running job with no output yet: `tick` re-reads its tail. */
  | "waiting_start"
  /** `too_large_live`: the head stays, nothing is read until the job finishes. */
  | "paused_large"
  | "done"
  | "unavailable"
  | "failed";

export interface JobLogReaderState {
  readonly phase: JobLogPhase;
  readonly busy: boolean;
  readonly loadingEarlier: boolean;
  readonly unavailable: {
    readonly reason: PipelinesLogUnavailableReason;
    readonly url: string | null;
  } | null;
  readonly error: PullRequestsOperationError | null;
  readonly errorMessage: string | null;
  readonly truncatedHead: boolean;
  readonly totalBytes: number | null;
  /** The loaded byte range, or null before any text. */
  readonly range: { readonly start: number; readonly end: number } | null;
  readonly complete: boolean;
  /**
   * Why Load earlier is not offered while text before the loaded start exists: `cap`,
   * the view holds its 16 MiB; `start`, the host keeps nothing earlier.
   */
  readonly earlierLimit: "cap" | "start" | null;
  /** A finished log's read past the loaded end brought nothing more. */
  readonly laterExhausted: boolean;
}

export const INITIAL_JOB_LOG_READER_STATE: JobLogReaderState = {
  phase: "opening",
  busy: false,
  loadingEarlier: false,
  unavailable: null,
  error: null,
  errorMessage: null,
  truncatedHead: false,
  totalBytes: null,
  range: null,
  complete: false,
  earlierLimit: null,
  laterExhausted: false,
};

type ReadKind = "open" | "catch_up" | "follow" | "final" | "earlier" | "later";

interface PendingRead {
  readonly kind: ReadKind;
  readonly input: LogReadInput;
  /** The job was running when the read was sent. */
  readonly live: boolean;
  /** The answer starts a fresh log (open, a reopened tail), not later text. */
  readonly replace: boolean;
  readonly startsAtLine: boolean;
}

export interface JobLogReaderOptions {
  readonly read: (input: LogReadInput, signal: AbortSignal) => Promise<LogReadAnswer>;
  readonly engine: JobLogEngine;
  readonly live: boolean;
  /** A line link's byte offset: the log opens on the window that starts there. */
  readonly at: number | null;
  readonly onLayout: (layout: JobLogLayout) => void;
  readonly onState: (state: JobLogReaderState) => void;
}

export class JobLogReader {
  private state: JobLogReaderState = INITIAL_JOB_LOG_READER_STATE;
  private live: boolean;
  private visible = true;
  private followTimer: ReturnType<typeof setTimeout> | null = null;
  private catchUps = 0;
  private lastRead: PendingRead | null = null;
  private controller: AbortController | null = null;
  private disposed = false;

  constructor(private readonly options: JobLogReaderOptions) {
    this.live = options.live;
  }

  get current(): JobLogReaderState {
    return this.state;
  }

  open(): void {
    this.catchUps = 0;
    const at = this.options.at;
    void this.run({
      kind: "open",
      input: {
        from: at === null ? { _tag: "tail" } : { _tag: "offset", offset: at },
        refresh: "user",
      },
      live: this.live,
      replace: true,
      startsAtLine: at !== null,
    });
  }

  /** The job's status changed; a running job that finished gets one final read. */
  setLive(live: boolean): void {
    const wasLive = this.live;
    this.live = live;
    this.schedule();
    if (!wasLive || live || this.state.busy) return;
    this.finalRead();
  }

  /** Follow reads run only while the page is visible. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.schedule();
  }

  /**
   * Arms the next follow read 5 s after the last one settled, while a running job is
   * followed and the page is visible; disarms it otherwise.
   */
  private schedule(): void {
    const followable =
      !this.disposed &&
      this.live &&
      this.visible &&
      !this.state.busy &&
      (this.state.phase === "following" || this.state.phase === "waiting_start");
    if (!followable) {
      if (this.followTimer !== null) clearTimeout(this.followTimer);
      this.followTimer = null;
      return;
    }
    if (this.followTimer !== null) return;
    this.followTimer = setTimeout(() => {
      this.followTimer = null;
      this.tick();
    }, LOG_FOLLOW_MS);
  }

  /** Sends the next follow read now; the reader's own timer calls it every 5 s. */
  tick(): void {
    if (this.state.busy || !this.live) return;
    if (this.state.phase === "following" && this.state.range !== null)
      void this.run(this.followRead(this.state.range.end, "follow"));
    else if (this.state.phase === "waiting_start")
      void this.run({
        kind: "follow",
        input: { from: { _tag: "tail" }, refresh: "follow" },
        live: true,
        replace: true,
        startsAtLine: false,
      });
  }

  canLoadEarlier(): boolean {
    const range = this.state.range;
    return range !== null && range.start > 0 && this.state.earlierLimit === null;
  }

  loadEarlier(): void {
    const range = this.state.range;
    if (this.state.busy || range === null || !this.canLoadEarlier()) return;
    void this.run({
      kind: "earlier",
      input: { from: { _tag: "before", offset: range.start }, refresh: "user" },
      live: this.live,
      replace: false,
      startsAtLine: false,
    });
  }

  /**
   * Whether a finished log has text after the loaded window (a line link opens on a
   * window in the middle): the view reads it when the reader scrolls to the end.
   */
  canLoadLater(): boolean {
    return readerCanLoadLater(this.state, this.live);
  }

  loadLater(): void {
    const range = this.state.range;
    if (range === null || !this.canLoadLater()) return;
    void this.run({ ...this.followRead(range.end, "later"), live: false });
  }

  /** Sends the read that failed again (Retry, or a rate limit's deadline passing). */
  retry(): void {
    const last = this.lastRead;
    const failed = this.state.error !== null || this.state.errorMessage !== null;
    if (this.state.busy || last === null || !failed) return;
    void this.run({ ...last, live: this.live });
  }

  dispose(): void {
    this.disposed = true;
    this.controller?.abort();
    this.schedule();
  }

  private followRead(offset: number, kind: ReadKind): PendingRead {
    return {
      kind,
      input: {
        from: { _tag: "offset", offset },
        // Catching up on a running log is a follow read: the server shares tails
        // and stops a too-large one only for these.
        refresh: this.live ? "follow" : "user",
      },
      live: this.live,
      replace: false,
      startsAtLine: false,
    };
  }

  private finalRead(): void {
    this.catchUps = 0;
    const { phase, range } = this.state;
    if (phase === "following" && range !== null) {
      void this.run(this.followRead(range.end, "final"));
    } else if (phase === "waiting_start" || phase === "paused_large") {
      // The finished log has an archived size, so its tail opens at the end.
      void this.run({
        kind: "final",
        input: { from: { _tag: "tail" }, refresh: "user" },
        live: false,
        replace: true,
        startsAtLine: false,
      });
    }
  }

  private update(patch: Partial<JobLogReaderState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.options.onState(this.state);
    this.schedule();
  }

  private async run(read: PendingRead): Promise<void> {
    if (this.disposed) return;
    this.lastRead = read;
    const controller = new AbortController();
    this.controller = controller;
    this.update({
      busy: true,
      loadingEarlier: read.kind === "earlier",
      ...(read.kind === "open" ? { phase: "opening" as const } : {}),
      ...(read.kind === "catch_up" ? { phase: "catching_up" as const } : {}),
    });
    const answer = await this.options.read(read.input, controller.signal);
    if (this.disposed || answer._tag === "interrupted") return;
    if (answer._tag === "failure") {
      this.update({
        busy: false,
        loadingEarlier: false,
        // A failed earlier or later read leaves the log as it was.
        ...(read.kind === "earlier" || read.kind === "later" ? {} : { phase: "failed" as const }),
        error: answer.error,
        errorMessage: answer.message,
      });
      return;
    }
    const log = answer.log;
    if (log._tag === "unavailable") {
      await this.onUnavailable(read, log.reason, log.url);
      return;
    }
    if (read.replace && this.state.range !== null) await this.options.engine.reset();
    const empty = log.text.length === 0 && this.state.range !== null && !read.replace;
    if (!empty) {
      const layout = await this.options.engine.load({
        text: log.text,
        offset: log.offset,
        nextOffset: log.nextOffset,
        firstLine: log.firstLine,
        startsAtLine: read.startsAtLine,
      });
      if (this.disposed) return;
      this.options.onLayout(layout);
    }
    const previous = read.replace ? null : this.state.range;
    const range = {
      start: Math.min(previous?.start ?? log.offset, log.offset),
      end: Math.max(previous?.end ?? log.nextOffset, log.nextOffset),
    };
    const earlierLimit =
      range.end - range.start >= LOG_CLIENT_CAP
        ? ("cap" as const)
        : read.kind === "earlier" &&
            log.offset >= (previous?.start ?? log.offset) &&
            range.start > 0
          ? ("start" as const)
          : read.replace
            ? null
            : this.state.earlierLimit;
    if (read.kind === "earlier") {
      // Earlier text says nothing about the end: completeness and size stay.
      this.update({
        busy: false,
        loadingEarlier: false,
        error: null,
        errorMessage: null,
        truncatedHead: log.truncatedHead,
        range,
        earlierLimit,
      });
      // The job finished while this read was out: the rest of its log is one read away.
      if (read.live && !this.live) this.finalRead();
      return;
    }
    const base = {
      busy: false,
      loadingEarlier: false,
      error: null,
      errorMessage: null,
      unavailable: null,
      truncatedHead: log.truncatedHead,
      totalBytes: log.totalBytes ?? this.state.totalBytes,
      range,
      complete: log.complete,
      earlierLimit,
      laterExhausted:
        read.kind === "later"
          ? log.nextOffset <= (previous?.end ?? 0)
          : read.replace
            ? false
            : this.state.laterExhausted,
    };
    if (read.kind === "later") {
      this.update({ ...base, phase: "done" });
      return;
    }
    if (log.complete) {
      this.update({ ...base, phase: "done" });
      return;
    }
    // Only a running job catches up: a finished window reads on when it is reached.
    const full = log.nextOffset - log.offset >= LOG_FULL_WINDOW;
    if (full && this.live && read.live && this.catchUps < LOG_CATCH_UP_READS) {
      this.catchUps += 1;
      this.update(base);
      void this.run(this.followRead(log.nextOffset, "catch_up"));
      return;
    }
    if (this.live) {
      this.update({ ...base, phase: "following" });
      return;
    }
    // The job finished while this read was out: the rest of its log is one read away.
    this.update({ ...base, phase: read.live ? "following" : "done" });
    if (read.live) this.finalRead();
  }

  private async onUnavailable(
    read: PendingRead,
    reason: PipelinesLogUnavailableReason,
    url: string | null,
  ): Promise<void> {
    const unavailable = { reason, url };
    const base = { busy: false, loadingEarlier: false, error: null, errorMessage: null };
    if (reason === "not_started" && this.live) {
      this.update({ ...base, phase: "waiting_start", unavailable });
      return;
    }
    if (reason === "too_large_live") {
      // The head on screen stays; the finished log opens at its end.
      this.update({ ...base, phase: "paused_large", unavailable });
      if (!this.live) this.finalRead();
      return;
    }
    if (reason === "not_started" && read.live) {
      this.update({ ...base, phase: "waiting_start", unavailable });
      this.finalRead();
      return;
    }
    if (this.state.range !== null) await this.options.engine.reset();
    this.update({ ...base, phase: "unavailable", unavailable, range: null, complete: false });
  }
}
