// @effect-diagnostics nodeBuiltinImport:off - Disposable TempGit, actual files and inert public asset ports only.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import * as NodeCrypto from "node:crypto";
import { extendOwnedClaudeVisualFixture } from "./release-visual-provider-chat-fixture.ts";
import { OrchestrationThread } from "../../../../packages/contracts/src/orchestration.ts";
import { prepareVisualProject, prepareVisualWorktree } from "./release-visual-fixture.ts";
import * as Media from "./release-visual-provider-chat-media.ts";
import { expect, it } from "vite-plus/test";

const Schema = NodeModule.createRequire(
  new URL("../../../../packages/contracts/package.json", import.meta.url),
)("effect/Schema");
const api = Media as unknown as {
  prepareProviderChatFiles: (input: object, thread: OrchestrationThread) => object;
  configureProviderChatMedia: (
    scope: object,
    value: unknown,
    fetchAsset: (url: string) => Promise<Buffer>,
  ) => Promise<void>;
  verifyProviderChatMedia: (scope: object, changed: boolean) => void;
};
function fixture() {
  const parent = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "provider-media-")),
    ),
    root = NodePath.join(parent, "light"),
    project = NodePath.join(root, "primary"),
    home = NodePath.join(root, "home"),
    worktree = NodePath.join(root, "managed");
  NodeFS.mkdirSync(project, { recursive: true, mode: 0o700 });
  NodeFS.mkdirSync(home, { mode: 0o700 });
  const git = "/usr/bin/git",
    branch = "codex/delivery-retry-light";
  const run = (args: string[]) =>
    NodeChildProcess.execFileSync(
      git,
      [
        "-C",
        project,
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Owned Fixture",
        "-c",
        "user.email=fixture@example.test",
        ...args,
      ],
      {
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          HOME: home,
          USERPROFILE: home,
          PATH: "/usr/bin:/bin",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    );
  run(["init", "--initial-branch=main"]);
  NodeFS.writeFileSync(NodePath.join(project, "README.md"), "owned\n");
  run(["add", "."]);
  run(["commit", "-m", "owned"]);
  prepareVisualProject({ root, project, home, git });
  run(["worktree", "add", "-b", branch, worktree]);
  const input = { root, project, home, git, branch };
  prepareVisualWorktree(input);
  const time = "2026-10-05T00:00:00.000Z";
  const thread: OrchestrationThread = Schema.decodeUnknownSync(OrchestrationThread)({
    id: "owned-thread",
    projectId: "owned-project",
    title: "Owned workspace",
    kind: "workspace",
    branch,
    worktreePath: worktree,
    modelSelection: { instanceId: "claudeAgent", model: "opus" },
    runtimeMode: "full-access",
    latestTurn: null,
    createdAt: time,
    updatedAt: time,
    deletedAt: null,
    messages: [],
    activities: [],
    checkpoints: [],
    session: null,
  });
  return {
    parent,
    root,
    worktree,
    input,
    thread,
    close: () => NodeFS.rmSync(parent, { recursive: true, force: true }),
  };
}

it("seeds only the real managed file and joins the typed asset to exact existing image bytes", async () => {
  expect(api.prepareProviderChatFiles).toBeTypeOf("function");
  const f = fixture();
  try {
    const scope = api.prepareProviderChatFiles(f.input, f.thread);
    expect(NodeFS.readFileSync(NodePath.join(f.worktree, "visual-chat.ts"), "utf8")).toBe(
      'export const visualChat = "baseline";\n',
    );
    await api.configureProviderChatMedia(
      scope,
      { relativeUrl: "/api/assets/owned-token/visual-swatch.png", expiresAt: 9000000000000 },
      async (url) => {
        expect(url).toBe("http://127.0.0.1:4885/api/assets/owned-token/visual-swatch.png");
        return NodeFS.readFileSync(NodePath.join(f.worktree, "visual-swatch.png"));
      },
    );
    api.verifyProviderChatMedia(scope, false);
    const marker = NodePath.join(f.root, "provider-chat-media.json");
    expect(NodeFS.statSync(marker).mode & 0o777).toBe(0o600);
    expect(JSON.parse(NodeFS.readFileSync(marker, "utf8"))).toMatchObject({
      kind: "provider-chat-v1",
      worktreePath: f.worktree,
      threadId: f.thread.id,
    });
    expect(() => api.verifyProviderChatMedia({ ...scope }, false)).toThrow();
    NodeFS.writeFileSync(
      NodePath.join(f.worktree, "visual-chat.ts"),
      'export const visualChat = "updated";\n',
    );
    api.verifyProviderChatMedia(scope, true);
  } finally {
    f.close();
  }
});

