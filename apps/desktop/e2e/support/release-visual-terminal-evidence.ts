// @effect-diagnostics nodeBuiltinImport:off - Optional owned CI evidence encrypts one bounded private refusal bundle.
import * as NodeUtil from "node:util";
import {
  admitImportEvidenceRecipient,
  sealImportFailure,
  publishImportFailure,
} from "./ci-import-private-evidence.ts";
import { terminalOscColorEnv } from "../../../web/src/components/terminalTheme.ts";
import type { createBrowserFollowupReplayObserver } from "./release-visual-browser-followups-caller-protocol.ts";

type Predecessor = NonNullable<
  ReturnType<ReturnType<typeof createBrowserFollowupReplayObserver>["privateTerminalPredecessor"]>
>;
type Capture = Parameters<
  NonNullable<Parameters<typeof createBrowserFollowupReplayObserver>[0]["observeTerminalRefusal"]>
>[0];
export type TerminalEvidenceStatus =
  | "disabled"
  | "not-observed"
  | "failure-encrypted"
  | "failure-omitted";
const refused = () => new Error("Private terminal evidence omitted.");
const entryPattern = /^[a-z0-9-]{1,40}:[0-9]{1,16}$/;
const connectionPattern = /^[a-z0-9-]{1,40}$/;
const requestPattern = /^[0-9]{1,16}$/;
const maxBytes = 256 * 1024;

function record(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    NodeUtil.types.isProxy(value)
  )
    throw refused();
  const output: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !property?.enumerable || !("value" in property)) throw refused();
    Object.defineProperty(output, key, { value: property.value, enumerable: true });
  }
  return output;
}
function payloadOwned(
  value: unknown,
  tag: "terminal.attach" | "terminal.resize",
  predecessor: Predecessor,
) {
  const payload = record(value);
  const allowed =
    tag === "terminal.attach"
      ? [
          "threadId",
          "terminalId",
          "cwd",
          "worktreePath",
          "cols",
          "rows",
          "env",
          "restartIfNotRunning",
          "sizeClaim",
          "centerPanel",
        ]
      : ["threadId", "terminalId", "cols", "rows", "sizeClaim"];
  if (
    Object.keys(payload).some((key) => !allowed.includes(key)) ||
    payload.threadId !== predecessor.baseline.threadId ||
    payload.terminalId !== predecessor.baseline.terminalId ||
    (tag === "terminal.attach" && payload.cwd !== predecessor.baseline.cwd) ||
    ("worktreePath" in payload &&
      payload.worktreePath !== null &&
      payload.worktreePath !== predecessor.baseline.cwd)
  )
    throw refused();
  if ("env" in payload) {
    const env = record(payload.env),
      colors = terminalOscColorEnv(predecessor.theme);
    if (
      Object.keys(env).length !== 3 ||
      Object.keys(colors).some((key) => env[key] !== colors[key])
    )
      throw refused();
  }
  return payload;
}
function validatePredecessor(predecessor: Predecessor | null, connection: string) {
  if (predecessor === null || !connectionPattern.test(connection)) throw refused();
  const { baseline, protocol, replay, theme } = predecessor;
  if (
    (theme !== "light" && theme !== "dark") ||
    protocol === null ||
    protocol.ambiguous !== false ||
    protocol.closed !== false ||
    protocol.failed !== false ||
    replay.closed !== false ||
    replay.failed !== false ||
    typeof baseline.threadId !== "string" ||
    !baseline.threadId ||
    typeof baseline.terminalId !== "string" ||
    !baseline.terminalId ||
    typeof baseline.cwd !== "string" ||
    !baseline.cwd ||
    !Number.isSafeInteger(baseline.pid) ||
    baseline.pid <= 0 ||
    typeof baseline.history !== "string" ||
    baseline.history.length > 65536 ||
    !Array.isArray(protocol.requests) ||
    protocol.requests.length > 128 ||
    !Array.isArray(protocol.attachments) ||
    protocol.attachments.length > 2 ||
    !Array.isArray(protocol.rendererConnections) ||
    protocol.rendererConnections.length > 128 ||
    !Array.isArray(replay.requests) ||
    replay.requests.length > 128 ||
    !Array.isArray(replay.snapshots) ||
    replay.snapshots.length > 2
  )
    throw refused();
  const renderers = new Set(protocol.rendererConnections);
  if (
    renderers.size !== protocol.rendererConnections.length ||
    !renderers.has(connection) ||
    protocol.rendererConnections.some((value) => !connectionPattern.test(value))
  )
    throw refused();
  const requests = new Map<string, (typeof protocol.requests)[number][1]>();
  for (const tuple of protocol.requests) {
    if (!Array.isArray(tuple) || tuple.length !== 2) throw refused();
    const [entry, request] = tuple;
    if (
      !entryPattern.test(entry) ||
      requests.has(entry) ||
      !renderers.has(entry.split(":")[0]!) ||
      (request.kind !== "active" && request.kind !== "interrupted") ||
      (request.tag !== "terminal.attach" && request.tag !== "terminal.resize") ||
      (request.kind === "interrupted" && request.tag !== "terminal.attach")
    )
      throw refused();
    payloadOwned(request.payload, request.tag, predecessor);
    requests.set(entry, request);
  }
  const validateSnapshot = (value: unknown) => {
    const snapshot = record(value);
    if (
      snapshot.threadId !== baseline.threadId ||
      snapshot.terminalId !== baseline.terminalId ||
      snapshot.cwd !== baseline.cwd ||
      snapshot.worktreePath !== baseline.cwd ||
      snapshot.pid !== baseline.pid ||
      snapshot.status !== "running" ||
      typeof snapshot.history !== "string" ||
      snapshot.history.length > 65536
    )
      throw refused();
  };
  const protocolConnections = new Set<string>();
  for (const [actor, attachment] of protocol.attachments) {
    const request = requests.get(attachment.entry);
    if (
      protocolConnections.has(actor) ||
      !renderers.has(actor) ||
      !attachment.entry.startsWith(actor + ":") ||
      request?.kind !== "active" ||
      request.tag !== "terminal.attach" ||
      typeof attachment.claim !== "string" ||
      record(request.payload).sizeClaim !== attachment.claim
    )
      throw refused();
    protocolConnections.add(actor);
    validateSnapshot(attachment.snapshot);
  }
  const replayRequests = new Set<string>();
  for (const [entry, actor] of replay.requests) {
    const request = requests.get(entry);
    if (
      replayRequests.has(entry) ||
      !entry.startsWith(actor + ":") ||
      !renderers.has(actor) ||
      request?.kind !== "active" ||
      request.tag !== "terminal.attach"
    )
      throw refused();
    replayRequests.add(entry);
  }
  const replayConnections = new Set<string>();
  for (const [actor, value] of replay.snapshots) {
    if (
      replayConnections.has(actor) ||
      !replayRequests.has(value.entry) ||
      !value.entry.startsWith(actor + ":") ||
      !protocolConnections.has(actor)
    )
      throw refused();
    replayConnections.add(actor);
    validateSnapshot(value.snapshot);
  }
  return { predecessor, requests };
}
function bundle(value: Capture) {
  const { predecessor, requests } = validatePredecessor(value.predecessor, value.connection);
  if (value.direction !== "request" && value.direction !== "reply") throw refused();
  const incoming = record(value.message);
  const outer =
    incoming._tag === "Request"
      ? ["_tag", "id", "tag", "payload", "headers", "traceId", "spanId", "sampled"]
      : incoming._tag === "Chunk"
        ? ["_tag", "requestId", "values", "headers"]
        : ["_tag", "requestId", "exit", "headers"];
  if (Object.keys(incoming).some((key) => !outer.includes(key))) throw refused();
  const message: Record<string, unknown> = {};
  for (const key of Object.keys(incoming))
    if (key !== "headers")
      Object.defineProperty(message, key, { value: incoming[key], enumerable: true });
  if (value.direction === "request") {
    if (
      message._tag !== "Request" ||
      typeof message.id !== "string" ||
      !requestPattern.test(message.id) ||
      (message.tag !== "terminal.attach" && message.tag !== "terminal.resize")
    )
      throw refused();
    payloadOwned(message.payload, message.tag, predecessor);
    if (
      message.tag === "terminal.resize" &&
      ![...requests.entries()].some(
        ([entry, request]) =>
          entry.startsWith(value.connection + ":") &&
          request.kind === "active" &&
          request.tag === "terminal.attach",
      )
    )
      throw refused();
  } else {
    if (
      (message._tag !== "Chunk" && message._tag !== "Exit") ||
      typeof message.requestId !== "string" ||
      !requestPattern.test(message.requestId) ||
      !requests.has(value.connection + ":" + message.requestId)
    )
      throw refused();
  }
  return { connection: value.connection, direction: value.direction, message, predecessor };
}

