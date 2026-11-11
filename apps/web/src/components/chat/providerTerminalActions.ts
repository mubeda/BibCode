import {
  ProviderDriverKind,
  TERMINAL_LAUNCH_ARGUMENT_MAX_LENGTH,
  type ModelSelection,
  type ServerSettings,
  type TerminalLaunchCommand,
} from "@bibcode/contracts";
import {
  PROVIDER_SESSION_EFFORT_OPTION_IDS,
  resolveProviderSessionDefault,
  type ProviderSessionDefaultFallback,
  type ResolvedProviderSessionDefault,
} from "@bibcode/shared/providerSessionDefaults";
import { resolvePromptInjectedEffort } from "@bibcode/shared/model";

import { getProviderModelCapabilities } from "~/providerModels";

import { decodeTerminalLaunchCommand } from "~/lib/terminalLaunchCommand";
import type { ProviderInstanceEntry } from "~/providerInstances";

interface ProviderTerminalDefinition {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
}

type ProviderTerminalSettings = Pick<
  ServerSettings,
  "providerInstances" | "providers" | "providerSessionDefaults"
>;

const DEFINITIONS: Partial<Record<ProviderDriverKind, ProviderTerminalDefinition>> = {
  [ProviderDriverKind.make("claudeAgent")]: {
    executable: "claude",
    args: ["--dangerously-skip-permissions"],
  },
  [ProviderDriverKind.make("codex")]: {
    executable: "codex",
    args: ["--dangerously-bypass-approvals-and-sandbox"],
  },
  [ProviderDriverKind.make("opencode")]: {
    executable: "opencode",
    args: [],
    // OpenCode's TUI paints its own dark theme by default instead of using the
    // terminal's colors. The "system" theme makes it adopt xterm's defaults so
    // the embedded terminal follows the app theme; this config layer merges on
    // top of (and takes precedence over) the user's opencode.json.
    env: { OPENCODE_CONFIG_CONTENT: '{"theme":"system"}' },
  },
  [ProviderDriverKind.make("cursor")]: {
    executable: "cursor-agent",
    args: ["--yolo"],
  },
  [ProviderDriverKind.make("grok")]: {
    executable: "grok",
    args: ["--permission-mode", "bypassPermissions"],
  },
};

export interface ProviderTerminalAction {
  readonly entry: ProviderInstanceEntry;
  readonly label: string;
  readonly command: TerminalLaunchCommand;
  readonly disabledReason: null;
  readonly fallback?: ProviderSessionDefaultFallback;
}

export interface DisabledProviderTerminalAction {
  readonly entry: ProviderInstanceEntry;
  readonly label: string;
  readonly command: null;
  readonly disabledReason: string;
  readonly fallback?: ProviderSessionDefaultFallback;
}

export type ProviderTerminalActionItem = ProviderTerminalAction | DisabledProviderTerminalAction;

const COMMAND_BOUNDS_REASON =
  "Provider terminal command exceeds supported limits. Shorten the provider name or configured binary path.";
const CLAUDE_NATIVE_EFFORT_FALLBACKS = new Set(["low", "medium", "high", "xhigh", "max"]);

function binaryPath(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as { binaryPath?: unknown }).binaryPath;
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveClaudeNativeEffort(
  resolution: ResolvedProviderSessionDefault,
  models: ProviderInstanceEntry["models"],
): string | null {
  const effort = resolution.effort;
  if (effort === null) return null;

  const driver = ProviderDriverKind.make("claudeAgent");
  const capabilities = getProviderModelCapabilities(
    models,
    resolution.modelSelection.model,
    driver,
  );
  if (resolvePromptInjectedEffort(capabilities, effort) !== null) {
    return null;
  }
  const metadataRecognizesEffort = capabilities.optionDescriptors?.some(
    (descriptor) =>
      descriptor.type === "select" &&
      PROVIDER_SESSION_EFFORT_OPTION_IDS.some((id) => id === descriptor.id) &&
      descriptor.options.some((option) => option.id === effort),
  );
  if (metadataRecognizesEffort) {
    return effort;
  }
  return CLAUDE_NATIVE_EFFORT_FALLBACKS.has(effort) ? effort : null;
}

