// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - Replay the browser reader against real rendered card markup.
import * as NodeVM from "node:vm";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { resolveWorktreeCreateInput } from "../CreateWorktreeDialog.logic.ts";
import { shouldShowWorkspaceBranchText, WORKSPACE_CARD_STATUS } from "../Sidebar.logic.ts";
import {
  WorkspaceCardBranchLine,
  WorkspaceCardShell,
  WorkspaceCardTitleLine,
  workspaceCardIds,
} from "./WorkspaceCard.tsx";
import { resolveWorkspaceCardBranchTooltip } from "./workspaceCard.logic";

// Execute only the actual self-contained browser reader. Importing the desktop
// module would pull its unrelated Git owner into the web TypeScript project.
const workspaceSource = NodeFS.readFileSync(
  NodePath.resolve(
    import.meta.dirname,
    "../../../../desktop/e2e/support/delivery-retry-workspace.ts",
  ),
  "utf8",
);
const readerStart = workspaceSource.indexOf("export function readSelectedDeliveryWorktree(");
if (readerStart < 0) throw new Error("The qualification browser reader is missing.");
const readerSource = NodeModule.stripTypeScriptTypes(
  workspaceSource.slice(readerStart).replace("export function", "function") +
    "\nreadSelectedDeliveryWorktree",
);

function renderCard(branch: string, title: string, id = "owned-thread") {
  const ids = workspaceCardIds("owned-card");
  const showBranch = shouldShowWorkspaceBranchText(branch, title);
  const noop = () => {};
  document.body.innerHTML = renderToStaticMarkup(
    <WorkspaceCardShell
      testId={`thread-row-${id}`}
      buttonTestId={`thread-card-button-${id}`}
      className=""
      idBase="owned-card"
      isActive
      hasFlags={false}
      hasBranchLine={showBranch}
      hasSessionLine={false}
      status={WORKSPACE_CARD_STATUS.idle}
      onClick={noop}
      onContextMenu={noop}
      onButtonKeyDown={noop}
    >
      <WorkspaceCardTitleLine
        id={ids.title}
        flagsId={ids.flags}
        title={title}
        titleTestId={`thread-title-${id}`}
        unread={false}
        pinned={false}
      />
      {showBranch ? (
        <WorkspaceCardBranchLine
          id={ids.branch}
          branch={branch}
          branchTooltip={`Worktree: selected (${branch})`}
        />
      ) : null}
    </WorkspaceCardShell>,
  );
  return ids;
}

// Exercise the real first-send title transition without mounting a live chat or
// replacing the metadata policy with a guessed fixture title.
const chatSource = NodeFS.readFileSync(
  NodePath.resolve(import.meta.dirname, "../ChatView.tsx"),
  "utf8",
);
const firstStart = chatSource.indexOf("      const isFirstMessage =");
const firstEnd = chatSource.indexOf(";", firstStart) + 1;
const titleStart = chatSource.indexOf("      let titleSeed = trimmed;");
const titleEnd = chatSource.indexOf("      if (failure === null && isServerThread)", titleStart);
if (firstStart < 0 || firstEnd <= firstStart || titleStart < 0 || titleEnd <= titleStart)
  throw new Error("The first-send title transition is missing.");

async function firstSendTitle(title: string, prompt: string) {
  let updatedTitle = title;
  const run = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      "async function autoTitle() {\n" +
        chatSource.slice(firstStart, firstEnd) +
        "\n" +
        chatSource.slice(titleStart, titleEnd) +
        "\n}\nautoTitle",
    ),
    {
      isServerThread: true,
      activeThread: { id: "owned-thread", title, messages: [], worktreePath: "/owned/worktree" },
      trimmed: prompt,
      composerAttachmentsSnapshot: [],
      composerTerminalContextsSnapshot: [],
      composerElementContextsSnapshot: [],
      truncate: (value: string) => value,
      ctxSelectedModelSelection: { instanceId: "claudeAgent", model: "opus" },
      environmentId: "local",
      threadIdForSend: "owned-thread",
      updateThreadMetadata: async (command: {
        environmentId: string;
        input: { threadId: string; title: string };
      }) => {
        expect(command).toEqual({
          environmentId: "local",
          input: { threadId: "owned-thread", title: prompt },
        });
        updatedTitle = command.input.title;
        return { _tag: "Success" };
      },
    },
  ) as () => Promise<void>;
  await run();
  return updatedTitle;
}

