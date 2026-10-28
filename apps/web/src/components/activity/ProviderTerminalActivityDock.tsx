import type {
  ActivityScopeRef,
  ActivitySnapshot,
  ProviderTerminalActivityLaunch,
  ScopedThreadRef,
} from "@bibcode/contracts";
import { useCallback, useMemo } from "react";

import { ActivityPane } from "./ActivityPane";

export interface ProviderTerminalActivityDockProps {
  /** The host thread that owns the terminal pane. */
  readonly threadRef: ScopedThreadRef;
  readonly terminalId: string;
  readonly activity: ProviderTerminalActivityLaunch | undefined;
  readonly visible: boolean;
  readonly compact: boolean;
  /** The terminal pane, whose height bounds the expanded panel. */
  readonly paneElement: HTMLElement | null;
}

interface EligibleProviderTerminalActivityDockProps extends Omit<
  ProviderTerminalActivityDockProps,
  "activity" | "visible"
> {}

function EligibleProviderTerminalActivityDock({
  threadRef,
  terminalId,
  compact,
  paneElement,
}: EligibleProviderTerminalActivityDockProps) {
  const scope = useMemo<ActivityScopeRef>(
    () => ({
      _tag: "terminal",
      threadId: threadRef.threadId,
      terminalId,
    }),
    [terminalId, threadRef.threadId],
  );
  const target = useMemo(
    () => ({
      environmentId: threadRef.environmentId,
      input: scope,
    }),
    [scope, threadRef.environmentId],
  );
  // The card appears only once the server proves it observes this terminal,
  // and then in the pane's saved open or closed state.
  const acceptSnapshot = useCallback(
    (snapshot: ActivitySnapshot) =>
      snapshot.scope._tag === "terminal" &&
      snapshot.scope.threadId === threadRef.threadId &&
      snapshot.scope.terminalId === terminalId &&
      snapshot.capabilities.terminalObservation,
    [terminalId, threadRef.threadId],
  );

  return (
    <ActivityPane
      acceptSnapshot={acceptSnapshot}
      alwaysVisible={false}
      compact={compact}
      paneElement={paneElement}
      paneId={`terminal:${terminalId}`}
      paneOwnerRef={threadRef}
      target={target}
    />
  );
}

export function ProviderTerminalActivityDock(props: ProviderTerminalActivityDockProps) {
  if (!props.visible || props.activity === undefined) {
    return null;
  }
  return (
    <EligibleProviderTerminalActivityDock
      threadRef={props.threadRef}
      terminalId={props.terminalId}
      compact={props.compact}
      paneElement={props.paneElement}
    />
  );
}
