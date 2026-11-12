import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  TERMINAL_LAUNCH_ARGUMENT_MAX_COUNT,
  TERMINAL_LAUNCH_ARGUMENT_MAX_LENGTH,
  TERMINAL_LAUNCH_EXECUTABLE_MAX_LENGTH,
  TERMINAL_LAUNCH_LABEL_MAX_LENGTH,
  type ProviderOptionDescriptor,
  type ServerSettings,
  type ServerProviderModel,
} from "@bibcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderInstanceEntry } from "~/providerInstances";
import { resolveCodeReviewPrompt } from "~/codeReview";
import { decodeTerminalLaunchCommand } from "~/lib/terminalLaunchCommand";
import {
  CODE_REVIEW_DRIVERS_WITH_TERMINALS,
  WINDOWS_TERMINAL_REVIEWS_ENABLED,
  resolveProviderReviewTerminalAction,
  resolveProviderTerminalAction,
} from "./providerTerminalActions";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CURSOR_DRIVER = ProviderDriverKind.make("cursor");
const GROK_DRIVER = ProviderDriverKind.make("grok");
const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");

function entry(
  driver: string,
  instanceId = driver,
  displayName = driver,
  models: ReadonlyArray<ServerProviderModel> = [],
): ProviderInstanceEntry {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driverKind: ProviderDriverKind.make(driver),
    displayName,
    accentColor: undefined,
    continuationGroupKey: undefined,
    enabled: true,
    installed: true,
    status: "ready",
    isDefault: instanceId === driver,
    isAvailable: true,
    snapshot: {} as ProviderInstanceEntry["snapshot"],
    models,
  };
}

