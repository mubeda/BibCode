export const providerChatFixturePrompts = {
  activity: "load deterministic activity",
  markdown: "Owned visual markdown and plan",
  context: "Owned visual context and MCP",
  held: "Owned visual partial reply [[slow]]",
  refused: "Owned visual refused option",
  command: "/comp",
} as const;

/** These stay explicit; an adapter-only fixture cannot qualify a production input path. */
export const providerChatUnqualifiedPrerequisites = {
  "question-multiselect":
    "Claude production permission-request transport is not wired; Codex normalizes multiSelect to false.",
  "chat-held-workspace-loss":
    "Native CI must observe the exact Codex slow turn, held FIFO and registered managed loss/restore proof before crediting originals.",
  "chat-refused-model":
    "Native CI must observe public High selection, real modelSelectionRefused delivery/FIFO and original pixels before crediting this row.",
  "chat-markdown-plan":
    "Native CI must join the owned file mutation, signed PNG bytes and real plan/checkpoint before crediting originals.",
} as const;

// Existing Claude stdio shapes: production completion queries and native recorded plan frames.
const extension = String.raw`
if (process.env.CI !== "true") throw new Error("Owned visual provider fixture requires CI ownership.");
if (retryEnabled) throw new Error("Owned visual provider fixture modes cannot be combined.");
const ownedVisualMedia = () => {
  const refused = () => new Error("Owned visual media fixture refused.");
  const fixture = fs.realpathSync(process.env.BIBCODE_UPLOAD_FIXTURE);
  const root = fs.realpathSync(process.env.BIBCODE_E2E_RUN_ROOT);
  if (fixture !== process.env.BIBCODE_UPLOAD_FIXTURE || root !== process.env.BIBCODE_E2E_RUN_ROOT ||
      ![path.join(fixture, "light"), path.join(fixture, "dark")].includes(root)) throw refused();
  for (const directory of [fixture, root]) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw refused();
  }
  const read = (file) => {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > 8192 || fs.realpathSync(file) !== file) throw refused();
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const opened = fs.fstatSync(fd), bytes = Buffer.alloc(8193);
      const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size || size !== stat.size || size > 8192) throw refused();
      return { stat, bytes: bytes.subarray(0, size) };
    } finally { fs.closeSync(fd); }
  };
  const marker = path.join(root, "provider-chat-media.json");
  if ((fs.lstatSync(marker).mode & 0o777) !== 0o600) throw refused();
  const config = JSON.parse(read(marker).bytes.toString("utf8"));
  const keys = ["kind", "worktreePath", "threadId", "assetRelativeUrl", "sourceSha256", "updatedSha256", "imageSha256", "sourceDev", "sourceIno", "imageDev", "imageIno"];
  if (Object.keys(config).length !== keys.length || !keys.every(key => Object.hasOwn(config, key)) ||
      config.kind !== "provider-chat-v1" || typeof config.threadId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(config.threadId) ||
      typeof config.worktreePath !== "string" || fs.realpathSync(process.cwd()) !== config.worktreePath ||
      fs.realpathSync(config.worktreePath) !== config.worktreePath || fs.lstatSync(config.worktreePath).isSymbolicLink()) throw refused();
  const relative = path.relative(root, config.worktreePath);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw refused();
  const url = new URL(config.assetRelativeUrl, "http://127.0.0.1:4885");
  if (typeof config.assetRelativeUrl !== "string" || !config.assetRelativeUrl.startsWith("/api/assets/") ||
      config.assetRelativeUrl.length > 4096 || url.origin !== "http://127.0.0.1:4885" || url.username || url.password || url.hash) throw refused();
  const sourcePath = path.join(config.worktreePath, "visual-chat.ts"), imagePath = path.join(config.worktreePath, "visual-swatch.png");
  const source = read(sourcePath), image = read(imagePath), digest = bytes => visualHash("sha256").update(bytes).digest("hex");
  const updated = ${JSON.stringify(providerChatFileUpdated)};
  if (source.stat.dev !== config.sourceDev || source.stat.ino !== config.sourceIno || image.stat.dev !== config.imageDev || image.stat.ino !== config.imageIno ||
      digest(source.bytes) !== config.sourceSha256 || digest(image.bytes) !== config.imageSha256 || digest(Buffer.from(updated)) !== config.updatedSha256) throw refused();
  const fd = fs.openSync(sourcePath, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.dev !== config.sourceDev || stat.ino !== config.sourceIno || stat.nlink !== 1) throw refused();
    fs.ftruncateSync(fd, 0); fs.writeSync(fd, updated, 0, "utf8");
  } finally { fs.closeSync(fd); }
  return url.toString();
};
const ownedVisualClaudeHandler = (() => {
  let serial = 0;
  return (message, emit) => {
    const next = () => {
      if (++serial > 128) throw new Error("Owned visual provider fixture budget refused.");
      return "owned-visual-" + serial;
    };
    if (message.type === "control_request" && ["get_context_usage", "mcp_status"].includes(message.request?.subtype)) {
      if (typeof message.request_id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(message.request_id)) {
        throw new Error("Owned visual provider correlation refused.");
      }
      next();
      const response = message.request.subtype === "get_context_usage"
        ? { totalTokens: 31251, maxTokens: 200000, rawMaxTokens: 200000, percentage: 15.6255,
            model: "claude-sonnet", isAutoCompactEnabled: true, categories: [], memoryFiles: [], mcpTools: [], agents: [], gridRows: [] }
        : { mcpServers: [
            { name: "owned-visual-mcp-server-with-a-long-name-that-wraps", status: "connected" },
            { name: "owned-unavailable-server", status: "failed", error: "Owned fixture endpoint is unavailable." }
          ] };
      emit({ type: "control_response", response: { request_id: message.request_id, subtype: "success", response } });
      return true;
    }
    if (message.type !== "user") return false;
    const prompt = promptTextFromParts(message.message?.content);
    if (!["Owned visual markdown and plan", "Owned visual context and MCP"].includes(prompt)) return false;
    const session = message.session_id ?? launchedSession;
    if (typeof session !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(session)) throw new Error("Owned visual provider session refused.");
    const id = next();
    appendProviderInput("claudeAgent", prompt);
    emit(message);
    const stream = (event) => emit({ type: "stream_event", session_id: session, uuid: next(), parent_tool_use_id: null, event });
    stream({ type: "message_start", message: { id } });
    if (prompt === "Owned visual markdown and plan") {
      const imageUrl = ownedVisualMedia();
      const markdown = "# Owned visual response\n\n**Protocol markdown** with a task list.\n\n- [x] Observe the fixture\n- [ ] Review the result\n\n| Step | State |\n| --- | --- |\n| Capture | Ready |\n\n\u0060\u0060\u0060typescript\nexport const visual = \"owned\";\n\u0060\u0060\u0060\n\n![Owned visual swatch](" + imageUrl + ")";
      stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: markdown } });
      stream({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: id + "-todo", name: "TodoWrite", input: {} } });
      stream({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify({ todos: [
        { content: "Observe the fixture", status: "completed" }, { content: "Review the result", status: "in_progress" }
      ] }) } });
      stream({ type: "content_block_stop", index: 1 });
      emit({ type: "assistant", session_id: session, uuid: next(), parent_tool_use_id: null,
        message: { id, content: [{ type: "tool_use", id: id + "-plan", name: "ExitPlanMode", input: { plan: "# Owned visual plan\n\n- Observe the fixture\n- Review the result" } }] } });
    } else {
      stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Owned visual context response." } });
    }
    emit({ type: "result", subtype: "success", is_error: false, errors: [], stop_reason: "end_turn", session_id: session, uuid: next() });
    return true;
  };
})();
`;

