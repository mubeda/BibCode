// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - Mounted public widgets use their owning package runtime.
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  readProjectLifecycleObservation,
  validateProjectLifecycleWitness,
  type ProjectLifecycleObservation,
} from "./release-visual-project-lifecycle.ts";

const h = vi.hoisted(() => ({ running: false }));
vi.mock("../../../web/src/state/use-atom-command", () => {
  const run = async () => ({
    _tag: "Success",
    value: {
      planToken: "owned-plan",
      generation: 1,
      availability: "present",
      registered: true,
      locked: false,
      trackedChangeCount: 0,
      untrackedFileCount: 0,
      pruneImpact: [],
    },
  });
  return { useAtomCommand: () => run };
});
vi.mock("../../../web/src/state/entities", () => {
  const thread = () => ({
    id: "owned-worktree",
    environmentId: "local",
    projectId: "owned-project",
    kind: "workspace",
    worktreePath: "/owned/managed",
    archivedAt: null,
    session: h.running ? { status: "running", activeTurnId: "owned-turn" } : null,
  });
  return {
    useThreadShell: () => thread(),
    useThreadShellsForProjectRefs: () => [thread()],
    readThreadShell: () => thread(),
    readEnvironmentThreadRefs: () => [{ environmentId: "local", threadId: "owned-worktree" }],
  };
});
vi.mock("../../../web/src/state/worktrees", () => ({
  worktreeEnvironment: {
    getRemovalPlan: { label: "plan" },
    remove: { label: "remove" },
    removeFromBibCode: { label: "detach" },
  },
}));
const require = NodeModule.createRequire(
  new NodeURL.URL("../../../web/package.json", import.meta.url),
);
const { act, createElement } = require("react") as {
  act: (run: () => unknown | Promise<unknown>) => Promise<void>;
  createElement: (component: unknown, props: unknown, ...children: unknown[]) => unknown;
};
const { createRoot } = require("react-dom/client") as {
  createRoot: (container: Element) => { render: (value: unknown) => void; unmount: () => void };
};
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  h.running = false;
});
const context = (
  scene: ProjectLifecycleObservation["scene"],
  theme: "light" | "dark",
): ProjectLifecycleObservation => ({
  scene,
  theme,
  origin: "http://127.0.0.1:4885",
  projectId: "owned-project",
  threadId: scene === "worktree-remove-busy" ? "owned-worktree" : "owned-primary",
  cwd: scene === "git-trust-refusal" ? "/owned/visual trust 'checkout" : "/owned/managed",
  branch: scene === "worktree-remove-busy" ? "codex/delivery-retry-" + theme : "main",
  title: "Owned workspace",
  cloneUrl: "https://visual.invalid/lifecycle-origin.git",
  cloneParent: "/owned/clone-parent",
});
function shell(input: ProjectLifecycleObservation) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("location", {
    origin: input.origin,
    pathname:
      input.scene === "git-trust-refusal"
        ? "/project/local/owned-project/git"
        : "/local/" + input.threadId,
    search: "",
    hash: "",
  });
  document.documentElement.classList.toggle("dark", input.theme === "dark");
  const rail = document.createElement("button");
  rail.dataset.testid = "environment-rail-local";
  rail.setAttribute("aria-checked", "true");
  rail.innerHTML = '<span data-status="connected"></span>';
  document.body.append(rail);
  const card = document.createElement("button");
  card.dataset.testid =
    (input.scene === "worktree-remove-busy" ? "thread-card-button-" : "primary-card-button-") +
    (input.scene === "worktree-remove-busy" ? input.threadId : input.projectId);
  card.setAttribute("aria-current", "page");
  document.body.append(card);
  let target: Element | null = null;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      target = this;
      return {
        x: 100,
        y: 100,
        width: 600,
        height: 450,
        left: 100,
        top: 100,
        right: 700,
        bottom: 550,
        toJSON: () => ({}),
      };
    },
  );
  vi.spyOn(document, "elementFromPoint").mockImplementation(() => target);
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("innerHeight", 960);
  return { hitTarget: () => target };
}
async function mount(component: unknown, props: unknown) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(createElement(component, props));
  });
}
const busyPath = "../../../web/src/components/WorktreeRemovalDialog.tsx";
const clonePath = "../../../web/src/components/add-project/AddProjectSteps.tsx";
const trustPath = "../../../web/src/components/gitManager/GitManagerRepositoryUnavailable.tsx";
const syncPath = "../../../web/src/components/gitManager/toolbar/GitManagerSyncButton.tsx";
const dialogPath = "../../../web/src/components/ui/dialog.tsx";
const buttonPath = "../../../web/src/components/ui/button.tsx";

