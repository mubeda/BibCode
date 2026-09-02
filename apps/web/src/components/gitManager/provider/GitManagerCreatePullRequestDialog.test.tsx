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
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type RunInput = {
  actionId: string;
  action: string;
  pullRequestTitle?: string;
  pullRequestBody?: string;
  onProgress?: (event: GitActionProgressEvent) => void;
};

const h = vi.hoisted(() => ({
  status: null as unknown,
  latestCommit: null as unknown,
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
  vcsEnvironment: { status: vi.fn(() => ({ kind: "status" })) },
}));

vi.mock("~/state/gitManager", () => ({
  gitManagerEnvironment: { getCommits: vi.fn(() => ({ kind: "commits" })) },
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: { kind: string } | null) => ({
    data:
      atom?.kind === "status"
        ? h.status
        : atom?.kind === "commits"
          ? { commits: h.latestCommit === null ? [] : [h.latestCommit] }
          : null,
    emission: { _tag: "Initial", waiting: false },
    error: null,
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

import { GitManagerCreatePullRequestDialog } from "./GitManagerCreatePullRequestDialog";

let container: HTMLDivElement;
let root: Root;

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

async function renderDialog(onSettled = vi.fn(), onOpenChange = vi.fn()) {
  await act(async () =>
    root.render(
      <GitManagerCreatePullRequestDialog
        open
        scope={{ environmentId: "env-a" as never, cwd: "/repo" }}
        onOpenChange={onOpenChange}
        onSettled={onSettled}
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

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  h.status = status();
  h.latestCommit = commit("feat: reviewed change", "Body from commit");
  h.runs = [];
  h.script = [];
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.replaceChildren();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("GitManagerCreatePullRequestDialog", () => {
  it("reviews repository, base, head, publish requirement, and commit defaults without running", async () => {
    await renderDialog();

    expect(h.runs).toEqual([]);
    expect(text("create-pr-repository")).toBe("GitHub · https://github.com");
    expect(text("create-pr-base")).toBe("main");
    expect(text("create-pr-head")).toBe("feature/reviewed");
    expect(text("create-pr-publish")).toContain("will be published first");
    expect(input("git-manager-create-pr-title").value).toBe("feat: reviewed change");
    expect(input("git-manager-create-pr-body").value).toBe("Body from commit");
    expect(button("Publish and create pull request").disabled).toBe(false);
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

  it("cancels freely before starting and refuses to close while publishing", async () => {
    const { onOpenChange } = await renderDialog();
    await act(async () => button("Cancel").click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(h.runs).toEqual([]);

    onOpenChange.mockClear();
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
