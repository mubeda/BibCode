/**
 * Whether a chat agent is out of tokens: its last turn failed with a full context window, or its
 * provider's account usage is at its limit. A hint only: the agent stays pickable, and Take over
 * from lists it first. Providers without either signal (Cursor, terminals) get no hint.
 */
import type {
  ProviderDriverKind,
  ServerProviderUsageProvider,
  ServerProviderUsageResult,
  ServerProviderUsageWindow,
} from "@bibcode/contracts";
import * as DateTime from "effect/DateTime";

import type { AgentRow } from "../sidebar/agentsSection.logic";
import { clampPercent } from "../status-bar/statusBarFormat";

export type OutOfTokensHint =
  | { kind: "context-full"; text: string }
  | { kind: "usage-limit"; text: string; resetsAt: Date | null };

const OUT_OF_USAGE = "Out of usage";
const OUT_OF_USAGE_UNTIL = `${OUT_OF_USAGE} until `;

export function usageProviderOf(
  driver: ProviderDriverKind | null,
): ServerProviderUsageProvider | null {
  if (driver === "claudeAgent") return "claude";
  if (driver === "codex") return "codex";
  return null;
}

function dayKey(date: Date, locale: string | undefined, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** "3:30 PM" on the same day as `now`, else "Tue 3:30 PM". */
export function formatResetTime(
  resetsAt: Date,
  now: Date,
  options: { locale?: string; timeZone?: string } = {},
): string {
  const { locale, timeZone } = options;
  const sameDay = dayKey(resetsAt, locale, timeZone) === dayKey(now, locale, timeZone);
  const text = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    ...(sameDay ? {} : { weekday: "short" }),
  }).format(resetsAt);
  // ICU puts a narrow no-break space before the day period; copy uses a plain space.
  return text.replace(/[  ]/g, " ").replace(",", "");
}

export function resolveOutOfTokensHint(input: {
  row: AgentRow;
  usage: ServerProviderUsageResult | null;
  now: Date;
  locale?: string;
  timeZone?: string;
}): OutOfTokensHint | null {
  const { row } = input;
  if (row.terminalId !== null) return null;
  // The class can outlive the failure, so it counts only while the session is still failed.
  const session = row.shell.session;
  if (session?.status === "error" && session.lastErrorClass === "context_limit") {
    return { kind: "context-full", text: "Context window full" };
  }
  const provider = usageProviderOf(row.providerDriverKind);
  const snapshot = input.usage?.providers.find(
    (entry) => entry.provider === provider && entry.status === "ok",
  );
  if (snapshot === undefined) return null;
  const limited = [snapshot.session, snapshot.weekly, snapshot.fableWeekly].filter(
    (window): window is ServerProviderUsageWindow =>
      window !== null && clampPercent(window.usedPercent) === 100,
  );
  if (limited.length === 0) return null;
  let resetsAt: Date | null = null;
  for (const window of limited) {
    if (window.resetsAt === null) continue;
    const at = DateTime.toDate(window.resetsAt);
    if (resetsAt === null || at > resetsAt) resetsAt = at;
  }
  if (resetsAt !== null) {
    const options = {
      ...(input.locale === undefined ? {} : { locale: input.locale }),
      ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
    };
    const time = formatResetTime(resetsAt, input.now, options);
    return { kind: "usage-limit", text: `${OUT_OF_USAGE_UNTIL}${time}`, resetsAt };
  }
  const description = limited.find((window) => window.resetDescription)?.resetDescription;
  return {
    kind: "usage-limit",
    text: description ? `${OUT_OF_USAGE_UNTIL}${description}` : OUT_OF_USAGE,
    resetsAt: null,
  };
}

/** The preview warning when a hinted agent is asked for something it may not answer. */
export function hintTargetWarning(hint: OutOfTokensHint): string | null {
  if (hint.kind === "context-full") {
    return "This agent's context window is full, so it may not answer.";
  }
  return hint.text.startsWith(OUT_OF_USAGE_UNTIL)
    ? `This agent may not answer until ${hint.text.slice(OUT_OF_USAGE_UNTIL.length)}.`
    : "This agent is out of usage, so it may not answer.";
}
