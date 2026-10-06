// @effect-diagnostics nodeBuiltinImport:off - Hosting setup uses private filesystem fixtures and an inert Git command port only.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
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
