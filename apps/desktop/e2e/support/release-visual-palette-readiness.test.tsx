// @effect-diagnostics nodeBuiltinImport:off - Real component and pinned SDK replay over inert DOM ports.
// @vitest-environment happy-dom
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import { expect, it, vi } from "vite-plus/test";
import { Command, CommandInput } from "../../../web/src/components/ui/command.tsx";
import { CommandPaletteResults } from "../../../web/src/components/CommandPaletteResults.tsx";
import { filterCommandPaletteGroups } from "../../../web/src/components/CommandPalette.logic.ts";

it.each(["single-sequential", "multi-sequential", "single-coalesced", "multi-coalesced"])(
  "executes the palette source and pinned SDK against real deferred results: %s",
  async (mode) => {
    const repo = NodePath.resolve(".");
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const web = NodeModule.createRequire(repo + "/apps/web/package.json");
    const desktop = NodeModule.createRequire(repo + "/apps/desktop/package.json");
    const sdkRequire = NodeModule.createRequire(desktop.resolve("webdriverio"));
    const { createElement, act, useState, useDeferredValue } = web("react");
    const { createRoot } = web("react-dom/client");
    // Coalesced public input events stay pending until a read-only owner poll yields.
    // act flushes actual React work; no highlight, DOM, store or native timing is injected.
    const settle = async () => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      try {
        await act(async () => {});
      } finally {
        vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", !mode.endsWith("coalesced"));
      }
    };

    const sdkSource = NodeFS.readFileSync(
      NodePath.join(NodePath.dirname(desktop.resolve("webdriverio")), "node.js"),
      "utf8",
    );
    const cut = (name: string, async: boolean) => {
      const first = sdkSource.indexOf(`${async ? "async " : ""}function ${name}(`);
      const last = sdkSource.indexOf("\n//", first);
      expect(first).toBeGreaterThan(0);
      expect(last).toBeGreaterThan(first);
      return sdkSource.slice(first, last);
    };
    const unicodeStart = sdkSource.indexOf("function checkUnicode(");
    const unicodeEnd = sdkSource.indexOf("function fetchElementByJSFunction(", unicodeStart);
    const utilsEntry = NodePath.resolve(
      NodePath.dirname(NodeFS.realpathSync(desktop.resolve("webdriverio"))),
      "../../@wdio/utils/build/index.js",
    );
    const unicode = (await import(utilsEntry)).UNICODE_CHARACTERS;

    const splitter = sdkRequire("grapheme-splitter");

    const keyStart = sdkSource.indexOf("var Key = {"),
      keyEnd = sdkSource.indexOf("\n};", keyStart) + 3;
    const key = NodeVM.runInNewContext(sdkSource.slice(keyStart, keyEnd) + "\nKey", {
      UNICODE_CHARACTERS: unicode,
    });

    const sdk = NodeVM.runInNewContext(
      [
        cut("clearValue", false),
        cut("addValue", false),
        cut("setValue", true),
        cut("keys", true),
        sdkSource.slice(unicodeStart, unicodeEnd),
      ].join("\n") + "\n({ clearValue, addValue, setValue, keys })",
      {
        VALID_TYPES: ["string", "number"],
        Key: key,
        UNICODE_CHARACTERS2: unicode,
        GraphemeSplitter: splitter,
      },
    );

    const item = (value: string, title: string, searchTerms: string[]) => ({
      kind: "action",
      value,
      title,
      searchTerms,
      icon: null,
      run: async () => {},
    });
    const settings = item("action:settings", "Open settings", ["settings", "preferences"]);
    const groups = mode.startsWith("multi")
      ? [
          {
            value: "recent-threads",
            label: "Recent",
            items: [item("recent", "Prior workspace", ["prior"])],
          },
          {
            value: "actions",
            label: "Actions",
            items: [item("add", "Add project", ["add"]), settings],
          },
        ]
      : [
          {
            value: "actions",
            label: "Actions",
            items: [item("add", "Add project", ["add"]), settings],
          },
        ];
    function Harness() {
      const [query, setQuery] = useState("");
      const deferredQuery = useDeferredValue(query);
      const displayed = filterCommandPaletteGroups({
        activeGroups: groups,
        query: deferredQuery,
        isInSubmenu: false,
        projectSearchItems: [],
        threadSearchItems: [],
      });
      return createElement(
        "div",
        { "data-testid": "command-palette" },
        createElement(
          Command,
          { autoHighlight: "always", mode: "none", value: query, onValueChange: setQuery },
          createElement(CommandInput, {}),
          createElement(CommandPaletteResults, {
            groups: displayed,
            isActionsOnly: false,
            keybindings: [],
            onExecuteItem: () => {
              throw new Error("No action execution in this source probe.");
            },
          }),
        ),
      );
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const input = () =>
      document.querySelector<HTMLInputElement>('[data-slot="autocomplete-input"]')!;
    let keyUps = 0,
      keyDowns = 0,
      clears = 0,
      types = 0,
      captures = 0;
    const edited = async (operation: () => void) =>
      mode.endsWith("coalesced") ? operation() : act(async () => operation());
    const element = {
      elementId: "owned-search",
      clearValue: () => sdk.clearValue.call(element),
      addValue: (value: string) => sdk.addValue.call(element, value),
      elementClear: async () => {
        clears++;
        await edited(() => input().focus());
        await edited(() => {
          nativeValue.call(input(), "");
          input().dispatchEvent(new Event("input", { bubbles: true }));
        });
        await edited(() => input().blur());
      },
      elementSendKeys: async (_id: string, value: string) => {
        types++;
        await edited(() => input().focus());
        await edited(() => {
          nativeValue.call(input(), input().value + value);
          input().dispatchEvent(
            new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }),
          );
        });
      },
    };
    const browser = {
      $$: (selector: string) => ({
        length: Promise.resolve(document.querySelectorAll(selector).length),
      }),
      $: (selector: string) => {
        if (selector.startsWith("//"))
          return {
            isDisplayed: async () => {
              const rows = document.querySelectorAll(
                '[data-testid="command-palette"] [data-slot="command-item"]',
              );
              return rows.length === 1 && rows[0]?.textContent?.includes("Open settings") === true;
            },
          };
        expect(selector).toBe('[data-testid="command-palette"] [data-slot="autocomplete-input"]');
        return {
          waitForDisplayed: async () => expect(input()).toBeInstanceOf(HTMLInputElement),
          isFocused: async () => document.activeElement === input(),
          getValue: async () => input().value,
          setValue: (value: string) => sdk.setValue.call(element, value),
        };
      },
      keys: (value: string) => sdk.keys.call(browser, value),
      action: (kind: string) => {
        expect(kind).toBe("key");
        const actions: Array<[string, string | number]> = [];
        const builder = {
          down: (value: string) => {
            actions.push(["keydown", value]);
            return builder;
          },
          up: (value: string) => {
            actions.push(["keyup", value]);
            return builder;
          },
          pause: (value: number) => {
            expect(value).toBe(10);
            actions.push(["pause", value]);
            return builder;
          },
          perform: async (skipRelease: boolean) => {
            expect(skipRelease).toBe(true);
            for (const [type, value] of actions) {
              if (type === "pause") {
                await Promise.resolve();
                continue;
              }
              expect(value).toBe(key.ArrowDown);
              if (type === "keydown") keyDowns++;
              else keyUps++;
              await edited(() =>
                input().dispatchEvent(
                  new KeyboardEvent(type, {
                    key: "ArrowDown",
                    code: "ArrowDown",
                    bubbles: true,
                    cancelable: true,
                  }),
                ),
              );
            }
          },
        };
        return builder;
      },
    };
    const source = NodeFS.readFileSync(
      repo + "/apps/desktop/e2e/support/release-visual-core.ts",
      "utf8",
    );
    const start = source.indexOf('  const search = browser.$(\'[data-testid="command-palette"]');
    const end = source.indexOf('  await browser.keys("Escape");', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        "async function run(){" + source.slice(start, end) + "}\nrun",
      ),
      {
        browser,
        owner: {
          until: async (check: () => Promise<boolean>) => {
            for (let attempt = 0; attempt < 4; attempt++) {
              if (await check()) return;
              await settle();
            }
            throw new Error("Inert public row readiness timed out.");
          },
        },
        capture: async (scene: string) => {
          expect(scene).toBe("command-palette");
          captures++;
        },
      },
    );

    try {
      await act(async () => root.render(createElement(Harness, {})));

      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", !mode.endsWith("coalesced"));
      await run();
      await settle();

      const rows = document.querySelectorAll('[data-slot="command-item"]');
      const active = document.querySelectorAll('[data-slot="command-item"][data-highlighted]');
      const baseline = { clears, types, keyDowns, keyUps, captures };

      const facts = {
        mode,
        inputValueMatched: input().value === "settings",
        rowCount: Math.min(rows.length, 9),
        filteredAction:
          rows.length === 1 && rows[0]?.textContent?.includes("Open settings") === true,
        highlightedCount: Math.min(active.length, 9),
        inputFocused: document.activeElement === input(),
        ...baseline,
        nativeProof: false,
      };

      expect(facts.inputValueMatched).toBe(true);
      expect(facts.filteredAction).toBe(true);
      expect(facts.inputFocused).toBe(true);
      expect(Object.values(baseline)).toEqual([1, 1, 1, 1, 1]);

      expect(active).toHaveLength(1);
    } finally {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  },
);
