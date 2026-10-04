// @effect-diagnostics nodeBuiltinImport:off - Finite owned original images; runtime/Git ownership remains with the existing controller.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { OrchestrationReadModel } from "../../../../packages/contracts/src/orchestration.ts";
import {
  bounded,
  type QualificationBrowser,
  type QualificationOwner,
} from "./qualification-owner.ts";
import { inspectScreenshot, validateCaptureWitness } from "./remote-ui-evidence.ts";
import type { GitProjectVisualFixture } from "./release-visual-git-project-fixture.ts";

export const gitProjectVisualScenes = [
  "worktree-discovery",
  "project-open-directory",
  "project-clone-chooser",
  "project-clone-incomplete",
  "git-tags",
  "git-switch-with-changes",
  "git-merge-conflict",
  "git-rewrite-preview",
  "git-unborn",
  "git-no-repository",
  "git-broken-recovery",
] as const;
export type GitProjectVisualScene = (typeof gitProjectVisualScenes)[number];
export type GitProjectVisualCoverage = "complete" | "groups-and-names-only";
export interface GitProjectVisualSelection {
  projectId: string;
  threadId: string;
  environmentId: string;
  cwd: string;
  branch: string | null;
  title: string;
}
export interface GitProjectVisualObservationInput {
  scene: GitProjectVisualScene;
  coverage: GitProjectVisualCoverage;
  theme: "light" | "dark";
  origin: string;
  selection: GitProjectVisualSelection;
  directory: string;
  cloneUrl: string;
  cloneParent: string;
}
const commonFacts = [
  "themeMatched",
  "selectedMatched",
  "expectedTextMatched",
  "targetInView",
  "credentialAbsent",
  "bootShellAbsent",
] as const;
const sceneFacts: Record<GitProjectVisualScene, readonly string[]> = {
  "worktree-discovery": ["groupedPaths", "addAndKeepHidden", "singlePrimary"],
  "project-open-directory": ["breadcrumbs", "folderSelection", "newFolder", "hostContext"],
  "project-clone-chooser": ["urlAndInferredName", "parentRetained", "editableForm"],
  "project-clone-incomplete": ["actionableRefusal", "retainedForm", "enabledRetry"],
  "git-tags": ["localTags", "remoteTags", "tagNames", "disabledTagActions"],
  "git-switch-with-changes": ["namedBranch", "safeChoices", "ordinaryStashExplanation"],
  "git-merge-conflict": ["conflictFile", "inProgress", "continueAbort", "blockedExplanation"],
  "git-rewrite-preview": ["targetBranch", "operationDescription", "safeWarning"],
  "git-unborn": ["noCommits", "notDetached", "disabledReason"],
  "git-no-repository": ["sidebarReason", "tabReason", "sameReason"],
  "git-broken-recovery": ["actionableReason", "retryBusy", "retryFocused", "selectedTab"],
};
const refused = () => new Error("Visual Git/project precondition failed.");

/** Fixed public selection identity; renderer IDs and page values never enter receipts. */
export function readGitProjectSelection(input: {
  origin: string;
  selection: GitProjectVisualSelection;
}): boolean {
  const { selection } = input;
  if (
    input.origin !== "http://127.0.0.1:4885" ||
    location.origin !== input.origin ||
    location.search ||
    location.hash ||
    selection.environmentId !== "local" ||
    ![selection.projectId, selection.threadId].every((value) =>
      /^[A-Za-z0-9._:-]{1,128}$/.test(value),
    ) ||
    document.querySelector(
      '#pairing-token,input[type="password"],input[autocomplete="one-time-code"],textarea[placeholder^="bibcode://pair"]',
    ) !== null
  )
    return false;
  const chat = location.pathname === "/local/" + selection.threadId;
  const git = location.pathname === "/project/local/" + selection.projectId + "/git";
  if (!chat && !git) return false;
  const cards = document.querySelectorAll(
    `[data-testid="primary-card-button-${selection.projectId}"]`,
  );
  const card = cards.length === 1 ? cards[0]! : null;
  if (
    !card ||
    card.closest("[hidden],[inert]") ||
    card.getBoundingClientRect().width <= 0 ||
    card.getBoundingClientRect().height <= 0 ||
    document.querySelector(
      '[data-testid="environment-rail-local"][aria-checked="true"] [data-status="connected"]',
    ) === null
  )
    return false;
  if (chat) return card.getAttribute("aria-current") === "page";
  const headers = document.querySelectorAll("header[data-environment-id][data-project-id]");
  const projects = document.querySelectorAll('[data-testid="git-manager-project"]');
  return (
    headers.length === 1 &&
    headers[0]!.getAttribute("data-environment-id") === "local" &&
    headers[0]!.getAttribute("data-project-id") === selection.projectId &&
    projects.length === 1 &&
    projects[0]!.getAttribute("title") === selection.cwd
  );
}

