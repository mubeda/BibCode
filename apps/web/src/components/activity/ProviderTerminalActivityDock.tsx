import { useAtomValue } from "@effect/atom-react";
import {
  EMPTY_ENVIRONMENT_ACTIVITY_STATE,
  type EnvironmentActivityState,
} from "@bibcode/client-runtime/state/activity";
import type {
  ActivityScopeRef,
  ActivitySection,
  ProviderTerminalActivityLaunch,
  ScopedThreadRef,
} from "@bibcode/contracts";
import { useCallback, useMemo } from "react";

import { useRightPanelStore } from "~/rightPanelStore";
import { environmentActivity } from "~/state/activity";

import { ActivityDock } from "./ActivityDock";
import { activitySnapshotForState, selectActivityDockVisibility } from "./activityPresentation";

export interface ProviderTerminalActivityDockProps {
  readonly threadRef: ScopedThreadRef;
  readonly terminalId: string;
  readonly activity: ProviderTerminalActivityLaunch | undefined;
  readonly visible: boolean;
  readonly compact: boolean;
}

interface EligibleProviderTerminalActivityDockProps extends Omit<
  ProviderTerminalActivityDockProps,
  "activity" | "visible"
> {}

function EligibleProviderTerminalActivityDock({
  threadRef,
  terminalId,
  compact,
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
  const stateValueAtom = useMemo(() => environmentActivity.stateValueAtom(target), [target]);
  const activityState =
    useAtomValue(stateValueAtom) ?? (EMPTY_ENVIRONMENT_ACTIVITY_STATE as EnvironmentActivityState);
  const snapshot = useMemo(() => activitySnapshotForState(activityState), [activityState]);
  const onOpenSection = useCallback(
    (section: ActivitySection) =>
      useRightPanelStore
        .getState()
        .openActivity(threadRef, section, { _tag: "terminal", terminalId }),
    [terminalId, threadRef],
  );

  if (
    snapshot === null ||
    snapshot.scope._tag !== "terminal" ||
    snapshot.scope.threadId !== threadRef.threadId ||
    snapshot.scope.terminalId !== terminalId ||
    !snapshot.capabilities.terminalObservation ||
    !selectActivityDockVisibility(snapshot).visible
  ) {
    return null;
  }

  return <ActivityDock snapshot={snapshot} compact={compact} onOpenSection={onOpenSection} />;
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
    />
  );
}
