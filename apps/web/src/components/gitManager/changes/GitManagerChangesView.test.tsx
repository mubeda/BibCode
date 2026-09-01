// @vitest-environment happy-dom

import { EnvironmentRpcUnavailableError } from "@bibcode/client-runtime/rpc";
import * as Cause from "effect/Cause";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useGitManagerStore } from "../../../gitManagerStore";
import type { ChangeRow } from "./changesList.logic";

const h = vi.hoisted(() => ({
  status: null as Record<string, unknown> | null,
  refs: {
    conflictedPaths: [] as string[],
  } as Record<string, unknown> | null,
  signalGeneration: 1 as number | null,
  availableEditors: [] as string[],
  statusError: null as string | null,
  statusEmission: null as AsyncResult.AsyncResult<unknown, unknown> | null,
  statusAtom: vi.fn((target: unknown) => ({ kind: "status", target })),
  refsAtom: vi.fn((target: unknown) => ({ kind: "refs", target })),
  signalAtom: vi.fn((target: unknown) => ({ kind: "signal", target })),
  refreshRefs: vi.fn(),
  contextMenuShow: vi.fn(
    (
      _items: ReadonlyArray<{ label: string }>,
      _position?: { x: number; y: number },
    ): Promise<string | null> => Promise.resolve(null),
  ),
  openInEditor: vi.fn(() => Promise.resolve({ _tag: "Success" })),
  listProps: null as Record<string, unknown> | null,
}));

vi.mock("../../../state/vcs", () => ({
  vcsEnvironment: { status: h.statusAtom },
}));

vi.mock("../../../state/gitManager", () => ({
  gitManagerEnvironment: { getRefs: h.refsAtom, signal: h.signalAtom },
}));

vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: (atom: { kind?: string } | null) => {
    const kind = atom?.kind;
    const data =
      kind === "status"
        ? h.status
        : kind === "refs"
          ? h.refs
          : kind === "signal" && h.signalGeneration !== null
            ? { generation: h.signalGeneration }
            : null;
    return {
      data,
      emission:
        kind === "status" && h.statusEmission !== null
          ? h.statusEmission
          : { _tag: data === null ? "Initial" : "Success", waiting: data === null },
      error: kind === "status" ? h.statusError : null,
      isPending: data === null,
      refresh: kind === "refs" ? h.refreshRefs : () => undefined,
    };
  },
}));

vi.mock("../../../state/entities", () => ({
  useProject: () => ({ workspaceRoot: "/repo/main" }),
  useServerConfigs: () => new Map([["environment-1", { availableEditors: h.availableEditors }]]),
  useThreadShellsForProjectRefs: () => [],
}));

vi.mock("../../../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
}));

vi.mock("../../../localApi", () => ({
  readLocalApi: () => ({ contextMenu: { show: h.contextMenuShow } }),
}));

vi.mock("../../../state/use-atom-command", () => ({
  useAtomCommand: () => h.openInEditor,
}));

vi.mock("./GitManagerChangesList", () => ({
  GitManagerChangesList: (props: { rows: ReadonlyArray<ChangeRow> }) => {
    h.listProps = props as unknown as Record<string, unknown>;
    return (
      <div>
        {props.rows.map((row) => (
          <span key={row.path}>{row.path}</span>
        ))}
      </div>
    );
  },
}));

import { GitManagerChangesView } from "./GitManagerChangesView";
import { GitManagerChangeRow } from "./GitManagerChangeRow";

const projectRef = { environmentId: "environment-1", projectId: "project-1" } as never;

function statusWith(path: string) {
  return {
    workingTree: {
      files: [
        {
          path,
          insertions: 1,
          deletions: 0,
          status: "modified",
          area: "unstaged",
        },
      ],
    },
  };
}

let container: HTMLDivElement;
let root: Root | null;