it.each(["primary", "existing", "symlink"])(
  "refuses foreign/preexisting file admission before writing: %s",
  (mode) => {
    expect(api.prepareProviderChatFiles).toBeTypeOf("function");
    const f = fixture();
    try {
      const file = NodePath.join(f.worktree, "visual-chat.ts");
      if (mode === "existing") NodeFS.writeFileSync(file, "retained");
      if (mode === "symlink") NodeFS.symlinkSync(NodePath.join(f.worktree, "README.md"), file);
      expect(() =>
        api.prepareProviderChatFiles(
          f.input,
          mode === "primary" ? { ...f.thread, worktreePath: f.input.project } : f.thread,
        ),
      ).toThrow("Owned provider media refused.");
      if (mode === "existing") expect(NodeFS.readFileSync(file, "utf8")).toBe("retained");
    } finally {
      f.close();
    }
  },
);

it.each(["foreign-url", "different-bytes", "linked-marker", "changed-image"])(
  "refuses an unjoined asset/config/source: %s",
  async (mode) => {
    expect(api.prepareProviderChatFiles).toBeTypeOf("function");
    const f = fixture();
    try {
      const scope = api.prepareProviderChatFiles(f.input, f.thread);
      const marker = NodePath.join(f.root, "provider-chat-media.json");
      if (mode === "linked-marker")
        NodeFS.symlinkSync(NodePath.join(f.worktree, "README.md"), marker);
      if (mode === "changed-image")
        NodeFS.writeFileSync(NodePath.join(f.worktree, "visual-swatch.png"), "changed");
      await expect(
        api.configureProviderChatMedia(
          scope,
          {
            relativeUrl:
              mode === "foreign-url"
                ? "https://example.test/private"
                : "/api/assets/owned-token/visual-swatch.png",
            expiresAt: 9000000000000,
          },
          async () =>
            mode === "different-bytes"
              ? Buffer.from("different")
              : NodeFS.readFileSync(NodePath.join(f.worktree, "visual-swatch.png")),
        ),
      ).rejects.toThrow("Owned provider media refused.");
    } finally {
      f.close();
    }
  },
);

it("uses the actual opt-in native handler to mutate only the admitted file and emit the real joined image URL", async () => {
  const f = fixture();
  try {
    const scope = api.prepareProviderChatFiles(f.input, f.thread);
    await api.configureProviderChatMedia(
      scope,
      { relativeUrl: "/api/assets/owned-token/visual-swatch.png", expiresAt: 9000000000000 },
      async () => NodeFS.readFileSync(NodePath.join(f.worktree, "visual-swatch.png")),
    );
    const source = NodeFS.readFileSync(new URL("./test-project.ts", import.meta.url), "utf8");
    const start = source.indexOf("const claudeFixtureSource = String.raw`"),
      end = source.indexOf("const cursorFixtureSource", start);
    const original = NodeVM.runInNewContext(source.slice(start, end) + "\nclaudeFixtureSource", {
      STREAMED_RESPONSE: "Owned baseline response.",
    });
    let receive = (_line: string) => {};
    const frames: Array<Record<string, unknown>> = [];
    NodeVM.runInNewContext(
      extendOwnedClaudeVisualFixture(original, "provider-chat-v1").replace(/^import .*;\n/gm, ""),
      {
        fs: NodeFS,
        path: NodePath,
        visualHash: NodeCrypto.createHash,
        Buffer,
        URL,
        process: {
          argv: [],
          env: { CI: "true", BIBCODE_UPLOAD_FIXTURE: f.parent, BIBCODE_E2E_RUN_ROOT: f.root },
          cwd: () => f.worktree,
          stdout: { write: (text: string) => frames.push(JSON.parse(text)) },
        },
        readline: {
          createInterface: () => ({
            on: (_event: string, callback: typeof receive) => {
              receive = callback;
            },
          }),
        },
        promptTextFromParts: (parts: Array<{ text: string }>) =>
          parts.map((part) => part.text).join(""),
        appendProviderInput: () => {},
        randomUUID: () => "owned-native-id",
      },
    );
    receive(
      JSON.stringify({
        type: "user",
        session_id: "owned-session",
        message: { content: [{ type: "text", text: "Owned visual markdown and plan" }] },
      }),
    );
    expect(NodeFS.readFileSync(NodePath.join(f.worktree, "visual-chat.ts"), "utf8")).toBe(
      'export const visualChat = "updated";\n',
    );
    expect(JSON.stringify(frames)).toContain(
      "http://127.0.0.1:4885/api/assets/owned-token/visual-swatch.png",
    );
    api.verifyProviderChatMedia(scope, true);
  } finally {
    f.close();
  }
});
