import {
  DEFAULT_CODE_REVIEW_PROMPT,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@bibcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  codeReviewGuardLine,
  codeReviewScopeText,
  resolveCodeReviewChatModes,
  resolveCodeReviewModelSelection,
  resolveCodeReviewPrompt,
  resolveSavedCodeReviewer,
} from "./codeReview";
import { buildProviderAgentActions } from "./components/chat/providerAgentActions";

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
});

describe("resolveCodeReviewChatModes", () => {
  it("uses plan only for Claude and approval everywhere", () => {
    expect(resolveCodeReviewChatModes(ProviderDriverKind.make("claudeAgent"))).toEqual({
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
    for (const driver of ["codex", "cursor", "grok", "opencode"]) {
      expect(resolveCodeReviewChatModes(ProviderDriverKind.make(driver))).toEqual({
        runtimeMode: "approval-required",
        interactionMode: "default",
      });
    }
  });
});

describe("codeReviewGuardLine", () => {
  const line = (kind: "chat" | "terminal", driver: string) =>
    codeReviewGuardLine({ kind, driver: ProviderDriverKind.make(driver) });

  it("returns the design note's line for each of the seven reviewers", () => {
    expect(line("chat", "claudeAgent")).toBe("Starts in Claude's plan mode.");
    expect(line("chat", "codex")).toBe(
      "Runs in Codex's read-only sandbox. Writes ask for your approval.",
    );
    expect(line("chat", "opencode")).toBe("Edits and commands ask for your approval.");
    expect(line("chat", "cursor")).toBe(
      "Told not to edit. BiBCode cannot block edits for this agent.",
    );
    expect(line("chat", "grok")).toBe(
      "Told not to edit. BiBCode cannot block edits for this agent.",
    );
    expect(line("terminal", "claudeAgent")).toBe("Starts in Claude's plan mode.");
    expect(line("terminal", "codex")).toBe("Runs in Codex's read-only sandbox.");
  });

  it("never promises that a review cannot edit", () => {
    for (const kind of ["chat", "terminal"] as const) {
      for (const driver of ["claudeAgent", "codex", "opencode", "cursor", "grok", "other"]) {
        const text = line(kind, driver);
        expect(text).not.toMatch(/blocks|cannot edit/i);
        expect(text).not.toContain("—");
      }
    }
  });

  it("treats an unknown driver as instructed only", () => {
    expect(line("chat", "other")).toBe(
      "Told not to edit. BiBCode cannot block edits for this agent.",
    );
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
  const actions = buildProviderAgentActions(
    [provider("claudeAgent", "claudeAgent", "Claude"), provider("cursor", "cursor", "Cursor")],
    settings,
  );

  it("never falls back from a disabled saved reviewer", () => {
    expect(
      resolveSavedCodeReviewer(actions, {
        kind: "chat",
        instanceId: ProviderInstanceId.make("claudeAgent"),
      }),
    ).toEqual({
      action: null,
      reason: "Claude is not available. Change the code review agent in Settings → Agents.",
    });
  });

  it("names an unlisted reviewer", () => {
    expect(
      resolveSavedCodeReviewer(actions, {
        kind: "chat",
        instanceId: ProviderInstanceId.make("codex"),
      }),
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
