// @vitest-environment happy-dom

import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@bibcode/client-runtime/environment";
import type { EnvironmentShellState } from "@bibcode/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationShellSnapshot,
} from "@bibcode/contracts";
import * as Option from "effect/Option";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  environmentIds: [] as EnvironmentId[],
  shellStates: new Map<EnvironmentId, EnvironmentShellState>(),
  shellStateListeners: new Set<() => void>(),
  archivedStates: new Map<
    EnvironmentId,
    {
      snapshots: Array<{
        readonly environmentId: EnvironmentId;
        readonly snapshot: OrchestrationShellSnapshot;
      }>;
      error: string | null;
      isLoading: boolean;
    }
  >(),
  refreshArchived: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  RouterProvider: () => null,
}));

vi.mock("@effect/atom-react", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useAtomValue: (atom: { readonly environmentId: EnvironmentId }) =>
      useSyncExternalStore(
        (listener) => {
          h.shellStateListeners.add(listener);
          return () => h.shellStateListeners.delete(listener);
        },
        () => h.shellStates.get(atom.environmentId),
        () => h.shellStates.get(atom.environmentId),
      ),
  };
});

vi.mock("./rpc/atomRegistry", () => ({
  AppAtomRegistryProvider: ({ children }: { readonly children?: React.ReactNode }) => children,
}));

vi.mock("./components/preview/PreviewAutomationHosts", () => ({
  PreviewAutomationHosts: () => null,
}));

vi.mock("./components/preview/previewBridge", () => ({ previewBridge: null }));

vi.mock("./previewRuntimeCapabilities", () => ({
  supportsPreviewRuntimeCapability: () => false,
}));

vi.mock("./state/environments", () => ({
  useEnvironments: () => ({
    isReady: true,
    networkStatus: "online",
    environments: h.environmentIds.map((environmentId) => ({
      environmentId,
      entry: { target: { _tag: "PrimaryConnectionTarget" } },
    })),
  }),
}));

vi.mock("./state/shell", () => ({
  environmentShell: {
    stateValueAtom: (environmentId: EnvironmentId) => ({ environmentId }),
  },
  environmentAvailabilityCommands: { retry: {}, adoptStorage: {} },
  useEnvironmentShellSummary: () => ({ statuses: [] }),
}));

vi.mock("./state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(async () => undefined),
}));

vi.mock("./state/projectDataSafety", () => ({
  projectDataSafetyStore: {
    open: vi.fn(async () => undefined),
    close: vi.fn(),
    retry: vi.fn(async () => undefined),
    restore: vi.fn(),
    startEmpty: vi.fn(),
    openPath: vi.fn(),
    exportDiagnostics: vi.fn(),
  },
  useProjectDataSafetySnapshot: () => ({
    open: false,
    environmentId: null,
    selected: null,
    busy: false,
    error: null,
    lastResult: null,
    requiresStorageAdoption: false,
  }),
}));

vi.mock("./components/desktop/ProjectDataRecoveryDialog", () => ({
  ProjectDataRecoveryDialog: () => null,
}));

vi.mock("./lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: ([environmentId]: readonly EnvironmentId[]) => ({
    ...(environmentId === undefined
      ? { snapshots: [], error: null, isLoading: false }
      : (h.archivedStates.get(environmentId) ?? {
          snapshots: [],
          error: null,
          isLoading: true,
        })),
    refresh: h.refreshArchived,
  }),
}));

import { AppRoot } from "./AppRoot";
import type { AppRouter } from "./router";
import {
  HOST_SURFACE_ID,
  selectThreadCenterPanelState,
  useCenterPanelStore,
} from "./centerPanelStore";
import { useRightPanelStore } from "./rightPanelStore";
import { DraftId, useComposerDraftStore } from "./composerDraftStore";

