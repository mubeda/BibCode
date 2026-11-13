// @effect-diagnostics nodeBuiltinImport:off - The token checks read the checked-in stylesheet.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { build, normalizePath, type Rollup } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { Window } from "happy-dom";
import tailwindcss from "@tailwindcss/vite";

import { buttonVariants } from "./components/ui/button";

const css = NodeFS.readFileSync(new URL("./index.css", import.meta.url), "utf8");

let windowInstance: Window;
let originalDocument: Document | undefined;
let originalGetComputedStyle: typeof getComputedStyle | undefined;
let compiledStylesheet = "";
const TEST_UTILITIES = [
  "text-link",
  "text-placeholder",
  "bg-primary",
  "bg-primary/90",
  "bg-primary-hover",
  "bg-primary-active",
  "bg-selected",
  "text-selected-foreground",
];
const applicationStylesheetPath = normalizePath(
  NodeURL.fileURLToPath(new URL("./index.css", import.meta.url)),
);

async function loadApplicationStylesheet(): Promise<string> {
  const buildResult = (await build({
    configFile: false,
    logLevel: "silent",
    mode: "test",
    plugins: [
      {
        enforce: "pre",
        name: "theme-token-test-utilities",
        transform: (code, id) =>
          id === applicationStylesheetPath
            ? `${code}\n@source inline("${TEST_UTILITIES.join(" ")}");`
            : undefined,
      },
      {
        name: "theme-token-test-entry",
        resolveId: (id) => (id === "virtual:theme-token-test" ? `\0${id}` : undefined),
        load: (id) =>
          id === "\0virtual:theme-token-test"
            ? `import ${JSON.stringify(applicationStylesheetPath)};`
            : undefined,
      },
      tailwindcss(),
    ],
    root: new URL("../", import.meta.url).pathname,
    build: {
      rollupOptions: {
        input: "virtual:theme-token-test",
      },
      write: false,
    },
  })) as Rollup.RollupOutput | Rollup.RollupOutput[];
  const outputs = Array.isArray(buildResult)
    ? buildResult.flatMap((result) => result.output)
    : buildResult.output;
  const stylesheet = outputs.find(
    (output): output is Rollup.OutputAsset =>
      output.type === "asset" &&
      output.fileName.endsWith(".css") &&
      typeof output.source === "string",
  );

  if (!stylesheet || typeof stylesheet.source !== "string") {
    throw new Error("The web build did not emit a stylesheet.");
  }

  return stylesheet.source;
}

function themeTokens(): CSSStyleDeclaration {
  return getComputedStyle(document.documentElement);
}

function compiledTextLinkColor(): string {
  const match = compiledStylesheet.match(/\.text-link\{color:([^}]+)}/);
  if (!match) {
    throw new Error("The compiled stylesheet did not emit the text-link utility.");
  }

  return match[1] ?? "";
}

/**
 * The color a utility paints inside `host`, with every variable substituted. happy-dom does not
 * compute `color-mix()`, so the utility's declaration is resolved through a custom property and a
 * mix with transparent is written as `<color> @ <percent>`; the color space does not matter for
 * such a mix.
 */
function paintedValue(utility: string, host: Element = document.body): string {
  const selector = `.${utility.replace(/[/:]/g, (character) => `\\${character}`)}{`;
  const start = compiledStylesheet.lastIndexOf(selector);
  if (start < 0) throw new Error(`The compiled stylesheet did not emit ${utility}.`);
  const body = compiledStylesheet.slice(start + selector.length);
  const value = body.slice(body.indexOf(":") + 1, body.search(/[;}]/));
  const probe = document.createElement("span");
  probe.style.setProperty("--painted-probe", value);
  host.append(probe);
  const resolved = getComputedStyle(probe).getPropertyValue("--painted-probe").trim();
  probe.remove();
  const mix = /^color-mix\(in [a-z]+,\s*(.+?)\s+(\d+%),\s*transparent\)$/.exec(resolved);
  return mix ? `${mix[1]} @ ${mix[2]}` : resolved;
}

