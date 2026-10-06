// @effect-diagnostics nodeBuiltinImport:off - Inert source ports and bounded generated fake children only.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";
import * as NodeCrypto from "node:crypto";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  providerChatFileBaseline,
  providerChatFileUpdated,
} from "./release-visual-provider-chat-media.ts";
import * as Fixture from "./release-visual-provider-chat-fixture.ts";
import { desktopActivityFixture, desktopActivityMarkerFileName } from "./activity-events.ts";
import { extendOwnedClaudeVisualFixture } from "./release-visual-provider-chat-fixture.ts";

function originalClaude() {
  const source = NodeFS.readFileSync(new URL("./test-project.ts", import.meta.url), "utf8");
  const start = source.indexOf("const claudeFixtureSource = String.raw`");
  const end = source.indexOf("const cursorFixtureSource", start);
  return NodeVM.runInNewContext(source.slice(start, end) + "\nclaudeFixtureSource", {
    STREAMED_RESPONSE: "Owned baseline response.",
  }) as string;
}
const mediaRoots: string[] = [];
afterEach(() => {
  for (const root of mediaRoots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});
function mediaProtocolInput() {
  const fixture = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "provider-protocol-media-")),
  );
  mediaRoots.push(fixture);
  const root = NodePath.join(fixture, "light"),
    worktree = NodePath.join(root, "managed");
  NodeFS.mkdirSync(worktree, { recursive: true, mode: 0o700 });
  const source = NodePath.join(worktree, "visual-chat.ts"),
    image = NodePath.join(worktree, "visual-swatch.png");
  NodeFS.writeFileSync(source, providerChatFileBaseline, { mode: 0o600 });
  NodeFS.writeFileSync(image, "Owned protocol source bytes.", { mode: 0o600 });
  const sourceStat = NodeFS.statSync(source),
    imageStat = NodeFS.statSync(image);
  const hash = (bytes: string) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  NodeFS.writeFileSync(
    NodePath.join(root, "provider-chat-media.json"),
    JSON.stringify({
      kind: "provider-chat-v1",
      worktreePath: worktree,
      threadId: "owned-thread",
      assetRelativeUrl: "/api/assets/owned-token/visual-swatch.png",
      sourceSha256: hash(providerChatFileBaseline),
      updatedSha256: hash(providerChatFileUpdated),
      imageSha256: hash("Owned protocol source bytes."),
      sourceDev: sourceStat.dev,
      sourceIno: sourceStat.ino,
      imageDev: imageStat.dev,
      imageIno: imageStat.ino,
    }),
    { mode: 0o600 },
  );
  return {
    environment: { CI: "true", BIBCODE_UPLOAD_FIXTURE: fixture, BIBCODE_E2E_RUN_ROOT: root },
    cwd: () => worktree,
  };
}
function inertChild(
  source: string,
  environment: Record<string, string> = { CI: "true" },
  cwd?: () => string,
) {
  const frames: Array<Record<string, unknown>> = [];
  const inputs: string[] = [];
  let line: (value: string) => void = () => {};
  NodeVM.runInNewContext(source.replace(/^import .*;\n/gm, ""), {
    process: {
      argv: [],
      env: environment,
      cwd,
      stdout: { write: (value: string) => frames.push(JSON.parse(value)) },
    },
    readline: {
      createInterface: () => ({
        on: (_event: string, receive: typeof line) => {
          line = receive;
        },
      }),
    },
    promptTextFromParts: (parts: Array<{ text?: string }>) =>
      parts.map((part) => part.text ?? "").join(""),
    appendProviderInput: (_provider: string, input: string) => inputs.push(input),
    randomUUID: () => "owned-fixed-id",
    fs: NodeFS,
    path: NodePath,
    visualHash: NodeCrypto.createHash,
    Buffer,
    URL,
  });
  return { frames, inputs, receive: (value: unknown) => line(JSON.stringify(value)) };
}
describe("owned opt-in Claude visual protocol extension", () => {
  it.each(["get_context_usage", "mcp_status"])(
    "answers actual correlated %s requests without a provider child",
    (subtype) => {
      const requestFixture = JSON.parse(
        NodeFS.readFileSync(
          new URL(
            "../../../server/tests/fixtures/claude-provider/control-requests.json",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const request =
        subtype === "get_context_usage" ? requestFixture.getContextUsage : requestFixture.mcpStatus;
      const original = inertChild(originalClaude());
      original.receive(request);
      expect(original.frames).toEqual([]);
      const child = inertChild(
        extendOwnedClaudeVisualFixture(originalClaude(), "provider-chat-v1"),
      );
      child.receive(request);
      expect(child.frames).toHaveLength(1);
      const response = child.frames[0]!.response as Record<string, unknown>;
      expect(child.frames[0]!.type).toBe("control_response");
      expect(response.request_id).toBe(request.request_id);
      expect(response.subtype).toBe("success");
      if (subtype === "get_context_usage") {
        const usage = JSON.parse(
          NodeFS.readFileSync(
            new URL(
              "../../../server/tests/fixtures/claude-provider/context-usage.json",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        expect(response.response).toEqual(usage.querySuccess);
      } else {
        expect(response.response).toEqual({
          mcpServers: [
            { name: "owned-visual-mcp-server-with-a-long-name-that-wraps", status: "connected" },
            {
              name: "owned-unavailable-server",
              status: "failed",
              error: "Owned fixture endpoint is unavailable.",
            },
          ],
        });
      }
      expect(child.inputs).toEqual([]);
    },
  );
  it("preserves default requests and ordinary user input while emitting real plan frames for one fixed prompt", () => {
    const source = originalClaude();
    const before = inertChild(source),
      after = inertChild(extendOwnedClaudeVisualFixture(source, "provider-chat-v1"));
    for (const value of [
      { type: "control_request", request_id: "bibcode-1", request: { subtype: "initialize" } },
      {
        type: "user",
        session_id: "owned-session",
        message: { content: [{ type: "text", text: "ordinary owned prompt" }] },
      },
    ]) {
      before.receive(value);
      after.receive(value);
    }
    expect(after.frames).toEqual(before.frames);
    expect(after.inputs).toEqual(before.inputs);
    const media = mediaProtocolInput();
    const child = inertChild(
      extendOwnedClaudeVisualFixture(source, "provider-chat-v1"),
      media.environment,
      media.cwd,
    );
    child.receive({
      type: "user",
      session_id: "owned-session",
      message: { content: [{ type: "text", text: "Owned visual markdown and plan" }] },
    });
    expect(child.inputs).toEqual(["Owned visual markdown and plan"]);
    const assistant = child.frames.find((frame) => frame.type === "assistant")!;
    expect(assistant).toBeDefined();
    const content = (assistant.message as { content: Array<Record<string, unknown>> }).content;
    const nativePlan = JSON.parse(
      NodeFS.readFileSync(
        new URL(
          "../../../server/tests/fixtures/claude-provider/exit-plan-message.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(content[0]!.type).toBe(nativePlan.message.message.content[0].type);
    expect(content[0]!.name).toBe("ExitPlanMode");
    expect((content[0]!.input as { plan: string }).plan).toContain("Owned visual plan");
    expect(child.frames.at(-1)!.type).toBe("result");
    expect(JSON.stringify(child.frames)).not.toMatch(
      /user-input.requested|capabilities|orchestration/,
    );
  });
  it("refuses runtime admission outside the real CI owner", () => {
    expect(() =>
      inertChild(extendOwnedClaudeVisualFixture(originalClaude(), "provider-chat-v1"), {}),
    ).toThrow("requires CI ownership");
  });
  it.each(["", "release-visual-core", "provider-chat-v2"])(
    "refuses unknown opt-in mode %s",
    (mode) => {
      expect(() => extendOwnedClaudeVisualFixture(originalClaude(), mode)).toThrow(
        "Owned visual provider fixture refused.",
      );
    },
  );
  it("refuses forged/missing/duplicate source anchors and invalid control correlation", () => {
    for (const source of [
      "",
      originalClaude().replace("const message = JSON.parse(line);", ""),
      originalClaude() + "\nconst message = JSON.parse(line);",
    ])
      expect(() => extendOwnedClaudeVisualFixture(source, "provider-chat-v1")).toThrow();
    const child = inertChild(extendOwnedClaudeVisualFixture(originalClaude(), "provider-chat-v1"));
    for (const request_id of ["", "private\nvalue", "x".repeat(129)])
      expect(() =>
        child.receive({ type: "control_request", request_id, request: { subtype: "mcp_status" } }),
      ).toThrow();
    expect(child.frames).toEqual([]);
  });
});

function originalCodex() {
  const source = NodeFS.readFileSync(new URL("./test-project.ts", import.meta.url), "utf8");
  const start = source.indexOf("const codexFixtureSource = String.raw`");
  const end = source.indexOf("const providerInputLogFixtureSource", start);
  return NodeVM.runInNewContext(source.slice(start, end) + "\ncodexFixtureSource", {
    STREAMED_RESPONSE: "Owned baseline response.",
    desktopActivityFixture,
    desktopActivityMarkerFileName,
    SLOW_TURN_RELEASE_FILE_NAME: ".bibcode-e2e-slow-turn-release",
  }) as string;
}
function codexExtension() {
  const extend = Reflect.get(Fixture, "extendOwnedCodexVisualFixture") as
    | ((source: string, selection?: string) => string)
    | undefined;
  expect(typeof extend).toBe("function");
  return extend!;
}
function refusalOwner() {
  const withRefusal = Reflect.get(Fixture, "withOwnedCodexVisualOptionRefusal") as
    | ((input: unknown, observe: () => Promise<unknown>) => Promise<unknown>)
    | undefined;
  expect(typeof withRefusal).toBe("function");
  return withRefusal!;
}
function codexRoots() {
  const fixtureRoot = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "provider-chat-codex-")),
  );
  const runRoot = NodePath.join(fixtureRoot, "light");
  NodeFS.mkdirSync(runRoot, { mode: 0o700 });
  const childEnv = {
    CI: "true",
    HOME: runRoot,
    BIBCODE_UPLOAD_FIXTURE: fixtureRoot,
    BIBCODE_E2E_RUN_ROOT: runRoot,
    BIBCODE_E2E_PROJECT_PATH: runRoot,
    BIBCODE_E2E_PROVIDER_INPUT_LOG: NodePath.join(runRoot, "inputs.jsonl"),
  };
  return {
    fixtureRoot,
    runRoot,
    childEnv,
    selection: "provider-chat-v1",
    marker: NodePath.join(runRoot, "provider-chat-refuse-high"),
    close: () => NodeFS.rmSync(fixtureRoot, { recursive: true, force: true }),
  };
}
async function catalogChild(source: string, roots: ReturnType<typeof codexRoots>) {
  const file = NodePath.join(roots.runRoot, "codex-fixture.mjs");
  NodeFS.writeFileSync(file, source, { mode: 0o600 });
  NodeFS.writeFileSync(
    NodePath.join(roots.runRoot, "provider-input-log-fixture.mjs"),
    "export function appendProviderInput() {}\nexport function promptTextFromParts() { return ''; }\n",
    { mode: 0o600 },
  );
  const child = NodeChildProcess.spawn(process.execPath, [file], {
    cwd: roots.runRoot,
    env: roots.childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = NodeReadline.createInterface({ input: child.stdout });
  let stderrBytes = 0;
  child.stderr.on("data", (bytes: Buffer) => {
    stderrBytes += bytes.length;
    if (stderrBytes > 8192) child.kill("SIGKILL");
  });
  let requests = 0;
  const request = () =>
    new Promise<Record<string, any>>((resolve, reject) => {
      const id = ++requests;
      // @effect-diagnostics-next-line globalTimers:off -- Finite reply watchdog for this test-owned fake child outside an Effect runtime.
      const timeout = setTimeout(() => reject(new Error("Owned catalog response bound.")), 3000);
      const onClose = () => {
        clearTimeout(timeout);
        reject(new Error("Owned catalog child closed before its reply."));
      };
      child.once("close", onClose);
      lines.once("line", (line) => {
        clearTimeout(timeout);
        child.off("close", onClose);
        if (line.length > 8192) return reject(new Error("Owned catalog frame bound."));
        try {
          const frame = JSON.parse(line);
          expect(frame.id).toBe(id);
          resolve(frame);
        } catch {
          reject(new Error("Owned catalog frame refused."));
        }
      });
      child.stdin.write(JSON.stringify({ id, method: "model/list", params: {} }) + "\n");
    });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  return {
    request,
    close: async (expectedExit = 0) => {
      child.stdin.end();
      // @effect-diagnostics-next-line globalTimers:off -- Finite EOF/reaping watchdog for this test-owned fake child outside an Effect runtime.
      const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
      try {
        expect(await closed).toBe(expectedExit);
      } finally {
        clearTimeout(timeout);
        lines.close();
      }
    },
  };
}

describe("owned Codex reasoning-option refusal prerequisite", () => {
  it("preserves default generated source bytes unless the exact opt-in is selected", () => {
    const extend = codexExtension();
    const source = originalCodex();
    expect(extend(source)).toBe(source);
    expect(() => extend(source, "provider-chat-v2")).toThrow();
    expect(() => extend(source + source, "provider-chat-v1")).toThrow();
  });
  it("keeps the ordinary generated CLI catalog at Medium without opt-in", async () => {
    const roots = codexRoots();
    const child = await catalogChild(codexExtension()(originalCodex()), roots);
    try {
      const frame = await child.request();
      expect(frame.result.data[0].model).toBe("gpt-5.4");
      expect(frame.result.data[0].supportedReasoningEfforts).toEqual([
        { reasoningEffort: "medium" },
      ]);
    } finally {
      await child.close();
      roots.close();
    }
  });
  it.each([
    "restored",
    "arming-valid",
    "arming-foreign",
    "arming-symlink",
    "missing-parent",
    "foreign-marker",
    "symlink-marker",
  ])("handles the actual generated stat/open restoration race only when verified: %s", (mode) => {
    const frames: Array<Record<string, any>> = [];
    const fixture = "/owned-fixture";
    const root = fixture + "/light";
    const marker = root + "/provider-chat-refuse-high";
    let markerPresent = true;
    let raced = false;
    let markerReads = 0;
    let receive: (line: string) => void = () => {};
    const absent = () => Object.assign(new Error("Owned inert absence."), { code: "ENOENT" });
    const fs = {
      constants: NodeFS.constants,
      realpathSync: (path: string) => {
        if (raced && mode === "missing-parent") throw absent();
        return path;
      },
      lstatSync: (path: string) => {
        if (path === marker && ++markerReads === 1 && mode.startsWith("arming-")) {
          raced = true;
          markerPresent = true;
          throw absent();
        }
        if (raced && mode === "missing-parent" && path !== marker) throw absent();
        if (path === marker && !markerPresent) throw absent();
        const file = path === marker;
        return {
          mode: file ? 0o600 : 0o700,
          dev: 1,
          ino: file ? 3 : path === root ? 2 : 1,
          nlink: 1,
          size: 12,
          isDirectory: () => !file,
          isFile: () => file,
          isSymbolicLink: () =>
            raced && ["symlink-marker", "arming-symlink"].includes(mode) && file,
        };
      },
      openSync: () => {
        if (mode.startsWith("arming-")) return 1;
        raced = true;
        markerPresent = !["restored", "missing-parent"].includes(mode);
        throw absent();
      },
      fstatSync: () => ({ isFile: () => true, dev: 1, ino: 3, mode: 0o600, size: 12, nlink: 1 }),
      readSync: (_fd: number, bytes: Buffer) => {
        Buffer.from(mode === "arming-foreign" ? "wrong-token\n" : "refuse-high\n").copy(bytes);
        return 12;
      },
      closeSync: () => {},
    };
    NodeVM.runInNewContext(
      codexExtension()(originalCodex(), "provider-chat-v1").replace(/^import .*;\n/gm, ""),
      {
        fs,
        Buffer,
        path: NodePath,
        process: {
          argv: [],
          platform: "linux",
          cwd: () => root,
          env: { CI: "true", BIBCODE_UPLOAD_FIXTURE: fixture, BIBCODE_E2E_RUN_ROOT: root },
          stdout: { write: (value: string) => frames.push(JSON.parse(value)) },
        },
        readline: {
          createInterface: () => ({
            on: (event: string, read: typeof receive) => {
              if (event === "line") receive = read;
            },
          }),
        },
      },
    );
    const read = () => receive(JSON.stringify({ id: 1, method: "model/list", params: {} }));
    if (mode === "restored" || mode === "arming-valid") {
      expect(read).not.toThrow();
      expect(frames[0]!.result.data[0].supportedReasoningEfforts).toEqual([
        { reasoningEffort: "medium" },
        ...(mode === "restored" ? [{ reasoningEffort: "high" }] : []),
      ]);
    } else {
      expect(read).toThrow();
      expect(frames).toEqual([]);
    }
  });
  it.each([false, true])(
    "advertises then withdraws only High through actual CLI frames and restores after failure=%s",
    async (fail) => {
      const extend = codexExtension();
      const withRefusal = refusalOwner();
      const roots = codexRoots();
      const child = await catalogChild(extend(originalCodex(), roots.selection), roots);
      const original = new Error("Owned controlled capture failure.");
      try {
        const before = await child.request();
        expect(before.result.data[0].model).toBe("gpt-5.4");
        expect(before.result.data[0].supportedReasoningEfforts).toEqual([
          { reasoningEffort: "medium" },
          { reasoningEffort: "high" },
        ]);
        const work = withRefusal(roots, async () => {
          expect(NodeFS.lstatSync(roots.marker).mode & 0o777).toBe(0o600);
          const armed = await child.request();
          expect(armed.result.data[0].model).toBe("gpt-5.4");
          expect(armed.result.data[0].defaultReasoningEffort).toBe("medium");
          expect(armed.result.data[0].supportedReasoningEfforts).toEqual([
            { reasoningEffort: "medium" },
          ]);
          if (fail) throw original;
          return true;
        });
        if (fail) await expect(work).rejects.toBe(original);
        else await expect(work).resolves.toBe(true);
        expect(NodeFS.existsSync(roots.marker)).toBe(false);
        const restored = await child.request();
        expect(restored.result).toEqual(before.result);
      } finally {
        await child.close();
        roots.close();
      }
    },
  );
  it("refuses unowned or linked arm targets without changing them or running the callback", async () => {
    const withRefusal = refusalOwner();
    const roots = codexRoots();
    let calls = 0;
    try {
      for (const input of [
        { ...roots, selection: "provider-chat-v2" },
        { ...roots, childEnv: { ...roots.childEnv, CI: "false" } },
        { ...roots, runRoot: roots.fixtureRoot },
      ])
        await expect(withRefusal(input, async () => calls++)).rejects.toThrow();
      const target = NodePath.join(roots.runRoot, "untouched");
      NodeFS.writeFileSync(target, "owned sentinel", { mode: 0o600 });
      NodeFS.symlinkSync(target, roots.marker);
      await expect(withRefusal(roots, async () => calls++)).rejects.toThrow();
      expect(NodeFS.readFileSync(target, "utf8")).toBe("owned sentinel");
      expect(NodeFS.lstatSync(roots.marker).isSymbolicLink()).toBe(true);
      expect(calls).toBe(0);
    } finally {
      roots.close();
    }
  });
  it.each(["unowned-marker", "outside-ci"])(
    "joins and reaps the generated child after rejecting %s",
    async (mode) => {
      const roots = codexRoots();
      if (mode === "unowned-marker")
        NodeFS.writeFileSync(roots.marker, "wrong-token\n", { mode: 0o600 });
      else roots.childEnv.CI = "false";
      const child = await catalogChild(codexExtension()(originalCodex(), roots.selection), roots);
      try {
        await expect(child.request()).rejects.toThrow("Owned catalog child closed");
      } finally {
        await child.close(1);
        roots.close();
      }
    },
  );
  it("refuses unsafe marker replacement on cleanup and never removes the foreign file", async () => {
    const roots = codexRoots();
    try {
      await expect(
        refusalOwner()(roots, async () => {
          NodeFS.unlinkSync(roots.marker);
          NodeFS.writeFileSync(roots.marker, "foreign sentinel", { mode: 0o600 });
        }),
      ).rejects.toThrow("Owned visual Codex refusal control refused");
      expect(NodeFS.readFileSync(roots.marker, "utf8")).toBe("foreign sentinel");
    } finally {
      roots.close();
    }
  });
});