it.each(["light", "dark"])(
  "binds a real rendered %s card with a distinct fixture title and unchanged Git branch",
  (theme) => {
    const branch = `codex/delivery-retry-${theme}`;
    const title = `codex/delivery retry ${theme}`;
    const resolution = resolveWorktreeCreateInput({
      mode: "smart",
      nameText: title,
      selectedBranchRefName: null,
      githubItem: null,
      advancedBaseBranchOverride: null,
      defaultBaseBranch: "main",
    });
    expect(resolution).toMatchObject({ title, branchName: branch, newRefName: branch });
    const id = "owned-thread";
    const ids = workspaceCardIds("owned-card");
    const read = NodeVM.runInNewContext(readerSource, {
      document,
      location: {
        origin: "http://127.0.0.1:4885",
        pathname: "/local/" + id,
        search: "",
        hash: "",
      },
    });
    try {
      for (const renderedTitle of [branch, title, "foreign title"]) {
        renderCard(branch, renderedTitle, id);
        expect(document.getElementById(ids.branch) !== null).toBe(renderedTitle !== branch);
        expect(read({ origin: "http://127.0.0.1:4885", branch, boundThreadId: null })).toEqual(
          renderedTitle === title ? { threadId: id } : null,
        );
      }
    } finally {
      document.body.replaceChildren();
    }
  },
);

it.each(["light", "dark"])(
  "keeps a real rendered %s card bound through first-send auto-title and refuses replacement or lost proof",
  async (theme) => {
    const origin = "http://127.0.0.1:4885";
    const branch = `codex/delivery-retry-${theme}`;
    const location = { origin, pathname: "/local/owned-thread", search: "", hash: "" };
    const read = NodeVM.runInNewContext(readerSource, { document, location });
    try {
      renderCard(branch, `codex/delivery retry ${theme}`);
      const initial = read({ origin, branch, boundThreadId: null });
      expect(initial).toEqual({ threadId: "owned-thread" });
      const title = await firstSendTitle(
        `codex/delivery retry ${theme}`,
        `delivery baseline ${theme}`,
      );
      expect(title).toBe(`delivery baseline ${theme}`);
      renderCard(branch, title);
      expect(read({ origin, branch, boundThreadId: null })).toBeNull();
      expect(read({ origin, branch, boundThreadId: initial.threadId })).toEqual({
        threadId: "owned-thread",
      });
      expect(read({ origin, branch })).toBeNull();
      for (const boundThreadId of [
        undefined,
        "",
        "other-thread",
        "owned thread",
        "x".repeat(129),
        42,
        false,
        {},
        [],
      ])
        expect(read({ origin, branch, boundThreadId })).toBeNull();

      for (const refusal of [
        "replaced",
        "malformed-selected-id",
        "no-selection",
        "multiple",
        "wrong-route",
        "wrong-origin",
        "search",
        "hash",
        "wrong-branch",
        "duplicate-title",
        "missing-description",
        "ambiguous-description",
        "missing-branch-trigger",
      ]) {
        const ids = renderCard(branch, title);
        Object.assign(location, { origin, pathname: "/local/owned-thread", search: "", hash: "" });
        const card = document.querySelector('[data-testid="thread-card-button-owned-thread"]')!;
        if (refusal === "replaced" || refusal === "malformed-selected-id") {
          const id = refusal === "replaced" ? "other-thread" : "invalid/thread";
          renderCard(branch, title, id);
          location.pathname = "/local/" + id;
        }
        if (refusal === "no-selection") card.removeAttribute("aria-current");
        if (refusal === "multiple") document.body.appendChild(card.cloneNode(true));
        if (refusal === "wrong-route") location.pathname = "/local/other-thread";
        if (refusal === "wrong-origin") location.origin = "http://localhost:4885";
        if (refusal === "search") location.search = "?private=value";
        if (refusal === "hash") location.hash = "#private";
        if (refusal === "wrong-branch") renderCard("codex/other", title);
        if (refusal === "duplicate-title") renderCard(branch, branch);
        if (refusal === "missing-description") card.removeAttribute("aria-describedby");
        if (refusal === "ambiguous-description")
          card.setAttribute("aria-describedby", ids.branch + " other-branch");
        if (refusal === "missing-branch-trigger")
          document.getElementById(ids.branch)!.replaceChildren();
        expect(read({ origin, branch, boundThreadId: initial.threadId }), refusal).toBeNull();
      }
    } finally {
      document.body.replaceChildren();
    }
  },
);

// Mount the real card and pinned BaseUI. Static markup and mocked tooltips cannot
// exercise the controller's actual popup selector, text or hover lifecycle.
const controllerSource = NodeFS.readFileSync(
  NodePath.resolve(import.meta.dirname, "../../../../desktop/e2e/qualify-delivery-retry.ts"),
  "utf8",
);
const tooltipStart = controllerSource.indexOf('    step("worktree-visible-path");');
const tooltipEnd = controllerSource.indexOf(
  '    await selectClaudeModel("worktree");',
  tooltipStart,
);
if (tooltipStart < 0 || tooltipEnd <= tooltipStart)
  throw new Error("The qualification tooltip seam is missing.");
