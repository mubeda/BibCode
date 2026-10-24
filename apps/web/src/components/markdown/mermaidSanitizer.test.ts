// @vitest-environment jsdom
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "pele/lazy";

import { MERMAID_CORPUS } from "../../test/mermaidCorpus";
import { MERMAID_SANITIZER_PROBES } from "../../test/mermaidSanitizerProbes";
import {
  isSafeCssValue,
  sanitizeDiagramSvg,
  sanitizeDiagramSvgWithReport,
} from "./mermaidSanitizer";

/** The root style Pele 1.3.0 writes with the app's font stacks. */
const PELE_ROOT_STYLE =
  "max-width:100%;height:auto;--_bg:var(--pele-bg,#fff);--_fg:var(--pele-fg,#1f1f1f);" +
  "--_m:var(--pele-muted,#6e6e6e);--_l:var(--pele-line,#1f1f1f);--_s:var(--pele-surface,#f3f3f3);" +
  "--_a:var(--pele-surface-alt,#e6e6e6);--_b:var(--pele-border,#8a8a8a);" +
  "--_c:var(--pele-accent,#5b7bd5);color:var(--_fg);--_r:var(--pele-radius,4px);" +
  '--_fm:var(--pele-font-mono,"SF Mono", "SFMono-Regular", "JetBrains Mono", Consolas, monospace);' +
  "font:14px sans-serif;letter-spacing:normal;word-spacing:normal;text-transform:none;" +
  'direction:ltr;font-family:var(--pele-font,"DM Sans Variable", "DM Sans", -apple-system, ' +
  'BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif)';

function svg(body: string, rootAttributes = ""): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"${rootAttributes}>${body}</svg>`;
}

function parse(markup: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = markup;
  return host;
}

function styleOf(markup: string, selector: string): string | null {
  return parse(markup).querySelector(selector)?.getAttribute("style") ?? null;
}

