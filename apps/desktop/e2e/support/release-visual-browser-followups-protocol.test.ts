// @effect-diagnostics nodeBuiltinImport:off - Original raw protocol fixtures drive the actual SDK receipt observer without product execution.
import * as NodeCrypto from "node:crypto";
import { expect, it } from "vite-plus/test";
import * as NodeModule from "node:module";
import { stageUpload } from "../../../../packages/client-runtime/src/operations/uploadStager.ts";
import { uploadHarness } from "../../../../packages/client-runtime/src/operations/uploadStager.testSupport.ts";
import { createSizedPng } from "./chat-upload-fixture.ts";
import { createBrowserFollowupProtocolObserver } from "./release-visual-browser-followups-protocol.ts";
const requireFramework = NodeModule.createRequire(
  new URL("../../../../packages/client-runtime/package.json", import.meta.url),
);
const Effect = requireFramework("effect/Effect");
const RpcSerialization = requireFramework("effect/unstable/rpc/RpcSerialization");
const png = createSizedPng(512 * 1024, "browser-followup");
const patch =
  "diff --git a/pierre-step5.ts b/pierre-step5.ts\n--- a/pierre-step5.ts\n+++ b/pierre-step5.ts\n@@ -1 +1 @@\n-old\n+new\n";
function fixture() {
  const observer = createBrowserFollowupProtocolObserver({
    png,
    cwd: "/owned/project",
    threadId: "owned-thread",
    terminalId: "term-1",
    patch: () => patch,
    slowTransport: () => true,
  });
  const request = (connection: string, id: string, tag: string, payload: object) =>
    observer.observe(connection, "request", { _tag: "Request", id, tag, payload, headers: [] });
  const reply = (connection: string, id: string, value: unknown) =>
    observer.observe(connection, "reply", {
      _tag: "Exit",
      requestId: id,
      exit: { _tag: "Success", value },
    });
  const chunk = (connection: string, id: string, event: object) =>
    observer.observe(connection, "reply", { _tag: "Chunk", requestId: id, values: [event] });
  return { observer, request, reply, chunk };
}
function begin(value: ReturnType<typeof fixture>) {
  value.request("first", "1", "uploads.begin", {
    target: {
      _tag: "chat-attachment",
      type: "image",
      name: "upload-browser-followup.png",
      mimeType: "image/png",
    },
    sizeBytes: png.length,
    sha256: NodeCrypto.createHash("sha256").update(png).digest("hex"),
  });
  value.reply("first", "1", { uploadId: "owned-upload", exists: false });
}
function terminalFixture() {
  const value = fixture();
  const snapshot = {
    threadId: "owned-thread",
    terminalId: "term-1",
    cwd: "/owned/project",
    worktreePath: null,
    status: "running",
    pid: 123,
    history: "Owned shared terminal output\r\n",
    exitCode: null,
    exitSignal: null,
    label: "Terminal 1",
    updatedAt: "2026-10-06T10:00:00.000Z",
    size: { cols: 91, rows: 24, sizeClaim: "first-owner" },
  };
  for (const [connection, claim] of [
    ["first", "first-owner"],
    ["second", "second-owner"],
  ] as const) {
    value.request(connection, "1", "terminal.attach", {
      threadId: "owned-thread",
      terminalId: "term-1",
      cwd: "/owned/project",
      sizeClaim: claim,
    });
    value.chunk(connection, "1", { type: "snapshot", snapshot });
  }
  const fit = () => {
    for (const connection of ["first", "second"])
      value.chunk(connection, "1", {
        type: "resized",
        threadId: "owned-thread",
        terminalId: "term-1",
        size: { cols: 91, rows: 30, sizeClaim: "second-owner" },
      });
  };
  return { ...value, fit };
}
it.each(["thread", "terminal"])(
  "retires terminal proof after a foreign %s resize on an owned attach stream",
  (mode) => {
    const value = terminalFixture();
    value.fit();
    expect(() => value.observer.fitted()).not.toThrow();
    expect(() =>
      value.chunk("second", "1", {
        type: "resized",
        threadId: mode === "thread" ? "foreign-thread" : "owned-thread",
        terminalId: mode === "terminal" ? "term-2" : "term-1",
        size: { cols: 91, rows: 30, sizeClaim: "second-owner" },
      }),
    ).toThrow();
    expect(() => value.observer.fitted()).toThrow();
    expect(() => value.observer.terminal()).toThrow();
  },
);
it.each(["thread", "terminal", "claim"])(
  "refuses a foreign %s resize command from an owned renderer before cached Fit can be reused",
  (mode) => {
    const value = terminalFixture();
    value.fit();
    expect(() => value.observer.fitted()).not.toThrow();
    expect(() =>
      value.request("second", "2", "terminal.resize", {
        threadId: mode === "thread" ? "foreign-thread" : "owned-thread",
        terminalId: mode === "terminal" ? "term-2" : "term-1",
        cols: 91,
        rows: 30,
        sizeClaim: mode === "claim" ? "foreign-owner" : "second-owner",
      }),
    ).toThrow();
    expect(() => value.observer.fitted()).toThrow();
  },
);
it.each(["Success", "Failure"])(
  "retires an ended %s attach stream before its cached snapshots can prove Fit",
  (tag) => {
    const value = terminalFixture();
    value.fit();
    expect(() => value.observer.fitted()).not.toThrow();
    value.observer.observe("second", "reply", {
      _tag: "Exit",
      requestId: "1",
      exit: { _tag: tag, value: undefined, cause: [] },
    });
    expect(() => value.observer.fitted()).toThrow();
    expect(() => value.observer.terminal()).toThrow();
    value.chunk("second", "1", {
      type: "resized",
      threadId: "owned-thread",
      terminalId: "term-1",
      size: { cols: 91, rows: 30, sizeClaim: "second-owner" },
    });
    expect(() => value.observer.fitted()).toThrow();
  },
);
it("requires resize proof from both still-current owned streams before Fit and ignores an ended request id", () => {
  const value = terminalFixture();
  value.chunk("second", "1", {
    type: "resized",
    threadId: "owned-thread",
    terminalId: "term-1",
    size: { cols: 91, rows: 30, sizeClaim: "second-owner" },
  });
  expect(() => value.observer.fitted()).toThrow();
  value.chunk("first", "1", {
    type: "resized",
    threadId: "owned-thread",
    terminalId: "term-1",
    size: { cols: 91, rows: 30, sizeClaim: "second-owner" },
  });
  expect(() => value.observer.fitted()).not.toThrow();
  value.reply("second", "1", undefined);
  value.request("second", "2", "terminal.attach", {
    threadId: "owned-thread",
    terminalId: "term-1",
    cwd: "/owned/project",
    sizeClaim: "new-second-owner",
  });
  value.chunk("second", "1", {
    type: "resized",
    threadId: "owned-thread",
    terminalId: "term-1",
    size: { cols: 91, rows: 30, sizeClaim: "new-second-owner" },
  });
  expect(() => value.observer.fitted()).toThrow();
});
it("observes the genuine staged PNG bytes and same-stage cancellation rather than guessing progress", () => {
  const value = fixture();
  begin(value);
  expect(() => value.observer.upload()).toThrow();
  value.request("first", "2", "uploads.append", {
    uploadId: "owned-upload",
    offset: 0,
    data: png.subarray(0, 16384).toString("base64"),
  });
  expect(value.observer.upload().unfinished).toBe(true);
  value.reply("first", "2", { receivedBytes: 16384 });
  value.request("first", "3", "uploads.cancel", { uploadId: "owned-upload" });
  value.reply("first", "3", {});
  expect(() => value.observer.cancelled()).not.toThrow();
  expect(() => value.observer.upload()).toThrow();
});
it("distinguishes actual renderer configuration subscriptions from auxiliary source API peers", () => {
  const value = fixture();
  value.request("api", "1", "server.getConfig", {});
  expect(value.observer.rendererConnection("api")).toBe(false);
  value.request("renderer", "1", "subscribeServerConfig", {});
  expect(value.observer.rendererConnection("renderer")).toBe(true);
  value.observer.connectionClosed("renderer");
  expect(value.observer.rendererConnection("renderer")).toBe(false);
});
it("refuses changed append bytes and a foreign review result", () => {
  const value = fixture();
  begin(value);
  expect(() =>
    value.request("first", "2", "uploads.append", {
      uploadId: "owned-upload",
      offset: 0,
      data: Buffer.from("wrong").toString("base64"),
    }),
  ).toThrow();
  value.request("first", "3", "review.getDiffPreview", { cwd: "/other" });
  expect(() => value.reply("first", "3", {})).toThrow();
});
it("joins a typed current review reply to the actual original Git patch", () => {
  const value = fixture();
  value.request("first", "1", "review.getDiffPreview", { cwd: "/owned/project" });
  value.reply("first", "1", {
    cwd: "/owned/project",
    generatedAt: "2026-10-06T10:00:00.000Z",
    sources: [
      {
        id: "working-tree",
        kind: "working-tree",
        title: "Dirty worktree",
        baseRef: "HEAD",
        headRef: null,
        diff: patch.trimEnd(),
        diffHash: NodeCrypto.createHash("sha256").update(patch.trimEnd()).digest("hex"),
        truncated: false,
      },
    ],
  });
  expect(value.observer.diff().originalPatchMatched).toBe(true);
});
it("joins two actual terminal attachments and requires a real resize event before Fit succeeds", () => {
  const value = fixture();
  const snapshot = {
    threadId: "owned-thread",
    terminalId: "term-1",
    cwd: "/owned/project",
    worktreePath: null,
    status: "running",
    pid: 123,
    history: "Owned shared terminal output\r\n",
    exitCode: null,
    exitSignal: null,
    label: "Terminal 1",
    updatedAt: "2026-10-06T10:00:00.000Z",
    size: { cols: 91, rows: 24, sizeClaim: "first-owner" },
  };
  for (const [connection, claim] of [
    ["first", "first-owner"],
    ["second", "second-owner"],
  ]) {
    value.request(connection!, "1", "terminal.attach", {
      threadId: "owned-thread",
      terminalId: "term-1",
      cwd: "/owned/project",
      sizeClaim: claim,
    });
    value.chunk(connection!, "1", { type: "snapshot", snapshot });
  }
  expect(value.observer.terminal().sameTerminalMatched).toBe(true);
  expect(() => value.observer.fitted()).toThrow();
  value.chunk("second", "1", {
    type: "resized",
    threadId: "owned-thread",
    terminalId: "term-1",
    size: { cols: 91, rows: 30, sizeClaim: "second-owner" },
  });
  value.chunk("first", "1", {
    type: "resized",
    threadId: "owned-thread",
    terminalId: "term-1",
    size: { cols: 91, rows: 30, sizeClaim: "second-owner" },
  });
  expect(() => value.observer.fitted()).not.toThrow();
  value.observer.connectionClosed("second");
  expect(() => value.observer.terminal()).toThrow();
  value.chunk("first", "1", {
    type: "resized",
    threadId: "owned-thread",
    terminalId: "term-1",
    size: { cols: 91, rows: 24, sizeClaim: "first-owner" },
  });
  expect(() => value.observer.terminalRestored()).not.toThrow();
  value.observer.close();
  expect(() => value.observer.terminalRestored()).toThrow();
});

