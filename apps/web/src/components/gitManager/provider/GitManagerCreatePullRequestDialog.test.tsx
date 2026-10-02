// @vitest-environment happy-dom

import type {
  GitActionProgressEvent,
  GitManagerCommitEntry,
  GitRunStackedActionResult,
  VcsStatusResult,
} from "@bibcode/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type RunInput = {
  actionId: string;
  action: string;
  pullRequestTitle?: string;
  pullRequestBody?: string;
  pullRequestBaseBranch?: string;
  pullRequestHeadBranch?: string;
  onProgress?: (event: GitActionProgressEvent) => void;
};

const h = vi.hoisted(() => ({
  status: null as unknown,
  latestCommit: null as unknown,
  otherCommit: null as unknown,
  branchSelectionSupported: true as boolean | undefined,
  currentSourceRemote: true,
  refsError: null as string | null,
  refPages: null as Array<string[]> | null,
  refreshStatus: vi.fn(),
  runs: [] as Array<RunInput>,
  script: [] as Array<
    | { readonly events: ReadonlyArray<GitActionProgressEvent>; readonly outcome: "success" }
    | {
        readonly events: ReadonlyArray<GitActionProgressEvent>;
        readonly outcome: "failure";
        readonly message: string;
      }
    | { readonly events: ReadonlyArray<GitActionProgressEvent>; readonly outcome: "hang" }
  >,
}));

vi.mock("~/state/vcs", () => ({
  vcsEnvironment: {
    status: vi.fn(() => ({ kind: "status" })),
    listRefs: vi.fn(({ input }: { input: { cursor: number } }) => ({
      kind: "refs",
      cursor: input.cursor,
    })),
    refreshStatus: {},
  },
}));

vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => h.refreshStatus }));

vi.mock("~/state/entities", () => ({
  useServerConfigs: () =>
    new Map(
      ["env-a", "env-b"].map((id) => [
        id,
        {
          environment: {
            capabilities: { gitPullRequestBranchSelection: h.branchSelectionSupported },
          },
        },
      ]),
    ),
}));

vi.mock("~/state/gitManager", () => ({
  gitManagerEnvironment: {
    getRefs: vi.fn(() => ({ kind: "snapshot" })),
    getCommits: vi.fn(({ input }: { input: { pinnedTips?: string[] } }) => ({
      kind: "commits",
      tip: input.pinnedTips?.[0],
    })),
  },
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: { kind: string; cursor?: number; tip?: string } | null) => ({
    data:
      atom?.kind === "status"
        ? h.status
        : atom?.kind === "commits"
          ? {
              commits:
                atom.tip === "b".repeat(40)
                  ? h.latestCommit === null
                    ? []
                    : [h.latestCommit]
                  : atom.tip === "c".repeat(40)
                    ? [h.otherCommit]
                    : [commit("Wrong branch title", "Wrong branch description")],
            }
          : atom?.kind === "snapshot"
            ? {
                localBranches: [
                  { name: (h.status as VcsStatusResult | null)?.refName, tipSha: "b".repeat(40) },
                  { name: "feature/other", tipSha: "c".repeat(40) },
                ],
                remoteBranches: [
                  ...(h.currentSourceRemote
                    ? [
                        {
                          name: `origin/${(h.status as VcsStatusResult | null)?.refName}`,
                          tipSha: "b".repeat(40),
                        },
                      ]
                    : []),
                  { name: "origin/feature/other", tipSha: "c".repeat(40) },
                ],
              }
            : atom?.kind === "refs"
              ? {
                  refs: (
                    h.refPages?.[(atom.cursor ?? 0) / 100] ?? [
                      "main",
                      "release/next",
                      "origin/main",
                      "origin/release/next",
                      "feature/reviewed",
                      "feature/other",
                      "origin/feature/reviewed",
                      "origin/feature/other",
                      "origin/remote-only",
                      "other/hidden",
                    ]
                  ).map((name) => ({
                    name,
                    isRemote: name.startsWith("origin/") || name.startsWith("other/"),
                    remoteName: name.startsWith("origin/") ? "origin" : "other",
                  })),
                  nextCursor:
                    h.refPages && (atom.cursor ?? 0) / 100 < h.refPages.length - 1
                      ? (atom.cursor ?? 0) + 100
                      : null,
                }
              : null,
    emission: { _tag: "Initial", waiting: false },
    error: atom?.kind === "refs" ? h.refsError : null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("~/state/sourceControlActions", () => ({
  useGitStackedAction: () => ({
    run: async (input: RunInput) => {
      h.runs.push(input);
      const step = h.script.shift();
      if (step === undefined) throw new Error("No scripted stacked-action outcome.");
      for (const event of step.events) input.onProgress?.(event);
      if (step.outcome === "hang") {
        return new Promise<never>(() => undefined);
      }
      if (step.outcome === "success") {
        const finished = step.events.at(-1);
        if (finished?.kind !== "action_finished") {
          throw new Error("A successful script must end with action_finished.");
        }
        return AsyncResult.success(finished.result);
      }
      return AsyncResult.failure(Cause.fail(new Error(step.message)));
    },
    isPending: false,
    error: null,
  }),
}));

vi.mock("~/lib/utils", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, randomUUID: () => `action-${String(h.runs.length + 1)}` };
});

import {
  GitManagerCreatePullRequestDialog,
  type GitManagerCreatePullRequestDialogProps,
} from "./GitManagerCreatePullRequestDialog";
import type { CreatePullRequestProviderHint } from "./GitManagerPullRequestPanel.logic";
import { vcsEnvironment } from "~/state/vcs";

let container: HTMLDivElement;
let root: Root;
const suiteGetAnimationsDescriptor = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "getAnimations",
);
let originalGetAnimationsDescriptor: PropertyDescriptor | undefined;

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    sourceControlProvider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/reviewed",
    defaultRefName: "main",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  } as VcsStatusResult;
}

