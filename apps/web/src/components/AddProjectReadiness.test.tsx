// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - Actual QA and installed SDK source with inert operation/query ports.

import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import * as NodeVM from "node:vm";
import { EnvironmentId } from "@bibcode/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AddProjectHostOption } from "./add-project/AddProjectDialog.logic";
import type { AddProjectWorkflow } from "./add-project/useAddProjectWorkflow";

const h = vi.hoisted(() => ({
  hosts: [] as ReadonlyArray<AddProjectHostOption>,
  current: null as AddProjectWorkflow | null,
  close: vi.fn(),
  addFolder: vi.fn(async () => true),
  clone: vi.fn(async () => ({ _tag: "Opened" as const })),
  create: vi.fn(async () => true),
  cancelClone: vi.fn(async () => ({ _tag: "Success" as const, value: { cancelled: true } })),
  pickFolder: vi.fn(async () => ({ _tag: "Cancelled" as const })),
  browseInputs: [] as Array<{ environmentId: string; input: { partialPath: string } }>,
  createEntry: vi.fn(),
}));

vi.mock("~/state/filesystem", () => ({
  filesystemEnvironment: { browse: (target: unknown) => target },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (target: { environmentId: string; input: { partialPath: string } }) => {
    h.browseInputs.push(target);
    const path = target.input.partialPath;
    return {
      data: {
        directoryPath: path,
        ancestorPath: "/owned",
        breadcrumbs: path.endsWith("/nested")
          ? [
              { name: "ordinary", fullPath: path.slice(0, -"/nested".length) },
              { name: "nested", fullPath: path },
            ]
          : [{ name: "ordinary", fullPath: path }],
        entries: path.endsWith("/nested")
          ? [
              { name: "leaf", fullPath: path + "/leaf" },
              { name: "nested", fullPath: path + "/nested" },
            ]
          : [{ name: "nested", fullPath: path + "/nested" }],
      },
      error: null,
      isPending: false,
      refresh: vi.fn(),
    };
  },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => h.createEntry }));

// Keep the real state hook, dialog and path step. Only host/operation ports are inert.
vi.mock("./add-project/useAddProjectWorkflow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./add-project/useAddProjectWorkflow")>();
  return {
    ...actual,
    useAddProjectWorkflow(input: { open: boolean; onOpenChange: (open: boolean) => void }) {
      const workflow = actual.useAddProjectWorkflowState({
        ...input,
        hosts: h.hosts,
        locationLabel: "Host",
        primaryEnvironmentId: EnvironmentId.make("primary"),
        initialEnvironmentId: null,
        operations: {
          addFolder: h.addFolder,
          clone: h.clone,
          create: h.create,
          cancelClone: h.cancelClone,
        },
        pickFolder: h.pickFolder,
      });
      h.current = workflow;
      return workflow;
    },
  };
});

import { AddProjectDialog } from "./AddProjectDialog";

const primary: AddProjectHostOption = {
  environmentId: EnvironmentId.make("primary"),
  label: "Primary host",
  platform: null,
  baseDirectory: "~/",
  isPrimary: true,
  desktopInstanceId: null,
  nativePickerAvailable: false,
};
const remote: AddProjectHostOption = {
  ...primary,
  environmentId: EnvironmentId.make("remote"),
  label: "Remote host",
  baseDirectory: "/remote/",
  isPrimary: false,
};
let root: Root | undefined;
let animations: PropertyDescriptor | undefined;
const workflow = () => {
  if (!h.current) throw new Error("Workflow was not rendered.");
  return h.current;
};
const pathInput = () => {
  const value = document.querySelector("#add-project-host-path");
  if (!(value instanceof HTMLInputElement)) throw new Error("Path input was not rendered.");
  return value;
};
const openButton = () => {
  const value = pathInput().form?.querySelector('button[type="submit"]');
  if (!(value instanceof HTMLButtonElement)) throw new Error("Open button was not rendered.");
  return value;
};
const render = async () =>
  act(async () => root?.render(<AddProjectDialog open onOpenChange={h.close} />));