function model(
  slug: string,
  optionDescriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ServerProviderModel {
  return {
    slug,
    name: slug,
    isCustom: false,
    capabilities: { optionDescriptors: [...optionDescriptors] },
  };
}

const effortDescriptor: ProviderOptionDescriptor = {
  id: "reasoningEffort",
  label: "Reasoning",
  type: "select",
  options: [
    { id: "medium", label: "Medium", isDefault: true },
    { id: "high", label: "High" },
  ],
  currentValue: "medium",
};

const claudeEffortDescriptor: ProviderOptionDescriptor = {
  ...effortDescriptor,
  id: "effort",
};

const claudePromptInjectedEffortDescriptor: ProviderOptionDescriptor = {
  ...claudeEffortDescriptor,
  options: [
    { id: "high", label: "High", isDefault: true },
    { id: "ultrathink", label: "Ultrathink" },
  ],
  promptInjectedValues: ["ultrathink"],
};

const cursorEffortDescriptor: ProviderOptionDescriptor = {
  ...effortDescriptor,
  id: "reasoning",
};

const fastModeDescriptor: ProviderOptionDescriptor = {
  id: "fastMode",
  label: "Fast mode",
  type: "boolean",
  currentValue: false,
};

const serviceTierDescriptor: ProviderOptionDescriptor = {
  id: "serviceTier",
  label: "Service tier",
  type: "select",
  options: [
    { id: "default", label: "Default", isDefault: true },
    { id: "fast", label: "Fast" },
  ],
  currentValue: "default",
};

const partialServiceTierDescriptor: ProviderOptionDescriptor = {
  id: "serviceTier",
  label: "Live service tier",
  type: "select",
  options: [{ id: "default", label: "Live Standard", isDefault: true }],
  currentValue: "default",
};

describe("resolveProviderTerminalAction", () => {
  it.each([
    {
      name: "Codex",
      driverKind: CODEX_DRIVER,
      models: [model("gpt-5.4", [effortDescriptor])],
      configuredDefault: {
        model: "gpt-5.4",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "serviceTier", value: "fast" },
        ],
      },
      expected: {
        executable: "codex",
        args: [
          "--dangerously-bypass-approvals-and-sandbox",
          "--model",
          "gpt-5.4",
          "--config",
          'model_reasoning_effort="high"',
        ],
        label: "Codex Terminal",
        activity: {
          driverKind: CODEX_DRIVER,
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
      },
    },
    {
      name: "Claude",
      driverKind: CLAUDE_DRIVER,
      models: [model("claude-sonnet-5", [claudeEffortDescriptor])],
      configuredDefault: {
        model: "claude-sonnet-5",
        options: [{ id: "effort", value: "high" }],
      },
      expected: {
        executable: "claude",
        args: ["--dangerously-skip-permissions", "--model", "claude-sonnet-5", "--effort", "high"],
        label: "Claude Terminal",
        activity: {
          driverKind: CLAUDE_DRIVER,
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        },
      },
    },
    {
      name: "Cursor",
      driverKind: CURSOR_DRIVER,
      models: [model("cursor-large[legacy=true]", [cursorEffortDescriptor, fastModeDescriptor])],
      configuredDefault: {
        model: "cursor-large[legacy=true]",
        options: [
          { id: "reasoning", value: "high" },
          { id: "fastMode", value: true },
        ],
      },
      expected: {
        executable: "cursor-agent",
        args: ["--yolo", "--model", "cursor-large[effort=high,fast=true]"],
        label: "Cursor Terminal",
        activity: {
          driverKind: CURSOR_DRIVER,
          providerInstanceId: ProviderInstanceId.make("cursor"),
        },
      },
    },
    {
      name: "Grok",
      driverKind: GROK_DRIVER,
      models: [model("grok-4", [claudeEffortDescriptor])],
      configuredDefault: {
        model: "grok-4",
        options: [{ id: "effort", value: "high" }],
      },
      expected: {
        executable: "grok",
        args: ["--permission-mode", "bypassPermissions", "--model", "grok-4", "--effort", "high"],
        label: "Grok Terminal",
        activity: {
          driverKind: GROK_DRIVER,
          providerInstanceId: ProviderInstanceId.make("grok"),
        },
      },
    },
    {
      name: "OpenCode",
      driverKind: OPENCODE_DRIVER,
      models: [model("openai/gpt-5", [claudeEffortDescriptor, fastModeDescriptor])],
      configuredDefault: {
        model: "openai/gpt-5",
        options: [
          { id: "effort", value: "high" },
          { id: "fastMode", value: true },
        ],
      },
      expected: {
        executable: "opencode",
        args: ["--model", "openai/gpt-5"],
        env: { OPENCODE_CONFIG_CONTENT: '{"theme":"system"}' },
        label: "OpenCode Terminal",
        activity: {
          driverKind: OPENCODE_DRIVER,
          providerInstanceId: ProviderInstanceId.make("opencode"),
        },
      },
    },
  ])(
    "resolves $name with the exact supported executable and argument vector",
    ({ name, driverKind, models, configuredDefault, expected }) => {
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerSessionDefaults: {
          [driverKind]: configuredDefault,
        },
      } satisfies ServerSettings;

      expect(
        resolveProviderTerminalAction(entry(driverKind, driverKind, name, models), settings)
          ?.command,
      ).toEqual(expected);
    },
  );

  it("omits unverified Codex Fast arguments during empty discovery", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerSessionDefaults: {
        [CODEX_DRIVER]: {
          model: "gpt-offline",
          options: [
            { id: "reasoningEffort", value: "xhigh" },
            { id: "serviceTier", value: "fast" },
          ],
        },
      },
    } satisfies ServerSettings;

    expect(
      resolveProviderTerminalAction(entry("codex", "codex", "Codex", []), settings)?.command?.args,
    ).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      DEFAULT_MODEL_BY_PROVIDER[CODEX_DRIVER],
      "--config",
      'model_reasoning_effort="xhigh"',
    ]);
  });

  it("omits Codex Fast arguments through a partial live serviceTier descriptor", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerSessionDefaults: {
        [CODEX_DRIVER]: {
          model: "gpt-5.6-sol",
          options: [{ id: "serviceTier", value: "fast" }],
        },
      },
    } satisfies ServerSettings;

    expect(
      resolveProviderTerminalAction(
        entry("codex", "codex", "Codex", [
          model("gpt-5.6-sol", [effortDescriptor, partialServiceTierDescriptor]),
        ]),
        settings,
      )?.command?.args,
    ).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      "gpt-5.6-sol",
      "--config",
      'model_reasoning_effort="medium"',
    ]);
  });

  it("builds Claude model and effort arguments and omits unsupported fast mode", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerSessionDefaults: {
        [CLAUDE_DRIVER]: {
          model: "claude-opus-4-8",
          options: [
            { id: "effort", value: "high" },
            { id: "fastMode", value: true },
          ],
        },
      },
    } satisfies ServerSettings;

    expect(
      resolveProviderTerminalAction(
        entry("claudeAgent", "claudeAgent", "Claude", [
          model("claude-opus-4-8", [claudeEffortDescriptor, fastModeDescriptor]),
        ]),
        settings,
      )?.command?.args,
    ).toEqual(["--dangerously-skip-permissions", "--model", "claude-opus-4-8", "--effort", "high"]);
  });

  it.each([
    {
      effort: "ultrathink",
      expected: ["--dangerously-skip-permissions", "--model", "claude-opus-4-8"],
    },
    {
      effort: "high",
      expected: [
        "--dangerously-skip-permissions",
        "--model",
        "claude-opus-4-8",
        "--effort",
        "high",
      ],
    },
  ])("maps the Claude $effort default to supported terminal arguments", ({ effort, expected }) => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerSessionDefaults: {
        [CLAUDE_DRIVER]: {
          model: "claude-opus-4-8",
          options: [{ id: "effort", value: effort }],
        },
      },
    } satisfies ServerSettings;

    expect(
      resolveProviderTerminalAction(
        entry("claudeAgent", "claudeAgent", "Claude", [
          model("claude-opus-4-8", [claudePromptInjectedEffortDescriptor]),
        ]),
        settings,
      )?.command?.args,
    ).toEqual(expected);
  });

  it.each([
    {
      effort: "ultrathink",
      expected: [
        "--dangerously-skip-permissions",
        "--model",
        DEFAULT_MODEL_BY_PROVIDER[CLAUDE_DRIVER],
      ],
    },
    {
      effort: "high",
      expected: [
        "--dangerously-skip-permissions",
        "--model",
        DEFAULT_MODEL_BY_PROVIDER[CLAUDE_DRIVER],
        "--effort",
        "high",
      ],
    },
  ])(
    "conservatively maps the Claude $effort default during empty discovery",
    ({ effort, expected }) => {
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerSessionDefaults: {
          [CLAUDE_DRIVER]: {
            model: "claude-offline",
            options: [{ id: "effort", value: effort }],
          },
        },
      } satisfies ServerSettings;

      expect(
        resolveProviderTerminalAction(entry("claudeAgent", "claudeAgent", "Claude", []), settings)
          ?.command?.args,
      ).toEqual(expected);
    },
  );

  it('passes Codex fast mode off as an explicit service_tier="default" config', () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerSessionDefaults: {
        [CODEX_DRIVER]: {
          model: "gpt-5.4",
          options: [{ id: "serviceTier", value: "default" }],
        },
      },
    } satisfies ServerSettings;

    expect(
      resolveProviderTerminalAction(
        entry("codex", "codex", "Codex", [model("gpt-5.4", [serviceTierDescriptor])]),
        settings,
      )?.command?.args,
    ).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      "gpt-5.4",
      "--config",
      'service_tier="default"',
    ]);
  });

  it("omits Claude fast mode from terminal arguments", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerSessionDefaults: {
        [CLAUDE_DRIVER]: {
          model: "claude-sonnet-5",
          options: [{ id: "fastMode", value: true }],
        },
      },
    } satisfies ServerSettings;

    expect(
      resolveProviderTerminalAction(
        entry("claudeAgent", "claudeAgent", "Claude", [
          model("claude-sonnet-5", [fastModeDescriptor]),
        ]),
        settings,
      )?.command?.args,
    ).toEqual(["--dangerously-skip-permissions", "--model", "claude-sonnet-5"]);
  });

  it("omits Grok fast mode from terminal arguments", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerSessionDefaults: {
        [GROK_DRIVER]: {
          model: "grok-4",
          options: [{ id: "fastMode", value: true }],
        },
      },
    } satisfies ServerSettings;

    expect(
      resolveProviderTerminalAction(
        entry("grok", "grok", "Grok", [model("grok-4", [fastModeDescriptor])]),
        settings,
      )?.command?.args,
    ).toEqual(["--permission-mode", "bypassPermissions", "--model", "grok-4"]);
  });

  it("preserves the verified Codex effort after a model fallback", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerSessionDefaults: {
        [CODEX_DRIVER]: {
          model: "retired-codex-model",
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "serviceTier", value: "fast" },
          ],
        },
      },
    } satisfies ServerSettings;

    const action = resolveProviderTerminalAction(
      entry("codex", "codex", "Codex", [model("gpt-5.4-mini", [])]),
      settings,
    );
    expect(action?.command?.args).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      "gpt-5.4-mini",
      "--config",
      'model_reasoning_effort="high"',
    ]);
    expect(action).toMatchObject({
      fallback: {
        driver: "codex",
        instanceId: "codex",
        configuredModel: "retired-codex-model",
        resolvedModel: "gpt-5.4-mini",
        reason: "configured-model-unavailable",
      },
    });
  });

  it("launches opencode with the system theme so the TUI follows the app theme", () => {
    const action = resolveProviderTerminalAction(
      entry("opencode", "opencode", "OpenCode"),
      DEFAULT_SERVER_SETTINGS,
    );
    expect(action?.command).toMatchObject({
      executable: "opencode",
      env: { OPENCODE_CONFIG_CONTENT: '{"theme":"system"}' },
    });
  });

  it("leaves the launch environment unset for providers without env defaults", () => {
    const action = resolveProviderTerminalAction(
      entry("claudeAgent", "claudeAgent", "Claude"),
      DEFAULT_SERVER_SETTINGS,
    );
    expect(action?.command?.env).toBe(undefined);
  });

  it("prefers instance paths, then legacy paths, and preserves custom names", () => {
    const customId = ProviderInstanceId.make("codex_personal");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        codex: {
          ...DEFAULT_SERVER_SETTINGS.providers.codex,
          binaryPath: "/legacy/codex",
        },
      },
      providerInstances: {
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
          displayName: "Personal Codex",
          config: { binaryPath: " /custom/Codex CLI " },
        },
      },
    } satisfies ServerSettings;

    expect(
      resolveProviderTerminalAction(entry("codex", customId, "Personal Codex"), settings),
    ).toMatchObject({
      label: "Personal Codex Terminal",
      command: {
        executable: "/custom/Codex CLI",
        activity: {
          driverKind: CODEX_DRIVER,
          providerInstanceId: customId,
        },
      },
    });

    const inherited = {
      ...settings,
      providerInstances: {
        [customId]: {
          ...settings.providerInstances[customId]!,
          config: {},
        },
      },
    };
    expect(
      resolveProviderTerminalAction(entry("codex", customId, "Personal Codex"), inherited),
    ).toMatchObject({
      command: {
        executable: "/legacy/codex",
        activity: {
          driverKind: CODEX_DRIVER,
          providerInstanceId: customId,
        },
      },
    });
  });

  it("falls through whitespace-only instance and legacy binary paths", () => {
    const customId = ProviderInstanceId.make("codex_personal");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        codex: {
          ...DEFAULT_SERVER_SETTINGS.providers.codex,
          binaryPath: " /legacy/codex ",
        },
      },
      providerInstances: {
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
          config: { binaryPath: " \t " },
        },
      },
    } satisfies ServerSettings;

    expect(
      resolveProviderTerminalAction(entry("codex", customId, "Personal Codex"), settings),
    ).toMatchObject({ command: { executable: "/legacy/codex" } });

    expect(
      resolveProviderTerminalAction(entry("codex", customId, "Personal Codex"), {
        ...settings,
        providers: {
          ...settings.providers,
          codex: {
            ...settings.providers.codex,
            binaryPath: " \n ",
          },
        },
      }),
    ).toMatchObject({ command: { executable: "codex" } });
  });

  it("preserves an explicit non-default Cursor binary path", () => {
    const customId = ProviderInstanceId.make("cursor_work");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [customId]: {
          driver: ProviderDriverKind.make("cursor"),
          config: { binaryPath: " /Applications/Cursor Agent/custom-agent " },
        },
      },
    } satisfies ServerSettings;

    expect(
      resolveProviderTerminalAction(entry("cursor", customId, "Work Cursor"), settings),
    ).toMatchObject({
      command: { executable: "/Applications/Cursor Agent/custom-agent" },
    });
  });

  it("does not invent command semantics for an unregistered driver", () => {
    const action = resolveProviderTerminalAction(
      entry("forkDriver", "fork", "Fork"),
      DEFAULT_SERVER_SETTINGS,
    );
    expect(action).toBeNull();
    expect(
      decodeTerminalLaunchCommand({
        executable: "fork-cli",
        args: [],
        label: "Fork shell",
      }),
    ).not.toHaveProperty("activity");
  });

  it.each([
    { driver: CURSOR_DRIVER, executable: "cursor-agent" },
    { driver: GROK_DRIVER, executable: "grok" },
  ])("names the $driver provider so its status reads unavailable", ({ driver, executable }) => {
    const action = resolveProviderTerminalAction(entry(driver, driver), DEFAULT_SERVER_SETTINGS);

    expect(action?.command?.executable).toBe(executable);
    // The server has no observer for this provider; the identity lets the left panel list the
    // agent with an unavailable status instead of hiding it (#187).
    expect(action?.command?.activity).toEqual({
      driverKind: driver,
      providerInstanceId: driver,
    });
  });

  it.each([
    {
      name: "configured executable",
      displayName: "Codex",
      binaryPath: "x".repeat(TERMINAL_LAUNCH_EXECUTABLE_MAX_LENGTH + 1),
    },
    {
      name: "display label",
      displayName: "x".repeat(TERMINAL_LAUNCH_LABEL_MAX_LENGTH),
      binaryPath: "codex",
    },
  ])("disables an action with an oversized $name", ({ displayName, binaryPath }) => {
    const instanceId = ProviderInstanceId.make("codex_bounded");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("codex"),
          displayName,
          config: { binaryPath },
        },
      },
    } satisfies ServerSettings;

    expect(
      resolveProviderTerminalAction(entry("codex", instanceId, displayName), settings),
    ).toEqual({
      entry: entry("codex", instanceId, displayName),
      label: `${displayName} Terminal`,
      command: null,
      disabledReason:
        "Provider terminal command exceeds supported limits. Shorten the provider name or configured binary path.",
    });
  });

  it("disables an action when a resolved model argument exceeds command bounds", () => {
    const oversizedModel = "x".repeat(TERMINAL_LAUNCH_ARGUMENT_MAX_LENGTH + 1);
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerSessionDefaults: {
        [OPENCODE_DRIVER]: { model: oversizedModel },
      },
    } satisfies ServerSettings;
    const providerEntry = entry("opencode", "opencode", "OpenCode", [model(oversizedModel, [])]);

    expect(resolveProviderTerminalAction(providerEntry, settings)).toEqual({
      entry: providerEntry,
      label: "OpenCode Terminal",
      command: null,
      disabledReason:
        "Provider terminal command exceeds supported limits. Shorten the provider name or configured binary path.",
    });
  });

  it("decodes executable, argument, count, and label boundaries before launch", () => {
    const atBoundary = {
      executable: "x".repeat(TERMINAL_LAUNCH_EXECUTABLE_MAX_LENGTH),
      args: Array.from({ length: TERMINAL_LAUNCH_ARGUMENT_MAX_COUNT }, () =>
        "x".repeat(TERMINAL_LAUNCH_ARGUMENT_MAX_LENGTH),
      ),
      label: "x".repeat(TERMINAL_LAUNCH_LABEL_MAX_LENGTH),
    };
    expect(decodeTerminalLaunchCommand(atBoundary)).toEqual(atBoundary);
    expect(
      decodeTerminalLaunchCommand({ executable: "/bin/zsh", args: ["-l"] }),
    ).not.toHaveProperty("activity");

    for (const candidate of [
      { ...atBoundary, executable: `${atBoundary.executable}x` },
      { ...atBoundary, args: [`${atBoundary.args[0]}x`] },
      { ...atBoundary, args: [...atBoundary.args, "x"] },
      { ...atBoundary, label: `${atBoundary.label}x` },
    ]) {
      expect(decodeTerminalLaunchCommand(candidate)).toBeNull();
    }
  });
});

