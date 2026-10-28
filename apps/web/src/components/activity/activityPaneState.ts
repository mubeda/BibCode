/**
 * The persisted per-pane Activity state: whether a chat or terminal pane's
 * inline Activity panel is expanded, and which section and record it shows.
 * The center-panel store owns persistence; this module owns the shape.
 */
import { ACTIVITY_ID_MAX_LENGTH } from "@bibcode/contracts";

export type ActivityPaneSection = "subagents" | "backgroundTasks";
export type ActivityPaneRecordKind = "actor" | "workItem";

export interface ActivityPaneRoute {
  readonly section: ActivityPaneSection;
  readonly selectedRecordKind: ActivityPaneRecordKind | null;
  readonly selectedRecordId: string | null;
}

export interface ActivityPaneState extends ActivityPaneRoute {
  readonly expanded: boolean;
}

export const DEFAULT_ACTIVITY_PANE_STATE: ActivityPaneState = {
  expanded: false,
  section: "subagents",
  selectedRecordKind: null,
  selectedRecordId: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isBoundedActivityId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= ACTIVITY_ID_MAX_LENGTH &&
    value.trim() === value
  );
}

export function normalizeActivitySection(value: unknown): ActivityPaneSection {
  return value === "backgroundTasks" ? "backgroundTasks" : "subagents";
}

/** A record belongs to one section: actors to Subagents, work items to Background tasks. */
export function normalizeActivitySelection(
  section: ActivityPaneSection,
  kind: unknown,
  id: unknown,
): Pick<ActivityPaneRoute, "selectedRecordKind" | "selectedRecordId"> {
  const kindMatchesSection =
    (section === "subagents" && kind === "actor") ||
    (section === "backgroundTasks" && kind === "workItem");
  if (kindMatchesSection && isBoundedActivityId(id)) {
    return { selectedRecordKind: kind, selectedRecordId: id };
  }
  return { selectedRecordKind: null, selectedRecordId: null };
}

export function normalizeActivityPaneRoute(value: unknown): ActivityPaneRoute {
  const record = isRecord(value) ? value : {};
  const section = normalizeActivitySection(record.section);
  return {
    section,
    ...normalizeActivitySelection(section, record.selectedRecordKind, record.selectedRecordId),
  };
}

export function normalizeActivityPaneState(value: unknown): ActivityPaneState | null {
  if (!isRecord(value)) return null;
  return { expanded: value.expanded === true, ...normalizeActivityPaneRoute(value) };
}

export function isDefaultActivityPaneState(state: ActivityPaneState): boolean {
  return (
    !state.expanded &&
    state.section === DEFAULT_ACTIVITY_PANE_STATE.section &&
    state.selectedRecordKind === null &&
    state.selectedRecordId === null
  );
}

export function activityPaneStatesEqual(
  left: ActivityPaneState,
  right: ActivityPaneState,
): boolean {
  return (
    left.expanded === right.expanded &&
    left.section === right.section &&
    left.selectedRecordKind === right.selectedRecordKind &&
    left.selectedRecordId === right.selectedRecordId
  );
}