/** Pure source extension for the existing owned CI shim; it never writes, launches, or enables a provider. */
export function extendOwnedClaudeVisualFixture(source: string, selection: string): string {
  const refused = () => new Error("Owned visual provider fixture refused.");
  const reader = 'reader.on("line", (line) => {';
  const parse = "  const message = JSON.parse(line);";
  if (
    selection !== "provider-chat-v1" ||
    typeof source !== "string" ||
    source.length > 65_536 ||
    source.includes("ownedVisualClaudeHandler") ||
    source.split(reader).length !== 2 ||
    source.split(parse).length !== 2 ||
    source.split("const message = JSON.parse(line);").length !== 2 ||
    !source.includes(
      'import { appendProviderInput, promptTextFromParts } from "./provider-input-log-fixture.mjs";',
    ) ||
    !source.includes('appendProviderInput("claudeAgent", prompt);') ||
    !source.includes('const retryEnabled = retryOption === "1";')
  )
    throw refused();
  const output =
    'import { createHash as visualHash } from "node:crypto";\n' +
    source
      .replace(reader, extension + "\n" + reader)
      .replace(parse, parse + "\n  if (ownedVisualClaudeHandler(message, send)) return;");
  if (output.length > 65_536) throw refused();
  return output;
}

const codexRefusalExtension = String.raw`
const ownedVisualCodexReasoning = (() => {
  const fixture = fs.realpathSync(process.env.BIBCODE_UPLOAD_FIXTURE);
  const root = fs.realpathSync(process.env.BIBCODE_E2E_RUN_ROOT);
  if (fixture !== process.env.BIBCODE_UPLOAD_FIXTURE || root !== process.env.BIBCODE_E2E_RUN_ROOT ||
      ![path.join(fixture, "light"), path.join(fixture, "dark")].includes(root)) {
    throw new Error("Owned visual Codex root refused.");
  }
  const directories = [fixture, root].map((directory) => {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0) {
      throw new Error("Owned visual Codex root refused.");
    }
    return { directory, dev: stat.dev, ino: stat.ino };
  });
  const marker = path.join(root, "provider-chat-refuse-high");
  const refreshMarkerState = () => {
    for (const owned of directories) {
      const current = fs.lstatSync(owned.directory);
      if (!current.isDirectory() || current.isSymbolicLink() || (current.mode & 0o077) !== 0 ||
          current.dev !== owned.dev || current.ino !== owned.ino ||
          fs.realpathSync(owned.directory) !== owned.directory) {
        throw new Error("Owned visual Codex root refused.");
      }
    }
    try { return fs.lstatSync(marker); }
    catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
  };
  const validateMarker = (stat) => {
    if (stat === undefined) return false;
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== 12 ||
          (stat.mode & 0o077) !== 0 || fs.realpathSync(marker) !== marker) {
        throw new Error("Owned visual Codex marker refused.");
      }
      const fd = fs.openSync(marker, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const opened = fs.fstatSync(fd);
        const bytes = Buffer.alloc(13);
        const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino ||
            opened.size !== 12 || opened.nlink !== 1 || (opened.mode & 0o077) !== 0 ||
            length !== 12 || bytes.subarray(0, length).toString("utf8") !== "refuse-high\n") {
          throw new Error("Owned visual Codex marker refused.");
        }
      } finally { fs.closeSync(fd); }
    return true;
  };
  let reads = 0;
  return () => {
    if (++reads > 128) throw new Error("Owned visual Codex catalog bound refused.");
    let stat;
    let refreshed = false;
    try { stat = fs.lstatSync(marker); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      stat = refreshMarkerState();
      refreshed = true;
    }
    let armed;
    try { armed = validateMarker(stat); }
    catch (error) {
      if (error?.code !== "ENOENT" || refreshed) throw error;
      armed = validateMarker(refreshMarkerState());
    }
    return armed ? [{ reasoningEffort: "medium" }]
      : [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }];
  };
})();
`;