export interface GitProjectOwnerAdapterInput {
  browser: QualificationBrowser;
  owner: Pick<QualificationOwner, "until">;
  origin: string;
  fixture: GitProjectVisualFixture;
  importProject: (cwd: string) => Promise<void>;
  readSnapshot: () => Promise<OrchestrationReadModel>;
  verifyServer: () => Promise<void>;
  readBranch: (cwd: string) => string | null;
  verifySource: (selection: GitProjectVisualSelection) => void;
}

/** Finite adapters for the existing public import, primary card and project menu. */
export function createGitProjectOwnerAdapters(input: GitProjectOwnerAdapterInput) {
  const bound = new Map<string, GitProjectVisualSelection>();
  let cloneBefore: string | null = null;
  const verifyOwnedIdentity = async (selection: GitProjectVisualSelection) => {
    if (bound.get(selection.projectId) !== selection) throw refused();
    await input.verifyServer();
    const snapshot = await input.readSnapshot();
    const projects = snapshot.projects.filter(
      (project) => project.id === selection.projectId && project.deletedAt === null,
    );
    const threads = snapshot.threads.filter(
      (thread) =>
        thread.projectId === selection.projectId &&
        thread.kind === "default" &&
        thread.deletedAt === null,
    );
    if (
      projects.length !== 1 ||
      projects[0]!.workspaceRoot !== selection.cwd ||
      projects[0]!.title !== selection.title ||
      threads.length !== 1 ||
      threads[0]!.id !== selection.threadId ||
      threads[0]!.worktreePath !== null
    )
      throw refused();
    input.verifySource(selection);
    await input.owner.until(async () =>
      input.browser.execute(readGitProjectSelection, { origin: input.origin, selection }),
    );
  };
  const click = async (selector: string) => {
    const control = input.browser.$(selector);
    await control.waitForDisplayed();
    if ((await input.browser.$$(selector).length) !== 1) throw refused();
    await control.waitForEnabled();
    await control.click();
  };
  return {
    selectProject: async (
      kind: "rich" | "merge" | "unborn" | "ordinary" | "broken",
      cwd: string,
    ) => {
      if (cwd !== input.fixture[kind]) throw refused();
      await input.verifyServer();
      await input.importProject(cwd);
      const binding: { selection: GitProjectVisualSelection | null } = { selection: null };
      await input.owner.until(async () => {
        const snapshot = await input.readSnapshot();
        const projects = snapshot.projects.filter(
          (project) => project.workspaceRoot === cwd && project.deletedAt === null,
        );
        if (projects.length === 0) return false;
        if (projects.length !== 1 || projects[0]!.title !== NodePath.basename(cwd)) throw refused();
        const project = projects[0]!;
        const threads = snapshot.threads.filter(
          (thread) =>
            thread.projectId === project.id &&
            thread.kind === "default" &&
            thread.deletedAt === null,
        );
        if (threads.length === 0) return false;
        if (threads.length !== 1 || threads[0]!.worktreePath !== null) throw refused();
        if (![project.id, threads[0]!.id].every((value) => /^[A-Za-z0-9._:-]{1,128}$/.test(value)))
          throw refused();
        binding.selection = {
          projectId: project.id,
          threadId: threads[0]!.id,
          environmentId: "local",
          cwd,
          branch: input.readBranch(cwd),
          title: project.title,
        };
        return true;
      });
      if (binding.selection === null) throw refused();
      const selected = binding.selection;
      bound.set(selected.projectId, selected);
      await click(`[data-testid="primary-card-button-${selected.projectId}"]`);
      await verifyOwnedIdentity(selected);
      return selected;
    },
    verifyOwnedIdentity,
    openHiddenWorktrees: async (selection: GitProjectVisualSelection) => {
      await verifyOwnedIdentity(selection);
      const selector = `button[aria-label="Project actions for ${selection.title}"]`;
      const control = input.browser.$(selector);
      await control.waitForExist();
      if ((await input.browser.$$(selector).length) !== 1) throw refused();
      await input.owner.until(async () => {
        if (await control.isFocused()) return true;
        await input.browser.keys("Tab");
        return control.isFocused();
      });
      await control.waitForDisplayed();
      await control.waitForEnabled();
      if ((await input.browser.$$(selector).length) !== 1 || !(await control.isFocused()))
        throw refused();
      await input.browser.keys("Enter");
      await click(
        '//*[@role="menuitem" and starts-with(normalize-space(),"Show Hidden Worktrees")]',
      );
    },
    verifyNoCloneImport: async () => {
      await input.verifyServer();
      const snapshot = await input.readSnapshot();
      if (
        snapshot.projects.some((project) => project.workspaceRoot === input.fixture.incomplete) ||
        snapshot.threads.some((thread) => thread.worktreePath === input.fixture.incomplete)
      )
        throw refused();
      const identity = JSON.stringify({
        projects: snapshot.projects
          .filter((project) => project.deletedAt === null)
          .map((project) => [project.id, project.workspaceRoot])
          .sort(),
        threads: snapshot.threads
          .filter((thread) => thread.deletedAt === null)
          .map((thread) => [thread.id, thread.projectId, thread.kind, thread.worktreePath])
          .sort(),
      });
      if (cloneBefore !== null && cloneBefore !== identity) throw refused();
      cloneBefore = identity;
    },
  };
}

