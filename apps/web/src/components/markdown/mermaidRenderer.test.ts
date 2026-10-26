// @vitest-environment jsdom
import { PeleError } from "pele/lazy";
import { describe, expect, it } from "vite-plus/test";

import { MERMAID_EDGE_LIMIT } from "./mermaidFence";
import {
  describeMermaidProblem,
  loadMermaidDiagramType,
  mermaidRenderOptions,
  renderMermaidDiagram,
} from "./mermaidRenderer";

const FONTS = { fontFamily: "sans-serif", fontFamilyMono: "monospace", fontSize: 14 };

async function problemFor(source: string) {
  await loadMermaidDiagramType(source);
  try {
    renderMermaidDiagram(source, FONTS, "test");
  } catch (error) {
    return describeMermaidProblem(error);
  }
  throw new Error("the diagram drew");
}

describe("Mermaid renderer", () => {
  it("draws sanitized SVG with the diagram's natural size and the given id prefix", async () => {
    const source = "flowchart TD\n  accTitle: Steps\n  A[Write] --> B[Draw]\n";
    await loadMermaidDiagramType(source);
    const diagram = renderMermaidDiagram(source, FONTS, "bibcode-mmd-7");
    expect(diagram.width).toBeGreaterThan(0);
    expect(diagram.height).toBeGreaterThan(0);
    expect(diagram.svg).toMatch(/^<svg/);
    expect(diagram.svg).toContain('id="bibcode-mmd-7-title"');
    expect(diagram.svg).toContain("max-width:100%");
  });

  it("keeps the authored direction and turns links and images off", () => {
    expect(mermaidRenderOptions(FONTS, "p")).toMatchObject({
      autoDirection: false,
      links: false,
      images: false,
      responsive: true,
      limit: 25_000,
      maxEdges: MERMAID_EDGE_LIMIT,
      outputLimit: 1_000_000,
      idPrefix: "p",
      fontSize: 14,
    });
    expect(mermaidRenderOptions(FONTS, "p")).not.toHaveProperty("maxWidth");
  });

  it("reports a syntax error with its line and Pele's explanation, without the snippet", async () => {
    expect(await problemFor("flowchart TD\n  A --> B\n  B --> C]\n")).toEqual({
      kind: "invalid",
      line: 3,
      detail: "Unrecognized text.",
    });
    const unclosed = await problemFor("flowchart TD\n  A[Start --> B\n");
    expect(unclosed).toMatchObject({ kind: "invalid", line: 4 });
    expect(unclosed.kind === "invalid" && unclosed.detail).toMatch(/^Expecting /);
  });

  it("reports semantic errors, invalid front matter and unknown diagram types", async () => {
    expect(await problemFor("sequenceDiagram\n  A->>B: hi\n  deactivate A\n")).toEqual({
      kind: "invalid",
      line: 0,
      detail: "Trying to inactivate an inactive participant (A)",
    });
    expect(await problemFor("---\ntitle: [unclosed\n---\nflowchart TD\nA-->B\n")).toMatchObject({
      kind: "invalid",
      line: 0,
    });
    expect(await problemFor("notADiagram\n  A\n")).toEqual({ kind: "unsupported" });
  });

  it("reports the limit a diagram exceeds", async () => {
    const edges = Array.from(
      { length: MERMAID_EDGE_LIMIT + 1 },
      (_, index) => `  n${index} --> n${index + 1}`,
    );
    expect(await problemFor(`flowchart TD\n${edges.join("\n")}\n`)).toEqual({
      kind: "too-large",
      limit: "edges",
    });
    expect(await problemFor(`flowchart TD\n  A --> B\n${"%% x\n".repeat(12_000)}`)).toEqual({
      kind: "too-large",
      limit: "characters",
    });
    expect(
      describeMermaidProblem(new PeleError("Diagram output is longer than the limit.", "limit")),
    ).toEqual({ kind: "too-large", limit: "output" });
  });

  it("classifies any other failure by its error name only", () => {
    expect(describeMermaidProblem(new TypeError("source text"))).toEqual({
      kind: "failed",
      code: "TypeError",
    });
    expect(describeMermaidProblem("thrown")).toEqual({ kind: "failed", code: "unknown" });
  });
});
