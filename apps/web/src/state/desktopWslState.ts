import type { DesktopBridge, DesktopWslDiscovery, DesktopWslState } from "@bibcode/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import {
  desktopWslStateWithDiscovery,
  observeDesktopLocalTopology,
  refreshDesktopLocalTopology,
  type DesktopLocalTopologySnapshot,
} from "~/connection/desktopLocal";

type DesktopWslStateBridge = Pick<DesktopBridge, "getWslState" | "onWslDiscoveryChanged">;

class DesktopWslStateUnavailableError extends Schema.TaggedErrorClass<DesktopWslStateUnavailableError>()(
  "DesktopWslStateUnavailableError",
  {},
) {
  override get message(): string {
    return "Desktop WSL state is unavailable.";
  }
}

class DesktopWslStateLoadError extends Schema.TaggedErrorClass<DesktopWslStateLoadError>()(
  "DesktopWslStateLoadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to load WSL state.";
  }
}

function getDesktopWslStateBridge(): DesktopWslStateBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge;
}

export function createDesktopWslStateAtom(
  getBridge: () => DesktopWslStateBridge | undefined,
  observeTopology?: (listener: (snapshot: DesktopLocalTopologySnapshot) => void) => () => void,
) {
  type StateStreamItem =
    | { readonly _tag: "State"; readonly state: DesktopWslState }
    | {
        readonly _tag: "Failure";
        readonly error: DesktopWslStateLoadError | DesktopWslStateUnavailableError;
      };
  const stateItems =
    observeTopology === undefined
      ? Stream.callback<StateStreamItem>((queue) =>
          Effect.gen(function* () {
            const bridge = getBridge();
            if (!bridge) {
              Queue.offerUnsafe(queue, {
                _tag: "Failure",
                error: new DesktopWslStateUnavailableError(),
              });
              return yield* Effect.never;
            }

            let current: DesktopWslState | null = null;
            let pendingDiscovery: DesktopWslDiscovery | null = null;
            if (bridge.onWslDiscoveryChanged !== undefined) {
              yield* Effect.acquireRelease(
                Effect.sync(() =>
                  bridge.onWslDiscoveryChanged?.((discovery) => {
                    const currentGeneration =
                      current?.discovery.generation ?? pendingDiscovery?.generation ?? -1;
                    if (discovery.generation <= currentGeneration) return;
                    if (current === null) {
                      pendingDiscovery = discovery;
                      return;
                    }
                    current = desktopWslStateWithDiscovery(current, discovery);
                    Queue.offerUnsafe(queue, { _tag: "State", state: current });
                  }),
                ),
                (unsubscribe) => Effect.sync(() => unsubscribe?.()),
              );
            }

            const initial = yield* Effect.tryPromise({
              try: (): Promise<DesktopWslState> => bridge.getWslState(),
              catch: (cause) => new DesktopWslStateLoadError({ cause }),
            }).pipe(
              Effect.match({
                onFailure: (error) => {
                  Queue.offerUnsafe(queue, { _tag: "Failure", error });
                  return null;
                },
                onSuccess: (state) => state,
              }),
            );
            if (initial === null) return yield* Effect.never;
            current =
              pendingDiscovery === null
                ? initial
                : desktopWslStateWithDiscovery(initial, pendingDiscovery);
            pendingDiscovery = null;
            Queue.offerUnsafe(queue, { _tag: "State", state: current });
            return yield* Effect.never;
          }),
        )
      : Stream.callback<StateStreamItem>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() =>
              observeTopology((snapshot) => {
                if (snapshot.wslState !== null) {
                  Queue.offerUnsafe(queue, { _tag: "State", state: snapshot.wslState });
                } else if (snapshot.wslStateError !== null) {
                  Queue.offerUnsafe(queue, {
                    _tag: "Failure",
                    error: new DesktopWslStateLoadError({ cause: snapshot.wslStateError }),
                  });
                }
              }),
            ),
            (unsubscribe) => Effect.sync(unsubscribe),
          ),
        );
  const states = stateItems.pipe(
    Stream.mapEffect((item) =>
      item._tag === "State" ? Effect.succeed(item.state) : Effect.fail(item.error),
    ),
  );

  return Atom.make(states, { initialValue: null }).pipe(
    Atom.keepAlive,
    Atom.withLabel("desktop:wsl-state:load"),
  );
}

export const desktopWslStateAtom = createDesktopWslStateAtom(
  getDesktopWslStateBridge,
  observeDesktopLocalTopology,
);

export function refreshDesktopWslState(): void {
  void refreshDesktopLocalTopology();
}
