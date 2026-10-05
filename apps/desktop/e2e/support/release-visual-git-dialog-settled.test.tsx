// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - Real dialog and read-only witness tests; no app, browser or provider starts.
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { GitManagerSwitchWithChangesDialog } from "../../../web/src/components/gitManager/dialogs/GitManagerSwitchWithChangesDialog.tsx";
import {
  readGitProjectVisualWitness,
  validateGitProjectVisualWitness,
} from "./release-visual-git-project.ts";

it.each([
  "settled",
  "finished",
  "idle",
  "starting",
  "ending",
  "running",
  "paused",
  "pending",
  "unknown-state",
  "missing-api",
  "malformed-api",
  "throwing-api",
])("requires a settled actual switch dialog before original capture: %s", async (mode) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const web = NodeModule.createRequire(NodePath.resolve("apps/web/package.json"));
  const { act, createElement } = web("react");
  const { createRoot } = web("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const input = {
    scene: "git-switch-with-changes" as const,
    coverage: "complete" as const,
    theme: "light" as const,
    origin: "http://127.0.0.1:4885",
    selection: {
      projectId: "owned",
      threadId: "thread",
      environmentId: "local",
      cwd: "/owned/rich",
      branch: "main",
      title: "rich",
    },
    directory: "/owned",
    cloneUrl: "https://visual.invalid/visual-origin.git",
    cloneParent: "/owned/parent",
  };
  let resolutions = 0;
  try {
    await act(async () =>
      root.render(
        createElement(GitManagerSwitchWithChangesDialog, {
          open: true,
          branchName: "visual-switch",
          busy: false,
          onOpenChange: () => {},
          onResolve: async () => {
            resolutions++;
          },
        }),
      ),
    );
    const popup = document.querySelector<HTMLElement>('[data-slot="dialog-popup"][role="dialog"]')!;
    expect(popup).not.toBeNull();
    expect(popup.textContent).toContain("ordinary, visible stash entry");
    // These are controlled native-animation observations, not a native timing or pixel replay.
    popup.removeAttribute("data-starting-style");
    popup.removeAttribute("data-ending-style");
    if (mode === "starting") popup.setAttribute("data-starting-style", "");
    if (mode === "ending") popup.setAttribute("data-ending-style", "");
    Object.defineProperty(popup, "getAnimations", {
      configurable: true,
      value:
        mode === "missing-api"
          ? undefined
          : () => {
              if (mode === "throwing-api") throw new Error("Inert unavailable animation sample.");
              if (mode === "malformed-api") return {};
              if (mode === "settled" || mode === "starting" || mode === "ending") return [];
              return [
                {
                  playState:
                    mode === "unknown-state"
                      ? "unobserved"
                      : mode === "pending"
                        ? "finished"
                        : mode,
                  pending: mode === "pending",
                },
              ];
            },
    });
    const context = document.createElement("div");
    context.innerHTML =
      '<button data-testid="primary-card-button-owned"></button><div data-testid="git-manager-environment"><span data-testid="git-manager-project" title="/owned/rich"></span></div><div data-testid="environment-rail-local" aria-checked="true"><span data-status="connected"></span></div>';
    container.append(context);
    vi.stubGlobal("location", {
      origin: input.origin,
      pathname: "/project/local/owned/git",
      search: "",
      hash: "",
    });
    vi.stubGlobal("innerWidth", 1280);
    vi.stubGlobal("innerHeight", 960);
    document.documentElement.className = "";
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(10, 10, 500, 300),
    );
    vi.spyOn(document, "elementFromPoint").mockReturnValue(popup);
    const witness = readGitProjectVisualWitness(input);
    expect(witness).not.toBeNull();
    const expected = ["settled", "finished", "idle"].includes(mode);
    if (expected)
      expect(
        validateGitProjectVisualWitness(input.scene, input.coverage, witness).dialogSettled,
      ).toBe(true);
    else
      expect(() => validateGitProjectVisualWitness(input.scene, input.coverage, witness)).toThrow();
    expect(witness?.dialogSettled).toBe(expected);
    expect(resolutions).toBe(0);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.documentElement.className = "";
  }
});
