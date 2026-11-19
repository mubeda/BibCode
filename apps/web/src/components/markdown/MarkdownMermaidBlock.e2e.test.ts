// @vitest-environment happy-dom
import { expect, it, vi } from "vite-plus/test";

// The packaged UI build sets this flag; it must be in place before the module loads.
vi.hoisted(() => vi.stubEnv("VITE_BIBCODE_DESKTOP_E2E", "1"));

import { __holdMermaidDrawsForTests } from "./MarkdownMermaidBlock";

it("gives the packaged UI build's page the draw hold", () => {
  expect(
    (window as Window & { __bibcodeHoldMermaidDraws?: unknown }).__bibcodeHoldMermaidDraws,
  ).toBe(__holdMermaidDrawsForTests);
});