/** Exact fixed incomplete-group result; no unknown producer fields are copied. */
export function projectGitProjectVisualAssertion(theme: "light" | "dark", input: unknown) {
  const expected = {
    inventory: [...gitProjectVisualScenes],
    completedScenes: gitProjectVisualScenes.filter(
      (scene) => scene !== "git-tags" && scene !== "git-rewrite-preview",
    ),
    partialScenes: ["git-tags"],
    blockedScenes: [
      { scene: "git-tags", check: "disabled-actions", reason: "no-owned-stable-disabled-binding" },
      {
        scene: "git-rewrite-preview",
        check: "target-operation-warning",
        reason: "multi-commit-substates-unbound",
      },
    ],
    completeGroup: false,
    cloneExecuted: false,
    noEditableCloneName: true,
    chooserRetained: true,
    dirtyWorkRetained: true,
    mergeAborted: true,
    brokenMetadataRestored: true,
    selectedTabRetained: true,
  };
  const matches = (value: unknown, expectedValue: unknown): boolean => {
    if (expectedValue === null || typeof expectedValue !== "object") return value === expectedValue;
    if (
      !value ||
      typeof value !== "object" ||
      !expectedValue ||
      typeof expectedValue !== "object" ||
      Array.isArray(value) !== Array.isArray(expectedValue)
    )
      return false;
    const keys = Reflect.ownKeys(expectedValue);
    const actualKeys = Reflect.ownKeys(value);
    if (keys.length !== actualKeys.length || !actualKeys.every((key) => keys.includes(key)))
      return false;
    return keys.every((key) => {
      const actual = Object.getOwnPropertyDescriptor(value, key);
      const expected = Object.getOwnPropertyDescriptor(expectedValue, key)!;
      return (
        actual !== undefined &&
        Object.hasOwn(actual, "value") &&
        actual.enumerable === expected.enumerable &&
        matches(actual.value, expected.value)
      );
    });
  };
  try {
    if (!["light", "dark"].includes(theme) || !matches(input, expected)) throw refused();
    return { theme, ...expected };
  } catch {
    throw refused();
  }
}
export function gitProjectVisualScreenshotName(scene: string, theme: string): string {
  if (
    !gitProjectVisualScenes.some((value) => value === scene) ||
    !["light", "dark"].includes(theme)
  )
    throw refused();
  return `${scene}-${theme}.png`;
}
/** Complete witnesses never accept missing checks. Tag-only pixels have a distinct explicit partial binding. */
export function validateGitProjectVisualWitness(
  scene: GitProjectVisualScene,
  coverage: GitProjectVisualCoverage,
  input: unknown,
): Record<string, true> {
  try {
    if (
      !gitProjectVisualScenes.includes(scene) ||
      !["complete", "groups-and-names-only"].includes(coverage) ||
      (coverage !== "complete" && scene !== "git-tags") ||
      !input ||
      typeof input !== "object" ||
      Array.isArray(input)
    )
      throw refused();
    const specific = sceneFacts[scene].filter(
      (key) => coverage === "complete" || key !== "disabledTagActions",
    );
    const keys = [...commonFacts, ...specific];
    if (Reflect.ownKeys(input).length !== keys.length) throw refused();
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (
        !descriptor?.enumerable ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.value !== true
      )
        throw refused();
    }
    validateCaptureWitness(Object.fromEntries(commonFacts.map((key) => [key, true])));
    return Object.fromEntries(keys.map((key) => [key, true]));
  } catch {
    throw refused();
  }
}

