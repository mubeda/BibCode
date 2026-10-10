// @effect-diagnostics nodeBuiltinImport:off - Hermetic observer ports use the maintained parser and inert data.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { it as test } from "vite-plus/test";
import { createBrowserFollowupReplyGate } from "./release-visual-browser-followups-transport.ts";
import { plaintextRecords } from "../../../../packages/client-runtime/src/e2ee/frame.ts";

const source = NodeFS.readFileSync(
  new URL("./release-visual-import-evidence.ts", import.meta.url),
  "utf8",
);
function harness(
  options: {
    enabled?: boolean;
    admitThrows?: boolean;
    sealThrows?: boolean;
    publishThrows?: boolean;
  } = {},
) {
  const captured: Buffer[] = [],
    published: unknown[] = [],
    gates: ReturnType<typeof createBrowserFollowupReplyGate>[] = [];
  const owner = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      source.slice(source.indexOf("const headerLimit =")).replace(/^export /gm, ""),
    ) + "\ncreateImportEvidenceOwner",
    {
      Buffer,
      Uint8Array,
      createBrowserFollowupReplyGate(input: Parameters<typeof createBrowserFollowupReplyGate>[0]) {
        const gate = createBrowserFollowupReplyGate({
          ...input,
          now() {
            throw Error("observer must not read clock");
          },
        });
        gates.push(gate);
        return gate;
      },
      admitImportEvidenceRecipient() {
        if (options.admitThrows) throw Error("admission");
        return options.enabled === false
          ? null
          : { publicKey: {}, context: Buffer.from("bounded-public-context") };
      },
      sealImportFailure(_admission: unknown, reply: Uint8Array) {
        if (options.sealThrows) throw Error("seal");
        captured.push(Buffer.from(reply));
        return {
          context: Buffer.from("context"),
          ciphertext: Buffer.from("encrypted"),
          wrappedKey: Buffer.from("wrapped"),
          nonce: Buffer.from("nonce"),
          tag: Buffer.from("tag"),
        };
      },
      publishImportFailure(_root: string, envelope: unknown) {
        if (options.publishThrows) throw Error("publication");
        published.push(envelope);
      },
    },
  )({ env: {}, evidenceRoot: "/inert/private", platform: "linux" });
  return { owner, captured, published, gates };
}
function frame(value: unknown, request = false, binary = false): Buffer {
  let body = Buffer.from(JSON.stringify(value) + (binary ? "\n" : ""));
  if (binary)
    return Buffer.concat(
      [...plaintextRecords(body)].map((record) => rawFrame(Buffer.from(record), request, 2)),
    );
  return rawFrame(body, request, 1);
}
function rawFrame(body: Buffer, request = false, opcode = 1): Buffer {
  const header = Buffer.alloc(body.length < 126 ? 2 : body.length < 65536 ? 4 : 10);
  header[0] = 128 | opcode;
  header[1] =
    (request ? 128 : 0) | (header.length === 2 ? body.length : header.length === 4 ? 126 : 127);
  if (header.length === 4) header.writeUInt16BE(body.length, 2);
  if (header.length === 10) header.writeBigUInt64BE(BigInt(body.length), 2);
  const payload = Buffer.from(body),
    mask = Buffer.from([7, 11, 19, 23]);
  if (request)
    for (let i = 0; i < payload.length; i++)
      payload.writeUInt8(payload.readUInt8(i) ^ mask.readUInt8(i % 4), i);
  return Buffer.concat(request ? [header, mask, payload] : [header, payload]);
}
const subscription = {
  _tag: "Request",
  id: "1",
  tag: "subscribeServerConfig",
  payload: {},
  headers: [],
};
const command = (path = "/fixture/owned", id = "2") => ({
  _tag: "Request",
  id,
  tag: "orchestration.dispatchCommand",
  payload: { type: "project.create", workspaceRoot: path },
  headers: [["Authorization", "private-request-header"]],
});
const reply = (tag = "Failure", id = "2", detail = "owned refusal") => ({
  _tag: "Exit",
  requestId: id,
  exit:
    tag === "Failure"
      ? { _tag: "Failure", cause: [{ _tag: "Fail", error: { detail } }] }
      : { _tag: "Success", value: { sequence: 1 } },
  headers: [["private-reply-header", "omit"]],
});
function handshake(
  owner: ReturnType<typeof harness>["owner"],
  connection = "renderer",
  protocol: string | null = null,
) {
  owner.observeData(
    connection,
    "request",
    Buffer.from(
      "GET /ws HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nAuthorization: private-http-secret\r\n" +
        (protocol ? "Sec-WebSocket-Protocol: " + protocol + "\r\n" : "") +
        "\r\n",
    ),
  );
  owner.observeData(
    connection,
    "reply",
    Buffer.from(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        (protocol ? "Sec-WebSocket-Protocol: " + protocol + "\r\n" : "") +
        "\r\n",
    ),
  );
}
function bind(h: ReturnType<typeof harness>, connection = "renderer", binary = false) {
  h.owner.pinProject("/fixture/owned");
  handshake(h.owner, connection, binary ? "bibcode.rpc.chunked.v1" : null);
  h.owner.observeData(connection, "request", frame(subscription, true, binary));
  h.owner.observeData(connection, "request", frame(command(), true, binary));
}

