import { useAtomValue } from "@effect/atom-react";
import {
  EMPTY_ENVIRONMENT_ACTIVITY_STATE,
  type EnvironmentActivityState,
} from "@bibcode/client-runtime/state/activity";
import type { ActivitySection, ActivitySnapshot, ScopedThreadRef } from "@bibcode/contracts";
import {
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { selectActivityPaneState, useCenterPanelStore } from "~/centerPanelStore";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { environmentActivity } from "~/state/activity";

import { ActivityDock } from "./ActivityDock";
import { ActivityPanelBinding, type ActivityStateTarget } from "./ActivityPaneBinding";
import type { ActivityPaneRoute } from "./activityPaneState";
import { activitySnapshotForState, selectActivityDockVisibility } from "./activityPresentation";

/** The expanded body never takes more than this much of its pane, nor more than 22rem. */
const ACTIVITY_PANE_BODY_MAX_SHARE = 0.45;
const ACTIVITY_PANE_BODY_MAX_REM = 22;

export interface ActivityPaneProps {
  /** The Activity scope this pane shows. */
  readonly target: ActivityStateTarget;
  /** The host thread whose center layout owns this pane. */
  readonly paneOwnerRef: ScopedThreadRef;
  /** The pane's center surface id: `chat:host`, `chat:<threadId>`, or `terminal:<terminalId>`. */
  readonly paneId: string;
  readonly compact: boolean;
  /** Show the header before any record exists, for sections the provider reports. */
  readonly alwaysVisible: boolean;
  /** The pane element whose height bounds the expanded body. */
  readonly paneElement: HTMLElement | null;
  /** Rejects a snapshot this pane must not show, such as another terminal's scope. */
  readonly acceptSnapshot?: (snapshot: ActivitySnapshot) => boolean;
}

function usePaneHeight(element: HTMLElement | null): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    if (element === null) return;
    const measure = () => {
      const next = Math.round(element.getBoundingClientRect().height);
      setHeight((current) => (current === next ? current : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return element === null ? null : height;
}

/** The open panel's content; only an open panel reads its queries and time format. */
function ActivityPaneBody(
  props: Omit<ComponentProps<typeof ActivityPanelBinding>, "timestampFormat">,
) {
  const timestampFormat = useEnvironmentSettings(
    props.target.environmentId,
    (settings) => settings.timestampFormat,
  );
  return <ActivityPanelBinding {...props} timestampFormat={timestampFormat} />;
}

/**
 * A pane's inline Activity: the summary button, and above it the collapsible
 * panel it discloses. It sits in the pane's own layout (above the composer, or
 * below a terminal), so collapsing it gives the pane its space back.
 *
 * The expanded state and route come from the pane's persisted state on the
 * first render, so a reload restores them without an arriving record or any
 * effect deciding it, and without taking focus.
 */
export function ActivityPane({
  target,
  paneOwnerRef,
  paneId,
  compact,
  alwaysVisible,
  paneElement,
  acceptSnapshot,
}: ActivityPaneProps) {
  const bodyId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const stateValueAtom = useMemo(() => environmentActivity.stateValueAtom(target), [target]);
  const activityState =
    useAtomValue(stateValueAtom) ?? (EMPTY_ENVIRONMENT_ACTIVITY_STATE as EnvironmentActivityState);
  const rawSnapshot = useMemo(() => activitySnapshotForState(activityState), [activityState]);
  const snapshot =
    rawSnapshot !== null && (acceptSnapshot === undefined || acceptSnapshot(rawSnapshot))
      ? rawSnapshot
      : null;
  const paneState = useCenterPanelStore((state) =>
    selectActivityPaneState(state.activityPanes, paneOwnerRef, paneId),
  );
  const [focusRequested, setFocusRequested] = useState(false);
  // Only an open panel needs its pane's height, so a closed one observes nothing.
  const paneHeight = usePaneHeight(paneState.expanded ? paneElement : null);

  // The card follows the rule for when the Activity button appears; the saved
  // open or closed state applies from the render in which it first appears.
  const shown =
    snapshot !== null && selectActivityDockVisibility(snapshot, { alwaysVisible }).visible;

  const onToggle = useCallback(
    (section: ActivitySection) => {
      const store = useCenterPanelStore.getState();
      if (paneState.expanded) {
        store.setActivityPaneExpanded(paneOwnerRef, paneId, false);
        return;
      }
      store.setActivityPaneExpanded(paneOwnerRef, paneId, true, section);
      setFocusRequested(true);
    },
    [paneId, paneOwnerRef, paneState.expanded],
  );
  const onNavigate = useCallback(
    (route: ActivityPaneRoute) =>
      useCenterPanelStore.getState().navigateActivityPane(paneOwnerRef, paneId, route),
    [paneId, paneOwnerRef],
  );
  const onFocusRequestHandled = useCallback(() => setFocusRequested(false), []);
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Escape" || event.defaultPrevented || !paneState.expanded) return;
      const body = cardRef.current?.querySelector(`[id="${CSS.escape(bodyId)}"]`);
      if (!(event.target instanceof Node) || !body?.contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      useCenterPanelStore.getState().setActivityPaneExpanded(paneOwnerRef, paneId, false);
      cardRef.current
        ?.querySelector<HTMLButtonElement>('[data-testid="activity-dock"] button')
        ?.focus();
    },
    [bodyId, paneId, paneOwnerRef, paneState.expanded],
  );

  if (!shown || snapshot === null) {
    return null;
  }
  const route: ActivityPaneRoute = {
    section: paneState.section,
    selectedRecordKind: paneState.selectedRecordKind,
    selectedRecordId: paneState.selectedRecordId,
  };
  const bodyHeight =
    paneHeight === null
      ? `${ACTIVITY_PANE_BODY_MAX_REM}rem`
      : `min(${ACTIVITY_PANE_BODY_MAX_REM}rem, ${Math.floor(paneHeight * ACTIVITY_PANE_BODY_MAX_SHARE)}px)`;
  const expanded = paneState.expanded;

  return (
    <div
      className="pointer-events-auto flex flex-col gap-1.5"
      data-activity-pane={paneId}
      data-activity-pane-expanded={expanded ? "true" : "false"}
      onKeyDown={onKeyDown}
      ref={cardRef}
    >
      {expanded ? (
        <div
          className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-background shadow-sm"
          data-text-surface="background"
          id={bodyId}
          style={{ height: bodyHeight }}
        >
          <ActivityPaneBody
            focusRequested={focusRequested}
            onFocusRequestHandled={onFocusRequestHandled}
            onNavigate={onNavigate}
            route={route}
            target={target}
          />
        </div>
      ) : null}
      <ActivityDock
        alwaysVisible={alwaysVisible}
        compact={compact}
        {...(expanded ? { controlsId: bodyId } : {})}
        expanded={expanded}
        onToggle={onToggle}
        snapshot={snapshot}
      />
    </div>
  );
}
