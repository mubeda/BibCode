// Test-only real-socket support. This module is intentionally absent from the
// package exports and may only be imported by colocated protocol tests.
// @effect-diagnostics globalTimers:off - Frame delivery has an explicit bounded watchdog.
import { MAX_E2EE_PREAUTH_MESSAGE_BYTES, plaintextRecords, RecordAssembler } from "./frame.ts";
import { createNkInitiator } from "./noise.ts";

const EMPTY = new Uint8Array(0);
const FRAME_TIMEOUT_MS = 10_000;

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export interface EncryptedTestSocket {
  readonly nextMessage: () => Promise<string>;
  readonly sendMessage: (text: string) => void;
  readonly sendRecords: (records: ReadonlyArray<Uint8Array>) => void;
  readonly close: () => void;
}

export async function openEncryptedTestSocket(
  httpBaseUrl: string,
  hostKey: Uint8Array,
): Promise<EncryptedTestSocket> {
  const wsUrl = `${httpBaseUrl.replace(/^http/, "ws")}/ws-e2ee`;
  const socket = new WebSocket(wsUrl);
  socket.binaryType = "arraybuffer";
  const frames: Uint8Array[] = [];
  const waiters: Array<{
    readonly resolve: (frame: Uint8Array) => void;
    readonly reject: (error: Error) => void;
  }> = [];
  let terminalError: Error | null = null;

  socket.addEventListener("message", (event) => {
    const frame = new Uint8Array(event.data as ArrayBuffer);
    const waiter = waiters.shift();
    if (waiter === undefined) frames.push(frame);
    else waiter.resolve(frame);
  });
  const failWaiters = (error: Error): void => {
    terminalError = error;
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  };
  socket.addEventListener("error", () => failWaiters(new Error("E2EE WebSocket failed")));
  socket.addEventListener("close", () => failWaiters(new Error("E2EE WebSocket closed")));

  const nextFrame = (): Promise<Uint8Array> => {
    const frame = frames.shift();
    if (frame !== undefined) return Promise.resolve(frame);
    if (terminalError !== null) return Promise.reject(terminalError);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.resolve === resolveFrame);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error("timed out waiting for E2EE frame"));
      }, FRAME_TIMEOUT_MS);
      const resolveFrame = (next: Uint8Array): void => {
        clearTimeout(timer);
        resolve(next);
      };
      const rejectFrame = (error: Error): void => {
        clearTimeout(timer);
        reject(error);
      };
      waiters.push({ resolve: resolveFrame, reject: rejectFrame });
    });
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener("open", opened);
        socket.removeEventListener("error", failed);
        socket.removeEventListener("close", failed);
      };
      const opened = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new Error("E2EE WebSocket did not open"));
      };
      const timer = setTimeout(failed, FRAME_TIMEOUT_MS);
      socket.addEventListener("open", opened, { once: true });
      socket.addEventListener("error", failed, { once: true });
      socket.addEventListener("close", failed, { once: true });
    });

    const initiator = createNkInitiator({ responderStaticPublicKey: hostKey });
    socket.send(ownedBuffer(initiator.writeMessageA(EMPTY)));
    const payload = initiator.readMessageB(await nextFrame());
    if (payload.length !== 0) {
      throw new Error("message B carried a non-empty handshake payload");
    }
    const transport = initiator.split();
    let assembler = new RecordAssembler(MAX_E2EE_PREAUTH_MESSAGE_BYTES);
    let authenticated = false;
    const nextMessage = async (): Promise<string> => {
      for (;;) {
        const record = transport.receive.decryptWithAd(EMPTY, await nextFrame());
        const message = assembler.push(record);
        if (message === null) continue;
        const text = new TextDecoder().decode(message);
        if (!authenticated) {
          try {
            const parsed = JSON.parse(text) as { type?: string };
            if (parsed.type === "e2ee_authenticated") {
              authenticated = true;
              assembler = new RecordAssembler();
            }
          } catch {
            // The caller owns assertions for malformed encrypted messages.
          }
        }
        return text;
      }
    };
    const sendRecords = (records: Iterable<Uint8Array>): void => {
      for (const record of records) {
        socket.send(ownedBuffer(transport.send.encryptWithAd(EMPTY, record)));
      }
    };
    const sendMessage = (text: string): void => {
      sendRecords(plaintextRecords(new TextEncoder().encode(text)));
    };
    return { nextMessage, sendMessage, sendRecords, close: () => socket.close() };
  } catch (error) {
    socket.close();
    throw error;
  }
}

export async function requestTestRpc(
  channel: EncryptedTestSocket,
  requestId: string,
  tag: string,
  payload: object = {},
): Promise<unknown> {
  channel.sendMessage(
    JSON.stringify({
      _tag: "Request",
      id: requestId,
      tag,
      payload,
      headers: [],
    }),
  );
  for (;;) {
    const message = JSON.parse(await channel.nextMessage()) as {
      _tag?: string;
      requestId?: string;
    };
    if (message._tag === "ClientProtocolError") {
      throw new Error(`server returned ClientProtocolError for request ${requestId}`);
    }
    if (message.requestId === requestId) return message;
  }
}

/** Consumes the complete finite response; an end value alone never means success. */
export async function streamTestRpc<A>(
  channel: EncryptedTestSocket,
  requestId: string,
  tag: string,
  payload: object,
  decode: (value: unknown) => A,
): Promise<ReadonlyArray<A>> {
  const values: A[] = [];
  let exited = false;
  channel.sendMessage(
    JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] }),
  );
  try {
    for (;;) {
      const message = JSON.parse(await channel.nextMessage()) as {
        readonly _tag?: string;
        readonly requestId?: string;
        readonly values?: unknown;
        readonly exit?: { readonly _tag?: string };
      };
      if (message._tag === "ClientProtocolError")
        throw new Error(`RPC stream ${tag} failed its protocol`);
      if (message.requestId !== requestId) continue;
      if (message._tag === "Chunk") {
        if (!Array.isArray(message.values))
          throw new Error(`RPC stream ${tag} sent an invalid chunk`);
        for (const value of message.values) values.push(decode(value));
        channel.sendMessage(JSON.stringify({ _tag: "Ack", requestId }));
      } else if (message._tag === "Exit") {
        exited = true;
        if (message.exit?._tag !== "Success") throw new Error(`RPC stream ${tag} failed`);
        return values;
      } else throw new Error(`RPC stream ${tag} sent an unexpected response`);
    }
  } catch (error) {
    if (!exited) {
      try {
        channel.sendMessage(JSON.stringify({ _tag: "Interrupt", requestId }));
      } catch {
        /* The transport may already be closed; preserve the original failure. */
      }
    }
    throw error;
  }
}
