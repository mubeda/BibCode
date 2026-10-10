// @effect-diagnostics nodeBuiltinImport:off - Passive QA observation consumes copied original wire bytes only.
import { createBrowserFollowupReplyGate } from "./release-visual-browser-followups-transport.ts";
import {
  admitImportEvidenceRecipient,
  sealImportFailure,
  publishImportFailure,
} from "./ci-import-private-evidence.ts";

export type ImportEvidenceStatus =
  | "disabled"
  | "not-observed"
  | "pending"
  | "success"
  | "failure-encrypted"
  | "failure-omitted";
type Direction = "request" | "reply";
type Gate = ReturnType<typeof createBrowserFollowupReplyGate>;
interface Wire {
  readonly gate: Gate;
  requestHeader: Buffer;
  replyHeader: Buffer;
  waitingClient: Buffer;
  requestReady: boolean;
  replyReady: boolean;
  upgraded: boolean;
  ignored: boolean;
  renderer: boolean;
  offered: readonly string[];
  protocol: string | null;
}
const headerLimit = 16_384;
const frameLimit = 1_048_576;
const failureLimit = 262_144;
const refused = () => new Error("Private import evidence omitted.");

/** Observe only the pinned import's original reply. No timing, admission, forwarding, or retry effect. */
export function createImportEvidenceOwner(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly evidenceRoot: string;
  readonly platform: string;
}) {
  let admission: ReturnType<typeof admitImportEvidenceRecipient> = null;
  try {
    admission = admitImportEvidenceRecipient(input.env, input.platform);
  } catch {
    /* Optional evidence. */
  }
  let phase: ImportEvidenceStatus = admission === null ? "disabled" : "not-observed";
  let closed = false;
  let project: string | null = null;
  let bound: { readonly connection: string; readonly requestId: string } | null = null;
  const wires = new Map<string, Wire>();
  const terminal = () =>
    phase === "success" || phase === "failure-encrypted" || phase === "failure-omitted";
  const clearWire = (wire: Wire) => {
    wire.ignored = true;
    wire.gate.close();
    wire.requestHeader.fill(0);
    wire.replyHeader.fill(0);
    wire.waitingClient.fill(0);
    wire.requestHeader = Buffer.alloc(0);
    wire.replyHeader = Buffer.alloc(0);
    wire.waitingClient = Buffer.alloc(0);
    wire.offered = [];
    wire.protocol = null;
    wire.renderer = false;
  };
  const close = () => {
    closed = true;
    for (const wire of wires.values()) clearWire(wire);
    wires.clear();
    project = null;
    bound = null;
  };
  const observeLogical = (
    connection: string,
    direction: Direction,
    value: Readonly<Record<string, unknown>>,
  ) => {
    const wire = wires.get(connection);
    if (closed || terminal() || admission === null || !wire?.upgraded) return;
    if (direction === "request") {
      if (value._tag === "Request" && value.tag === "subscribeServerConfig") {
        wire.renderer = true;
        return;
      }
      const payload = value.payload;
      if (
        bound !== null ||
        project === null ||
        !wire.renderer ||
        value._tag !== "Request" ||
        value.tag !== "orchestration.dispatchCommand" ||
        typeof value.id !== "string" ||
        !/^[0-9]{1,16}$/.test(value.id) ||
        payload === null ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        !("type" in payload) ||
        payload.type !== "project.create" ||
        !("workspaceRoot" in payload) ||
        payload.workspaceRoot !== project
      )
        return;
      bound = { connection, requestId: value.id };
      phase = "pending";
      return;
    }
    if (
      bound === null ||
      bound.connection !== connection ||
      value._tag !== "Exit" ||
      value.requestId !== bound.requestId
    )
      return;
    const exit = value.exit;
    if (exit === null || typeof exit !== "object" || Array.isArray(exit) || !("_tag" in exit))
      return;
    if (exit._tag === "Success") {
      phase = "success";
      return;
    }
    if (exit._tag !== "Failure") return;
    phase = "failure-omitted";
    let plaintext: Buffer | null = null;
    try {
      const selected = JSON.stringify({ _tag: "Exit", requestId: bound.requestId, exit });
      if (Buffer.byteLength(selected, "utf8") > failureLimit) return;
      plaintext = Buffer.from(selected, "utf8");
      const envelope = sealImportFailure(admission, plaintext);
      publishImportFailure(input.evidenceRoot, envelope);
      phase = "failure-encrypted";
    } catch {
      /* Evidence failure never replaces the original import reply or deadline. */
    } finally {
      plaintext?.fill(0);
    }
  };
  const newWire = (connection: string): Wire => ({
    gate: createBrowserFollowupReplyGate({
      observeOriginal: (direction, value) => observeLogical(connection, direction, value),
    }),
    requestHeader: Buffer.alloc(0),
    replyHeader: Buffer.alloc(0),
    waitingClient: Buffer.alloc(0),
    requestReady: false,
    replyReady: false,
    upgraded: false,
    ignored: false,
    renderer: false,
    offered: [],
    protocol: null,
  });
  const readHeader = (wire: Wire, direction: Direction, bytes: Buffer): Buffer | null => {
    const previous = direction === "request" ? wire.requestHeader : wire.replyHeader;
    const pending = Buffer.concat([previous, bytes]);
    previous.fill(0);
    const end = pending.indexOf("\r\n\r\n");
    if (end < 0) {
      if (pending.length > headerLimit) {
        pending.fill(0);
        throw refused();
      }
      if (direction === "request") wire.requestHeader = pending;
      else wire.replyHeader = pending;
      return null;
    }
    if (end + 4 > headerLimit) {
      pending.fill(0);
      throw refused();
    }
    try {
      const header = pending.subarray(0, end + 4).toString("ascii");
      const fields = header.split("\r\n");
      const values = (name: string) =>
        fields
          .slice(1)
          .filter((field) => field.toLowerCase().startsWith(name + ":"))
          .map((field) => field.slice(field.indexOf(":") + 1).trim());
      const upgrade = values("upgrade"),
        connections = values("connection"),
        protocols = values("sec-websocket-protocol");
      if (
        upgrade.length !== 1 ||
        upgrade[0]?.toLowerCase() !== "websocket" ||
        !connections.some((value) =>
          value.split(",").some((token) => token.trim().toLowerCase() === "upgrade"),
        )
      )
        throw refused();
      if (direction === "request") {
        if (!/^GET [^ \r\n]+ HTTP\/1\.[01]$/.test(fields[0] ?? "")) throw refused();
        wire.offered = protocols.flatMap((value) => value.split(",").map((token) => token.trim()));
        if (
          wire.offered.length > 32 ||
          wire.offered.some((token) => !/^[A-Za-z0-9.!#$%&'*+^_`|~-]{1,128}$/.test(token))
        )
          throw refused();
        wire.requestReady = true;
        wire.requestHeader = Buffer.alloc(0);
      } else {
        if (!/^HTTP\/1\.[01] 101(?: |$)/.test(fields[0] ?? "") || protocols.length > 1)
          throw refused();
        wire.protocol = protocols[0] ?? null;
        wire.replyReady = true;
        wire.replyHeader = Buffer.alloc(0);
      }
      return Buffer.from(pending.subarray(end + 4));
    } finally {
      pending.fill(0);
    }
  };
  const consume = (wire: Wire, direction: Direction, bytes: Buffer) => {
    if (bytes.length === 0) return;
    if (direction === "request") wire.gate.client(bytes);
    else wire.gate.server(bytes);
  };
  const observeData = (connection: string, direction: Direction, bytes: Uint8Array) => {
    if (closed || admission === null || terminal()) return;
    let wire: Wire | undefined;
    try {
      if (
        typeof connection !== "string" ||
        connection.length === 0 ||
        connection.length > 128 ||
        (direction !== "request" && direction !== "reply") ||
        !(bytes instanceof Uint8Array) ||
        bytes.length === 0
      )
        return;
      wire = wires.get(connection);
      if (bytes.length > frameLimit) throw refused();
      if (!wire) {
        if (wires.size >= 128) return;
        wire = newWire(connection);
        wires.set(connection, wire);
      }
      if (wire.ignored) return;
      let remaining: Buffer = Buffer.from(bytes);
      if (!(direction === "request" ? wire.requestReady : wire.replyReady)) {
        const body = readHeader(wire, direction, remaining);
        remaining.fill(0);
        if (body === null) return;
        remaining = body;
      }
      if (!wire.upgraded && wire.requestReady && wire.replyReady) {
        wire.gate.selectProtocol(wire.offered, wire.protocol);
        wire.upgraded = true;
        wire.offered = [];
        wire.protocol = null;
        const waiting = wire.waitingClient;
        wire.waitingClient = Buffer.alloc(0);
        try {
          consume(wire, "request", waiting);
        } finally {
          waiting.fill(0);
        }
      }
      try {
        if (!wire.upgraded) {
          if (direction !== "request" || wire.waitingClient.length + remaining.length > frameLimit)
            throw refused();
          const waiting = Buffer.concat([wire.waitingClient, remaining]);
          wire.waitingClient.fill(0);
          wire.waitingClient = waiting;
        } else consume(wire, direction, remaining);
      } finally {
        remaining.fill(0);
      }
      if (terminal()) close();
    } catch {
      if (wire) clearWire(wire);
      if (bound?.connection === connection && phase === "pending") {
        phase = "failure-omitted";
        close();
      }
    }
  };
  return {
    pinProject: (value: string) => {
      if (
        !closed &&
        admission !== null &&
        project === null &&
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= 4096
      )
        project = value;
    },
    observeData,
    connectionClosed: (connection: string) => {
      const wire = wires.get(connection);
      if (wire) {
        clearWire(wire);
        wires.delete(connection);
      }
    },
    status: (): ImportEvidenceStatus => phase,
    close,
  };
}
