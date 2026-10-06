// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - Inert source execution and private temporary owner markers; no browser or provider processes.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeVM from "node:vm";
import { afterEach, expect, it, vi } from "vite-plus/test";
import * as ProviderChat from "./release-visual-provider-chat.ts";
import {
  providerChatScenes,
  providerChatScreenshotName,
  providerChatViewport,
  readProviderChatWitness,
  validateProviderChatWitness,
  runProviderChatScene,
  projectProviderChatCapture,
  captureProviderChatScene,
  type ProviderChatInput,
  type ProviderChatDriver,
} from "./release-visual-provider-chat.ts";
import {
  providerChatFixturePrompts,
  withOwnedCodexVisualOptionRefusal,
} from "./release-visual-provider-chat-fixture.ts";

const input: ProviderChatInput = {
  scene: "composer-command-menu",
  theme: "light",
  origin: "http://127.0.0.1:4885",
  threadId: "owned",
  branch: "codex/delivery-retry-light",
};
function commandDom() {
  vi.stubGlobal("location", {
    origin: input.origin,
    pathname: "/local/owned",
    search: "",
    hash: "",
  });
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("innerHeight", 960);
  document.documentElement.className = "";
  document.body.innerHTML =
    '<div data-testid="environment-rail-local" aria-checked="true"><i data-status="connected"></i></div><button data-testid="thread-card-button-owned" aria-current="page"></button><div data-center-surface-host data-visible="true"><button data-chat-provider-model-picker="true" aria-label="Claude Opus">Opus</button><div data-testid="composer-editor">/comp</div><div data-composer-menu="true" data-composer-menu-loading="false"><div data-composer-item-active="true">/compact Compact the deterministic fixture context.</div></div></div>';
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(10, 10, 300, 200),
  );
  vi.spyOn(document, "elementFromPoint").mockImplementation(() =>
    document.querySelector('[data-composer-item-active="true"]'),
  );
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

