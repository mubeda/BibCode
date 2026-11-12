import type {
  TerminalAttachStreamEvent,
  TerminalConsoleTheme,
  TerminalGeneration,
  TerminalSessionSnapshot,
  TerminalSize,
} from "@bibcode/contracts";

import {
  createTerminalTranscript,
  DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
} from "./terminalTranscript.ts";

/**
 * Where a size sits in the server's order: the sequence of the event or snapshot that set it
 * and the process it belongs to, each absent when the server did not send one. A resize
 * request's answer names the sequence its acknowledgement carries (#348).
 */
export interface TerminalSizePosition {
  readonly sequence?: number;
  readonly generation?: TerminalGeneration;
}

export type TerminalRenderSignal =
  | ({
      readonly type: "reset";
      readonly snapshot: string;
      readonly size?: TerminalSize;
      readonly oscColorResponderActive?: boolean;
      readonly firstAttachmentGrant?: boolean;
    } & TerminalSizePosition)
  | ({ readonly type: "resized"; readonly size: TerminalSize } & TerminalSizePosition)
  /**
   * The renderer's own attach stream delivered its first snapshot, at a state another stream
   * already applied: its claim is registered now, so the renderer may claim (#348).
   */
  | ({ readonly type: "attached"; readonly size?: TerminalSize } & TerminalSizePosition)
  | { readonly type: "delta"; readonly data: string };

export interface TerminalMetadataSnapshot {
  readonly status: TerminalSessionSnapshot["status"] | "closed";
  readonly error: string | null;
  readonly consoleTheme: TerminalConsoleTheme | null;
  /** Bumps whenever a server snapshot replaces the transcript. */
  readonly generation: number;
  /** Bumps for lifecycle metadata changes, never for output, activity, or resizing. */
  readonly revision: number;
}

export const EMPTY_TERMINAL_METADATA_SNAPSHOT = Object.freeze<TerminalMetadataSnapshot>({
  status: "closed",
  error: null,
  consoleTheme: null,
  generation: 0,
  revision: 0,
});

export interface TerminalTranscriptRuntime {
  /**
   * `source` identifies the attach stream the event came from (one object per stream), with
   * the size claim it was opened with. Several streams can feed one runtime, so an event
   * another stream already delivered is skipped.
   */
  ingest(event: TerminalAttachStreamEvent, source?: TerminalStreamSource): void;
  /** `source`'s stream ended: it no longer orders the others. */
  releaseSource(source: TerminalStreamSource): void;
  attachRenderer(
    sink: (signal: TerminalRenderSignal) => void,
    sizeClaim?: string,
  ): { detach(): void };
  snapshot(): string;
  metadata(): TerminalMetadataSnapshot;
  subscribeMetadata(listener: (metadata: TerminalMetadataSnapshot) => void): () => void;
}

export interface TerminalStreamSource {
  readonly sizeClaim?: string;
}