async function renderView() {
  await act(async () =>
    root?.render(
      <GitManagerChangesView
        scope={{ environmentId: "environment-1" as never, cwd: "/repo/main" }}
        projectRef={projectRef}
      />,
    ),
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.status = null;
  h.refs = { conflictedPaths: [] };
  h.signalGeneration = 1;
  h.availableEditors = [];
  h.statusError = null;
  h.statusEmission = null;
  h.listProps = null;
  h.statusAtom.mockClear();
  h.refsAtom.mockClear();
  h.signalAtom.mockClear();
  h.refreshRefs.mockClear();
  h.contextMenuShow.mockClear();
  h.openInEditor.mockClear();
  useGitManagerStore.setState({ byProjectKey: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("GitManagerChangesView", () => {
  it("repopulates from the status subscription after a reconnect", async () => {
    await renderView();
    expect(container.textContent).toContain("Connecting to changes");

    h.status = statusWith("src/before.ts");
    await renderView();
    expect(container.textContent).toContain("src/before.ts");

    h.status = null;
    await renderView();
    expect(container.textContent).toContain("Connecting to changes");

    h.status = statusWith("src/after.ts");
    await renderView();
    expect(container.textContent).toContain("src/after.ts");
    expect(h.statusAtom).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: { cwd: "/repo/main" },
    });
  });

  it("distinguishes an unavailable environment from a Git read failure", async () => {
    h.statusError = "Remote environment is not connected.";
    h.statusEmission = AsyncResult.failure(
      Cause.fail(
        new EnvironmentRpcUnavailableError({
          environmentId: "environment-1",
          message: h.statusError,
        }),
      ),
    );

    await renderView();

    expect(container.textContent).toContain("Environment unavailable");
    expect(container.textContent).toContain("Remote environment is not connected.");
  });

  it("keeps inclusion local while selection updates the shared view state", async () => {
    h.status = statusWith("src/selected.ts");
    await renderView();
    const listProps = h.listProps as {
      rows: ReadonlyArray<ChangeRow>;
      onSelect: (path: string) => void;
      onToggle: (path: string) => void;
    };

    expect(listProps.rows[0]?.inclusion).toBe("all");
    await act(async () => listProps.onToggle("src/selected.ts"));
    expect((h.listProps as { rows: ReadonlyArray<ChangeRow> }).rows[0]?.inclusion).toBe("none");

    await act(async () => listProps.onSelect("src/selected.ts"));
    expect(useGitManagerStore.getState().selectViewState(projectRef).selectedFilePath).toBe(
      "src/selected.ts",
    );
  });

  it("uses the local context-menu path and omits discard mutations", async () => {
    h.status = statusWith("src/menu.ts");
    h.contextMenuShow.mockResolvedValueOnce("toggle-inclusion");
    await renderView();
    const listProps = h.listProps as {
      rows: ReadonlyArray<ChangeRow>;
      onContextMenu: (path: string, position: { x: number; y: number }) => void;
    };

    await act(async () => listProps.onContextMenu("src/menu.ts", { x: 12, y: 24 }));
    await vi.waitFor(() => expect(h.contextMenuShow).toHaveBeenCalledOnce());

    const items = h.contextMenuShow.mock.calls[0]?.[0] ?? [];
    expect(items.map((item) => item.label)).toEqual(
      expect.arrayContaining([
        "Ignore file",
        "Ignore folder",
        "Ignore all .ts",
        "Exclude selected",
        "Copy path",
        "Copy relative path",
        "Reveal",
        "Open in editor",
      ]),
    );
    expect(items.map((item) => item.label)).not.toContain("Discard");
    await vi.waitFor(() =>
      expect((h.listProps as { rows: ReadonlyArray<ChangeRow> }).rows[0]?.inclusion).toBe("none"),
    );
  });

  it("reveals a file through the environment-scoped file-manager command", async () => {
    h.status = statusWith("src/menu.ts");
    h.availableEditors = ["file-manager"];
    h.contextMenuShow.mockResolvedValueOnce("reveal");
    await renderView();
    const listProps = h.listProps as {
      onContextMenu: (path: string, position: { x: number; y: number }) => void;
    };

    await act(async () => listProps.onContextMenu("src/menu.ts", { x: 12, y: 24 }));
    await vi.waitFor(() =>
      expect(h.openInEditor).toHaveBeenCalledWith({
        environmentId: "environment-1",
        input: { cwd: "/repo/main/src", editor: "file-manager" },
      }),
    );
  });

  it("renders the filter-miss blank slate with a clear action", async () => {
    h.status = statusWith("src/visible.ts");
    useGitManagerStore.getState().setFilterText(projectRef, "missing");

    await renderView();

    expect(container.textContent).toContain("No changed files match these filters.");
    expect(container.textContent).toContain("Clear filters");
  });

  it("keeps mouse selection separate from keyboard inclusion toggling", async () => {
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    await act(async () =>
      root?.render(
        <GitManagerChangeRow
          row={{
            path: "src/keyboard.ts",
            status: "modified",
            area: "unstaged",
            insertions: 1,
            deletions: 0,
            inclusion: "all",
            conflicted: false,
            submodule: false,
            disabledReason: null,
          }}
          selected={false}
          onContextMenu={() => undefined}
          onOpenExternal={() => undefined}
          onSelect={onSelect}
          onToggle={onToggle}
        />,
      ),
    );
    const row = container.querySelector<HTMLElement>("[role='option']")!;

    await act(async () => row.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSelect).toHaveBeenCalledWith("src/keyboard.ts");
    expect(onToggle).not.toHaveBeenCalled();

    await act(async () =>
      row.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })),
    );
    expect(onToggle).toHaveBeenCalledWith("src/keyboard.ts");
  });

  it("renders a disabled reason verbatim and blocks keyboard inclusion", async () => {
    const onToggle = vi.fn();
    await act(async () =>
      root?.render(
        <GitManagerChangeRow
          row={{
            path: "vendor/nested",
            status: "modified",
            area: "unstaged",
            insertions: 0,
            deletions: 0,
            inclusion: "none",
            conflicted: false,
            submodule: true,
            disabledReason: "Server-authored nested checkout reason.",
          }}
          selected={false}
          onContextMenu={() => undefined}
          onOpenExternal={() => undefined}
          onSelect={() => undefined}
          onToggle={onToggle}
        />,
      ),
    );
    const row = container.querySelector<HTMLElement>("[role='option']")!;
    const checkbox = container.querySelector<HTMLElement>("[role='checkbox']")!;

    expect(container.textContent).toContain("Server-authored nested checkout reason.");
    expect(checkbox.getAttribute("aria-describedby")).toBeTruthy();
    expect(checkbox.getAttribute("title")).toBe("Server-authored nested checkout reason.");
    await act(async () =>
      row.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: " " })),
    );
    expect(onToggle).not.toHaveBeenCalled();
  });
});
