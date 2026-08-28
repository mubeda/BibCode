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

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("websocket open failed")), {
      once: true,
    });
  });

  const initiator = createNkInitiator({ responderStaticPublicKey: hostKey });
  socket.send(ownedBuffer(initiator.writeMessageA(EMPTY)));
  const payload = initiator.readMessageB(await nextFrame());
  if (payload.length !== 0) {
    socket.close();
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
  const sendMessage = (text: string): void => {
    for (const record of plaintextRecords(new TextEncoder().encode(text))) {
      socket.send(ownedBuffer(transport.send.encryptWithAd(EMPTY, record)));
    }
  };
  return { nextMessage, sendMessage, close: () => socket.close() };
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