/** Runs only as a readonly browser callback. No page text, IDs, paths or input values leave it. */
export function readGitProjectVisualWitness(
  input: GitProjectVisualObservationInput,
): Record<string, boolean> | null {
  const scenes = [
    "worktree-discovery",
    "project-open-directory",
    "project-clone-chooser",
    "project-clone-incomplete",
    "git-tags",
    "git-switch-with-changes",
    "git-merge-conflict",
    "git-rewrite-preview",
    "git-unborn",
    "git-no-repository",
    "git-broken-recovery",
  ];
  if (
    !scenes.includes(input.scene) ||
    !["light", "dark"].includes(input.theme) ||
    !["complete", "groups-and-names-only"].includes(input.coverage) ||
    (input.coverage !== "complete" && input.scene !== "git-tags") ||
    input.origin !== "http://127.0.0.1:4885" ||
    location.origin !== input.origin ||
    location.search ||
    location.hash ||
    ![input.selection.projectId, input.selection.threadId, input.selection.environmentId].every(
      (value) => /^[A-Za-z0-9._:-]{1,128}$/.test(value),
    )
  )
    return null;
  const gitScene = input.scene.startsWith("git-");
  const route = gitScene
    ? `/project/${input.selection.environmentId}/${input.selection.projectId}/git`
    : `/local/${input.selection.threadId}`;
  if (location.pathname !== route) return null;
  const visible = (element: Element | null): element is HTMLElement => {
    if (!element) return false;
    const box = element.getBoundingClientRect(),
      style = getComputedStyle(element);
    return (
      box.width > 0 &&
      box.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0"
    );
  };
  const all = (selector: string) => Array.from(document.querySelectorAll(selector)).filter(visible);
  const one = (selector: string) => {
    const values = all(selector);
    return values.length === 1 ? values[0]! : null;
  };
  const inView = (element: Element | null) => {
    if (!visible(element)) return false;
    const box = element.getBoundingClientRect();
    if (box.left < 0 || box.top < 0 || box.right > innerWidth || box.bottom > innerHeight)
      return false;
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const clip = ancestor.getBoundingClientRect(),
        style = getComputedStyle(ancestor);
      if (
        ["auto", "scroll", "hidden", "clip"].includes(style.overflowX) &&
        (box.left < clip.left || box.right > clip.right)
      )
        return false;
      if (
        ["auto", "scroll", "hidden", "clip"].includes(style.overflowY) &&
        (box.top < clip.top || box.bottom > clip.bottom)
      )
        return false;
    }
    return true;
  };
  const text = (element: Element | null) => element?.textContent?.trim() ?? "";
  const field = (selector: string) => {
    const element = one(selector);
    return element instanceof HTMLInputElement ? element : null;
  };
  const button = (parent: Element | null, label: string) =>
    Array.from(parent?.querySelectorAll("button") ?? []).find(
      (candidate) => text(candidate) === label,
    ) ?? null;
  const popup = one('[data-slot="dialog-popup"][role="dialog"]');
  const pane = one('[role="tabpanel"]');
  const primary = one(`[data-testid="primary-card-button-${input.selection.projectId}"]`);
  const gitToolbar = one('[data-testid="git-manager-environment"]');
  let target: Element | null = null,
    facts: Record<string, boolean> = {};
  if (input.scene === "worktree-discovery") {
    target = one(
      `[data-testid="worktree-discovery-card-${input.selection.environmentId}-${input.selection.projectId}"]`,
    );
    const rows = target ? Array.from(target.querySelectorAll("[data-worktree-candidate-row]")) : [];
    facts = {
      groupedPaths:
        inView(target?.querySelector("[data-worktree-parent-directory]") ?? null) &&
        rows.length === 1 &&
        text(rows[0]!).includes("visual-discovered"),
      addAndKeepHidden:
        inView(target?.querySelector("[data-worktree-add-action]") ?? null) &&
        inView(target?.querySelector('button[aria-label="Keep hidden"]') ?? null),
      singlePrimary:
        document.querySelectorAll(`[data-testid="primary-card-${input.selection.projectId}"]`)
          .length === 1 && inView(primary),
    };
  } else if (input.scene === "project-open-directory") {
    target = popup;
    facts = {
      breadcrumbs: inView(popup?.querySelector('[aria-label="Directory breadcrumbs"]') ?? null),
      folderSelection: inView(button(popup, "Select folder")),
      newFolder: inView(popup?.querySelector('button[aria-label="New folder"]') ?? null),
      hostContext:
        /Open project folder on .+/.test(text(popup)) &&
        field('[aria-label="Server directory path"]')?.value === input.directory &&
        inView(one('button[aria-label="Open nested"]')),
    };
  } else if (
    input.scene === "project-clone-chooser" ||
    input.scene === "project-clone-incomplete"
  ) {
    target = popup;
    const url = field("#add-project-clone-url"),
      parent = field("#add-project-clone-parent");
    const retained = url?.value === input.cloneUrl && parent?.value === input.cloneParent;
    if (input.scene === "project-clone-chooser")
      facts = {
        urlAndInferredName:
          inView(url) &&
          input.cloneUrl === "https://visual.invalid/visual-origin.git" &&
          url?.value === input.cloneUrl,
        parentRetained: inView(parent) && parent?.value === input.cloneParent,
        editableForm:
          retained &&
          !!url &&
          !url.disabled &&
          !!parent &&
          !parent.disabled &&
          inView(popup?.querySelector('button[title="Choose parent folder"]') ?? null),
      };
    else
      facts = {
        actionableRefusal:
          text(popup).includes("An incomplete clone exists at") &&
          text(popup).includes("Remove it or choose another folder.") &&
          text(popup).includes(input.cloneParent + "/visual-origin"),
        retainedForm: retained && inView(url) && inView(parent),
        enabledRetry:
          inView(button(popup, "Clone")) &&
          !(button(popup, "Clone") as HTMLButtonElement | null)?.disabled,
      };
  } else if (input.scene === "git-tags") {
    target = one('[data-testid="git-manager-tags"]');
    facts = {
      localTags: inView(target?.querySelector('[aria-label="Local tags"]') ?? null),
      remoteTags: inView(target?.querySelector('[aria-label="Tags on origin"]') ?? null),
      tagNames:
        inView(one('[data-testid="git-manager-local-tag-visual-local"]')) &&
        inView(one('[data-testid="git-manager-remote-tag-origin-visual-remote"]')),
    };
    if (input.coverage === "complete")
      facts.disabledTagActions = all(
        '[aria-label="Delete tag visual-local"],[aria-label="Push tag visual-local"]',
      ).some(
        (control) =>
          inView(control) &&
          (control.hasAttribute("disabled") || control.getAttribute("aria-disabled") === "true") &&
          !!control.getAttribute("title"),
      );
  } else if (input.scene === "git-switch-with-changes") {
    target = popup;
    facts = {
      namedBranch: text(popup).includes("Switch to visual-switch?"),
      safeChoices:
        inView(button(popup, "Leave my changes")) && inView(button(popup, "Bring my changes")),
      ordinaryStashExplanation:
        text(popup).includes("ordinary, visible stash entry") &&
        text(popup).includes("working-tree changes across"),
    };
  } else if (input.scene === "git-merge-conflict") {
    target = pane;
    const strip = one('[data-in-progress-kind="merge"][role="alert"]');
    const row = one('[role="option"][data-path="visual-conflict.txt"]');
    facts = {
      conflictFile: inView(row) && text(row).includes("Conflict"),
      inProgress: inView(strip) && text(strip).includes("Merge underway"),
      continueAbort: inView(button(strip, "Continue")) && inView(button(strip, "Abort")),
      blockedExplanation: Array.from(strip?.querySelectorAll("p") ?? []).some(
        (value) => inView(value) && text(value).length > 0,
      ),
    };
  } else if (input.scene === "git-unborn") {
    target = pane;
    const branch = one('button[aria-label="Choose branch"]');
    facts = {
      noCommits: inView(branch) && text(branch).includes("No commits yet"),
      notDetached: !text(branch).includes("Detached HEAD"),
      disabledReason: all("button[disabled][title]").some(
        (value) => inView(value) && /commit|HEAD/i.test(value.getAttribute("title") ?? ""),
      ),
    };
  } else if (input.scene === "git-no-repository") {
    target = pane;
    const card = one(`[data-testid="primary-card-${input.selection.projectId}"]`);
    const describedIds = primary?.getAttribute("aria-describedby")?.split(/\s+/) ?? [];
    const branches = Array.from(card?.querySelectorAll("[id]") ?? []).filter(
      (element) =>
        describedIds.includes(element.id) &&
        element.querySelector('[data-slot="tooltip-trigger"][aria-hidden]') !== null,
    );
    const branch = branches.length === 1 ? branches[0]! : null;
    const notices = Array.from(
      branch?.querySelectorAll('[data-slot="tooltip-trigger"][aria-hidden]') ?? [],
    );
    const descriptions = Array.from(branch?.querySelectorAll(".sr-only") ?? []);
    const notice = notices.length === 1 ? notices[0]! : null;
    const description = descriptions.length === 1 ? descriptions[0]! : null;
    const ownedCard = card !== null && primary !== null && card.contains(primary);
    facts = {
      sidebarReason: ownedCard && inView(notice) && text(notice) === "Not a Git repository",
      tabReason:
        text(pane).includes("This folder isn't a Git repository.") &&
        text(pane).includes("git init"),
      sameReason:
        ownedCard &&
        text(description) === "This folder isn't a Git repository. Run git init to create one.",
    };
  } else if (input.scene === "git-broken-recovery") {
    target = pane;
    const retry = button(pane, "Retrying…");
    facts = {
      actionableReason:
        text(pane).includes("Git can't read this repository.") &&
        text(pane).includes("damaged HEAD or config file"),
      retryBusy: inView(retry) && retry?.getAttribute("aria-disabled") === "true",
      retryFocused: retry !== null && document.activeElement === retry,
      selectedTab:
        all('[role="tab"][aria-selected="true"]').length === 1 &&
        text(one('[role="tab"][aria-selected="true"]')) === "Tags",
    };
  } else return null; // No complete public multi-commit target/warning binding is invented.
  const rect = target?.getBoundingClientRect();
  const unobstructed =
    !!target &&
    !!rect &&
    [
      [rect.left + rect.width / 2, rect.top + 2],
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
      [rect.left + rect.width / 2, rect.bottom - 2],
    ].every(([x, y]) => {
      const hit = document.elementFromPoint(x!, y!);
      return hit !== null && (hit === target || target.contains(hit));
    });
  const noOtherDialog = all('[data-slot="dialog-popup"],[data-slot="alert-dialog-popup"]').every(
    (value) => value === target || value.contains(target) || target?.contains(value),
  );
  return {
    themeMatched: document.documentElement.classList.contains("dark") === (input.theme === "dark"),
    selectedMatched:
      inView(primary) &&
      (!gitScene ||
        (inView(gitToolbar) &&
          one('[data-testid="git-manager-project"]')?.getAttribute("title") ===
            input.selection.cwd)) &&
      one('[data-testid="environment-rail-local"]')?.getAttribute("aria-checked") === "true" &&
      one('[data-testid="environment-rail-local"] [data-status="connected"]') !== null,
    expectedTextMatched: Object.values(facts).every(Boolean),
    targetInView:
      innerWidth === 1280 && innerHeight === 960 && inView(target) && unobstructed && noOtherDialog,
    credentialAbsent:
      document.querySelector(
        '#pairing-token,input[type="password"],input[autocomplete="one-time-code"],textarea[placeholder^="bibcode://pair"]',
      ) === null,
    bootShellAbsent:
      document.getElementById("boot-shell") === null &&
      document.querySelector("vite-error-overlay") === null,
    ...facts,
  };
}

