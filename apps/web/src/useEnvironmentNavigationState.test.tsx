// @vitest-environment happy-dom

import { scopedProjectKey, scopeProjectRef } from "@bibcode/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@bibcode/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  toggleEnvironmentDisclosure,
  type EnvironmentNavigationStateV2,
} from "./environmentNavigationStore";

const commands = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(() => Promise.resolve({ _tag: "Success", value: undefined })),
}));

vi.mock("./state/use-atom-command", () => ({
  useAtomCommand: (command: { readonly label: string }) =>
    command.label === "environment-navigation:load" ? commands.load : commands.save,
}));

import {
  useEnvironmentNavigationState,
  type EnvironmentNavigationStateController,
  type UseEnvironmentNavigationStateInput,
} from "./useEnvironmentNavigationState";

const ENVIRONMENT = EnvironmentId.make("environment-remote");
const PROJECT = ProjectId.make("project-api");
const MAIN = ThreadId.make("thread-main");

function state(overrides: Partial<EnvironmentNavigationStateV2> = {}) {
  return {
    schemaVersion: 2 as const,
    selected: { environmentId: ENVIRONMENT, projectId: PROJECT, threadId: MAIN },
    expandedEnvironmentIds: [ENVIRONMENT],
    expandedProjectKeys: [scopedProjectKey(scopeProjectRef(ENVIRONMENT, PROJECT))],
    manuallyToggledKeys: [],
    environmentOrder: [ENVIRONMENT],
    pinnedEnvironmentIds: [],
    projectOrderByEnvironment: {},
    ...overrides,
  } satisfies EnvironmentNavigationStateV2;
}

let controller: EnvironmentNavigationStateController | null = null;
const controllers = new Map<string, EnvironmentNavigationStateController>();

function Harness({ input }: { readonly input: UseEnvironmentNavigationStateInput }) {
  controller = useEnvironmentNavigationState(input);
  return <div data-hydrated={String(controller.hydrated)} />;
}

function SharedHarness({
  id,
  input,
}: {
  readonly id: string;
  readonly input: UseEnvironmentNavigationStateInput;
}) {
  controllers.set(id, useEnvironmentNavigationState(input));
  return null;
}

const mounted: Array<{ root: ReturnType<typeof createRoot>; container: HTMLDivElement }> = [];

afterEach(async () => {
  await act(async () => {
    for (const entry of mounted.splice(0)) entry.root.unmount();
  });
  controller = null;
  controllers.clear();
  commands.load.mockReset();
  commands.save.mockClear();
});