function commit(subject: string, body = ""): GitManagerCommitEntry {
  return {
    sha: "b".repeat(40),
    shortSha: "bbbbbbb",
    parents: [],
    decorations: [],
    subject,
    body,
    authorName: "Local",
    authorEmail: "local@example.test",
    authoredAtMs: 1,
    committerName: "Local",
    committerEmail: "local@example.test",
    committedAtMs: 1,
    changedFiles: [],
  };
}

const base = { actionId: "action-1", cwd: "/repo", action: "create_pr" } as const;

function finished(prStatus: "created" | "opened_existing"): GitActionProgressEvent {
  const result: GitRunStackedActionResult = {
    action: "create_pr",
    branch: { status: "skipped_not_requested" },
    commit: { status: "skipped_not_requested" },
    push: { status: "pushed", branch: "feature/reviewed" },
    pr: {
      status: prStatus,
      url: "https://github.com/owner/name/pull/7",
      number: 7,
      baseBranch: "main",
      headBranch: "feature/reviewed",
      title: "Reviewed",
    },
    toast: { title: "Git action completed", cta: { kind: "none" } },
  };
  return { ...base, kind: "action_finished", result };
}

async function renderDialog(
  onSettled = vi.fn(),
  onOpenChange = vi.fn(),
  providerHint: CreatePullRequestProviderHint | null = null,
  overrides: Partial<GitManagerCreatePullRequestDialogProps> = {},
) {
  await act(async () =>
    root.render(
      <GitManagerCreatePullRequestDialog
        open
        scope={{ environmentId: "env-a" as never, cwd: "/repo" }}
        onOpenChange={onOpenChange}
        onSettled={onSettled}
        providerHint={providerHint}
        {...overrides}
      />,
    ),
  );
  return { onSettled, onOpenChange };
}

function button(text: string): HTMLButtonElement {
  const result = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!(result instanceof HTMLButtonElement)) throw new Error(`Missing button: ${text}`);
  return result;
}

function text(testId: string): string {
  return document.querySelector(`[data-testid="${testId}"]`)?.textContent?.trim() ?? "";
}

function input(id: string): HTMLInputElement | HTMLTextAreaElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    throw new Error(`Missing field: ${id}`);
  }
  return element;
}

