// @effect-diagnostics nodeBuiltinImport:off - Hermetic encrypted evidence and actual RPC/observer caller only.
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import * as NodeUtil from "node:util";
import { test } from "vite-plus/test";
import {
  admitImportEvidenceRecipient,
  sealImportFailure,
  publishImportFailure,
} from "./ci-import-private-evidence.ts";
import { terminalOscColorEnv } from "../../../web/src/components/terminalTheme.ts";
import { createBrowserFollowupReplayObserver } from "./release-visual-browser-followups-caller-protocol.ts";
import { createBrowserFollowupReplyGate } from "./release-visual-browser-followups-transport.ts";
import { runBrowserFollowupScene } from "./release-visual-browser-followups-producer.ts";
const recipient = NodeCrypto.generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicExponent: 65537,
});
const der = recipient.publicKey.export({ format: "der", type: "spki" });
const env = {
  CI: "true",
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_JOB: "visual_core",
  GITHUB_SHA: "1".repeat(40),
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "1",
  BIBCODE_DELIVERY_UI_SELECTION: "release-visual-browser-followups",
  BIBCODE_IMPORT_EVIDENCE_SELECTED: "true",
  BIBCODE_TERMINAL_EVIDENCE_SELECTED: "true",
  BIBCODE_IMPORT_EVIDENCE_PUBLIC_SPKI: der.toString("base64"),
  BIBCODE_IMPORT_EVIDENCE_PUBLIC_SHA256: NodeCrypto.createHash("sha256").update(der).digest("hex"),
};
const serialization = NodeModule.createRequire(
  new URL("../../../../packages/contracts/package.json", import.meta.url),
)("effect/unstable/rpc/RpcSerialization").json.makeUnsafe();
function owner(root, options = {}) {
  const source = NodeFS.readFileSync(
    new URL("./release-visual-terminal-evidence.ts", import.meta.url),
    "utf8",
  );
  return NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      source.replace(/^import[\s\S]*?;\n/gm, "").replace(/^export /gm, ""),
    ) + "\ncreateTerminalEvidenceOwner",
    {
      Buffer,
      Uint8Array,
      NodeUtil: NodeUtil,
      terminalOscColorEnv,
      admitImportEvidenceRecipient,
      sealImportFailure: options.seal ?? sealImportFailure,
      publishImportFailure: options.publish ?? publishImportFailure,
    },
  )({
    env: options.disabled
      ? {}
      : options.importOnly
        ? { ...env, BIBCODE_TERMINAL_EVIDENCE_SELECTED: undefined }
        : env,
    evidenceRoot: root,
    platform: "linux",
  });
}
function withRoot(run) {
  const root = NodeFS.mkdtempSync(
    NodePath.join(NodeFS.realpathSync.native(NodeOS.tmpdir()), "terminal-evidence-owned-"),
  );
  NodeFS.chmodSync(root, 0o700);
  return Promise.resolve()
    .then(() => run(root))
    .finally(() => NodeFS.rmSync(root, { recursive: true, force: true }));
}
function frame(value, client) {
  const body = Buffer.from(serialization.encode(value)),
    header = Buffer.alloc(body.length < 126 ? 2 : 4),
    mask = Buffer.from([7, 11, 19, 23]);
  header[0] = 129;
  header[1] = (client ? 128 : 0) | (header.length === 2 ? body.length : 126);
  if (header.length === 4) header.writeUInt16BE(body.length, 2);
  if (client) for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
  return Buffer.concat(client ? [header, mask, body] : [header, body]);
}
function fixture(observeTerminalRefusal) {
  const snapshot = {
    threadId: "owned-thread",
    terminalId: "term-1",
    cwd: "/owned/project",
    worktreePath: "/owned/project",
    status: "running",
    pid: 123,
    history: "Owned shared terminal output\r\n",
    exitCode: null,
    exitSignal: null,
    label: "sleep",
    updatedAt: "2026-10-10T00:00:00.000Z",
    sequence: 10,
    size: { cols: 91, rows: 24, sizeClaim: "primary-claim" },
    oscColorResponderActive: false,
    firstAttachmentGrant: false,
  };
  const observer = createBrowserFollowupReplayObserver({
    observeTerminalRefusal,
    theme: "light",
    baseline: {
      threadId: snapshot.threadId,
      terminalId: snapshot.terminalId,
      cwd: snapshot.cwd,
      pid: snapshot.pid,
      history: snapshot.history,
      sequence: 10,
    },
    png: Buffer.from("inert"),
    cwd: snapshot.cwd,
    threadId: snapshot.threadId,
    terminalId: snapshot.terminalId,
    patch: () => "",
    slowTransport: () => false,
  });
  const gates = new Map();
  function carry(connection, direction, message) {
    let gate = gates.get(connection);
    if (!gate) {
      gate = createBrowserFollowupReplyGate({
        observeOriginal: (d, v) => observer.observe(connection, d, v),
      });
      gate.selectProtocol([], null);
      gates.set(connection, gate);
    }
    const wire = frame(message, direction === "request");
    const out = direction === "request" ? gate.client(wire) : gate.server(wire);
    NodeAssert.deepEqual(Buffer.concat(out), wire);
  }
  for (const [c, claim] of [
    ["primary", "primary-claim"],
    ["second", "second-claim"],
  ]) {
    carry(c, "request", {
      _tag: "Request",
      id: "1",
      tag: "subscribeServerConfig",
      payload: {},
      headers: [],
    });
    carry(c, "request", {
      _tag: "Request",
      id: "2",
      tag: "terminal.attach",
      payload: {
        threadId: snapshot.threadId,
        terminalId: snapshot.terminalId,
        cwd: snapshot.cwd,
        restartIfNotRunning: false,
        sizeClaim: claim,
        env: terminalOscColorEnv("light"),
      },
      headers: [],
    });
    carry(c, "reply", { _tag: "Chunk", requestId: "2", values: [{ type: "snapshot", snapshot }] });
    if (c === "primary") observer.terminalRestored();
  }
  return {
    observer,
    carry,
    message: {
      _tag: "Chunk",
      requestId: "2",
      values: [{ type: "snapshot", snapshot }],
      headers: [["Authorization", "private-header"]],
    },
    predecessor: observer.privateTerminalPredecessor(),
  };
}
function decrypt(root) {
  const ready = NodePath.join(root, "terminal-private", "ready"),
    read = (name) => NodeFS.readFileSync(NodePath.join(ready, name));
  NodeAssert.deepEqual(
    NodeFS.readdirSync(ready).sort(),
    ["context.json", "reply.aesgcm.bin", "key.rsa-oaep-sha256.bin", "nonce.bin", "tag.bin"].sort(),
  );
  const context = read("context.json");
  NodeAssert.equal(JSON.parse(context).scope, "browser-owned-terminal-observer-refusal");
  const key = NodeCrypto.privateDecrypt(
    {
      key: recipient.privateKey,
      padding: NodeCrypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    read("key.rsa-oaep-sha256.bin"),
  );
  try {
    const cipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, read("nonce.bin"));
    cipher.setAAD(context);
    cipher.setAuthTag(read("tag.bin"));
    return JSON.parse(
      Buffer.concat([cipher.update(read("reply.aesgcm.bin")), cipher.final()]).toString(),
    );
  } finally {
    key.fill(0);
  }
}
async function receipt(observer) {
  const original = new Error("inert actual terminal receipt deadline"),
    guards = [];
  const browser = {
    $$: () => [{}],
    $: () => ({
      waitForDisplayed: async () => {},
      waitForEnabled: async () => {},
      click: async () => {},
    }),
  };
  let error;
  try {
    await runBrowserFollowupScene(
      {
        browser,
        owner: {
          until: async (p) => {
            if (!(await p())) throw original;
          },
        },
        verifyOwnedIdentity: async () => {},
        viewport: async () => {},
        capture: async () => {},
        terminal: {
          withSecondWindow: async (run) =>
            run({
              browser,
              label: "sleep",
              verify: async () => observer.terminal(),
              prepareOriginalSizeOwner: async () => {},
              verifyFit: async () => {},
            }),
        },
        step: () => {},
        observeUnsafeCleanup: () => {},
        observeTerminalReceiptFailure: (_error, reason) => guards.push(reason),
      },
      "terminal-shared-size",
    );
  } catch (value) {
    error = value;
  }
  NodeAssert.equal(error, original);
  NodeAssert.deepEqual(guards, ["observer-unavailable"]);
}
test("actual duplicate-refusal packet encrypts once and replay joins exact predecessor/full caller", () =>
  withRoot(async (root) => {
    const o = owner(root),
      f = fixture((value) => o.capture(value));
    let original;
    try {
      f.carry("second", "reply", f.message);
    } catch (error) {
      original = error;
    }
    NodeAssert.ok(original);
    const before = JSON.stringify(f.predecessor);
    o.capture({
      connection: "second",
      direction: "reply",
      message: f.message,
      predecessor: f.predecessor,
    });
    NodeAssert.equal(o.status(), "failure-encrypted");
    NodeAssert.equal(JSON.stringify(f.predecessor), before);
    o.capture({
      connection: "second",
      direction: "reply",
      message: f.message,
      predecessor: f.predecessor,
    });
    const bundle = decrypt(root);
    NodeAssert.equal(JSON.stringify(bundle).includes("private-header"), false);
    NodeAssert.deepEqual(Object.keys(bundle).sort(), [
      "connection",
      "direction",
      "message",
      "predecessor",
    ]);
    const replay = fixture();
    NodeAssert.deepEqual(replay.observer.privateTerminalPredecessor(), bundle.predecessor);
    NodeAssert.throws(() => replay.carry(bundle.connection, bundle.direction, bundle.message));
    await receipt(f.observer);
    await receipt(replay.observer);
    NodeAssert.equal(NodeFS.existsSync(NodePath.join(root, "import-private")), false);
    o.close();
  }));
