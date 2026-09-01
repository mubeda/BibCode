// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  runOperation: vi.fn((_registry: unknown, _target: unknown, _onEvent: unknown) => ({
    result: new Promise(() => undefined),
    cancel: vi.fn(),
  })),
}));

vi.mock("../../../state/gitManager", () => ({
  runGitManagerOperation: h.runOperation,
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

import { GitManagerTagDialog } from "./GitManagerTagDialog";

let container: HTMLDivElement;
let root: Root;

const baseProps = {
  open: true,
  scope: { environmentId: "env-a" as never, cwd: "/repo" },
  projectRef: { environmentId: "env-a", projectId: "project-a" } as never,
  existingTags: ["existing"],
  targetSha: "0123456789abcdef0123456789abcdef01234567",
  tag: null,
  remote: "origin",
  onOpenChange: vi.fn(),
};

async function renderDialog(overrides: Partial<React.ComponentProps<typeof GitManagerTagDialog>>) {
  await act(async () =>
    root.render(<GitManagerTagDialog {...baseProps} action="create" {...overrides} />),
  );
}

function button(text: string): HTMLButtonElement {
  const result = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === text,
  );
  if (!(result instanceof HTMLButtonElement)) throw new Error(`Missing button: ${text}`);
  return result;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  h.runOperation.mockClear();
  baseProps.onOpenChange.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("GitManagerTagDialog", () => {
  it("validates and dispatches tag creation on the selected environment/worktree lane", async () => {
    await renderDialog({});
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Tag name"]');
    expect(input).not.toBeNull();
    await act(async () => {
      setInputValue(input!, "release/v1");
    });
    await act(async () => button("Create Tag").click());

    expect(h.runOperation).toHaveBeenCalledOnce();
    expect(h.runOperation.mock.calls[0]?.[1]).toEqual({
      environmentId: "env-a",
      input: {
        _tag: "tag-create",
        cwd: "/repo",
        projectId: "project-a",
        name: "release/v1",
        sha: "0123456789abcdef0123456789abcdef01234567",
      },
    });
  });

  it("disables duplicate creation immediately with an accessible reason", async () => {
    await renderDialog({});
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Tag name"]')!;
    await act(async () => {
      setInputValue(input, "existing");
    });
    expect(button("Create Tag").disabled).toBe(true);
    expect(container.textContent).toContain("A tag named existing already exists.");
  });

  it("renders explicit local-only destructive copy for deletion", async () => {
    await renderDialog({ action: "delete", tag: "release/v1" });
    expect(container.textContent).toContain("Delete tag release/v1?");
    expect(container.textContent).toContain("not deleted there");
    expect(button("Delete Tag").className).toContain("destructive");
  });
});