describe("resolveProviderReviewTerminalAction", () => {
  const PROMPT =
    "Code review requested from BiBCode. Do not edit files. Scope: the staged, unstaged and untracked changes in the working tree.\n\nReview.";
  const claude = entry("claudeAgent", "claudeAgent", "Claude", [
    model("opus", []),
    model("sonnet", []),
  ]);
  const codex = entry("codex", "codex", "Codex", [model("gpt-5", []), model("gpt-5.4", [])]);
  const review = (
    target: ProviderInstanceEntry,
    input: Partial<Parameters<typeof resolveProviderReviewTerminalAction>[2]> = {},
  ) =>
    resolveProviderReviewTerminalAction(target, DEFAULT_SERVER_SETTINGS, {
      prompt: PROMPT,
      platformOs: "darwin",
      modelSelection: null,
      ...input,
    });

  it("starts Claude in plan mode with the prompt last, after -- (R97)", () => {
    const action = review(claude, {
      modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus" },
    });
    expect(action?.disabledReason).toBeNull();
    expect(action?.label).toBe("Claude Review");
    expect(action?.command?.executable).toBe("claude");
    expect(action?.command?.args).toEqual([
      "--permission-mode",
      "plan",
      "--model",
      "opus",
      "--",
      PROMPT,
    ]);
    expect(action?.command?.activity).toEqual({
      driverKind: CLAUDE_DRIVER,
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    });
  });

  it("starts Codex in the read-only sandbox with the prompt last, after -- (R97)", () => {
    const args = review(codex)?.command?.args ?? [];
    expect(args.slice(0, 4)).toEqual(["--sandbox", "read-only", "--ask-for-approval", "never"]);
    expect(args.slice(-2)).toEqual(["--", PROMPT]);
  });

  it("never carries a bypass flag", () => {
    for (const target of [claude, codex]) {
      const args = review(target)?.command?.args ?? [];
      expect(args.length).toBeGreaterThan(0);
      for (const flag of [
        "--dangerously-skip-permissions",
        "--allow-dangerously-skip-permissions",
        "--dangerously-bypass-approvals-and-sandbox",
      ]) {
        expect(args).not.toContain(flag);
      }
    }
  });

  it("uses the review model only for its own instance", () => {
    const foreign = review(claude, {
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "sonnet" },
    });
    expect(foreign?.command?.args.slice(2, 4)).toEqual(["--model", "opus"]);
    const own = review(codex, {
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    });
    expect(own?.command?.args.slice(4, 6)).toEqual(["--model", "gpt-5.4"]);
  });

  it("offers no review terminal for other drivers", () => {
    expect(review(entry("cursor"))).toBeNull();
    expect(review(entry("opencode"))).toBeNull();
    expect(review(entry("grok"))).toBeNull();
    expect(CODE_REVIEW_DRIVERS_WITH_TERMINALS).toEqual(new Set([CLAUDE_DRIVER, CODEX_DRIVER]));
  });

  it("refuses a prompt over 8,192 characters", () => {
    expect(review(claude, { prompt: "x".repeat(8_192) })?.disabledReason).toBeNull();
    expect(review(claude, { prompt: "x".repeat(8_193) })).toMatchObject({
      command: null,
      disabledReason:
        "Review prompt is longer than 8,192 characters. Shorten it in Settings → Agents.",
    });
  });

  it("refuses control characters other than tab and line breaks", () => {
    expect(review(codex, { prompt: "a\tb\r\nc" })?.disabledReason).toBeNull();
    expect(review(codex, { prompt: "a b" })?.disabledReason).toBeNull();
    for (const prompt of [
      "a\u0000b",
      "a\u001bb",
      "a\u007fb",
      "a\u0080b",
      "a\u0085b",
      "a\u009bb",
      "a\u009fb",
    ]) {
      expect(review(codex, { prompt })).toMatchObject({
        command: null,
        disabledReason:
          "Review prompt holds a control character other than tab or a line break. Remove it in Settings → Agents.",
      });
    }
  });

  it("keeps a prompt that starts with a dash after --", () => {
    const args = review(claude, { prompt: "--dangerously-skip-permissions" })?.command?.args ?? [];
    expect(args.at(-2)).toBe("--");
    expect(args.indexOf("--dangerously-skip-permissions")).toBe(args.length - 1);
  });

  it("is on on Windows, with line breaks flattened (R98)", () => {
    expect(WINDOWS_TERMINAL_REVIEWS_ENABLED).toBe(true);
    for (const target of [claude, codex]) {
      const action = review(target, { prompt: "a\nb\r\nc\rd", platformOs: "windows" });
      expect(action?.disabledReason).toBeNull();
      expect(action?.command?.args.at(-1)).toBe("a b c d");
      for (const platformOs of ["darwin", "linux", null]) {
        expect(review(target, { platformOs })?.disabledReason).toBeNull();
      }
    }
  });

  it("flattens line breaks on Windows only", () => {
    const prompt = "a\nb\r\nc\rd";
    expect(review(codex, { prompt, platformOs: "windows" })?.command?.args.at(-1)).toBe("a b c d");
    expect(review(codex, { prompt, platformOs: "linux" })?.command?.args.at(-1)).toBe(prompt);
  });

  it("ends with one-off instructions, flattened only on Windows (R105)", () => {
    const prompt = resolveCodeReviewPrompt({
      project: "Rules",
      user: "",
      scope: { kind: "uncommitted", base: "origin/main" },
      extra: "Focus on the parser.",
    });
    for (const platformOs of ["darwin", "linux"]) {
      expect(review(claude, { prompt, platformOs })?.command?.args.at(-1)).toMatch(
        /Rules\n\nFocus on the parser\.$/,
      );
    }
    expect(review(claude, { prompt, platformOs: "windows" })?.command?.args.at(-1)).toMatch(
      /Rules {2}Focus on the parser\.$/,
    );
  });
});