const tooltipSource = NodeModule.stripTypeScriptTypes(
  "async function replay() {\n" + controllerSource.slice(tooltipStart, tooltipEnd) + "\n}\nreplay",
);

describe.each(["light", "dark"])("actual mounted %s card tooltip qualification", (theme) => {
  it.each([
    "visible",
    "wrong-path",
    "wrong-branch",
    "hidden",
    "move-only",
    "enter-only",
    "touch",
    "foreign-text-node",
  ])("keeps visible exact path and branch proof mandatory: %s", async (scenario) => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    // happy-dom has no layout. Control only the existing visibility predicate;
    // card markup, hover state, portal and popup content are actual source.
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
      function (this: HTMLElement) {
        return (scenario === "hidden" && this.matches('[data-slot="tooltip-popup"]')
          ? []
          : [{ width: 120, height: 24 }]) as unknown as DOMRectList;
      },
    );
    const branch = `codex/delivery-retry-${theme}`;
    const path = "/owned/run/worktrees/selected";
    const threadId = "owned-thread";
    const ids = workspaceCardIds("owned-card");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const noop = () => {};
    try {
      await act(async () =>
        root.render(
          <WorkspaceCardShell
            testId={`thread-row-${threadId}`}
            buttonTestId={`thread-card-button-${threadId}`}
            className=""
            idBase="owned-card"
            isActive
            hasFlags={false}
            hasBranchLine
            hasSessionLine={false}
            status={WORKSPACE_CARD_STATUS.idle}
            onClick={noop}
            onContextMenu={noop}
            onButtonKeyDown={noop}
          >
            <WorkspaceCardTitleLine
              id={ids.title}
              flagsId={ids.flags}
              title={branch.replaceAll("-", " ")}
              titleTestId={`thread-title-${threadId}`}
              unread={false}
              pinned={false}
            />
            <WorkspaceCardBranchLine
              id={ids.branch}
              branch={branch}
              branchTooltip={resolveWorkspaceCardBranchTooltip({
                branch: scenario === "wrong-branch" ? "codex/other" : branch,
                worktreePath: scenario === "wrong-path" ? "/owned/other" : path,
                checkoutPath: null,
              })}
            />
          </WorkspaceCardShell>,
        ),
      );
      if (scenario === "foreign-text-node") {
        const foreign = document.createElement("span");
        foreign.textContent = `Worktree: selected (${branch})`;
        container.append(foreign);
      }
      const browser = {
        $: (selector: string) => ({
          moveTo: async () => {
            expect(selector).toBe(
              `[data-testid="thread-row-${threadId}"] [id$="-branch"] [data-slot="tooltip-trigger"]`,
            );
            const target = document.querySelector(selector)!;
            expect(target).not.toBeNull();
            await act(async () => {
              if (scenario !== "move-only" && scenario !== "foreign-text-node") {
                target.dispatchEvent(
                  new PointerEvent("pointerover", {
                    bubbles: true,
                    pointerType: scenario === "touch" ? "touch" : "mouse",
                  }),
                );
                target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
                target.dispatchEvent(new MouseEvent("mouseenter"));
              }
              if (scenario !== "enter-only")
                target.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
              await vi.advanceTimersByTimeAsync(700);
            });
          },
        }),
        execute: async (reader: (value: string) => boolean, value: string) => reader(value),
      };
      const replay = NodeVM.runInNewContext(tooltipSource, {
        b: () => browser,
        step: () => {},
        branch,
        threadId,
        identity: { path },
        NodePath,
        document,
        owner: {
          until: async (read: () => Promise<boolean>) => {
            if (!(await read())) throw new Error("Tooltip observation refused.");
          },
        },
      }) as () => Promise<void>;
      if (scenario === "visible") {
        await expect(replay()).resolves.toBeUndefined();
      } else {
        await expect(replay()).rejects.toThrow("Tooltip observation refused.");
      }
      const popup = document.querySelector('[data-slot="tooltip-popup"]');
      if (["visible", "wrong-path", "wrong-branch", "hidden"].includes(scenario)) {
        expect(popup).not.toBeNull();
        expect(popup?.textContent?.trim()).toBe(
          scenario === "wrong-branch"
            ? "Worktree: selected (codex/other)"
            : `Worktree: ${scenario === "wrong-path" ? "other" : "selected"} (${branch})`,
        );
      } else {
        expect(popup).toBeNull();
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