function providerArguments(
  driver: ProviderDriverKind,
  resolution: ResolvedProviderSessionDefault,
  models: ProviderInstanceEntry["models"],
): ReadonlyArray<string> {
  const model = resolution.modelSelection.model;
  if (driver === ProviderDriverKind.make("codex")) {
    const args = ["--model", model];
    if (resolution.effort !== null) {
      args.push("--config", `model_reasoning_effort="${resolution.effort}"`);
    }
    if (resolution.fastMode !== null) {
      args.push("--config", `service_tier="${resolution.fastMode ? "fast" : "default"}"`);
    }
    return args;
  }
  if (driver === ProviderDriverKind.make("claudeAgent")) {
    const nativeEffort = resolveClaudeNativeEffort(resolution, models);
    return ["--model", model, ...(nativeEffort === null ? [] : ["--effort", nativeEffort])];
  }
  if (driver === ProviderDriverKind.make("cursor")) {
    const baseModel = model.replace(/\[[^\]]*\]$/, "");
    const parameters = [
      resolution.effort === null ? null : `effort=${resolution.effort}`,
      resolution.fastMode === null ? null : `fast=${String(resolution.fastMode)}`,
    ].filter((value): value is string => value !== null);
    const cursorModel =
      parameters.length === 0 ? baseModel : `${baseModel}[${parameters.join(",")}]`;
    return ["--model", cursorModel];
  }
  if (driver === ProviderDriverKind.make("grok")) {
    return [
      "--model",
      model,
      ...(resolution.effort === null ? [] : ["--effort", resolution.effort]),
    ];
  }
  if (driver === ProviderDriverKind.make("opencode")) {
    return ["--model", model];
  }
  return [];
}

function resolveTerminalLaunch(
  entry: ProviderInstanceEntry,
  settings: ProviderTerminalSettings,
  definition: ProviderTerminalDefinition,
  explicitSelection: ModelSelection | null,
) {
  const instance = settings.providerInstances?.[entry.instanceId];
  const legacy = (settings.providers as Readonly<Record<string, unknown>>)[entry.driverKind];
  const resolution = resolveProviderSessionDefault({
    driver: entry.driverKind,
    instanceId: entry.instanceId,
    models: entry.models,
    configuredDefault: settings.providerSessionDefaults[entry.driverKind] ?? null,
    explicitSelection,
  });
  return {
    executable: binaryPath(instance?.config) ?? binaryPath(legacy) ?? definition.executable,
    // Every AI Terminal names its provider: the server observes the ones it can (Codex, Claude,
    // OpenCode on macOS and Linux) and reports the rest as status unavailable (#187).
    activity: { driverKind: entry.driverKind, providerInstanceId: entry.instanceId },
    resolution,
    modelArguments: providerArguments(entry.driverKind, resolution, entry.models),
  };
}

export function resolveProviderTerminalAction(
  entry: ProviderInstanceEntry,
  settings: ProviderTerminalSettings,
): ProviderTerminalActionItem | null {
  const definition = DEFINITIONS[entry.driverKind];
  if (!definition) return null;
  const { executable, activity, resolution, modelArguments } = resolveTerminalLaunch(
    entry,
    settings,
    definition,
    null,
  );
  const label = `${entry.displayName} Terminal`;
  const command = decodeTerminalLaunchCommand({
    executable,
    args: [...definition.args, ...modelArguments],
    label,
    ...(definition.env ? { env: { ...definition.env } } : {}),
    activity,
  });
  if (command === null) {
    return {
      entry,
      label,
      command: null,
      disabledReason: COMMAND_BOUNDS_REASON,
    };
  }
  return {
    entry,
    label,
    command,
    disabledReason: null,
    ...(resolution.fallback ? { fallback: resolution.fallback } : {}),
  };
}