test("default disabled and no-refusal never writes", () =>
  withRoot((root) => {
    const o = owner(root, { disabled: true });
    o.capture({ connection: "second", direction: "reply", message: {}, predecessor: null });
    NodeAssert.equal(o.status(), "disabled");
    NodeAssert.deepEqual(NodeFS.readdirSync(root), []);
    const enabled = owner(root);
    NodeAssert.equal(enabled.status(), "not-observed");
    enabled.close();
    NodeAssert.deepEqual(NodeFS.readdirSync(root), []);
  }));
for (const mode of [
  "command",
  "env-extra",
  "env-wrong",
  "predecessor-command",
  "predecessor-env",
  "ambiguous",
  "missing",
  "failed",
  "oversize",
  "request-overflow",
  "attachment-overflow",
  "foreign",
  "auth",
  "outer-auth",
]) {
  test("omits unsafe bundle: " + mode, () =>
    withRoot((root) => {
      const f = fixture(),
        o = owner(root);
      let p = structuredClone(f.predecessor),
        message = {
          _tag: "Request",
          id: "3",
          tag: "terminal.attach",
          payload: {
            threadId: "owned-thread",
            terminalId: "term-1",
            cwd: "/owned/project",
            sizeClaim: "second-claim",
          },
          headers: [["Authorization", "private-header"]],
        };
      if (mode === "command") message.payload.command = undefined;
      if (mode === "env-extra")
        message.payload.env = { ...terminalOscColorEnv("light"), SECRET: "unsafe" };
      if (mode === "env-wrong") message.payload.env = terminalOscColorEnv("dark");
      if (mode === "predecessor-command")
        p.protocol.requests[0][1].payload.command = { argv: ["bash"] };
      if (mode === "predecessor-env") p.protocol.requests[0][1].payload.env = { SECRET: "unsafe" };
      if (mode === "ambiguous") p.protocol.ambiguous = true;
      if (mode === "missing") p = null;
      if (mode === "failed") p.replay.failed = true;
      if (mode === "oversize")
        message = {
          ...f.message,
          values: [
            {
              type: "output",
              threadId: "owned-thread",
              terminalId: "term-1",
              data: "x".repeat(262144),
            },
          ],
        };
      if (mode === "request-overflow")
        p.protocol.requests = Array.from({ length: 129 }, (_, i) => [
          "second:" + (i + 10),
          p.protocol.requests[0][1],
        ]);
      if (mode === "attachment-overflow") p.protocol.attachments.push(p.protocol.attachments[0]);
      if (mode === "foreign") message.payload.terminalId = "foreign-terminal";
      if (mode === "outer-auth") message.authorization = "private-auth";
      if (mode === "auth")
        message = {
          _tag: "Request",
          id: "3",
          tag: "authenticate",
          payload: { token: "private-auth" },
        };
      o.capture({
        connection: "second",
        direction: mode === "oversize" ? "reply" : "request",
        message,
        predecessor: p,
      });
      NodeAssert.notEqual(o.status(), "failure-encrypted");
      NodeAssert.deepEqual(NodeFS.readdirSync(root), []);
    }),
  );
}
for (const boundary of ["seal", "publish"]) {
  test(boundary + " failure and close are isolated", () =>
    withRoot((root) => {
      const f = fixture(),
        o = owner(root, {
          [boundary]: () => {
            throw Error("private-port");
          },
        });
      NodeAssert.doesNotThrow(() =>
        o.capture({
          connection: "second",
          direction: "reply",
          message: f.message,
          predecessor: f.predecessor,
        }),
      );
      NodeAssert.equal(o.status(), "failure-omitted");
      o.close();
      o.close();
      NodeAssert.doesNotThrow(() =>
        o.capture({
          connection: "second",
          direction: "reply",
          message: f.message,
          predecessor: f.predecessor,
        }),
      );
      NodeAssert.deepEqual(NodeFS.readdirSync(root), []);
    }),
  );
}