export function createTerminalTranscriptRuntime(
  options: { readonly maxBufferBytes?: number } = {},
): TerminalTranscriptRuntime {
  const transcript = createTerminalTranscript(
    options.maxBufferBytes ?? DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
  );
  const rendererClaims = new Map<(signal: TerminalRenderSignal) => void, string | undefined>();
  const metadataListeners = new Set<(metadata: TerminalMetadataSnapshot) => void>();
  const pendingEvents: Array<TerminalAttachStreamEvent> = [];
  const pendingSources: Array<TerminalStreamSource> = [];
  let pendingHead = 0;
  // Server sequences only grow within one process; a restart starts over. Each stream is in
  // order, but several streams (a remount's old and new attachment, two viewports) can feed
  // this runtime. The server's generation orders processes; the process each stream last
  // reset to fences its events, and the highest sequence applied skips what another stream
  // already delivered. Sizes reach only claimed streams, so they keep their own watermark.
  const defaultSource = {};
  const sourceProcesses = new WeakMap<object, ProcessKey>();
  const leftBoots = new Set<string>();
  let processKey: ProcessKey | undefined;
  // `processKey` was closed by a close naming its generation; an older server's close is not
  // fenced, since its processes are told apart only by a pid that can be reused.
  let processClosed = false;
  let appliedSequence: number | undefined;
  let sizeSequence: number | undefined;
  let sequenceSource: object | undefined;
  // Live claimed streams on the current process. Each carries every size in order, so while
  // one is live it orders rendering; a stream without sizes merging ahead would lay output
  // out at a size the server had already replaced (#348).
  const claimedSources = new Set<object>();
  let processingEvents = false;
  let metadata = EMPTY_TERMINAL_METADATA_SNAPSHOT;
  let size: TerminalSize | undefined;
  let oscColorResponderActive = false;
  let firstAttachmentGrantClaim: string | null = null;
  let renderers: ReadonlyArray<
    readonly [(signal: TerminalRenderSignal) => void, string | undefined]
  > = [];

  const fanRender = (signal: TerminalRenderSignal | ((claim?: string) => TerminalRenderSignal)) => {
    const currentRenderers = renderers;
    for (const [sink, claim] of currentRenderers) {
      try {
        sink(typeof signal === "function" ? signal(claim) : signal);
      } catch {
        // Renderer failures are isolated from transcript ingestion and other renderers.
      }
    }
  };

  const notifyMetadata = () => {
    for (const listener of Array.from(metadataListeners)) {
      try {
        listener(metadata);
      } catch {
        // A faulty observer must not prevent other observers from receiving lifecycle state.
      }
    }
  };

  const updateMetadata = (
    next: Pick<TerminalMetadataSnapshot, "status" | "error"> & {
      readonly consoleTheme?: TerminalConsoleTheme | null;
    },
    newGeneration: boolean,
  ) => {
    metadata = Object.freeze({
      status: next.status,
      error: next.error,
      consoleTheme: next.consoleTheme === undefined ? metadata.consoleTheme : next.consoleTheme,
      generation: metadata.generation + (newGeneration ? 1 : 0),
      revision: metadata.revision + 1,
    });
  };

  const sizePosition = (): TerminalSizePosition => ({
    ...(sizeSequence === undefined ? {} : { sequence: sizeSequence }),
    ...(processKey?.generation ? { generation: processKey.generation } : {}),
  });

  const createResetSignalAndConsumeGrant = (
    snapshot: string,
    rendererClaim?: string,
  ): TerminalRenderSignal => {
    const firstAttachmentGrant =
      firstAttachmentGrantClaim !== null && firstAttachmentGrantClaim === rendererClaim;
    // A cached transcript can hydrate many mounts. The first-attachment grant
    // is consumed only by its owner, once, rather than replayed with the cache.
    if (firstAttachmentGrant) firstAttachmentGrantClaim = null;
    return {
      type: "reset",
      snapshot,
      ...(size ? { size } : {}),
      ...(oscColorResponderActive ? { oscColorResponderActive: true } : {}),
      ...(firstAttachmentGrant ? { firstAttachmentGrant: true } : {}),
      ...sizePosition(),
    };
  };

  /**
   * Replaces the transcript and state with `snapshot`'s. A resync (the server's catch-up
   * after its stream fell behind) is the same attachment and process, so it keeps the
   * generation, and with it any input still waiting to be written.
   */
  const resetTranscript = (snapshot: TerminalSessionSnapshot, newGeneration = true) => {
    transcript.clear();
    transcript.append(snapshot.history);
    size = snapshot.size;
    oscColorResponderActive = snapshot.oscColorResponderActive ?? false;
    // A resync is the same attachment: a startup grant not used yet stays its owner's.
    if (newGeneration) {
      firstAttachmentGrantClaim = snapshot.firstAttachmentGrant ? (size?.sizeClaim ?? null) : null;
    }
    updateMetadata(
      { status: snapshot.status, error: null, consoleTheme: snapshot.consoleTheme ?? null },
      newGeneration,
    );
    const history = transcript.snapshot();
    fanRender((claim) => createResetSignalAndConsumeGrant(history, claim));
    notifyMetadata();
  };

  /** Moves to `next`, never back to a server instance this runtime has left. */
  const enterProcess = (next: ProcessKey) => {
    if (processKey?.generation && processKey.boot !== next.boot) leftBoots.add(processKey.boot);
    if (!sameProcess(processKey, next)) claimedSources.clear();
    processKey = next;
  };

  /** Tells the renderer holding `source`'s claim that its stream is attached. */
  const announceAttached = (source: TerminalStreamSource) => {
    if (source.sizeClaim === undefined) return;
    for (const [sink, claim] of renderers) {
      if (claim !== source.sizeClaim) continue;
      try {
        sink({ type: "attached", ...(size ? { size } : {}), ...sizePosition() });
      } catch {
        // Renderer failures are isolated from transcript ingestion and other renderers.
      }
    }
  };

  const accept = (event: TerminalAttachStreamEvent, source: TerminalStreamSource): boolean => {
    if (event.type === "snapshot" || event.type === "restarted") {
      const { sequence } = event.snapshot;
      const key = processKeyOf(event.snapshot, processKey);
      const firstFromSource = !sourceProcesses.has(source);
      sourceProcesses.set(source, key);
      const order = compareProcesses(key, processKey, leftBoots);
      // A delayed state of an earlier process, from a stream that has not caught up, or of
      // the closed one: only a newer process reopens a closed terminal.
      if (order < 0 || (order === 0 && processClosed)) return false;
      if (
        order === 0 &&
        source !== sequenceSource &&
        sequence !== undefined &&
        appliedSequence !== undefined &&
        sequence <= appliedSequence
      ) {
        // Another stream already applied this transcript, but sizes reach only claimed streams
        // and an acknowledgement only its requester: a catch-up can carry the one this
        // runtime lacks, which the requester waits for (#348).
        const snapshotSize = event.snapshot.size;
        if (snapshotSize !== undefined && (sizeSequence === undefined || sequence > sizeSequence)) {
          sizeSequence = sequence;
          processEvent({
            type: "resized",
            threadId: event.snapshot.threadId,
            terminalId: event.snapshot.terminalId,
            sequence,
            size: snapshotSize,
          });
        }
        if (source.sizeClaim !== undefined) claimedSources.add(source);
        // Another stream already applied this state of the same process.
        if (event.snapshot.firstAttachmentGrant) {
          firstAttachmentGrantClaim = event.snapshot.size?.sizeClaim ?? null;
        }
        // A remount's new stream registered its claim; nothing else about the state is new.
        if (firstFromSource && event.type === "snapshot" && event.resync !== true) {
          announceAttached(source);
        }
        return false;
      }
      enterProcess(key);
      if (source.sizeClaim !== undefined) claimedSources.add(source);
      processClosed = false;
      appliedSequence = sequence;
      sizeSequence = sequence;
      sequenceSource = source;
      return true;
    }
    // A close names its process: an attachment that fell behind reports it at its own
    // cursor, so it is applied by generation, never against another stream's sequence.
    if (event.type === "closed" && event.generation !== undefined) {
      const key = generationKey(event.generation);
      const order = compareProcesses(key, processKey, leftBoots);
      if (order < 0 || (order === 0 && metadata.status === "closed")) return false;
      // The close outranks every process before it, and its own, so their delayed states stay
      // out. The server issues a re-created terminal a newer process.
      enterProcess(key);
      processClosed = true;
      return true;
    }
    // A stream still on an earlier process (it has not seen the restart yet).
    if (!sameProcess(sourceProcesses.get(source), processKey)) return false;
    const sequence = event.sequence;
    if (sequence === undefined) return true;
    // A live claimed stream delivers this event too, behind the sizes published before it.
    // shortcut: what this stream drops while a claimed stream is live and that stream had not
    // delivered when it ended is lost until the next snapshot. The panel mixes them only when
    // the ownership capability arrives after a claimless attach, until the old stream ends.
    // A client cannot ask the server for a resync (it sends one only to a lagging stream);
    // upgrade with a bounded replay of the dropped events if streams mix more often.
    if (source.sizeClaim === undefined && claimedSources.size > 0) return false;
    if (event.type === "resized") {
      if (sizeSequence !== undefined && sequence <= sizeSequence) return false;
      sizeSequence = sequence;
      if (appliedSequence === undefined || sequence > appliedSequence) {
        appliedSequence = sequence;
        sequenceSource = source;
      }
      return true;
    }
    if (appliedSequence !== undefined && sequence <= appliedSequence) {
      return source === sequenceSource;
    }
    appliedSequence = sequence;
    sequenceSource = source;
    return true;
  };

  const processEvent = (event: TerminalAttachStreamEvent) => {
    switch (event.type) {
      case "snapshot":
        resetTranscript(event.snapshot, event.resync !== true);
        return;
      case "restarted":
        resetTranscript(event.snapshot);
        return;
      case "output":
        transcript.append(event.data);
        fanRender({ type: "delta", data: event.data });
        return;
      case "resized":
        size = event.size;
        if (size.sizeClaim !== firstAttachmentGrantClaim) firstAttachmentGrantClaim = null;
        fanRender({ type: "resized", size, ...sizePosition() });
        return;
      case "cleared":
        transcript.clear();
        firstAttachmentGrantClaim = null;
        updateMetadata({ status: metadata.status, error: null }, false);
        fanRender((claim) => createResetSignalAndConsumeGrant("", claim));
        notifyMetadata();
        return;
      case "exited":
        updateMetadata({ status: "exited", error: null }, false);
        notifyMetadata();
        return;
      case "closed":
        updateMetadata({ status: "closed", error: null }, false);
        notifyMetadata();
        return;
      case "error":
        updateMetadata({ status: "error", error: event.message }, false);
        notifyMetadata();
        return;
      case "activity":
        return;
    }
  };

  return {
    ingest(event, source = defaultSource) {
      pendingEvents.push(event);
      pendingSources.push(source);
      if (processingEvents) return;

      processingEvents = true;
      try {
        while (pendingHead < pendingEvents.length) {
          const next = pendingEvents[pendingHead]!;
          if (accept(next, pendingSources[pendingHead]!)) processEvent(next);
          pendingHead += 1;
        }
      } finally {
        pendingEvents.length = 0;
        pendingSources.length = 0;
        pendingHead = 0;
        processingEvents = false;
      }
    },
    releaseSource(source) {
      claimedSources.delete(source);
    },
    attachRenderer(sink, rendererClaim) {
      let attached = true;
      rendererClaims.set(sink, rendererClaim);
      renderers = Array.from(rendererClaims);
      try {
        sink(createResetSignalAndConsumeGrant(transcript.snapshot(), rendererClaim));
      } catch {
        // Initial hydration obeys the same observer isolation as live fan-out.
      }
      return {
        detach() {
          if (!attached) return;
          attached = false;
          rendererClaims.delete(sink);
          renderers = Array.from(rendererClaims);
        },
      };
    },
    snapshot() {
      return transcript.snapshot();
    },
    metadata() {
      return metadata;
    },
    subscribeMetadata(listener) {
      let subscribed = true;
      metadataListeners.add(listener);
      return () => {
        if (!subscribed) return;
        subscribed = false;
        metadataListeners.delete(listener);
      };
    },
  };
}

