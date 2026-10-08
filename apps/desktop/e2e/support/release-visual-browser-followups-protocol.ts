// @effect-diagnostics nodeBuiltinImport:off - The observer decodes actual public SDK envelopes at an external raw protocol boundary.
import * as NodeModule from "node:module";
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import {
  UploadBeginInput,
  UploadBeginResult,
  UploadAppendInput,
  UploadAppendResult,
  UploadCancelInput,
} from "../../../../packages/contracts/src/uploads.ts";
import {
  TerminalAttachInput,
  TerminalAttachStreamEvent,
  TerminalResizeInput,
} from "../../../../packages/contracts/src/terminal.ts";
import type { TerminalSessionSnapshot } from "../../../../packages/contracts/src/terminal.ts";
import {
  ReviewDiffPreviewInput,
  ReviewDiffPreviewResult,
} from "../../../../packages/contracts/src/review.ts";
import {
  verifyBrowserFollowupDiff,
  verifyBrowserFollowupTerminal,
  type BrowserFollowupUploadReceipt,
} from "./release-visual-browser-followups-source.ts";
const Schema = NodeModule.createRequire(
  new URL("../../../../packages/contracts/package.json", import.meta.url),
)("effect/Schema");
const refused = () => new Error("Owned browser follow-up protocol receipt refused.");
const admitted = new Set([
  "uploads.begin",
  "uploads.append",
  "uploads.cancel",
  "terminal.attach",
  "terminal.resize",
  "review.getDiffPreview",
]);

export type BrowserInitialCardinality = "none" | "one" | "multiple";
export type BrowserInitialSizeOwner =
  | "absent"
  | "unclaimed"
  | "current-attach"
  | "foreign-claim"
  | "ambiguous"
  | "unknown";