describe("useEnvironmentNavigationState", () => {
  it("replays a disclosure made during hydration and persists the exact result", async () => {
    let resolveLoad:
      | ((value: { _tag: "Success"; value: EnvironmentNavigationStateV2 }) => void)
      | undefined;
    commands.load.mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );
    const input: UseEnvironmentNavigationStateInput = {
      ready: true,
      environmentIds: [ENVIRONMENT],
      projects: [
        {
          ...scopeProjectRef(ENVIRONMENT, PROJECT),
          workspaceRoot: "/srv/api",
          mainThreadId: MAIN,
          threadIds: [MAIN],
        },
      ],
      selected: { environmentId: ENVIRONMENT, projectId: PROJECT, threadId: MAIN },
    };
    const container = document.createElement("div");
    const root = createRoot(container);
    mounted.push({ root, container });

    await act(async () => {
      root.render(<Harness input={input} />);
    });
    expect(controller?.hydrated).toBe(false);

    await act(async () => {
      controller?.update((current) => toggleEnvironmentDisclosure(current, ENVIRONMENT));
    });
    expect(controller?.state.expandedEnvironmentIds).toEqual([]);
    expect(commands.save).not.toHaveBeenCalled();

    await act(async () => {
      resolveLoad?.({ _tag: "Success", value: state() });
      await Promise.resolve();
    });

    expect(controller?.hydrated).toBe(true);
    expect(controller?.state.expandedEnvironmentIds).toEqual([]);
    expect(controller?.state.manuallyToggledKeys).toEqual([`environment:${ENVIRONMENT}`]);
    expect(commands.save).toHaveBeenLastCalledWith(controller?.state);
  });

  it("persists route selection while respecting an explicit collapsed ancestor", async () => {
    commands.load.mockResolvedValue({
      _tag: "Success",
      value: state({
        selected: null,
        expandedEnvironmentIds: [],
        expandedProjectKeys: [],
        manuallyToggledKeys: [`environment:${ENVIRONMENT}`],
      }),
    });
    const base: UseEnvironmentNavigationStateInput = {
      ready: true,
      environmentIds: [ENVIRONMENT],
      projects: [
        {
          environmentId: ENVIRONMENT,
          projectId: PROJECT,
          workspaceRoot: "/srv/api",
          mainThreadId: MAIN,
          threadIds: [MAIN],
        },
      ],
      selected: null,
    };
    const container = document.createElement("div");
    const root = createRoot(container);
    mounted.push({ root, container });

    await act(async () => {
      root.render(<Harness input={base} />);
      await Promise.resolve();
    });
    commands.save.mockClear();
    await act(async () => {
      root.render(
        <Harness
          input={{
            ...base,
            selected: { environmentId: ENVIRONMENT, projectId: PROJECT, threadId: MAIN },
          }}
        />,
      );
      await Promise.resolve();
    });

    expect(controller?.state.selected).toEqual({
      environmentId: ENVIRONMENT,
      projectId: PROJECT,
      threadId: MAIN,
    });
    expect(controller?.state.expandedEnvironmentIds).toEqual([]);
    expect(controller?.state.expandedProjectKeys).toEqual([
      scopedProjectKey(scopeProjectRef(ENVIRONMENT, PROJECT)),
    ]);
    expect(commands.save).toHaveBeenCalledOnce();
  });

  it("does not let a superseded hydration publish or persist stale state", async () => {
    let resolveFirstLoad:
      | ((value: { _tag: "Success"; value: EnvironmentNavigationStateV2 }) => void)
      | undefined;
    commands.load
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirstLoad = resolve;
        }),
      )
      .mockResolvedValueOnce({ _tag: "Success", value: state() });
    const input: UseEnvironmentNavigationStateInput = {
      ready: true,
      environmentIds: [ENVIRONMENT],
      projects: [
        {
          ...scopeProjectRef(ENVIRONMENT, PROJECT),
          workspaceRoot: "/srv/api",
          mainThreadId: MAIN,
          threadIds: [MAIN],
        },
      ],
      selected: { environmentId: ENVIRONMENT, projectId: PROJECT, threadId: MAIN },
    };
    const container = document.createElement("div");
    const root = createRoot(container);
    mounted.push({ root, container });

    await act(async () => {
      root.render(<Harness key="first" input={input} />);
    });
    await act(async () => {
      controller?.update((current) => toggleEnvironmentDisclosure(current, ENVIRONMENT));
      root.render(<Harness key="replacement" input={input} />);
      await Promise.resolve();
    });

    expect(controller?.hydrated).toBe(true);
    expect(controller?.state).toEqual(state());
    commands.save.mockClear();

    await act(async () => {
      resolveFirstLoad?.({ _tag: "Success", value: state() });
      await Promise.resolve();
    });

    expect(controller?.state).toEqual(state());
    expect(commands.save).not.toHaveBeenCalled();
  });

  it("synchronizes client-local pin/order edits between the sidebar and center workspace", async () => {
    commands.load.mockResolvedValue({ _tag: "Success", value: state() });
    const input: UseEnvironmentNavigationStateInput = {
      ready: true,
      environmentIds: [ENVIRONMENT],
      projects: [],
      selected: { environmentId: ENVIRONMENT, projectId: null, threadId: null },
    };
    const container = document.createElement("div");
    const root = createRoot(container);
    mounted.push({ root, container });

    await act(async () => {
      root.render(
        <>
          <SharedHarness id="sidebar" input={input} />
          <SharedHarness id="workspace" input={input} />
        </>,
      );
      await Promise.resolve();
    });
    commands.save.mockClear();

    await act(async () => {
      controllers.get("workspace")?.update((current) => ({
        ...current,
        pinnedEnvironmentIds: [ENVIRONMENT],
      }));
    });

    expect(controllers.get("sidebar")?.state.pinnedEnvironmentIds).toEqual([ENVIRONMENT]);
    expect(controllers.get("workspace")?.state.pinnedEnvironmentIds).toEqual([ENVIRONMENT]);
    expect(commands.save).toHaveBeenCalledOnce();
  });
});