export interface GitProjectVisualCaptureInput extends GitProjectVisualObservationInput {
  browser: QualificationBrowser;
  owner: Pick<QualificationOwner, "until">;
  evidence: string;
  captured: Set<string>;
  verifyOwnedIdentity: (selection: GitProjectVisualSelection) => Promise<void>;
}
export async function captureGitProjectVisualScene(
  input: GitProjectVisualCaptureInput,
): Promise<object> {
  const file = gitProjectVisualScreenshotName(input.scene, input.theme),
    path = NodePath.join(input.evidence, file);
  if (input.captured.has(file) || NodeFS.existsSync(path) || (await input.browser.isAlertOpen()))
    throw refused();
  const observation: GitProjectVisualObservationInput = {
    scene: input.scene,
    coverage: input.coverage,
    theme: input.theme,
    origin: input.origin,
    selection: input.selection,
    directory: input.directory,
    cloneUrl: input.cloneUrl,
    cloneParent: input.cloneParent,
  };
  await input.verifyOwnedIdentity(input.selection);
  let witness: Record<string, true> | undefined;
  await input.owner.until(async () => {
    const value = await bounded(
      input.browser.execute(readGitProjectVisualWitness, observation),
      2000,
    );
    try {
      witness = validateGitProjectVisualWitness(input.scene, input.coverage, value);
      return true;
    } catch {
      return false;
    }
  });
  const bytes = Buffer.from(await bounded(input.browser.takeScreenshot(), 5000), "base64");
  await input.verifyOwnedIdentity(input.selection);
  validateGitProjectVisualWitness(
    input.scene,
    input.coverage,
    await bounded(input.browser.execute(readGitProjectVisualWitness, observation), 2000),
  );
  const image = inspectScreenshot(bytes);
  if (image.width !== 1280 || image.height !== 960) throw refused();
  const receipt = projectGitProjectVisualCapture({
    scene: input.scene,
    coverage: input.coverage,
    theme: input.theme,
    file,
    witness,
    ...image,
  });
  NodeFS.writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
  input.captured.add(file);
  return receipt;
}

