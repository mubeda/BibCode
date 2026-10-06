// CI-only source builds; each config is evaluated in a fresh process under the existing shared build lock.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import { runWebBuildLocked } from "./run-web-build-locked.mjs";
const repo = NodePath.resolve(import.meta.dirname, ".."),
  refused = () => new Error("Owned browser follow-up build refused.");
export function browserFollowupBuildEnvironment(mode, inherited) {
  if (!["primary", "hosted"].includes(mode)) throw refused();
  const env = { ...inherited };
  for (const key of Object.keys(env))
    if (
      [
        "VITE_HTTP_URL",
        "VITE_WS_URL",
        "VITE_DEV_SERVER_URL",
        "VITE_DESKTOP_BUILD",
        "VITE_HOSTED_APP_CHANNEL",
        "VITE_HOSTED_APP_URL",
      ].includes(key.toUpperCase())
    )
      delete env[key];
  Object.assign(env, {
    VITE_HTTP_URL: "",
    VITE_WS_URL: "",
    VITE_DEV_SERVER_URL: "",
    VITE_DESKTOP_BUILD: "",
    VITE_HOSTED_APP_CHANNEL: "latest",
    VITE_HOSTED_APP_URL: "http://127.0.0.1:4893",
  });
  if (mode === "primary")
    Object.assign(env, {
      VITE_HTTP_URL: "http://127.0.0.1:4887",
      VITE_WS_URL: "ws://127.0.0.1:4887",
      VITE_DEV_SERVER_URL: "http://127.0.0.1:4885",
    });
  return env;
}
export function admitBrowserFollowupBuild(input) {
  if (
    input.environment.CI !== "true" ||
    input.environment.GITHUB_ACTIONS !== "true" ||
    !["primary", "hosted"].includes(input.mode) ||
    !/^[a-f0-9]{40}$/.test(input.source) ||
    input.source !== input.environment.GITHUB_SHA ||
    !NodePath.isAbsolute(input.root) ||
    NodeFS.realpathSync(input.root) !== input.root
  )
    throw refused();
  const stat = NodeFS.lstatSync(input.root);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o700 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  )
    throw refused();
  const outDir = NodePath.join(input.root, input.mode + "-assets");
  if (NodeFS.existsSync(outDir)) throw refused();
  return outDir;
}
export async function buildBrowserFollowupUi(input) {
  const outDir = admitBrowserFollowupBuild(input);
  const env = browserFollowupBuildEnvironment(input.mode, input.environment);
  await runWebBuildLocked({
    runWebBuild: () =>
      new Promise((resolve, reject) => {
        const log = NodeFS.openSync(
          NodePath.join(input.root, input.mode + "-build.private.log"),
          "wx",
          0o600,
        );
        let child;
        try {
          child = NodeChildProcess.spawn(
            process.execPath,
            [
              NodeURL.fileURLToPath(import.meta.url),
              "--child",
              input.mode,
              input.root,
              input.source,
            ],
            { cwd: NodePath.join(repo, "apps/web"), env, stdio: ["ignore", log, log] },
          );
        } finally {
          NodeFS.closeSync(log);
        }
        child.once("error", reject);
        child.once("close", (code) => (code === 0 ? resolve(0) : reject(refused())));
      }),
  });
  return outDir;
}
async function childBuild(mode, root, source) {
  const outDir = admitBrowserFollowupBuild({ mode, root, source, environment: process.env });
  const { build } = await import("vite-plus"),
    { prepareBrowserFollowupHostedProbe } =
      await import("../apps/desktop/e2e/support/release-visual-browser-followups-fixture.ts");
  const probe =
    mode === "hosted"
      ? prepareBrowserFollowupHostedProbe({ root, repository: repo, outDir })
      : null;
  const sdk = NodePath.join(repo, "apps/web/src/hostedPairing.ts"),
    sdkSourceSha256 = NodeCrypto.createHash("sha256")
      .update(NodeFS.readFileSync(sdk))
      .digest("hex");
  await build({
    root: NodePath.join(repo, "apps/web"),
    configFile: NodePath.join(repo, "apps/web/vite.config.ts"),
    envDir: false,
    build: probe ? probe.build : { outDir, emptyOutDir: false },
  });
  probe?.verify();
  if (
    NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(sdk)).digest("hex") !==
    sdkSourceSha256
  )
    throw refused();
  NodeFS.writeFileSync(
    NodePath.join(outDir, "qualified-browser-build.json"),
    JSON.stringify({
      schema: 1,
      mode,
      source,
      sdkSourceSha256,
      backendHttp: mode === "primary" ? "http://127.0.0.1:4887" : "",
      backendWs: mode === "primary" ? "ws://127.0.0.1:4887" : "",
      devServerUrl: mode === "primary" ? "http://127.0.0.1:4885" : "",
      hostedOrigin: "http://127.0.0.1:4893",
      probeEntry: mode === "hosted" ? "qualified-hosted-mode.js" : null,
    }),
    { mode: 0o600, flag: "wx" },
  );
}
if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 6) throw refused();
    const [kind, mode, root, source] = process.argv.slice(2);
    if (kind === "--child") await childBuild(mode, root, source);
    else if (kind === "--build")
      await buildBrowserFollowupUi({ mode, root, source, environment: process.env });
    else throw refused();
  } catch {
    process.stderr.write("OWNED_BROWSER_FOLLOWUP_BUILD_REFUSED\n");
    process.exitCode = 1;
  }
}
