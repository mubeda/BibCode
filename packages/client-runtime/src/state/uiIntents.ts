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
 * A pending intent and its `deadline` on this client's clock: the moment it arrived plus the
 * time the server said it had left (`expiresInMs`), so a client clock that is off never drops
 * a fresh intent or keeps a stale one.
 */
export type PendingUiIntent = UiIntent & { readonly deadline: number };

/**
 * An outside agent's UI suggestions still pending, oldest first (#139, slices X4 and X7): the
 * newest 64 `focus` intents, and the last `commitMessage` intent of up to 64 folders.
 */
export type UiIntentsState = ReadonlyArray<PendingUiIntent>;

export const EMPTY_UI_INTENTS: UiIntentsState = [];

/** Whether `intent` is still pending at `now` on this client's clock. */
export function isUiIntentPending(intent: PendingUiIntent, now: number): boolean {
  return intent.deadline > now;
}

/**
 * Whether commit message `candidate`, which arrived after `kept`, replaces it. Within one
 * server boot the higher sequence wins. A message from another boot is newer, whatever its
 * sequence: the server's store does not survive a restart, and a clock set back across one can
 * issue a lower sequence. One server serves one environment, so boots never interleave.
 */
export function replacesCommitMessage(
  kept: UiIntent & { kind: "commitMessage" },
  candidate: UiIntent & { kind: "commitMessage" },
): boolean {
  return candidate.bootId !== kept.bootId || candidate.sequence > kept.sequence;
}

/**
 * Drops expired intents and caps each kind on its own, so a flood of `focus` intents never
 * pushes out a folder's commit message. `pending` is in the order intents arrived. A folder
 * keeps only its newest commit message, so a live event that arrives after a newer snapshot
 * never wins.
 */
function bound(intents: UiIntentsState, now: number): UiIntentsState {
  const pending = intents.filter((intent) => isUiIntentPending(intent, now));
  const newestPerFolder = new Map<string, PendingUiIntent & { kind: "commitMessage" }>();
  for (const intent of pending) {
    if (intent.kind !== "commitMessage") continue;
    const kept = newestPerFolder.get(intent.cwd);
    if (kept === undefined || replacesCommitMessage(kept, intent)) {
      newestPerFolder.set(intent.cwd, intent);
    }
  }
  const focus = pending.filter((intent) => intent.kind === "focus");
  const messages = pending.filter(
    (intent) => intent.kind === "commitMessage" && newestPerFolder.get(intent.cwd) === intent,
  );
  const kept = new Set<PendingUiIntent>([
    ...focus.slice(-MOST_UI_INTENTS),
    ...messages.slice(-MOST_UI_INTENTS),
  ]);
  return pending.filter((intent) => kept.has(intent));
}

/** `intent` with its deadline on this client's clock, arriving at `now`. */
function arrived(intent: UiIntent, now: number): PendingUiIntent {
  return { ...intent, deadline: now + intent.expiresInMs };
}

/**
 * Folds one `subscribeUiIntents` event, arriving at `now` on this client's clock, into the
 * pending intents; an id is kept once, and intents past their deadline are dropped.
 */
export function applyUiIntentEvent(
  current: UiIntentsState,
  event: UiIntentStreamEvent,
  now: number,
): UiIntentsState {
  switch (event.type) {
    case "snapshot":
      return bound(
        event.intents.map((intent) => arrived(intent, now)),
        now,
      );
    case "intent":
      return current.some((intent) => intent.intentId === event.intent.intentId)
        ? current
        : bound([...current, arrived(event.intent, now)], now);
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
