import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { deliverEachPreviewEvent, previewAutomationHostFocusConcurrencyKey } from "./preview.ts";

describe("preview state commands", () => {
  it("keeps focus updates from replacement host connections independent", () => {
    const first = previewAutomationHostFocusConcurrencyKey({
      environmentId: "environment-1",
      input: { clientId: "client-1", connectionId: "connection-1" },
    });
    const replacement = previewAutomationHostFocusConcurrencyKey({
      environmentId: "environment-1",
      input: { clientId: "client-1", connectionId: "connection-2" },
    });

    expect(first).not.toBe(replacement);
  });
});

describe("preview events", () => {
  it("delivers every event of a batch, not only the last", async () => {
    // An open request followed by a navigation in one batch must both reach subscribers.
    const registry = AtomRegistry.make();
    const seen: string[] = [];
    // One chunk of two events, arriving after the subscriber is attached (as RPC events do).
    const batch = Stream.fromEffect(Effect.sleep("1 millis")).pipe(
      Stream.flatMap(() => Stream.make("openRequested", "navigated")),
    );
    const atom = Atom.make(deliverEachPreviewEvent(batch));
    const unsubscribe = registry.subscribe(
      atom,
      (result) => {
        if (AsyncResult.isSuccess(result)) seen.push(result.value);
      },
      { immediate: true },
    );
    await vi.waitFor(() => expect(seen).toContain("navigated"));
    expect(seen).toContain("openRequested");
    unsubscribe();
  });
});
