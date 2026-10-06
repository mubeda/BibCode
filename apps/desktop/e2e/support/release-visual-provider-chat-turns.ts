// @effect-diagnostics nodeBuiltinImport:off - Exact private native input log bytes are bounded and schema decoded.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import type {
  OrchestrationThread,
  OrchestrationMessage,
} from "../../../../packages/contracts/src/orchestration.ts";
const Schema = NodeModule.createRequire(
  new NodeURL.URL("../../../../packages/contracts/package.json", import.meta.url),
)("effect/Schema");
const NativeInput = Schema.Struct({
  provider: Schema.Literals(["codex", "claudeAgent"]),
  kind: Schema.Literals(["start", "steer"]),
  prompt: Schema.String,
  turnId: Schema.optional(Schema.String),
  recordedAt: Schema.String,
});
export interface ProviderChatNativeInput {
  readonly provider: "codex" | "claudeAgent";
  readonly kind: "start" | "steer";
  readonly prompt: string;
  readonly turnId?: string;
  readonly recordedAt: string;
}
const refused = () => new Error("Owned provider turn proof refused.");
/** Native/public message correlation; IDs and native input values remain private. */
export interface ProviderChatMessageBinding {
  readonly messageId: string;
  readonly turnId: string | null;
  readonly threadId: string;
  readonly provider: "codex" | "claudeAgent";
  readonly prompt: string;
  readonly beforeInputCount: number;
}

export function readProviderChatInputs(path: string): readonly ProviderChatNativeInput[] {
  try {
    if (!NodePath.isAbsolute(path) || NodeFS.realpathSync(path) !== path) throw refused();
    const stat = NodeFS.lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536)
      throw refused();
    const text = NodeFS.readFileSync(path, "utf8");
    if (text && !text.endsWith("\n")) throw refused();
    const values = text.split("\n").filter(Boolean);
    if (values.length > 128 || values.some((value) => Buffer.byteLength(value) > 8192))
      throw refused();
    return values.map((value) => Schema.decodeUnknownSync(NativeInput)(JSON.parse(value)));
  } catch {
    throw refused();
  }
}
function message(thread: OrchestrationThread, id: string): OrchestrationMessage {
  const values = thread.messages.filter((value) => value.id === id && value.role === "user");
  if (values.length !== 1) throw refused();
  return values[0]!;
}
function provider(thread: OrchestrationThread, expected: "codex" | "claudeAgent") {
  if (
    thread.deletedAt !== null ||
    thread.modelSelection.instanceId !== expected ||
    thread.session?.threadId !== thread.id ||
    thread.session.providerInstanceId !== expected ||
    thread.session.providerName !== expected
  )
    throw refused();
}
export function bindProviderChatMessage(input: {
  before: OrchestrationThread;
  after: OrchestrationThread;
  prompt: string;
  provider: "codex" | "claudeAgent";
  state: "running" | "completed" | "queued" | "refused";
  inputs: readonly ProviderChatNativeInput[];
  beforeInputCount: number;
}): ProviderChatMessageBinding {
  const { before, after } = input;
  provider(after, input.provider);
  if (
    before.id !== after.id ||
    before.projectId !== after.projectId ||
    before.worktreePath !== after.worktreePath ||
    before.branch !== after.branch ||
    !Number.isInteger(input.beforeInputCount) ||
    input.beforeInputCount < 0 ||
    input.inputs.length < input.beforeInputCount
  )
    throw refused();
  const ids = new Set(before.messages.map((value) => value.id));
  const values = after.messages.filter(
    (value) => !ids.has(value.id) && value.role === "user" && value.text === input.prompt,
  );
  if (values.length !== 1) throw refused();
  const value = values[0]!;
  if (
    value.delivery?.provider !== input.provider ||
    value.delivery.providerInstanceId !== input.provider ||
    (value.delivery.mode ?? "start") !== "start"
  )
    throw refused();
  const appended = input.inputs.slice(input.beforeInputCount);
  if (input.state === "queued" || input.state === "refused") {
    if (
      appended.length !== 0 ||
      value.turnId !== null ||
      value.delivery.state !== (input.state === "queued" ? "queued" : "failed") ||
      (input.state === "refused" && value.delivery.reason !== "modelSelectionRefused")
    )
      throw refused();
  } else {
    if (
      value.delivery.state !== "delivered" ||
      value.turnId === null ||
      after.latestTurn?.turnId !== value.turnId ||
      after.latestTurn.state !== input.state ||
      (input.state === "running" && after.session?.activeTurnId !== value.turnId) ||
      appended.length !== 1 ||
      appended[0]?.provider !== input.provider ||
      appended[0].kind !== "start" ||
      appended[0].prompt !== input.prompt ||
      (input.provider === "codex" && appended[0].turnId !== value.turnId)
    )
      throw refused();
  }
  return Object.freeze({
    messageId: value.id,
    turnId: value.turnId,
    threadId: after.id,
    provider: input.provider,
    prompt: input.prompt,
    beforeInputCount: input.beforeInputCount,
  });
}

