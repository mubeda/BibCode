// @vitest-environment happy-dom

import type { EnvironmentCatalogState } from "@bibcode/client-runtime/state/connections";
import { RegistryContext } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./catalog", () => ({ environmentCatalog: {} }));

import {
  CONNECTION_STORE_ATTRIBUTE,
  useConnectionStoreReadinessAttribute,
} from "./connectionStoreReadiness";

describe("connection store readiness attribute", () => {
  it("follows the catalog through pending, ready and failed", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const catalogAtom = Atom.make<EnvironmentCatalogState>({ isReady: false, entries: new Map() });
    const registry = AtomRegistry.make();
    function Probe({ timedOut }: { readonly timedOut: boolean }) {
      useConnectionStoreReadinessAttribute(timedOut, catalogAtom);
      return null;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = (timedOut: boolean) =>
      act(async () =>
        root.render(
          <RegistryContext.Provider value={registry}>
            <Probe timedOut={timedOut} />
          </RegistryContext.Provider>,
        ),
      );
    const attribute = () => document.documentElement.getAttribute(CONNECTION_STORE_ATTRIBUTE);

    await render(false);
    expect(attribute()).toBe("pending");

    await act(async () => registry.set(catalogAtom, { isReady: true, entries: new Map() }));
    expect(attribute()).toBe("ready");

    await render(true);
    expect(attribute()).toBe("failed");

    await render(false);
    await act(async () =>
      registry.set(catalogAtom, { isReady: false, entries: new Map(), failed: true }),
    );
    expect(attribute()).toBe("failed");

    act(() => root.unmount());
    registry.dispose();
  });
});
