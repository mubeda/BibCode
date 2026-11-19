import { scopeThreadRef } from "@bibcode/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@bibcode/client-runtime/state/runtime";
import { type EnvironmentId, TerminalInputError, ThreadId } from "@bibcode/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useCanGoBack, useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useEffect, useEffectEvent, useMemo, useState } from "react";

import type { CenterSurface } from "~/centerPanelStore";
import { useEnvironment } from "~/state/environments";
import { filesystemEnvironment } from "~/state/filesystem";
import { useEnvironmentQuery } from "~/state/query";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { terminalEnvironment } from "~/state/terminal";
import { useAtomCommand } from "~/state/use-atom-command";

import { CenterTerminalPanel } from "../CenterTerminalPanel";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { ServerPanelFrame } from "./ServerPanelFrame";
import { serverCommandTarget, serverCommandUnavailableReason } from "./serverCommands";

/**
 * The server terminal's session key. No thread owns it: the server refuses to create a thread
 * with this id, so each server has one session no thread terminal can hold.
 */
export const SERVER_TERMINAL_THREAD_ID = ThreadId.make("server-terminal");
export const SERVER_TERMINAL_ID = "server-terminal";

const SERVER_TERMINAL_SURFACE: Extract<CenterSurface, { kind: "terminal" }> = {
  id: `terminal:${SERVER_TERMINAL_ID}`,
  kind: "terminal",
  terminalId: SERVER_TERMINAL_ID,
  label: "Terminal",
};

const NO_RUNTIME_ENV: Record<string, string> = {};
const noop = () => undefined;

function PanelMessage({ children }: { readonly children: React.ReactNode }) {
  return (
    <div
      role="status"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

const isTerminalInputError = Schema.is(TerminalInputError);

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : "The server did not start the terminal.";
}

/**
 * A terminal on the server itself, started in that server user's home folder. Each
 * `invocation` (one per Open terminal) runs `terminal.open`, which reuses a running shell
 * and replaces an exited one, then focuses the terminal. A failure says why in a toast and
 * returns to the previous view. docs/plans/2026-11-18-server-commands-design.md has the lifecycle.
 */
export function ServerTerminalPanel({
  environmentId,
  invocation,
}: {
  readonly environmentId: EnvironmentId;
  readonly invocation: number | undefined;
}) {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const environment = useEnvironment(environmentId);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const target = environment === null ? null : serverCommandTarget(environment);
  const unavailableReason = target === null ? null : serverCommandUnavailableReason(target);
  const label = target?.label ?? "This server";
  // `~` is resolved by the server that owns the home: terminal.open does not expand it.
  const home = useEnvironmentQuery(
    target?.connected === true
      ? filesystemEnvironment.browse({
          environmentId,
          input: { partialPath: "~", mode: "directory" },
        })
      : null,
  );
  // Latched: a refetch or a reconnect must not move or restart a running terminal.
  const [homePath, setHomePath] = useState<string | null>(null);
  const resolvedHome = home.data?.directoryPath ?? null;
  if (homePath === null && resolvedHome !== null) setHomePath(resolvedHome);
  // An older server answers browse without `directoryPath`.
  const homeError =
    homePath !== null
      ? null
      : (home.error ??
        (home.data !== null && resolvedHome === null
          ? "This server does not report its home folder. Update it to open a terminal here."
          : null));

  const leave = () => {
    if (canGoBack) window.history.back();
    else void navigate({ to: "/", replace: true });
  };
  const fail = useEffectEvent((reason: string) => {
    toastManager.add({ type: "error", title: "Could not open terminal", description: reason });
    leave();
  });
  useEffect(() => {
    if (homeError !== null) fail(`The home folder of ${label} could not be read. ${homeError}`);
  }, [homeError, label]);

  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, SERVER_TERMINAL_THREAD_ID),
    [environmentId],
  );
  const launchContext = useMemo(
    () =>
      homePath === null ? null : { cwd: homePath, worktreePath: null, runtimeEnv: NO_RUNTIME_ENV },
    [homePath],
  );

  const openTerminal = useAtomCommand(terminalEnvironment.open, { reportFailure: false });
  // The invocation that last opened: the terminal mounts after the first and is focused by each.
  const [focusRequestId, setFocusRequestId] = useState<number | null>(null);
  const settleOpen = useEffectEvent(
    (result: Awaited<ReturnType<typeof openTerminal>>, opened: number) => {
      if (result._tag === "Success") {
        setFocusRequestId(opened);
        return;
      }
      if (isAtomCommandInterrupted(result)) {
        fail(
          `The connection to ${label} was lost while the terminal was opening. Open it again once the server reconnects.`,
        );
        return;
      }
      const error = squashAtomCommandFailure(result);
      // Only input setup fails with this error, after the shell started: the terminal
      // attaches, prepares its input again, and shows a failure inside it.
      if (isTerminalInputError(error)) setFocusRequestId(opened);
      else fail(failureReason(error));
    },
  );
  useEffect(() => {
    if (homePath === null) return;
    let current = true;
    void openTerminal({
      environmentId,
      input: {
        threadId: SERVER_TERMINAL_THREAD_ID,
        terminalId: SERVER_TERMINAL_ID,
        cwd: homePath,
        worktreePath: null,
        env: NO_RUNTIME_ENV,
        centerPanel: true,
      },
    }).then((result) => {
      if (current) settleOpen(result, invocation ?? 1);
    });
    return () => {
      current = false;
    };
  }, [environmentId, homePath, invocation, openTerminal]);

  let body: React.ReactNode;
  if (launchContext !== null && focusRequestId !== null) {
    body = (
      <CenterTerminalPanel
        threadRef={threadRef}
        surface={SERVER_TERMINAL_SURFACE}
        launchContext={launchContext}
        keybindings={keybindings}
        focusRequestId={focusRequestId}
        focusEligible
        chatThread={false}
        // Only terminal.open starts or replaces the shell; the exit only leaves (no close).
        attachOnly
        onAddTerminalContext={noop}
        onClose={leave}
      />
    );
  } else if (unavailableReason !== null && launchContext === null) {
    body = (
      <PanelMessage>
        <p>{unavailableReason} Connect it to open a terminal.</p>
        <Button
          size="xs"
          variant="outline"
          onClick={() => void navigate({ to: "/settings/remote-servers" })}
        >
          Open Remote Servers
        </Button>
      </PanelMessage>
    );
  } else {
    body = (
      <PanelMessage>
        <Spinner />
        <span>Opening terminal…</span>
      </PanelMessage>
    );
  }

  return (
    <ServerPanelFrame environmentId={environmentId} title="Terminal" testId="server-terminal-panel">
      <div className="flex min-h-0 flex-1 flex-col">{body}</div>
    </ServerPanelFrame>
  );
}
