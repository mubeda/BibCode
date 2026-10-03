export const OLD_INLINE_SOURCE = "cd66fda5700294a320fe76256c486bd7a7a0b3a5";
export interface InlineFallbackObservation {
  readonly version: 1;
  readonly complete: boolean;
  readonly plainSockets: number;
  readonly uploadRequests: number;
  readonly turnRequests: number;
  readonly inlineAttachments: number;
  readonly inlineBytes: number;
  readonly stagedReferences: number;
}
function installInlineFallbackObserver() {
  const Original = window.WebSocket;
  const observed = {
    version: 1 as const,
    complete: true,
    plainSockets: 0,
    uploadRequests: 0,
    turnRequests: 0,
    inlineAttachments: 0,
    inlineBytes: 0,
    stagedReferences: 0,
  };
  const object = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const trimmed = (value: unknown, limit: number): value is string =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= limit &&
    value.trim() === value;
  const requestId = (value: unknown) =>
    trimmed(value, 128) || (Number.isSafeInteger(value) && (value as number) >= 0);
  const bump = (
    key:
      | "plainSockets"
      | "uploadRequests"
      | "turnRequests"
      | "inlineAttachments"
      | "inlineBytes"
      | "stagedReferences",
    count = 1,
  ) => {
    if (observed[key] + count > 16 * 10 * 1024 ** 2) observed.complete = false;
    else observed[key] += count;
  };
  const inspect = (data: unknown) => {
    if (typeof data !== "string" || data.length > 15 * 1024 ** 2) {
      observed.complete = false;
      return;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(data);
    } catch {
      observed.complete = false;
      return;
    }
    const entries = Array.isArray(decoded) ? decoded : [decoded];
    if (entries.length > 64) {
      observed.complete = false;
      return;
    }
    for (const value of entries) {
      const entry = object(value);
      if (
        !entry ||
        typeof entry._tag !== "string" ||
        !["Request", "Ping", "Ack", "Interrupt", "Eof"].includes(entry._tag)
      ) {
        observed.complete = false;
        continue;
      }
      if (entry._tag !== "Request") continue;
      if (
        typeof entry.tag !== "string" ||
        entry.tag.length > 200 ||
        entry.tag.length === 0 ||
        !requestId(entry.id) ||
        !Array.isArray(entry.headers) ||
        entry.headers.length > 64
      ) {
        observed.complete = false;
        continue;
      }
      if (entry.tag.startsWith("uploads.")) bump("uploadRequests");
      if (entry.tag !== "orchestration.dispatchCommand") continue;
      const command = object(entry.payload);
      if (command?.type !== "thread.turn.start") continue;
      bump("turnRequests");
      const attachments = object(command.message)?.attachments;
      if (!Array.isArray(attachments) || attachments.length > 8) {
        observed.complete = false;
        continue;
      }
      let valid = true,
        totalBytes = 0,
        totalImages = 0;
      const quarantine = () => {
        valid = false;
        observed.complete = false;
      };
      for (const value of attachments) {
        const attachment = object(value);
        if (!attachment) {
          quarantine();
          continue;
        }
        if (Object.hasOwn(attachment, "uploadId")) {
          bump("stagedReferences");
          quarantine();
          continue;
        }
        if (
          attachment.type !== "image" ||
          !trimmed(attachment.id, 128) ||
          !/^[a-z0-9_-]+$/i.test(attachment.id) ||
          !trimmed(attachment.name, 255) ||
          !trimmed(attachment.mimeType, 100) ||
          attachment.mimeType.toLowerCase() !== "image/png" ||
          !Number.isSafeInteger(attachment.sizeBytes) ||
          (attachment.sizeBytes as number) < 0 ||
          (attachment.sizeBytes as number) > 10 * 1024 ** 2
        ) {
          quarantine();
          continue;
        }
        const url = attachment.dataUrl;
        const prefix = "data:image/png;base64,";
        if (typeof url !== "string" || url.length > 14000000 || !url.startsWith(prefix)) {
          quarantine();
          continue;
        }
        const encoded = url.slice(prefix.length);
        const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
        const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        const tail = alphabet.indexOf(encoded[encoded.length - padding - 1] ?? "!");
        const bytes = (encoded.length / 4) * 3 - padding;
        if (
          !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ||
          encoded.length % 4 !== 0 ||
          bytes > 10 * 1024 ** 2 ||
          bytes !== attachment.sizeBytes ||
          tail < 0 ||
          (padding === 2 && (tail & 15) !== 0) ||
          (padding === 1 && (tail & 3) !== 0)
        ) {
          quarantine();
          continue;
        }
        totalImages++;
        totalBytes += bytes;
      }
      if (valid) {
        bump("inlineAttachments", totalImages);
        bump("inlineBytes", totalBytes);
      }
    }
  };
  window.WebSocket = class extends Original {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args);
      let owned = false;
      try {
        const url = new URL(this.url);
        owned =
          (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
          url.port === "4903" &&
          url.pathname === "/ws";
      } catch {
        return;
      }
      if (!owned) return;
      bump("plainSockets");
      if (observed.plainSockets > 16) observed.complete = false;
      const socket = this;
      const send = this.send;
      this.send = function (this: WebSocket, ...values: Parameters<WebSocket["send"]>) {
        const result = Reflect.apply(send, this, values);
        try {
          if (this === socket) inspect(values[0]);
          else observed.complete = false;
        } catch {
          observed.complete = false;
        }
        return result;
      };
    }
  };
  Object.defineProperty(window, "__inlineFallbackObservations", {
    value: { read: () => ({ ...observed }) },
  });
}
export const inlineFallbackObservationScript = `(${installInlineFallbackObserver.toString()})();`;

/** Untrusted browser metadata must remain exactly this bounded, path-free shape. */
export function projectInlineFallbackObservation(value: unknown): InlineFallbackObservation | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const counters = [
    "plainSockets",
    "uploadRequests",
    "turnRequests",
    "inlineAttachments",
    "inlineBytes",
    "stagedReferences",
  ];
  if (
    Object.keys(row).length !== 8 ||
    row.version !== 1 ||
    typeof row.complete !== "boolean" ||
    !counters.every(
      (key) =>
        Number.isSafeInteger(row[key]) &&
        (row[key] as number) >= 0 &&
        (row[key] as number) <= 16 * 10 * 1024 ** 2,
    ) ||
    ((row.plainSockets as number) > 16 && row.complete)
  )
    return null;
  return {
    version: 1,
    complete: row.complete,
    plainSockets: row.plainSockets as number,
    uploadRequests: row.uploadRequests as number,
    turnRequests: row.turnRequests as number,
    inlineAttachments: row.inlineAttachments as number,
    inlineBytes: row.inlineBytes as number,
    stagedReferences: row.stagedReferences as number,
  };
}
