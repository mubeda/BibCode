// @effect-diagnostics nodeBuiltinImport:off - Execute only pinned pure command functions against inert protocol endpoints.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import * as NodeProcess from "node:process";

function repositoryRoot() {
  // oxlint-disable-next-line bibcode/no-global-process-runtime -- The inert fixture supports the documented repository-root and web-package test commands.
  const cwd = NodeProcess.cwd();
  const root = NodeFS.existsSync(NodePath.join(cwd, "apps/desktop/package.json"))
    ? cwd
    : NodePath.resolve(cwd, "../..");
  if (!NodeFS.existsSync(NodePath.join(root, "apps/desktop/package.json")))
    throw new Error("Pinned input command fixture refused.");
  return root;
}

export interface InertElementEndpoint {
  readonly elementId: string;
  readonly elementClear: (id: string) => Promise<void>;
  readonly elementSendKeys: (id: string, text: string) => Promise<void>;
}

/** The installed 9.29.1 setValue/clearValue/addValue implementation, not a rewritten gesture. */
export function pinnedSetValue(endpoint: InertElementEndpoint, value: string): Promise<void> {
  const require = NodeModule.createRequire(
    NodePath.join(repositoryRoot(), "apps/desktop/package.json"),
  );
  const entry = NodePath.join(NodePath.dirname(require.resolve("webdriverio")), "index.js");
  const manifest = JSON.parse(
    NodeFS.readFileSync(NodePath.join(NodePath.dirname(entry), "../package.json"), "utf8"),
  );
  if (manifest.version !== "9.29.1") throw new Error("Pinned input command fixture refused.");
  const source = NodeFS.readFileSync(entry, "utf8");
  const command = (name: string) => {
    const section = source.indexOf("// src/commands/element/" + name + ".ts");
    const start = source.indexOf(
      name === "setValue" ? "async function " + name : "function " + name,
      section,
    );
    const end = source.indexOf("\n// src/", start);
    if (section < 0 || start < section || end < start)
      throw new Error("Pinned input command fixture refused.");
    return source.slice(start, end);
  };
  const functions = NodeVM.runInNewContext(
    'const VALID_TYPES = ["string", "number"];\n' +
      command("clearValue") +
      command("addValue") +
      command("setValue") +
      "\n({ clearValue, addValue, setValue })",
  );
  const context = {
    ...endpoint,
    clearValue: functions.clearValue,
    addValue: functions.addValue,
  };
  return functions.setValue.call(context, value);
}

/** Load the actual serialized observer without adding desktop source to the web type graph. */
export function actualClearObserver(context: Record<string, unknown>) {
  const source = NodeFS.readFileSync(
    NodePath.join(repositoryRoot(), "apps/desktop/e2e/support/release-visual-observation.ts"),
    "utf8",
  );
  return NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(source).replace(/^export /gm, "") +
      "\n({ observeVisualNameClear, projectVisualNameClearObservation })",
    context,
  ) as {
    observeVisualNameClear: (input: {
      origin: string;
      threadId: string;
      admission: string;
      admitted?: boolean;
      operation: "start" | "finish";
    }) => unknown;
    projectVisualNameClearObservation: (input: unknown) => Record<string, unknown> | null;
  };
}
