import type { UiIntent, UiIntentStreamEvent } from "@bibcode/contracts";
import { WS_METHODS } from "@bibcode/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
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

/** Whether `intent` is still pending at `now` (milliseconds since the epoch). */
export function isUiIntentPending(intent: UiIntent, now: number): boolean {
  return Date.parse(intent.expiresAt) > now;
}

/**
 * Drops expired intents and caps each kind on its own, so a flood of `focus` intents never
 * pushes out a folder's commit message. A folder keeps only its commit message with the
 * highest `sequence`, so a live event that arrives after a newer snapshot never wins.
 */
function bound(intents: ReadonlyArray<UiIntent>, now: number): UiIntentsState {
  const pending = intents.filter((intent) => isUiIntentPending(intent, now));
  const newestPerFolder = new Map<string, UiIntent & { kind: "commitMessage" }>();
  for (const intent of pending) {
    if (intent.kind !== "commitMessage") continue;
    const kept = newestPerFolder.get(intent.cwd);
    if (kept === undefined || intent.sequence > kept.sequence) {
      newestPerFolder.set(intent.cwd, intent);
    }
  }
  const focus = pending.filter((intent) => intent.kind === "focus");
  const messages = [...newestPerFolder.values()].toSorted(
    (left, right) => left.sequence - right.sequence,
  );
  const kept = new Set<UiIntent>([
    ...focus.slice(-MOST_UI_INTENTS),
    ...messages.slice(-MOST_UI_INTENTS),
  ]);
  return pending.filter((intent) => kept.has(intent));
}

/**
 * Folds one `subscribeUiIntents` event into the pending intents at `now`; an id is kept once,
 * and intents that expired are dropped.
 */
export function applyUiIntentEvent(
  current: UiIntentsState,
  event: UiIntentStreamEvent,
  now: number,
): UiIntentsState {
  switch (event.type) {
    case "snapshot":
      return bound(event.intents, now);
    case "intent":
      return current.some((intent) => intent.intentId === event.intent.intentId)
        ? current
        : bound([...current, event.intent], now);
  }
}

function projectUiIntents(
  current: UiIntentsState,
  [event, now]: readonly [UiIntentStreamEvent, number],
): readonly [UiIntentsState, ReadonlyArray<UiIntentsState>] {
  const next = applyUiIntentEvent(current, event, now);
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
          // Each event is folded at the time it arrived, so expired intents drop out.
          Stream.mapEffect((event) =>
            Effect.map(Clock.currentTimeMillis, (now) => [event, now] as const),
          ),
          Stream.mapAccum(() => EMPTY_UI_INTENTS, projectUiIntents),
        ),
    }),
  };
}
