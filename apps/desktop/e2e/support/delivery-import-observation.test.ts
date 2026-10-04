// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - Source-backed, inert serialization tests only.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  readDeliveryImportObservation,
  projectDeliveryImportObservation,
} from "./delivery-import-observation.ts";

const origin = "http://127.0.0.1:4885";
function page(markup: string, pathname = "/") {
  vi.stubGlobal("location", { origin, pathname, search: "", hash: "" });
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("innerHeight", 960);
  document.body.innerHTML = markup;
  vi.spyOn(HTMLElement.prototype, "checkVisibility").mockReturnValue(true);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 10,
    top: 10,
    right: 300,
    bottom: 100,
    width: 290,
    height: 90,
    x: 10,
    y: 10,
    toJSON: () => ({}),
  });
}
const modal =
  '<div data-slot="dialog-popup" role="dialog"><div data-add-project-content="true"><form><input id="add-project-host-path"><button type="submit">Open project</button></form></div></div>';
const card =
  '<li data-testid="primary-card-private-id"><button data-testid="primary-card-button-private-id" aria-current="page"></button><span data-testid="primary-card-title-private-id">private project path/title</span></li>';
const composer =
  '<div data-center-surface-host data-visible="true"><div data-testid="composer-editor" contenteditable="true">private draft</div></div>';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("failure-only owned import DOM sample", () => {
  it("observes the actual public form/card/composer shape without values, text or actions", () => {
    page(modal + card + composer, "/local/private-id");
    const path = document.querySelector<HTMLInputElement>("input")!;
    const privateRead = vi.fn(() => {
      throw new Error("private data must remain unread");
    });
    Object.defineProperty(path, "value", { get: privateRead });
    for (const selector of [
      '[data-testid^="primary-card-title-"]',
      '[data-testid="composer-editor"]',
    ])
      Object.defineProperty(document.querySelector(selector)!, "textContent", { get: privateRead });
    const click = vi.spyOn(HTMLElement.prototype, "click"),
      focus = vi.spyOn(HTMLElement.prototype, "focus"),
      dispatch = vi.spyOn(document, "dispatchEvent");
    path.disabled = true;
    document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled = true;
    expect(readDeliveryImportObservation(origin)).toEqual({
      safeLocation: true,
      route: "workspace",
      modalPresent: true,
      modalDisplayed: true,
      pathPresent: true,
      pathDisabled: true,
      submitPresent: true,
      submitDisabled: true,
      composerPresent: true,
      composerDisplayed: true,
      primaryCardCount: "one",
      primaryCardSelected: true,
      errorCategory: null,
    });
    expect(privateRead).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(JSON.stringify(readDeliveryImportObservation(origin))).not.toMatch(/private|http|1280/);
  });
  it("serializes the actual reader without a module closure or any network/control dependency", () => {
    page(card);
    const observed = NodeVM.runInNewContext(
      "(" + readDeliveryImportObservation.toString() + ")(origin)",
      { origin, location, document, HTMLInputElement, HTMLButtonElement, innerWidth, innerHeight },
    );
    expect(observed).toEqual(readDeliveryImportObservation(origin));
  });
  it.each([
    { origin: "https://private-host" },
    { search: "?token=private-token" },
    { hash: "#private-grant" },
  ])("refuses an unexpected location before inspecting any DOM", (change) => {
    page(modal + card);
    vi.stubGlobal("location", { origin, pathname: "/", search: "", hash: "", ...change });
    const query = vi.spyOn(document, "querySelectorAll");
    const value = readDeliveryImportObservation(origin)!;
    expect(value.safeLocation).toBe(false);
    expect(query).not.toHaveBeenCalled();
    expect(
      Object.entries(value)
        .filter(([key]) => key !== "safeLocation")
        .every(([, value]) => value === null),
    ).toBe(true);
    expect(projectDeliveryImportObservation(value)).toEqual(value);
    expect(JSON.stringify(value)).not.toMatch(/private|https|token/);
  });
  it("refuses a foreign expected origin before DOM reads", () => {
    page(modal);
    const query = vi.spyOn(document, "querySelectorAll");
    expect(readDeliveryImportObservation("https://private-host")?.safeLocation).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
  it.each([
    ["/", "root"],
    ["/pair", "pair"],
    ["/settings/general", "settings"],
    ["/local/private-id", "workspace"],
    ["/local/private-id/nested", "other"],
  ])("retains only the route category", (pathname, route) => {
    page("", pathname!);
    expect(readDeliveryImportObservation(origin)?.route).toBe(route);
  });
  it.each([
    ['<p role="status">Waiting for host information…</p>', "host-loading"],
    ['<p role="alert">Host platform information is still loading.</p>', "host-loading"],
    ['<p role="alert">Enter a project path.</p>', "path-invalid"],
    ['<p role="alert">Windows-style paths are only supported on Windows.</p>', "path-invalid"],
    ['<p role="alert">Enter an absolute or home-relative path.</p>', "path-invalid"],
    ['<p role="alert">private unexpected error/path</p>', "other"],
  ])("classifies only exact scoped import copy", (error, category) => {
    page(modal.replace("</form>", error + "</form>"));
    expect(readDeliveryImportObservation(origin)?.errorCategory).toBe(category);
    expect(JSON.stringify(readDeliveryImportObservation(origin))).not.toMatch(
      /private|path\/|loading\./,
    );
  });
  it.each([
    ["alert-title", "Workspace unavailable", "workspace-unavailable"],
    ["toast-title", "Failed to add project", "other"],
    ["toast-title", "Failed to open project", "other"],
  ])("classifies known title without reading the private description", (slot, title, category) => {
    page(
      '<div data-center-surface-host data-visible="true"><div data-slot="' +
        slot +
        '">' +
        title +
        '</div><div data-slot="alert-description">private error/path</div></div>',
    );
    const read = vi.fn(() => {
      throw new Error("private description");
    });
    Object.defineProperty(
      document.querySelector('[data-slot="alert-description"]')!,
      "textContent",
      { get: read },
    );
    expect(readDeliveryImportObservation(origin)?.errorCategory).toBe(category);
    expect(read).not.toHaveBeenCalled();
  });
  it("leaves hidden errors and duplicate controls distinct from off-screen displayed fields", () => {
    page(
      modal.replace("</form>", '<p role="alert">private hidden error</p></form>') +
        composer +
        card +
        card,
    );
    vi.mocked(HTMLElement.prototype.checkVisibility).mockReturnValue(false);
    expect(readDeliveryImportObservation(origin)).toMatchObject({
      modalPresent: true,
      modalDisplayed: false,
      composerPresent: true,
      composerDisplayed: false,
      primaryCardCount: "multiple",
      errorCategory: null,
    });
    vi.mocked(HTMLElement.prototype.checkVisibility).mockReturnValue(true);
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({
      left: -10,
      top: 10,
      right: 30,
      bottom: 30,
      width: 40,
      height: 20,
    } as DOMRect);
    expect(readDeliveryImportObservation(origin)?.composerDisplayed).toBe(true);
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({
      left: Infinity,
    } as DOMRect);
    expect(readDeliveryImportObservation(origin)?.composerDisplayed).toBeNull();
  });
  it("leaves unavailable visibility and ambiguous path/composer states unknown", () => {
    page(
      modal.replace(
        '<input id="add-project-host-path">',
        '<input id="add-project-host-path"><input id="add-project-host-path">',
      ) +
        composer +
        composer,
    );
    Object.defineProperty(
      document.querySelector('[data-slot="dialog-popup"]')!,
      "checkVisibility",
      { value: undefined },
    );
    expect(readDeliveryImportObservation(origin)).toMatchObject({
      modalPresent: true,
      modalDisplayed: null,
      pathPresent: true,
      pathDisabled: null,
      submitPresent: false,
      submitDisabled: null,
      composerPresent: true,
      composerDisplayed: null,
      primaryCardCount: "none",
      primaryCardSelected: false,
    });
  });
  it("contains a DOM exception without retaining its raw error", () => {
    page(modal);
    vi.spyOn(document, "querySelectorAll").mockImplementation(() => {
      throw new Error("private DOM error");
    });
    expect(readDeliveryImportObservation(origin)).toBeNull();
  });
  it("pins selectors and known error/title copy to the current real component/navigation source", () => {
    const read = (file: string) =>
      NodeFS.readFileSync(new URL("../../../web/src/" + file, import.meta.url), "utf8");
    expect(read("components/AddProjectDialog.tsx")).toContain('data-add-project-content="true"');
    expect(read("components/add-project/AddProjectSteps.tsx")).toContain(
      'id="add-project-host-path"',
    );
    expect(read("components/add-project/AddProjectSteps.tsx")).toContain('type="submit"');
    expect(read("components/add-project/AddProjectSteps.tsx")).toContain(
      "Waiting for host information…",
    );
    expect(read("components/add-project/AddProjectDialog.logic.ts")).toContain(
      "Enter an absolute or home-relative path.",
    );
    expect(read("components/Sidebar.tsx")).toContain(
      "buttonTestId={`primary-card-button-${project.id}`}",
    );
    expect(read("components/sidebar/WorkspaceCard.tsx")).toContain(
      'aria-current={props.isActive ? "page" : undefined}',
    );
    expect(read("components/ChatView.tsx")).toContain('title: "Workspace unavailable"');
    expect(read("components/ui/alert.tsx")).toContain('data-slot="alert-title"');
    expect(read("components/add-project/addProjectOperations.ts")).toContain(
      '"Failed to open project"',
    );
    expect(read("components/add-project/useAddProjectWorkflow.ts")).toContain(
      'to: "/$environmentId/$threadId"',
    );
  });
});

describe("closed import projection", () => {
  function valid() {
    page(modal + card);
    return readDeliveryImportObservation(origin)!;
  }
  it("admits only finite exact own-data fields", () => {
    const value = valid();
    expect(projectDeliveryImportObservation(value)).toEqual(value);
    for (const key of Object.keys(value)) {
      const read = vi.fn(() => "private field");
      const input = { ...value };
      Object.defineProperty(input, key, { enumerable: true, get: read });
      expect(projectDeliveryImportObservation(input)).toBeNull();
      expect(read).not.toHaveBeenCalled();
      const inherited = Object.assign(
        Object.create({ [key]: value[key as keyof typeof value] }),
        value,
      );
      delete inherited[key];
      inherited.extra = null;
      expect(projectDeliveryImportObservation(inherited)).toBeNull();
    }
    for (const input of [
      null,
      [],
      { ...value, private: "payload" },
      { ...value, route: "private path" },
      { ...value, primaryCardCount: Infinity },
      { ...value, errorCategory: "private error" },
      { ...value, safeLocation: false },
    ])
      expect(projectDeliveryImportObservation(input)).toBeNull();
    const proxy = Proxy.revocable(value, {});
    proxy.revoke();
    expect(projectDeliveryImportObservation(proxy.proxy)).toBeNull();
    expect(
      projectDeliveryImportObservation(
        new Proxy(value, {
          ownKeys: () => {
            throw new Error("private proxy failure");
          },
        }),
      ),
    ).toBeNull();
  });
});
