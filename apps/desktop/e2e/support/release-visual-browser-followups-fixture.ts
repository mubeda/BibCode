// @effect-diagnostics nodeBuiltinImport:off - The existing disposable qualification root owns these fixture bytes.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { createSizedPng, STAGED_SMOKE_IMAGE_BYTES } from "./chat-upload-fixture.ts";
import { browserFollowupHostedOrigin } from "./release-visual-browser-followups.ts";
const refused = () => new Error("Owned browser follow-up fixture refused.");
export function prepareBrowserFollowupPng(root: string) {
  if (
    !NodePath.isAbsolute(root) ||
    NodeFS.realpathSync(root) !== root ||
    !NodeFS.statSync(root).isDirectory()
  )
    throw refused();
  const path = NodePath.join(root, "upload-browser-followup.png");
  const png = createSizedPng(STAGED_SMOKE_IMAGE_BYTES, "browser-followup");
  const sha256 = NodeCrypto.createHash("sha256").update(png).digest("hex");
  NodeFS.writeFileSync(path, png, { flag: "wx", mode: 0o600 });
  const verify = () => {
    if (
      NodeFS.lstatSync(path).isSymbolicLink() ||
      NodeFS.realpathSync(path) !== path ||
      NodeFS.statSync(path).size !== STAGED_SMOKE_IMAGE_BYTES ||
      NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex") !== sha256
    )
      throw refused();
  };
  return { path, bytes: STAGED_SMOKE_IMAGE_BYTES, sha256, verify };
}
/** This environment is for a separate ordinary Vite build; the existing primary web process is never changed. */
export function browserFollowupHostedEnvironment(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...inherited };
  for (const key of Object.keys(env))
    if (["VITE_HTTP_URL", "VITE_WS_URL", "VITE_DESKTOP_BUILD"].includes(key.toUpperCase()))
      delete env[key];
  env.VITE_HOSTED_APP_CHANNEL = "latest";
  env.VITE_HOSTED_APP_URL = browserFollowupHostedOrigin;
  return env;
}
/** An ordinary build entry re-exports the actual SDK read; it adds no renderer, state, auth, or network replacement. */
export function prepareBrowserFollowupHostedProbe(input: {
  root: string;
  repository: string;
  outDir: string;
}) {
  if (
    ![input.root, input.repository].every(
      (path) =>
        NodePath.isAbsolute(path) &&
        NodeFS.realpathSync(path) === path &&
        NodeFS.statSync(path).isDirectory(),
    ) ||
    !NodePath.isAbsolute(input.outDir) ||
    NodePath.dirname(input.outDir) !== input.root ||
    NodeFS.existsSync(input.outDir)
  )
    throw refused();
  const source = NodePath.join(input.repository, "apps/web/src/hostedPairing.ts");
  if (NodeFS.realpathSync(source) !== source || !NodeFS.statSync(source).isFile()) throw refused();
  const path = NodePath.join(input.root, "qualified-hosted-mode-entry.ts");
  const contents =
    "export { isHostedStaticApp } from " +
    JSON.stringify(source.split(NodePath.sep).join("/")) +
    ";\n";
  NodeFS.writeFileSync(path, contents, { flag: "wx", mode: 0o600 });
  const sourceSha256 = NodeCrypto.createHash("sha256")
    .update(NodeFS.readFileSync(source))
    .digest("hex");
  const verify = () => {
    if (
      NodeFS.realpathSync(path) !== path ||
      NodeFS.readFileSync(path, "utf8") !== contents ||
      NodeFS.realpathSync(source) !== source ||
      NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(source)).digest("hex") !==
        sourceSha256
    )
      throw refused();
  };
  return {
    path,
    sourceSha256,
    verify,
    envDir: false as const,
    /** Merge into the existing current-source web config in the existing build owner, retaining its plugins and lock. */
    build: {
      outDir: input.outDir,
      emptyOutDir: false,
      rolldownOptions: {
        preserveEntrySignatures: "strict" as const,
        input: {
          index: NodePath.join(input.repository, "apps/web/index.html"),
          qualifiedHostedMode: path,
        },
        output: {
          entryFileNames: (entry: { name: string }) =>
            entry.name === "qualifiedHostedMode"
              ? "qualified-hosted-mode.js"
              : "assets/[name]-[hash].js",
        },
      },
    },
  };
}
/** Incomplete entries deliberately retain the owned host: current root routing uses it to preserve the hosted pairing surface. */
export function buildBrowserFollowupHostedEntry(
  mode: "confirm" | "incomplete",
  token: string,
): string {
  if (
    !["confirm", "incomplete"].includes(mode) ||
    typeof token !== "string" ||
    token.length < 8 ||
    token.length > 16384 ||
    /[\r\n]/.test(token)
  )
    throw refused();
  const url = new URL("/pair", browserFollowupHostedOrigin);
  url.searchParams.set("host", "http://127.0.0.1:4887");
  url.searchParams.set("label", "Owned hosted backend");
  if (mode === "confirm") url.hash = new URLSearchParams([["token", token]]).toString();
  return url.toString();
}