/** Exact opt-in changes only the generated model/list offer; default bytes remain identical. */
export function extendOwnedCodexVisualFixture(source: string, selection?: string): string {
  const refused = () => new Error("Owned visual Codex fixture refused.");
  if (typeof source !== "string" || source.length > 65_536) throw refused();
  if (selection === undefined) return source;
  const hook = '          supportedReasoningEfforts: [{ reasoningEffort: "medium" }],';
  if (
    selection !== "provider-chat-v1" ||
    source.includes("ownedVisualCodexReasoning") ||
    source.includes('import path from "node:path";') ||
    source.split(hook).length !== 2 ||
    source.split("const activity = ").length !== 2 ||
    source.split('case "model/list":').length !== 2 ||
    !source.includes('import fs from "node:fs";') ||
    !source.includes(
      'import { appendProviderInput, promptTextFromParts } from "./provider-input-log-fixture.mjs";',
    )
  )
    throw refused();
  const output =
    'import path from "node:path";\nif (process.env.CI !== "true") throw new Error("Owned visual Codex fixture requires CI ownership.");\n' +
    source
      .replace("const activity = ", codexRefusalExtension + "\nconst activity = ")
      .replace(hook, "          supportedReasoningEfforts: ownedVisualCodexReasoning(),");
  if (output.length > 65_536) throw refused();
  return output;
}