export interface BrowserInitialProtocol {
  readonly closed: boolean;
  readonly failed: boolean;
  readonly attachRequests: BrowserInitialCardinality;
  readonly snapshots: BrowserInitialCardinality;
  readonly configAttachments: BrowserInitialCardinality;
  readonly resizeRequests: BrowserInitialCardinality;
  readonly sizeOwner: BrowserInitialSizeOwner;
}
export interface BrowserInitialReplay {
  readonly closed: boolean;
  readonly failed: boolean;
  readonly snapshots: BrowserInitialCardinality;
  readonly configSnapshots: BrowserInitialCardinality;
}
export interface BrowserInitialTransport {
  readonly closed: boolean;
  readonly failed: boolean;
  readonly upgradedWires: BrowserInitialCardinality;
  readonly configWires: BrowserInitialCardinality;
}
export interface BrowserInitialOwners {
  protocol?: () => BrowserInitialProtocol;
  replay?: () => BrowserInitialReplay;
  transport?: () => BrowserInitialTransport;
}
export interface BrowserInitialHooks {
  registerInitialOwners?: (owners: BrowserInitialOwners) => void;
  observeInitialFailure?: (error: unknown) => void;
}
export interface BrowserInitialJoin {
  readonly waitingOn: "before-focus" | "focus-predicate" | "receipt-predicate";
  readonly ui: {
    readonly windows: BrowserInitialCardinality | null;
    readonly mounts: BrowserInitialCardinality | null;
    readonly pinnedMountMatched: boolean | null;
    readonly screenClickCompleted: boolean;
    readonly activeTextareaOwned: boolean | null;
  };
  readonly transport: BrowserInitialTransport | null;
  readonly protocol: BrowserInitialProtocol | null;
  readonly replay: BrowserInitialReplay | null;
  readonly sizeOwner: BrowserInitialSizeOwner;
}
export function browserInitialCardinality(count: number): BrowserInitialCardinality {
  return count === 0 ? "none" : count === 1 ? "one" : "multiple";
}
/** Only this finite failure record crosses the existing private writer boundary. */
export function projectBrowserInitialJoin(value: unknown): BrowserInitialJoin | null {
  const fields = (input: unknown, keys: readonly string[]): Record<string, unknown> => {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      NodeUtil.types.isProxy(input)
    )
      throw refused();
    const own = Reflect.ownKeys(input);
    if (
      own.length !== keys.length ||
      !own.every((key) => typeof key === "string" && keys.includes(key))
    )
      throw refused();
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      const property = Object.getOwnPropertyDescriptor(input, key);
      if (!property?.enumerable || !Object.hasOwn(property, "value")) throw refused();
      output[key] = property.value;
    }
    return output;
  };
  const boolean = (input: unknown): boolean => {
    if (typeof input !== "boolean") throw refused();
    return input;
  };
  const nullableBoolean = (input: unknown): boolean | null =>
    input === null ? null : boolean(input);
  const cardinality = (input: unknown): BrowserInitialCardinality => {
    if (input !== "none" && input !== "one" && input !== "multiple") throw refused();
    return input;
  };
  const sizeOwner = (input: unknown): BrowserInitialSizeOwner => {
    if (
      input !== "absent" &&
      input !== "unclaimed" &&
      input !== "current-attach" &&
      input !== "foreign-claim" &&
      input !== "ambiguous" &&
      input !== "unknown"
    )
      throw refused();
    return input;
  };
  try {
    const record = fields(value, [
      "waitingOn",
      "ui",
      "transport",
      "protocol",
      "replay",
      "sizeOwner",
    ]);
    if (
      record.waitingOn !== "before-focus" &&
      record.waitingOn !== "focus-predicate" &&
      record.waitingOn !== "receipt-predicate"
    )
      return null;
    const ui = fields(record.ui, [
      "windows",
      "mounts",
      "pinnedMountMatched",
      "screenClickCompleted",
      "activeTextareaOwned",
    ]);
    let transport: BrowserInitialTransport | null = null,
      protocol: BrowserInitialProtocol | null = null,
      replay: BrowserInitialReplay | null = null;
    if (record.transport !== null) {
      const part = fields(record.transport, ["closed", "failed", "upgradedWires", "configWires"]);
      transport = Object.freeze({
        closed: boolean(part.closed),
        failed: boolean(part.failed),
        upgradedWires: cardinality(part.upgradedWires),
        configWires: cardinality(part.configWires),
      });
    }
    if (record.protocol !== null) {
      const part = fields(record.protocol, [
        "closed",
        "failed",
        "attachRequests",
        "snapshots",
        "configAttachments",
        "resizeRequests",
        "sizeOwner",
      ]);
      protocol = Object.freeze({
        closed: boolean(part.closed),
        failed: boolean(part.failed),
        attachRequests: cardinality(part.attachRequests),
        snapshots: cardinality(part.snapshots),
        configAttachments: cardinality(part.configAttachments),
        resizeRequests: cardinality(part.resizeRequests),
        sizeOwner: sizeOwner(part.sizeOwner),
      });
    }
    if (record.replay !== null) {
      const part = fields(record.replay, ["closed", "failed", "snapshots", "configSnapshots"]);
      replay = Object.freeze({
        closed: boolean(part.closed),
        failed: boolean(part.failed),
        snapshots: cardinality(part.snapshots),
        configSnapshots: cardinality(part.configSnapshots),
      });
    }
    return Object.freeze({
      waitingOn: record.waitingOn,
      ui: Object.freeze({
        windows: ui.windows === null ? null : cardinality(ui.windows),
        mounts: ui.mounts === null ? null : cardinality(ui.mounts),
        pinnedMountMatched: nullableBoolean(ui.pinnedMountMatched),
        screenClickCompleted: boolean(ui.screenClickCompleted),
        activeTextareaOwned: nullableBoolean(ui.activeTextareaOwned),
      }),
      transport,
      protocol,
      replay,
      sizeOwner: sizeOwner(record.sizeOwner),
    });
  } catch {
    return null;
  }
}

