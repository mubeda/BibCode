// @effect-diagnostics nodeBuiltinImport:off - Actual QA producer and protocol replay use inert browser/window/deadline endpoints only.
import * as NodeAssert from "node:assert/strict";
import * as NodeModule from "node:module";
import { it } from "vite-plus/test";
import { createBrowserFollowupReplayObserver } from "./release-visual-browser-followups-caller-protocol.ts";
import { createBrowserFollowupReplyGate } from "./release-visual-browser-followups-transport.ts";
import { runBrowserFollowupScene } from "./release-visual-browser-followups-producer.ts";
const serialization = NodeModule.createRequire(
  new URL("../../../../packages/contracts/package.json", import.meta.url),
)("effect/unstable/rpc/RpcSerialization").json.makeUnsafe();
function frame(message, client) {
  const body = Buffer.from(serialization.encode(message)),
    header = Buffer.alloc(body.length < 126 ? 2 : 4),
    mask = Buffer.from([7, 11, 19, 23]);
  header[0] = 129;
  header[1] = (client ? 128 : 0) | (header.length === 2 ? body.length : 126);
  if (header.length === 4) header.writeUInt16BE(body.length, 2);
  if (client) for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
  return Buffer.concat(client ? [header, mask, body] : [header, body]);
}
function fixture() {
  const census = {};
  const observer = createBrowserFollowupReplayObserver({
    registerInitialOwners: (owners) => Object.assign(census, owners),
    baseline: {
      threadId: "owned-thread",
      terminalId: "term-1",
      cwd: "/owned/project",
      pid: 123,
      history: "Owned shared terminal output\r\n",
      sequence: 10,
    },
    png: Buffer.from("inert"),
    cwd: "/owned/project",
    threadId: "owned-thread",
    terminalId: "term-1",
    patch: () => "",
    slowTransport: () => false,
  });
  const gates = new Map(),
    refusals = [],
    transcript = [];
  function carry(connection, direction, message) {
    let gate = gates.get(connection);
    if (!gate) {
      gate = createBrowserFollowupReplyGate({
        observeOriginal: (d, v) => observer.observe(connection, d, v),
      });
      gate.selectProtocol([], null);
      gates.set(connection, gate);
    }
    transcript.push({ connection, direction, message });
    try {
      const original = frame(message, direction === "request");
      const forwarded = direction === "request" ? gate.client(original) : gate.server(original);
      NodeAssert.deepEqual(Buffer.concat(forwarded), original);
    } catch (error) {
      refusals.push(error);
    }
  }
  const request = (c, id, tag, payload) =>
    carry(c, "request", { _tag: "Request", id, tag, payload, headers: [] });
  const snap = {
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
  const payload = (claim) => ({
    threadId: "owned-thread",
    terminalId: "term-1",
    cwd: "/owned/project",
    restartIfNotRunning: false,
    sizeClaim: claim,
  });
  const snapshot = (c, id) =>
    carry(c, "reply", {
      _tag: "Chunk",
      requestId: id,
      values: [{ type: "snapshot", snapshot: snap }],
    });
  const end = (c, id) =>
    carry(c, "reply", {
      _tag: "Exit",
      requestId: id,
      exit: { _tag: "Failure", cause: [{ _tag: "Interrupt" }] },
    });
  request("primary", "1", "subscribeServerConfig", {});
  request("primary", "2", "terminal.attach", payload("primary-claim"));
  snapshot("primary", "2");
  observer.terminalRestored();
  request("second", "1", "subscribeServerConfig", {});
  request("second", "2", "terminal.attach", payload("second-claim"));
  snapshot("second", "2");
  return { observer, carry, request, snapshot, end, payload, refusals, transcript, gates, census };
}
async function actualSizeReceipt(h) {
  const phases = [],
    guards = [],
    captures = [];
  let untilCalls = 0;
  const deadline = new Error("inert original size receipt deadline");
  const browser = {
    $$: () => [{}],
    $: () => ({
      waitForDisplayed: async () => {},
      waitForEnabled: async () => {},
      waitForClickable: async () => {},
      isDisplayed: async () => true,
      click: async () => {},
    }),
  };
  const input = {
    browser,
    owner: {
      until: async (predicate) => {
        untilCalls++;
        if (!(await predicate())) throw deadline;
      },
    },
    verifyOwnedIdentity: async () => {},
    viewport: async () => {},
    capture: async (scene, _browser, verify) => {
      await verify();
      await verify();
      captures.push(scene);
    },
    terminal: {
      withSecondWindow: async (run) =>
        run({
          browser,
          label: "sleep",
          verify: async () => h.observer.terminal(),
          prepareOriginalSizeOwner: async () => {},
          verifyFit: async () => {},
        }),
    },
    step: (p) => phases.push(p),
    observeUnsafeCleanup: () => {},
    observeTerminalReceiptFailure: (_error, reason) => guards.push(reason),
  };
  let error;
  try {
    await runBrowserFollowupScene(input, "terminal-shared-size");
  } catch (value) {
    error = value;
  }
  return { phases, guards, captures, untilCalls, error, deadline };
}
for (const actor of ["primary", "second"])
  for (const ordering of [
    "old-exit-first",
    "replacement-snapshot-first",
    "replacement-resize-first",
  ]) {
    it(
      "actual size receipt accepts an interrupted same-claim replacement: " +
        actor +
        "/" +
        ordering,
      async () => {
        const h = fixture();
        const claim = actor === "primary" ? "primary-claim" : "second-claim";
        h.carry(actor, "request", { _tag: "Interrupt", requestId: "2", interruptors: [] });
        if (ordering === "old-exit-first") h.end(actor, "2");
        h.request(actor, "3", "terminal.attach", h.payload(claim));
        if (ordering === "replacement-resize-first")
          h.request(actor, "4", "terminal.resize", {
            threadId: "owned-thread",
            terminalId: "term-1",
            cols: 91,
            rows: 24,
            sizeClaim: claim,
          });
        h.snapshot(actor, "3");
        h.carry(actor, "reply", {
          _tag: "Chunk",
          requestId: "2",
          values: [
            {
              type: "output",
              threadId: "owned-thread",
              terminalId: "term-1",
              data: "retired output must not prove current history",
              sequence: 11,
            },
          ],
        });
        if (ordering !== "old-exit-first") h.end(actor, "2");
        const result = await actualSizeReceipt(h);
        NodeAssert.equal(
          result.phases.includes(
            "visual-browser-followups-terminal-shared-size-terminal-receipt-wait",
          ),
          true,
        );
        if (result.error) {
          NodeAssert.equal(result.error, result.deadline);
          NodeAssert.deepEqual(result.guards, ["observer-unavailable"]);
        }
        NodeAssert.equal(
          result.error,
          undefined,
          JSON.stringify({ ordering, guards: result.guards, callbackRefusals: h.refusals.length }),
        );
        NodeAssert.equal(h.refusals.length, 0);
        NodeAssert.deepEqual(result.captures, ["terminal-shared-size"]);
        NodeAssert.deepEqual(result.guards, []);
      },
    );
  }
it("an unknown connection interrupt cannot retire either current renderer", async () => {
  const h = fixture();
  h.carry("foreign", "request", { _tag: "Interrupt", requestId: "2", interruptors: [] });
  const result = await actualSizeReceipt(h);
  NodeAssert.equal(result.error, undefined);
  NodeAssert.deepEqual(result.captures, ["terminal-shared-size"]);
  NodeAssert.equal(h.refusals.length, 0);
});
for (const actor of ["primary", "second"])
  it(
    "interrupting a pending attach preserves that renderer's current snapshot: " + actor,
    async () => {
      const h = fixture();
      const claim = actor === "primary" ? "primary-claim" : "second-claim";
      h.request(actor, "3", "terminal.attach", h.payload(claim));
      h.carry(actor, "request", { _tag: "Interrupt", requestId: "3", interruptors: [] });
      h.snapshot(actor, "3");
      h.end(actor, "3");
      NodeAssert.equal(h.census.replay().snapshots, "multiple");
      NodeAssert.equal(h.census.replay().configSnapshots, "multiple");
      const result = await actualSizeReceipt(h);
      NodeAssert.equal(result.error, undefined);
      NodeAssert.deepEqual(result.captures, ["terminal-shared-size"]);
      NodeAssert.equal(h.refusals.length, 0);
    },
  );
it("unsignaled second snapshot remains refused", async () => {
  const h = fixture();
  h.snapshot("second", "2");
  const result = await actualSizeReceipt(h);
  NodeAssert.equal(result.error, result.deadline);
  NodeAssert.deepEqual(result.guards, ["observer-unavailable"]);
  NodeAssert.deepEqual(result.captures, []);
});
