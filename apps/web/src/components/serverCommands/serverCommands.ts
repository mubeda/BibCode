import type { ContextMenuItem, EnvironmentId } from "@bibcode/contracts";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { useSidebar } from "~/components/ui/sidebar";
import type { EnvironmentPresentation } from "~/state/environments";

/** The two per-server commands every server entry point offers, in menu order. */
export const SERVER_COMMANDS = [
  { id: "terminal", label: "Open terminal" },
  { id: "dashboard", label: "Dashboard" },
] as const;

export type ServerCommand = (typeof SERVER_COMMANDS)[number]["id"];

export interface ServerCommandTarget {
  readonly label: string;
  readonly connected: boolean;
}

/** Both commands need a live connection; the reason is shown where the command is offered. */
export function serverCommandUnavailableReason(target: ServerCommandTarget): string | null {
  return target.connected ? null : `${target.label} is not connected.`;
}

export function serverCommandAccessibleName(command: ServerCommand, label: string): string {
  return command === "terminal" ? `Open terminal on ${label}` : `Dashboard for ${label}`;
}

export function serverCommandMenuItems(
  target: ServerCommandTarget,
): ContextMenuItem<ServerCommand>[] {
  const reason = serverCommandUnavailableReason(target);
  return SERVER_COMMANDS.map((command) =>
    reason === null
      ? { id: command.id, label: command.label }
      : { id: command.id, label: command.label, disabled: true, description: reason },
  );
}

/** This device is "Local" wherever a server is named, as on the Repositories card. */
export function serverDisplayLabel(environment: EnvironmentPresentation): string {
  return environment.entry.target._tag === "PrimaryConnectionTarget" ? "Local" : environment.label;
}

export function serverCommandTarget(environment: EnvironmentPresentation): ServerCommandTarget {
  return {
    label: serverDisplayLabel(environment),
    connected: environment.connection.phase === "connected",
  };
}

export interface ServerTerminalSearch {
  /** One value per Open terminal: a new one opens the session again and focuses it. */
  readonly open?: number;
}

export function validateServerTerminalSearch(
  search: Record<string, unknown>,
): ServerTerminalSearch {
  return typeof search.open === "number" && Number.isSafeInteger(search.open)
    ? { open: search.open }
    : {};
}

let lastInvocation = 0;
/** Grows with every invocation, also across reloads, so no two runs share a value. */
function nextInvocation(): number {
  lastInvocation = Math.max(Date.now(), lastInvocation + 1);
  return lastInvocation;
}

/**
 * Opens the server's center panel. Each panel is a route per environment, so a second run
 * shows the panel (and the terminal session) that is already open. Open terminal on the
 * terminal already shown replaces its history entry, so Back (which an exit takes) leaves
 * the terminal instead of reopening it. On a phone the modal sidebar closes so the panel is
 * visible.
 */
export function useRunServerCommand(): (
  command: ServerCommand,
  environmentId: EnvironmentId,
) => void {
  const navigate = useNavigate();
  // Read when a command runs, so the entry points do not render on every navigation.
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  return useCallback(
    (command: ServerCommand, environmentId: EnvironmentId) => {
      if (isMobile) setOpenMobile(false);
      if (command === "dashboard") {
        void navigate({ to: "/environment/$environmentId/dashboard", params: { environmentId } });
        return;
      }
      const terminal = {
        to: "/environment/$environmentId/terminal",
        params: { environmentId },
      } as const;
      const refocus = router.buildLocation(terminal).pathname === router.state.location.pathname;
      void navigate({
        ...terminal,
        search: { open: nextInvocation() },
        ...(refocus ? { replace: true } : {}),
      });
    },
    [isMobile, navigate, router, setOpenMobile],
  );
}