describe("application theme tokens", () => {
  beforeAll(async () => {
    const stylesheet = await loadApplicationStylesheet();
    compiledStylesheet = stylesheet;
    windowInstance = new Window();
    windowInstance.document.documentElement.style.setProperty("--color-white", "white");
    windowInstance.document.documentElement.style.setProperty(
      "--color-neutral-400",
      "rgb(163, 163, 163)",
    );
    windowInstance.document.documentElement.style.setProperty(
      "--color-blue-400",
      "rgb(96, 165, 250)",
    );
    windowInstance.document.documentElement.style.setProperty(
      "--color-blue-500",
      "rgb(59, 130, 246)",
    );
    windowInstance.document.documentElement.style.setProperty(
      "--color-blue-700",
      "rgb(29, 78, 216)",
    );
    const style = windowInstance.document.createElement("style");
    style.textContent = stylesheet;
    windowInstance.document.head.append(style);

    originalDocument = globalThis.document;
    originalGetComputedStyle = globalThis.getComputedStyle;
    globalThis.document = windowInstance.document as unknown as Document;
    globalThis.getComputedStyle = windowInstance.getComputedStyle.bind(
      windowInstance,
    ) as unknown as typeof getComputedStyle;
  }, 30_000);

  afterAll(() => {
    windowInstance?.close();
    if (originalDocument === undefined) {
      delete (globalThis as { document?: Document }).document;
    } else {
      globalThis.document = originalDocument;
    }
    if (originalGetComputedStyle === undefined) {
      delete (globalThis as { getComputedStyle?: typeof getComputedStyle }).getComputedStyle;
    } else {
      globalThis.getComputedStyle = originalGetComputedStyle;
    }
  });

  it("uses the approved orange interaction tokens and white foreground in both themes", () => {
    document.documentElement.className = "";
    expect(themeTokens().getPropertyValue("--primary").trim()).toBe("#d8610e");
    expect(themeTokens().getPropertyValue("--ring").trim()).toBe("#d8610e");
    expect(themeTokens().getPropertyValue("--primary-foreground").trim()).toBe("white");

    document.documentElement.classList.add("dark");

    expect(themeTokens().getPropertyValue("--primary").trim()).toBe("#d8610e");
    expect(themeTokens().getPropertyValue("--ring").trim()).toBe("#d8610e");
    expect(themeTokens().getPropertyValue("--primary-foreground").trim()).toBe("white");
  });

  it("a placeholder inside a dark sidebar card resolves from the card's muted-foreground", () => {
    document.documentElement.className = "dark";
    const card = document.createElement("div");
    card.setAttribute("data-sidebar-card", "");
    document.body.append(card);

    expect(paintedValue("text-placeholder", card)).toBe("rgb(163, 163, 163) @ 72%");

    card.remove();
  });

  it("the default primary hover equals primary at 90 percent", () => {
    for (const mode of ["", "dark"]) {
      document.documentElement.className = mode;
      expect(paintedValue("bg-primary-hover"), mode).toBe("#d8610e @ 90%");
      expect(paintedValue("bg-primary-hover"), mode).toBe(paintedValue("bg-primary/90"));
    }
  });

  it("button idle, hover and pressed colors are unchanged in Light and Dark", () => {
    for (const mode of ["", "dark"]) {
      document.documentElement.className = mode;
      // Recorded before the change: idle bg-primary, hover and press bg-primary/90.
      expect(paintedValue("bg-primary"), mode).toBe("#d8610e");
      expect(paintedValue("bg-primary-hover"), mode).toBe("#d8610e @ 90%");
      expect(paintedValue("bg-primary-active"), mode).toBe("#d8610e @ 90%");
    }
  });

  it("Verdant Light hover and pressed values apply when the theme sets them", () => {
    document.documentElement.className = "";
    document.documentElement.style.setProperty("--primary-hover", "#066649");
    document.documentElement.style.setProperty("--primary-active", "#05543d");

    expect(paintedValue("bg-primary-hover")).toBe("#066649");
    expect(paintedValue("bg-primary-active")).toBe("#05543d");

    document.documentElement.style.removeProperty("--primary-hover");
    document.documentElement.style.removeProperty("--primary-active");
  });

  it("keeps link and information semantics blue", () => {
    document.documentElement.className = "";
    expect(themeTokens().getPropertyValue("--link").trim()).toBe("rgb(29, 78, 216)");
    expect(themeTokens().getPropertyValue("--info").trim()).toBe("rgb(59, 130, 246)");
    expect(themeTokens().getPropertyValue("--info-foreground").trim()).toBe("rgb(29, 78, 216)");

    document.documentElement.classList.add("dark");

    expect(themeTokens().getPropertyValue("--link").trim()).toBe("rgb(96, 165, 250)");
    expect(themeTokens().getPropertyValue("--info").trim()).toBe("rgb(59, 130, 246)");
    expect(themeTokens().getPropertyValue("--info-foreground").trim()).toBe("rgb(96, 165, 250)");
  });

  function diagramColors(): Record<string, string> {
    const chat = document.createElement("div");
    chat.className = "chat-markdown";
    const diagram = document.createElement("div");
    diagram.className = "chat-markdown-mermaid";
    chat.append(diagram);
    document.body.append(chat);
    const styles = getComputedStyle(diagram);
    const colors = Object.fromEntries(
      ["--pele-bg", "--pele-fg", "--pele-accent"].map((name) => [
        name,
        styles.getPropertyValue(name).trim(),
      ]),
    );
    chat.remove();
    return colors;
  }

  it("a rendered diagram container follows a change of info, background and foreground", () => {
    document.documentElement.className = "dark";
    const before = diagramColors();
    const root = document.documentElement.style;
    root.setProperty("--info", "#7dcfff");
    root.setProperty("--background", "#1a1b26");
    root.setProperty("--foreground", "#a9b1d6");
    const after = diagramColors();
    for (const name of ["--info", "--background", "--foreground"]) root.removeProperty(name);

    expect(after).toEqual({
      "--pele-bg": "#1a1b26",
      "--pele-fg": "#a9b1d6",
      "--pele-accent": "#7dcfff",
    });
    for (const name of Object.keys(after)) expect(after[name], name).not.toBe(before[name]);
  });

  it("a change of primary alone does not change the diagram colors", () => {
    document.documentElement.className = "dark";
    const before = diagramColors();
    document.documentElement.style.setProperty("--primary", "#7aa2f7");
    const after = diagramColors();
    document.documentElement.style.removeProperty("--primary");
    expect(after).toEqual(before);
  });

  /** Paints Verdant Light's focus and shadow tokens on the root, as applyTheme does. */
  function withVerdantFocusAndShadow(run: () => void) {
    const root = document.documentElement;
    root.className = "";
    root.setAttribute("data-theme-focus-ring", "");
    root.setAttribute("data-theme-control-shadow", "none");
    root.style.setProperty("--focus-ring-width", "2px");
    root.style.setProperty("--focus-ring-offset", "2px");
    try {
      run();
    } finally {
      root.removeAttribute("data-theme-focus-ring");
      root.removeAttribute("data-theme-control-shadow");
      root.style.removeProperty("--focus-ring-width");
      root.style.removeProperty("--focus-ring-offset");
    }
  }
  function mountButton(): HTMLButtonElement {
    const button = document.createElement("button");
    button.className = buttonVariants({ variant: "default" });
    button.setAttribute("data-control-shadow", "");
    document.body.append(button);
    return button;
  }
  const noShadow = (value: string) => /^(none|0 0 #0000(, 0 0 #0000)*|)$/.test(value.trim());

  it("under Verdant Light a focused button has a 2px outline with a 2px offset and no ring shadow", () => {
    withVerdantFocusAndShadow(() => {
      const button = mountButton();
      button.focus();
      const styles = getComputedStyle(button);
      expect(styles.outlineStyle).toBe("solid");
      expect(styles.outlineWidth).toBe("2px");
      expect(styles.outlineOffset).toBe("2px");
      expect(styles.getPropertyValue("--tw-ring-shadow").trim()).toBe("0 0 #0000");
      button.remove();
    });
  });

  it("under Verdant Light a focused input shows the 2px outline on its wrapper and no 3px ring", () => {
    withVerdantFocusAndShadow(() => {
      const wrapper = document.createElement("span");
      wrapper.setAttribute("data-focus-ring-owner", "");
      wrapper.className = "has-focus-visible:ring-[3px]";
      const input = document.createElement("input");
      input.className = "outline-none";
      wrapper.append(input);
      document.body.append(wrapper);
      input.focus();
      const outer = getComputedStyle(wrapper);
      expect(outer.outlineWidth).toBe("2px");
      expect(outer.outlineOffset).toBe("2px");
      expect(outer.getPropertyValue("--tw-ring-shadow").trim()).toBe("0 0 #0000");
      expect(getComputedStyle(input).outlineStyle).not.toBe("solid");
      wrapper.remove();
    });
  });

  /**
   * happy-dom applies no rule inside a cascade layer, so the layered button and composer shadows
   * compute as empty. These unlayered stand-ins give each owner a shadow the theme must remove.
   */
  function withStandInShadows(run: () => void) {
    const style = document.createElement("style");
    style.textContent =
      ".stand-in-shadow, .stand-in-shadow::before, .stand-in-shadow::after, .chat-composer-glass { box-shadow: 0 1px 2px rgb(0 0 0 / 30%); }";
    document.head.append(style);
    const button = mountButton();
    button.classList.add("stand-in-shadow");
    const send = document.createElement("button");
    send.setAttribute("data-control-shadow", "");
    send.className = "stand-in-shadow";
    const composer = document.createElement("div");
    composer.className = "chat-composer-glass";
    document.body.append(send, composer);
    try {
      run();
    } finally {
      for (const element of [style, button, send, composer]) element.remove();
    }
  }
  const shadowsOf = () =>
    [...document.querySelectorAll(".stand-in-shadow, .chat-composer-glass")].map(
      (element) => getComputedStyle(element).boxShadow,
    );

  it("under Verdant Light the button, its pseudo-elements, the Send button and the composer surface (.chat-composer-glass) have no box shadow", () => {
    withVerdantFocusAndShadow(() =>
      withStandInShadows(() => {
        for (const shadow of shadowsOf()) expect(noShadow(shadow), shadow).toBe(true);
        // happy-dom computes no pseudo-element styles, so the pseudo-element rule is read as text.
        expect(css).toContain(
          ':root[data-theme-control-shadow="none"] [data-control-shadow]::before',
        );
        expect(css).toContain(
          ':root[data-theme-control-shadow="none"] [data-control-shadow]::after',
        );
      }),
    );
  });

  it("under Light and Dark the focus ring and shadows equal the values recorded before the change", () => {
    for (const mode of ["", "dark"]) {
      document.documentElement.className = mode;
      withStandInShadows(() => {
        const button = document.querySelector<HTMLButtonElement>("button.stand-in-shadow")!;
        button.focus();
        expect(getComputedStyle(button).outlineStyle, mode).not.toBe("solid");
        expect(getComputedStyle(button).outlineWidth, mode).not.toBe("2px");
        for (const shadow of shadowsOf()) expect(shadow, mode).toBe("0 1px 2px rgb(0 0 0 / 30%)");
      });
    }
  });

  it("routes Tailwind link utilities and markdown anchors through blue link semantics", () => {
    const chat = document.createElement("div");
    chat.className = "chat-markdown";
    const anchor = document.createElement("a");
    chat.append(anchor);
    document.body.append(chat);
    document.documentElement.style.setProperty("--info-foreground", "rgb(255, 0, 0)");

    expect(compiledTextLinkColor()).toBe("var(--link)");

    document.documentElement.className = "";
    expect(getComputedStyle(anchor).color).toBe("rgb(29, 78, 216)");

    document.documentElement.classList.add("dark");
    expect(getComputedStyle(anchor).color).toBe("rgb(96, 165, 250)");

    document.documentElement.style.removeProperty("--info-foreground");
    chat.remove();
  });
});