export function verifyProviderChatDelivery(input: {
  scene: "chat-held-workspace-loss" | "chat-refused-model";
  thread: OrchestrationThread;
  original: ProviderChatMessageBinding;
  queuedMessageId: string;
  inputs: readonly ProviderChatNativeInput[];
}) {
  const { thread, original } = input;
  provider(thread, "codex");
  if (thread.id !== original.threadId || original.provider !== "codex") throw refused();
  const first = message(thread, original.messageId),
    queued = message(thread, input.queuedMessageId);
  if (
    first.text !== original.prompt ||
    queued.turnId !== null ||
    queued.delivery?.state !== "queued" ||
    queued.delivery.provider !== "codex" ||
    queued.delivery.providerInstanceId !== "codex" ||
    (queued.delivery.mode ?? "start") !== "start" ||
    thread.messages.indexOf(first) >= thread.messages.indexOf(queued)
  )
    throw refused();
  const appended = input.inputs.slice(original.beforeInputCount);
  if (input.scene === "chat-refused-model") {
    if (
      first.turnId !== null ||
      first.delivery?.state !== "failed" ||
      first.delivery.reason !== "modelSelectionRefused" ||
      appended.length !== 0 ||
      queued.text !== "Owned visual message waiting behind refusal" ||
      thread.session?.activeTurnId !== null
    )
      throw refused();
    return Object.freeze({ exactFifo: true, modelSelectionRefused: true, noAutomaticResend: true });
  }
  const assistants = thread.messages.filter(
    (value) => value.role === "assistant" && value.turnId === original.turnId,
  );
  if (
    original.turnId === null ||
    first.turnId !== original.turnId ||
    first.delivery?.state !== "delivered" ||
    thread.latestTurn?.turnId !== original.turnId ||
    thread.latestTurn.state !== "error" ||
    thread.latestTurn.completedAt === null ||
    thread.session?.activeTurnId !== null ||
    thread.session.status !== "error" ||
    queued.delivery.held !== true ||
    queued.text !== "Owned visual message waiting behind partial reply" ||
    assistants.length !== 1 ||
    assistants[0]?.streaming !== false ||
    !assistants[0].text.includes("BiBCode deterministic streamed fixture response.") ||
    appended.length !== 1 ||
    appended[0]?.provider !== "codex" ||
    appended[0].kind !== "start" ||
    appended[0].prompt !== original.prompt ||
    appended[0].turnId !== original.turnId
  )
    throw refused();
  return Object.freeze({ exactNativeTurn: true, exactFifo: true, noAutomaticResend: true });
}
export function verifyProviderChatCheckpoint(
  thread: OrchestrationThread,
  binding: Pick<ProviderChatMessageBinding, "messageId" | "turnId">,
) {
  const user = message(thread, binding.messageId);
  const plans = thread.proposedPlans.filter(
    (value) => value.turnId === binding.turnId && value.planMarkdown.includes("Owned visual plan"),
  );
  const checkpoints = thread.checkpoints.filter(
    (value) => value.turnId === binding.turnId && value.status === "ready",
  );
  const assistants = thread.messages.filter(
    (value) => value.role === "assistant" && value.turnId === binding.turnId && !value.streaming,
  );
  if (
    binding.turnId === null ||
    user.turnId !== binding.turnId ||
    thread.latestTurn?.turnId !== binding.turnId ||
    thread.latestTurn.state !== "completed" ||
    plans.length !== 1 ||
    checkpoints.length !== 1 ||
    assistants.length !== 1 ||
    checkpoints[0]?.assistantMessageId !== assistants[0]?.id ||
    !checkpoints[0]?.files.some((value) => value.path === "visual-chat.ts" && value.additions > 0)
  )
    throw refused();
  return Object.freeze({ checkpointFileJoined: true, planTurnJoined: true });
}
