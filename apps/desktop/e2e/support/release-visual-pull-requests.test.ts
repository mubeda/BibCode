// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - Closed request-row capture admission runs over inert DOM ports.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { expect, it, vi, afterEach, beforeEach } from "vite-plus/test";
const path = "./release-visual-pull-requests.ts";
const api = await import(path).catch((error) => {
  if (NodeFS.existsSync(new NodeURL.URL(path, import.meta.url))) throw error;
  return {};
});
const bindings = () => Reflect.get(api, "pullRequestsCaptureBindings");
it("retains exactly five approved base rows and the finite approved substates", () => {
  expect(bindings()).toBeInstanceOf(Array);
  const rows = bindings();
  expect(rows.filter((entry: { substate: string }) => entry.substate === "base")).toHaveLength(10);
  expect(rows).toHaveLength(48);
  expect(new Set(rows.map((entry: { row: string }) => entry.row)).size).toBe(5);
  expect(new Set(rows.map((entry: { file: string }) => entry.file)).size).toBe(48);
  expect(
    rows.filter((entry: { substate: string }) =>
      ["base", "checks", "files", "editors", "comment", "confirmation-undo"].includes(
        entry.substate,
      ),
    ),
  ).toHaveLength(24);
  expect(
    rows.filter((entry: { file: string }) =>
      /^request-(?:github|gitlab)-detail-conversation(?:-activity)?-(?:light|dark)\.png$/.test(
        entry.file,
      ),
    ),
  ).toHaveLength(8);
  expect(
    rows.filter(
      (entry: { substate: string }) => entry.substate === "checks" || entry.substate === "files",
    ),
  ).toHaveLength(8);
});
it("projects the native host context only when the exact expected owned scope is available", () => {
  const project = Reflect.get(api, "projectPullRequestsHostContext");
  expect(project).toBeTypeOf("function");
  const expected = {
    provider: "github",
    host: "github.visual.invalid",
    repository: "owned/requests",
    account: "viewer",
  };
  const context = {
    status: "available",
    provider: "github",
    host: "github.visual.invalid",
    repository: "owned/requests",
    account: { login: "viewer" },
  };
  expect(project(context, expected)).toBe(true);
  for (const bad of [
    { ...context, status: "unavailable" },
    { ...context, host: "github.com" },
    { ...context, provider: "gitlab" },
    { ...context, repository: "foreign/requests" },
    { ...context, account: { login: "foreign" } },
  ])
    expect(project(bad, expected)).toBe(false);
});
it("refuses executable host context metadata without running accessors", () => {
  const project = Reflect.get(api, "projectPullRequestsHostContext");
  expect(project).toBeTypeOf("function");
  let reads = 0;
  const value = {
    status: "available",
    provider: "github",
    host: "github.visual.invalid",
    repository: "owned/requests",
    account: { login: "viewer" },
  };
  Object.defineProperty(value, "host", {
    get() {
      reads++;
      return "github.visual.invalid";
    },
    enumerable: true,
  });
  expect(
    project(value, {
      provider: "github",
      host: "github.visual.invalid",
      repository: "owned/requests",
      account: "viewer",
    }),
  ).toBe(false);
  expect(reads).toBe(0);
});

