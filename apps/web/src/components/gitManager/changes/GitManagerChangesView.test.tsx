// @vitest-environment happy-dom

import { EnvironmentRpcUnavailableError } from "@bibcode/client-runtime/rpc";
import { GitManagerOperationError } from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useGitManagerStore } from "../../../gitManagerStore";
import { useSourceControlPanelStore } from "../../../sourceControlPanelStore";
import type { ChangeRow } from "./changesList.logic";

const h = vi.hoisted(() => ({
  status: null as Record<string, unknown> | null,
  freshStatus: null as Record<string, unknown> | null,
  refs: {
    conflictedPaths: [] as string[],
  } as Record<string, unknown> | null,
  commits: null as Record<string, unknown> | null,
  signalGeneration: 1 as number | null,
  liveSignalAvailable: true,
  availableEditors: [] as string[],
  statusError: null as string | null,
  statusEmission: null as AsyncResult.AsyncResult<unknown, unknown> | null,
  statusAtom: vi.fn((target: unknown) => ({ kind: "status", target })),
  refsAtom: vi.fn((target: unknown) => ({ kind: "refs", target })),
  commitsAtom: vi.fn((target: unknown) => ({ kind: "commits", target })),
  signalAtom: vi.fn((target: unknown) => ({ kind: "signal", target })),
  refreshRefs: vi.fn(),
  contextMenuShow: vi.fn(
    (
      _items: ReadonlyArray<{ label: string }>,
      _position?: { x: number; y: number },
    ): Promise<string | null> => Promise.resolve(null),
  ),
  openInEditor: vi.fn(() => Promise.resolve({ _tag: "Success" })),
  refreshStatus: vi.fn(),
  stageFiles: vi.fn(),
  unstageFiles: vi.fn(),
  commit: vi.fn(),
  undoCommit: vi.fn(),
  discard: vi.fn(),
  listProps: null as Record<string, unknown> | null,
  listRenderCount: 0,
}));

vi.mock("../../../state/vcs", () => ({
  vcsEnvironment: {
    status: h.statusAtom,
    refreshStatus: "cmd:refresh-status",
    stageFiles: "cmd:stage-files",
    unstageFiles: "cmd:unstage-files",
  },
}));

vi.mock("../../../state/gitManager", () => ({
  gitManagerEnvironment: {
    getRefs: h.refsAtom,
    getCommits: h.commitsAtom,
    signal: h.signalAtom,
    commit: "cmd:commit",
    undoCommit: "cmd:undo-commit",
    discard: "cmd:discard",
  },
}));

vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: (atom: { kind?: string } | null) => {
    const kind = atom?.kind;
    const data =
      kind === "status"
        ? h.status
        : kind === "refs"
          ? h.refs
          : kind === "commits"
            ? h.commits
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
  useServerConfigs: () =>
    new Map([
      [
        "environment-1",
        {
          availableEditors: h.availableEditors,
          environment: {
            capabilities: {
              gitManagerCommitOperations: true,
              gitManagerLiveSignal: h.liveSignalAvailable,
            },
          },
        },
      ],
    ]),
  useThreadShellsForProjectRefs: () => [],
}));

vi.mock("../../../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
}));

vi.mock("../../../localApi", () => ({
  readLocalApi: () => ({ contextMenu: { show: h.contextMenuShow } }),
}));

vi.mock("../../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => {
    switch (command) {
      case "cmd:refresh-status":
        return h.refreshStatus;
      case "cmd:stage-files":
        return h.stageFiles;
      case "cmd:unstage-files":
        return h.unstageFiles;
      case "cmd:commit":
        return h.commit;
      case "cmd:undo-commit":
        return h.undoCommit;
      case "cmd:discard":
        return h.discard;
      default:
        return h.openInEditor;
    }
  },
}));

