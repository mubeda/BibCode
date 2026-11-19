import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentCatalogState } from "@bibcode/client-runtime/state/connections";
import type { Atom } from "effect/reactivity";
import { useEffect } from "react";

import { environmentCatalog } from "./catalog";

export type ConnectionStoreReadiness = "pending" | "ready" | "failed";

/** The attribute on `<html>` that E2E harnesses read to wait for the connection store. */
export const CONNECTION_STORE_ATTRIBUTE = "data-connection-store";

export function resolveConnectionStoreReadiness(
  catalog: EnvironmentCatalogState,
  timedOut: boolean,
): ConnectionStoreReadiness {
  if (catalog.failed === true || timedOut) return "failed";
  return catalog.isReady ? "ready" : "pending";
}

/**
 * Publishes whether the connection store has finished opening, so a test
 * harness can wait for it on every route instead of reading page text.
 */
export function useConnectionStoreReadinessAttribute(
  timedOut: boolean,
  catalogAtom: Atom.Atom<EnvironmentCatalogState> = environmentCatalog.catalogValueAtom,
): void {
  const readiness = resolveConnectionStoreReadiness(useAtomValue(catalogAtom), timedOut);
  useEffect(() => {
    document.documentElement.setAttribute(CONNECTION_STORE_ATTRIBUTE, readiness);
  }, [readiness]);
}