/** Keeps private protocol values in memory only; returns finite public proofs, never raw envelopes or identifiers. */
export function createBrowserFollowupProtocolObserver(
  input: {
    png: Buffer;
    cwd: string;
    threadId: string;
    terminalId: string;
    patch: () => string;
    slowTransport: () => boolean;
  } & BrowserInitialHooks,
) {
  const requests = new Map<string, { tag: string; payload: unknown }>();
  const appendEnds = new Map<string, number>();
  const rendererConnections = new Set<string>();
  const attachments = new Map<
    string,
    { entry: string; claim: string; snapshot: TerminalSessionSnapshot }
  >();
  let begin: {
    payload: typeof UploadBeginInput.Type;
    result: typeof UploadBeginResult.Type;
  } | null = null;
  let appendObserved = false,
    cancelObserved = false,
    received = 0,
    requested = 0;
  let preview: typeof ReviewDiffPreviewResult.Type | null = null;
  let closed = false;
  let terminalFailed = false;
  const initialObservation = (): BrowserInitialProtocol => {
    const values = [...attachments.values()];
    const current = values.length === 1 ? values[0] : undefined;
    const size = current?.snapshot.size;
    return Object.freeze({
      closed,
      failed: terminalFailed,
      attachRequests: browserInitialCardinality(
        [...requests.values()].filter(
          (request) =>
            request.tag === "terminal.attach" &&
            decode<TerminalAttachInput>(TerminalAttachInput, request.payload).sizeClaim != null,
        ).length,
      ),
      snapshots: browserInitialCardinality(attachments.size),
      configAttachments: browserInitialCardinality(
        [...attachments.entries()].filter(
          ([connection, value]) =>
            rendererConnections.has(connection) &&
            requests.get(value.entry)?.tag === "terminal.attach",
        ).length,
      ),
      resizeRequests: browserInitialCardinality(
        [...requests.values()].filter((request) => request.tag === "terminal.resize").length,
      ),
      sizeOwner:
        values.length === 0
          ? "absent"
          : values.length > 1
            ? "ambiguous"
            : size == null
              ? "unknown"
              : size.sizeClaim === null
                ? "unclaimed"
                : size.sizeClaim === current?.claim
                  ? "current-attach"
                  : "foreign-claim",
    });
  };
  try {
    input.registerInitialOwners?.({ protocol: initialObservation });
  } catch {
    /* Optional evidence cannot affect protocol ownership. */
  }
  const digest = NodeCrypto.createHash("sha256").update(input.png).digest("hex");
  const decode = <A>(schema: unknown, value: unknown): A =>
    Schema.decodeUnknownSync(Schema.toCodecJson(schema))(value) as A;
  const key = (connection: string, id: unknown) => {
    if (
      !/^[a-z0-9-]{1,40}$/.test(connection) ||
      typeof id !== "string" ||
      !/^[0-9]{1,16}$/.test(id)
    )
      throw refused();
    return connection + ":" + id;
  };
  let originalClaim: string | null = null;
  let secondClaim: string | null = null;
  const currentTerminal = (count: 1 | 2) => {
    const values = [...attachments.values()];
    if (closed || terminalFailed || values.length !== count) throw refused();
    for (const value of values) {
      const request = requests.get(value.entry);
      if (request?.tag !== "terminal.attach") throw refused();
      const payload = decode<typeof TerminalAttachInput.Type>(TerminalAttachInput, request.payload);
      const snapshot = value.snapshot;
      if (
        payload.threadId !== input.threadId ||
        payload.terminalId !== input.terminalId ||
        payload.cwd !== input.cwd ||
        payload.sizeClaim !== value.claim ||
        snapshot.threadId !== input.threadId ||
        snapshot.terminalId !== input.terminalId ||
        snapshot.cwd !== input.cwd ||
        snapshot.status !== "running" ||
        snapshot.pid === null ||
        !snapshot.history.includes("Owned shared terminal output")
      )
        throw refused();
    }
    if (
      count === 2 &&
      (values[0]!.claim === values[1]!.claim || values[0]!.snapshot.pid !== values[1]!.snapshot.pid)
    )
      throw refused();
    return values;
  };
  const roleTerminal = () => {
    const values = currentTerminal(2);
    if (originalClaim === null) throw refused();
    const original = values.find((value) => value.claim === originalClaim);
    const second = values.find((value) => value.claim !== originalClaim);
    if (!original || !second) throw refused();
    if (secondClaim !== null && second.claim !== secondClaim) throw refused();
    secondClaim = second.claim;
    return [original, second] as const;
  };
  const observe = (
    connection: string,
    direction: "request" | "reply",
    value: Readonly<Record<string, unknown>>,
  ) => {
    if (closed) throw refused();
    if (direction === "request") {
      if (value._tag === "Request" && value.tag === "subscribeServerConfig") {
        key(connection, value.id);
        rendererConnections.add(connection);
        return;
      }
      if (value._tag !== "Request" || typeof value.tag !== "string" || !admitted.has(value.tag))
        return;
      const entry = key(connection, value.id);
      if (requests.has(entry) || requests.size >= 128) throw refused();
      if (value.tag !== "terminal.resize") {
        requests.set(entry, { tag: value.tag, payload: value.payload });
      }
      if (value.tag === "terminal.resize") {
        try {
          const payload = decode<typeof TerminalResizeInput.Type>(
            TerminalResizeInput,
            value.payload,
          );
          const live = [...requests.entries()].filter(
            ([id, request]) => id.startsWith(connection + ":") && request.tag === "terminal.attach",
          );
          if (
            terminalFailed ||
            live.length !== 1 ||
            payload.threadId !== input.threadId ||
            payload.terminalId !== input.terminalId ||
            !payload.sizeClaim
          )
            throw refused();
          const attach = decode<typeof TerminalAttachInput.Type>(
            TerminalAttachInput,
            live[0]![1].payload,
          );
          if (
            attach.threadId !== input.threadId ||
            attach.terminalId !== input.terminalId ||
            attach.cwd !== input.cwd ||
            attach.sizeClaim !== payload.sizeClaim
          )
            throw refused();
        } catch (error) {
          terminalFailed = true;
          try {
            input.observeInitialFailure?.(error);
          } catch {
            /* Original refusal wins. */
          }
          attachments.delete(connection);
          requests.delete(entry);
          throw error;
        }
        requests.set(entry, { tag: value.tag, payload: value.payload });
      }
      if (value.tag === "uploads.append") {
        const payload = decode<typeof UploadAppendInput.Type>(UploadAppendInput, value.payload);
        if (!begin || payload.uploadId !== begin.result.uploadId || payload.offset !== requested)
          throw refused();
        const bytes = Buffer.from(payload.data, "base64");
        if (
          payload.sha256 !== undefined &&
          (payload.sha256 !== digest || payload.offset + bytes.length !== input.png.length)
        )
          throw refused();
        if (
          bytes.toString("base64") !== payload.data ||
          bytes.length === 0 ||
          !bytes.equals(input.png.subarray(payload.offset, payload.offset + bytes.length))
        )
          throw refused();
        requested = payload.offset + bytes.length;
        appendEnds.set(entry, requested);
        appendObserved = true;
      }
      return;
    }
    if (value._tag !== "Exit" && value._tag !== "Chunk") return;
    const entry = key(connection, value.requestId),
      request = requests.get(entry);
    if (!request) return;
    if (value._tag === "Exit") {
      if (request.tag === "terminal.attach") {
        if (attachments.get(connection)?.entry === entry) attachments.delete(connection);
        requests.delete(entry);
        return;
      }
      const exit = value.exit as { _tag?: unknown; value?: unknown } | null;
      if (exit?._tag !== "Success") {
        appendEnds.delete(entry);
        requests.delete(entry);
        return;
      }
      if (request.tag === "uploads.begin") {
        const payload = decode<typeof UploadBeginInput.Type>(UploadBeginInput, request.payload),
          result = decode<typeof UploadBeginResult.Type>(UploadBeginResult, exit.value);
        if (
          begin ||
          payload.target._tag !== "chat-attachment" ||
          payload.target.type !== "image" ||
          payload.target.name !== "upload-browser-followup.png" ||
          payload.target.mimeType !== "image/png" ||
          payload.sizeBytes !== input.png.length ||
          (payload.sha256 !== undefined && payload.sha256 !== digest) ||
          result.exists
        )
          throw refused();
        begin = { payload, result };
      }
      if (request.tag === "uploads.append") {
        const result = decode<typeof UploadAppendResult.Type>(UploadAppendResult, exit.value);
        const count = result.receivedBytes;
        const expected = appendEnds.get(entry);
        if (
          expected === undefined ||
          !Number.isSafeInteger(count) ||
          count !== expected ||
          count > requested ||
          count > input.png.length
        )
          throw refused();
        received = Math.max(received, count);
        appendEnds.delete(entry);
      }
      if (request.tag === "uploads.cancel") {
        const payload = decode<typeof UploadCancelInput.Type>(UploadCancelInput, request.payload);
        if (!begin || payload.uploadId !== begin.result.uploadId) throw refused();
        cancelObserved = true;
      }
      if (request.tag === "review.getDiffPreview") {
        const payload = decode<typeof ReviewDiffPreviewInput.Type>(
          ReviewDiffPreviewInput,
          request.payload,
        );
        if (payload.cwd !== input.cwd) throw refused();
        preview = decode<typeof ReviewDiffPreviewResult.Type>(ReviewDiffPreviewResult, exit.value);
      }
      requests.delete(entry);
    } else if (request.tag === "terminal.attach") {
      try {
        if (terminalFailed) throw refused();
        const payload = decode<typeof TerminalAttachInput.Type>(
          TerminalAttachInput,
          request.payload,
        );
        if (
          payload.threadId !== input.threadId ||
          payload.terminalId !== input.terminalId ||
          payload.cwd !== input.cwd ||
          !payload.sizeClaim
        )
          throw refused();
        if (!Array.isArray(value.values) || value.values.length > 64) throw refused();
        for (const raw of value.values) {
          const event = decode<typeof TerminalAttachStreamEvent.Type>(
            TerminalAttachStreamEvent,
            raw,
          );
          const current = attachments.get(connection);
          if (event.type === "snapshot") {
            if (current || attachments.size >= 2) throw refused();
            if (
              event.snapshot.threadId !== input.threadId ||
              event.snapshot.terminalId !== input.terminalId ||
              event.snapshot.cwd !== input.cwd
            )
              throw refused();
            attachments.set(connection, {
              entry,
              claim: payload.sizeClaim,
              snapshot: event.snapshot,
            });
          } else if (
            !current ||
            current.entry !== entry ||
            event.threadId !== input.threadId ||
            event.terminalId !== input.terminalId
          ) {
            throw refused();
          } else if (current && event.type === "output") {
            if (
              event.threadId !== input.threadId ||
              event.terminalId !== input.terminalId ||
              current.snapshot.history.length + event.data.length > 65536
            )
              throw refused();
            current.snapshot = {
              ...current.snapshot,
              history: current.snapshot.history + event.data,
            };
          } else if (current && event.type === "resized") {
            current.snapshot = { ...current.snapshot, size: event.size };
          } else if (
            event.type === "exited" ||
            event.type === "closed" ||
            event.type === "error" ||
            event.type === "restarted"
          )
            throw refused();
        }
      } catch (error) {
        terminalFailed = true;
        try {
          input.observeInitialFailure?.(error);
        } catch {
          /* Original refusal wins. */
        }
        attachments.delete(connection);
        requests.delete(entry);
        throw error;
      }
    } else if (request.tag === "terminal.resize") decode(TerminalResizeInput, request.payload);
  };
  return {
    observe,
    upload: (): BrowserFollowupUploadReceipt => {
      if (
        closed ||
        !begin ||
        cancelObserved ||
        !appendObserved ||
        received >= input.png.length ||
        input.png.length !== 512 * 1024 ||
        !input.slowTransport()
      )
        throw refused();
      return {
        originalPngMatched: true,
        stagedBeginObserved: true,
        appendObserved: true,
        unfinished: true,
        actualSlowTransport: true,
        bytes: input.png.length,
        sha256: digest,
      };
    },
    cancelled: () => {
      if (closed || !cancelObserved) throw refused();
    },
    diff: () => {
      if (closed || !preview) throw refused();
      return verifyBrowserFollowupDiff({
        cwd: input.cwd,
        file: "pierre-step5.ts",
        patch: input.patch(),
        result: preview,
      });
    },
    terminal: () => {
      const values = roleTerminal();
      return verifyBrowserFollowupTerminal({
        cwd: input.cwd,
        threadId: input.threadId,
        terminalId: input.terminalId,
        firstClaim: values[0]!.claim,
        secondClaim: values[1]!.claim,
        first: values[0]!.snapshot,
        second: values[1]!.snapshot,
        output: "Owned shared terminal output",
      });
    },
    fitted: () => {
      const values = roleTerminal();
      if (
        !values.every((value) => value.snapshot.size?.sizeClaim === values[1]!.claim) ||
        values[0]!.snapshot.size?.cols !== values[1]!.snapshot.size?.cols ||
        values[0]!.snapshot.size?.rows !== values[1]!.snapshot.size?.rows
      )
        throw refused();
    },
    connectionClosed: (connection: string) => {
      if (!/^[a-z0-9-]{1,40}$/.test(connection)) throw refused();
      attachments.delete(connection);
      rendererConnections.delete(connection);
      for (const entry of requests.keys())
        if (entry.startsWith(connection + ":")) {
          appendEnds.delete(entry);
          requests.delete(entry);
        }
    },
    terminalRestored: () => {
      const values = currentTerminal(1);
      if (
        values[0]!.snapshot.size?.sizeClaim !== values[0]!.claim ||
        !values[0]!.snapshot.history.includes("Owned shared terminal output") ||
        (originalClaim !== null && values[0]!.claim !== originalClaim)
      )
        throw refused();
      originalClaim = values[0]!.claim;
    },
    rendererConnection: (connection: string) => !closed && rendererConnections.has(connection),
    close: () => {
      closed = true;
      requests.clear();
      appendEnds.clear();
      attachments.clear();
      rendererConnections.clear();
      originalClaim = null;
      secondClaim = null;
      begin = null;
      preview = null;
      received = 0;
    },
  };
}
