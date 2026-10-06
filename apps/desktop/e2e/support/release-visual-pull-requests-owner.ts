// @effect-diagnostics nodeBuiltinImport:off - Development-only public project and source admission.
import * as NodePath from "node:path";
import type { OrchestrationReadModel } from "../../../../packages/contracts/src/orchestration.ts";
import type { QualificationBrowser, QualificationOwner } from "./qualification-owner.ts";
import type { GitProjectVisualSelection } from "./release-visual-git-project.ts";
import type { PullRequestsHostingFixture } from "./release-visual-pull-requests-installer.ts";
type Provider = "github" | "gitlab";
const refused = () => new Error("Owned request project admission refused.");
/** Serialized read only: normal primary navigation or the finite owned Requests routes. */
export function readPullRequestsProjectSelection(input: {
  origin: string;
  provider: Provider;
  selection: GitProjectVisualSelection;
  target: "primary" | "list" | "any";
}): boolean {
  try {
    const { selection } = input;
    if (
      input.origin !== "http://127.0.0.1:4885" ||
      location.origin !== input.origin ||
      location.hash ||
      selection.environmentId !== "local" ||
      ![selection.projectId, selection.threadId].every((value) =>
        /^[A-Za-z0-9._:-]{1,128}$/.test(value),
      ) ||
      !["github", "gitlab"].includes(input.provider) ||
      selection.title !== input.provider ||
      document.querySelector(
        '#pairing-token,input[type="password"],input[autocomplete="one-time-code"],textarea[placeholder^="bibcode://pair"]',
      )
    )
      return false;
    const shown = (element: Element) => {
      const box = element.getBoundingClientRect();
      if (![box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0)
        return false;
      for (let node: Element | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (
          node.hasAttribute("hidden") ||
          node.hasAttribute("inert") ||
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse" ||
          Number.parseFloat(style.opacity) === 0
        )
          return false;
      }
      return true;
    };
    const cards = document.querySelectorAll(
      '[data-testid="primary-card-button-' + selection.projectId + '"]',
    );
    if (
      cards.length !== 1 ||
      !shown(cards[0]!) ||
      document.querySelectorAll(
        '[data-testid="environment-rail-local"][aria-checked="true"] [data-status="connected"]',
      ).length !== 1
    )
      return false;
    const primary = location.pathname === "/local/" + selection.threadId && location.search === "";
    if (primary)
      return input.target !== "list" && cards[0]!.getAttribute("aria-current") === "page";
    if (input.target === "primary") return false;
    const base = "/project/local/" + selection.projectId + "/pull-requests";
    const list = location.pathname === base && location.search === "";
    const number = input.provider === "github" ? [41, 43] : [42];
    const detail =
      number.some((value) => location.pathname === base + "/" + value) &&
      ["?tab=conversation", "?tab=checks", "?tab=files"].includes(location.search);
    if ((!list && !detail) || (input.target === "list" && !list)) return false;
    const entries = document.querySelectorAll(
      'button[data-testid="pull-requests-button"][aria-label="Pull Requests for ' +
        selection.title +
        '"]',
    );
    const panels = document.querySelectorAll('section[aria-label="Pull Requests"]');
    if (entries.length !== 1 || panels.length !== 1 || !shown(panels[0]!)) return false;
    const headers = panels[0]!.querySelectorAll(":scope > header"),
      fields = headers.length === 1 ? headers[0]!.querySelectorAll(":scope > div > p") : [];
    return (
      fields.length === 2 &&
      fields[0]!.textContent?.trim() === "owned/requests" &&
      fields[1]!.textContent?.trim() === input.provider + ".visual.invalid · viewer"
    );
  } catch {
    return false;
  }
}
export interface PullRequestsOwnerAdapterInput {
  browser: QualificationBrowser;
  owner: Pick<QualificationOwner, "until">;
  origin: string;
  fixture: Pick<PullRequestsHostingFixture, "projects">;
  importProject: (
    cwd: string,
    bindSource?: () => Promise<GitProjectVisualSelection>,
  ) => Promise<void>;
  /** The existing normal snapshot reader decodes OrchestrationReadModel before this boundary. */
  readSnapshot: () => Promise<OrchestrationReadModel>;
  verifyServer: () => Promise<void>;
  /** Root verifies the owned real branch/origin/config and immutable source against the fixture. */
  verifySource: (provider: Provider, selection: GitProjectVisualSelection) => void | Promise<void>;
}
/** Public import/card/sidebar only; no renderer/store state writes or provider turn. */
export function createPullRequestsOwnerAdapters(input: PullRequestsOwnerAdapterInput) {
  if (input.origin !== "http://127.0.0.1:4885") throw refused();
  for (const provider of ["github", "gitlab"] as const) {
    const cwd = input.fixture.projects[provider].cwd;
    if (
      !NodePath.isAbsolute(cwd) ||
      NodePath.normalize(cwd) !== cwd ||
      !cwd.endsWith("/requests/" + provider) ||
      !/\/(light|dark)\/requests\//.test(cwd)
    )
      throw refused();
  }
  const bound = new Map<Provider, GitProjectVisualSelection>();
  const identityMatches = (
    provider: Provider,
    project: OrchestrationReadModel["projects"][number],
  ) => {
    const identity = project.repositoryIdentity;
    return (
      identity != null &&
      identity.canonicalKey === provider + ".visual.invalid/owned/requests" &&
      identity.locator.source === "git-remote" &&
      identity.locator.remoteName === "origin" &&
      identity.locator.remoteUrl === "https://" + provider + ".visual.invalid/owned/requests.git" &&
      identity.rootPath === input.fixture.projects[provider].cwd &&
      identity.owner === "owned" &&
      identity.name === "requests"
    );
  };
  let opening = false;
  const source = async (provider: Provider, selection: GitProjectVisualSelection) => {
    await input.verifyServer();
    const snapshot = await input.readSnapshot();
    const projects = snapshot.projects.filter(
      (project) =>
        project.deletedAt === null &&
        (project.id === selection.projectId || project.workspaceRoot === selection.cwd),
    );
    const threads = snapshot.threads.filter(
      (thread) =>
        thread.projectId === selection.projectId &&
        thread.kind === "default" &&
        thread.deletedAt === null,
    );
    if (
      projects.length !== 1 ||
      projects[0]!.id !== selection.projectId ||
      projects[0]!.workspaceRoot !== selection.cwd ||
      projects[0]!.title !== selection.title ||
      !identityMatches(provider, projects[0]!) ||
      threads.length !== 1 ||
      threads[0]!.id !== selection.threadId ||
      threads[0]!.worktreePath !== null ||
      threads[0]!.latestTurn !== null ||
      threads[0]!.session !== null ||
      threads[0]!.messages.length !== 0
    )
      throw refused();
    await input.verifySource(provider, selection);
  };
  const dom = async (
    provider: Provider,
    selection: GitProjectVisualSelection,
    target: "primary" | "list" | "any",
  ) =>
    input.owner.until(async () =>
      input.browser.execute(readPullRequestsProjectSelection, {
        origin: input.origin,
        provider,
        selection,
        target,
      }),
    );
  const verifyOwnedIdentity = async (selection: GitProjectVisualSelection) => {
    const provider = (["github", "gitlab"] as const).find(
      (value) => bound.get(value) === selection,
    );
    if (!provider) throw refused();
    await source(provider, selection);
    await dom(provider, selection, "any");
  };
  const click = async (selector: string) => {
    const control = input.browser.$(selector);
    await control.waitForDisplayed();
    if ((await input.browser.$$(selector).length) !== 1) throw refused();
    await control.waitForEnabled();
    await control.click();
  };
  const openModule = async (selection: GitProjectVisualSelection) => {
    const selector =
      'button[data-testid="pull-requests-button"][aria-label="Pull Requests for ' +
      selection.title +
      '"]';
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
  };
  return {
    verifyOwnedIdentity,
    openRequests: async (provider: Provider): Promise<GitProjectVisualSelection> => {
      if (opening || !["github", "gitlab"].includes(provider)) throw refused();
      opening = true;
      try {
        let selection = bound.get(provider);
        const readSelection = (): GitProjectVisualSelection | undefined => selection;
        if (!selection) {
          const cwd = input.fixture.projects[provider].cwd;
          let callbackEntered = false;
          await input.verifyServer();
          await input.importProject(cwd, async () => {
            if (callbackEntered) throw refused();
            callbackEntered = true;
            await input.owner.until(async () => {
              const snapshot = await input.readSnapshot();
              const projects = snapshot.projects.filter(
                (project) => project.workspaceRoot === cwd && project.deletedAt === null,
              );
              if (projects.length === 0) return false;
              if (projects.length !== 1 || projects[0]!.title !== provider) throw refused();
              const project = projects[0]!;
              if (project.repositoryIdentity == null) return false;
              if (!identityMatches(provider, project)) throw refused();
              const threads = snapshot.threads.filter(
                (thread) =>
                  thread.projectId === project.id &&
                  thread.kind === "default" &&
                  thread.deletedAt === null,
              );
              if (threads.length === 0) return false;
              if (
                threads.length !== 1 ||
                ![project.id, threads[0]!.id].every((value) =>
                  /^[A-Za-z0-9._:-]{1,128}$/.test(value),
                )
              )
                throw refused();
              selection = Object.freeze({
                environmentId: "local",
                projectId: project.id,
                threadId: threads[0]!.id,
                cwd,
                title: project.title,
                branch: "visual-request",
              });
              await source(provider, selection);
              bound.set(provider, selection);
              return true;
            });
            if (!selection) throw refused();
            await click('[data-testid="primary-card-button-' + selection.projectId + '"]');
            await dom(provider, selection, "primary");
            return selection;
          });
          selection = readSelection();
          if (!callbackEntered || !selection) throw refused();
        } else {
          await source(provider, selection);
          await click('[data-testid="primary-card-button-' + selection.projectId + '"]');
          await dom(provider, selection, "primary");
        }
        await source(provider, selection);
        await openModule(selection);
        await source(provider, selection);
        await dom(provider, selection, "list");
        return selection;
      } finally {
        opening = false;
      }
    },
  };
}
