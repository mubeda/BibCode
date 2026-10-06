// @effect-diagnostics nodeBuiltinImport:off - Hosting setup uses private filesystem fixtures and an inert Git command port only.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { prepareDesktopUiTestContext } from "./test-project.ts";
import { expect, it } from "vite-plus/test";
const path = "./release-visual-pull-requests-installer.ts";
const api = await import(path).catch((error) => {
  if (NodeFS.existsSync(new NodeURL.URL(path, import.meta.url))) throw error;
  return {};
});
const prepare = (input: object) => {
  const method = Reflect.get(api, "preparePullRequestsHostingFixture");
  return typeof method === "function" ? method(input) : Promise.resolve(null);
};
const parent = () =>
  NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-owned-requests-")),
  );
it("assembles fixed CI-only hosting executables with private origins and actual source query bytes", async () => {
  const base = parent();
  const root = NodePath.join(base, "light");
  NodeFS.mkdirSync(root, { mode: 0o700 });
  const commits = new Map<string, number>();
  const calls: string[][] = [];
  const git = async (cwd: string, argv: readonly string[]) => {
    calls.push([...argv]);
    if (argv[0] === "init" && !argv.includes("--bare")) {
      NodeFS.mkdirSync(NodePath.join(cwd, ".git"), { mode: 0o700 });
      NodeFS.writeFileSync(
        NodePath.join(cwd, ".git", "config"),
        "[core]\nrepositoryformatversion = 0\n",
        { mode: 0o600 },
      );
    }
    if (argv[0] === "commit") commits.set(cwd, (commits.get(cwd) ?? 0) + 1);
    if (argv[0] === "remote")
      NodeFS.appendFileSync(
        NodePath.join(cwd, ".git", "config"),
        '[remote "origin"]\nurl = ' + argv.at(-1) + "\n",
      );
    if (argv[0] === "config" && argv[1] === "--file")
      NodeFS.writeFileSync(argv[2]!, "[url]\nowned = true\n", { mode: 0o600 });
    return {
      status: 0,
      stdout:
        argv[0] === "rev-parse"
          ? (commits.get(cwd) === 1 ? "a" : "b").repeat(40) + "\n"
          : argv[0] === "diff"
            ? "diff --git a/visual-request.ts b/visual-request.ts\n--- a/visual-request.ts\n+++ b/visual-request.ts\n@@ -1 +1 @@\n-export const approved = false;\n+export const approved = true;\n"
            : "",
    };
  };
  try {
    const fixture = await prepare({
      root,
      sourceSha: "c".repeat(40),
      node: NodeFS.realpathSync(process.execPath),
      ci: true,
      git,
    });
    expect(fixture).not.toBeNull();
    expect(Object.keys(fixture.projects)).toEqual(["github", "gitlab"]);
    expect(
      calls
        .filter((argv) => argv[0] === "remote" && argv[1] === "set-url")
        .map((argv) => argv.at(-1)),
    ).toEqual([
      "https://github.visual.invalid/owned/requests.git",
      "https://gitlab.visual.invalid/owned/requests.git",
    ]);
    expect(calls.filter((argv) => argv[0] === "push").map((argv) => argv.slice(1))).toEqual([
      ["--set-upstream", "origin", "main", "visual-request", "visual-create"],
      ["--set-upstream", "origin", "main", "visual-request", "visual-create"],
    ]);
    for (const provider of ["github", "gitlab"]) {
      const program = NodeFS.readFileSync(fixture.executables[provider], "utf8");
      expect(program).toContain('process.env.CI !== "true"');
      expect(program).not.toMatch(/node:child_process|fetch\(|https?\.request|execSync/);
      expect(NodeFS.statSync(fixture.executables[provider]).mode & 0o777).toBe(0o500);
      expect(NodeFS.statSync(fixture.config).mode & 0o777).toBe(0o600);
    }
    expect(fixture.projects.github.baseSha).toBe("a".repeat(40));
    expect(fixture.projects.github.headSha).toBe("b".repeat(40));
    const cliEnv: NodeJS.ProcessEnv = { ...process.env, CI: "true" };
    delete cliEnv.NODE_OPTIONS;
    delete cliEnv.NODE_PATH;
    const run = (provider: "github" | "gitlab", argv: string[], input = "") =>
      NodeChildProcess.spawnSync(
        NodeFS.realpathSync(process.execPath),
        [fixture.executables[provider], ...argv],
        {
          cwd: fixture.projects[provider].cwd,
          env: {
            ...cliEnv,
            [provider === "github" ? "GH_HOST" : "GITLAB_HOST"]: provider + ".visual.invalid",
          },
          input,
          encoding: "utf8",
          timeout: 3000,
        },
      );
    const version = run("github", ["--version"]);
    expect(version.status).toBe(0);
    expect(version.stdout).toContain("gh version 2.65.0");
    const raw = JSON.parse(NodeFS.readFileSync(fixture.config, "utf8"));
    const metadata = raw.exchanges.gitlab.find(
      (entry: { kind: string }) => entry.kind === "metadata",
    );
    const bodyDirectory = NodePath.join(root, "server-state", "pull-requests");
    NodeFS.mkdirSync(bodyDirectory, { recursive: true, mode: 0o700 });
    const bodyFile = NodePath.join(bodyDirectory, "body-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json");
    NodeFS.writeFileSync(bodyFile, metadata.input.value, { mode: 0o600 });
    const bodyArgs = metadata.argv.map((arg: string) =>
      arg === "<OWNED_BODY_FILE>" ? bodyFile : arg,
    );
    const response = run("gitlab", bodyArgs);
    expect(response.status).toBe(0);
    expect(JSON.parse(response.stdout).data.project.mergeRequest.commitCount).toBe(1);
    const foreign = run("github", ["api", "repos/foreign/requests"]);
    expect(foreign.status).toBe(64);
    expect(foreign.stdout).toBe("");
    const noHeader = run(
      "gitlab",
      bodyArgs.filter((arg: string) => arg !== "-H" && arg !== "Content-Type: application/json"),
    );
    expect(noHeader.status).toBe(64);
    NodeFS.chmodSync(bodyFile, 0o644);
    expect(run("gitlab", bodyArgs).status).toBe(64);
    NodeFS.chmodSync(bodyFile, 0o600);
    const callFacts = NodeFS.readFileSync(raw.calls, "utf8");
    expect(callFacts).not.toMatch(
      /owned\/requests|body-aaaaaaaa|graphql|query|server-state|visual.invalid/,
    );
    const sentinel = NodePath.join(root, "unverified-engine-executed");
    NodeFS.chmodSync(fixture.engine, 0o600);
    NodeFS.writeFileSync(
      fixture.engine,
      'import * as fs from "node:fs"; fs.writeFileSync(' +
        JSON.stringify(sentinel) +
        ',"unexpected"); export const matchPullRequestsHostExchange=()=>null;',
    );
    NodeFS.chmodSync(fixture.engine, 0o500);
    const env: NodeJS.ProcessEnv = { ...process.env, CI: "true", GH_HOST: "github.visual.invalid" };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    const result = NodeChildProcess.spawnSync(
      NodeFS.realpathSync(process.execPath),
      [fixture.executables.github, "--version"],
      { cwd: fixture.projects.github.cwd, env, input: "", encoding: "utf8", timeout: 3000 },
    );
    expect(result.status).toBe(64);
    expect(NodeFS.existsSync(sentinel)).toBe(false);
  } finally {
    NodeFS.rmSync(base, { recursive: true, force: true });
  }
});
it.each(["not-ci", "source", "symlink", "git-failure"])(
  "refuses unsafe setup before admitting hosting: %s",
  async (mode) => {
    const base = parent();
    const root = NodePath.join(base, "light");
    NodeFS.mkdirSync(root, { mode: 0o700 });
    let calls = 0;
    let target = root;
    if (mode === "symlink") {
      target = NodePath.join(base, "dark");
      NodeFS.symlinkSync(root, target);
    }
    try {
      await expect(
        prepare({
          root: target,
          sourceSha: mode === "source" ? "foreign" : "c".repeat(40),
          node: NodeFS.realpathSync(process.execPath),
          ci: mode !== "not-ci",
          git: async () => {
            calls++;
            return { status: 1, stdout: "" };
          },
        }),
      ).rejects.toThrow("Owned hosting fixture refused.");
      if (mode !== "git-failure") expect(calls).toBe(0);
      expect(NodeFS.existsSync(NodePath.join(root, "hosting", "bin", "gh"))).toBe(false);
    } finally {
      NodeFS.rmSync(base, { recursive: true, force: true });
    }
  },
);

const qualifierPath = new NodeURL.URL("../qualify-delivery-retry.ts", import.meta.url);
const qualifierSource = () => NodeFS.readFileSync(qualifierPath, "utf8");
function actualRequestContext(
  fixture: string,
  theme: string,
  selection = "release-visual-pull-requests",
  source = qualifierSource(),
  context = prepareDesktopUiTestContext,
  uid: number | null = process.getuid?.() ?? null,
) {
  const start = source.indexOf("      const runRoot = NodePath.join(config.fixture, theme);");
  const end = source.indexOf("      const control = NodePath.join(runRoot", start);
  if (start < 0 || end < start) throw new Error("Actual request context boundary missing.");
  return NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(source.slice(start, end)) + "\ncontext;",
    {
      NodeFS,
      NodePath,
      process: { env: { CI: "true" }, getuid: uid === null ? undefined : () => uid },
      config: { fixture, selection },
      theme,
      prepareDesktopUiTestContext: context,
      cursorQuestionFixtureSelection: "cursor-question-v1",
      Error,
    },
  ) as ReturnType<typeof prepareDesktopUiTestContext>;
}
function actualRequestGit(root: string, fixtureRoot: string, home: string) {
  const source = qualifierSource(),
    start = source.indexOf("export function runOwnedGitProjectCommand("),
    end = source.indexOf("export async function readOwnedGitProjectSnapshot(", start);
  if (start < 0 || end < start) throw new Error("Actual request Git boundary missing.");
  const owner = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(source.slice(start, end).replace(/^export /gm, "")) +
      "\nrunOwnedGitProjectCommand;",
    { NodeFS, NodePath, NodeChildProcess, Buffer, Error },
  ) as (
    input: { root: string; fixtureRoot: string; home: string; git: string },
    cwd: string,
    args: readonly string[],
  ) => { status: number; stdout: string };
  let calls = 0;
  return {
    calls: () => calls,
    git: async (cwd: string, args: readonly string[]) => {
      calls++;
      return owner(
        { root, fixtureRoot, home, git: NodePath.join(fixtureRoot, "bin", "git") },
        cwd,
        args,
      );
    },
  };
}
function actualRequestTools(fixture: string) {
  NodeFS.mkdirSync(NodePath.join(fixture, "bin"), { mode: 0o700 });
  const result = NodeChildProcess.spawnSync(
    "python3",
    [
      "-B",
      "-c",
      "import importlib.util,shutil,sys\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('owned',sys.argv[1]);owner=importlib.util.module_from_spec(spec);spec.loader.exec_module(owner);owner.prepare_tools(Path(sys.argv[2]),sys.argv[3],shutil.which('git'),shutil.which('dirname'))",
      NodeURL.fileURLToPath(
        new NodeURL.URL("../../../../scripts/qualify-chat-uploads.py", import.meta.url),
      ),
      fixture,
      NodeFS.realpathSync(process.execPath),
    ],
    { encoding: "utf8", timeout: 5000, maxBuffer: 65536 },
  );
  if (result.error || result.status !== 0) throw new Error("Actual request tool setup refused.");
}
it.each(["light", "dark"])(
  "prepares the actual PR context/installer/Git port privately under ordinary umask: %s",
  async (theme) => {
    const fixture = parent(),
      oldUmask = process.umask(0o022);
    try {
      actualRequestTools(fixture);
      const context = actualRequestContext(fixture, theme),
        root = NodePath.join(fixture, theme),
        port = actualRequestGit(root, fixture, context.fixtureUserHomePath);
      expect(NodeFS.lstatSync(root).mode & 0o777).toBe(0o700);
      const result = await prepare({
        root,
        sourceSha: "a".repeat(40),
        node: NodeFS.realpathSync(process.execPath),
        ci: true,
        git: port.git,
      });
      expect(result !== null).toBe(true);
      expect(port.calls()).toBe(30);
      expect(Object.keys(result.projects)).toEqual(["github", "gitlab"]);
      expect(NodeFS.lstatSync(root).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(oldUmask);
      NodeFS.rmSync(fixture, { recursive: true, force: true });
    }
  },
);
it("retains the installer refusal when the actual PR pre-context preparation is absent", async () => {
  const fixture = parent(),
    oldUmask = process.umask(0o022);
  try {
    actualRequestTools(fixture);
    const source = qualifierSource(),
      begin = source.indexOf(
        "      if (",
        source.indexOf("      const runRoot = NodePath.join(config.fixture, theme);"),
      ),
      end = source.indexOf("      const env = {", begin);
    expect(begin >= 0 && end > begin).toBe(true);
    const context = actualRequestContext(
        fixture,
        "light",
        undefined,
        source.slice(0, begin) + source.slice(end),
      ),
      root = NodePath.join(fixture, "light"),
      port = actualRequestGit(root, fixture, context.fixtureUserHomePath);
    expect(NodeFS.lstatSync(root).mode & 0o777).toBe(0o755);
    await expect(
      prepare({
        root,
        sourceSha: "a".repeat(40),
        node: NodeFS.realpathSync(process.execPath),
        ci: true,
        git: port.git,
      }),
    ).rejects.toThrow("Owned hosting fixture refused.");
    expect(port.calls()).toBe(0);
  } finally {
    process.umask(oldUmask);
    NodeFS.rmSync(fixture, { recursive: true, force: true });
  }
});
it.each([
  "private-collision",
  "public-collision",
  "file-collision",
  "symlink-collision",
  "public-parent",
  "alias-parent",
  "foreign-owner",
  "missing-owner",
  "foreign-theme",
])("refuses PR root ownership before the actual context factory: %s", (mode) => {
  const fixture = parent(),
    root = NodePath.join(fixture, "light"),
    target = NodePath.join(fixture, "target");
  let fixtureInput = fixture,
    contextCalls = 0;
  try {
    if (mode === "private-collision" || mode === "public-collision") {
      NodeFS.mkdirSync(root, { mode: mode === "private-collision" ? 0o700 : 0o755 });
      NodeFS.writeFileSync(NodePath.join(root, "retain"), "retained", { mode: 0o600 });
    } else if (mode === "file-collision") NodeFS.writeFileSync(root, "retained", { mode: 0o600 });
    else if (mode === "symlink-collision") {
      NodeFS.mkdirSync(target, { mode: 0o700 });
      NodeFS.symlinkSync(target, root);
    } else if (mode === "public-parent") NodeFS.chmodSync(fixture, 0o755);
    else if (mode === "alias-parent") {
      fixtureInput = NodePath.join(fixture, "alias");
      NodeFS.symlinkSync(fixture, fixtureInput);
    }
    const context = (...args: Parameters<typeof prepareDesktopUiTestContext>) => {
      contextCalls++;
      return prepareDesktopUiTestContext(...args);
    };
    expect(() =>
      actualRequestContext(
        fixtureInput,
        mode === "foreign-theme" ? "foreign" : "light",
        undefined,
        undefined,
        context,
        mode === "foreign-owner"
          ? (process.getuid?.() ?? 0) + 1
          : mode === "missing-owner"
            ? null
            : (process.getuid?.() ?? null),
      ),
    ).toThrow();
    expect(contextCalls).toBe(0);
    expect(NodeFS.existsSync(NodePath.join(root, "state"))).toBe(false);
    if (mode === "private-collision" || mode === "public-collision") {
      expect(NodeFS.readFileSync(NodePath.join(root, "retain"), "utf8")).toBe("retained");
      expect(NodeFS.lstatSync(root).mode & 0o777).toBe(
        mode === "private-collision" ? 0o700 : 0o755,
      );
    }
    if (mode === "symlink-collision") expect(NodeFS.readdirSync(target).length).toBe(0);
  } finally {
    NodeFS.rmSync(fixture, { recursive: true, force: true });
  }
});
it("keeps source admission before Git after private context preparation", async () => {
  const fixture = parent();
  try {
    actualRequestTools(fixture);
    const context = actualRequestContext(fixture, "light"),
      root = NodePath.join(fixture, "light"),
      port = actualRequestGit(root, fixture, context.fixtureUserHomePath);
    await expect(
      prepare({
        root,
        sourceSha: "foreign",
        node: NodeFS.realpathSync(process.execPath),
        ci: true,
        git: port.git,
      }),
    ).rejects.toThrow("Owned hosting fixture refused.");
    expect(port.calls()).toBe(0);
    expect(NodeFS.existsSync(NodePath.join(root, "requests"))).toBe(false);
  } finally {
    NodeFS.rmSync(fixture, { recursive: true, force: true });
  }
});
it.each(["delivery-retry-ui", "release-visual-settings", "release-visual-core"])(
  "retains the actual default context behavior for other selections: %s",
  (selection) => {
    const fixture = parent(),
      oldUmask = process.umask(0o022);
    try {
      const context = actualRequestContext(fixture, "light", selection);
      expect(NodeFS.lstatSync(NodePath.join(fixture, "light")).mode & 0o777).toBe(0o755);
      expect(NodeFS.existsSync(context.projectPath)).toBe(true);
    } finally {
      process.umask(oldUmask);
      NodeFS.rmSync(fixture, { recursive: true, force: true });
    }
  },
);