async function setValue(id: string, value: string) {
  await act(async () => {
    const field = input(id);
    const prototype =
      field instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function fieldButton(id: string, slot: string) {
  return input(id)
    .closest('[data-slot="input-control"]')
    ?.parentElement?.querySelector<HTMLButtonElement>(`[data-slot="${slot}"]`);
}

async function chooseBranch(id: string, branch: string) {
  await act(async () => {
    input(id).focus();
    fieldButton(id, "combobox-trigger")?.click();
  });
  await setValue(id, branch);
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (item) => item.textContent?.trim() === branch,
  );
  if (!option) throw new Error(`Missing branch option: ${branch}`);
  await act(async () => option.click());
}

const chooseTarget = (branch: string) => chooseBranch("git-manager-create-pr-base", branch);
const chooseSource = (branch: string) => chooseBranch("git-manager-create-pr-head", branch);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  originalGetAnimationsDescriptor = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "getAnimations",
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  h.status = status();
  h.latestCommit = commit("feat: reviewed change", "Body from commit");
  h.otherCommit = {
    ...commit("Other branch change", "Other branch description"),
    sha: "c".repeat(40),
  };
  h.branchSelectionSupported = true;
  h.currentSourceRemote = true;
  h.refsError = null;
  h.refPages = null;
  h.refreshStatus.mockReset().mockImplementation(async () => AsyncResult.success(h.status));
  h.runs = [];
  h.script = [];
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.replaceChildren();
  if (originalGetAnimationsDescriptor) {
    Object.defineProperty(Element.prototype, "getAnimations", originalGetAnimationsDescriptor);
  } else {
    Reflect.deleteProperty(Element.prototype, "getAnimations");
  }
  originalGetAnimationsDescriptor = undefined;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

afterAll(() => {
  expect(Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations")).toEqual(
    suiteGetAnimationsDescriptor,
  );
});

describe("GitManagerCreatePullRequestDialog", () => {
  it.each(["git-manager-create-pr-head", "git-manager-create-pr-base"])(
    "offers only origin branches in %s, even when the response includes local refs",
    async (id) => {
      h.refPages = [
        ["local-only", "main", "origin/main", "origin/release/next", "origin/HEAD", "other/hidden"],
      ];
      await renderDialog();
      await act(async () => fieldButton(id, "combobox-trigger")?.click());
      await setValue(id, "");
      expect(
        [...document.querySelectorAll('[role="option"]')].map((option) =>
          option.textContent?.trim(),
        ),
      ).toEqual(["main", "release/next"]);
      expect(vcsEnvironment.listRefs).toHaveBeenLastCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({ refKind: "remote", includeMatchingRemoteRefs: true }),
        }),
      );
      expect(h.runs).toEqual([]);
    },
  );

  it("leaves a local-only checkout unselected until a remote source is chosen", async () => {
    h.currentSourceRemote = false;
    await renderDialog();
    expect(input("git-manager-create-pr-head").value).toBe("");
    expect(text("create-pr-status")).toBe("Select a source branch.");
    await chooseTarget("main");
    expect(button("Publish and create pull request").disabled).toBe(true);
    await chooseSource("feature/other");
    expect(input("git-manager-create-pr-base").value).toBe("");
    await chooseTarget("main");
    expect(button("Publish and create pull request").disabled).toBe(false);
    expect(h.runs).toEqual([]);
  });

  it.each([false, undefined])(
    "blocks creation if a reconnected server lacks branch selection (%s)",
    async (supported) => {
      await renderDialog();
      await chooseTarget("main");
      h.branchSelectionSupported = supported;
      await renderDialog();
      const primary = button("Publish and create pull request");
      expect(primary.disabled).toBe(true);
      expect(document.querySelector('[data-slot="dialog-description"]')?.textContent).toContain(
        "Update this environment's BiBCode server",
      );
      await act(async () => primary.click());
      expect(h.runs).toEqual([]);
    },
  );

  it("selects a different source without borrowing the checkout's request or commit", async () => {
    h.status = status({
      hasWorkingTreeChanges: true,
      pr: {
        state: "open",
        number: 8,
        title: "Checkout request",
        url: "https://github.com/org/repo/pull/8",
        headRef: "feature/reviewed",
        baseRef: "main",
      },
    });
    await renderDialog();
    expect(input("git-manager-create-pr-head").value).toBe("feature/reviewed");
    expect(input("git-manager-create-pr-head").disabled).toBe(false);
    await chooseSource("feature/other");
    expect(input("git-manager-create-pr-title").value).toBe("Other branch change");
    expect(input("git-manager-create-pr-body").value).toBe("Other branch description");
    expect(text("create-pr-existing")).toBe("");
    await chooseTarget("release/next");
    h.script = [{ outcome: "success", events: [finished("created")] }];
    await act(async () => button("Publish and create pull request").click());
    expect(h.runs[0]).toMatchObject({
      pullRequestHeadBranch: "feature/other",
      pullRequestBaseBranch: "release/next",
    });
  });

  it("preserves edited content and requires a new target when the source changes", async () => {
    await renderDialog();
    await chooseTarget("main");
    await setValue("git-manager-create-pr-title", "My request");
    await setValue("git-manager-create-pr-body", "My description");
    await chooseSource("remote-only");
    expect(input("git-manager-create-pr-base").value).toBe("");
    expect(input("git-manager-create-pr-title").value).toBe("My request");
    expect(input("git-manager-create-pr-body").value).toBe("My description");
    expect(button("Publish and create pull request").disabled).toBe(true);
    await chooseTarget("main");
    await setValue("git-manager-create-pr-head", "typed-but-not-selected");
    expect(button("Publish and create pull request").disabled).toBe(true);
    expect(h.runs).toEqual([]);
  });

  it("tracks a changed checkout until a different source is explicitly selected", async () => {
    await renderDialog();
    await chooseTarget("main");
    h.status = status({ refName: "release/next" });
    await renderDialog();
    expect(input("git-manager-create-pr-head").value).toBe("release/next");
    expect(input("git-manager-create-pr-base").value).toBe("");
    await chooseSource("feature/other");
    await chooseTarget("main");
    h.status = status({ refName: "main" });
    await renderDialog();
    expect(input("git-manager-create-pr-head").value).toBe("feature/other");
    expect(input("git-manager-create-pr-base").value).toBe("main");
  });

  it("allows choosing a remote target beyond the first page", async () => {
    h.refPages = [Array.from({ length: 100 }, (_, i) => `origin/release-${i}`), ["origin/release"]];
    await renderDialog();
    await act(async () => fieldButton("git-manager-create-pr-base", "combobox-trigger")?.click());
    expect(document.querySelector('[role="option"]')?.textContent).toContain("release-");
    await act(async () => button("Next branches").click());
    const target = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent?.trim() === "release",
    );
    expect(target).toBeDefined();
    await act(async () => target?.click());
    expect(input("git-manager-create-pr-base").value).toBe("release");
    expect(button("Publish and create pull request").disabled).toBe(false);
  });

  it("resumes publication after a combined action committed on a new feature branch", async () => {
    h.status = status({ refName: "main", hasWorkingTreeChanges: true });
    const props = { commitInput: { featureBranch: true, commitMessage: "Feature work" } };
    await renderDialog(vi.fn(), vi.fn(), null, props);
    await chooseTarget("release/next");
    h.script = [
      {
        outcome: "failure",
        message: "publish failed",
        events: [{ ...base, kind: "action_failed", phase: null, message: "publish failed" }],
      },
      { outcome: "success", events: [finished("created")] },
    ];
    await act(async () => button("Commit, publish and create pull request").click());
    h.status = status({ refName: "feature/work", hasWorkingTreeChanges: false });
    await renderDialog(vi.fn(), vi.fn(), null, props);
    expect(input("git-manager-create-pr-base").value).toBe("");
    await chooseTarget("release/next");
    await act(async () => button("Retry").click());
    expect(h.refreshStatus).toHaveBeenCalledWith({
      environmentId: "env-a",
      input: { cwd: "/repo" },
    });
    expect(h.runs).toHaveLength(2);
    expect(h.runs[1]).toMatchObject({ action: "create_pr", pullRequestBaseBranch: "release/next" });
    expect(h.runs[1]).not.toHaveProperty("featureBranch");
    expect(h.runs[1]).not.toHaveProperty("commitMessage");
  });

  it("does not publish an externally checked-out branch discovered during Retry", async () => {
    h.status = status({ refName: "main", hasWorkingTreeChanges: true });
    const props = { commitInput: { featureBranch: true } };
    await renderDialog(vi.fn(), vi.fn(), null, props);
    await chooseTarget("release/next");
    h.script = [
      {
        outcome: "failure",
        message: "failed",
        events: [{ ...base, kind: "action_failed", phase: null, message: "failed" }],
      },
    ];
    await act(async () => button("Commit, publish and create pull request").click());
    h.refreshStatus.mockResolvedValueOnce(AsyncResult.success(status({ refName: "unrelated" })));
    await act(async () => button("Retry").click());
    expect(h.runs).toHaveLength(1);
    expect(input("git-manager-create-pr-base").value).toBe("");
    expect(text("create-pr-status")).toContain("The source branch changed");
    expect(button("Retry").disabled).toBe(true);
  });

  it("requires an explicit target selection and clearing or typing revokes it", async () => {
    await renderDialog();
    const primary = () => button("Publish and create pull request");
    expect(primary().disabled).toBe(true);
    expect(primary().title).toBe("Select a target branch.");
    await act(async () => primary().click());
    expect(h.runs).toEqual([]);
    await setValue("git-manager-create-pr-base", "main");
    expect(primary().disabled).toBe(true);
    await chooseTarget("main");
    expect(primary().disabled).toBe(false);
    await act(async () => fieldButton("git-manager-create-pr-base", "combobox-clear")?.click());
    expect(primary().disabled).toBe(true);
    await chooseTarget("release/next");
    await setValue("git-manager-create-pr-base", "main");
    expect(primary().disabled).toBe(true);
    expect(h.runs).toEqual([]);
  });

  it("requires a new selection after reopening or changing repositories", async () => {
    await renderDialog();
    await chooseTarget("main");
    await renderDialog(vi.fn(), vi.fn(), null, { open: false });
    await renderDialog();
    expect(input("git-manager-create-pr-base").value).toBe("");
    await chooseTarget("release/next");
    await renderDialog(vi.fn(), vi.fn(), null, {
      scope: { environmentId: "env-b" as never, cwd: "/other" },
    });
    expect(input("git-manager-create-pr-base").value).toBe("");
    expect(button("Publish and create pull request").disabled).toBe(true);
  });

  it("reviews the target before committing and publishing a combined action", async () => {
    h.status = status({ hasWorkingTreeChanges: true });
    h.currentSourceRemote = false;
    await renderDialog(vi.fn(), vi.fn(), null, {
      commitInput: { commitMessage: "Reviewed commit", commitStagedIndexAsIs: true },
    });
    expect(h.runs).toEqual([]);
    expect(input("git-manager-create-pr-head").value).toBe("feature/reviewed");
    expect(input("git-manager-create-pr-head").disabled).toBe(true);
    expect(button("Commit, publish and create pull request").disabled).toBe(true);
    await chooseTarget("release/next");
    h.script = [{ outcome: "success", events: [finished("created")] }];
    await act(async () => button("Commit, publish and create pull request").click());
    expect(h.runs[0]).toMatchObject({
      action: "commit_push_pr",
      commitMessage: "Reviewed commit",
      commitStagedIndexAsIs: true,
      pullRequestBaseBranch: "release/next",
    });
  });

  it("keeps the review content in one padded panel with a separate publish callout", async () => {
    await renderDialog();

    const popup = document.querySelector('[data-testid="git-manager-create-pr-dialog"]');
    const panel = popup?.querySelector('[data-slot="dialog-panel"]');
    const summary = panel?.querySelector('[data-testid="create-pr-summary"]');
    const publish = panel?.querySelector('[data-testid="create-pr-publish"]');

    expect(popup?.className).toContain("max-w-xl");
    expect(panel).not.toBeNull();
    expect(summary?.getAttribute("aria-label")).toBe("Pull request details");
    expect(summary?.textContent).toContain("GitHub · https://github.com");
    expect(input("git-manager-create-pr-head").value).toBe("feature/reviewed");
    expect(
      [...summary!.querySelectorAll("dt")].map((label) =>
        label.classList.contains("whitespace-nowrap"),
      ),
    ).toEqual([true]);
    expect(publish?.parentElement).toBe(panel);
    expect(panel?.contains(input("git-manager-create-pr-title"))).toBe(true);
    expect(panel?.contains(input("git-manager-create-pr-body"))).toBe(true);
  });

  it("reviews repository, base, head, publish requirement, and commit defaults without running", async () => {
    await renderDialog();

    expect(h.runs).toEqual([]);
    expect(text("create-pr-repository")).toBe("GitHub · https://github.com");
    expect(input("git-manager-create-pr-base").value).toBe("");
    expect(input("git-manager-create-pr-head").value).toBe("feature/reviewed");
    expect(text("create-pr-publish")).toContain("will be published first");
    expect(input("git-manager-create-pr-title").value).toBe("feat: reviewed change");
    expect(input("git-manager-create-pr-body").value).toBe("Body from commit");
    expect(button("Publish and create pull request").disabled).toBe(true);
  });

  it("says merge request and shows the self-hosted GitLab address", async () => {
    h.status = status({
      sourceControlProvider: {
        kind: "gitlab",
        name: "GitLab",
        baseUrl: "https://luna.tripunkt.de",
      },
    });
    await renderDialog();

    expect(document.body.textContent).toContain("Create merge request");
    expect(document.body.textContent).toContain(
      "Review the merge request before anything is published.",
    );
    expect(text("create-pr-repository")).toBe("GitLab · https://luna.tripunkt.de");
    expect(
      document.querySelector('[data-testid="create-pr-summary"]')?.getAttribute("aria-label"),
    ).toBe("Merge request details");
    expect(button("Publish and create merge request").disabled).toBe(true);
  });

  it("tells an unidentified host how to get identified, and asks for a missing origin", async () => {
    h.status = status({ sourceControlProvider: undefined });
    await renderDialog();
    const reason =
      "BiBCode hasn't identified this repository's host yet. Open Pull Requests for this project or run Rescan in Settings → Source Control.";
    expect(text("create-pr-repository")).toBe("Not identified yet");
    expect(text("create-pr-status")).toBe(reason);
    const blocked = button("Publish and create pull request");
    expect(blocked.disabled).toBe(true);
    // A disabled button gets no pointer events: its wrapper carries the tooltip, and
    // assistive technology reads the reason through aria-describedby.
    expect(blocked.parentElement?.getAttribute("title")).toBe(reason);
    const described = document.getElementById(blocked.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toBe(reason);

    h.status = status({ sourceControlProvider: undefined, hasPrimaryRemote: false });
    h.currentSourceRemote = false;
    await renderDialog();
    expect(text("create-pr-repository")).toBe("No origin remote");
    expect(text("create-pr-status")).toBe("Add an origin remote to create a pull request.");
    expect(h.runs).toEqual([]);
  });

  it("uses shared change-request wording for an explicitly unknown provider", async () => {
    h.status = status({
      sourceControlProvider: { kind: "unknown", name: "forge", baseUrl: "https://forge.test" },
      hasWorkingTreeChanges: true,
    });
    await renderDialog();
    expect(document.body.textContent).toContain("Create change request");
    expect(button("Publish and create change request").disabled).toBe(true);
    expect(text("create-pr-status")).toBe("Commit local changes before creating a change request.");
  });

  it("stays neutral while reading status without a hint", async () => {
    h.status = null;
    await renderDialog();
    expect(document.body.textContent).toContain("Create change request");
    expect(document.body.textContent).toContain(
      "Review the change request before anything is published.",
    );
    expect(document.body.textContent).not.toContain("ull request");
    expect(
      document.querySelector('[data-testid="create-pr-summary"]')?.getAttribute("aria-label"),
    ).toBe("Change request details");
    expect(button("Create change request").parentElement?.getAttribute("title")).toBe(
      "Reading repository status…",
    );
    // Nothing is known about the branch yet either.
    expect(input("git-manager-create-pr-base").value).toBe("");
    expect(input("git-manager-create-pr-head").value).toBe("");

    h.status = status({
      sourceControlProvider: { kind: "gitlab", name: "GitLab", baseUrl: "https://gitlab.invalid" },
    });
    await renderDialog();
    expect(button("Publish and create merge request").disabled).toBe(true);
    expect(h.runs).toEqual([]);
  });

  it("shows the host Pull Requests identified while the status has not named it", async () => {
    const providerHint = { kind: "gitlab", baseUrl: "https://luna.tripunkt.de" } as const;
    h.status = null;
    await renderDialog(vi.fn(), vi.fn(), providerHint);
    expect(text("create-pr-repository")).toBe("GitLab · https://luna.tripunkt.de");
    expect(button("Create merge request").parentElement?.getAttribute("title")).toBe(
      "Reading repository status…",
    );

    h.status = status({ sourceControlProvider: undefined });
    await renderDialog(vi.fn(), vi.fn(), providerHint);
    expect(text("create-pr-repository")).toBe("GitLab · https://luna.tripunkt.de");
    // The server validates the provider when creating, so the review does not block.
    await chooseTarget("main");
    const primary = button("Publish and create merge request");
    expect(primary.disabled).toBe(false);
    expect(primary.getAttribute("aria-describedby")).toBeNull();
    expect(primary.parentElement?.getAttribute("title")).toBeNull();
  });

  it("requires a title and explains why creation is unavailable", async () => {
    await renderDialog();
    await setValue("git-manager-create-pr-title", "   ");
    const primary = button("Publish and create pull request");
    expect(primary.disabled).toBe(true);
    expect(primary.title).toBe("Enter a title for the pull request.");

    h.status = status({ hasWorkingTreeChanges: true, hasUpstream: true });
    await renderDialog();
    const blocked = button("Create pull request");
    expect(blocked.disabled).toBe(true);
    expect(blocked.title).toBe("Commit local changes before creating a pull request.");
    expect(text("create-pr-status")).toBe("Commit local changes before creating a pull request.");
    expect(h.runs).toEqual([]);
  });

  it("publishes and creates only on the explicit action, then reports the created pull request", async () => {
    const { onSettled } = await renderDialog();
    await chooseTarget("release/next");
    h.status = status({ defaultRefName: "master" });
    await renderDialog(onSettled);
    expect(input("git-manager-create-pr-base").value).toBe("release/next");
    await setValue("git-manager-create-pr-title", "Reviewed title");
    await setValue("git-manager-create-pr-body", "Reviewed body");
    h.script = [
      {
        outcome: "success",
        events: [
          { ...base, kind: "action_started", phases: ["push", "pr"] },
          { ...base, kind: "phase_started", phase: "push", label: "Pushing" },
          { ...base, kind: "phase_started", phase: "pr", label: "Creating pull request" },
          finished("created"),
        ],
      },
    ];

    await act(async () => button("Publish and create pull request").click());

    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]).toMatchObject({
      actionId: "action-1",
      action: "create_pr",
      pullRequestTitle: "Reviewed title",
      pullRequestBody: "Reviewed body",
      pullRequestBaseBranch: "release/next",
    });
    expect(text("create-pr-status")).toContain("Pull request #7 created.");
    expect(
      document.querySelector<HTMLAnchorElement>('[data-testid="create-pr-status"] a')?.href,
    ).toBe("https://github.com/owner/name/pull/7");
    expect(onSettled).toHaveBeenCalledOnce();
    expect(button("Done").disabled).toBe(false);
  });

  it("keeps a published branch visible after a creation failure and retries without duplicating", async () => {
    const { onSettled, onOpenChange } = await renderDialog();
    await chooseTarget("release/next");
    h.script = [
      {
        outcome: "failure",
        message: "transport lost",
        events: [
          { ...base, kind: "action_started", phases: ["push", "pr"] },
          { ...base, kind: "phase_started", phase: "push", label: "Pushing" },
          { ...base, kind: "phase_started", phase: "pr", label: "Creating pull request" },
          { ...base, kind: "action_failed", phase: "pr", message: "gh exited 1" },
        ],
      },
      {
        outcome: "success",
        events: [
          { ...base, kind: "action_started", phases: ["push", "pr"] },
          { ...base, kind: "phase_started", phase: "pr", label: "Creating pull request" },
          finished("opened_existing"),
        ],
      },
    ];

    await act(async () => button("Publish and create pull request").click());

    expect(text("create-pr-status")).toBe(
      "feature/reviewed was published, but creating the pull request failed: gh exited 1",
    );
    expect(onSettled).not.toHaveBeenCalled();
    expect(button("Cancel").disabled).toBe(false);

    await act(async () => button("Retry").click());

    expect(h.runs).toHaveLength(2);
    expect(h.runs[1]?.action).toBe("create_pr");
    expect(text("create-pr-status")).toContain(
      "Pull request #7 already exists for this branch, so none was created.",
    );
    expect(onSettled).toHaveBeenCalledOnce();

    await act(async () => button("Done").click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("retains the reviewed GitLab draft after a safely classified launch failure", async () => {
    h.status = status({
      sourceControlProvider: {
        kind: "gitlab",
        name: "GitLab",
        baseUrl: "https://gitlab.example.test",
      },
    });
    const { onSettled } = await renderDialog();
    await chooseTarget("release/next");
    await setValue("git-manager-create-pr-title", "Reviewed merge request");
    await setValue("git-manager-create-pr-body", "Keep this draft");
    const message =
      "Could not start glab: a required file or directory was not found (OS error 2). Check that the executable is available to this environment and that the repository folder is accessible.";
    h.script = [
      {
        outcome: "failure",
        message,
        events: [{ ...base, kind: "action_failed", phase: null, message }],
      },
    ];
    await act(async () => button("Publish and create merge request").click());
    expect(text("create-pr-status")).toContain(message);
    expect(input("git-manager-create-pr-head").value).toBe("feature/reviewed");
    expect(input("git-manager-create-pr-base").value).toBe("release/next");
    expect(input("git-manager-create-pr-title").value).toBe("Reviewed merge request");
    expect(input("git-manager-create-pr-body").value).toBe("Keep this draft");
    expect(button("Retry").disabled).toBe(false);
    expect(h.runs).toHaveLength(1);
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("cancels freely before starting and refuses to close while publishing", async () => {
    const { onOpenChange } = await renderDialog();
    await act(async () => button("Cancel").click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(h.runs).toEqual([]);

    onOpenChange.mockClear();
    await chooseTarget("main");
    h.script = [
      {
        outcome: "hang",
        events: [
          { ...base, kind: "action_started", phases: ["push", "pr"] },
          { ...base, kind: "phase_started", phase: "push", label: "Pushing" },
        ],
      },
    ];
    await act(async () => button("Publish and create pull request").click());

    expect(text("create-pr-status")).toBe("Publishing feature/reviewed…");
    const cancel = button("Cancel");
    expect(cancel.disabled).toBe(true);
    expect(cancel.title).toBe("Wait for the pull request to finish.");
    expect(button("Working…").disabled).toBe(true);
    expect(input("git-manager-create-pr-title").disabled).toBe(true);
    await act(async () => cancel.click());
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("shows an existing pull request and offers no creation", async () => {
    h.status = status({
      hasUpstream: true,
      pr: {
        number: 9,
        title: "Existing",
        url: "https://github.com/owner/name/pull/9",
        baseRef: "main",
        headRef: "feature/reviewed",
        state: "open",
      },
    });
    await renderDialog();

    expect(text("create-pr-existing")).toContain("Pull request #9 already exists");
    const primary = button("Create pull request");
    expect(primary.disabled).toBe(true);
    expect(primary.title).toBe("A pull request already exists for this branch.");
    expect(h.runs).toEqual([]);
  });
});
