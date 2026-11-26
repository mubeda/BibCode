import {
  DEFAULT_CODE_REVIEW_PROMPT,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@bibcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildCodeReviewMenuReviewers,
  CODE_REVIEW_INSTRUCTIONS_MAX_LENGTH,
  codeReviewGuardLine,
  codeReviewScopeText,
  resolveCodeReviewChatModes,
  resolveCodeReviewModelSelection,
  resolveCodeReviewPrompt,
  resolveSavedCodeReviewer,
} from "./codeReview";
import { buildProviderAgentActions } from "./components/chat/providerAgentActions";
import { deriveProviderInstanceEntries } from "./providerInstances";

const BRANCH = { kind: "branch", base: "origin/main" } as const;
const UNCOMMITTED = { kind: "uncommitted", base: "origin/main" } as const;
const BRANCH_LEAD =
  "Code review requested from BiBCode. Do not edit files. Scope: the commits on the current branch that are not on origin/main, plus all staged, unstaged and untracked changes. Base: origin/main.";
const UNCOMMITTED_LEAD =
  "Code review requested from BiBCode. Do not edit files. Scope: the staged, unstaged and untracked changes in the working tree.";

describe("codeReviewScopeText", () => {
  it("names both scopes", () => {
    expect(codeReviewScopeText(BRANCH)).toBe(
      "the commits on the current branch that are not on origin/main, plus all staged, unstaged and untracked changes",
    );
    expect(codeReviewScopeText(UNCOMMITTED)).toBe(
      "the staged, unstaged and untracked changes in the working tree",
    );
  });
});

describe("resolveCodeReviewPrompt", () => {
  it("puts the project prompt behind the lead-in when all three are set (R92)", () => {
    expect(
      resolveCodeReviewPrompt({
        project: "Check our test naming. Base is {base}.",
        user: "User text",
        scope: BRANCH,
      }),
    ).toBe(`${BRANCH_LEAD}\n\nCheck our test naming. Base is origin/main.`);
  });

  it("uses the user prompt when the project prompt is blank", () => {
    expect(resolveCodeReviewPrompt({ project: "", user: "User text", scope: BRANCH })).toBe(
      `${BRANCH_LEAD}\n\nUser text`,
    );
  });

  it("falls through whitespace-only values to the default", () => {
    const expectedDefault = DEFAULT_CODE_REVIEW_PROMPT.replaceAll(
      "{scope}",
      codeReviewScopeText(BRANCH),
    ).replaceAll("{base}", "origin/main");
    expect(resolveCodeReviewPrompt({ project: "   ", user: "", scope: BRANCH })).toBe(
      `${BRANCH_LEAD}\n\n${expectedDefault}`,
    );
    expect(resolveCodeReviewPrompt({ project: "\n\t ", user: "  ", scope: BRANCH })).toBe(
      `${BRANCH_LEAD}\n\n${expectedDefault}`,
    );
  });

  it("leaves Base out of the lead-in for the uncommitted scope", () => {
    expect(
      resolveCodeReviewPrompt({ project: "Scope {scope}", user: "", scope: UNCOMMITTED }),
    ).toBe(
      `${UNCOMMITTED_LEAD}\n\nScope the staged, unstaged and untracked changes in the working tree`,
    );
  });

  it("falls back to HEAD for a missing base", () => {
    expect(
      resolveCodeReviewPrompt({
        project: "diff {base}",
        user: "",
        scope: { kind: "uncommitted", base: null },
      }),
    ).toBe(`${UNCOMMITTED_LEAD}\n\ndiff HEAD`);
  });

  it("replaces every placeholder once, without reading $ patterns in the base", () => {
    expect(
      resolveCodeReviewPrompt({
        project: "{base} {base} {scope} {base}",
        user: "",
        scope: { kind: "uncommitted", base: "origin/a$&b" },
      }),
    ).toBe(
      `${UNCOMMITTED_LEAD}\n\norigin/a$&b origin/a$&b the staged, unstaged and untracked changes in the working tree origin/a$&b`,
    );
  });

  it("starts with the lead-in when the project prompt is a CLI command word", () => {
    const resolved = resolveCodeReviewPrompt({ project: "purge", user: "", scope: BRANCH });
    expect(resolved.startsWith("Code review requested from BiBCode.")).toBe(true);
    expect(resolved).toBe(`${BRANCH_LEAD}\n\npurge`);
  });

  it("appends one-off instructions after a blank line, without expanding them (R105)", () => {
    expect(
      resolveCodeReviewPrompt({
        project: "Rules for {base}.",
        user: "",
        scope: BRANCH,
        extra: "Focus on the parser. Not {base}.",
      }),
    ).toBe(`${BRANCH_LEAD}\n\nRules for origin/main.\n\nFocus on the parser. Not {base}.`);
    expect(
      resolveCodeReviewPrompt({ project: "Rules", user: "", scope: BRANCH, extra: " \n " }),
    ).toBe(`${BRANCH_LEAD}\n\nRules`);
    expect(CODE_REVIEW_INSTRUCTIONS_MAX_LENGTH).toBe(1_000);
  });
});