test("disabled admission never parses or publishes", () => {
  const h = harness({ enabled: false });
  bind(h);
  h.owner.observeData("renderer", "reply", frame(reply()));
  NodeAssert.equal(h.owner.status(), "disabled");
  NodeAssert.equal(h.gates.length, 0);
  NodeAssert.equal(h.published.length, 0);
});
test("admission errors remain disabled and never escape", () => {
  const h = harness({ admitThrows: true });
  NodeAssert.equal(h.owner.status(), "disabled");
  NodeAssert.doesNotThrow(() => h.owner.close());
});
test("only renderer, exact fixture, connection and request bind the original failure", () => {
  const h = harness();
  h.owner.pinProject("/fixture/owned");
  handshake(h.owner, "foreign");
  h.owner.observeData("foreign", "request", frame(command(), true));
  NodeAssert.equal(h.owner.status(), "not-observed");
  handshake(h.owner);
  h.owner.observeData("renderer", "request", frame(subscription, true));
  h.owner.observeData("renderer", "request", frame(command("/fixture/other"), true));
  NodeAssert.equal(h.owner.status(), "not-observed");
  h.owner.observeData("renderer", "request", frame(command(), true));
  NodeAssert.equal(h.owner.status(), "pending");
  h.owner.observeData("foreign", "reply", frame(reply()));
  h.owner.observeData("renderer", "reply", frame(reply("Failure", "3")));
  NodeAssert.equal(h.owner.status(), "pending");
  h.owner.observeData("renderer", "reply", frame(reply()));
  NodeAssert.equal(h.owner.status(), "failure-encrypted");
  NodeAssert.deepEqual(JSON.parse(h.captured[0]!.toString()), {
    _tag: "Exit",
    requestId: "2",
    exit: reply().exit,
  });
  NodeAssert.equal(h.captured[0]!.includes("private-http-secret"), false);
  NodeAssert.equal(h.captured[0]!.includes("private-request-header"), false);
  NodeAssert.equal(h.captured[0]!.includes("private-reply-header"), false);
  h.owner.observeData("renderer", "reply", frame(reply()));
  NodeAssert.equal(h.published.length, 1);
  NodeAssert.equal(h.captured.length, 1);
  NodeAssert.equal(h.gates[0]!.observation().armed, false);
});
test("matching success reports success without publication", () => {
  const h = harness();
  bind(h);
  h.owner.observeData("renderer", "reply", frame(reply("Success")));
  NodeAssert.equal(h.owner.status(), "success");
  NodeAssert.equal(h.published.length, 0);
});
test("requests before pin and authentication are never selected", () => {
  const h = harness();
  handshake(h.owner);
  h.owner.observeData("renderer", "request", frame(subscription, true));
  h.owner.observeData("renderer", "request", frame(command(), true));
  h.owner.pinProject("/fixture/owned");
  h.owner.observeData(
    "renderer",
    "request",
    frame(
      { _tag: "Request", id: "2", tag: "authenticate", payload: { secret: "private-auth" } },
      true,
    ),
  );
  h.owner.observeData("renderer", "reply", frame(reply()));
  NodeAssert.equal(h.owner.status(), "not-observed");
  NodeAssert.equal(h.captured.length, 0);
});
test("fragmented headers and coalesced first frames are read-only", () => {
  const h = harness();
  h.owner.pinProject("/fixture/owned");
  const request = Buffer.concat([
    Buffer.from("GET /ws HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"),
    frame(subscription, true),
    frame(command(), true),
  ]);
  const before = Buffer.from(request);
  for (let i = 0; i < request.length; i += 3)
    h.owner.observeData("renderer", "request", request.subarray(i, i + 3));
  h.owner.observeData(
    "renderer",
    "reply",
    Buffer.concat([
      Buffer.from(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      ),
      frame(reply()),
    ]),
  );
  NodeAssert.equal(h.owner.status(), "failure-encrypted");
  NodeAssert.deepEqual(request, before);
});
test("negotiated binary records observe the logical failure", () => {
  const h = harness();
  bind(h, "renderer", true);
  const wire = frame(reply("Failure", "2", "x".repeat(140000)), false, true);
  for (let i = 0; i < wire.length; i += 777)
    h.owner.observeData("renderer", "reply", wire.subarray(i, i + 777));
  NodeAssert.equal(h.owner.status(), "failure-encrypted");
  NodeAssert.equal(JSON.parse(h.captured[0]!.toString()).exit.cause[0].error.detail.length, 140000);
});
test("oversized selected failure is omitted without sealing", () => {
  const h = harness();
  bind(h);
  h.owner.observeData("renderer", "reply", frame(reply("Failure", "2", "x".repeat(262144))));
  NodeAssert.equal(h.owner.status(), "failure-omitted");
  NodeAssert.equal(h.captured.length, 0);
  NodeAssert.equal(h.published.length, 0);
});
for (const option of ["sealThrows", "publishThrows"] as const)
  test(option + " is isolated and not retried", () => {
    const h = harness({ [option]: true });
    bind(h);
    NodeAssert.doesNotThrow(() => h.owner.observeData("renderer", "reply", frame(reply())));
    NodeAssert.equal(h.owner.status(), "failure-omitted");
    h.owner.observeData("renderer", "reply", frame(reply()));
    NodeAssert.equal(h.published.length, 0);
    NodeAssert.equal(h.captured.length, option === "publishThrows" ? 1 : 0);
  });