const box = (x: number, y: number, width: number, height: number) => ({
  x,
  y,
  left: x,
  top: y,
  width,
  height,
  right: x + width,
  bottom: y + height,
  toJSON: () => ({}),
});
let textRectangles = new WeakMap<Node, ReturnType<typeof box>>();
beforeEach(() => {
  textRectangles = new WeakMap();
  const create = document.createRange.bind(document);
  vi.spyOn(document, "createRange").mockImplementation(() => {
    const range = create();
    Object.defineProperty(range, "getClientRects", {
      value: () => {
        const node = range.startContainer;
        const element = node instanceof Element ? node : node.parentElement;
        return textRectangles.has(node)
          ? [textRectangles.get(node)!]
          : element
            ? [element.getBoundingClientRect()]
            : [];
      },
    });
    return range;
  });
});
let restoreXPath: (() => void) | undefined;
afterEach(() => {
  restoreXPath?.();
  restoreXPath = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
it.each([
  "clear",
  "wrong-theme",
  "foreign-route",
  "duplicate-card",
  "hidden-copy",
  "edge-covered",
  "transparent-toast",
  "own-toast",
  "foreign-toast-on-own",
  "partial-transparent-toast",
  "credential",
  "boot",
])("admits only the live unobstructed public witness: %s", (mode) => {
  const read = Reflect.get(api, "readPullRequestsCaptureWitness");
  expect(read).toBeTypeOf("function");
  vi.stubGlobal("location", new URL("http://127.0.0.1:4885/project/local/owned/pull-requests"));
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("innerHeight", 960);
  document.documentElement.classList.remove("dark");
  document.body.innerHTML =
    '<button data-testid="primary-card-button-owned"></button><section id="target"><p id="copy">Owned visible requirement</p><button id="control">Save</button></section>';
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return this.id === "target"
      ? box(430, 80, 780, 780)
      : this.id === "control"
        ? box(600, 300, 120, 32)
        : this.id === "toast"
          ? mode === "partial-transparent-toast"
            ? box(705, -30, 250, 400)
            : box(705, 280, 250, 100)
          : this.id === "own-toast"
            ? box(580, 280, 200, 100)
            : box(60, 80, 200, 30);
  });
  vi.stubGlobal("getComputedStyle", (node: HTMLElement) => ({
    display: node.style.display || "block",
    visibility: node.style.visibility || "visible",
    opacity: node.style.opacity || "1",
  }));
  const control = document.getElementById("control")!,
    target = document.getElementById("target")!;
  vi.spyOn(document, "elementFromPoint").mockImplementation((x) =>
    mode === "edge-covered" && x >= 690 ? target : control,
  );
  if (mode === "wrong-theme") document.documentElement.classList.add("dark");
  if (mode === "foreign-route")
    vi.stubGlobal("location", new URL("http://127.0.0.1:4885/project/local/foreign/pull-requests"));
  if (mode === "duplicate-card")
    document.body.append(document.querySelector("button")!.cloneNode());
  if (mode === "hidden-copy")
    (document.getElementById("copy") as HTMLElement).style.display = "none";
  if (["transparent-toast", "foreign-toast-on-own", "partial-transparent-toast"].includes(mode))
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div data-slot="toast-viewport"><div id="toast" data-position="top-right" style="pointer-events:none">Toast</div></div>',
    );
  if (mode === "own-toast" || mode === "foreign-toast-on-own") {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div data-slot="toast-viewport"><div id="own-toast" data-position="top-right"></div></div>',
    );
    document.getElementById("own-toast")!.append(control);
  }
  if (mode === "credential")
    document.body.insertAdjacentHTML("beforeend", '<input type="password">');
  if (mode === "boot") document.body.insertAdjacentHTML("beforeend", '<div id="boot-shell"></div>');
  const witness = read({
    origin: "http://127.0.0.1:4885",
    theme: "light",
    selection: {
      environmentId: "local",
      projectId: "owned",
      threadId: "thread",
      cwd: "/owned/light/requests/github",
    },
    path: "/project/local/owned/pull-requests",
    target: "#target",
    requiredText: ["Owned visible requirement"],
    requiredSelectors: ["#control"],
    requiredValues: [],
    requiredTextScopes: [],
  });
  const validate = Reflect.get(api, "validatePullRequestsCaptureWitness");
  expect(validate).toBeTypeOf("function");
  if (mode === "clear" || mode === "own-toast") expect(() => validate(witness)).not.toThrow();
  else expect(() => validate(witness)).toThrow("Owned request capture refused.");
});
it.each(["github", "gitlab"] as const)(
  "requires the owned header/metadata and anchored suggestion in actual Checks/Files observations: %s",
  (provider) => {
    const read = Reflect.get(api, "readPullRequestsCaptureWitness"),
      observe = Reflect.get(api, "pullRequestsObservationFor"),
      validate = Reflect.get(api, "validatePullRequestsCaptureWitness");
    for (const substate of ["checks", "files"] as const) {
      const binding = bindings().find(
        (entry: { row: string; substate: string; theme: string }) =>
          entry.row === "request-" + provider + "-detail" &&
          entry.substate === substate &&
          entry.theme === "light",
      );
      const observation = observe(
        binding,
        {
          environmentId: "local",
          projectId: "owned",
          threadId: "thread",
          cwd: "/owned/light/requests/" + provider,
        },
        "http://127.0.0.1:4885",
      );
      vi.stubGlobal(
        "location",
        new URL(observation.origin + observation.path + "?tab=" + substate),
      );
      vi.stubGlobal("innerWidth", 1280);
      vi.stubGlobal("innerHeight", 960);
      vi.stubGlobal("getComputedStyle", (node: HTMLElement) => ({
        display: node.style.display || "block",
        visibility: "visible",
        opacity: "1",
      }));
      document.documentElement.classList.remove("dark");
      const title = provider === "github" ? "Owned GitHub request #41" : "Owned GitLab request !42";
      document.body.innerHTML =
        '<button data-testid="primary-card-button-owned"></button><section aria-label="Pull Requests"><p>owned/requests ' +
        provider +
        ".visual.invalid " +
        (provider === "github" ? "#41 Checks Files changed" : "!42 Pipelines Changes") +
        ' build visual-request.ts approved Owned inline feedback</p><header id="owned-header"><h1>' +
        title +
        '</h1><span>Open</span><div>owned-author wants to merge <code>visual-request</code> into <button aria-label="Change base branch"><code>main</code></button></div></header><button role="tab" aria-selected="true">' +
        substate +
        '</button><div class="hidden lg:block"><aside aria-label="Request details"><h2>Assignees</h2><h2>Labels</h2><p>' +
        (provider === "github" ? "rust" : "bug") +
        '</p><h2>Milestone</h2><p>Next</p></aside></div><section aria-label="Suggested change"><p>Lines 1–1</p><p>' +
        (provider === "github"
          ? "GitHub has no public API for applying review suggestions. Apply it on GitHub."
          : "This suggestion cannot be applied to the current head") +
        '</p><pre>-export const approved = true;\n+export const approved = true; // suggested</pre><button disabled>Apply</button><button>Copy</button></section><div aria-label="Reactions"><button aria-label="+1: ' +
        (provider === "github" ? "2" : "1") +
        '"><span>👍</span> <span>' +
        (provider === "github" ? "2" : "1") +
        "</span></button></div></section>";
      const nodes = Array.from(document.querySelectorAll("*"));
      for (const [index, element] of nodes.entries())
        element.getBoundingClientRect = () =>
          box(10 + (index % 10) * 90, 10 + Math.floor(index / 10) * 90, 70, 70);
      vi.spyOn(document, "elementFromPoint").mockImplementation(
        (x, y) =>
          nodes.find((element) => {
            const b = element.getBoundingClientRect();
            return x >= b.x && x <= b.right && y >= b.y && y <= b.bottom;
          }) ?? null,
      );
      expect(() => validate(read(observation))).not.toThrow();
      for (const selector of [
        "#owned-header",
        'aside[aria-label="Request details"]',
        ...(substate === "files" ? ['section[aria-label="Suggested change"]'] : []),
      ]) {
        const node = document.querySelector<HTMLElement>(selector)!;
        node.style.display = "none";
        expect(() => validate(read(observation))).toThrow("Owned request capture refused.");
        node.style.display = "block";
        const parent = node.parentElement!,
          next = node.nextSibling;
        node.remove();
        expect(() => validate(read(observation))).toThrow("Owned request capture refused.");
        parent.insertBefore(node, next);
      }
    }
  },
);
it("preserves visible JSX text adjacency for the actual inline-comment label", () => {
  vi.stubGlobal(
    "location",
    new URL("http://127.0.0.1:4885/project/local/owned/pull-requests/43?tab=files"),
  );
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("innerHeight", 960);
  vi.stubGlobal("getComputedStyle", () => ({
    display: "block",
    visibility: "visible",
    opacity: "1",
  }));
  document.body.innerHTML =
    '<button data-testid="primary-card-button-owned"></button><section id="inline"><label>Comment on </label><textarea id="draft"></textarea></section>';
  const label = document.querySelector("label")!;
  label.append(
    document.createTextNode("visual-request.ts"),
    document.createTextNode(":"),
    document.createTextNode("1"),
  );
  document.querySelector<HTMLTextAreaElement>("textarea")!.value = "Owned draft";
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(box(20, 20, 300, 100));
  vi.spyOn(document, "elementFromPoint").mockReturnValue(document.querySelector("textarea"));
  const read = Reflect.get(api, "readPullRequestsCaptureWitness"),
    validate = Reflect.get(api, "validatePullRequestsCaptureWitness");
  expect(() =>
    validate(
      read({
        origin: "http://127.0.0.1:4885",
        theme: "light",
        selection: { environmentId: "local", projectId: "owned" },
        path: "/project/local/owned/pull-requests/43",
        target: "#inline",
        requiredText: ["Comment on visual-request.ts:1"],
        requiredSelectors: ["#draft"],
        requiredValues: [{ selector: "#draft", value: "Owned draft" }],
        requiredTextScopes: [],
      }),
    ),
  ).not.toThrow();
});
it.each([
  "hidden",
  "auto",
  "scroll",
  "clip",
  "partial",
  "valid-scroll",
  "visible-overflow",
  "control-clipped",
  "border",
  "paint-containment",
  "text-range",
  "shadow-clipped",
  "valid-shadow",
  "auto-y",
  "valid-y",
])("executes the actual base-confirmation reader with ancestor clipping: %s", (mode) => {
  vi.stubGlobal(
    "location",
    new URL("http://127.0.0.1:4885/project/local/owned/pull-requests/43?tab=files"),
  );
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("innerHeight", 960);
  document.documentElement.classList.remove("dark");
  document.body.innerHTML =
    '<button data-testid="primary-card-button-owned"></button><div data-slot="alert-dialog-popup"><h2>Change base branch</h2><p>Change the base from main to visual-create.</p><div id="clip"><p id="warning">Changing the base clears 1 pending review comment.</p></div><button id="cancel">Cancel</button><button id="change">Change base</button></div>';
  const parent = document.getElementById("clip")!,
    warning = document.getElementById("warning")!,
    cancel = document.getElementById("cancel")!,
    change = document.getElementById("change")!;
  if (mode === "control-clipped") parent.append(cancel);
  const rectangles = new Map<Element, ReturnType<typeof box>>([
    [
      parent,
      box(
        450,
        100,
        mode === "valid-scroll" ||
          mode === "valid-shadow" ||
          mode === "auto-y" ||
          mode === "valid-y" ||
          mode === "visible-overflow"
          ? 300
          : mode === "partial"
            ? 150
            : 20,
        20,
      ),
    ],
    [warning, box(510, 100, 140, 20)],
    [cancel, box(600, 300, 120, 32)],
    [change, box(800, 300, 120, 32)],
  ]);
  if (mode === "auto-y") rectangles.set(warning, box(510, 150, 140, 20));
  if (mode === "text-range") {
    rectangles.set(warning, box(450, 100, 10, 20));
    textRectangles.set(warning.firstChild!, box(510, 100, 140, 20));
  }
  if (mode === "shadow-clipped" || mode === "valid-shadow") {
    const host = document.createElement("div");
    parent.append(host);
    host.attachShadow({ mode: "open" }).append(warning);
    rectangles.set(host, box(450, 100, 300, 20));
  }
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return (
      rectangles.get(this) ??
      (this.getAttribute("data-slot") === "alert-dialog-popup"
        ? box(430, 80, 780, 780)
        : box(60, 80, 200, 30))
    );
  });
  for (const [key, value] of Object.entries({
    clientLeft: mode === "border" ? 2 : 0,
    clientTop: 0,
    clientWidth: parent.getBoundingClientRect().width - (mode === "border" ? 4 : 0),
    clientHeight: 20,
    offsetWidth: parent.getBoundingClientRect().width,
    offsetHeight: 20,
  }))
    Object.defineProperty(parent, key, { configurable: true, value });
  vi.stubGlobal("getComputedStyle", (element: Element) => ({
    display: "block",
    visibility: "visible",
    opacity: "1",
    overflowX:
      element === parent
        ? mode === "valid-scroll" || mode === "valid-shadow"
          ? "auto"
          : mode === "visible-overflow" || mode === "paint-containment"
            ? "visible"
            : mode === "partial" ||
                mode === "control-clipped" ||
                mode === "border" ||
                mode === "text-range" ||
                mode === "shadow-clipped"
              ? "hidden"
              : mode
        : "visible",
    overflowY: element === parent && (mode === "auto-y" || mode === "valid-y") ? "auto" : "visible",
    contain: element === parent && mode === "paint-containment" ? "paint" : "none",
  }));
  vi.spyOn(document, "elementFromPoint").mockImplementation((x) => (x < 760 ? cancel : change));
  vi.stubGlobal("XPathResult", { ORDERED_NODE_SNAPSHOT_TYPE: 7 });
  const previousXPath = Object.getOwnPropertyDescriptor(document, "evaluate");
  restoreXPath = () =>
    previousXPath
      ? Object.defineProperty(document, "evaluate", previousXPath)
      : Reflect.deleteProperty(document, "evaluate");
  Object.defineProperty(document, "evaluate", {
    configurable: true,
    value: (expression: string) => {
      const element =
        expression === '//*[@data-slot="alert-dialog-popup"]//button[normalize-space()="Cancel"]'
          ? cancel
          : expression ===
              '//*[@data-slot="alert-dialog-popup"]//button[normalize-space()="Change base"]'
            ? change
            : null;
      return {
        resultType: 7,
        booleanValue: false,
        numberValue: 0,
        stringValue: "",
        singleNodeValue: null,
        invalidIteratorState: false,
        iterateNext: () => null,
        snapshotLength: element ? 1 : 0,
        snapshotItem: (index: number) => (index === 0 ? element : null),
      };
    },
  });
  const observe = Reflect.get(api, "pullRequestsObservationFor"),
    read = Reflect.get(api, "readPullRequestsCaptureWitness"),
    validate = Reflect.get(api, "validatePullRequestsCaptureWitness");
  const observed = observe(
    { row: "request-review-edit-error", substate: "base-confirmation", theme: "light" },
    { environmentId: "local", projectId: "owned", threadId: "owned-thread" },
    "http://127.0.0.1:4885",
  );
  const facts = read(observed);
  if (
    mode === "valid-scroll" ||
    mode === "valid-shadow" ||
    mode === "valid-y" ||
    mode === "visible-overflow"
  )
    expect(() => validate(facts)).not.toThrow();
  else expect(() => validate(facts)).toThrow("Owned request capture refused.");
});