it("selects High through the real composer trait menu and its normal options callback", async () => {
  const prepare = Reflect.get(ProviderChat, "selectOwnedCodexVisualHigh");
  expect(typeof prepare).toBe("function");
  vi.stubGlobal("location", {
    origin: input.origin,
    pathname: "/local/owned",
    search: "",
    hash: "",
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(10, 10, 300, 200),
  );
  document.body.innerHTML =
    '<div data-testid="environment-rail-local" aria-checked="true"><i data-status="connected"></i></div><button data-testid="thread-card-button-owned" aria-current="page" aria-describedby="owned-branch"></button><div id="owned-branch"><span data-slot="tooltip-trigger">codex/delivery-retry-light</span></div>';
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const require = NodeModule.createRequire(NodePath.resolve("apps/web/package.json"));
  const { act, createElement, useState } = require("react") as {
    act: (run: () => void | Promise<void>) => Promise<void>;
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => unknown;
    useState: <T>(value: T) => [T, (value: T) => void];
  };
  const { createRoot } = require("react-dom/client") as {
    createRoot: (node: Element) => { render: (value: unknown) => void; unmount: () => void };
  };
  const traitsModule = "../../../web/src/components/chat/TraitsPicker.tsx";
  const { ComposerTraitControls } = await import(traitsModule);
  const replies: unknown[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const animations = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  function Composer() {
    const [options, setOptions] = useState([{ id: "reasoningEffort", value: "medium" }]);
    return createElement(
      "div",
      { "data-center-surface-host": "chat:host", "data-visible": "true" },
      createElement(
        "button",
        { "data-chat-provider-model-picker": "true", "aria-label": "Codex · GPT-5.4" },
        "GPT-5.4",
      ),
      createElement(ComposerTraitControls, {
        provider: "codex",
        instanceId: "codex",
        model: "gpt-5.4",
        prompt: "",
        onPromptChange: () => {},
        models: [
          {
            slug: "gpt-5.4",
            name: "GPT-5.4",
            isCustom: false,
            capabilities: {
              optionDescriptors: [
                {
                  id: "reasoningEffort",
                  label: "Reasoning effort",
                  type: "select",
                  currentValue: "medium",
                  options: [
                    { id: "medium", label: "Medium", isDefault: true },
                    { id: "high", label: "High" },
                  ],
                },
              ],
            },
          },
        ],
        modelOptions: options,
        onModelOptionsChange: (next: Array<{ id: string; value: string }>) => {
          replies.push(next);
          setOptions(next);
        },
      }),
    );
  }
  try {
    await act(async () => root.render(createElement(Composer, null)));
    const owner = {
      until: async (read: () => Promise<boolean>) => expect(await read()).toBe(true),
    };
    const browser = {
      $: (selector: string) => {
        const node = () => {
          if (selector.startsWith("//")) {
            expect(selector).toBe(
              '//*[@role="menuitemradio"][.//span[@data-effort-title="true" and normalize-space()="High"]]',
            );
            const values = Array.from(
              document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
            ).filter(
              (item) =>
                item.querySelector('[data-effort-title="true"]')?.textContent?.trim() === "High",
            );
            expect(values).toHaveLength(1);
            return values[0]!;
          }
          const values = document.querySelectorAll<HTMLButtonElement>(selector);
          expect(values).toHaveLength(1);
          return values[0]!;
        };
        return {
          waitForDisplayed: async () => expect(node()).not.toBeNull(),
          waitForEnabled: async () => expect(node().getAttribute("aria-disabled")).not.toBe("true"),
          click: async () => act(async () => node().click()),
        };
      },
      $$: () => ({ length: Promise.resolve(1) }),
      execute: async (reader: (value: unknown) => unknown, value: unknown) => {
        const callback = NodeVM.runInNewContext("(" + reader.toString() + ")", {
          document,
          location,
          getComputedStyle,
        });
        return callback(value);
      },
    };
    // These inert ports implement only the operations exercised by the actual helper.
    await prepare({
      browser,
      owner,
      ...input,
      scene: "chat-refused-model",
      verifyOwnedIdentity: async () => {},
    } as unknown as Parameters<typeof ProviderChat.selectOwnedCodexVisualHigh>[0]);
    expect(replies).toEqual([[{ id: "reasoningEffort", value: "high" }]]);
    expect(document.querySelector('button[aria-label="Reasoning effort: High"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    if (animations) Object.defineProperty(Element.prototype, "getAnimations", animations);
    else Reflect.deleteProperty(Element.prototype, "getAnimations");
  }
});

it.each(["null", "missing", "extra", "getter", "proxy", "unsafe", "foreign-model", "non-boolean"])(
  "refuses unsafe High preparation %s before public actions without inspecting private data",
  async (mode) => {
    const prepare = Reflect.get(ProviderChat, "selectOwnedCodexVisualHigh");
    let reads = 0,
      actions = 0;
    let value: unknown = { contextMatched: true, codexModelMatched: true, highSelected: false };
    if (mode === "null") value = null;
    if (mode === "missing") delete (value as Record<string, unknown>).highSelected;
    if (mode === "extra") Object.assign(value as object, { private: "not retained" });
    if (mode === "unsafe") Object.assign(value as object, { contextMatched: false });
    if (mode === "foreign-model") Object.assign(value as object, { codexModelMatched: false });
    if (mode === "non-boolean") Object.assign(value as object, { highSelected: "private" });
    if (mode === "getter")
      Object.defineProperty(value, "highSelected", {
        enumerable: true,
        get() {
          reads++;
          throw new Error("Inert private getter.");
        },
      });
    if (mode === "proxy")
      value = new Proxy(value as object, {
        ownKeys() {
          reads++;
          throw new Error("Inert private proxy.");
        },
      });
    await expect(
      prepare({
        ...input,
        scene: "chat-refused-model",
        verifyOwnedIdentity: async () => {},
        browser: {
          execute: async () => value,
          $: () => {
            actions++;
            throw new Error("No unsafe action.");
          },
        },
        owner: {
          until: async () => {
            actions++;
            throw new Error("No unsafe poll.");
          },
        },
      } as unknown as Parameters<typeof ProviderChat.selectOwnedCodexVisualHigh>[0]),
    ).rejects.toThrow("Owned public Codex High selection refused.");
    expect(actions).toBe(0);
    expect(reads).toBe(0);
  },
);
it("retains all eight inventory bindings and the exact narrow Activity geometry", () => {
  expect(providerChatScenes).toHaveLength(8);
  for (const scene of providerChatScenes)
    for (const theme of ["light", "dark"])
      expect(providerChatScreenshotName(scene, theme)).toBe(`${scene}-${theme}.png`);
  expect(providerChatViewport("activity-narrow")).toEqual({ width: 960, height: 800 });
  expect(providerChatViewport("context-popover")).toEqual({ width: 1280, height: 960 });
  for (const scene of ["unknown", "../../private", "workspace-composite"])
    expect(() => providerChatScreenshotName(scene, "light")).toThrow();
  expect(() => providerChatScreenshotName("context-popover", "system")).toThrow();
});
it("refuses duplicate captures, an open real-alert state, and unavailable multiselect before DOM commands", async () => {
  const calls: string[] = [];
  const base = {
    ...input,
    captured: new Set<string>(),
    evidence: "/owned-evidence",
    browser: {
      isAlertOpen: async () => {
        calls.push("alert");
        return true;
      },
    },
    verifyOwnedIdentity: async () => {
      calls.push("identity");
    },
  } as unknown as Parameters<typeof captureProviderChatScene>[0];
  await expect(captureProviderChatScene(base)).rejects.toThrow();
  expect(calls).toEqual(["alert"]);
  calls.length = 0;
  await expect(
    captureProviderChatScene({ ...base, captured: new Set(["composer-command-menu-light.png"]) }),
  ).rejects.toThrow();
  await expect(
    captureProviderChatScene({ ...base, scene: "question-multiselect" }),
  ).rejects.toThrow("Owned multiselect protocol is unqualified.");
  expect(calls).toEqual([]);
});
it("executes the imported shared capture and keeps pixels unretained after the post-screenshot witness fails", async () => {
  commandDom();
  const evidence = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "provider-capture-post-"));
  const calls: string[] = [],
    captured = new Set<string>();
  try {
    await expect(
      captureProviderChatScene({
        ...input,
        captured,
        evidence,
        verifyOwnedIdentity: async () => {
          calls.push("identity");
        },
        owner: {
          until: async (probe: () => Promise<boolean>) => {
            expect(await probe()).toBe(true);
          },
        },
        browser: {
          isAlertOpen: async () => false,
          execute: async (read: typeof readProviderChatWitness, value: ProviderChatInput) => {
            calls.push("read");
            return read(value);
          },
          takeScreenshot: async () => {
            calls.push("screenshot");
            document.documentElement.className = "dark";
            return "";
          },
        },
      } as unknown as Parameters<typeof captureProviderChatScene>[0]),
    ).rejects.toThrow("Owned provider visual witness refused.");
    expect(calls).toEqual(["identity", "read", "screenshot", "identity", "read"]);
    expect(captured.size).toBe(0);
    expect(NodeFS.readdirSync(evidence)).toEqual([]);
  } finally {
    NodeFS.rmSync(evidence, { recursive: true, force: true });
  }
});
it.each([
  "chat-held-workspace-loss",
  "chat-refused-model",
  "chat-markdown-plan",
  "activity-narrow",
  "context-popover",
  "mcp-popover",
] as const)(
  "keeps %s behind the existing owner admission and genuine public actions",
  async (scene) => {
    const calls: string[] = [];
    const driver = {
      browser: {
        $: (selector: string) => ({
          waitForDisplayed: async () => {
            calls.push("display");
          },
          waitForEnabled: async () => {
            calls.push("enabled");
          },
          click: async () => {
            calls.push("click:" + selector);
          },
        }),
      },
      prepare: async () => {
        calls.push("prepare");
      },
      verifyOwnedIdentity: async () => {
        calls.push("identity");
      },
      send: async () => {
        calls.push("send");
      },
      draft: async () => {
        calls.push("draft");
      },
      viewport: async (width: number, height: number) => {
        calls.push(`viewport:${width}x${height}`);
      },
      withRefusedModel: async (sendAndCapture: () => Promise<void>) => {
        calls.push("refusal-arm");
        try {
          await sendAndCapture();
        } finally {
          calls.push("refusal-restored");
        }
      },
      withManagedWorkspaceLoss: async (
        capture: (scope: { kind: "provider-chat-registered-managed-loss" }) => Promise<void>,
      ) => {
        calls.push("loss");
        try {
          await capture({ kind: "provider-chat-registered-managed-loss" });
        } finally {
          calls.push("restore");
        }
      },
      capture: async () => {
        calls.push("capture");
      },
    } as unknown as Parameters<typeof runProviderChatScene>[0];
    await actualProviderSceneDriver()(driver, scene);
    const click = (selector: string) => ["display", "enabled", "click:" + selector];
    const expected: Record<string, string[]> = {
      "chat-held-workspace-loss": ["send", "send", "draft", "loss", "capture", "restore"],
      "chat-refused-model": ["refusal-arm", "send", "send", "draft", "capture", "refusal-restored"],
      "chat-markdown-plan": [
        "send",
        "draft",
        ...click('button[aria-label^="Show "][aria-label$=" sidebar"]'),
        "capture",
      ],
      "activity-narrow": [
        "send",
        ...click('button[aria-label^="Expand activity summary:"]'),
        ...click('button[aria-label^="Open Subagents:"]'),
        ...click('[data-activity-row$="bibcode-ui-reviewer-thread"]'),
        "capture",
      ],
      "context-popover": ["send", ...click('button[aria-label^="Context window "]'), "capture"],
      "mcp-popover": ["send", ...click('button[aria-label="MCP servers"]'), "capture"],
    };
    expect(calls).toEqual([
      "prepare",
      "identity",
      scene === "activity-narrow" ? "viewport:960x800" : "viewport:1280x960",
      ...expected[scene]!,
      "identity",
    ]);
  },
);
it("executes the real closed observer and refuses foreign routes before page inspection", () => {
  commandDom();
  const facts = readProviderChatWitness(input);
  expect(validateProviderChatWitness(input.scene, facts)).toEqual(facts);
  expect(Object.values(facts!)).toEqual(Array(Object.keys(facts!).length).fill(true));
  vi.stubGlobal("location", {
    origin: "http://foreign.invalid",
    pathname: "/local/owned",
    search: "",
    hash: "",
  });
  const query = vi.spyOn(document, "querySelectorAll");
  expect(readProviderChatWitness(input)).toBeNull();
  expect(query).not.toHaveBeenCalled();
});
it.each([
  "credential",
  "wrong-theme",
  "duplicate",
  "no-active",
  "wrong-description",
  "hidden",
  "hidden-ancestor",
  "occluded",
  "boot",
])("fails closed for the actual command-menu seam: %s", (mode) => {
  commandDom();
  const menu = document.querySelector<HTMLElement>('[data-composer-menu="true"]')!;
  if (mode === "credential") {
    const field = document.createElement("input");
    field.type = "password";
    document.body.append(field);
  }
  if (mode === "wrong-theme") document.documentElement.className = "dark";
  if (mode === "duplicate") document.body.append(menu.cloneNode(true));
  if (mode === "no-active")
    menu.querySelector("div")!.setAttribute("data-composer-item-active", "false");
  if (mode === "wrong-description") menu.textContent = "unrelated";
  if (mode === "hidden") menu.style.display = "none";
  if (mode === "hidden-ancestor") menu.parentElement!.style.opacity = "0";
  if (mode === "occluded") vi.spyOn(document, "elementFromPoint").mockReturnValue(document.body);
  if (mode === "boot") {
    const boot = document.createElement("div");
    boot.id = "boot-shell";
    document.body.append(boot);
  }
  expect(() => validateProviderChatWitness(input.scene, readProviderChatWitness(input))).toThrow();
});
it("projects only the exact closed capture schema and original geometry/hash", () => {
  commandDom();
  const record = {
    scene: input.scene,
    theme: input.theme,
    file: "composer-command-menu-light.png",
    witness: readProviderChatWitness(input),
    width: 1280,
    height: 960,
    nonBlank: true,
    sha256: "a".repeat(64),
  };
  expect(projectProviderChatCapture(record)).toEqual(record);
  for (const key of Object.keys(record))
    expect(() => projectProviderChatCapture({ ...record, [key]: "private" })).toThrow(
      "Owned provider visual capture record refused.",
    );
  expect(() => projectProviderChatCapture({ ...record, rawText: "private" })).toThrow();
  const revoked = Proxy.revocable(record, {});
  revoked.revoke();
  expect(() => projectProviderChatCapture(revoked.proxy)).toThrow(
    "Owned provider visual capture record refused.",
  );
});
it.each(["context-popover", "mcp-popover"] as const)(
  "checks actual source-backed %s widgets without capture evidence",
  (scene) => {
    commandDom();
    document.querySelector('[data-testid="composer-editor"]')!.textContent = "";
    document.querySelector('[data-composer-menu="true"]')!.remove();
    const popup = document.createElement("div");
    popup.setAttribute("data-slot", "popover-popup");
    popup.innerHTML =
      scene === "context-popover"
        ? '<p>Context Window 16% · 31k/200k</p><p>Claude automatically compacts its context when needed.</p><div role="progressbar" aria-label="Context window usage" aria-valuenow="16"></div>'
        : "<p>MCPs</p><p>owned-visual-mcp-server-with-a-long-name-that-wraps Connected</p><p>owned-unavailable-server Error Owned fixture endpoint is unavailable.</p>";
    document.body.append(popup);
    vi.spyOn(document, "elementFromPoint").mockImplementation(
      () => popup.querySelector('[role="progressbar"]') ?? popup,
    );
    const facts = readProviderChatWitness({ ...input, scene });
    expect(validateProviderChatWitness(scene, facts)).toEqual(facts);
    popup.textContent = "unrelated source";
    expect(() =>
      validateProviderChatWitness(scene, readProviderChatWitness({ ...input, scene })),
    ).toThrow();
  },
);
it("rejects live proxy traps before reflecting on either closed provider receipt", () => {
  let reads = 0;
  const proxy = new Proxy(
    {},
    {
      ownKeys: () => {
        reads++;
        throw new Error("Inert private trap");
      },
    },
  );
  expect(() => validateProviderChatWitness("composer-command-menu", proxy)).toThrow(
    "Owned provider visual witness refused.",
  );
  expect(() => projectProviderChatCapture(proxy)).toThrow(
    "Owned provider visual capture record refused.",
  );
  expect(reads).toBe(0);
});

it("rejects private, accessor, missing and proxy witness fields without returning their contents", () => {
  commandDom();
  const facts = readProviderChatWitness(input)!;
  for (const key of Object.keys(facts)) {
    expect(() => validateProviderChatWitness(input.scene, { ...facts, [key]: false })).toThrow();
    const other = { ...facts };
    delete other[key];
    expect(() => validateProviderChatWitness(input.scene, other)).toThrow();
    Object.defineProperty(other, key, {
      enumerable: true,
      get: () => {
        throw new Error("private");
      },
    });
    expect(() => validateProviderChatWitness(input.scene, other)).toThrow(
      "Owned provider visual witness refused.",
    );
  }
  expect(() =>
    validateProviderChatWitness(input.scene, { ...facts, privateText: "private" }),
  ).toThrow();
  const revoked = Proxy.revocable(facts, {});
  revoked.revoke();
  expect(() => validateProviderChatWitness(input.scene, revoked.proxy)).toThrow(
    "Owned provider visual witness refused.",
  );
});
it("preserves public preparation/identity/entry/capture order and leaves blocked multiselect unqualified", async () => {
  const calls: string[] = [];
  const browser = {
    $: (selector: string) => ({
      waitForDisplayed: async () => {
        calls.push("display:" + selector);
      },
      waitForEnabled: async () => {},
      click: async () => {
        calls.push("click:" + selector);
      },
    }),
    keys: async (key: string) => {
      calls.push("key:" + key);
    },
  };
  const driver = {
    browser,
    prepare: async (scene: string) => {
      calls.push("prepare:" + scene);
    },
    verifyOwnedIdentity: async () => {
      calls.push("identity");
    },
    send: async (prompt: string) => {
      calls.push("send:" + prompt);
    },
    draft: async (text: string) => {
      calls.push("draft:" + text);
    },
    viewport: async (width: number, height: number) => {
      calls.push(`viewport:${width}x${height}`);
    },
    withRefusedModel: async () => {
      throw new Error("Unexpected refusal owner in another scene.");
    },
    withManagedWorkspaceLoss: async (
      capture: (scope: { kind: "provider-chat-registered-managed-loss" }) => Promise<void>,
    ) => {
      await capture({ kind: "provider-chat-registered-managed-loss" });
    },
    capture: async (scene: string) => {
      calls.push("capture:" + scene);
    },
  } as unknown as Parameters<typeof runProviderChatScene>[0];
  await runProviderChatScene(driver, "composer-command-menu");
  expect(calls).toEqual([
    "prepare:composer-command-menu",
    "identity",
    "viewport:1280x960",
    "draft:/comp",
    "capture:composer-command-menu",
    "identity",
  ]);
  calls.length = 0;
  await expect(runProviderChatScene(driver, "question-multiselect")).rejects.toThrow(
    "Owned multiselect protocol is unqualified.",
  );
  expect(calls).toEqual([]);
  const rejected = {
    ...driver,
    prepare: async () => {
      throw new Error("private prerequisite");
    },
  };
  await expect(runProviderChatScene(rejected, "context-popover")).rejects.toThrow();
  expect(calls).toEqual([]);
});

function actualProviderSceneDriver() {
  const source = NodeFS.readFileSync(
    new NodeURL.URL("./release-visual-provider-chat.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("export async function runProviderChatScene(");
  expect(start).toBeGreaterThan(0);
  return NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(source.slice(start)).replace(/^export /gm, "") +
      "\nrunProviderChatScene",
    { providerChatScenes, providerChatViewport, providerChatFixturePrompts },
  ) as typeof runProviderChatScene;
}

function ownedRefusalDriver(stage: string) {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "provider-driver-refusal-")),
  );
  NodeFS.chmodSync(root, 0o700);
  const runRoot = NodePath.join(root, "light");
  NodeFS.mkdirSync(runRoot, { mode: 0o700 });
  const marker = NodePath.join(runRoot, "provider-chat-refuse-high");
  const calls: string[] = [];
  const original = new Error("Inert original driver callback failure.");
  let prepared = false;
  let armed = 0;
  let identityChecks = 0;
  let unsafeCleanup = 0;
  const callbackAction = (operation: string) => {
    expect(prepared).toBe(true);
    expect(NodeFS.existsSync(marker)).toBe(true);
    expect(NodeFS.statSync(marker).mode & 0o077).toBe(0);
    calls.push(operation);
    if (stage === operation) throw original;
  };
  const driver: ProviderChatDriver = {
    browser: {} as never,
    prepare: async (scene) => {
      expect(scene).toBe("chat-refused-model");
      expect(NodeFS.existsSync(marker)).toBe(false);
      calls.push("prepare-public-High");
      if (stage === "prepare") throw original;
      prepared = true;
    },
    verifyOwnedIdentity: async () => {
      expect(NodeFS.existsSync(marker)).toBe(false);
      calls.push("identity");
      identityChecks++;
      if (stage === "identity" || (stage === "post-identity" && identityChecks === 2))
        throw original;
    },
    viewport: async (width, height) => {
      expect([width, height]).toEqual([1280, 960]);
      calls.push("viewport");
      if (stage === "viewport") throw original;
    },
    send: async (prompt) =>
      callbackAction(
        prompt === providerChatFixturePrompts.refused
          ? "refusal-send"
          : prompt === "Owned visual message waiting behind refusal"
            ? "queue-send"
            : "unexpected-send",
      ),
    draft: async (text) => {
      expect(text).toBe("Owned visual review draft");
      callbackAction("draft");
    },
    capture: async (scene) => {
      expect(scene).toBe("chat-refused-model");
      callbackAction("capture");
      if (stage === "cleanup" || stage === "capture-and-cleanup") {
        NodeFS.unlinkSync(marker);
        if (stage === "capture-and-cleanup") throw original;
      }
    },
    withManagedWorkspaceLoss: async () => {
      throw new Error("Unexpected workspace loss owner.");
    },
    withRefusedModel: async (sendAndCapture) => {
      expect(prepared).toBe(true);
      expect(NodeFS.existsSync(marker)).toBe(false);
      armed++;
      calls.push("arm");
      try {
        await withOwnedCodexVisualOptionRefusal(
          {
            selection: "provider-chat-v1",
            fixtureRoot: root,
            runRoot,
            childEnv: { CI: "true", BIBCODE_UPLOAD_FIXTURE: root, BIBCODE_E2E_RUN_ROOT: runRoot },
            observeUnsafeCleanup: () => {
              unsafeCleanup++;
            },
          },
          sendAndCapture,
        );
      } finally {
        calls.push("owner-settled");
      }
    },
  };
  return {
    driver,
    calls,
    original,
    marker,
    armed: () => armed,
    unsafeCleanup: () => unsafeCleanup,
    close: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
}

it.each(["success", "refusal-send", "queue-send", "draft", "capture", "post-identity"])(
  "runs the actual refusal driver inside the real private marker owner and restores on %s",
  async (stage) => {
    const f = ownedRefusalDriver(stage);
    try {
      const run = actualProviderSceneDriver();
      if (stage === "success")
        await expect(run(f.driver, "chat-refused-model")).resolves.toBeUndefined();
      else await expect(run(f.driver, "chat-refused-model")).rejects.toBe(f.original);
      const actions = ["refusal-send", "queue-send", "draft", "capture"];
      const completedCallback = stage === "success" || stage === "post-identity";
      const attempted = completedCallback ? actions : actions.slice(0, actions.indexOf(stage) + 1);
      expect(f.calls).toEqual([
        "prepare-public-High",
        "identity",
        "viewport",
        "arm",
        ...attempted,
        "owner-settled",
        ...(completedCallback ? ["identity"] : []),
      ]);
      expect(f.armed()).toBe(1);
      expect(NodeFS.existsSync(f.marker)).toBe(false);
    } finally {
      f.close();
    }
  },
);

it.each(["prepare", "identity", "viewport"])(
  "refuses failed %s before arming the refusal owner",
  async (stage) => {
    const f = ownedRefusalDriver(stage);
    try {
      await expect(actualProviderSceneDriver()(f.driver, "chat-refused-model")).rejects.toBe(
        f.original,
      );
      const phases = ["prepare-public-High", "identity", "viewport"];
      const last = stage === "prepare" ? 0 : stage === "identity" ? 1 : 2;
      expect(f.calls).toEqual(phases.slice(0, last + 1));
      expect(f.armed()).toBe(0);
      expect(NodeFS.existsSync(f.marker)).toBe(false);
    } finally {
      f.close();
    }
  },
);

it.each(["cleanup", "capture-and-cleanup"])(
  "does not credit cleanup refusal or replace the original callback failure: %s",
  async (stage) => {
    const f = ownedRefusalDriver(stage);
    try {
      const result = actualProviderSceneDriver()(f.driver, "chat-refused-model");
      if (stage === "cleanup")
        await expect(result).rejects.toThrow("Owned visual Codex refusal control refused.");
      else await expect(result).rejects.toBe(f.original);
      expect(f.calls).toEqual([
        "prepare-public-High",
        "identity",
        "viewport",
        "arm",
        "refusal-send",
        "queue-send",
        "draft",
        "capture",
        "owner-settled",
      ]);
      expect(f.armed()).toBe(1);
      expect(f.unsafeCleanup()).toBe(1);
    } finally {
      f.close();
    }
  },
);

function actualCaptureWithSharedPorts(
  source: string,
  start: number,
  end: number,
  ports: Record<string, unknown>,
) {
  const sharedSource = NodeFS.readFileSync(
    new NodeURL.URL("./owned-visual-capture.ts", import.meta.url),
    "utf8",
  );
  const sharedStart = sharedSource.indexOf("export async function captureOwnedVisualScene(");
  const bodyStart =
    sharedStart >= 0
      ? sharedStart
      : sharedSource.indexOf("export async function captureOwnedVisualScene<");
  const shared = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(sharedSource.slice(bodyStart)).replace(/^export /gm, "") +
      "\ncaptureOwnedVisualScene",
    {
      ...ports,
      NodePath: { join: (root: string, file: string) => root + "/" + file },
      NodeFS: { ...(ports.NodeFS as object), existsSync: () => false },
    },
  );
  return NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(source.slice(start, end)).replace(/^export /gm, "") +
      "\ncaptureProviderChatScene",
    { ...ports, captureOwnedVisualScene: shared },
  ) as typeof captureProviderChatScene;
}

