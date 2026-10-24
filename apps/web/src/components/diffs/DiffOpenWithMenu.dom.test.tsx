// @vitest-environment happy-dom

import {
  EnvironmentId,
  ReviewDiffToolError,
  type ReviewDiffToolScope,
  type ReviewListDiffToolsResult,
} from "@bibcode/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  primaryEnvironmentId: "environment-1" as string | null,
  environmentLabel: "This Mac",
  supported: true,
  desktop: true,
  tools: null as ReviewListDiffToolsResult | null,
  toolsError: null as string | null,
  toolsRequested: 0,
  lastChoice: null as string | null,
  updates: [] as Array<Record<string, unknown>>,
  launches: [] as Array<{ input: Record<string, unknown> }>,
  launch: null as null | (() => Promise<unknown>),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({
    environment: { capabilities: { reviewDiffTools: h.supported } },
  }),
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: { configValueAtom: () => ({}) },
}));
vi.mock("~/state/environments", () => ({
  usePrimaryEnvironmentId: () => h.primaryEnvironmentId,
  useEnvironment: () => ({ label: h.environmentLabel }),
}));
vi.mock("~/env", () => ({
  get isDesktopHost() {
    return h.desktop;
  },
}));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (select?: (settings: { diffToolLastChoice: string | null }) => unknown) =>
    select ? select({ diffToolLastChoice: h.lastChoice }) : { diffToolLastChoice: h.lastChoice },
  useUpdateClientSettings: () => (patch: Record<string, unknown>) => h.updates.push(patch),
}));
vi.mock("~/state/review", () => ({
  reviewEnvironment: {
    diffTools: (target: unknown) => ({ diffTools: target }),
    openDiffTool: { label: "open-diff-tool" },
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    if (atom) h.toolsRequested += 1;
    return {
      data: atom ? h.tools : null,
      error: atom ? h.toolsError : null,
      isPending: atom !== null && h.tools === null && h.toolsError === null,
    };
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => (value: { input: Record<string, unknown> }) => {
    h.launches.push(value);
    return h.launch ? h.launch() : Promise.resolve(AsyncResult.success({ _tag: "opened" }));
  },
}));
vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  MenuTrigger: ({
    children,
    render: _render,
    ...props
  }: React.ComponentProps<"button"> & { render?: unknown }) => (
    <button type="button" data-testid="open-with" {...props}>
      {children}
    </button>
  ),
  MenuPopup: ({ children }: { children?: React.ReactNode }) => <div role="menu">{children}</div>,
  MenuGroup: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  MenuGroupLabel: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="heading">{children}</div>
  ),
  MenuSeparator: () => <hr />,
  MenuItem: ({
    children,
    disabled,
    onClick,
    closeOnClick: _closeOnClick,
  }: {
    children?: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
    closeOnClick?: boolean;
  }) => (
    <button type="button" role="menuitem" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));

import { DiffOpenWithMenu, DiffToolLaunchAlert } from "./DiffOpenWithMenu";
import type { DiffOpenWithTarget, DiffToolLaunchFailure } from "~/lib/diffOpenWith";

const environmentId = EnvironmentId.make("environment-1");
const WORKING_TREE: ReviewDiffToolScope = { _tag: "working-tree" };
const FILE: DiffOpenWithTarget = {
  kind: "file",
  path: "src/foo.ts",
  previousPath: null,
  untracked: false,
};
const TOOLS: ReviewListDiffToolsResult = {
  tools: [
    { id: "bc", label: "Beyond Compare", kind: "builtin" },
    { id: "meld", label: "Meld", kind: "builtin" },
  ],
  defaultToolId: null,
  defaultSource: null,
};

