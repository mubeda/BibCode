/** Closed QA metadata only. Wire identifiers never leave the installer's transient maps. */
export interface ChatUploadObservation {
  version: 1;
  available: true;
  socketOverflow: boolean;
  plain: {
    available: boolean;
    complete: boolean;
    created: number;
    opened: number;
    closed: number;
    requests: { begin: number; append: number; get: number; cancel: number };
    append: {
      outstanding: number;
      maximumOutstanding: number;
      maximumOutstandingPerSocket: number;
      successes: number;
      failures: number;
      abandoned: number;
      minRawBytes: number | null;
      maxRawBytes: number | null;
      maxAcknowledgedOffset: number | null;
      minReplyMs: number | null;
      maxReplyMs: number | null;
    };
    control: { ping: number; pong: number; ack: number; interrupt: number };
    capability: boolean | null;
    issues: { malformed: number; unsupported: number; overflow: number; unknown: number };
    partialMessages: number;
    maxBufferedBytesAtClose: number | null;
    closeCalls: number;
    lastCloseCode: number | null;
  };
  noise: { created: number; opened: number; closed: number; applicationMetricsAvailable: false };
  other: { created: number };
}

/** Self-contained: serialized into the pre-document QA script and tested as installed. */
function installChatUploadObserver() {
  const original = window.WebSocket;
  const countLimit = 1_000_000;
  const socketLimit = 16;
  const pendingLimit = 64;
  // UploadData permits 1,398,104 chars (one MiB raw). Include 64 KiB for the
  // real Request envelope, bounded IDs, headers and tracing fields.
  const outgoingLimit = 1_398_104 + 64 * 1024;
  const incomingLimit = 256 * 1024;
  const recordLimit = 2048;
  const maximumRaw = 1024 * 1024;
  const maximumOffset = 10 * maximumRaw;
  const maximumRecord = 65535 - 16 - 1;
  const utf8 = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const requests = { begin: 0, append: 0, get: 0, cancel: 0 };
  const control = { ping: 0, pong: 0, ack: 0, interrupt: 0 };
  const issues = { malformed: 0, unsupported: 0, overflow: 0, unknown: 0 };
  const plain = {
    created: 0,
    opened: 0,
    closed: 0,
    capability: null as boolean | null,
    maximumOutstanding: 0,
    maximumOutstandingPerSocket: 0,
    successes: 0,
    failures: 0,
    abandoned: 0,
    minRawBytes: null as number | null,
    maxRawBytes: null as number | null,
    maxAcknowledgedOffset: null as number | null,
    minReplyMs: null as number | null,
    maxReplyMs: null as number | null,
    maxBufferedBytesAtClose: null as number | null,
    closeCalls: 0,
    lastCloseCode: null as number | null,
  };
  const noise = { created: 0, opened: 0, closed: 0, applicationMetricsAvailable: false as const };
  const other = { created: 0 };
  let socketOverflow = false;
  type Pending = {
    method: keyof typeof requests | "config";
    started: number;
    offset: number;
    bytes: number;
  };
  type State = {
    pending: Map<string, Pending>;
    parts: Uint8Array[];
    bytes: number;
    records: number;
    discard: boolean;
    closed: boolean;
  };
  const states: State[] = [];
  const object = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const integer = (value: unknown, maximum = countLimit): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
  const id = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 && value.length <= 128
      ? value
      : integer(value, Number.MAX_SAFE_INTEGER)
        ? String(value)
        : null;
  const bump = (group: object, key: string) => {
    const value: unknown = Reflect.get(group, key);
    if (typeof value === "number" && value < countLimit) Reflect.set(group, key, value + 1);
    else socketOverflow = true;
  };
  const outstanding = () =>
    states.reduce(
      (sum, state) =>
        sum + [...state.pending.values()].filter((value) => value.method === "append").length,
      0,
    );
  const issue = (kind: keyof typeof issues) => bump(issues, kind);
  const reset = (state: State) => {
    state.parts = [];
    state.bytes = 0;
    state.records = 0;
    state.discard = false;
  };
  const rawSize = (value: unknown): number | null => {
    if (
      typeof value !== "string" ||
      value.length > 1_398_104 ||
      value.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
    )
      return null;
    const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
    const size = (value.length / 4) * 3 - padding;
    return size <= maximumRaw ? size : null;
  };
  const inbound = (state: State, value: unknown) => {
    const envelope = object(value);
    if (!envelope || typeof envelope._tag !== "string") {
      issue("malformed");
      return;
    }
    if (envelope._tag === "Pong") {
      bump(control, "pong");
      return;
    }
    if (envelope._tag === "Chunk") {
      if (
        id(envelope.requestId) === null ||
        !Array.isArray(envelope.values) ||
        envelope.values.length === 0 ||
        envelope.values.length > 256
      ) {
        issue("malformed");
        return;
      }
      if (state.pending.get(id(envelope.requestId)!)?.method !== "config") return;
      for (const entry of envelope.values) {
        const snapshot = object(entry);
        if (snapshot?.version !== 1 || snapshot.type !== "snapshot") continue;
        const environment = object(object(snapshot.config)?.environment);
        const capabilities = object(environment?.capabilities);
        const capability = capabilities?.attachmentStaging;
        if (typeof capability === "boolean") plain.capability = capability;
        else if (capabilities !== null && !Object.hasOwn(capabilities, "attachmentStaging"))
          plain.capability = false;
        else {
          plain.capability = null;
          issue("malformed");
        }
      }
      return;
    }
    if (envelope._tag === "Exit") {
      const key = id(envelope.requestId);
      const exit = object(envelope.exit);
      if (key === null || (exit?._tag !== "Success" && exit?._tag !== "Failure")) {
        issue("malformed");
        return;
      }
      const pending = state.pending.get(key);
      if (!pending) return; // unrelated RPC terminals do not own upload entries
      if (exit._tag === "Success" && pending.method === "append") {
        const received = object(exit.value)?.receivedBytes;
        if (!integer(received, maximumOffset) || received < pending.offset + pending.bytes) {
          issue("malformed");
          return;
        }
        plain.maxAcknowledgedOffset = Math.max(plain.maxAcknowledgedOffset ?? 0, received);
        const elapsed = performance.now() - pending.started;
        if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 3_600_000) issue("unknown");
        else {
          plain.minReplyMs = Math.min(plain.minReplyMs ?? elapsed, elapsed);
          plain.maxReplyMs = Math.max(plain.maxReplyMs ?? elapsed, elapsed);
        }
        bump(plain, "successes");
      } else if (pending.method === "append") bump(plain, "failures");
      state.pending.delete(key);
      return;
    }
    if (!["Defect", "ClientProtocolError"].includes(envelope._tag)) issue("unknown");
  };
  const outbound = (state: State, value: unknown) => {
    const envelope = object(value);
    if (!envelope || typeof envelope._tag !== "string") {
      issue("malformed");
      return;
    }
    if (envelope._tag === "Ping") {
      bump(control, "ping");
      return;
    }
    if (envelope._tag === "Ack" || envelope._tag === "Interrupt") {
      if (id(envelope.requestId) === null) issue("malformed");
      else bump(control, envelope._tag === "Ack" ? "ack" : "interrupt");
      return;
    }
    if (envelope._tag === "Eof") return;
    if (
      envelope._tag !== "Request" ||
      typeof envelope.tag !== "string" ||
      id(envelope.id) === null ||
      !Array.isArray(envelope.headers)
    ) {
      issue("malformed");
      return;
    }
    const key = id(envelope.id)!;
    if (state.closed || state.pending.has(key)) {
      issue("unknown");
      return;
    }
    const methods: Record<string, keyof typeof requests> = {
      "uploads.begin": "begin",
      "uploads.append": "append",
      "uploads.get": "get",
      "uploads.cancel": "cancel",
    };
    const method: keyof typeof requests | "config" | undefined =
      envelope.tag === "subscribeServerConfig"
        ? "config"
        : Object.hasOwn(methods, envelope.tag)
          ? methods[envelope.tag]
          : undefined;
    if (!method) return;
    const payload = object(envelope.payload);
    const bytes = method === "append" ? rawSize(payload?.data) : 0;
    const offset = method === "append" ? payload?.offset : 0;
    if (bytes === null || !integer(offset, maximumOffset) || offset + bytes > maximumOffset) {
      issue("malformed");
      return;
    }
    if (state.pending.size >= pendingLimit) {
      issue("overflow");
      return;
    }
    if (method !== "config") bump(requests, method);
    state.pending.set(key, { method, bytes, offset, started: performance.now() });
    if (method === "append") {
      plain.minRawBytes = Math.min(plain.minRawBytes ?? bytes, bytes);
      plain.maxRawBytes = Math.max(plain.maxRawBytes ?? bytes, bytes);
      plain.maximumOutstanding = Math.max(plain.maximumOutstanding, outstanding());
      plain.maximumOutstandingPerSocket = Math.max(
        plain.maximumOutstandingPerSocket,
        [...state.pending.values()].filter((value) => value.method === "append").length,
      );
    }
  };
  const json = (state: State, text: string, direction: "in" | "out") => {
    const limit = direction === "in" ? incomingLimit : outgoingLimit;
    if (text.length > limit || utf8.encode(text).length > limit) {
      issue("overflow");
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      issue("malformed");
      return;
    }
    const values = Array.isArray(value) ? value : [value];
    if (values.length === 0 || values.length > 256) {
      issue("overflow");
      return;
    }
    for (const entry of values) (direction === "in" ? inbound : outbound)(state, entry);
  };
  const message = (state: State, data: unknown, negotiated: boolean) => {
    if (typeof data === "string") {
      json(state, data, "in");
      return;
    }
    if (!negotiated || !(data instanceof ArrayBuffer || data instanceof Uint8Array)) {
      issue("unsupported");
      return;
    }
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const flag = bytes[0];
    const body = bytes.subarray(1);
    if (
      bytes.length === 0 ||
      ![0, 1, 2].includes(flag!) ||
      body.length > maximumRecord ||
      (flag !== 0 && body.length === 0)
    ) {
      issue("malformed");
      state.parts = [];
      state.bytes = 0;
      state.discard = true;
      return;
    }
    if (flag === 2) {
      try {
        json(state, decoder.decode(body), "in");
      } catch {
        issue("malformed");
      }
      return;
    }
    state.records++;
    if (state.records > recordLimit || state.bytes + body.length > incomingLimit) {
      if (!state.discard) issue("overflow");
      state.parts = [];
      state.bytes = 0;
      state.discard = true;
    }
    if (!state.discard) {
      state.parts.push(body.slice());
      state.bytes += body.length;
    }
    if (flag !== 0) return;
    if (!state.discard) {
      const joined = new Uint8Array(state.bytes);
      let offset = 0;
      for (const part of state.parts) {
        joined.set(part, offset);
        offset += part.length;
      }
      try {
        json(state, decoder.decode(joined), "in");
      } catch {
        issue("malformed");
      }
    }
    reset(state);
  };
  const read = (): ChatUploadObservation => ({
    version: 1,
    available: true,
    socketOverflow,
    plain: {
      available: plain.created > 0,
      complete:
        plain.created > 0 &&
        !socketOverflow &&
        Object.values(issues).every((value) => value === 0) &&
        states.every((state) => state.bytes === 0 && !state.discard),
      created: plain.created,
      opened: plain.opened,
      closed: plain.closed,
      requests: { ...requests },
      append: {
        outstanding: outstanding(),
        maximumOutstanding: plain.maximumOutstanding,
        maximumOutstandingPerSocket: plain.maximumOutstandingPerSocket,
        successes: plain.successes,
        failures: plain.failures,
        abandoned: plain.abandoned,
        minRawBytes: plain.minRawBytes,
        maxRawBytes: plain.maxRawBytes,
        maxAcknowledgedOffset: plain.maxAcknowledgedOffset,
        minReplyMs: plain.minReplyMs,
        maxReplyMs: plain.maxReplyMs,
      },
      control: { ...control },
      capability: plain.capability,
      issues: { ...issues },
      partialMessages: states.filter((state) => state.bytes > 0 || state.discard).length,
      maxBufferedBytesAtClose: plain.maxBufferedBytesAtClose,
      closeCalls: plain.closeCalls,
      lastCloseCode: plain.lastCloseCode,
    },
    noise: { ...noise },
    other: { ...other },
  });
  Reflect.set(window, "__uploadObservations", { read });
  window.WebSocket = class extends original {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args);
      let endpoint: "plain" | "noise" | "other" = "other";
      try {
        const url = new URL(this.url);
        if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
          if (url.port === "4903" && url.pathname === "/ws") endpoint = "plain";
          else if (url.port === "4911" && url.pathname === "/ws-e2ee") endpoint = "noise";
        }
      } catch {
        /* Unclassifiable socket remains unrelated. */
      }
      if (endpoint === "other") {
        bump(other, "created");
        return;
      }
      bump(endpoint === "plain" ? plain : noise, "created");
      if (states.length >= socketLimit) {
        socketOverflow = true;
        return;
      }
      const state: State = {
        pending: new Map(),
        parts: [],
        bytes: 0,
        records: 0,
        discard: false,
        closed: false,
      };
      states.push(state);
      this.addEventListener("open", () => bump(endpoint === "plain" ? plain : noise, "opened"));
      this.addEventListener("close", () => {
        state.closed = true;
        bump(endpoint === "plain" ? plain : noise, "closed");
        if (endpoint === "plain") {
          for (const value of state.pending.values())
            if (value.method === "append") bump(plain, "abandoned");
          if (state.bytes > 0 || state.discard) issue("unknown");
        }
        state.pending.clear();
        reset(state);
      });
      if (endpoint !== "plain") return;
      this.addEventListener("message", (event) => {
        try {
          message(state, event.data, this.protocol === "bibcode.rpc.chunked.v1");
        } catch {
          issue("malformed");
        }
      });
      const send = this.send;
      const ownsReceiver = (candidate: WebSocket) => candidate === this;
      this.send = function (this: WebSocket, ...args: Parameters<WebSocket["send"]>) {
        const result = Reflect.apply(send, this, args);
        try {
          const data = args[0];
          if (!ownsReceiver(this)) issue("unknown");
          else if (typeof data === "string") json(state, data, "out");
          else issue("unsupported");
        } catch {
          issue("malformed");
        }
        return result;
      };
      const close = this.close;
      this.close = function (this: WebSocket, ...args: Parameters<WebSocket["close"]>) {
        let buffered: number | null = null;
        try {
          const observed = this.bufferedAmount;
          if (integer(observed, 2 ** 31 - 1)) buffered = observed;
        } catch {
          /* Metadata cannot prevent the original close. */
        }
        const result = Reflect.apply(close, this, args);
        try {
          if (!ownsReceiver(this)) {
            issue("unknown");
            return result;
          }
          bump(plain, "closeCalls");
          const code = args[0];
          if (integer(code, 4999) && code >= 1000) plain.lastCloseCode = code;
          if (buffered !== null)
            plain.maxBufferedBytesAtClose = Math.max(plain.maxBufferedBytesAtClose ?? 0, buffered);
          else issue("unknown");
        } catch {
          issue("unknown");
        }
        return result;
      };
    }
  };
}

