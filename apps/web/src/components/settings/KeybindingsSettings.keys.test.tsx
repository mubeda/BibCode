// @vitest-environment happy-dom
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@bibcode/shared/keybindings";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { value: unknown }) => atom.value,
}));
vi.mock("../../state/server", () => ({
  primaryServerKeybindingsAtom: { value: DEFAULT_RESOLVED_KEYBINDINGS },
  primaryServerKeybindingsConfigPathAtom: { value: null },
  primaryServerAvailableEditorsAtom: { value: [] },
  serverEnvironment: {},
}));
vi.mock("../../state/environments", () => ({ usePrimaryEnvironment: () => null }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../editorPreferences", () => ({ useOpenInPreferredEditor: () => vi.fn() }));

import { KeybindingsSettingsPanel } from "./KeybindingsSettings";

describe("KeybindingsSettingsPanel with the shipped defaults", () => {
  it("renders every row without a duplicate React key", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<KeybindingsSettingsPanel />));
    await act(async () => root.unmount());
    const keyWarnings = error.mock.calls.filter((call) => String(call[0]).includes("same key"));
    error.mockRestore();
    expect(keyWarnings).toEqual([]);
  });
});
