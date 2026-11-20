// @vitest-environment happy-dom

import { vi } from "vite-plus/test";

// The editors read the platform once, when their modules load, so it is set before the suite's
// imports run.
vi.hoisted(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

const { defineFileUndoChordSuite } = await import("./fileUndoChords.suite");

defineFileUndoChordSuite("mac");
