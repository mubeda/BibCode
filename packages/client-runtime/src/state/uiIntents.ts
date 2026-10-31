import type { UiIntent, UiIntentStreamEvent } from "@bibcode/contracts";
import { WS_METHODS } from "@bibcode/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe } from "../rpc/client.ts";
import { createEnvironmentSubscriptionAtomFamily } from "./runtime.ts";

/**
 * The most intents kept of each kind: 16 `focus` intents per thread for 60 seconds keeps the
 * real number far below, and the server keeps one `commitMessage` intent per folder.
 */
const MOST_UI_INTENTS = 64;

/**
 * An outside agent's UI suggestions still pending, oldest first (#139, slices X4 and X7): the
 * newest 64 `focus` intents, and the last `commitMessage` intent of up to 64 folders.
 */
export type UiIntentsState = ReadonlyArray<UiIntent>;

export const EMPTY_UI_INTENTS: UiIntentsState = [];

/**
 * Caps each kind on its own, so a flood of `focus` intents never pushes out a folder's commit
 * message, and keeps only a folder's newest commit message.
 */
function bound(intents: ReadonlyArray<UiIntent>): UiIntentsState {
  const latestPerFolder = new Map<string, string>();
  for (const intent of intents) {
    if (intent.kind === "commitMessage") latestPerFolder.set(intent.cwd, intent.intentId);
  }
  const focus = intents.filter((intent) => intent.kind === "focus");
  const messages = intents.filter(
    (intent) =>
      intent.kind === "commitMessage" && latestPerFolder.get(intent.cwd) === intent.intentId,
  );
  const kept = new Set<UiIntent>([
    ...focus.slice(-MOST_UI_INTENTS),
    ...messages.slice(-MOST_UI_INTENTS),
  ]);
  return intents.filter((intent) => kept.has(intent));
}

/** Folds one `subscribeUiIntents` event into the pending intents; an id is kept once. */
export function applyUiIntentEvent(
  current: UiIntentsState,
  event: UiIntentStreamEvent,
): UiIntentsState {
  switch (event.type) {
    case "snapshot":
      return bound(event.intents);
    case "intent":
      return current.some((intent) => intent.intentId === event.intent.intentId)
        ? current
        : bound([...current, event.intent]);
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