/** Optional sink only; its caller supplies the original first refusal and exact BEFORE-state. */
export function createTerminalEvidenceOwner(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly evidenceRoot: string;
  readonly platform: string;
}) {
  let admission: ReturnType<typeof admitImportEvidenceRecipient> = null;
  try {
    if (input.env.BIBCODE_TERMINAL_EVIDENCE_SELECTED === "true")
      admission = admitImportEvidenceRecipient(
        input.env,
        input.platform,
        "browser-owned-terminal-observer-refusal",
      );
  } catch {
    /* Optional evidence. */
  }
  let phase: TerminalEvidenceStatus = admission === null ? "disabled" : "not-observed";
  let closed = false;
  return {
    capture: (value: Capture) => {
      if (closed || admission === null || phase !== "not-observed") return;
      phase = "failure-omitted";
      let plaintext: Buffer | null = null;
      try {
        const selected = JSON.stringify(bundle(value));
        if (Buffer.byteLength(selected, "utf8") > maxBytes) return;
        plaintext = Buffer.from(selected, "utf8");
        publishImportFailure(
          input.evidenceRoot,
          sealImportFailure(admission, plaintext),
          "terminal-private",
        );
        phase = "failure-encrypted";
      } catch {
        /* The original observer error, raw bytes and caller deadline remain authoritative. */
      } finally {
        plaintext?.fill(0);
      }
    },
    status: (): TerminalEvidenceStatus => phase,
    close: () => {
      closed = true;
      admission = null;
    },
  };
}