export const chatUploadObservationScript = `(${installChatUploadObserver.toString()})();`;

/** Reject foreign fields/shapes; neither missing nor invalid evidence becomes complete-zero. */
export function projectChatUploadObservation(input: unknown): ChatUploadObservation | null {
  const record = (value: unknown): Record<string, unknown> | null => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const copy: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!("value" in descriptor)) return null;
      Object.defineProperty(copy, key, { value: descriptor.value, enumerable: true });
    }
    return copy;
  };
  const top = record(input),
    plain = record(top?.plain),
    append = record(plain?.append);
  const requests = record(plain?.requests),
    control = record(plain?.control),
    issues = record(plain?.issues),
    noise = record(top?.noise),
    other = record(top?.other);
  const keys = (value: Record<string, unknown> | null, names: string[]) =>
    value !== null &&
    Object.keys(value).length === names.length &&
    names.every((name) => Object.hasOwn(value, name));
  const count = (value: unknown, max = 1_000_000) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
  const nullable = (value: unknown, max: number) => value === null || count(value, max);
  if (
    !keys(top, ["version", "available", "socketOverflow", "plain", "noise", "other"]) ||
    top!.version !== 1 ||
    top!.available !== true ||
    typeof top!.socketOverflow !== "boolean" ||
    !keys(plain, [
      "available",
      "complete",
      "created",
      "opened",
      "closed",
      "requests",
      "append",
      "control",
      "capability",
      "issues",
      "partialMessages",
      "maxBufferedBytesAtClose",
      "closeCalls",
      "lastCloseCode",
    ]) ||
    !keys(append, [
      "outstanding",
      "maximumOutstanding",
      "maximumOutstandingPerSocket",
      "successes",
      "failures",
      "abandoned",
      "minRawBytes",
      "maxRawBytes",
      "maxAcknowledgedOffset",
      "minReplyMs",
      "maxReplyMs",
    ]) ||
    !keys(requests, ["begin", "append", "get", "cancel"]) ||
    !keys(control, ["ping", "pong", "ack", "interrupt"]) ||
    !keys(issues, ["malformed", "unsupported", "overflow", "unknown"]) ||
    !keys(noise, ["created", "opened", "closed", "applicationMetricsAvailable"]) ||
    !keys(other, ["created"]) ||
    noise!.applicationMetricsAvailable !== false
  )
    return null;
  if (
    typeof plain!.available !== "boolean" ||
    typeof plain!.complete !== "boolean" ||
    !(plain!.capability === null || typeof plain!.capability === "boolean")
  )
    return null;
  for (const group of [requests!, control!, issues!])
    if (!Object.values(group).every((value) => count(value))) return null;
  for (const name of ["created", "opened", "closed", "closeCalls"])
    if (!count(plain![name])) return null;
  if (
    !count(other!.created) ||
    ![noise!.created, noise!.opened, noise!.closed].every((value) => count(value)) ||
    !count(plain!.partialMessages, 16) ||
    !nullable(plain!.maxBufferedBytesAtClose, 2 ** 31 - 1) ||
    !nullable(plain!.lastCloseCode, 4999)
  )
    return null;
  for (const name of ["outstanding", "maximumOutstanding"])
    if (!count(append![name], 16 * 64)) return null;
  if (!count(append!.maximumOutstandingPerSocket, 64)) return null;
  for (const name of ["successes", "failures", "abandoned"]) if (!count(append![name])) return null;
  for (const name of ["minRawBytes", "maxRawBytes"])
    if (!nullable(append![name], 1024 ** 2)) return null;
  if (
    !nullable(append!.maxAcknowledgedOffset, 10 * 1024 ** 2) ||
    ![append!.minReplyMs, append!.maxReplyMs].every(
      (value) =>
        value === null ||
        (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 3_600_000),
    )
  )
    return null;
  if (
    plain!.available !== (plain!.created as number) > 0 ||
    (plain!.opened as number) > (plain!.created as number) ||
    (plain!.closed as number) > (plain!.created as number) ||
    (noise!.opened as number) > (noise!.created as number) ||
    (noise!.closed as number) > (noise!.created as number)
  )
    return null;
  if (plain!.lastCloseCode !== null && (plain!.lastCloseCode as number) < 1000) return null;
  if (
    (append!.outstanding as number) > (append!.maximumOutstanding as number) ||
    (append!.maximumOutstandingPerSocket as number) > (append!.maximumOutstanding as number) ||
    (append!.maximumOutstanding as number) > (requests!.append as number)
  )
    return null;
  if (
    (append!.successes as number) +
      (append!.failures as number) +
      (append!.abandoned as number) +
      (append!.outstanding as number) !==
    requests!.append
  )
    return null;
  if (
    append!.minRawBytes !== null &&
    append!.maxRawBytes !== null &&
    (append!.minRawBytes as number) > (append!.maxRawBytes as number)
  )
    return null;
  if (
    append!.minReplyMs !== null &&
    append!.maxReplyMs !== null &&
    (append!.minReplyMs as number) > (append!.maxReplyMs as number)
  )
    return null;
  if (
    plain!.complete &&
    (!plain!.available ||
      top!.socketOverflow ||
      plain!.partialMessages !== 0 ||
      Object.values(issues!).some((value) => value !== 0))
  )
    return null;
  // Every accepted field is a fixed primitive; rebuilding through JSON returns no
  // input object identity/accessors/foreign fields to the artifact caller.
  return JSON.parse(
    JSON.stringify({
      version: 1,
      available: true,
      socketOverflow: top!.socketOverflow,
      plain: {
        ...plain,
        requests: { ...requests },
        append: { ...append },
        control: { ...control },
        issues: { ...issues },
      },
      noise: { ...noise },
      other: { ...other },
    }),
  ) as ChatUploadObservation;
}
