import { useAtomValue } from "@effect/atom-react";
import { offShellThreads } from "@bibcode/client-runtime/state/off-shell-threads";
import type { OrchestrationOlderThreadsScope } from "@bibcode/contracts";
import { LoaderIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { loadOlderThreads, olderPageKey, useOffShellThreadShells } from "../../state/offShell";
import { cappedShellEnvironmentsAtom } from "../../state/shell";

const AGENTS_SCOPE: OrchestrationOlderThreadsScope = { kind: "agents" };
const AGENTS_PAGE_KEY = olderPageKey(AGENTS_SCOPE);

/**
 * The end of the Done group when a capped shell left finished agents out (#223): pages them in,
 * chat panels included, from every live environment.
 */
export function AgentsShowOlder() {
  // Re-render as pages land; the rows themselves come from `useAgentRows`.
  useOffShellThreadShells();
  const [phase, setPhase] = useState<"idle" | "loading" | "error">("idle");
  const capped = useAtomValue(cappedShellEnvironmentsAtom);
  const remaining = capped.filter(
    ({ environmentId }) =>
      offShellThreads.get(environmentId).pages.get(AGENTS_PAGE_KEY)?.cursor !== null,
  );
  const load = useCallback(async () => {
    setPhase("loading");
    const outcomes = await Promise.all(
      remaining
        .filter(({ live }) => live)
        .map(({ environmentId }) =>
          loadOlderThreads(environmentId, AGENTS_SCOPE, {
            append: offShellThreads.get(environmentId).pages.has(AGENTS_PAGE_KEY),
          }),
        ),
    );
    setPhase(outcomes.includes("failed") ? "error" : "idle");
  }, [remaining]);

  if (remaining.length === 0) return null;
  const anyLive = remaining.some(({ live }) => live);
  if (phase === "loading") {
    return (
      <div
        role="status"
        className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground"
      >
        <LoaderIcon className="size-3 animate-spin" aria-hidden />
        Loading older agents…
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
      {phase === "error" ? <span role="status">Couldn&apos;t load older agents.</span> : null}
      <button
        type="button"
        className="underline underline-offset-2 hover:text-foreground disabled:no-underline disabled:opacity-60"
        disabled={!anyLive}
        {...(anyLive ? {} : { "aria-description": "Reconnect to load older agents." })}
        onClick={() => void load()}
      >
        {phase === "error" ? "Retry" : anyLive ? "Show older" : "Show older: reconnect to load"}
      </button>
    </div>
  );
}