it.each(["execute", "bound"] as const)(
  "keeps the first initial %s read failure without repeat, screenshot, write or admission",
  async (mode) => {
    const source = NodeFS.readFileSync(
      new NodeURL.URL("./release-visual-provider-chat.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("export async function captureProviderChatScene(");
    const end = source.indexOf("export interface ProviderChatDriver", start);
    const original = new Error("inert original read failure");
    const calls: string[] = [];
    const run = actualCaptureWithSharedPorts(source, start, end, {
      providerChatScreenshotName,
      providerChatViewport,
      projectProviderChatCapture,
      readProviderChatWitness,
      validateProviderChatWitness,
      Buffer,
      bounded: (promise: Promise<unknown>, budget: number) => {
        calls.push("bound:" + budget);
        return mode === "bound" ? Promise.reject(original) : promise;
      },
      inspectScreenshot: () => {
        calls.push("inspect");
        throw new Error("No image inspection allowed.");
      },
      NodeFS: {
        writeFileSync: () => {
          calls.push("write");
        },
      },
      NodePath: {},
    });
    const captured = new Set<string>();
    await expect(
      run({
        ...input,
        evidence: "/owned-evidence",
        captured,
        verifyOwnedIdentity: async () => {
          calls.push("identity");
        },
        owner: {
          until: async (probe: () => Promise<boolean>) => {
            if (!(await probe())) {
              calls.push("repeat");
              await probe();
              throw new Error("inert predicate timeout");
            }
          },
        },
        browser: {
          isAlertOpen: async () => false,
          execute: async () => {
            calls.push("execute");
            if (mode === "execute") throw original;
            return null;
          },
          takeScreenshot: async () => {
            calls.push("screenshot");
            return "";
          },
        },
      } as unknown as Parameters<typeof captureProviderChatScene>[0]),
    ).rejects.toBe(original);
    expect(calls).toEqual(["identity", "execute", "bound:2000"]);
    expect(captured.size).toBe(0);
  },
);

function contextMeterDom(theme: "light" | "dark") {
  commandDom();
  document.querySelector('[data-testid="composer-editor"]')!.textContent = "";
  document.querySelector('[data-composer-menu="true"]')!.remove();
  const popup = document.createElement("div");
  popup.setAttribute("data-slot", "popover-popup");
  popup.innerHTML =
    '<p>Context Window 16% · 31k/200k</p><p>Claude automatically compacts its context when needed.</p><div data-meter-clip><div role="progressbar" aria-label="Context window usage" aria-valuenow="16"></div></div>';
  document.body.append(popup);
  document.documentElement.classList.toggle("dark", theme === "dark");
  const clip = popup.querySelector<HTMLElement>("[data-meter-clip]")!;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.matches('[role="progressbar"]')) {
        const index = Array.from(popup.querySelectorAll('[role="progressbar"]')).indexOf(this);
        return new DOMRect(20, 20 + index * 50, 280, 20);
      }
      if (this === clip && clip.style.overflowX === "hidden") return new DOMRect(50, 10, 260, 200);
      return new DOMRect(10, 10, 300, 200);
    },
  );
  vi.spyOn(document, "elementFromPoint").mockImplementation((x, y) => {
    const box = clip.getBoundingClientRect();
    if (clip.style.overflowX === "hidden" && (x < box.left || x > box.right)) return popup;
    for (const meter of popup.querySelectorAll<HTMLElement>('[role="progressbar"]')) {
      const rect = meter.getBoundingClientRect();
      if (
        meter.style.display !== "none" &&
        x >= rect.left &&
        x <= rect.right &&
        y >= rect.top &&
        y <= rect.bottom
      )
        return meter;
    }
    return popup;
  });
  return {
    popup,
    clip,
    meter: popup.querySelector<HTMLElement>('[role="progressbar"]')!,
    observation: {
      ...input,
      scene: "context-popover" as const,
      theme,
      branch: `codex/delivery-retry-${theme}`,
    },
  };
}
it.each(["light", "dark"] as const)("admits one fully visible context meter in %s", (theme) => {
  const page = contextMeterDom(theme);
  expect(
    validateProviderChatWitness("context-popover", readProviderChatWitness(page.observation)),
  ).toMatchObject({ contextMeter: true, targetInView: true });
});
it.each(["hidden", "duplicate", "horizontal-clipped", "missing"] as const)(
  "refuses a required context meter that is %s in both themes",
  (mode) => {
    for (const theme of ["light", "dark"] as const) {
      const page = contextMeterDom(theme);
      if (mode === "hidden") page.meter.style.display = "none";
      if (mode === "duplicate") page.clip.append(page.meter.cloneNode(true));
      if (mode === "horizontal-clipped") page.clip.style.overflowX = "hidden";
      if (mode === "missing") page.meter.remove();
      const witness = readProviderChatWitness(page.observation);
      expect(witness?.targetInView).toBe(false);
      expect(witness?.contextMeter).toBe(mode === "horizontal-clipped");
      expect(() => validateProviderChatWitness("context-popover", witness)).toThrow();
      page.popup.remove();
    }
  },
);

