// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type RemoteUpdateSnapshot,
  type ServerProvider,
} from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ProviderUpdateEnvironmentInput, ServerUpdateInput } from "../ProviderUpdateAll.logic";

const state = vi.hoisted(() => ({
  environments: [] as ProviderUpdateEnvironmentInput[],
  run: vi.fn(),
  install: vi.fn(),
  activeWorkTargets: [] as unknown[],
}));

vi.mock("../ProviderUpdateLaunchNotification.environments", () => ({
  useProviderUpdateEnvironments: () => state.environments,
}));

vi.mock("~/state/server", () => ({
  serverEnvironment: { updateProvider: { label: "update-provider", run: state.run } },
}));

vi.mock("~/state/remoteUpdates", async () => {
  const { AsyncResult: Result, Atom: AtomModule } = await import("effect/reactivity");
  const activeWork = AtomModule.make(
    Result.success({ runningTurns: 2, liveTerminals: 0, queuedMessages: 0 }),
  );
  const noRun = AtomModule.make(null);
  return {
    remoteUpdateEnvironment: {
      update: { label: "remote-update", run: state.install },
      activeWork: (target: unknown) => {
        state.activeWorkTargets.push(target);
        return activeWork;
      },
      run: () => noRun,
    },
  };
});

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

function serverUpdate(overrides: Partial<RemoteUpdateSnapshot> = {}): ServerUpdateInput {
  return {
    progress: true,
    snapshot: {
      serverVersion: "0.11.0",
      latestVersion: "0.12.0",
      state: "update-available",
      error: null,
      support: { installMode: "interactive", reason: "available", installKind: "unknown" },
      downloadPercent: null,
      targetVersion: "0.12.0",
      installStage: null,
      ...overrides,
    },
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
  state.install.mockReset();
  state.activeWorkTargets = [];
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

  it("explains every skip when nothing can update in one click", async () => {
    state.environments = [
      state.environments[2]!,
      {
        environmentId: ssh,
        label: "devbox",
        connected: true,
        providers: [
          provider(claude, "claude-ssh", {
            versionAdvisory: {
              ...provider(claude, "claude-ssh").versionAdvisory!,
              canUpdate: false,
            },
          }),
        ],
      },
    ];
    const container = await mount();

    expect(container.textContent).toContain("Nothing here updates in one click.");
    expect(button(container, "Update all…").disabled).toBe(true);
    const rows = [...container.querySelectorAll<HTMLElement>("[data-provider-update-all-row]")];
    expect(rows.map((row) => row.getAttribute("data-provider-update-all-row"))).toEqual([
      ssh,
      offline,
    ]);
    expect(rows.map((row) => row.getAttribute("data-status"))).toEqual(["skipped", "skipped"]);
    expect(container.textContent).toContain("Claude can be updated from provider settings.");
    expect(container.textContent).toContain("This environment isn’t connected");
    expect(
      [...container.querySelectorAll("button")].some((entry) => entry.textContent === "Clear"),
    ).toBe(false);
    expect(registry.get(providerUpdateAllRun)).toBeNull();
  });

  it("confirms a remote server install with the providers and runs it once they update", async () => {
    let finishProvider!: (value: unknown) => void;
    state.run.mockImplementation(() => new Promise((done) => (finishProvider = done)));
    state.install.mockResolvedValue(AsyncResult.success({ phase: "succeeded", version: "0.12.0" }));
    state.environments = [
      {
        environmentId: ssh,
        label: "devbox",
        connected: true,
        providers: [provider(codex, "codex-ssh")],
        serverUpdate: serverUpdate(),
      },
    ];
    const container = await mount();

    expect(container.textContent).toContain(
      "1 provider update and 1 server update on 1 environment.",
    );
    await click(button(container, "Update all…"));
    const dialog = container.querySelector("[data-dialog]")!;
    expect(dialog.textContent).toContain("Server v0.12.0");
    expect(dialog.textContent).toContain("Updating devbox restarts BiBCode there.");
    expect(dialog.textContent).toContain("2 running agents will stop.");
    expect(state.activeWorkTargets).toContainEqual({ environmentId: ssh, input: {} });

    await click(button(container, "Update 1 provider and 1 server"));
    await vi.waitFor(() => expect(state.run).toHaveBeenCalledTimes(1));
    for (let tick = 0; tick < 10; tick += 1) await act(async () => Promise.resolve());
    expect(state.install).not.toHaveBeenCalled();
    expect(
      container
        .querySelector('[data-provider-update-all-row][data-subject="server"]')
        ?.getAttribute("data-status"),
    ).toBe("queued");

    await act(async () =>
      finishProvider(AsyncResult.success({ providers: [updated("codex-ssh")] })),
    );
    await vi.waitFor(() => expect(state.install).toHaveBeenCalledTimes(1));
    expect(state.install.mock.calls[0]?.[1]).toEqual({ environmentId: ssh, input: {} });
    await vi.waitFor(() =>
      expect(
        container
          .querySelector('[data-provider-update-all-row][data-subject="server"]')
          ?.getAttribute("data-status"),
      ).toBe("updated"),
    );
    expect(container.textContent).toContain("Updated to v0.12.0");
  });

  it("names a manual host as skipped with the manual copy and never installs it", async () => {
    state.run.mockResolvedValue(AsyncResult.success({ providers: [updated("codex-ssh")] }));
    state.environments = [
      {
        environmentId: ssh,
        label: "devbox",
        connected: true,
        providers: [provider(codex, "codex-ssh")],
        serverUpdate: serverUpdate({
          latestVersion: null,
          state: "idle",
          support: {
            installMode: "manual",
            reason: "manual-update-required",
            installKind: "archive",
          },
          targetVersion: null,
        }),
      },
    ];
    const container = await mount();

    await click(button(container, "Update all…"));
    expect(container.querySelector("[data-dialog]")?.textContent).toContain(
      "This server must be updated manually.",
    );
    await click(button(container, "Update 1 provider"));
    await vi.waitFor(() =>
      expect(
        container
          .querySelector('[data-provider-update-all-row][data-subject="providers"]')
          ?.getAttribute("data-status"),
      ).toBe("updated"),
    );
    expect(state.install).not.toHaveBeenCalled();
  });
});