const ENVIRONMENT_ID = EnvironmentId.make("environment-lifecycle");
const HOST_ID = ThreadId.make("host-thread");
const DELETED_ID = ThreadId.make("deleted-thread");
const ARCHIVED_ID = ThreadId.make("archived-thread");
const DRAFT_THREAD_ID = ThreadId.make("draft-thread");
const HOST_REF = scopeThreadRef(ENVIRONMENT_ID, HOST_ID);
const DELETED_REF = scopeThreadRef(ENVIRONMENT_ID, DELETED_ID);
const ARCHIVED_REF = scopeThreadRef(ENVIRONMENT_ID, ARCHIVED_ID);
const DRAFT_REF = scopeThreadRef(ENVIRONMENT_ID, DRAFT_THREAD_ID);
const PROJECT_REF = scopeProjectRef(ENVIRONMENT_ID, ProjectId.make("draft-project"));

function snapshot(
  snapshotSequence: number,
  threadIds: readonly ThreadId[],
): OrchestrationShellSnapshot {
  return {
    snapshotSequence,
    projects: [],
    threads: threadIds.map((id) => ({ id }) as OrchestrationShellSnapshot["threads"][number]),
    updatedAt: "2026-08-06T00:00:00.000Z",
  };
}

function shellState(
  status: EnvironmentShellState["status"],
  shellSnapshot: OrchestrationShellSnapshot,
): EnvironmentShellState {
  return {
    snapshot: Option.some(shellSnapshot),
    status,
    error: Option.none(),
  };
}