it("still polls successful unsatisfied witnesses without changing the post-image refusal fence", async () => {
  commandDom();
  const facts = readProviderChatWitness(input);
  const source = NodeFS.readFileSync(
    new NodeURL.URL("./release-visual-provider-chat.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("export async function captureProviderChatScene(");
  const end = source.indexOf("export interface ProviderChatDriver", start);
  const stopped = new Error("inert image inspection stop");
  const calls: string[] = [];
  let reads = 0;
  const run = actualCaptureWithSharedPorts(source, start, end, {
    providerChatScreenshotName,
    providerChatViewport,
    projectProviderChatCapture,
    readProviderChatWitness,
    validateProviderChatWitness,
    Buffer,
    bounded: (promise: Promise<unknown>, budget: number) => {
      calls.push("bound:" + budget);
      return promise;
    },
    inspectScreenshot: () => {
      calls.push("inspect");
      throw stopped;
    },
    NodeFS: {
      writeFileSync: () => {
        calls.push("write");
      },
    },
    NodePath: {},
  });
  const captured = new Set<string>();
  await expect(
    run({
      ...input,
      evidence: "/owned-evidence",
      captured,
      verifyOwnedIdentity: async () => {
        calls.push("identity");
      },
      owner: {
        until: async (probe: () => Promise<boolean>) => {
          for (let i = 0; i < 2; i++) if (await probe()) return;
          throw new Error("inert predicate timeout");
        },
      },
      browser: {
        isAlertOpen: async () => false,
        execute: async () => {
          calls.push("execute");
          return ++reads === 1 ? null : facts;
        },
        takeScreenshot: async () => {
          calls.push("screenshot");
          return "";
        },
      },
    } as unknown as Parameters<typeof captureProviderChatScene>[0]),
  ).rejects.toBe(stopped);
  expect(calls).toEqual([
    "identity",
    "execute",
    "bound:2000",
    "execute",
    "bound:2000",
    "screenshot",
    "bound:5000",
    "identity",
    "execute",
    "bound:2000",
    "inspect",
  ]);
  expect(captured.size).toBe(0);
});
