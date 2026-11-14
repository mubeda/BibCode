import type {
  ServerProviderUsageResult,
  ServerProviderUsageSnapshot,
  ServerProviderUsageWindow,
} from "@bibcode/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { AgentRow } from "../sidebar/agentsSection.logic";
import {
  formatResetTime,
  hintTargetWarning,
  resolveOutOfTokensHint,
  usageProviderOf,
} from "./outOfTokens.logic";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const OPTIONS = { now: NOW, locale: "en-US", timeZone: "UTC" } as const;

function row(
  driver: string | null,
  overrides: { terminalId?: string | null; status?: string; lastErrorClass?: string | null } = {},
): AgentRow {
  return {
    key: "thread-a",
    terminalId: overrides.terminalId ?? null,
    providerDriverKind: driver,
    shell: {
      session: {
        status: overrides.status ?? "ready",
        lastErrorClass: overrides.lastErrorClass ?? null,
      },
    },
  } as unknown as AgentRow;
}

function window(
  usedPercent: number,
  resetsAt: string | null,
  resetDescription: string | null = null,
) {
  return {
    usedPercent,
    windowMinutes: 300,
    resetsAt: resetsAt === null ? null : DateTime.makeUnsafe(resetsAt),
    resetDescription,
  } satisfies ServerProviderUsageWindow;
}

function usage(
  provider: "claude" | "codex",
  windows: Partial<Pick<ServerProviderUsageSnapshot, "session" | "weekly" | "fableWeekly">>,
  status: ServerProviderUsageSnapshot["status"] = "ok",
): ServerProviderUsageResult {
  const at = DateTime.makeUnsafe("2026-11-10T11:59:00.000Z");
  return {
    readAt: at,
    isFetching: false,
    providers: [
      {
        provider,
        status,
        session: null,
        weekly: null,
        fableWeekly: null,
        planType: null,
        rateLimitResetCredits: null,
        updatedAt: at,
        error: null,
        metadata: {},
        ...windows,
      },
    ],
  };
}

const claude = row("claudeAgent");

describe("outOfTokens.logic", () => {
  it('a Claude agent whose account usage is at its limit reads "Out of usage until 3:30 PM"', () => {
    const hint = resolveOutOfTokensHint({
      row: claude,
      usage: usage("claude", { session: window(100, "2026-11-10T15:30:00.000Z") }),
      ...OPTIONS,
    });
    expect(hint).toEqual({
      kind: "usage-limit",
      text: "Out of usage until 3:30 PM",
      resetsAt: new Date("2026-11-10T15:30:00.000Z"),
    });
    expect(usageProviderOf("claudeAgent" as never)).toBe("claude");
    expect(usageProviderOf("codex" as never)).toBe("codex");
    expect(usageProviderOf("cursor" as never)).toBeNull();
    expect(usageProviderOf(null)).toBeNull();
  });

  it('a reset on another day includes the weekday, "Out of usage until Tue 3:30 PM"', () => {
    const hint = resolveOutOfTokensHint({
      row: claude,
      usage: usage("claude", { weekly: window(100, "2026-11-17T15:30:00.000Z") }),
      ...OPTIONS,
    });
    expect(hint?.text).toBe("Out of usage until Tue 3:30 PM");
    expect(formatResetTime(new Date("2026-11-10T15:30:00.000Z"), NOW, OPTIONS)).toBe("3:30 PM");
  });

  it("with two windows at their limit the later reset wins", () => {
    const hint = resolveOutOfTokensHint({
      row: claude,
      usage: usage("claude", {
        session: window(100, "2026-11-10T15:30:00.000Z"),
        weekly: window(100, "2026-11-12T09:00:00.000Z"),
        fableWeekly: window(40, "2026-11-20T09:00:00.000Z"),
      }),
      ...OPTIONS,
    });
    expect(hint?.text).toBe("Out of usage until Thu 9:00 AM");
  });

  it('at its limit without a reset time reads "Out of usage", and with only a resetDescription reads "Out of usage until {description}"', () => {
    const bare = resolveOutOfTokensHint({
      row: claude,
      usage: usage("claude", { session: window(100, null) }),
      ...OPTIONS,
    });
    expect(bare).toEqual({ kind: "usage-limit", text: "Out of usage", resetsAt: null });
    const described = resolveOutOfTokensHint({
      row: claude,
      usage: usage("claude", { session: window(100, null, "tomorrow morning") }),
      ...OPTIONS,
    });
    expect(described?.text).toBe("Out of usage until tomorrow morning");
  });

  it("an account below its limit gives no hint", () => {
    const hint = resolveOutOfTokensHint({
      row: claude,
      usage: usage("claude", { session: window(99.4, "2026-11-10T15:30:00.000Z") }),
      ...OPTIONS,
    });
    expect(hint).toBeNull();
  });

  it("a usage snapshot that is not ok gives no hint", () => {
    const hint = resolveOutOfTokensHint({
      row: claude,
      usage: usage("claude", { session: window(100, "2026-11-10T15:30:00.000Z") }, "error"),
      ...OPTIONS,
    });
    expect(hint).toBeNull();
  });

  it('a chat agent whose last turn failed at the context limit reads "Context window full"', () => {
    const hint = resolveOutOfTokensHint({
      row: row("codex", { status: "error", lastErrorClass: "context_limit" }),
      usage: null,
      ...OPTIONS,
    });
    expect(hint).toEqual({ kind: "context-full", text: "Context window full" });
    const recovered = resolveOutOfTokensHint({
      row: row("codex", { status: "ready", lastErrorClass: "context_limit" }),
      usage: null,
      ...OPTIONS,
    });
    expect(recovered, "a session that took a turn since is no longer full").toBeNull();
  });

  it("an agent whose session failed for another reason gets no hint", () => {
    const hint = resolveOutOfTokensHint({
      row: row("codex", { status: "error", lastErrorClass: "provider_error" }),
      usage: usage("codex", { session: window(20, null) }),
      ...OPTIONS,
    });
    expect(hint).toBeNull();
  });

  it("a Cursor agent has no signal and gets no hint", () => {
    const hint = resolveOutOfTokensHint({
      row: row("cursor"),
      usage: usage("claude", { session: window(100, "2026-11-10T15:30:00.000Z") }),
      ...OPTIONS,
    });
    expect(hint).toBeNull();
  });

  it("a terminal agent gets no hint", () => {
    const hint = resolveOutOfTokensHint({
      row: row("claudeAgent", { terminalId: "term-1", lastErrorClass: "context_limit" }),
      usage: usage("claude", { session: window(100, "2026-11-10T15:30:00.000Z") }),
      ...OPTIONS,
    });
    expect(hint).toBeNull();
  });

  it('hintTargetWarning says "This agent may not answer until 3:30 PM." for a usage limit and "This agent\'s context window is full, so it may not answer." for a full context', () => {
    expect(
      hintTargetWarning({
        kind: "usage-limit",
        text: "Out of usage until 3:30 PM",
        resetsAt: new Date("2026-11-10T15:30:00.000Z"),
      }),
    ).toBe("This agent may not answer until 3:30 PM.");
    expect(hintTargetWarning({ kind: "context-full", text: "Context window full" })).toBe(
      "This agent's context window is full, so it may not answer.",
    );
  });
});
