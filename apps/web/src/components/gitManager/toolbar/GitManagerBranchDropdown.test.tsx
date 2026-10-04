// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - Replay the actual QA segment against an inert protocol endpoint.

import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import * as NodeVM from "node:vm";
import type { GitManagerRefEntry, ScopedProjectRef } from "@bibcode/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useGitManagerStore } from "../../../gitManagerStore";
import { pinnedKeys, pinnedSetValue } from "../../../../test/pinned-wdio-input";

vi.mock("@legendapp/list/react", () => ({
  LegendList: ({
    data,
    estimatedItemSize,
    renderItem,
  }: {
    data: ReadonlyArray<unknown>;
    estimatedItemSize: number;
    renderItem: (input: { item: unknown; index: number }) => React.ReactNode;
  }) => (
    <div data-estimated-item-size={estimatedItemSize}>
      {data.map((item, index) => (
        <div key={JSON.stringify(item)}>{renderItem({ item, index })}</div>
      ))}
    </div>
  ),
}));

vi.mock("~/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
  PopoverPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { GitManagerBranchDropdown } from "./GitManagerBranchDropdown";

const projectRef = {
  environmentId: "environment-1",
  projectId: "project-1",
} as ScopedProjectRef;

function branch(name: string, options: Partial<GitManagerRefEntry> = {}): GitManagerRefEntry {
  return {
    name,
    tipSha: `${name}-sha`,
    upstream: null,
    ahead: 0,
    behind: 0,
    current: false,
    isDefault: false,
    worktreePath: null,
    blocked: [],
    ...options,
  };
}

let container: HTMLDivElement;
let root: Root | null;

function rowButton(name: string): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(name),
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing branch row: ${name}`);
  return button;
}

async function renderDropdown(
  refs: ReadonlyArray<GitManagerRefEntry>,
  overrides: Partial<React.ComponentProps<typeof GitManagerBranchDropdown>> = {},
) {
  const callbacks = {
    onSelectBranch: vi.fn(),
    onSwitchWorktree: vi.fn(),
    onCreateBranch: vi.fn(),
    onMergeInto: vi.fn(),
  };
  await act(async () =>
    root?.render(
      <GitManagerBranchDropdown
        currentBranchName="main"
        branchDisabledReason={null}
        mergeDisabledReason={null}
        triggerDisabledReason={null}
        noBranchLabel="Detached HEAD"
        projectRef={projectRef}
        recentNames={[]}
        refs={refs}
        remoteRefs={[]}
        selectedWorktreeCwd="/opaque/main"
        {...callbacks}
        {...overrides}
      />,
    ),
  );
  return callbacks;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useGitManagerStore.setState({ byProjectKey: {}, toolbarByProjectKey: {} });
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

describe("GitManagerBranchDropdown", () => {
  it.each([null, "An owned operation is still running."])(
    "restores current refs and focuses the occupied row through actual QA keys without activation: %s",
    async (branchDisabledReason) => {
      const current = "codex/delivery-retry-light";
      const callbacks = await renderDropdown(
        [
          branch(current, { current: true, worktreePath: "/owned/managed" }),
          branch("visual-held", { worktreePath: "/owned/held" }),
        ],
        {
          currentBranchName: current,
          selectedWorktreeCwd: "/owned/managed",
          remoteRefs: [branch("origin/visual-held")],
          branchDisabledReason,
        },
      );
      const filter = container.querySelector<HTMLInputElement>(
        'input[aria-label="Filter branches"]',
      )!;
      const inputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      const type = async (value: string) => {
        await act(async () => {
          inputValue.call(filter, value);
          filter.dispatchEvent(new Event("input", { bubbles: true }));
        });
      };
      const endpoint = {
        elementId: "owned-filter",
        elementClear: async () => {
          await act(async () => {
            filter.focus();
            filter.value = "";
            filter.dispatchEvent(new Event("change", { bubbles: true }));
          });
        },
        elementSendKeys: async (_id: string, value: string) => {
          if (value !== "") await type(value);
        },
      };
      let controlDown = false;
      const keyboard = {
        releaseActions: async () => {},
        performActions: async (
          packets: ReadonlyArray<{
            type: string;
            actions: ReadonlyArray<{ type: string; value?: string }>;
          }>,
        ) => {
          for (const action of packets[0]!.actions) {
            if (action.type === "pause") continue;
            if (action.value === "\uE004") {
              if (action.type === "keyDown") {
                const controls = [
                  ...container.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
                    "button,input",
                  ),
                ].filter((control) => !control.disabled && control.tabIndex >= 0);
                const current = controls.indexOf(document.activeElement as HTMLButtonElement);
                await act(async () => controls[(current + 1) % controls.length]!.focus());
              }
              continue;
            }
            expect(document.activeElement).toBe(filter);
            if (action.value === "\uE009") controlDown = action.type === "keyDown";
            else if (action.type === "keyDown" && action.value === "a" && controlDown)
              filter.setSelectionRange(0, filter.value.length);
            else if (action.type === "keyDown" && action.value === "\uE003") {
              expect(controlDown).toBe(false);
              expect(filter.selectionStart).toBe(0);
              expect(filter.selectionEnd).toBe(filter.value.length);
              await type("");
            }
          }
        },
      };
      const source = NodeFS.readFileSync(
        new NodeURL.URL(
          "../../../../../desktop/e2e/support/release-visual-core.ts",
          import.meta.url,
        ),
        "utf8",
      );
      const focusStart = source.indexOf("  const focus = async");
      const focusEnd = source.indexOf("\n  const composer =", focusStart);
      const start = source.indexOf('  step("visual-branches-open");');
      const end = source.indexOf('  await capture("git-branch-menu");', start);
      expect(focusStart).toBeGreaterThan(0);
      expect(focusEnd).toBeGreaterThan(focusStart);
      expect(start).toBeGreaterThan(focusEnd);
      expect(end).toBeGreaterThan(start);
      const read = (selector: string) => {
        if (selector.startsWith("//*"))
          return (
            [
              ...container.querySelectorAll<HTMLButtonElement>('[aria-label="Branches"] button'),
            ].find((candidate) =>
              [...candidate.querySelectorAll("span")].some(
                (span) => span.textContent === "visual-held",
              ),
            ) ?? null
          );
        return container.querySelector<HTMLElement>(selector);
      };
      const capture = vi.fn(async () => {
        expect(filter.value).toBe("");
        expect(
          useGitManagerStore.getState().selectToolbarViewState(projectRef).branchFilterText,
        ).toBe("");
        expect(
          container.querySelector('[aria-label="Branches"] [aria-label="Current branch"]'),
        ).not.toBeNull();
        expect(
          container.querySelector('[aria-label="Check out remote branch origin/visual-held"]'),
        ).not.toBeNull();
        expect(container.querySelector('[aria-label="Rename visual-held"]')).not.toBeNull();
        expect(container.querySelector('[aria-label="Delete visual-held"]')).not.toBeNull();
        const held = read(
          '//*[@aria-label="Branches"]//button[.//span[normalize-space()="visual-held"]]',
        )!;
        expect(document.activeElement).toBe(held);
        expect(held.parentElement?.classList.contains("group")).toBe(true);
        const require = NodeModule.createRequire(
          new NodeURL.URL("../../../../package.json", import.meta.url),
        );
        const { compile } = require("tailwindcss") as {
          compile: (css: string) => Promise<{ build: (classes: string[]) => string }>;
        };
        for (const label of ["Rename visual-held", "Delete visual-held"]) {
          const control = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
          expect(control.parentElement).toBe(held.parentElement);
          expect(control.parentElement!.contains(document.activeElement)).toBe(true);
          expect(control.disabled).toBe(branchDisabledReason !== null);
          expect(control.classList.contains("group-focus-within:opacity-100")).toBe(true);
          expect(control.classList.contains("group-focus-within:pointer-events-auto")).toBe(true);
          const css = (await compile("@tailwind utilities;")).build([...control.classList]);
          // HappyDOM lacks :focus-within; verify the installed compiler's actual rule without substituting CSS.
          expect(css).toContain(
            ".group-focus-within\\:opacity-100:is(:where(.group):focus-within *)",
          );
          expect(css).toContain(
            ".group-focus-within\\:pointer-events-auto:is(:where(.group):focus-within *)",
          );
          expect(css).toContain("opacity: 100%");
          expect(css).toContain("pointer-events: auto");
        }
      });
      const replay = NodeVM.runInNewContext(
        NodeModule.stripTypeScriptTypes(
          "async function replay() {\n" +
            source.slice(focusStart, focusEnd) +
            source.slice(start, end + '  await capture("git-branch-menu");'.length) +
            "\n}\nreplay",
        ),
        {
          step: () => {},
          click: async (selector: string) => {
            await act(async () => read(selector)!.click());
          },
          capture,
          owner: {
            until: async (proof: () => Promise<boolean>) => {
              for (let pass = 0; pass < 20; pass++) if (await proof()) return;
              throw new Error("Inert public focus did not arrive.");
            },
          },
          browser: {
            $$: (selector: string) => ({
              length: Promise.resolve(
                selector.startsWith("//*")
                  ? Number(read(selector) !== null)
                  : container.querySelectorAll(selector).length,
              ),
            }),
            $: (selector: string) => ({
              elementId: "owned-filter",
              isFocused: async () => document.activeElement === read(selector),
              isDisplayed: async () => read(selector) !== null,
              waitForDisplayed: async () => {
                expect(read(selector)).not.toBeNull();
                if (selector.includes("Check out remote branch")) {
                  expect(container.querySelector('[aria-label="Current branch"]')).toBeNull();
                  expect(
                    useGitManagerStore.getState().selectToolbarViewState(projectRef)
                      .branchFilterText,
                  ).toBe("visual");
                }
              },
              waitForEnabled: async () =>
                expect((read(selector) as HTMLInputElement).disabled).toBe(false),
              setValue: (value: string) => pinnedSetValue(endpoint, value),
              moveTo: async () => expect(read(selector)).not.toBeNull(),
            }),
            keys: (value: string | string[]) => pinnedKeys(keyboard, value),
          },
        },
      ) as () => Promise<void>;
      await replay();
      expect(capture).toHaveBeenCalledWith("git-branch-menu");
      expect(callbacks.onSelectBranch).not.toHaveBeenCalled();
      expect(callbacks.onSwitchWorktree).not.toHaveBeenCalled();
    },
  );
  it("disables its trigger with an accessible explanation while the repository is unavailable", async () => {
    const reason =
      "Git can't read this repository. Check its .git folder, for example a damaged HEAD or config file.";
    await renderDropdown([], {
      currentBranchName: null,
      noBranchLabel: "No branch",
      triggerDisabledReason: reason,
    });
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Choose branch"]');
    expect(trigger).toMatchObject({ disabled: true, title: reason, textContent: "No branch" });
    expect(document.getElementById(trigger!.getAttribute("aria-describedby")!)?.textContent).toBe(
      reason,
    );
  });
  it("keeps filter updates isolated from the panel view-state subscription", () => {
    useGitManagerStore.getState().touchProject(projectRef);
    const panelViewState = useGitManagerStore.getState().selectViewState(projectRef);

    useGitManagerStore.getState().setBranchFilterText(projectRef, "feature");

    expect(useGitManagerStore.getState().selectViewState(projectRef)).toBe(panelViewState);
    expect(useGitManagerStore.getState().selectToolbarViewState(projectRef).branchFilterText).toBe(
      "feature",
    );
  });

  it("redirects an occupied branch to its worktree without issuing checkout", async () => {
    const message = "Branch is checked out in worktree at /opaque/feature.";
    const callbacks = await renderDropdown([
      branch("feature", {
        worktreePath: "/opaque/feature",
        blocked: [{ operation: "branch-checkout", code: "worktree-checked-out", message }],
      }),
    ]);

    await act(async () => rowButton("feature").click());

    expect(callbacks.onSwitchWorktree).toHaveBeenCalledWith("/opaque/feature");
    expect(callbacks.onSelectBranch).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Switch to worktree");
    expect(document.body.textContent).toContain("/opaque/feature");
  });

  it("renders a blocked row's server-authored message verbatim", async () => {
    const message = "Already checked out.";
    await renderDropdown([
      branch("main", {
        current: true,
        blocked: [{ operation: "branch-checkout", code: "current-branch", message }],
      }),
    ]);

    const button = document.querySelector(`button[title="${message}"]`);
    expect(button).toBeInstanceOf(HTMLButtonElement);
    if (!(button instanceof HTMLButtonElement)) throw new Error("Missing blocked branch row");
    expect(button.disabled).toBe(true);
    expect(button.title).toBe(message);
    expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toBe(
      message,
    );
  });

  it("fails closed when the server sends an unknown blocked code", async () => {
    const message = "A newer server guard blocked this branch.";
    await renderDropdown([
      branch("future", {
        blocked: [
          {
            operation: "branch-checkout",
            code: "future-policy" as never,
            message,
          },
        ],
      }),
    ]);

    expect(rowButton("future").disabled).toBe(true);
    expect(document.body.textContent).toContain(message);
  });

  it("disables branch mutations with their reason while merge and worktree surfaces remain", async () => {
    const reason = "This environment does not support Git Manager branch and sync operations.";
    const callbacks = await renderDropdown([branch("feature")], {
      branchDisabledReason: reason,
    });

    expect(rowButton("feature")).toMatchObject({ disabled: true, title: reason });
    expect(
      document.querySelector<HTMLButtonElement>('[aria-label="Rename feature"]'),
    ).toMatchObject({ disabled: true, title: reason });
    expect(
      document.querySelector<HTMLButtonElement>('[aria-label="Delete feature"]'),
    ).toMatchObject({ disabled: true, title: reason });
    expect(document.body.textContent).toContain(reason);

    const merge = rowButton("Choose a branch to merge into main");
    expect(merge.disabled).toBe(false);
    await act(async () => merge.click());
    expect(rowButton("feature").disabled).toBe(false);
    await act(async () => rowButton("feature").click());
    expect(callbacks.onMergeInto).toHaveBeenCalledWith(
      expect.objectContaining({ name: "feature" }),
    );
    expect(callbacks.onSelectBranch).not.toHaveBeenCalled();
  });

  it("disables merge with its reason while ordinary branch checkout remains available", async () => {
    const reason = "This environment does not support Git Manager stash and merge operations.";
    const callbacks = await renderDropdown([branch("feature")], {
      mergeDisabledReason: reason,
    });

    const merge = rowButton("Choose a branch to merge into main");
    expect(merge).toMatchObject({ disabled: true, title: reason });
    expect(document.body.textContent).toContain(reason);
    expect(rowButton("feature").disabled).toBe(false);
    await act(async () => rowButton("feature").click());
    expect(callbacks.onSelectBranch).toHaveBeenCalledWith(
      expect.objectContaining({ name: "feature" }),
      false,
    );
  });

  it("offers remote checkout without local rename/delete actions, including matching local names", async () => {
    const remote = branch("origin/develop");
    useGitManagerStore.getState().setBranchFilterText(projectRef, "Develop");
    const callbacks = await renderDropdown([branch("origin/develop")], {
      remoteRefs: [remote, branch("upstream/develop"), branch("origin/main")],
    });

    expect(container.textContent).toContain("Remote branches");
    expect(container.textContent).not.toContain("origin/main");
    expect(container.querySelectorAll('[aria-label="Rename origin/develop"]')).toHaveLength(1);
    expect(container.querySelectorAll('[aria-label="Delete origin/develop"]')).toHaveLength(1);
    expect(container.querySelector('[aria-label="Rename upstream/develop"]')).toBeNull();
    const remoteButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Check out remote branch origin/develop"]',
    );
    expect(remoteButton).not.toBeNull();
    await act(async () => remoteButton!.click());
    expect(callbacks.onSelectBranch).toHaveBeenCalledWith(remote, true);

    await act(async () => rowButton("Choose a branch to merge into main").click());
    expect(container.textContent).not.toContain("Remote branches");
  });
});