test("invalid negotiated protocol is ignored without affecting its owner", () => {
  const h = harness();
  h.owner.pinProject("/fixture/owned");
  NodeAssert.doesNotThrow(() => handshake(h.owner, "invalid", "unknown.protocol"));
  NodeAssert.equal(h.owner.status(), "not-observed");
  NodeAssert.equal(h.published.length, 0);
});
test("malformed frames clear the bound parser without escaping", () => {
  const h = harness();
  bind(h);
  NodeAssert.doesNotThrow(() => h.owner.observeData("renderer", "reply", Buffer.from([0, 0])));
  NodeAssert.equal(h.owner.status(), "failure-omitted");
  NodeAssert.equal(h.gates[0]!.observation().retainedBytes, 0);
  NodeAssert.equal(h.published.length, 0);
});
test("closed owner and wire clear partial parser buffers and cannot publish", () => {
  const h = harness();
  bind(h);
  h.owner.observeData("renderer", "reply", frame(reply()).subarray(0, 5));
  NodeAssert.ok(h.gates[0]!.observation().retainedBytes > 0);
  h.owner.connectionClosed("renderer");
  NodeAssert.equal(h.gates[0]!.observation().retainedBytes, 0);
  h.owner.close();
  h.owner.close();
  h.owner.observeData("renderer", "reply", frame(reply()));
  NodeAssert.equal(h.published.length, 0);
});
test("at most 128 connection parsers can be retained", () => {
  const h = harness();
  for (let i = 0; i < 129; i++) handshake(h.owner, "wire-" + i);
  NodeAssert.equal(h.gates.length, 128);
  h.owner.close();
  NodeAssert.equal(
    h.gates.every((g) => g.observation().closed && g.observation().retainedBytes === 0),
    true,
  );
});
test("unbounded or nonupgrade HTTP headers are dropped passively", () => {
  const h = harness();
  NodeAssert.doesNotThrow(() =>
    h.owner.observeData("oversized", "request", Buffer.alloc(16385, 65)),
  );
  h.owner.observeData(
    "plain",
    "request",
    Buffer.from("POST /auth HTTP/1.1\r\nContent-Length: 12\r\n\r\nprivate-body"),
  );
  NodeAssert.equal(h.owner.status(), "not-observed");
  NodeAssert.equal(h.captured.length, 0);
  h.owner.close();
  NodeAssert.equal(
    h.gates.every((g) => g.observation().retainedBytes === 0),
    true,
  );
});

test("oversized observation chunks invalidate a pending parser rather than skipping original bytes", () => {
  const h = harness();
  bind(h);
  h.owner.observeData("renderer", "reply", frame(reply()).subarray(0, 5));
  h.owner.observeData("renderer", "reply", Buffer.alloc(1048577));
  NodeAssert.equal(h.owner.status(), "failure-omitted");
  NodeAssert.equal(h.gates[0]!.observation().retainedBytes, 0);
  NodeAssert.equal(h.published.length, 0);
});
