// @effect-diagnostics nodeBuiltinImport:off - Original raw protocol fixtures drive the actual SDK receipt observer without product execution.
import * as NodeCrypto from "node:crypto";
import { expect, it } from "vite-plus/test";
import { createSizedPng } from "./chat-upload-fixture.ts";
import { createBrowserFollowupProtocolObserver } from "./release-visual-browser-followups-protocol.ts";
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