it.each(["light", "dark"] as const)(
  "admits the actual running-removal public widget in %s and rejects wrong context",
  async (theme) => {
    const input = context("worktree-remove-busy", theme);
    const paint = shell(input);
    h.running = true;
    const { WorktreeRemovalDialog } = await import(busyPath);
    await mount(WorktreeRemovalDialog, {
      open: true,
      target: {
        environmentId: "local",
        projectId: input.projectId,
        threadId: input.threadId,
        title: input.title,
        path: input.cwd,
        branch: input.branch,
        availability: "present",
        registrationState: "registered",
        locked: false,
      },
      onOpenChange: () => {},
      onRemoved: () => {},
    });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        "Stop the running session before deleting this worktree.",
      ),
    );
    expect(
      validateProjectLifecycleWitness(input.scene, readProjectLifecycleObservation(input)),
    ).toMatchObject({
      destructiveDisabled: true,
      reasonLinked: true,
      checkoutIdentityMatched: true,
    });
    expect(readProjectLifecycleObservation({ ...input, cwd: "/owned/foreign" })).toBeNull();
    const destructive = Array.from(document.querySelectorAll("button")).find(
      (x) => x.textContent?.trim() === "Delete Git worktree and remove",
    )!;
    // Actual Button CSS removes disabled controls from hit-testing; its painted parent remains.
    destructive.style.pointerEvents = "none";
    vi.mocked(document.elementFromPoint).mockImplementation(() => {
      const target = paint.hitTarget();
      return target === destructive ? destructive.parentElement : target;
    });
    expect(
      validateProjectLifecycleWitness(input.scene, readProjectLifecycleObservation(input)),
    ).toMatchObject({ destructiveDisabled: true });
    const toast = document.createElement("div");
    toast.dataset.slot = "toast-root";
    toast.style.pointerEvents = "none";
    document.body.append(toast);
    expect(readProjectLifecycleObservation(input)).toBeNull();
    toast.remove();
    vi.mocked(document.elementFromPoint).mockReturnValue(document.createElement("div"));
    expect(readProjectLifecycleObservation(input)).toBeNull();
    vi.mocked(document.elementFromPoint).mockImplementation(() => {
      const target = paint.hitTarget();
      return target === destructive ? destructive.parentElement : target;
    });
    destructive.removeAttribute("aria-describedby");
    expect(readProjectLifecycleObservation(input)).toBeNull();
  },
);

it.each(["light", "dark"] as const)(
  "admits the real clone progress/cancel widget in %s without a percentage claim",
  async (theme) => {
    const input = context("project-clone-progress", theme);
    shell(input);
    const { AddProjectCloneStep } = await import(clonePath);
    const { Dialog, DialogPopup } = await import(dialogPath);
    let cancelled = 0;
    const cloneProps = {
      url: input.cloneUrl,
      parentDir: input.cloneParent,
      platform: "Linux",
      error: null,
      notice: null,
      busy: true,
      progress: "cloning",
      canPickParent: false,
      onUrlChange: () => {},
      onParentDirChange: () => {},
      onPickParent: () => {},
      onClone: () => {},
      onCancel: () => {
        cancelled++;
      },
    };
    await mount(
      () =>
        createElement(
          Dialog,
          { open: true },
          createElement(DialogPopup, {}, createElement(AddProjectCloneStep, cloneProps)),
        ),
      {},
    );
    expect(
      validateProjectLifecycleWitness(input.scene, readProjectLifecycleObservation(input)),
    ).toMatchObject({ cloneRunning: true, cancelEnabled: true, inputsRetained: true });
    expect(readProjectLifecycleObservation({ ...input, cloneParent: "/owned/foreign" })).toBeNull();
    const cancel = Array.from(document.querySelectorAll("button")).find(
      (x) => x.textContent?.trim() === "Cancel clone",
    )!;
    await act(() => cancel.click());
    expect(cancelled).toBe(1);
    cancel.disabled = true;
    expect(readProjectLifecycleObservation(input)).toBeNull();
  },
);

it.each(["light", "dark"] as const)(
  "admits the actual quoted trust alert and disabled sync reason in %s",
  async (theme) => {
    const input = context("git-trust-refusal", theme);
    shell(input);
    const header = document.createElement("header");
    header.dataset.environmentId = "local";
    header.dataset.projectId = input.projectId;
    const checkout = document.createElement("span");
    checkout.dataset.testid = "git-manager-project";
    checkout.title = input.cwd;
    header.append(checkout);
    document.body.append(header);
    const { GitManagerRepositoryUnavailable } = await import(trustPath);
    const { GitManagerSyncButton } = await import(syncPath);
    const command =
      "git config --global --add safe.directory '" + input.cwd.replaceAll("'", "'\\''") + "'";
    const message =
      "Git doesn't trust this repository because another user owns it. Run " +
      command +
      " to trust it.";
    await mount(GitManagerRepositoryUnavailable, {
      title: "Could not load changes",
      reason: "untrusted",
      cwd: input.cwd,
      retrying: false,
      onRetry: () => {},
    });
    await mount(GitManagerSyncButton, {
      state: {
        kind: "unavailable",
        label: "Sync unavailable",
        ahead: 0,
        behind: 0,
        disabledReason: message,
      },
      currentBranchName: null,
      remote: "origin",
      blockedReason: null,
      disabledReason: message,
      onOperation: () => {},
    });
    const { Button } = await import(buttonPath);
    // Actual public Button widgets with the exact disabled/reason props used by the toolbar/panel.
    // The panel's policy itself has its existing repositoryUnavailable mounted tests.
    for (const [index, label] of [
      "Choose branch",
      "Tags…",
      "Stashes",
      "Merge…",
      "Rebase…",
    ].entries()) {
      const id = "owned-operation-reason-" + index,
        reason = document.createElement("span");
      reason.id = id;
      reason.textContent = message;
      document.body.append(reason);
      await mount(
        () =>
          createElement(
            Button,
            {
              disabled: true,
              title: message,
              "aria-describedby": id,
              ...(label === "Choose branch" ? { "aria-label": label } : {}),
            },
            label,
          ),
        {},
      );
    }
    expect(
      validateProjectLifecycleWitness(input.scene, readProjectLifecycleObservation(input)),
    ).toMatchObject({
      quotedTrustCommand: true,
      retryEnabled: true,
      operationsDisabled: true,
      disabledReasons: true,
    });
    expect(readProjectLifecycleObservation({ ...input, cwd: "/owned/foreign" })).toBeNull();
    vi.mocked(document.elementFromPoint).mockReturnValue(document.createElement("div"));
    expect(readProjectLifecycleObservation(input)).toBeNull();
  },
);