test("old import-only opt-in never enables terminal capture", () =>
  withRoot((root) => {
    const f = fixture(),
      o = owner(root, { importOnly: true });
    o.capture({
      connection: "second",
      direction: "reply",
      message: f.message,
      predecessor: f.predecessor,
    });
    NodeAssert.equal(o.status(), "disabled");
    NodeAssert.deepEqual(NodeFS.readdirSync(root), []);
  }));
for (const mode of ["capacity", "collision"]) {
  test("omits a terminal refusal that depends on omitted global request state: " + mode, () =>
    withRoot((root) => {
      const o = owner(root),
        f = fixture(o.capture);
      const count = mode === "capacity" ? 126 : 1;
      for (let i = 0; i < count; i++)
        f.carry("second", "request", {
          _tag: "Request",
          id: String(10 + i),
          tag: "uploads.begin",
          payload: {},
          headers: [],
        });
      NodeAssert.throws(() =>
        f.carry("second", "request", {
          _tag: "Request",
          id: mode === "capacity" ? "200" : "10",
          tag: "terminal.resize",
          payload: {
            threadId: "owned-thread",
            terminalId: "term-1",
            cols: 91,
            rows: 24,
            sizeClaim: "second-claim",
          },
          headers: [],
        }),
      );
      NodeAssert.equal(o.status(), "failure-omitted");
      NodeAssert.deepEqual(NodeFS.readdirSync(root), []);
      f.observer.close();
      o.close();
    }),
  );
}