describe("DiffOpenWithMenu", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onLaunchFailure = vi.fn<(failure: DiffToolLaunchFailure) => void>();

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.assign(h, {
      primaryEnvironmentId: "environment-1",
      environmentLabel: "This Mac",
      supported: true,
      desktop: true,
      tools: TOOLS,
      toolsError: null,
      toolsRequested: 0,
      lastChoice: null,
      launch: null,
    });
    h.updates.length = 0;
    h.launches.length = 0;
    onLaunchFailure.mockClear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(target: DiffOpenWithTarget = FILE, scope = WORKING_TREE) {
    await act(async () => {
      root.render(
        <DiffOpenWithMenu
          cwd="/repo"
          environmentId={environmentId}
          scope={scope}
          target={target}
          onLaunchFailure={onLaunchFailure}
        />,
      );
    });
    // The list is asked for once the pointer reaches the button.
    await act(async () => {
      container
        .querySelector('[data-testid="open-with"]')!
        .dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    });
  }

  const items = () =>
    [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map((item) => ({
      text: item.textContent,
      disabled: item.disabled,
    }));

  async function choose(text: string) {
    const item = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (candidate) => candidate.textContent?.startsWith(text),
    );
    expect(item, text).toBeDefined();
    await act(async () => item!.click());
  }

  it("names the file and lists the apps with the default first marked", async () => {
    h.lastChoice = "meld";
    await render();
    expect(container.querySelector('[data-testid="heading"]')?.textContent).toBe("Open foo.ts in");
    expect(items()).toEqual([
      { text: "MeldDefault", disabled: false },
      { text: "Beyond Compare", disabled: false },
      { text: "All files in Meld", disabled: false },
    ]);
  });

  it("prefers the tool Git is set to use over the last choice", async () => {
    h.lastChoice = "meld";
    h.tools = { ...TOOLS, defaultToolId: "bc", defaultSource: "diff.tool" };
    await render({ kind: "all", count: 42 });
    expect(container.querySelector('[data-testid="heading"]')?.textContent).toBe(
      "Open all 42 files in",
    );
    expect(items()).toEqual([
      { text: "Beyond CompareDefault", disabled: false },
      { text: "Meld", disabled: false },
    ]);
  });

  it("does not ask for the list until the pointer reaches the button", async () => {
    await act(async () => {
      root.render(
        <DiffOpenWithMenu
          cwd="/repo"
          environmentId={environmentId}
          scope={WORKING_TREE}
          target={FILE}
          onLaunchFailure={onLaunchFailure}
        />,
      );
    });
    expect(h.toolsRequested).toBe(0);
  });

  it("says why each unavailable case cannot open", async () => {
    h.primaryEnvironmentId = "environment-2";
    h.environmentLabel = "build-box";
    await render();
    expect(items()).toEqual([
      {
        text: "Available for threads on this computer. This thread runs on build-box.",
        disabled: true,
      },
    ]);
    expect(h.toolsRequested).toBe(0);

    h.primaryEnvironmentId = "environment-1";
    h.supported = false;
    await render();
    expect(items()).toEqual([{ text: "Update the server to use Open with.", disabled: true }]);

    h.supported = true;
    h.tools = { tools: [], defaultToolId: null, defaultSource: null };
    await render();
    expect(items()).toEqual([
      { text: "No diff app found. Install one, or set git config diff.tool.", disabled: true },
    ]);

    h.tools = null;
    await render();
    expect(items()).toEqual([{ text: "Finding diff apps…", disabled: true }]);
  });

  it("keeps All files for an untracked file, which alone cannot open", async () => {
    await render({ ...FILE, untracked: true });
    expect(items()).toEqual([
      { text: "Untracked file. Stage it to compare it in a diff app.", disabled: true },
      { text: "All files in Beyond Compare", disabled: false },
    ]);
  });

  it("hides All files for VS Code, which compares two files only", async () => {
    h.tools = { tools: [{ id: "vscode", label: "Visual Studio Code", kind: "builtin" }] } as never;
    await render();
    expect(items().map((item) => item.text)).toEqual(["Visual Studio CodeDefault"]);
  });

  it("opens the file in the chosen app, remembers it, and reports nothing", async () => {
    await render(
      { kind: "file", path: "new.ts", previousPath: "old.ts", untracked: false },
      { _tag: "branch", baseRef: "main" },
    );
    await choose("Meld");
    expect(h.launches).toEqual([
      {
        environmentId,
        input: {
          cwd: "/repo",
          toolId: "meld",
          target: { _tag: "file", path: "new.ts", previousPath: "old.ts" },
          scope: { _tag: "branch", baseRef: "main" },
        },
      },
    ]);
    expect(h.updates).toEqual([{ diffToolLastChoice: "meld" }]);
    expect(onLaunchFailure).not.toHaveBeenCalled();
  });

  it("opens every file from a file's menu", async () => {
    await render();
    await choose("All files in");
    expect(h.launches[0]?.input).toMatchObject({ toolId: "bc", target: { _tag: "all" } });
  });

  it("reports Git's message and command when the app does not open", async () => {
    h.launch = () =>
      Promise.resolve(
        AsyncResult.failure(
          Cause.fail(
            new ReviewDiffToolError({
              reason: "launch-failed",
              message: "fatal: external diff died (exit 128)",
              command: ["git", "-C", "/repo", "difftool"],
            }),
          ),
        ),
      );
    await render();
    await choose("Beyond Compare");
    expect(onLaunchFailure).toHaveBeenCalledWith({
      title: "Couldn't open Beyond Compare.",
      detail: "fatal: external diff died (exit 128)",
      command: ["git", "-C", "/repo", "difftool"],
    });
  });

  it("disables an app's item while its own launch runs", async () => {
    let finish: (value: unknown) => void = () => undefined;
    h.launch = () => new Promise((resolve) => (finish = resolve));
    await render();
    await choose("Beyond Compare");
    expect(items()[0]).toMatchObject({ disabled: true });
    expect(items()[1]).toMatchObject({ disabled: false });
    await act(async () => finish(AsyncResult.success({ _tag: "opened" })));
    expect(items()[0]).toMatchObject({ disabled: false });
  });

  it("says where the app opens in a browser", async () => {
    h.desktop = false;
    await render();
    expect(container.textContent).toContain("Opens on the computer running the server.");
  });

  it("needs no such note in the desktop app", async () => {
    await render();
    expect(container.textContent).not.toContain("Opens on the computer running the server.");
  });
});

describe("DiffToolLaunchAlert", () => {
  it("shows the failure with Copy command and Dismiss", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const onDismiss = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <DiffToolLaunchAlert
          failure={{
            title: "Couldn't open Meld.",
            detail: "fatal: external diff died (exit 128)",
            command: ["git", "-C", "/my repo", "difftool"],
          }}
          onDismiss={onDismiss}
        />,
      );
    });
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn't open Meld.");
    expect(alert?.textContent).toContain("fatal: external diff died (exit 128)");
    const buttons = [...container.querySelectorAll("button")];
    await act(async () => buttons.find((button) => button.textContent === "Copy command")!.click());
    expect(writeText).toHaveBeenCalledWith("git -C '/my repo' difftool");
    await act(async () => buttons.find((button) => button.textContent === "Dismiss")!.click());
    expect(onDismiss).toHaveBeenCalled();

    await act(async () => {
      root.render(
        <DiffToolLaunchAlert
          failure={{ title: "Couldn't confirm that Meld opened.", detail: null, command: null }}
          onDismiss={onDismiss}
        />,
      );
    });
    expect(container.textContent).not.toContain("Copy command");
    await act(async () => root.unmount());
    container.remove();
  });
});
