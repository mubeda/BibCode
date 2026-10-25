// @vitest-environment happy-dom

import {
  parsePatchFiles,
  registerCustomCSSVariableTheme,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { hydrateCompareFile } from "~/lib/diffCompareModel";

const testTheme = "compare-hydration-integration";
registerCustomCSSVariableTheme(testTheme, { background: "#ffffff", foreground: "#000000" });

const OLD_ID = "1".repeat(40);
const NEW_ID = "2".repeat(40);

function lines(replace: Record<number, string> = {}): string {
  return Array.from(
    { length: 40 },
    (_, index) => `${replace[index + 1] ?? `line ${index + 1}`}\n`,
  ).join("");
}

const OLD = lines();
const NEW = lines({ 10: "line ten", 30: "line thirty" });

/** The patch Git prints for OLD → NEW with `-U<context>`. */
function patch(context: number): FileDiffMetadata {
  const hunk = (line: number, replacement: string) => {
    const start = Math.max(1, line - context);
    const end = Math.min(40, line + context);
    const body = [];
    for (let current = start; current <= end; current += 1) {
      if (current === line) body.push(`-line ${line}`, `+${replacement}`);
      else body.push(` line ${current}`);
    }
    const count = end - start + 1;
    const range = count === 1 ? `${start}` : `${start},${count}`;
    return [`@@ -${range} +${range} @@`, ...body];
  };
  const text = [
    "diff --git a/numbers.txt b/numbers.txt",
    `index ${OLD_ID}..${NEW_ID} 100644`,
    "--- a/numbers.txt",
    "+++ b/numbers.txt",
    ...hunk(10, "line ten"),
    ...hunk(30, "line thirty"),
    "",
  ].join("\n");
  return parsePatchFiles(text, `compare-hydration-${context}`)[0]!.files[0]!;
}

function renderedLineNumbers(container: HTMLElement): Set<string> {
  const shadow = container.querySelector("diffs-container")?.shadowRoot;
  const numbers = new Set<string>();
  for (const node of shadow?.querySelectorAll("[data-line]") ?? []) {
    const line = node.getAttribute("data-line");
    if (line) numbers.add(line);
  }
  return numbers;
}

describe("Compare hydration in pierre", () => {
  let container: HTMLDivElement;
  let root: Root;
  let canvasGetContext: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    canvasGetContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      font: "",
      measureText: (text: string) => ({ width: text.length * 8 }),
    } as unknown as CanvasRenderingContext2D);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    canvasGetContext.mockRestore();
  });

  async function render(
    fileDiff: FileDiffMetadata,
    expandUnchanged: boolean,
  ): Promise<Set<string>> {
    await act(async () => {
      root.render(
        <FileDiff
          fileDiff={fileDiff}
          options={{ theme: testTheme, diffStyle: "split", expandUnchanged }}
        />,
      );
    });
    return renderedLineNumbers(container);
  }

  it.each([0, 7])(
    "All lines shows every line and Changes only keeps gaps, with -U%i",
    async (context) => {
      const hydration = hydrateCompareFile(patch(context), OLD, NEW);
      expect(hydration.kind).toBe("hydrated");
      if (hydration.kind !== "hydrated") return;

      const all = await render(hydration.fileDiff, true);
      for (let line = 1; line <= 40; line += 1) {
        expect(all.has(String(line)), `line ${line} with All lines`).toBe(true);
      }

      const partialOnly = await render(patch(context), true);
      expect(partialOnly.has("20"), "a patch alone has no lines between its hunks").toBe(false);

      const changes = await render(hydration.fileDiff, false);
      expect(changes.has("10")).toBe(true);
      expect(changes.has("30")).toBe(true);
      expect(changes.has("20"), "the gap between the hunks stays collapsed").toBe(false);
      expect(changes.has(String(10 + context))).toBe(true);
      expect(changes.has(String(10 + context + 1)), "context past N is collapsed").toBe(false);
    },
  );
});
