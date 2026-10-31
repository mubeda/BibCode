import type { UiIntent, UiIntentStreamEvent } from "@bibcode/contracts";
import { WS_METHODS } from "@bibcode/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe } from "../rpc/client.ts";
import { createEnvironmentSubscriptionAtomFamily } from "./runtime.ts";

/** The most intents kept: 16 per thread for 60 seconds keeps the real number far below. */
const MOST_UI_INTENTS = 64;

/** An outside agent's UI suggestions still pending, oldest first (#139, slice X4). */
export type UiIntentsState = ReadonlyArray<UiIntent>;

export const EMPTY_UI_INTENTS: UiIntentsState = [];

/** Folds one `subscribeUiIntents` event into the pending intents; an id is kept once. */
export function applyUiIntentEvent(
  current: UiIntentsState,
  event: UiIntentStreamEvent,
): UiIntentsState {
  switch (event.type) {
    case "snapshot":
      return event.intents.slice(-MOST_UI_INTENTS);
    case "intent":
      return current.some((intent) => intent.intentId === event.intent.intentId)
        ? current
        : [...current, event.intent].slice(-MOST_UI_INTENTS);
  }
}

function projectUiIntents(
  current: UiIntentsState,
  event: UiIntentStreamEvent,
): readonly [UiIntentsState, ReadonlyArray<UiIntentsState>] {
  const next = applyUiIntentEvent(current, event);
  return [next, [next]];
}

export function createUiIntentsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    intents: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:ui:intents",
      subscribe: (_input: null) =>
        subscribe(WS_METHODS.subscribeUiIntents, {}).pipe(
          Stream.mapAccum(() => EMPTY_UI_INTENTS, projectUiIntents),
        ),
    }),
  };
}
