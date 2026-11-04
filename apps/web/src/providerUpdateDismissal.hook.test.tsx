// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { removeLocalStorageItem } from "./hooks/useLocalStorage";
import {
  isProviderUpdateNotificationDismissed,
  PROVIDER_UPDATE_DISMISSALS_STORAGE_KEY,
  useDismissedProviderUpdateNotificationKeys,
} from "./providerUpdateDismissal";

let dismiss: ((key: string) => void) | null = null;

function Probe() {
  const { dismissNotificationKey } = useDismissedProviderUpdateNotificationKeys();
  useEffect(() => {
    dismiss = dismissNotificationKey;
  }, [dismissNotificationKey]);
  return null;
}

describe("useDismissedProviderUpdateNotificationKeys", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    removeLocalStorageItem(PROVIDER_UPDATE_DISMISSALS_STORAGE_KEY);
  });
  afterEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("keeps every dismissal issued in the same tick", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<Probe />));
    await act(async () => {
      // Two environments announcing in one effect share the list this render captured.
      dismiss?.("external:environment-a:claudeAgent:2.1.318");
      dismiss?.("external:environment-b:claudeAgent:2.1.318");
      dismiss?.("external:environment-a:claudeAgent:2.1.318");
    });
    expect(
      isProviderUpdateNotificationDismissed("external:environment-a:claudeAgent:2.1.318"),
    ).toBe(true);
    expect(
      isProviderUpdateNotificationDismissed("external:environment-b:claudeAgent:2.1.318"),
    ).toBe(true);
    const stored = JSON.parse(
      window.localStorage.getItem(PROVIDER_UPDATE_DISMISSALS_STORAGE_KEY) ?? "{}",
    ) as { keys: string[] };
    expect(stored.keys).toHaveLength(2);
    await act(async () => root.unmount());
  });
});
