import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

/**
 * Runs an older-history load (#226) from the UI. Its outcome shows in the thread's state, so a
 * failure is not rethrown; the returned function cancels a load still running.
 */
export function runOlderHistoryLoad<E>(load: Effect.Effect<void, E>): () => void {
  const fiber = Effect.runFork(Effect.ignore(load));
  return () => {
    Effect.runFork(Fiber.interrupt(fiber));
  };
}
