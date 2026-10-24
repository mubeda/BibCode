// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ProviderUpdateEnvironmentInput } from "../ProviderUpdateAll.logic";

const state = vi.hoisted(() => ({
  environments: [] as ProviderUpdateEnvironmentInput[],
  run: vi.fn(),
}));

vi.mock("../ProviderUpdateLaunchNotification.environments", () => ({
  useProviderUpdateEnvironments: () => state.environments,
}));

vi.mock("~/state/server", () => ({
  serverEnvironment: { updateProvider: { label: "update-provider", run: state.run } },
}));

vi.mock("../ui/dialog", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
      open === false ? null : <div data-dialog>{children}</div>,
    DialogPopup: Box,
    DialogHeader: Box,
    DialogTitle: Box,
    DialogDescription: Box,
    DialogPanel: Box,
    DialogFooter: Box,
  };
});

import { providerUpdateAllRun } from "~/state/providerUpdateAll";
import { ProviderUpdateAllSection } from "./ProviderUpdateAllSection";

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");
const local = EnvironmentId.make("local");
const ssh = EnvironmentId.make("ssh-devbox");
const offline = EnvironmentId.make("relay-offline");

function provider(
  driver: ReturnType<typeof ProviderDriverKind.make>,
  instanceId: string,
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-24T10:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    agents: [],
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      updateCommand: "npm install -g provider",
      canUpdate: true,
      checkedAt: "2026-10-24T10:00:00.000Z",
      message: null,
    },
    ...overrides,
  };
}

function updated(instanceId: string, driver = codex): ServerProvider {
  return provider(driver, instanceId, {
    updateState: {
      status: "succeeded",
      startedAt: null,
      finishedAt: null,
      message: null,
      output: null,
    },
  });
}

let registry: AtomRegistry.AtomRegistry;
const mounted: Array<{ readonly root: Root; readonly container: HTMLDivElement }> = [];

async function mount(): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <ProviderUpdateAllSection />
      </RegistryContext.Provider>,
    ),
  );
  return container;
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  expect(found, `button ${name}`).toBeDefined();
  return found!;
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click();
    await Promise.resolve();
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  registry = AtomRegistry.make();
  state.run.mockReset();
  state.environments = [
    {
      environmentId: local,
      label: "macOS",
      connected: true,
      providers: [provider(codex, "codex")],
    },
    {
      environmentId: ssh,
      label: "devbox",
      connected: true,
      providers: [
        provider(codex, "codex-ssh"),
        provider(claude, "claude-ssh", {
          versionAdvisory: { ...provider(claude, "claude-ssh").versionAdvisory!, canUpdate: false },
        }),
      ],
    },
    {
      environmentId: offline,
      label: "laptop",
      connected: false,
      providers: [provider(codex, "codex-offline")],
    },
  ];
});

afterEach(async () => {
  for (const entry of mounted.splice(0)) {
    await act(async () => entry.root.unmount());
    entry.container.remove();
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("ProviderUpdateAllSection", () => {
  it("renders nothing when no environment has an outdated provider", async () => {
    state.environments = [
      {
        environmentId: local,
        label: "macOS",
        connected: true,
        providers: [
          provider(codex, "codex", {
            versionAdvisory: { ...provider(codex, "codex").versionAdvisory!, status: "current" },
          }),
        ],
      },
    ];
    const container = await mount();
    expect(container.childElementCount).toBe(0);
  });

  it("lists every environment and provider in the confirmation, and Cancel runs nothing", async () => {
    const container = await mount();

    expect(container.textContent).toContain("2 provider updates on 2 environments.");
    await click(button(container, "Update all…"));
    const dialog = container.querySelector("[data-dialog]");
    expect(dialog?.textContent).toContain("macOS");
    expect(dialog?.textContent).toContain("devbox");
    expect(dialog?.textContent).toContain("Codex");
    expect(dialog?.textContent).toContain("Claude can be updated from provider settings.");
    expect(dialog?.textContent).toContain("laptop");
    expect(dialog?.textContent).toContain("This environment isn’t connected");

    await click(button(container, "Cancel"));
    expect(state.run).not.toHaveBeenCalled();
    expect(container.querySelector("[data-dialog]")).toBeNull();
    expect(registry.get(providerUpdateAllRun)).toBeNull();
  });

  it("sends a remote environment's id and shows each environment's result", async () => {
    state.run.mockImplementation(
      async (
        _registry: unknown,
        input: { environmentId: EnvironmentId; input: { instanceId: string } },
      ) =>
        input.environmentId === ssh
          ? AsyncResult.failure(Cause.fail(new Error("npm: permission denied")))
          : AsyncResult.success({ providers: [updated(input.input.instanceId)] }),
    );
    const container = await mount();

    await click(button(container, "Update all…"));
    await click(button(container, "Update 2 providers"));
    await vi.waitFor(() => expect(state.run).toHaveBeenCalledTimes(2));

    expect(state.run.mock.calls.map(([, input]) => input)).toEqual([
      { environmentId: local, input: { provider: codex, instanceId: "codex" } },
      { environmentId: ssh, input: { provider: codex, instanceId: "codex-ssh" } },
    ]);
    await vi.waitFor(() => {
      const rows = container.querySelectorAll("[data-provider-update-all-row]");
      expect([...rows].map((row) => row.getAttribute("data-status"))).toEqual([
        "updated",
        "failed",
        "skipped",
      ]);
    });
    expect(container.textContent).toContain("npm: permission denied");
    expect(container.textContent).toContain("This environment isn’t connected");
  });

  it("keeps the summary in the registry after the page unmounts", async () => {
    let resolve!: (value: unknown) => void;
    state.run.mockImplementation(() => new Promise((done) => (resolve = done)));
    state.environments = [state.environments[1]!];
    const container = await mount();
    await click(button(container, "Update all…"));
    await click(button(container, "Update 1 provider"));
    expect(container.querySelector('[data-status="updating"]')).not.toBeNull();

    const entry = mounted.pop()!;
    await act(async () => entry.root.unmount());
    entry.container.remove();
    resolve(AsyncResult.success({ providers: [updated("codex-ssh")] }));

    await vi.waitFor(() =>
      expect(registry.get(providerUpdateAllRun)?.[0]).toMatchObject({
        environmentId: ssh,
        status: "updated",
      }),
    );
    const remounted = await mount();
    expect(remounted.querySelector('[data-status="updated"]')).not.toBeNull();
    await click(button(remounted, "Clear"));
    expect(registry.get(providerUpdateAllRun)).toBeNull();
  });
});