export interface OwnedCodexVisualRefusalInput {
  selection: "provider-chat-v1";
  fixtureRoot: string;
  runRoot: string;
  childEnv: NodeJS.ProcessEnv;
  observeUnsafeCleanup?: () => void;
}

/** Arm before a real option validation; restore only the same owned marker on every outcome. */
export async function withOwnedCodexVisualOptionRefusal<T>(
  input: OwnedCodexVisualRefusalInput,
  observe: () => Promise<T>,
): Promise<T> {
  const refused = () => new Error("Owned visual Codex refusal control refused.");
  let marker: string;
  try {
    if (
      input.selection !== "provider-chat-v1" ||
      input.childEnv.CI !== "true" ||
      input.childEnv.BIBCODE_UPLOAD_FIXTURE !== input.fixtureRoot ||
      input.childEnv.BIBCODE_E2E_RUN_ROOT !== input.runRoot ||
      !NodePath.isAbsolute(input.fixtureRoot) ||
      input.fixtureRoot === NodePath.parse(input.fixtureRoot).root ||
      NodeFS.realpathSync(input.fixtureRoot) !== input.fixtureRoot ||
      NodeFS.realpathSync(input.runRoot) !== input.runRoot ||
      ![
        NodePath.join(input.fixtureRoot, "light"),
        NodePath.join(input.fixtureRoot, "dark"),
      ].includes(input.runRoot)
    )
      throw refused();
    for (const path of [input.fixtureRoot, input.runRoot]) {
      const stat = NodeFS.lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
        throw refused();
    }
    marker = NodePath.join(input.runRoot, "provider-chat-refuse-high");
  } catch {
    throw refused();
  }
  let owned: NodeFS.Stats;
  try {
    NodeFS.writeFileSync(marker, "refuse-high\n", { mode: 0o600, flag: "wx" });
    owned = NodeFS.lstatSync(marker);
  } catch {
    throw refused();
  }
  let failed = false;
  let failure: unknown;
  let result: T | undefined;
  try {
    result = await observe();
  } catch (error) {
    failed = true;
    failure = error;
  }
  let cleanupFailed = false;
  try {
    const after = NodeFS.lstatSync(marker);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.nlink !== 1 ||
      after.dev !== owned.dev ||
      after.ino !== owned.ino ||
      after.size !== 12 ||
      (after.mode & 0o077) !== 0
    )
      throw refused();
    const fd = NodeFS.openSync(
      marker,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
    );
    try {
      const opened = NodeFS.fstatSync(fd);
      const bytes = Buffer.alloc(13);
      const length = NodeFS.readSync(fd, bytes, 0, bytes.length, 0);
      if (
        !opened.isFile() ||
        (opened.mode & 0o077) !== 0 ||
        opened.dev !== owned.dev ||
        opened.ino !== owned.ino ||
        opened.nlink !== 1 ||
        opened.size !== 12 ||
        length !== 12 ||
        bytes.subarray(0, length).toString("utf8") !== "refuse-high\n"
      )
        throw refused();
    } finally {
      NodeFS.closeSync(fd);
    }
    NodeFS.unlinkSync(marker);
  } catch {
    cleanupFailed = true;
    try {
      input.observeUnsafeCleanup?.();
    } catch {
      /* Preserve original and cleanup failures. */
    }
  }
  if (failed) throw failure;
  if (cleanupFailed) throw refused();
  return result as T;
}
// @effect-diagnostics nodeBuiltinImport:off - Only generated private CI fixture controls are owned here.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { providerChatFileUpdated } from "./release-visual-provider-chat-values.ts";
