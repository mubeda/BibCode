// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { readVisualWitness } from "./release-visual-observation.ts";
import { validateVisualWitness } from "./release-visual-evidence.ts";
const input = {
  scene: "command-palette" as const,
  theme: "light" as const,
  origin: "http://127.0.0.1:4885",
  threadId: "owned",
  branch: "codex/delivery-retry-light",
};
function palette() {
  vi.stubGlobal("location", {
    origin: input.origin,
    pathname: "/local/owned",
    search: "",
    hash: "",
  });
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("innerHeight", 960);
  document.documentElement.className = "";
  document.body.innerHTML = `<div data-testid="environment-rail-local" aria-checked="true"><i data-status="connected"></i></div><button data-testid="thread-card-button-owned" aria-current="page"></button><div data-testid="thread-row-owned"><span data-testid="thread-title-owned">codex/delivery-retry-light</span></div><div data-testid="command-palette" data-slot="command-dialog-popup"><input data-slot="autocomplete-input"><div data-slot="command-item" data-highlighted>Open settings</div></div>`;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 10,
    y: 10,
    left: 10,
    top: 10,
    right: 310,
    bottom: 210,
    width: 300,
    height: 200,
    toJSON: () => ({}),
  });
  vi.spyOn(document, "elementFromPoint").mockImplementation(() =>
    document.querySelector('[data-testid="command-palette"]'),
  );
  document.querySelector<HTMLInputElement>("input")!.value = "settings";
  document.querySelector<HTMLInputElement>("input")!.focus();
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
describe("read-only visual observations", () => {
  it("admits the actually focused single public palette action without returning input contents", () => {
    palette();
    const witness = readVisualWitness(input);
    expect(validateVisualWitness(input.scene, witness)).toEqual({
      themeMatched: true,
      selectedMatched: true,
      expectedTextMatched: true,
      targetInView: true,
      credentialAbsent: true,
      bootShellAbsent: true,
      singlePalette: true,
      filteredAction: true,
      singleActiveRow: true,
      inputFocused: true,
    });
    expect(JSON.stringify(witness)).not.toMatch(/owned|settings|4885|delivery-retry/);
  });
  it.each([
    "focus",
    "duplicate",
    "obstructed",
    "credential",
    "boot",
    "theme",
    "selection",
    "viewport",
  ])("refuses a %s mismatch instead of capturing a nearby state", (kind) => {
    palette();
    if (kind === "focus") document.querySelector<HTMLInputElement>("input")!.blur();
    if (kind === "duplicate")
      document
        .querySelector('[data-slot="command-item"]')!
        .insertAdjacentHTML(
          "afterend",
          '<div data-slot="command-item" data-highlighted>Open settings</div>',
        );
    if (kind === "obstructed") vi.mocked(document.elementFromPoint).mockReturnValue(document.body);
    if (kind === "credential")
      document.body.insertAdjacentHTML("beforeend", '<input id="pairing-token">');
    if (kind === "boot")
      document.body.insertAdjacentHTML("beforeend", '<div id="boot-shell"></div>');
    if (kind === "theme") document.documentElement.className = "dark";
    if (kind === "selection")
      document.querySelector('[aria-current="page"]')!.removeAttribute("aria-current");
    if (kind === "viewport") vi.stubGlobal("innerHeight", 700);
    expect(() => validateVisualWitness(input.scene, readVisualWitness(input))).toThrow();
  });
  it.each(["origin", "search", "hash"])("refuses a private %s before reading any DOM", (key) => {
    palette();
    vi.stubGlobal("location", {
      origin: input.origin,
      pathname: "/local/owned",
      search: "",
      hash: "",
      [key]: "private-token",
    });
    const query = vi.spyOn(document, "querySelector");
    expect(readVisualWitness(input)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});
it("binds the auto-selected exact ref after its search row disappears, including the real occupied-branch name hint", () => {
  palette();
  document.querySelector('[data-testid="command-palette"]')!.remove();
  document.body.insertAdjacentHTML(
    "beforeend",
    `<div data-slot="dialog-popup" role="dialog"><input placeholder="Worktree name" value="visual-held"><input aria-label="Create From" value="visual-held"><input type="checkbox" disabled><p role="status">"visual-held" is already checked out. A new branch ("visual-held-2" or the next available name) will be created from it.</p><button aria-label="Agent">Claude</button><button>Advanced</button></div>`,
  );
  vi.mocked(document.elementFromPoint).mockImplementation(() =>
    document.querySelector('[role="dialog"]'),
  );
  const scene = "worktree-create-ref" as const;
  expect(validateVisualWitness(scene, readVisualWitness({ ...input, scene }))).toMatchObject({
    exactRef: true,
    derivedName: true,
    reuseBlocked: true,
  });
  document.querySelector<HTMLInputElement>('input[aria-label="Create From"]')!.value =
    "origin/visual-held";
  expect(() => validateVisualWitness(scene, readVisualWitness({ ...input, scene }))).toThrow();
});

describe("actual workspace-card fallback menu witness", () => {
  it.each(["no-opener", "cursor", "host-opener", "wrong-reason", "no-reason", "wrong-focus"])(
    "admits only the focused disabled Open in with its visible no-opener reason: %s",
    async (mode) => {
      // Load the real bundler-owned web modules through Vitest. A static import
      // would add their extensionless imports to the NodeNext E2E type graph.
      const fallbackModule = "../../../web/src/contextMenuFallback.ts";
      const sidebarMenuModule = "../../../web/src/components/sidebar/sidebarMenus.logic.ts";
      const { showContextMenuFallback } = await import(fallbackModule);
      const { buildWorkspaceCardMenu } = await import(sidebarMenuModule);
      palette();
      document.querySelector('[data-testid="command-palette"]')!.remove();
      const entries = buildWorkspaceCardMenu({
        isWorktree: true,
        openIn:
          mode === "cursor"
            ? [{ id: "open-in:cursor", label: "Cursor" }]
            : mode === "host-opener"
              ? [{ id: "open-in:zed", label: "Zed" }]
              : [],
        pullDisabledReason: null,
        workspaceUnavailableReason:
          mode === "wrong-reason" ? "This worktree is being removed." : null,
        branchName: input.branch,
        pinned: false,
        unread: false,
        confirmThreadDelete: true,
        worktreeSessionRunning: false,
      });
      if (mode === "no-reason") entries[0] = { id: "open-in", label: "Open in", disabled: true };
      const result = showContextMenuFallback(entries, { x: 10, y: 10 });
      try {
        vi.mocked(document.elementFromPoint).mockImplementation(() =>
          document.querySelector('[role="menu"]'),
        );
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
        if (mode === "wrong-focus")
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        const scene = "workspace-card-menu" as const;
        const witness = readVisualWitness({ ...input, scene });
        if (mode === "no-opener") {
          expect(
            document.getElementById(document.activeElement!.getAttribute("aria-labelledby")!)
              ?.textContent,
          ).toBe("Open in");
          expect(validateVisualWitness(scene, witness)).toEqual({
            themeMatched: true,
            selectedMatched: true,
            expectedTextMatched: true,
            targetInView: true,
            credentialAbsent: true,
            bootShellAbsent: true,
            singleMenu: true,
            disabledReason: true,
            focusedDisabledItem: true,
            groupedActions: true,
          });
        } else {
          expect(() => validateVisualWitness(scene, witness)).toThrow(
            "Visual precondition failed.",
          );
          if (mode === "cursor" || mode === "host-opener") {
            expect(document.activeElement?.getAttribute("aria-disabled")).toBeNull();
            expect(document.activeElement?.getAttribute("aria-haspopup")).toBe("menu");
          }
        }
      } finally {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await expect(result).resolves.toBeNull();
      }
    },
  );
});