vi.mock("./GitManagerChangesList", () => ({
  GitManagerChangesList: (props: { rows: ReadonlyArray<ChangeRow> }) => {
    h.listProps = props as unknown as Record<string, unknown>;
    h.listRenderCount += 1;
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

function buttonWithText(text: string): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find(
    (candidate) =>
      (candidate.textContent?.includes(text) ?? false) ||
      candidate.getAttribute("aria-label") === text,
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button: ${text}`);
  return button;
}

function checkboxWithLabel(text: string): HTMLElement {
  const label = [...document.querySelectorAll("label")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  const checkbox = label?.querySelector<HTMLElement>("[role='checkbox']");
  if (checkbox === null || checkbox === undefined) throw new Error(`Missing checkbox: ${text}`);
  return checkbox;
}

async function changeInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.status = null;
  h.freshStatus = null;
  h.refs = {
    conflictedPaths: [],
    headRef: "main",
    isDirty: false,
    localBranches: [],
  };
  h.commits = null;
  h.signalGeneration = 1;
  h.liveSignalAvailable = true;
  h.availableEditors = [];
  h.statusError = null;
  h.statusEmission = null;
  h.listProps = null;
  h.listRenderCount = 0;
  h.statusAtom.mockClear();
  h.refsAtom.mockClear();
  h.commitsAtom.mockClear();
  h.signalAtom.mockClear();
  h.refreshRefs.mockClear();
  h.contextMenuShow.mockClear();
  h.openInEditor.mockClear();
  h.refreshStatus.mockReset();
  h.refreshStatus.mockImplementation(() =>
    Promise.resolve(AsyncResult.success(h.freshStatus ?? h.status)),
  );
  h.stageFiles.mockReset();
  h.stageFiles.mockResolvedValue(AsyncResult.success({}));
  h.unstageFiles.mockReset();
  h.unstageFiles.mockResolvedValue(AsyncResult.success({}));
  h.commit.mockReset();
  h.commit.mockResolvedValue(AsyncResult.success({ sha: "abc", empty: false }));
  h.undoCommit.mockReset();
  h.undoCommit.mockResolvedValue(
    AsyncResult.success({ summary: "Restored", description: "", coAuthors: [] }),
  );
  h.discard.mockReset();
  h.discard.mockResolvedValue(
    AsyncResult.success({ trashed: [], permanentlyDiscarded: [], trashUnavailable: [] }),
  );
  useGitManagerStore.setState({ byProjectKey: {} });
  useSourceControlPanelStore.setState({ byThreadKey: {}, byCwdKey: {} });
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
  it("keeps explicit change reads available without opening the live signal", async () => {
    h.liveSignalAvailable = false;
    h.status = statusWith("src/manual-refresh.ts");

    await renderView();

    expect(h.signalAtom).not.toHaveBeenCalled();
    expect(h.statusAtom).toHaveBeenCalledOnce();
    expect(h.refsAtom).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("src/manual-refresh.ts");
  });

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

  it("uses the local context-menu path and exposes confirmed discard", async () => {
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
        "Discard changes",
        "Copy path",
        "Copy relative path",
        "Reveal",
        "Open in editor",
      ]),
    );
    await vi.waitFor(() =>
      expect((h.listProps as { rows: ReadonlyArray<ChangeRow> }).rows[0]?.inclusion).toBe("none"),
    );
  });

  it("refreshes status immediately before staging the selected paths", async () => {
    h.status = statusWith("src/selected.ts");
    h.freshStatus = {
      workingTree: {
        files: [
          {
            path: "src/selected.ts",
            insertions: 1,
            deletions: 0,
            status: "modified",
            area: "unstaged",
          },
          {
            path: "src/appeared-after-click.ts",
            insertions: 1,
            deletions: 0,
            status: "modified",
            area: "staged",
          },
        ],
      },
    };
    await renderView();

    await act(async () => buttonWithText("Commit 1 files to main").click());

    await vi.waitFor(() => expect(h.commit).toHaveBeenCalledOnce());
    expect(h.refreshStatus).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: { cwd: "/repo/main" },
    });
    expect(h.stageFiles).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: { cwd: "/repo/main", filePaths: ["src/selected.ts"] },
    });
    expect(h.unstageFiles).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: { cwd: "/repo/main", filePaths: ["src/appeared-after-click.ts"] },
    });
    expect(h.refreshStatus.mock.invocationCallOrder[0]).toBeLessThan(
      h.stageFiles.mock.invocationCallOrder[0]!,
    );
    expect(h.refreshStatus.mock.invocationCallOrder[0]).toBeLessThan(
      h.unstageFiles.mock.invocationCallOrder[0]!,
    );
  });

  it("does not re-render the changes list while the shared draft is typed", async () => {
    h.status = statusWith("src/selected.ts");
    await renderView();
    const listRenderCount = h.listRenderCount;

    await changeInput(
      container.querySelector<HTMLInputElement>("#git-manager-summary")!,
      "Draft without list churn",
    );

    expect(h.listRenderCount).toBe(listRenderCount);
  });

  it("passes amend, options, and co-authors through the environment command", async () => {
    h.status = statusWith("src/selected.ts");
    h.freshStatus = h.status;
    h.refs = {
      conflictedPaths: [],
      headRef: "main",
      isDirty: false,
      localBranches: [{ current: true, upstream: null, ahead: 0 }],
    };
    h.commits = {
      commits: [{ committedAtMs: Date.now(), parents: ["parent"] }],
    };
    await renderView();
    await changeInput(
      container.querySelector<HTMLInputElement>("#git-manager-summary")!,
      "Commit options",
    );
    await changeInput(
      container.querySelector<HTMLInputElement>("#git-manager-co-author")!,
      "Ada Lovelace <ada@example.test>",
    );
    await act(async () => buttonWithText("Add Co-author").click());
    await act(async () => buttonWithText("Amend Last Commit").click());
    await act(async () => buttonWithText("Commit Options").click());
    for (const label of ["Bypass Commit Hooks", "Signed-off-by", "Allow Empty"]) {
      const checkbox = checkboxWithLabel(label);
      await act(async () => {
        checkbox.focus();
        checkbox.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: " " }),
        );
        checkbox.dispatchEvent(
          new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: " " }),
        );
      });
    }

    await act(async () => buttonWithText("Commit 1 files to main").click());

    await vi.waitFor(() => expect(h.commit).toHaveBeenCalledOnce());
    expect(h.commit).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: {
        cwd: "/repo/main",
        summary: "Commit options",
        description: "",
        amend: true,
        noVerify: true,
        signoff: true,
        allowEmpty: true,
        coAuthors: [{ name: "Ada Lovelace", email: "ada@example.test" }],
      },
    });
  });

  it("renders a server-authored blocked reason verbatim", async () => {
    const reason = "Finish the server-observed merge before committing.";
    h.status = statusWith("src/selected.ts");
    h.freshStatus = h.status;
    h.commit.mockResolvedValueOnce(
      AsyncResult.failure(
        Cause.fail(
          new GitManagerOperationError({
            operation: "gitManager.commit",
            code: "merge-in-progress",
            message: reason,
            blocked: {
              operation: "commit",
              code: "merge-in-progress",
              message: reason,
            },
          }),
        ),
      ),
    );
    await renderView();

    await act(async () => buttonWithText("Commit 1 files to main").click());

    await vi.waitFor(() => expect(container.textContent).toContain(reason));
  });

  it("does not discard from the context menu until the confirmation is accepted", async () => {
    h.status = statusWith("src/discard.ts");
    h.contextMenuShow.mockResolvedValueOnce("discard");
    await renderView();
    const listProps = h.listProps as {
      onContextMenu: (path: string, position: { x: number; y: number }) => void;
    };

    await act(async () => listProps.onContextMenu("src/discard.ts", { x: 12, y: 24 }));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Move Changes to Trash?"));
    expect(h.discard).not.toHaveBeenCalled();

    await act(async () => buttonWithText("Move to Trash").click());
    await vi.waitFor(() =>
      expect(h.discard).toHaveBeenCalledWith({
        environmentId: "environment-1",
        input: {
          cwd: "/repo/main",
          paths: ["src/discard.ts"],
          permitPermanent: false,
        },
      }),
    );
  });

  it("offers permanent discard only for paths the server reports as not trashed", async () => {
    h.status = statusWith("src/unavailable-trash.ts");
    h.contextMenuShow.mockResolvedValueOnce("discard");
    h.discard
      .mockResolvedValueOnce(
        AsyncResult.success({
          trashed: [],
          permanentlyDiscarded: [],
          trashUnavailable: ["src/unavailable-trash.ts"],
        }),
      )
      .mockResolvedValueOnce(
        AsyncResult.success({
          trashed: [],
          permanentlyDiscarded: ["src/unavailable-trash.ts"],
          trashUnavailable: [],
        }),
      );
    await renderView();
    const listProps = h.listProps as {
      onContextMenu: (path: string, position: { x: number; y: number }) => void;
    };

    await act(async () => listProps.onContextMenu("src/unavailable-trash.ts", { x: 12, y: 24 }));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Move Changes to Trash?"));
    await act(async () => buttonWithText("Move to Trash").click());
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("server reported that OS trash is unavailable"),
    );

    await act(async () => buttonWithText("Discard Permanently").click());
    await vi.waitFor(() => expect(h.discard).toHaveBeenCalledTimes(2));
    expect(h.discard).toHaveBeenLastCalledWith({
      environmentId: "environment-1",
      input: {
        cwd: "/repo/main",
        paths: ["src/unavailable-trash.ts"],
        permitPermanent: true,
      },
    });
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
