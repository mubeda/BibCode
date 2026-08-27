// Cross-language E2EE interop: TypeScript Noise NK initiator against the real
// Rust responder. Opt-in: requires a freshly built server binary.
//
//   cargo build -p bibcode-server
//   BIBCODE_E2EE_SERVER_BIN=$PWD/target/debug/bibcode vp test run src/e2ee/serverInterop.test.ts
//
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off - This opt-in harness probes a real loopback server process.
// @effect-diagnostics globalTimers:off - The process and WebSocket harness owns bounded watchdogs.
import { spawn, type ChildProcess } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createInterface } from "node:readline";

import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  type RemotePairingCodePayload,
} from "@bibcode/contracts";
import { parsePairingCode } from "@bibcode/shared/pairingCode";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";

import { RecordAssembler, splitIntoRecords } from "./frame.ts";
import { createNkInitiator, decodeBase64UrlKey, type NkTransport } from "./noise.ts";

const serverBinary = process.env["BIBCODE_E2EE_SERVER_BIN"];
const EMPTY = new Uint8Array(0);

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

interface RunningServer {
  process: ChildProcess;
  httpBaseUrl: string;
  token: string;
  dataRoot: string;
  adminAccessToken?: string;
}

async function startServer(): Promise<RunningServer> {
  const dataRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-e2ee-"));
  const child = spawn(serverBinary!, [
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    "0",
    "--base-dir",
    dataRoot,
    "--no-browser",
  ]);
  const stderr: string[] = [];
  child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  const startup = await new Promise<{ httpBaseUrl: string; token: string }>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server did not report readiness: ${stderr.join("")}`)),
      30_000,
    );
    let ready = false;
    createInterface({ input: child.stdout! }).on("line", (line) => {
      try {
        const parsed = JSON.parse(line) as { httpBaseUrl?: string; token?: string };
        if (parsed.httpBaseUrl && parsed.token) {
          ready = true;
          clearTimeout(timer);
          resolve({ httpBaseUrl: parsed.httpBaseUrl, token: parsed.token });
        }
      } catch {
        // Ignore non-JSON log lines.
      }
    });
    child.on("exit", (code) => {
      if (!ready) {
        clearTimeout(timer);
        reject(new Error(`server exited early (${String(code)}): ${stderr.join("")}`));
      }
    });
  });
  return { process: child, dataRoot, ...startup };
}

async function stopServer(server: RunningServer): Promise<void> {
  if (server.process.exitCode === null) {
    server.process.kill();
    await Promise.race([
      new Promise<void>((resolve) => server.process.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  if (server.process.exitCode === null) server.process.kill("SIGKILL");
  NodeFS.rmSync(server.dataRoot, { recursive: true, force: true });
}

function readHostPublicKey(dataRoot: string): Uint8Array {
  const record = NodeFS.readFileSync(
    NodePath.join(dataRoot, "userdata", "secrets", "host-identity-x25519.bin"),
  );
  expect(record).toHaveLength(64);
  return Uint8Array.from(record.subarray(32));
}

async function adminAccessToken(server: RunningServer): Promise<string> {
  if (server.adminAccessToken !== undefined) return server.adminAccessToken;
  const response = await fetch(`${server.httpBaseUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: AuthTokenExchangeGrantType,
      subject_token: server.token,
      subject_token_type: AuthEnvironmentBootstrapTokenType,
      requested_token_type: AuthAccessTokenType,
    }),
  });
  const body = (await response.json()) as { access_token?: string };
  expect(response.ok, JSON.stringify(body)).toBe(true);
  expect(body.access_token).toBeTruthy();
  server.adminAccessToken = body.access_token!;
  return body.access_token!;
}

async function mintedPairing(server: RunningServer): Promise<{
  payload: RemotePairingCodePayload;
  hostKey: Uint8Array;
}> {
  const response = await fetch(`${server.httpBaseUrl}/api/auth/pairing-offer`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await adminAccessToken(server)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: "Interop",
      endpoint: server.httpBaseUrl,
      reach: "custom",
    }),
  });
  const offer = (await response.json()) as { code?: string };
  expect(response.ok, JSON.stringify(offer)).toBe(true);
  expect(offer.code).toBeTruthy();
  const payload = parsePairingCode(offer.code!);
  const hostKey = decodeBase64UrlKey(payload.hostKey);
  expect(hostKey).toEqual(readHostPublicKey(server.dataRoot));
  return { payload, hostKey };
}

interface EncryptedSocket {
  nextMessage: () => Promise<string>;
  sendMessage: (text: string) => void;
  close: () => void;
}