const AUTO_MODE_GUARD_LINE =
  "Runs in auto mode without asking for permissions. Told not to edit; BiBCode cannot block edits for this agent.";

describe("resolveCodeReviewChatModes", () => {
  it("uses full-access + default for non-Codex drivers and approval-required + default for Codex", () => {
    expect(resolveCodeReviewChatModes(ProviderDriverKind.make("codex"))).toEqual({
      runtimeMode: "approval-required",
      interactionMode: "default",
    });
    for (const driver of [
      "claudeAgent",
      "cursor",
      "grok",
      "opencode",
      "antigravity",
      "custom-reviewer",
    ]) {
      expect(resolveCodeReviewChatModes(ProviderDriverKind.make(driver))).toEqual({
        runtimeMode: "full-access",
        interactionMode: "default",
      });
    }
  });
});

describe("codeReviewGuardLine", () => {
  const line = (kind: "chat" | "terminal", driver: string) =>
    codeReviewGuardLine({ kind, driver: ProviderDriverKind.make(driver) });

  it("returns the auto-mode guard line for non-Codex reviewers and read-only lines for Codex", () => {
    expect(line("chat", "claudeAgent")).toBe(AUTO_MODE_GUARD_LINE);
    expect(line("chat", "codex")).toBe(
      "Runs in Codex's read-only sandbox. Writes ask for your approval.",
    );
    expect(line("chat", "opencode")).toBe(AUTO_MODE_GUARD_LINE);
    expect(line("chat", "cursor")).toBe(AUTO_MODE_GUARD_LINE);
    expect(line("chat", "grok")).toBe(AUTO_MODE_GUARD_LINE);
    expect(line("chat", "antigravity")).toBe(AUTO_MODE_GUARD_LINE);
    expect(line("terminal", "claudeAgent")).toBe(AUTO_MODE_GUARD_LINE);
    expect(line("terminal", "codex")).toBe("Runs in Codex's read-only sandbox.");
  });

  it("offers the Antigravity chat as a reviewer with the auto-mode guard, and no terminal review", () => {
    const antigravity = {
      instanceId: ProviderInstanceId.make("antigravity"),
      driver: ProviderDriverKind.make("antigravity"),
      displayName: "Antigravity",
      enabled: true,
      installed: true,
      status: "ready",
      availability: "available",
      models: [],
    } as unknown as ServerProvider;
    const actions = buildProviderAgentActions([antigravity], {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [antigravity.instanceId]: { driver: antigravity.driver, enabled: true },
      },
    });

    expect(
      buildCodeReviewMenuReviewers(actions, () => null).map(({ value, guardLine }) => ({
        value,
        guardLine,
      })),
    ).toEqual([
      {
        value: "chat:antigravity",
        guardLine: AUTO_MODE_GUARD_LINE,
      },
    ]);
  });

  it("says a Codex chat review runs on its own only on a server with read-only Codex reviews", () => {
    const codex = ProviderDriverKind.make("codex");
    expect(codeReviewGuardLine({ kind: "chat", driver: codex, readOnlyCodexReviews: true })).toBe(
      "Runs on its own in Codex's read-only sandbox, like the Codex terminal review.",
    );
    // An older server still asks before commands, so the line keeps today's wording.
    expect(codeReviewGuardLine({ kind: "chat", driver: codex, readOnlyCodexReviews: false })).toBe(
      "Runs in Codex's read-only sandbox. Writes ask for your approval.",
    );
    expect(
      codeReviewGuardLine({ kind: "terminal", driver: codex, readOnlyCodexReviews: true }),
    ).toBe("Runs in Codex's read-only sandbox.");
    expect(
      codeReviewGuardLine({
        kind: "chat",
        driver: ProviderDriverKind.make("claudeAgent"),
        readOnlyCodexReviews: true,
      }),
    ).toBe(AUTO_MODE_GUARD_LINE);
  });

  it("never promises that a review cannot edit", () => {
    for (const kind of ["chat", "terminal"] as const) {
      for (const driver of [
        "claudeAgent",
        "codex",
        "opencode",
        "cursor",
        "grok",
        "antigravity",
        "other",
      ]) {
        const text = line(kind, driver);
        expect(text).not.toMatch(/blocks|cannot edit/i);
        expect(text).not.toContain("—");
      }
    }
  });

  it("treats an unknown driver as auto-mode instructed only", () => {
    expect(line("chat", "other")).toBe(AUTO_MODE_GUARD_LINE);
  });
});