/**
 * The process a state belongs to. The server's generation orders processes; an older server
 * sends none, so its pid only tells processes apart, and an exited snapshot without one
 * belongs to the last process.
 */
interface ProcessKey {
  readonly boot: string;
  readonly process: number;
  readonly generation?: TerminalGeneration;
}

function generationKey(generation: TerminalGeneration): ProcessKey {
  return { boot: generation.boot, process: generation.process, generation };
}

function processKeyOf(
  snapshot: TerminalSessionSnapshot,
  current: ProcessKey | undefined,
): ProcessKey {
  if (snapshot.generation !== undefined) return generationKey(snapshot.generation);
  if (snapshot.pid === null && current !== undefined && current.generation === undefined) {
    return current;
  }
  return { boot: `pid:${snapshot.pid ?? "none"}`, process: 0 };
}

/** Before any snapshot, neither stream nor runtime names a process, and that matches. */
function sameProcess(a: ProcessKey | undefined, b: ProcessKey | undefined): boolean {
  return (
    a === b || (a !== undefined && b !== undefined && a.boot === b.boot && a.process === b.process)
  );
}

/** Positive when `next` is newer than `current`, zero when it is the same process. */
function compareProcesses(
  next: ProcessKey,
  current: ProcessKey | undefined,
  leftBoots: ReadonlySet<string>,
): number {
  if (current === undefined) return 1;
  if (next.boot === current.boot) return next.process - current.process;
  // A server instance this runtime moved on from never comes back; any other is newer.
  return leftBoots.has(next.boot) ? -1 : 1;
}