describe("diagram SVG sanitizer", () => {
  describe("removes", () => {
    it("links, keeping their text", () => {
      const host = parse(
        sanitizeDiagramSvg(svg('<a href="javascript:alert(1)"><text x="1">Open</text></a>')),
      );
      expect(host.querySelector("a")).toBeNull();
      expect(host.querySelector("text")?.textContent).toBe("Open");
    });

    it.each([
      ["an event handler", '<rect width="1" onclick="alert(1)"></rect>', "[onclick]"],
      ["a script", "<script>alert(1)</script>", "script"],
      ["foreign HTML", "<foreignObject><div>html</div></foreignObject>", "foreignObject, div"],
      ["a style element", "<style>body{display:none}</style>", "style"],
      ["an image", '<image href="/mermaid-probe/image"></image>', "image"],
      ["a use reference", '<use href="#other"></use>', "use"],
      [
        "an animation",
        '<animate attributeName="href" to="javascript:alert(1)"></animate>',
        "animate",
      ],
      ["a set animation", '<set attributeName="fill" to="red"></set>', "set"],
      ["xlink:href", '<rect xlink:href="/mermaid-probe/x" width="1"></rect>', "[xlink\\:href]"],
      ["src", '<rect src="/mermaid-probe/src" width="1"></rect>', "[src]"],
      ["srcset", '<rect srcset="/mermaid-probe/srcset 1x" width="1"></rect>', "[srcset]"],
      ["filter", '<rect filter="url(#f)" width="1"></rect>', "[filter]"],
      ["mask", '<rect mask="url(#m)" width="1"></rect>', "[mask]"],
      ["clip-path", '<rect clip-path="url(#c)" width="1"></rect>', "[clip-path]"],
    ])("%s", (_name, body, selector) => {
      const report = sanitizeDiagramSvgWithReport(svg(body));
      expect(parse(report.svg).querySelector(selector)).toBeNull();
      expect(report.svg).not.toContain("mermaid-probe");
      expect(report.svg).not.toContain("alert");
    });
  });

  describe("drops CSS that could load a resource or escape", () => {
    it.each([
      ["a remote url()", 'style="fill:url(https://x.test/a)"'],
      ["image-set()", 'style="background-image:image-set(&quot;/mermaid-probe/a&quot; 1x)"'],
      ["an escaped url() in style", 'style="fill:u\\72l(/mermaid-probe/b)"'],
      ["a custom property holding url()", 'style="--_fg:url(/mermaid-probe/d)"'],
      ["url() inside a var() fallback", 'style="fill:var(--x,url(/mermaid-probe/e))"'],
      ["a quoted string holding a semicolon", 'style="font-family:&quot;a;b&quot;"'],
      ["a property outside the allowlist", 'style="background-image:none"'],
      ["a comment", 'style="fill:red/**/"'],
      ["an at-rule", 'style="fill:@import"'],
      ["an unknown custom property", 'style="--app-color:red"'],
      ["var() without a custom property", 'style="fill:var(url)"'],
    ])("%s", (_name, attribute) => {
      const clean = sanitizeDiagramSvg(svg(`<rect width="1" ${attribute}></rect>`));
      expect(styleOf(clean, "rect")).toBeNull();
      expect(clean).not.toContain("mermaid-probe");
      expect(clean).not.toContain("url(");
    });

    it("keeps the allowed declarations of a style it trims", () => {
      const clean = sanitizeDiagramSvg(
        svg(
          '<rect width="1" style="fill:#fde68a;background:url(/mermaid-probe/f);stroke:red"></rect>',
        ),
      );
      expect(styleOf(clean, "rect")).toBe("fill:#fde68a;stroke:red");
    });

    it.each([
      ["an escaped url() in a presentation attribute", 'fill="u\\72l(/mermaid-probe/c)"'],
      ["a remote url() in a presentation attribute", 'stroke="url(https://x.test/s)"'],
      ["a url() reference in a non-paint attribute", 'stop-color="url(#g)"'],
      ["script in a transform", 'transform="translate(1) url(/mermaid-probe/t)"'],
      ["a foreign namespace", 'xmlns="http://www.w3.org/1999/xhtml"'],
    ])("%s", (_name, attribute) => {
      const clean = sanitizeDiagramSvg(`<svg><g ${attribute}><rect width="1"></rect></g></svg>`);
      const group = parse(clean).querySelector("g");
      expect(group?.attributes.length).toBe(0);
      expect(clean).not.toContain("mermaid-probe");
    });

    it("keeps only Pele's own classes", () => {
      const host = parse(
        sanitizeDiagramSvg(svg('<g class="pele-node hidden"></g><g class="hidden absolute"></g>')),
      );
      const [peleGroup, appGroup] = host.querySelectorAll("g");
      expect(peleGroup?.getAttribute("class")).toBe("pele-node");
      expect(appGroup?.hasAttribute("class")).toBe(false);
    });
  });

  describe("keeps", () => {
    it("Pele's root style unchanged", () => {
      const clean = sanitizeDiagramSvg(
        svg(
          "",
          ` role="graphics-document document" aria-roledescription="flowchart" style='${PELE_ROOT_STYLE}'`,
        ),
      );
      const root = parse(clean).querySelector("svg");
      expect(root?.getAttribute("style")).toBe(PELE_ROOT_STYLE);
      expect(root?.getAttribute("role")).toBe("graphics-document document");
      expect(root?.getAttribute("aria-roledescription")).toBe("flowchart");
    });

    it("same-document gradient paint, color functions and Pele's custom properties", () => {
      const clean = sanitizeDiagramSvg(
        svg(
          '<defs><linearGradient id="g" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="rgb(1,2,3)"></stop></linearGradient></defs>' +
            '<rect width="1" fill="url(#g)" style="fill:rgb(1,2,3);stroke:hsla(1,2%,3%,0.5)"></rect>' +
            '<g style="--_fg:var(--pele-fg)" transform="translate(1.5,-2) rotate(45)"></g>',
        ),
      );
      const host = parse(clean);
      expect(host.querySelector("rect")?.getAttribute("fill")).toBe("url(#g)");
      expect(host.querySelector("rect")?.getAttribute("style")).toBe(
        "fill:rgb(1,2,3);stroke:hsla(1,2%,3%,0.5)",
      );
      expect(host.querySelector("g")?.getAttribute("style")).toBe("--_fg:var(--pele-fg)");
      expect(host.querySelector("g")?.getAttribute("transform")).toBe(
        "translate(1.5,-2) rotate(45)",
      );
      expect(host.querySelector("stop")?.getAttribute("stop-color")).toBe("rgb(1,2,3)");
    });

    it("titles, descriptions and ARIA attributes", () => {
      const host = parse(
        sanitizeDiagramSvg(
          svg(
            '<title>Release flow</title><desc>Steps</desc><g aria-label="Build" aria-hidden="true"></g>',
          ),
        ),
      );
      expect(host.querySelector("title")?.textContent).toBe("Release flow");
      expect(host.querySelector("desc")?.textContent).toBe("Steps");
      expect(host.querySelector("g")?.getAttribute("aria-label")).toBe("Build");
    });
  });

  it("checks CSS values by allowlist", () => {
    expect(isSafeCssValue('"DM Sans Variable", sans-serif')).toBe(true);
    expect(isSafeCssValue("var( --pele-fg , #fff)")).toBe(true);
    expect(isSafeCssValue("RGB(1, 2, 3)")).toBe(true);
    expect(isSafeCssValue("URL(/x)")).toBe(false);
    expect(isSafeCssValue("calc(1px + 2px)")).toBe(false);
    expect(isSafeCssValue('"unbalanced')).toBe(false);
    expect(isSafeCssValue("'a:b'")).toBe(false);
    expect(isSafeCssValue("red\\9")).toBe(false);
  });

  it("refuses to pass SVG through when DOMPurify is unsupported", () => {
    // Without a document DOMPurify reports itself unsupported and would return its input.
    vi.stubGlobal("window", {});
    try {
      expect(() => sanitizeDiagramSvg(svg("<script>alert(1)</script>"))).toThrow(
        "The diagram sanitizer is unavailable.",
      );
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sanitizeDiagramSvg(svg("<script>alert(1)</script>"))).not.toContain("script");
  });

  it.each(MERMAID_SANITIZER_PROBES)("leaves the $name probe nothing to load", ({ svg: probe }) => {
    const clean = sanitizeDiagramSvg(probe);
    expect(clean).not.toContain("mermaid-probe");
    expect(parse(clean).querySelector("svg")).not.toBeNull();
  });

  it("draws no link, image or remote URL from hostile Mermaid source", async () => {
    const { loadMermaidDiagramType, renderMermaidDiagram } = await import("./mermaidRenderer");
    const source = [
      "flowchart TD",
      "  A[Start] --> B[Next] --> C[\"<a href='javascript:alert(1)'>html</a>\"]",
      '  img@{ img: "https://x.test/mermaid-probe/node.png", label: "Image", w: 60, h: 60 }',
      '  click A "javascript:alert(1)"',
      "  click B call fn()",
      '  click C href "https://x.test/mermaid-probe/link"',
      "  classDef bad fill:#f00,stroke-width:4px",
      "  class A bad",
    ].join("\n");
    await loadMermaidDiagramType(source);
    const { svg: clean } = renderMermaidDiagram(source, CORPUS_FONTS, "hostile");
    const host = parse(clean);
    expect(host.querySelector("svg")).not.toBeNull();
    expect(host.querySelectorAll("a, image, foreignObject, style, script, use")).toHaveLength(0);
    expect(clean).not.toMatch(/url\((?!#)/);
    expect(clean).not.toContain("mermaid-probe");
    expect(clean).not.toContain("javascript:");

    // Pele's grammar refuses a function in a style value, so these never draw at all.
    for (const line of [
      "classDef bad fill:url(https://x.test/mermaid-probe/fill)",
      "style A fill:image-set('/mermaid-probe/i' 1x)",
    ]) {
      expect(() =>
        renderMermaidDiagram(`flowchart TD\n  A --> B\n  ${line}\n`, CORPUS_FONTS, "hostile"),
      ).toThrow();
    }
  });

  it("removes nothing from the corpus Pele draws, apart from authored class names", async () => {
    const { loadMermaidDiagramType, mermaidRenderOptions } = await import("./mermaidRenderer");
    let drawn = 0;
    for (const [name, source] of Object.entries(MERMAID_CORPUS)) {
      await loadMermaidDiagramType(source);
      let raw: string;
      try {
        raw = render(source, mermaidRenderOptions(CORPUS_FONTS, `corpus-${drawn}`)).svg;
      } catch {
        expect(name, "only the invalid sample may fail").toBe("invalidFlowchart");
        continue;
      }
      drawn += 1;
      const report = sanitizeDiagramSvgWithReport(raw);
      expect(report.removed, name).toEqual([]);
      expect(
        report.dropped.filter((entry) => !entry.startsWith("class ")),
        name,
      ).toEqual([]);
      expect(report.svg.length, name).toBeGreaterThan(raw.length * 0.9);
    }
    expect(drawn).toBe(Object.keys(MERMAID_CORPUS).length - 1);
  });
});

const CORPUS_FONTS = {
  fontFamily:
    '"DM Sans Variable", "DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  fontFamilyMono: '"SF Mono", "SFMono-Regular", "JetBrains Mono", Consolas, monospace',
  fontSize: 14,
};