async function openEncrypted(server: RunningServer, hostKey: Uint8Array): Promise<EncryptedSocket> {
  const wsUrl = `${server.httpBaseUrl.replace(/^http/, "ws")}/ws-e2ee`;
  const socket = new WebSocket(wsUrl);
  socket.binaryType = "arraybuffer";
  const frames: Uint8Array[] = [];
  const waiters: Array<(frame: Uint8Array) => void> = [];
  socket.addEventListener("message", (event) => {
    const frame = new Uint8Array(event.data as ArrayBuffer);
    const waiter = waiters.shift();
    if (waiter === undefined) frames.push(frame);
    else waiter(frame);
  });
  const nextFrame = (): Promise<Uint8Array> => {
    const frame = frames.shift();
    if (frame !== undefined) return Promise.resolve(frame);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for E2EE frame")), 10_000);
      waiters.push((next) => {
        clearTimeout(timer);
        resolve(next);
      });
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
  expect(payload).toHaveLength(0);
  const transport = initiator.split();
  const assembler = new RecordAssembler();
  const nextMessage = async (): Promise<string> => {
    for (;;) {
      const record = transport.receive.decryptWithAd(EMPTY, await nextFrame());
      const message = assembler.push(record);
      if (message !== null) return new TextDecoder().decode(message);
    }
  };
  const sendMessage = (text: string): void => {
    for (const record of splitIntoRecords(new TextEncoder().encode(text))) {
      socket.send(ownedBuffer(transport.send.encryptWithAd(EMPTY, record)));
    }
  };
  return { nextMessage, sendMessage, close: () => socket.close() };
}

async function requestConfig(channel: EncryptedSocket, requestId: string, payload: object = {}) {
  channel.sendMessage(
    JSON.stringify({
      _tag: "Request",
      id: requestId,
      tag: "server.getConfig",
      payload,
      headers: [],
    }),
  );
  for (;;) {
    const message = JSON.parse(await channel.nextMessage()) as {
      _tag?: string;
      requestId?: string;
    };
    expect(message._tag).not.toBe("ClientProtocolError");
    if (message.requestId === requestId) return message;
  }
}

describe.skipIf(serverBinary === undefined)(
  "TypeScript initiator against the Rust responder",
  () => {
    let server: RunningServer;

    beforeAll(async () => {
      server = await startServer();
    }, 60_000);

    afterAll(async () => {
      if (server !== undefined) await stopServer(server);
    });

    it("mints, pairs in-channel, round-trips RPC, and reconnects with the minted bearer", async () => {
      const { payload, hostKey } = await mintedPairing(server);
      const channel = await openEncrypted(server, hostKey);
      channel.sendMessage(JSON.stringify({ type: "e2ee_auth", pairing: payload.token }));
      const authenticated = JSON.parse(await channel.nextMessage()) as {
        type: string;
        credential?: string;
        storageInstanceId?: string;
      };
      expect(authenticated.type).toBe("e2ee_authenticated");
      expect(authenticated.credential).toBeTruthy();
      expect(authenticated.storageInstanceId).toBe(payload.storageInstanceId);
      expect(await requestConfig(channel, "1")).toMatchObject({ _tag: "Exit", requestId: "1" });
      channel.close();

      const second = await openEncrypted(server, hostKey);
      second.sendMessage(JSON.stringify({ type: "e2ee_auth", bearer: authenticated.credential }));
      expect(JSON.parse(await second.nextMessage())).toEqual({ type: "e2ee_authenticated" });
      second.close();
    }, 30_000);

    it("reassembles a fragmented client message across the language boundary", async () => {
      const { payload, hostKey } = await mintedPairing(server);
      const channel = await openEncrypted(server, hostKey);
      channel.sendMessage(JSON.stringify({ type: "e2ee_auth", pairing: payload.token }));
      await channel.nextMessage();
      expect(await requestConfig(channel, "2", { ignored: "x".repeat(200_000) })).toMatchObject({
        requestId: "2",
      });
      channel.close();
    }, 30_000);

    it("rejects a bad pairing token inside the encrypted channel", async () => {
      const { hostKey } = await mintedPairing(server);
      const channel = await openEncrypted(server, hostKey);
      channel.sendMessage(JSON.stringify({ type: "e2ee_auth", pairing: "bogus" }));
      expect(JSON.parse(await channel.nextMessage())).toEqual({
        type: "e2ee_error",
        code: "unauthorized",
      });
      channel.close();
    }, 30_000);
  },
);