function stageThroughActualObserver(holdFirstAcknowledgement: boolean) {
  const value = fixture();
  const harness = uploadHarness(true, png.length);
  const beginPort = harness.begin.getMockImplementation();
  const appendPort = harness.append.getMockImplementation();
  const cancelPort = harness.cancel.getMockImplementation();
  if (!beginPort || !appendPort || !cancelPort)
    throw new Error("Maintained upload ports unavailable.");
  const codec = RpcSerialization.json.makeUnsafe();
  let ordinal = 0;
  const carry = (direction: "request" | "reply", envelope: object) => {
    const encoded = codec.encode(envelope);
    if (encoded === undefined) throw new Error("Maintained JSON serialization refused.");
    const decoded = codec.decode(typeof encoded === "string" ? Buffer.from(encoded) : encoded);
    if (decoded.length !== 1) throw new Error("Maintained JSON envelope refused.");
    const envelopeValue = decoded[0];
    if (typeof envelopeValue !== "object" || envelopeValue === null || Array.isArray(envelopeValue))
      throw new Error("Maintained JSON object refused.");
    value.observer.observe("first", direction, envelopeValue as Readonly<Record<string, unknown>>);
  };
  let releaseFirst: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let concurrentRefusal = false;
  const acknowledgementEnds: number[] = [];
  harness.begin.mockImplementation((input) =>
    Effect.gen(function* () {
      const id = String(++ordinal);
      carry("request", { _tag: "Request", id, tag: "uploads.begin", payload: input, headers: [] });
      const result = yield* beginPort(input);
      carry("reply", { _tag: "Exit", requestId: id, exit: { _tag: "Success", value: result } });
      return result;
    }),
  );
  harness.append.mockImplementation((input) =>
    Effect.gen(function* () {
      const id = String(++ordinal);
      try {
        carry("request", {
          _tag: "Request",
          id,
          tag: "uploads.append",
          payload: input,
          headers: [],
        });
      } catch (error) {
        concurrentRefusal = input.offset > 0 && holdFirstAcknowledgement;
        releaseFirst?.();
        throw error;
      }
      if (holdFirstAcknowledgement && input.offset === 0) yield* Effect.promise(() => held);
      const result = yield* appendPort(input);
      carry("reply", { _tag: "Exit", requestId: id, exit: { _tag: "Success", value: result } });
      acknowledgementEnds.push(result.receivedBytes);
      if (holdFirstAcknowledgement && input.offset > 0) releaseFirst?.();
      return result;
    }),
  );
  harness.cancel.mockImplementation((input) =>
    Effect.gen(function* () {
      const id = String(++ordinal);
      carry("request", { _tag: "Request", id, tag: "uploads.cancel", payload: input, headers: [] });
      const result = yield* cancelPort(input);
      carry("reply", { _tag: "Exit", requestId: id, exit: { _tag: "Success", value: result } });
      return result;
    }),
  );
  const run = stageUpload(
    {
      target: {
        _tag: "chat-attachment",
        type: "image",
        name: "upload-browser-followup.png",
        mimeType: "image/png",
      },
      file: new Blob([Uint8Array.from(png)]),
      fileName: "upload-browser-followup.png",
    },
    harness.port,
  );
  return {
    ...value,
    harness,
    run,
    acknowledgementEnds,
    concurrentRefusal: () => concurrentRefusal,
  };
}
it("accepts the actual staged client without prehashed begin and validates its final hash", async () => {
  const value = stageThroughActualObserver(false);
  const result = await Effect.runPromise(value.run);
  expect(result.sizeBytes).toBe(png.length);
  expect(value.harness.begin.mock.calls[0]?.[0].sha256).toBeUndefined();
  expect(value.harness.append.mock.calls.at(-1)?.[0].sha256).toBe(
    NodeCrypto.createHash("sha256").update(png).digest("hex"),
  );
  expect(() => value.observer.upload()).toThrow();
});
it("completes actual staged upload when the second ACK precedes the held first ACK", async () => {
  const value = stageThroughActualObserver(true);
  const result = await Effect.runPromise(value.run);
  expect(result.sizeBytes).toBe(png.length);
  expect(value.concurrentRefusal()).toBe(false);
  expect(value.acknowledgementEnds.slice(0, 2)).toEqual([128 * 1024, 64 * 1024]);
  expect(value.harness.cancel).not.toHaveBeenCalled();
  expect(() => value.observer.upload()).toThrow();
});
function acknowledgeOriginalPrefix(value: ReturnType<typeof fixture>) {
  const chunkBytes = 64 * 1024;
  for (let offset = 0; offset < png.length - chunkBytes; offset += chunkBytes) {
    const id = String(2 + offset / chunkBytes);
    value.request("first", id, "uploads.append", {
      uploadId: "owned-upload",
      offset,
      data: png.subarray(offset, offset + chunkBytes).toString("base64"),
    });
    value.reply("first", id, { receivedBytes: offset + chunkBytes });
  }
  return png.length - chunkBytes;
}
it.each(["begin", "append"])("refuses an explicitly wrong %s digest", (operation) => {
  const value = fixture();
  if (operation === "begin") {
    value.request("first", "1", "uploads.begin", {
      target: {
        _tag: "chat-attachment",
        type: "image",
        name: "upload-browser-followup.png",
        mimeType: "image/png",
      },
      sizeBytes: png.length,
      sha256: "0".repeat(64),
    });
    expect(() => value.reply("first", "1", { uploadId: "owned-upload", exists: false })).toThrow();
  } else {
    begin(value);
    const offset = acknowledgeOriginalPrefix(value);
    expect(() =>
      value.request("first", "2", "uploads.append", {
        uploadId: "owned-upload",
        offset,
        data: png.subarray(offset).toString("base64"),
        sha256: "0".repeat(64),
      }),
    ).toThrow();
  }
});

