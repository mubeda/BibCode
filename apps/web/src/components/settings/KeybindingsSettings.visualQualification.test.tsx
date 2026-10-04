// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - Execute the actual QA segment against real mounted UI without network.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const ports = vi.hoisted(() => ({
  bindings: Symbol("bindings"),
  path: Symbol("path"),
  editors: Symbol("editors"),
  save: vi.fn(),
  remove: vi.fn(),
  open: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === ports.bindings
      ? [
          {
            command: "sidebar.toggle",
            shortcut: {
              key: "b",
              metaKey: false,
              ctrlKey: false,
              shiftKey: false,
              altKey: false,
              modKey: true,
            },
          },
          {
            command: "sidebar.show",
            shortcut: {
              key: "s",
              metaKey: false,
              ctrlKey: false,
              shiftKey: false,
              altKey: false,
              modKey: true,
            },
            whenAst: { type: "identifier", name: "terminalFocus" },
          },
        ]
      : atom === ports.path
        ? "/owned/keybindings.json"
        : [],
}));
vi.mock("../../state/server", () => ({
  primaryServerKeybindingsAtom: ports.bindings,
  primaryServerKeybindingsConfigPathAtom: ports.path,
  primaryServerAvailableEditorsAtom: ports.editors,
  serverEnvironment: { upsertKeybinding: ports.save, removeKeybinding: ports.remove },
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironment: () => ({ environmentId: "owned" }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("../../editorPreferences", () => ({ useOpenInPreferredEditor: () => ports.open }));
vi.mock("../ui/toast", () => ({ toastManager: { add: ports.toast } }));

import { KeybindingsSettingsPanel } from "./KeybindingsSettings";

it("selects the displayed new-binding When input after the real keep-mounted popovers", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 900, 290),
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(290);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900);
  const network = vi.fn(() => {
    throw new Error("No network in mounted When editor seam.");
  });
  vi.stubGlobal("fetch", network);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (label: string) =>
    document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  try {
    await act(async () => root.render(<KeybindingsSettingsPanel />));
    await act(async () => button("Add keybinding").click());
    await act(async () => button("Edit when clause for new keybinding").click());
    const all = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[aria-label="When expression"]'),
    );
    const opened = document.querySelector<HTMLInputElement>(
      '[data-slot="popover-popup"][data-open] input[aria-label="When expression"]',
    );
    expect(opened).not.toBeNull();
    expect(all.length).toBeGreaterThan(1);
    expect(all[0]).not.toBe(opened);
    expect(all[0]!.closest('[data-slot="popover-popup"]')?.hasAttribute("data-closed")).toBe(true);
    expect(opened!.closest('[data-slot="popover-popup"]')?.hasAttribute("data-open")).toBe(true);
    const controller = NodeFS.readFileSync(
      new NodeURL.URL(
        "../../../../desktop/e2e/support/release-visual-settings.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const start = controller.indexOf('observeKeybindingsAwait("when-input", "displayed")');
    const end = controller.indexOf('await capture("settings-keybindings")', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    let selectedInput: HTMLInputElement | null = null;
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(`(async () => { ${controller.slice(start, end)} })`),
      {
        observeKeybindingsAwait: () => {},
        browser: {
          $: (selector: string) => {
            const input = document.querySelector<HTMLInputElement>(selector);
            return {
              waitForDisplayed: async () => {
                if (
                  input === null ||
                  !input.closest('[data-slot="popover-popup"]')?.hasAttribute("data-open")
                )
                  throw new Error("Actual QA selector chose a closed When editor.");
                selectedInput = input;
              },
              setValue: async (value: string) => {
                expect(input).toBe(opened);
                expect(value).toBe("terminalFocus && !terminalOpen");
              },
            };
          },
        },
      },
    );
    await run();
    expect(selectedInput).toBe(opened);
    expect(network).not.toHaveBeenCalled();
    expect(ports.save).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
}, 5_000);
