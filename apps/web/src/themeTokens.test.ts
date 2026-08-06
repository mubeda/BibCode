import { build, type Rollup } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { Window } from "happy-dom";
import tailwindcss from "@tailwindcss/vite";

let windowInstance: Window;
let originalDocument: Document | undefined;
let originalGetComputedStyle: typeof getComputedStyle | undefined;
let compiledStylesheet = "";
const applicationStylesheetPath = new URL("./index.css", import.meta.url).pathname;

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
          id === applicationStylesheetPath ? `${code}\n@source inline("text-link");` : undefined,
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

describe("application theme tokens", () => {
  beforeAll(async () => {
    const stylesheet = await loadApplicationStylesheet();
    compiledStylesheet = stylesheet;
    windowInstance = new Window();
    windowInstance.document.documentElement.style.setProperty("--color-white", "white");
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