// Only Task 12.17 turns this on, once the native Windows batch argument tests run green (D44).
export const WINDOWS_TERMINAL_REVIEWS_ENABLED = false;

/** Read-only flags replace `DEFINITIONS`' bypass flags; other CLIs' read-only flags are unverified. */
const REVIEW_ARGUMENTS: Partial<Record<ProviderDriverKind, ReadonlyArray<string>>> = {
  [ProviderDriverKind.make("claudeAgent")]: ["--permission-mode", "plan"],
  [ProviderDriverKind.make("codex")]: ["--sandbox", "read-only", "--ask-for-approval", "never"],
};

export const CODE_REVIEW_DRIVERS_WITH_TERMINALS: ReadonlySet<ProviderDriverKind> = new Set(
  Object.keys(REVIEW_ARGUMENTS) as ProviderDriverKind[],
);

const WINDOWS_REVIEWS_OFF_REASON =
  "Terminal reviews are off on Windows for now. Pick a chat reviewer in Settings → Agents.";
const REVIEW_PROMPT_TOO_LONG_REASON = `Review prompt is longer than ${TERMINAL_LAUNCH_ARGUMENT_MAX_LENGTH.toLocaleString("en-US")} characters. Shorten it in Settings → Agents.`;
const REVIEW_PROMPT_CONTROL_REASON =
  "Review prompt holds a control character other than tab or a line break. Remove it in Settings → Agents.";
// oxlint-disable-next-line no-control-regex -- the point is to find control characters.
const FORBIDDEN_CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

export function resolveProviderReviewTerminalAction(
  entry: ProviderInstanceEntry,
  settings: ProviderTerminalSettings,
  input: {
    readonly prompt: string;
    readonly platformOs: string | null;
    readonly modelSelection: ModelSelection | null;
    /** Test seam for Task 12.17; callers leave it unset. */
    readonly windowsEnabled?: boolean;
  },
): ProviderTerminalActionItem | null {
  const reviewArguments = REVIEW_ARGUMENTS[entry.driverKind];
  const definition = DEFINITIONS[entry.driverKind];
  if (!reviewArguments || !definition) return null;
  const label = `${entry.displayName} Review`;
  const disabled = (disabledReason: string): DisabledProviderTerminalAction => ({
    entry,
    label,
    command: null,
    disabledReason,
  });
  const isWindows = input.platformOs === "windows";
  if (isWindows && !(input.windowsEnabled ?? WINDOWS_TERMINAL_REVIEWS_ENABLED)) {
    return disabled(WINDOWS_REVIEWS_OFF_REASON);
  }
  // cmd.exe cannot carry a line break inside an argument; the web cannot see whether the
  // resolved executable is a batch file, so every Windows launch is flattened.
  const prompt = isWindows ? input.prompt.replace(/\r\n|\r|\n/g, " ") : input.prompt;
  if (prompt.length > TERMINAL_LAUNCH_ARGUMENT_MAX_LENGTH) {
    return disabled(REVIEW_PROMPT_TOO_LONG_REASON);
  }
  if (FORBIDDEN_CONTROL_CHARACTER.test(prompt)) return disabled(REVIEW_PROMPT_CONTROL_REASON);
  const { executable, activity, resolution, modelArguments } = resolveTerminalLaunch(
    entry,
    settings,
    definition,
    input.modelSelection,
  );
  const command = decodeTerminalLaunchCommand({
    executable,
    args: [...reviewArguments, ...modelArguments, "--", prompt],
    label,
    activity,
  });
  if (command === null) return disabled(COMMAND_BOUNDS_REASON);
  return {
    entry,
    label,
    command,
    disabledReason: null,
    ...(resolution.fallback ? { fallback: resolution.fallback } : {}),
  };
}