function provider(instanceId: string, driver: string, displayName: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver,
    displayName,
    enabled: true,
    installed: true,
    status: "ready",
    availability: "available",
    models: [],
  } as unknown as ServerProvider;
}

describe("resolveSavedCodeReviewer", () => {
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      claudeAgent: { ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent, enabled: false },
    },
  };
  const providers = [
    provider("claudeAgent", "claudeAgent", "Claude"),
    provider("cursor", "cursor", "Cursor"),
  ];
  const actions = buildProviderAgentActions(providers, settings);
  const known = deriveProviderInstanceEntries(providers);

  it("never falls back from a disabled saved reviewer (R90)", () => {
    expect(
      resolveSavedCodeReviewer(
        actions,
        { kind: "chat", instanceId: ProviderInstanceId.make("claudeAgent") },
        known,
      ),
    ).toEqual({
      action: null,
      reason: "Claude is not available. Change the code review agent in Settings → Agents.",
    });
  });

  it("names a listed reviewer that is not ready", () => {
    const notReady = buildProviderAgentActions(
      [{ ...provider("codex", "codex", "Codex"), status: "error" } as ServerProvider],
      DEFAULT_SERVER_SETTINGS,
    );
    expect(
      resolveSavedCodeReviewer(notReady, {
        kind: "terminal",
        instanceId: ProviderInstanceId.make("codex"),
      }),
    ).toEqual({
      action: null,
      reason: "Codex Terminal is not available. Change the code review agent in Settings → Agents.",
    });
  });

  it("names an unlisted reviewer", () => {
    expect(
      resolveSavedCodeReviewer(
        actions,
        { kind: "chat", instanceId: ProviderInstanceId.make("codex") },
        known,
      ),
    ).toEqual({
      action: null,
      reason:
        "The code review agent is not available on this environment. Change it in Settings → Agents.",
    });
  });

  it("matches kind and instance exactly", () => {
    const resolved = resolveSavedCodeReviewer(actions, {
      kind: "chat",
      instanceId: ProviderInstanceId.make("cursor"),
    });
    expect(resolved.reason).toBeNull();
    expect(resolved.action?.kind).toBe("chat");
    expect(resolved.action?.entry.instanceId).toBe("cursor");
  });
});

describe("resolveCodeReviewModelSelection", () => {
  const stored = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus" };

  it("keeps the stored model only for its own instance", () => {
    expect(resolveCodeReviewModelSelection(stored, ProviderInstanceId.make("claudeAgent"))).toBe(
      stored,
    );
    expect(resolveCodeReviewModelSelection(stored, ProviderInstanceId.make("codex"))).toBeNull();
    expect(resolveCodeReviewModelSelection(null, ProviderInstanceId.make("codex"))).toBeNull();
  });
});