async function mountPath(hosts: ReadonlyArray<AddProjectHostOption> = [primary]) {
  h.hosts = hosts;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
  await act(async () => {
    workflow().openHostPath();
    workflow().setHostPath("/typed/project");
  });
}
async function attempt(action: "pointer" | "enter" | "form") {
  await act(async () => {
    if (action === "pointer") openButton().click();
    else if (action === "enter")
      pathInput().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    else pathInput().form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.current = null;
  h.browseInputs.length = 0;
  vi.clearAllMocks();
  animations = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  if (animations) Object.defineProperty(Element.prototype, "getAnimations", animations);
  else Reflect.deleteProperty(Element.prototype, "getAnimations");
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("Add Project manual-path host readiness", () => {
  it.each(["pointer", "enter", "form"] as const)(
    "blocks %s while loading, then uses late metadata without losing input",
    async (action) => {
      await mountPath();
      await attempt(action);
      expect(workflow().error).toBeNull();
      expect(h.addFolder).not.toHaveBeenCalled();
      expect(h.close).not.toHaveBeenCalled();
      expect(openButton().disabled).toBe(true);
      expect(pathInput().disabled).toBe(false);
      expect(pathInput().form?.querySelector('[role="status"]')?.textContent).toBe(
        "Waiting for host information…",
      );
      h.hosts = [{ ...primary, platform: "Linux", baseDirectory: "/new-default/" }];
      await render();
      expect(workflow().selectedHost.environmentId).toBe(primary.environmentId);
      expect(pathInput().value).toBe("/typed/project");
      expect(openButton().disabled).toBe(false);
      expect(pathInput().form?.querySelector('[role="status"]')).toBeNull();
      expect(h.addFolder).not.toHaveBeenCalled();
      await attempt(action);
      expect(h.addFolder).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          environmentId: primary.environmentId,
          workspaceRoot: "/typed/project",
        }),
      );
      expect(h.close).toHaveBeenCalledExactlyOnceWith(false);
    },
  );

  it("tracks the selected host rather than a late update for a different host", async () => {
    await mountPath([primary, remote]);
    await act(async () => {
      workflow().selectHost(remote.environmentId);
      workflow().openHostPath();
      workflow().setHostPath("/typed/remote");
    });
    h.hosts = [{ ...primary, platform: "Linux" }, remote];
    await render();
    expect(openButton().disabled).toBe(true);
    expect(workflow().selectedHost.environmentId).toBe(remote.environmentId);
    h.hosts = [
      { ...primary, platform: "Linux" },
      { ...remote, platform: "Linux", baseDirectory: "/changed/" },
    ];
    await render();
    expect(pathInput().value).toBe("/typed/remote");
    expect(openButton().disabled).toBe(false);
    await attempt("pointer");
    expect(h.addFolder).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        environmentId: remote.environmentId,
        workspaceRoot: "/typed/remote",
      }),
    );
  });

  it("keeps the existing disconnect fallback and never submits the lost host", async () => {
    await mountPath([{ ...primary, platform: "Linux" }, remote]);
    await act(async () => {
      workflow().selectHost(remote.environmentId);
      workflow().openHostPath();
      workflow().setHostPath("/typed/remote");
    });
    h.hosts = [{ ...primary, platform: "Linux" }];
    await render();
    expect(workflow().step).toBe("start");
    expect(workflow().selectedHost.environmentId).toBe(primary.environmentId);
    expect(workflow().error).toBe("The selected host disconnected. Choose a host and try again.");
    expect(document.querySelector("#add-project-host-path")).toBeNull();
    expect(h.addFolder).not.toHaveBeenCalled();
  });

  it("retains submit-time validation for a ready host", async () => {
    await mountPath([{ ...primary, platform: "Linux" }]);
    await act(async () => workflow().setHostPath("relative/path"));
    await attempt("pointer");
    expect(workflow().error).toBe("Enter an absolute or home-relative path.");
    expect(h.addFolder).not.toHaveBeenCalled();
  });
});

