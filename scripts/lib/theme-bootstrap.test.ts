// @effect-diagnostics nodeBuiltinImport:off - Tests inspect web assets and evaluate the bootstrap without a browser.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";

import {
  UI_COLOR_TOKENS,
  UI_KEYWORD_TOKENS,
  UI_LENGTH_TOKENS,
} from "../../packages/contracts/src/theme.ts";
import {
  assertNoInlineScripts,
  themeBootstrapPlugins,
  themeBootstrapVersionPlugin,
  versionThemeBootstrap,
} from "./theme-bootstrap.ts";

const indexHtmlPath = new URL("../../apps/web/index.html", import.meta.url);
const bootstrapPath = new URL("../../apps/web/public/theme-bootstrap.js", import.meta.url);

// Copied from git show HEAD:apps/web/index.html before the external bootstrap change.
const oldInlineBootstrap = `<script>
      (() => {
        const LIGHT_BACKGROUND = "#ffffff";
        const DARK_BACKGROUND = "#161616";
        const themeColorMeta = document.querySelector('meta[name="theme-color"]');
        try {
          const storedTheme = window.localStorage.getItem("bibcode:theme");
          const theme =
            storedTheme === "light" || storedTheme === "dark" || storedTheme === "system"
              ? storedTheme
              : "system";
          const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
          const isDark = theme === "dark" || (theme === "system" && prefersDark);
          document.documentElement.classList.toggle("dark", isDark);
          const chromeColor = isDark ? DARK_BACKGROUND : LIGHT_BACKGROUND;
          document.documentElement.style.backgroundColor = chromeColor;
          themeColorMeta?.setAttribute("content", chromeColor);
        } catch {
          document.documentElement.classList.add("dark");
          document.documentElement.style.backgroundColor = DARK_BACKGROUND;
          themeColorMeta?.setAttribute("content", DARK_BACKGROUND);
        }
      })();
    </script>`;

const builtHtml = `<head>
  <script src="/theme-bootstrap.js?v=ba7816bf8f01"></script>
  <script type="module" crossorigin src="/assets/index-x.js"></script>
</head>`;