function publishShellState(environmentId: EnvironmentId, state: EnvironmentShellState): void {
  h.shellStates.set(environmentId, state);
  for (const listener of h.shellStateListeners) {
    listener();
  }
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.environmentIds = [ENVIRONMENT_ID];
  h.shellStates.clear();
  h.shellStateListeners.clear();
  h.archivedStates.clear();
  h.refreshArchived.mockReset();
  useCenterPanelStore.setState({ byThreadKey: {} });
  useRightPanelStore.setState({ byThreadKey: {} });
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("AppRoot thread lifecycle reconciliation", () => {
  it("prunes a remote deletion, preserves archive state, and safely replays the snapshot", async () => {
    publishShellState(ENVIRONMENT_ID, shellState("live", snapshot(12, [HOST_ID])));
    h.archivedStates.set(ENVIRONMENT_ID, {
      snapshots: [{ environmentId: ENVIRONMENT_ID, snapshot: snapshot(12, [ARCHIVED_ID]) }],
      error: null,
      isLoading: false,
    });
    useCenterPanelStore.getState().openChatPanel(HOST_REF, DELETED_ID, "Codex");
    useCenterPanelStore.getState().openTerminalPanel(DELETED_REF, "term-deleted");
    useCenterPanelStore.getState().openTerminalPanel(ARCHIVED_REF, "term-archived");
    useRightPanelStore.getState().openTerminal(DELETED_REF, "term-deleted");
    useRightPanelStore.getState().openTerminal(ARCHIVED_REF, "term-archived");

    await act(async () => root.render(<AppRoot router={{} as AppRouter} />));

    expect(
      useCenterPanelStore.getState().byThreadKey[scopedThreadKey(DELETED_REF)],
    ).toBeUndefined();
    expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(DELETED_REF)]).toBeUndefined();
    expect(
      selectThreadCenterPanelState(useCenterPanelStore.getState().byThreadKey, HOST_REF).surfaces,
    ).toEqual([{ id: HOST_SURFACE_ID, kind: "chat-host" }]);
    expect(useCenterPanelStore.getState().byThreadKey[scopedThreadKey(ARCHIVED_REF)]).toBeDefined();
    expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(ARCHIVED_REF)]).toBeDefined();

    const centerAfterFirstReconciliation = useCenterPanelStore.getState();
    const rightAfterFirstReconciliation = useRightPanelStore.getState();
    await act(async () => root.render(<AppRoot router={{} as AppRouter} />));

    expect(useCenterPanelStore.getState()).toBe(centerAfterFirstReconciliation);
    expect(useRightPanelStore.getState()).toBe(rightAfterFirstReconciliation);
  });

  it.each([
    [
      "cached live-shell data",
      () => {
        publishShellState(ENVIRONMENT_ID, shellState("degraded", snapshot(20, [HOST_ID])));
        h.archivedStates.set(ENVIRONMENT_ID, {
          snapshots: [{ environmentId: ENVIRONMENT_ID, snapshot: snapshot(20, []) }],
          error: null,
          isLoading: false,
        });
      },
    ],
    [
      "a synchronizing shell",
      () => {
        publishShellState(ENVIRONMENT_ID, shellState("synchronizing", snapshot(20, [HOST_ID])));
        h.archivedStates.set(ENVIRONMENT_ID, {
          snapshots: [{ environmentId: ENVIRONMENT_ID, snapshot: snapshot(20, []) }],
          error: null,
          isLoading: false,
        });
      },
    ],
    [
      "an archived snapshot refresh in flight",
      () => {
        publishShellState(ENVIRONMENT_ID, shellState("live", snapshot(20, [HOST_ID])));
        h.archivedStates.set(ENVIRONMENT_ID, {
          snapshots: [{ environmentId: ENVIRONMENT_ID, snapshot: snapshot(20, []) }],
          error: null,
          isLoading: true,
        });
      },
    ],
    [
      "a partial response with no archived environment snapshot",
      () => {
        publishShellState(ENVIRONMENT_ID, shellState("live", snapshot(20, [HOST_ID])));
        h.archivedStates.set(ENVIRONMENT_ID, {
          snapshots: [],
          error: null,
          isLoading: false,
        });
      },
    ],
    [
      "an archived snapshot failure",
      () => {
        publishShellState(ENVIRONMENT_ID, shellState("live", snapshot(20, [HOST_ID])));
        h.archivedStates.set(ENVIRONMENT_ID, {
          snapshots: [{ environmentId: ENVIRONMENT_ID, snapshot: snapshot(20, []) }],
          error: "Failed to load archived threads.",
          isLoading: false,
        });
      },
    ],
    [
      "sequence-skewed live and archived snapshots",
      () => {
        publishShellState(ENVIRONMENT_ID, shellState("live", snapshot(21, [HOST_ID])));
        h.archivedStates.set(ENVIRONMENT_ID, {
          snapshots: [{ environmentId: ENVIRONMENT_ID, snapshot: snapshot(20, []) }],
          error: null,
          isLoading: false,
        });
      },
    ],
  ] as const)("does not prune from %s", async (_name, configureKnowledge) => {
    configureKnowledge();
    useCenterPanelStore.getState().openTerminalPanel(DELETED_REF, "term-deleted");
    useRightPanelStore.getState().openTerminal(DELETED_REF, "term-deleted");

    await act(async () => root.render(<AppRoot router={{} as AppRouter} />));

    expect(useCenterPanelStore.getState().byThreadKey[scopedThreadKey(DELETED_REF)]).toBeDefined();
    expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(DELETED_REF)]).toBeDefined();
  });

  it("waits through cached and synchronizing reconnect state before pruning a missed deletion", async () => {
    const archived = {
      snapshots: [{ environmentId: ENVIRONMENT_ID, snapshot: snapshot(30, []) }],
      error: null,
      isLoading: false,
    };
    publishShellState(ENVIRONMENT_ID, shellState("degraded", snapshot(30, [HOST_ID])));
    h.archivedStates.set(ENVIRONMENT_ID, archived);
    useCenterPanelStore.getState().openTerminalPanel(DELETED_REF, "term-deleted");
    useRightPanelStore.getState().openTerminal(DELETED_REF, "term-deleted");

    await act(async () => root.render(<AppRoot router={{} as AppRouter} />));
    expect(useCenterPanelStore.getState().byThreadKey[scopedThreadKey(DELETED_REF)]).toBeDefined();

    await act(async () =>
      publishShellState(ENVIRONMENT_ID, shellState("synchronizing", snapshot(30, [HOST_ID]))),
    );
    expect(useCenterPanelStore.getState().byThreadKey[scopedThreadKey(DELETED_REF)]).toBeDefined();

    await act(async () =>
      publishShellState(ENVIRONMENT_ID, shellState("live", snapshot(30, [HOST_ID]))),
    );
    await vi.waitFor(() => {
      expect(
        useCenterPanelStore.getState().byThreadKey[scopedThreadKey(DELETED_REF)],
      ).toBeUndefined();
      expect(
        useRightPanelStore.getState().byThreadKey[scopedThreadKey(DELETED_REF)],
      ).toBeUndefined();
    });
  });

  it("refreshes stale archived knowledge without pruning from the skewed pair", async () => {
    publishShellState(ENVIRONMENT_ID, shellState("live", snapshot(41, [HOST_ID])));
    h.archivedStates.set(ENVIRONMENT_ID, {
      snapshots: [{ environmentId: ENVIRONMENT_ID, snapshot: snapshot(40, []) }],
      error: null,
      isLoading: false,
    });
    useCenterPanelStore.getState().openTerminalPanel(DELETED_REF, "term-deleted");

    await act(async () => root.render(<AppRoot router={{} as AppRouter} />));

    expect(useCenterPanelStore.getState().byThreadKey[scopedThreadKey(DELETED_REF)]).toBeDefined();
    expect(h.refreshArchived).toHaveBeenCalledTimes(1);
  });

  it("protects draft identities and retains panel state across archive then unarchive", async () => {
    publishShellState(ENVIRONMENT_ID, shellState("live", snapshot(50, [HOST_ID])));
    h.archivedStates.set(ENVIRONMENT_ID, {
      snapshots: [{ environmentId: ENVIRONMENT_ID, snapshot: snapshot(50, [ARCHIVED_ID]) }],
      error: null,
      isLoading: false,
    });
    useComposerDraftStore
      .getState()
      .setLogicalProjectDraftThreadId(
        scopedProjectKey(PROJECT_REF),
        PROJECT_REF,
        DraftId.make("draft-lifecycle"),
        { threadId: DRAFT_THREAD_ID },
      );
    useCenterPanelStore.getState().openChatPanel(HOST_REF, DRAFT_THREAD_ID, "Draft");
    useCenterPanelStore.getState().openTerminalPanel(DELETED_REF, "term-deleted");
    useCenterPanelStore.getState().openTerminalPanel(ARCHIVED_REF, "term-archived");
    useCenterPanelStore.getState().openTerminalPanel(DRAFT_REF, "term-draft");
    useRightPanelStore.getState().openTerminal(DELETED_REF, "term-deleted");
    useRightPanelStore.getState().openTerminal(ARCHIVED_REF, "term-archived");
    useRightPanelStore.getState().openTerminal(DRAFT_REF, "term-draft");

    await act(async () => root.render(<AppRoot router={{} as AppRouter} />));

    expect(
      useCenterPanelStore.getState().byThreadKey[scopedThreadKey(DELETED_REF)],
    ).toBeUndefined();
    expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(DELETED_REF)]).toBeUndefined();
    expect(useCenterPanelStore.getState().byThreadKey[scopedThreadKey(ARCHIVED_REF)]).toBeDefined();
    expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(ARCHIVED_REF)]).toBeDefined();
    expect(useCenterPanelStore.getState().byThreadKey[scopedThreadKey(DRAFT_REF)]).toBeDefined();
    expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(DRAFT_REF)]).toBeDefined();
    expect(
      selectThreadCenterPanelState(useCenterPanelStore.getState().byThreadKey, HOST_REF).surfaces,
    ).toContainEqual(expect.objectContaining({ kind: "chat", threadId: DRAFT_THREAD_ID }));

    publishShellState(ENVIRONMENT_ID, shellState("live", snapshot(51, [HOST_ID, ARCHIVED_ID])));
    h.archivedStates.set(ENVIRONMENT_ID, {
      snapshots: [{ environmentId: ENVIRONMENT_ID, snapshot: snapshot(51, []) }],
      error: null,
      isLoading: false,
    });
    await act(async () => root.render(<AppRoot router={{} as AppRouter} />));

    expect(useCenterPanelStore.getState().byThreadKey[scopedThreadKey(ARCHIVED_REF)]).toBeDefined();
    expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(ARCHIVED_REF)]).toBeDefined();
    expect(useCenterPanelStore.getState().byThreadKey[scopedThreadKey(DRAFT_REF)]).toBeDefined();
  });
});
