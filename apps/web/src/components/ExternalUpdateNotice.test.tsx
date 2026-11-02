// @vitest-environment happy-dom
import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@bibcode/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  environments: [] as Array<unknown>,
  toasts: [] as Array<{ title?: unknown }>,
}));

vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: state.environments }),
}));
vi.mock("./ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: (toast: { title?: unknown }) => state.toasts.push(toast) },
}));

import { removeLocalStorageItem } from "../hooks/useLocalStorage";
import { PROVIDER_UPDATE_DISMISSALS_STORAGE_KEY } from "../providerUpdateDismissal";
import { ExternalUpdateNotice } from "./ExternalUpdateNotice";

const environment = (id: string, version: string) => ({
  environmentId: EnvironmentId.make(id),
  label: id,
  serverConfig: {
    providers: [
      {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        driver: ProviderDriverKind.make("claudeAgent"),
        version,
      },
    ],
  },
});

describe("ExternalUpdateNotice", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    removeLocalStorageItem(PROVIDER_UPDATE_DISMISSALS_STORAGE_KEY);
    state.toasts.length = 0;
  });
  afterEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("announces two environments in one pass and persists both dismissals", async () => {
    state.environments = [
      environment("environment-a", "2.1.99 (Claude Code)"),
      environment("environment-b", "2.1.99 (Claude Code)"),
    ];
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<ExternalUpdateNotice />));
    expect(state.toasts).toHaveLength(0);

    state.environments = [
      environment("environment-a", "2.1.100 (Claude Code)"),
      environment("environment-b", "2.1.100 (Claude Code)"),
    ];
    await act(async () => root.render(<ExternalUpdateNotice />));

    expect(state.toasts).toHaveLength(2);
    const stored = JSON.parse(
      window.localStorage.getItem(PROVIDER_UPDATE_DISMISSALS_STORAGE_KEY) ?? "{}",
    ) as { keys: string[] };
    expect([...stored.keys].toSorted()).toEqual([
      "external:environment-a:claudeAgent:2.1.100",
      "external:environment-b:claudeAgent:2.1.100",
    ]);
    await act(async () => root.unmount());
  });
});