describe("web theme bootstrap", () => {
  it("loads only same-origin external scripts and blocks on the theme before the module entry", () => {
    const html = NodeFS.readFileSync(indexHtmlPath, "utf8");
    const scripts = Array.from(html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi));

    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attributes = "", body = ""] of scripts) {
      const src = /\ssrc\s*=\s*(["'])(.*?)\1/i.exec(attributes)?.[2];
      expect(src).toMatch(/^\/(?!\/)/);
      expect(body.trim()).toBe("");
    }

    const bootstrapScripts = scripts.filter(([, attributes = ""]) =>
      /\ssrc\s*=\s*(["'])\/theme-bootstrap\.js\1/i.test(attributes),
    );
    expect(bootstrapScripts).toHaveLength(1);
    const [bootstrap] = bootstrapScripts;
    expect(bootstrap?.[1]).not.toMatch(/\s(?:async|defer|type)(?:\s|=|$)/i);
    expect(bootstrap?.index).toBeLessThan(html.indexOf("</head>"));
    const moduleEntry = scripts.find(([, attributes = ""]) =>
      /\stype\s*=\s*(["'])module\1/i.test(attributes),
    );
    expect(moduleEntry).toBeDefined();
    expect(bootstrap?.index).toBeLessThan(moduleEntry?.index ?? -1);
    expect(NodeFS.existsSync(bootstrapPath)).toBe(true);
  });

  it("applies stored dark mode even when the system prefers light", () => {
    expect(evaluateBootstrap("dark", false)).toEqual({
      dark: true,
      backgroundColor: "#161616",
      metaContent: "#161616",
    });
  });

  it("applies stored light mode even when the system prefers dark", () => {
    expect(evaluateBootstrap("light", true)).toEqual({
      dark: false,
      backgroundColor: "#ffffff",
      metaContent: "#ffffff",
    });
  });

  it.each([
    { storedTheme: "system", prefersDark: true, color: "#161616" },
    { storedTheme: "system", prefersDark: false, color: "#ffffff" },
    { storedTheme: null, prefersDark: true, color: "#161616" },
    { storedTheme: null, prefersDark: false, color: "#ffffff" },
  ])(
    "follows the system for stored $storedTheme with prefersDark=$prefersDark",
    ({ storedTheme, prefersDark, color }) => {
      expect(evaluateBootstrap(storedTheme, prefersDark)).toEqual({
        dark: prefersDark,
        backgroundColor: color,
        metaContent: color,
      });
    },
  );

  it("falls back to dark mode when localStorage throws", () => {
    expect(evaluateBootstrap(null, false, true)).toEqual({
      dark: true,
      backgroundColor: "#161616",
      metaContent: "#161616",
    });
  });
});

describe("web theme bootstrap paint record", () => {
  const record = (overrides: Record<string, unknown> = {}) => ({
    base: "dark",
    background: "#101820",
    vars: { "--background": "#101820", "--primary": "#7aa2f7", "--radius": "0.5rem" },
    stamp: "s1",
    ...overrides,
  });
  const stored = (dark: unknown, paintStamp = "s1") => ({
    "bibcode:theme": "dark",
    "bibcode:theme-slots:v1": JSON.stringify({ light: "light", dark: "custom", paintStamp }),
    "bibcode:theme-paint:v1": JSON.stringify({
      light: { base: "light", background: "#ffffff", vars: {}, stamp: paintStamp },
      dark,
    }),
  });
  const builtInDark = { dark: true, backgroundColor: "#161616", vars: {}, attributes: {} };

  it("a stored paint record sets the class, the properties and the background before anything else runs", () => {
    expect(evaluateBootstrapWithStorage(stored(record()))).toEqual({
      dark: true,
      backgroundColor: "#101820",
      metaContent: "#101820",
      vars: { "--background": "#101820", "--primary": "#7aa2f7", "--radius": "0.5rem" },
      attributes: {},
    });
  });

  it("sets the focus ring and control shadow attributes from the record", () => {
    const result = evaluateBootstrapWithStorage(
      stored(
        record({
          vars: {
            "--focus-ring-width": "2px",
            "--focus-ring-offset": "2px",
            "--control-shadow": "none",
          },
        }),
      ),
    );
    expect(result.attributes).toEqual({
      "data-theme-focus-ring": "",
      "data-theme-control-shadow": "none",
    });
  });

  it("a corrupt paint record falls back to the built-in background for the stored mode", () => {
    const entries = { ...stored(record()), "bibcode:theme-paint:v1": "{not json" };
    expect(evaluateBootstrapWithStorage(entries)).toMatchObject(builtInDark);
  });

  it.each([
    ["a property outside the allowlist", record({ vars: { "--x": "#ffffff" } })],
    ["a non-custom property", record({ vars: { background: "#ffffff" } })],
    ["inherit", record({ vars: { "--primary": "inherit" } })],
    ["url(x)", record({ vars: { "--primary": "url(x)" } })],
    ["var(--y)", record({ vars: { "--primary": "var(--y)" } })],
    ["a named color", record({ vars: { "--primary": "red" } })],
    ["rgb() instead of hex", record({ vars: { "--primary": "rgb(0 0 0)" } })],
    ["a radius of 9rem", record({ vars: { "--radius": "9rem" } })],
    ["a focus width of 30px", record({ vars: { "--focus-ring-width": "30px" } })],
    [
      "a keyword with a declaration",
      record({ vars: { "--control-shadow": "default; color: red" } }),
    ],
    ["sidebar-card-shadow default", record({ vars: { "--sidebar-card-shadow": "default" } })],
    ["a background that is not hex", record({ background: "url(x)" })],
    ["a record for the other base", record({ base: "light" })],
    ["a missing stamp", record({ stamp: undefined })],
    ["a record that is not an object", "not an object"],
  ])("hostile paint records are not applied: %s", (_label, dark) => {
    expect(evaluateBootstrapWithStorage(stored(dark))).toMatchObject(builtInDark);
  });

  it("hostile paint records are not applied: a record over 32 KiB", () => {
    const vars = { "--primary": "#7aa2f7", padding: "x".repeat(33 * 1024) };
    expect(evaluateBootstrapWithStorage(stored(record({ vars })))).toMatchObject(builtInDark);
  });

  it("a paint record whose stamp differs from the slots' paintStamp is not applied", () => {
    expect(evaluateBootstrapWithStorage(stored(record({ stamp: "new" }), "old"))).toMatchObject(
      builtInDark,
    );
  });

  it("the allowlist in the script equals the supported tokens of the contracts module", () => {
    const source = NodeFS.readFileSync(bootstrapPath, "utf8");
    const literal = (name: string) => {
      const match = new RegExp(`const ${name} = ([\\[{][\\s\\S]*?[\\]}]);`).exec(source);
      if (!match) throw new Error(`theme-bootstrap.js has no ${name}`);
      return NodeVM.runInNewContext(`(${match[1]})`) as unknown;
    };
    expect([...(literal("COLOR_TOKENS") as string[])].toSorted()).toEqual(
      [...UI_COLOR_TOKENS].toSorted(),
    );
    expect(Object.keys(literal("LENGTH_RANGES") as object).toSorted()).toEqual(
      [...UI_LENGTH_TOKENS].toSorted(),
    );
    expect(Object.keys(literal("KEYWORDS") as object).toSorted()).toEqual(
      [...UI_KEYWORD_TOKENS].toSorted(),
    );
  });
});

describe("versionThemeBootstrap", () => {
  it.each(['"', "'"])("rewrites only the bootstrap src with %s quotes", (quote) => {
    const html = `<head>
  <link href="/theme-bootstrap.js" rel="preload" as="script" />
  <script data-label="theme" src=${quote}/theme-bootstrap.js${quote}></script>
  <script type="module" src="/entry.js" data-src="/theme-bootstrap.js"></script>
</head>`;

    expect(versionThemeBootstrap(html, "abc")).toBe(`<head>
  <link href="/theme-bootstrap.js" rel="preload" as="script" />
  <script data-label="theme" src=${quote}/theme-bootstrap.js?v=ba7816bf8f01${quote}></script>
  <script type="module" src="/entry.js" data-src="/theme-bootstrap.js"></script>
</head>`);
  });

  it("keeps the version stable for the same source", () => {
    const html = '<script src="/theme-bootstrap.js"></script>';
    const first = versionThemeBootstrap(html, "abc");

    expect(versionThemeBootstrap(html, "abc")).toBe(first);
  });

  it("changes the version when the source changes", () => {
    const html = '<script src="/theme-bootstrap.js"></script>';

    expect(versionThemeBootstrap(html, "abcd")).toBe(
      '<script src="/theme-bootstrap.js?v=88d4266fd4e6"></script>',
    );
    expect(versionThemeBootstrap(html, "abcd")).not.toBe(versionThemeBootstrap(html, "abc"));
  });

  it("rejects HTML without a bootstrap script", () => {
    const html = '<script src="/entry.js" data-src="/theme-bootstrap.js"></script>';

    expect(() => versionThemeBootstrap(html, "abc")).toThrow(
      'Expected exactly one script with src="/theme-bootstrap.js" in index HTML; found 0',
    );
  });

  it("rejects HTML with two bootstrap scripts", () => {
    const html = '<script src="/theme-bootstrap.js"></script>'.repeat(2);

    expect(() => versionThemeBootstrap(html, "abc")).toThrow(
      'Expected exactly one script with src="/theme-bootstrap.js" in index HTML; found 2',
    );
  });
});

describe("themeBootstrapVersionPlugin", () => {
  it("versions the page using the real public bootstrap source", () => {
    const html = NodeFS.readFileSync(indexHtmlPath, "utf8");
    const source = NodeFS.readFileSync(bootstrapPath, "utf8");
    const plugin = themeBootstrapVersionPlugin();

    expect(plugin.name).toBe("bibcode-theme-bootstrap-version");
    expect(plugin.transformIndexHtml.handler(html)).toBe(versionThemeBootstrap(html, source));
  });
});

describe("assertNoInlineScripts", () => {
  it("rejects the original inline theme bootstrap and identifies its first 80 characters", () => {
    expect(() => assertNoInlineScripts(oldInlineBootstrap)).toThrow(
      `Inline script is not allowed in built index HTML: ${oldInlineBootstrap.slice(0, 80)}`,
    );
  });

  it("accepts the current index HTML", () => {
    expect(() => assertNoInlineScripts(NodeFS.readFileSync(indexHtmlPath, "utf8"))).not.toThrow();
  });

  it("accepts the built bootstrap and module entry with empty bodies", () => {
    expect(() => assertNoInlineScripts(builtHtml)).not.toThrow();
  });

  it("accepts an external script with only whitespace in its body", () => {
    expect(() => assertNoInlineScripts('<SCRIPT SRC="/a.js"> \n\t </SCRIPT>')).not.toThrow();
  });

  it.each([
    '<script src="/a.js">code</script>',
    "<script> \n\t </script>",
    '<script data-src="/a.js"></script>',
  ])("rejects %s even after valid external scripts", (script) => {
    expect(() => assertNoInlineScripts(builtHtml + script)).toThrow(
      `Inline script is not allowed in built index HTML: ${script.slice(0, 80)}`,
    );
  });
});

describe("themeBootstrapPlugins", () => {
  it("keeps versioning in both modes and rejects inline scripts after build transforms", () => {
    const [versionPlugin, buildPlugin] = themeBootstrapPlugins();

    expect(versionPlugin).not.toHaveProperty("apply");
    expect(versionPlugin?.transformIndexHtml.order).toBe("pre");
    expect(buildPlugin).toMatchObject({
      apply: "build",
      transformIndexHtml: { order: "post" },
    });
    expect(() => buildPlugin?.transformIndexHtml.handler(builtHtml)).not.toThrow();
    expect(() => buildPlugin?.transformIndexHtml.handler(builtHtml + oldInlineBootstrap)).toThrow(
      `Inline script is not allowed in built index HTML: ${oldInlineBootstrap.slice(0, 80)}`,
    );
  });
});

function evaluateBootstrap(
  storedTheme: string | null,
  prefersDark: boolean,
  storageThrows = false,
) {
  const classes = new Set<string>();
  const style = { backgroundColor: "" };
  const meta = {
    content: "",
    setAttribute(name: string, value: string) {
      if (name === "content") this.content = value;
    },
  };
  const document = {
    documentElement: {
      classList: {
        toggle(name: string, enabled: boolean) {
          if (enabled) classes.add(name);
          else classes.delete(name);
        },
        add(name: string) {
          classes.add(name);
        },
      },
      style,
    },
    querySelector(selector: string) {
      return selector === 'meta[name="theme-color"]' ? meta : null;
    },
  };
  const window = {
    localStorage: {
      getItem(key: string) {
        if (storageThrows) throw new Error("Storage is unavailable");
        return key === "bibcode:theme" ? storedTheme : null;
      },
    },
    matchMedia(query: string) {
      return { matches: query === "(prefers-color-scheme: dark)" && prefersDark };
    },
  };

  NodeVM.runInNewContext(NodeFS.readFileSync(bootstrapPath, "utf8"), { window, document });

  return {
    dark: classes.has("dark"),
    backgroundColor: style.backgroundColor,
    metaContent: meta.content,
  };
}

function evaluateBootstrapWithStorage(entries: Record<string, string>, prefersDark = false) {
  const classes = new Set<string>();
  const vars: Record<string, string> = {};
  const attributes: Record<string, string> = {};
  const style = {
    backgroundColor: "",
    setProperty(name: string, value: string) {
      vars[name] = value;
    },
  };
  const meta = {
    content: "",
    setAttribute(name: string, value: string) {
      if (name === "content") this.content = value;
    },
  };
  const document = {
    documentElement: {
      classList: {
        toggle(name: string, enabled: boolean) {
          if (enabled) classes.add(name);
          else classes.delete(name);
        },
        add(name: string) {
          classes.add(name);
        },
      },
      style,
      setAttribute(name: string, value: string) {
        attributes[name] = value;
      },
    },
    querySelector(selector: string) {
      return selector === 'meta[name="theme-color"]' ? meta : null;
    },
  };
  const window = {
    localStorage: { getItem: (key: string) => entries[key] ?? null },
    matchMedia: (query: string) => ({
      matches: query === "(prefers-color-scheme: dark)" && prefersDark,
    }),
  };

  NodeVM.runInNewContext(NodeFS.readFileSync(bootstrapPath, "utf8"), { window, document });

  return {
    dark: classes.has("dark"),
    backgroundColor: style.backgroundColor,
    metaContent: meta.content,
    vars,
    attributes,
  };
}