export interface GitProjectVisualInput {
  browser: QualificationBrowser;
  owner: Pick<QualificationOwner, "until" | "cleanup">;
  theme: "light" | "dark";
  origin: string;
  fixture: GitProjectVisualFixture;
  step: (phase: string) => void;
  /** Existing public import/selection controls; returns a real typed snapshot's default-thread identity. */
  selectProject: (
    kind: "rich" | "merge" | "unborn" | "ordinary" | "broken",
    cwd: string,
  ) => Promise<GitProjectVisualSelection>;
  openHiddenWorktrees: (selection: GitProjectVisualSelection) => Promise<void>;
  verifyOwnedIdentity: (selection: GitProjectVisualSelection) => Promise<void>;
  verifyNoCloneImport: () => Promise<void>;
  capture: (
    scene: GitProjectVisualScene,
    selection: GitProjectVisualSelection,
    coverage: GitProjectVisualCoverage,
  ) => Promise<void>;
}
/** One finite group. Partial tags and the unbound rewrite scene remain explicitly unqualified. */
export async function runGitProjectVisual(input: GitProjectVisualInput): Promise<object> {
  const { browser, fixture } = input;
  const completed: GitProjectVisualScene[] = [];
  const click = async (selector: string) => {
    const control = browser.$(selector);
    await control.waitForDisplayed();
    if ((await browser.$$(selector).length) !== 1) throw refused();
    await control.waitForEnabled();
    await control.click();
  };
  const capture = async (
    scene: GitProjectVisualScene,
    selection: GitProjectVisualSelection,
    coverage: GitProjectVisualCoverage = "complete",
  ) => {
    input.step(`visual-git-project-${scene}`);
    await input.verifyOwnedIdentity(selection);
    await input.capture(scene, selection, coverage);
    if (coverage === "complete") completed.push(scene);
  };
  const select = async (kind: "rich" | "merge" | "unborn" | "ordinary" | "broken") => {
    const selection = await input.selectProject(kind, fixture[kind]);
    if (
      selection.cwd !== fixture[kind] ||
      ![selection.projectId, selection.threadId, selection.environmentId].every((value) =>
        /^[A-Za-z0-9._:-]{1,128}$/.test(value),
      )
    )
      throw refused();
    await input.verifyOwnedIdentity(selection);
    return selection;
  };
  const popup = '[data-slot="dialog-popup"][role="dialog"]';
  const close = async () => {
    await browser.keys("Escape");
    await browser.$(popup).waitForDisplayed({ reverse: true });
  };
  const tab = async (label: string) =>
    click(`//button[@role="tab" and normalize-space()="${label}"]`);
  const openGit = async (selection: GitProjectVisualSelection) => {
    if (selection.title !== NodePath.basename(selection.cwd)) throw refused();
    const selector = `button[aria-label="Git Manager for ${selection.title}"]`;
    const control = browser.$(selector);
    await control.waitForExist();
    if ((await browser.$$(selector).length) !== 1) throw refused();
    await input.owner.until(async () => {
      if (await control.isFocused()) return true;
      await browser.keys("Tab");
      return control.isFocused();
    });
    await control.waitForDisplayed();
    await control.waitForEnabled();
    if ((await browser.$$(selector).length) !== 1 || !(await control.isFocused())) throw refused();
    await browser.keys("Enter");
  };
  const rich = await select("rich");
  await capture("worktree-discovery", rich);
  await click('button[aria-label="Keep hidden"]');
  await input.openHiddenWorktrees(rich);
  await browser.$("[data-worktree-candidate-row]").waitForDisplayed();
  if (
    (await browser.$("[data-worktree-candidate-row]").getText()).includes("visual-discovered") !==
    true
  )
    throw refused();
  await input.verifyOwnedIdentity(rich);

  input.step("visual-git-project-directory-open");
  await click('[data-testid="sidebar-add-project-trigger"]');
  await click(
    '//button[@data-add-project-action="true"][.//span[normalize-space()="Browse folder"]]',
  );
  await browser.$('[aria-label="Server directory path"]').setValue(fixture.ordinary);
  await browser.keys("Enter");
  await click('button[aria-label="Open nested"]');
  await capture("project-open-directory", rich);
  await click("button=Type a path instead");
  await browser.$("#add-project-host-path").waitForDisplayed();
  await close();

  await fixture.verifyCloneAlias();
  input.step("visual-git-project-clone-chooser-open");
  await click('[data-testid="sidebar-add-project-trigger"]');
  await click(
    '//button[@data-add-project-action="true"][.//span[normalize-space()="Clone from URL"]]',
  );
  await browser.$("#add-project-clone-url").setValue(fixture.cloneUrl);
  await browser.$("#add-project-clone-parent").setValue(fixture.cloneParent);
  await click('button[title="Choose parent folder"]');
  await browser.$('[aria-label="Server directory path"]').waitForDisplayed();
  if ((await browser.$('[aria-label="Server directory path"]').getValue()) !== fixture.cloneParent)
    throw refused();
  await click("button=Cancel");
  if (
    (await browser.$("#add-project-clone-url").getValue()) !== fixture.cloneUrl ||
    (await browser.$("#add-project-clone-parent").getValue()) !== fixture.cloneParent
  )
    throw refused();
  await capture("project-clone-chooser", rich);
  fixture.verifyIncompleteRetained();
  await input.verifyNoCloneImport();
  await click(`${popup} button=Clone`);
  await input.owner.until(async () =>
    (await browser.$(popup).getText()).includes("An incomplete clone exists at"),
  );
  fixture.verifyIncompleteRetained();
  await input.verifyNoCloneImport();
  await capture("project-clone-incomplete", rich);
  await close();

  await openGit(rich);
  await tab("Tags");
  await capture("git-tags", rich, "groups-and-names-only");
  await tab("History");
  await click('[aria-label="Choose branch"]');
  await click('//*[@aria-label="Branches"]//button[.//span[normalize-space()="visual-switch"]]');
  await capture("git-switch-with-changes", rich);
  await close();
  await fixture.verifyDirtyRetained();

  const merge = await select("merge");
  await openGit(merge);
  await tab("Changes");
  await capture("git-merge-conflict", merge);
  await click('//*[@data-in-progress-kind="merge"]//button[normalize-space()="Abort"]');
  await click(`${popup} button=Abort Merge`);
  await browser.$(popup).waitForDisplayed({ reverse: true });
  await input.owner.until(async () => {
    try {
      await fixture.verifyMergeAborted();
      return true;
    } catch {
      return false;
    }
  });

  const unborn = await select("unborn");
  await openGit(unborn);
  await tab("History");
  await capture("git-unborn", unborn);
  const ordinary = await select("ordinary");
  await openGit(ordinary);
  await tab("History");
  await capture("git-no-repository", ordinary);
  const broken = await select("broken");
  await openGit(broken);
  await tab("Tags");
  await fixture.breakMetadata();
  let metadataRestored = false;
  try {
    await input.owner.until(async () =>
      (await browser.$('[role="tabpanel"]').getText()).includes("Git can't read this repository."),
    );
    await click('//*[@role="tabpanel"]//button[normalize-space()="Retry"]');
    await capture("git-broken-recovery", broken);
  } finally {
    await input.owner.cleanup("visual-owned-git-metadata", async () => {
      await fixture.restoreMetadata();
      metadataRestored = true;
    });
  }
  if (!metadataRestored) throw refused();
  await browser.$('//*[@role="tabpanel"]//button[normalize-space()="Retry"]').waitForDisplayed();
  await click('//*[@role="tabpanel"]//button[normalize-space()="Retry"]');
  await input.owner.until(
    async () =>
      await browser
        .$('[data-testid="git-manager-tags"]')
        .isDisplayed()
        .catch(() => false),
  );
  if ((await browser.$('[role="tab"][aria-selected="true"]').getText()) !== "Tags") throw refused();
  await input.verifyOwnedIdentity(broken);
  return {
    inventory: [...gitProjectVisualScenes],
    completedScenes: completed,
    partialScenes: ["git-tags"],
    blockedScenes: [
      { scene: "git-tags", check: "disabled-actions", reason: "no-owned-stable-disabled-binding" },
      {
        scene: "git-rewrite-preview",
        check: "target-operation-warning",
        reason: "multi-commit-substates-unbound",
      },
    ],
    completeGroup: false,
    cloneExecuted: false,
    noEditableCloneName: true,
    chooserRetained: true,
    dirtyWorkRetained: true,
    mergeAborted: true,
    brokenMetadataRestored: metadataRestored,
    selectedTabRetained: true,
  };
}

export function projectGitProjectVisualCapture(input: unknown) {
  try {
    const keys = [
      "scene",
      "coverage",
      "theme",
      "file",
      "witness",
      "width",
      "height",
      "nonBlank",
      "sha256",
    ];
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Reflect.ownKeys(input).length !== keys.length
    )
      throw refused();
    const row: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw refused();
      row[key] = descriptor.value;
    }
    if (
      typeof row.scene !== "string" ||
      typeof row.theme !== "string" ||
      row.file !== gitProjectVisualScreenshotName(row.scene, row.theme) ||
      row.width !== 1280 ||
      row.height !== 960 ||
      row.nonBlank !== true ||
      typeof row.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(row.sha256)
    )
      throw refused();
    const witness = validateGitProjectVisualWitness(
      row.scene as GitProjectVisualScene,
      row.coverage as GitProjectVisualCoverage,
      row.witness,
    );
    return {
      scene: row.scene,
      coverage: row.coverage,
      theme: row.theme,
      file: row.file,
      witness,
      width: 1280,
      height: 960,
      nonBlank: true,
      sha256: row.sha256,
    };
  } catch {
    throw refused();
  }
}
