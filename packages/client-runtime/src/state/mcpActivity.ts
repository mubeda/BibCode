import type { McpActiveClient, McpActivityRow, McpActivityStreamEvent } from "@bibcode/contracts";
import { MCP_ACTIVITY_RECENT_ROWS, WS_METHODS } from "@bibcode/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe } from "../rpc/client.ts";
import { createEnvironmentSubscriptionAtomFamily } from "./runtime.ts";

/** What outside agents did (newest first) and who is active now (#139, slice X1). */
export interface McpActivityState {
  readonly rows: ReadonlyArray<McpActivityRow>;
  readonly active: ReadonlyArray<McpActiveClient>;
}

export const EMPTY_MCP_ACTIVITY: McpActivityState = { rows: [], active: [] };

/** Folds one `subscribeMcpActivity` event into the state; a row replaces one with its id. */
export function applyMcpActivityEvent(
  current: McpActivityState,
  event: McpActivityStreamEvent,
): McpActivityState {
  switch (event.type) {
    case "snapshot":
      return { rows: event.rows, active: event.active };
    case "row":
      return {
        ...current,
        rows: [event.row, ...current.rows.filter((row) => row.id !== event.row.id)].slice(
          0,
          MCP_ACTIVITY_RECENT_ROWS,
        ),
      };
    case "active":
      return { ...current, active: event.active };
  }
}

function projectMcpActivity(
  current: McpActivityState,
  event: McpActivityStreamEvent,
): readonly [McpActivityState, ReadonlyArray<McpActivityState>] {
  const next = applyMcpActivityEvent(current, event);
  return [next, [next]];
}

export function createMcpActivityEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    activity: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:mcp-activity",
      subscribe: (_input: null) =>
        subscribe(WS_METHODS.subscribeMcpActivity, {}).pipe(
          Stream.mapAccum(() => EMPTY_MCP_ACTIVITY, projectMcpActivity),
        ),
    }),
  };
}
