// @vitest-environment happy-dom

import type { GitManagerMergePreview, GitManagerRefEntry } from "@bibcode/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  preview: null as GitManagerMergePreview | null,
  pending: false,
  error: null as string | null,
  onEvent: null as ((event: Record<string, unknown>) => void) | null,
  runOperation: vi.fn(
    (_registry: unknown, _target: unknown, onEvent: (event: Record<string, unknown>) => void) => {
      h.onEvent = onEvent;
      return { result: new Promise(() => undefined), cancel: vi.fn() };
    },
  ),
  previewMerge: vi.fn(() => ({ kind: "preview" })),
}));

vi.mock("../../../state/gitManager", () => ({
  gitManagerEnvironment: {
    previewMerge: h.previewMerge,
  },
  runGitManagerOperation: h.runOperation,
}));

vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: h.preview,
    emission: { _tag: h.preview === null ? "Initial" : "Success" },
    error: h.error,
    isPending: h.pending,
    refresh: () => undefined,
  }),
}));

vi.mock("~/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
  DialogPopup: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("../toolbar/GitManagerOperationBanner", () => ({
  GitManagerOperationBanner: ({ operation }: { operation: { _tag: string } | null }) =>
    operation === null ? null : <div data-operation-event={operation._tag} />,
}));

import { GitManagerMergeDialog } from "./GitManagerMergeDialog";

const cleanPreview: GitManagerMergePreview = {
  _tag: "clean",
  source: "feature",
  current: "main",
  ahead: 2,
  behind: 0,
};

function branch(name: string, current = false): GitManagerRefEntry {
  return {
    name,
    tipSha: `${name}-sha`,
    upstream: null,
    ahead: 0,
    behind: 0,
    current,
    isDefault: current,
    worktreePath: null,
    blocked: [],
  };
}

let container: HTMLDivElement;
let root: Root | null;

async function renderDialog(
  refs: ReadonlyArray<GitManagerRefEntry>,
  onOpenChange = vi.fn(),
  disabledReason: string | null = null,
) {
  await act(async () =>
    root?.render(
      <GitManagerMergeDialog
        open
        disabledReason={disabledReason}
        scope={{ environmentId: "env-a" as never, cwd: "/repo" }}
        projectRef={{ environmentId: "env-a", projectId: "project-a" } as never}
        refs={refs}
        recentNames={["feature"]}
        onOpenChange={onOpenChange}
      />,
    ),
  );
  return onOpenChange;
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === text,
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button: ${text}`);
  return button;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  h.preview = cleanPreview;
  h.pending = false;
  h.error = null;
  h.onEvent = null;
  h.runOperation.mockClear();
  h.previewMerge.mockClear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("GitManagerMergeDialog", () => {
  it("disables confirm while previewing and for unrelated histories", async () => {
    h.preview = null;
    h.pending = true;
    await renderDialog([branch("main", true), branch("feature")]);
    expect(buttonWithText("Merge").disabled).toBe(true);

    h.preview = { ...cleanPreview, _tag: "unrelated-histories" };
    h.pending = false;
    await renderDialog([branch("main", true), branch("feature")]);
    expect(buttonWithText("Merge").disabled).toBe(true);
    expect(container.textContent).toContain("unrelated histories");
  });

  it("renders a server block verbatim and links it to the disabled confirm button", async () => {
    const message = "Server says the working tree must be clean first.";
    const feature = {
      ...branch("feature"),
      blocked: [{ operation: "merge", code: "dirty-working-tree", message }],
    } as GitManagerRefEntry;
    await renderDialog([branch("main", true), feature]);

    const confirm = buttonWithText("Merge");
    expect(confirm.disabled).toBe(true);
    expect(confirm.title).toBe(message);
    expect(confirm.getAttribute("aria-describedby")).toBe("git-manager-merge-disabled-reason");
    expect(container.textContent).toContain(message);
  });

  it("skips merge preview and disables confirmation with the capability reason only", async () => {
    const reason = "This environment does not support Git Manager stash and merge operations.";
    await renderDialog([branch("main", true), branch("feature")], vi.fn(), reason);

    expect(h.previewMerge).not.toHaveBeenCalled();
    expect(buttonWithText("Merge")).toMatchObject({ disabled: true, title: reason });
    expect(container.textContent).toContain(reason);
    expect(buttonWithText("Cancel").disabled).toBe(false);
    expect(container.textContent).toContain("feature");
  });

  it("closes on finished and stays open with the failure code on failed", async () => {
    const onOpenChange = await renderDialog([branch("main", true), branch("feature")]);
    await act(async () => buttonWithText("Merge").click());
    expect(h.runOperation).toHaveBeenCalledWith(
      expect.anything(),
      {
        environmentId: "env-a",
        input: {
          _tag: "merge",
          cwd: "/repo",
          projectId: "project-a",
          source: "feature",
          noVerify: false,
        },
      },
      expect.any(Function),
    );

    await act(async () =>
      h.onEvent?.({
        _tag: "failed",
        operation: "merge",
        code: "merge-conflicts",
        message: "Resolve conflicts.",
        blocked: null,
      }),
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(container.textContent).toContain("merge-conflicts");

    await act(async () =>
      h.onEvent?.({ _tag: "finished", operation: "merge", message: "Merged." }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