it("admits a matching digest only at the complete canonical image boundary", () => {
  const value = fixture();
  begin(value);
  const digest = NodeCrypto.createHash("sha256").update(png).digest("hex");
  expect(() =>
    value.request("first", "2", "uploads.append", {
      uploadId: "owned-upload",
      offset: 0,
      data: png.subarray(0, 16384).toString("base64"),
      sha256: digest,
    }),
  ).toThrow();
  const complete = fixture();
  begin(complete);
  const offset = acknowledgeOriginalPrefix(complete);
  expect(() =>
    complete.request("first", "9", "uploads.append", {
      uploadId: "owned-upload",
      offset,
      data: png.subarray(offset).toString("base64"),
      sha256: digest,
    }),
  ).not.toThrow();
});

it.each(["offset", "data", "upload"])("refuses malformed pipelined %s request", (fault) => {
  const value = fixture();
  begin(value);
  value.request("first", "2", "uploads.append", {
    uploadId: "owned-upload",
    offset: 0,
    data: png.subarray(0, 16384).toString("base64"),
  });
  expect(() =>
    value.request("first", "3", "uploads.append", {
      uploadId: fault === "upload" ? "foreign-upload" : "owned-upload",
      offset: fault === "offset" ? 0 : 16384,
      data:
        fault === "data"
          ? Buffer.from("not-original").toString("base64")
          : png.subarray(16384, 32768).toString("base64"),
    }),
  ).toThrow();
});
it.each([0, 1, 32768, 16383, 16385, -1, 1.5, Number.MAX_SAFE_INTEGER])(
  "rejects ACK %s not bound to its carrying request",
  (count) => {
    const value = fixture();
    begin(value);
    value.request("first", "2", "uploads.append", {
      uploadId: "owned-upload",
      offset: 0,
      data: png.subarray(0, 16384).toString("base64"),
    });
    value.request("first", "3", "uploads.append", {
      uploadId: "owned-upload",
      offset: 16384,
      data: png.subarray(16384, 32768).toString("base64"),
    });
    expect(() => value.reply("first", "2", { receivedBytes: count })).toThrow();
  },
);
it("accepts exact reversed ACKs and retains unfinished progress", () => {
  const value = fixture();
  begin(value);
  value.request("first", "2", "uploads.append", {
    uploadId: "owned-upload",
    offset: 0,
    data: png.subarray(0, 16384).toString("base64"),
  });
  value.request("first", "3", "uploads.append", {
    uploadId: "owned-upload",
    offset: 16384,
    data: png.subarray(16384, 32768).toString("base64"),
  });
  expect(() => value.reply("first", "3", { receivedBytes: 32768 })).not.toThrow();
  expect(() => value.reply("first", "2", { receivedBytes: 16384 })).not.toThrow();
  expect(value.observer.upload().unfinished).toBe(true);
});
