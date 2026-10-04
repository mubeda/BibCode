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

function pinnedCommandSource() {
  const require = NodeModule.createRequire(
    NodePath.join(repositoryRoot(), "apps/desktop/package.json"),
  );
  const entry = NodePath.join(NodePath.dirname(require.resolve("webdriverio")), "index.js");
  const manifest = JSON.parse(
    NodeFS.readFileSync(NodePath.join(NodePath.dirname(entry), "../package.json"), "utf8"),
  );
  if (manifest.version !== "9.29.1") throw new Error("Pinned input command fixture refused.");
  return { require, entry, source: NodeFS.readFileSync(entry, "utf8") };
}

export interface InertElementEndpoint {
  readonly elementId: string;
  readonly elementClear: (id: string) => Promise<void>;
  readonly elementSendKeys: (id: string, text: string) => Promise<void>;
}

/** The installed 9.29.1 setValue/clearValue/addValue implementation, not a rewritten gesture. */
export function pinnedSetValue(endpoint: InertElementEndpoint, value: string): Promise<void> {
  const { source } = pinnedCommandSource();
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

export interface InertKeyboardAction {
  readonly type: "keyDown" | "keyUp" | "pause";
  readonly value?: string;
  readonly duration?: number;
}

export interface InertKeyboardEndpoint {
  readonly performActions: (
    actions: ReadonlyArray<{
      readonly type: string;
      readonly id: string;
      readonly parameters: Record<string, unknown>;
      readonly actions: ReadonlyArray<InertKeyboardAction>;
    }>,
  ) => Promise<void>;
  readonly releaseActions: () => Promise<void>;
}

const keyboardCommandCache = new WeakMap<
  InertKeyboardEndpoint,
  {
    keys: (value: string | string[]) => Promise<void>;
    action: (type: string, options?: unknown) => unknown;
  }
>();

/** Installed keys/action/KeyAction/BaseAction implementations; only the protocol endpoint is inert. */
export async function pinnedKeys(
  endpoint: InertKeyboardEndpoint,
  value: string | string[],
): Promise<void> {
  const { source, require, entry } = pinnedCommandSource();
  const dependencyRequire = NodeModule.createRequire(entry);
  const section = (marker: string, start: string, end: string) => {
    const markerIndex = source.indexOf(marker);
    const first = source.indexOf(start, markerIndex);
    const last = source.indexOf(end, first);
    if (markerIndex < 0 || first < markerIndex || last < first)
      throw new Error("Pinned input command fixture refused.");
    return source.slice(first, last);
  };
  let commands = keyboardCommandCache.get(endpoint);
  if (!commands) {
    const utilities = NodeFS.readFileSync(
      NodePath.join(NodePath.dirname(entry), "../../@wdio/utils/build/index.js"),
      "utf8",
    );
    const unicodeStart = utilities.indexOf("var UNICODE_CHARACTERS = {");
    const unicodeEnd = utilities.indexOf("\n};", unicodeStart);
    const primitiveEnd = source.indexOf("\n// src/index.ts");
    if (unicodeStart < 0 || unicodeEnd < unicodeStart || primitiveEnd < 0)
      throw new Error("Pinned input command fixture refused.");
    commands = NodeVM.runInNewContext(
      source.slice(0, primitiveEnd) +
        utilities.slice(unicodeStart, unicodeEnd + "\n};".length) +
        "\nconst UNICODE_CHARACTERS2 = UNICODE_CHARACTERS;\n" +
        section("// src/utils/actions/base.ts", "var keyActionIds =", "\n// src/environment.ts") +
        section(
          "// src/utils/actions/key.ts",
          "var _KeyAction_instances",
          "\n// src/utils/actions/pointer.ts",
        ) +
        section("// src/commands/browser/keys.ts", "async function keys(", "\n// src/") +
        section("// src/commands/browser/action.ts", "function action(", "\n// src/") +
        section(
          "function checkUnicode(",
          "function checkUnicode(",
          "\nfunction fetchElementByJSFunction(",
        ) +
        "\n({ keys, action })",
      {
        Key: require("webdriverio").Key,
        environment: { value: { osType: () => "linux" } },
        GraphemeSplitter: dependencyRequire("grapheme-splitter"),
      },
    );
    if (!commands) throw new Error("Pinned input command fixture refused.");
    keyboardCommandCache.set(endpoint, commands);
  }
  const context = {
    ...endpoint,
    capabilities: { platformName: "linux" },
    options: { hostname: "127.0.0.1" },
    isIOS: false,
    action: commands.action,
  };
  await commands.keys.call(context, value);
}

/** Execute the actual controller's public clear block and focus proof without importing its type graph. */
export function actualVisualNameClear(context: Record<string, unknown>): () => Promise<void> {
  const source = NodeFS.readFileSync(
    NodePath.join(repositoryRoot(), "apps/desktop/e2e/support/release-visual-core.ts"),
    "utf8",
  );
  const focusStart = source.indexOf("  const focus = async");
  const focusEnd = source.indexOf("\n  const composer =", focusStart);
  const clearStart = source.indexOf("\n  try {", source.indexOf("  const clearInput ="));
  const clearEnd = source.indexOf("\n  } finally {", clearStart);
  if (focusStart < 0 || focusEnd < focusStart || clearStart < 0 || clearEnd < clearStart)
    throw new Error("Pinned input command fixture refused.");
  return NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      "async function clearOwnedName() {\n" +
        source.slice(focusStart, focusEnd) +
        source.slice(clearStart + "\n  try {".length, clearEnd) +
        "\n}\nclearOwnedName",
    ),
    context,
  );
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