it("runs the actual QA directory path through public browser controls and installed SDK typing", async () => {
  h.hosts = [{ ...primary, platform: "Linux", baseDirectory: "/owned/initial" }];
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
  const source = NodeFS.readFileSync(
    new NodeURL.URL("../../../desktop/e2e/support/release-visual-git-project.ts", import.meta.url),
    "utf8",
  );
  const runStart = source.indexOf("export async function runGitProjectVisual(");
  const clickStart = source.indexOf("  const completed:", runStart);
  const clickEnd = source.indexOf("  const capture = async", clickStart);
  const directoryStart = source.indexOf(
    '  input.step("visual-git-project-directory-open");',
    runStart,
  );
  // The real Add Project dialog is already open; replay its original remaining await sequence.
  const browseStart = source.indexOf("  await click(\n", directoryStart);
  const directoryEnd = source.indexOf('  await click("button=Type a path instead");', browseStart);
  expect(browseStart).toBeGreaterThan(directoryStart);
  expect(directoryEnd).toBeGreaterThan(browseStart);
  const require = NodeModule.createRequire(
    new NodeURL.URL("../../../desktop/package.json", import.meta.url),
  );
  const sdkSource = NodeFS.readFileSync(
    new NodeURL.URL("node.js", NodeURL.pathToFileURL(require.resolve("webdriverio"))),
    "utf8",
  );
  const sdkFunction = (name: string, async: boolean) => {
    const start = sdkSource.indexOf(`${async ? "async " : ""}function ${name}(`);
    const end = sdkSource.indexOf("\n//", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    return sdkSource.slice(start, end);
  };
  const sdk = NodeVM.runInNewContext(
    sdkFunction("clearValue", false) +
      sdkFunction("addValue", false) +
      sdkFunction("setValue", true) +
      "\n({ clearValue, addValue, setValue })",
    { VALID_TYPES: ["string", "number"] },
  );
  const requested = "/owned/visual-git-project/ordinary";
  const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  const findAll = (selector: string) => {
    // HappyDOM has no XPath engine. This inert transport admits only the unchanged public action.
    if (selector.startsWith("//")) {
      expect(selector).toBe(
        '//button[@data-add-project-action="true"][.//span[normalize-space()="Browse folder"]]',
      );
      return Array.from(
        document.querySelectorAll<HTMLElement>('button[data-add-project-action="true"]'),
      ).filter((button) =>
        Array.from(button.querySelectorAll("span")).some(
          (span) => span.textContent?.trim() === "Browse folder",
        ),
      );
    }
    return Array.from(document.querySelectorAll<HTMLElement>(selector));
  };
  const find = (selector: string) => findAll(selector)[0] ?? null;
  const browser = {
    $: (selector: string) => {
      const node = () => {
        const result = find(selector);
        if (!result) throw new Error("Missing public directory control.");
        return result;
      };
      const input = {
        elementId: "owned-directory-input",
        clearValue: () => sdk.clearValue.call(input),
        addValue: (value: string) => sdk.addValue.call(input, value),
        elementClear: async () =>
          act(async () => {
            const field = node();
            field.focus();
            nativeValue.call(field, "");
            field.dispatchEvent(new Event("input", { bubbles: true }));
          }),
        elementSendKeys: async (_id: string, value: string) =>
          act(async () => {
            const field = node();
            nativeValue.call(field, value);
            field.dispatchEvent(new Event("input", { bubbles: true }));
          }),
      };
      return {
        waitForDisplayed: async () => expect(node()).toBeInstanceOf(HTMLElement),
        waitForEnabled: async () => expect(node().hasAttribute("disabled")).toBe(false),
        click: async () => act(async () => node().click()),
        setValue: (value: string) => sdk.setValue.call(input, value),
      };
    },
    $$: (selector: string) => ({ length: Promise.resolve(findAll(selector).length) }),
    keys: async (key: string) =>
      act(async () => {
        expect(key).toBe("Enter");
        document.activeElement!.dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
        );
      }),
  };
  const capture = vi.fn(async (scene: string) => {
    expect(scene).toBe("project-open-directory");
    expect(workflow().step).toBe("remote-browse");
    expect(
      document.querySelector<HTMLInputElement>('[aria-label="Server directory path"]')?.value,
    ).toBe(requested + "/nested");
    expect(
      document.querySelector('button[aria-label="Open nested"][aria-current="page"]'),
    ).not.toBeNull();
    expect(document.querySelector('[aria-label="Directory breadcrumbs"]')).not.toBeNull();
    expect(document.querySelector('button[aria-label="New folder"]')).not.toBeNull();
  });
  const run = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      "async function directory() {" +
        source.slice(clickStart, clickEnd) +
        source.slice(browseStart, directoryEnd) +
        "}\ndirectory",
    ),
    {
      browser,
      input: { step: () => {} },
      fixture: { ordinary: requested },
      rich: {},
      capture,
      refused: () => new Error("Directory admission refused."),
    },
  );
  await run();
  expect(capture).toHaveBeenCalledOnce();
  expect(document.querySelectorAll('button[aria-label="Open nested"]')).toHaveLength(2);
  // Ideal geometry tests the serialized predicate, never native pixel layout or capture approval.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(10, 10, 300, 200),
  );
  vi.spyOn(document, "elementFromPoint").mockImplementation(() =>
    document.querySelector('[data-slot="dialog-popup"][role="dialog"]'),
  );
  const readerStart = source.indexOf("export function readGitProjectVisualWitness(");
  const readerEnd = source.indexOf("export interface GitProjectVisualCaptureInput", readerStart);
  const read = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(source.slice(readerStart, readerEnd)).replace(
      /^export /gm,
      "",
    ) + "\nreadGitProjectVisualWitness",
    {
      document,
      location: {
        origin: "http://127.0.0.1:4885",
        pathname: "/local/owned-default",
        search: "",
        hash: "",
      },
      innerWidth: 1280,
      innerHeight: 960,
      HTMLInputElement,
      getComputedStyle,
    },
  );
  const observe = () =>
    read({
      scene: "project-open-directory",
      coverage: "complete",
      theme: "light",
      origin: "http://127.0.0.1:4885",
      selection: { projectId: "owned-rich", threadId: "owned-default", environmentId: "primary" },
      directory: requested + "/nested",
    });
  expect(observe()?.hostContext).toBe(true);
  expect(observe()?.selectedMatched).toBe(false);
  const folder = Array.from(
    document.querySelectorAll<HTMLButtonElement>('button[aria-label="Open nested"]'),
  ).find((button) => button.querySelector("[data-directory-folder-icon]") !== null)!;
  const duplicate = folder.cloneNode(true) as HTMLButtonElement;
  folder.parentElement!.append(duplicate);
  expect(observe()?.hostContext).toBe(false);
  duplicate.remove();
  folder.style.display = "none";
  expect(observe()?.hostContext).toBe(false);
  folder.style.display = "";
  const parent = folder.parentElement!;
  document.body.append(folder);
  expect(observe()?.hostContext).toBe(false);
  parent.append(folder);
  folder.remove();
  expect(observe()?.hostContext).toBe(false);
  parent.append(folder);
  expect(h.browseInputs.some((target) => target.input.partialPath === requested)).toBe(true);
  expect(h.browseInputs.at(-1)?.input.partialPath).toBe(requested + "/nested");
  expect(h.browseInputs.every((target) => target.environmentId === primary.environmentId)).toBe(
    true,
  );
  expect(h.pickFolder).not.toHaveBeenCalled();
  expect(h.addFolder).not.toHaveBeenCalled();
  expect(h.createEntry).not.toHaveBeenCalled();
});
