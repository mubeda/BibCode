// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  readNativeSharingDom,
  validateNativeSharingDom,
  projectNativeSharingDomFacts,
} from "./release-visual-native-sharing-dom.ts";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  document.documentElement.className = "";
});
it("projects only closed DOM facts, retaining false facts without values", () => {
  const keys = [
    "routeMatched",
    "themeMatched",
    "shareSelected",
    "controlsMatched",
    "expectedState",
    "credentialAbsent",
    "targetInView",
    "viewportExact",
    "panelBoundsInView",
    "panelCenterHit",
  ];
  const value = Object.fromEntries(keys.map((key) => [key, key !== "targetInView"]));
  const facts = projectNativeSharingDomFacts(value);
  expect(facts).toMatchObject({ domRouteMatched: true, domTargetInView: false });
  expect(Object.keys(facts)).toHaveLength(10);
  expect(JSON.stringify(facts)).not.toMatch(/tauri|http|Owned|#|</);
});
it.each(["missing", "extra", "getter", "proxy", "array"])(
  "refuses unsafe last-DOM attribution packet without evaluating it: %s",
  (mode) => {
    const value: Record<string, unknown> = {
      routeMatched: true,
      themeMatched: true,
      shareSelected: true,
      controlsMatched: true,
      expectedState: true,
      credentialAbsent: true,
      targetInView: false,
      viewportExact: true,
      panelBoundsInView: false,
      panelCenterHit: null,
    };
    let reads = 0;
    if (mode === "missing") delete value.routeMatched;
    if (mode === "extra") value.privateValue = "inert sensitive text";
    if (mode === "getter")
      Object.defineProperty(value, "targetInView", {
        enumerable: true,
        get: () => {
          reads++;
          throw new Error("inert getter");
        },
      });
    const input =
      mode === "proxy"
        ? new Proxy(value, {
            ownKeys: () => {
              reads++;
              throw new Error("inert proxy");
            },
          })
        : mode === "array"
          ? [value]
          : value;
    expect(Object.values(projectNativeSharingDomFacts(input))).toEqual(Array(10).fill(null));
    expect(reads).toBe(0);
  },
);
function page(scene: "native-share-no-route" | "native-share-refresh", mode = "owned") {
  vi.stubGlobal("location", {
    origin: "null",
    href:
      (mode === "origin" ? "http://foreign.invalid" : "tauri://localhost") +
      "/#/settings/remote-servers",
    pathname: "/",
    search: "",
    hash: mode === "route" ? "#/settings/providers" : "#/settings/remote-servers",
  });
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("innerHeight", 960);
  document.body.innerHTML =
    '<button role="tab" aria-selected="true" aria-controls="sharing">Share this host</button><div id="sharing" role="tabpanel"><button role="radio" aria-label="Another device" aria-checked="true"></button><select aria-label="Share address">' +
    (scene === "native-share-refresh" ? '<option value="auto-lan">Automatic (LAN)</option>' : "") +
    '</select><button aria-label="Refresh addresses">Refresh</button><button ' +
    (scene === "native-share-no-route" ? "disabled" : "") +
    ">Generate pairing offer</button>" +
    (scene === "native-share-no-route"
      ? "<p>Native sharing uses the private address of this computer's default network route, and this computer has none right now. Connect it to a local network that provides a default route, then Refresh.</p>"
      : "") +
    "</div>";
  if (mode === "credential")
    document.body.insertAdjacentHTML("beforeend", '<input type="password">');
  if (mode === "duplicate")
    document
      .getElementById("sharing")!
      .insertAdjacentHTML("beforeend", '<button aria-label="Refresh addresses">Refresh</button>');
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    x: 10,
    y: 10,
    left: 10,
    top: 10,
    right: 600,
    bottom: 800,
    width: 590,
    height: 790,
    toJSON: () => ({}),
  });
  vi.spyOn(document, "elementFromPoint").mockImplementation(() =>
    document.getElementById("sharing"),
  );
  return { scene, theme: "light" as const, origin: "tauri://localhost" };
}
it.each(["native-share-no-route", "native-share-refresh"] as const)(
  "reads only fixed public native DOM facts for %s",
  (scene) => {
    const value = readNativeSharingDom(page(scene));
    expect(validateNativeSharingDom(value)).toEqual(
      expect.objectContaining({
        routeMatched: true,
        shareSelected: true,
        controlsMatched: true,
        expectedState: true,
        credentialAbsent: true,
        targetInView: true,
      }),
    );
    expect(JSON.stringify(value)).not.toMatch(/http|tauri|default network|Generate/);
  },
);
it.each(["origin", "route", "credential", "duplicate"])(
  "refuses %s native sharing admission",
  (mode) => {
    const value = readNativeSharingDom(page("native-share-no-route", mode));
    expect(() => validateNativeSharingDom(value)).toThrow();
  },
);

it.each([
  {
    mode: "owned",
    want: {
      viewportExact: true,
      panelBoundsInView: true,
      panelCenterHit: true,
      targetInView: true,
    },
    contains: 1,
  },
  {
    mode: "viewport",
    want: {
      viewportExact: false,
      panelBoundsInView: null,
      panelCenterHit: null,
      targetInView: false,
    },
    contains: 0,
  },
  {
    mode: "long-panel",
    want: {
      viewportExact: true,
      panelBoundsInView: false,
      panelCenterHit: null,
      targetInView: false,
    },
    contains: 0,
  },
  {
    mode: "obstructed",
    want: {
      viewportExact: true,
      panelBoundsInView: true,
      panelCenterHit: false,
      targetInView: false,
    },
    contains: 1,
  },
  {
    mode: "no-hit",
    want: {
      viewportExact: true,
      panelBoundsInView: true,
      panelCenterHit: false,
      targetInView: false,
    },
    contains: 0,
  },
])(
  "attributes only reached visibility predicates without another DOM read: $mode",
  ({ mode, want, contains }) => {
    const input = page("native-share-no-route");
    const panel = document.getElementById("sharing")!,
      refresh = panel.querySelector("button")!;
    const rectangle = Element.prototype.getBoundingClientRect as ReturnType<typeof vi.fn>;
    const hit = document.elementFromPoint as ReturnType<typeof vi.fn>;
    if (mode === "viewport") vi.stubGlobal("innerWidth", 1279);
    if (mode === "long-panel")
      panel.getBoundingClientRect = () => ({
        x: 10,
        y: 10,
        left: 10,
        top: 10,
        right: 600,
        bottom: 1200,
        width: 590,
        height: 1190,
        toJSON: () => ({}),
      });
    hit.mockReturnValue(mode === "obstructed" ? document.body : mode === "no-hit" ? null : refresh);
    const containment = vi.spyOn(panel, "contains");
    const value = readNativeSharingDom(input);
    expect(value).toMatchObject(want);
    expect(hit).toHaveBeenCalledTimes(1);
    expect(containment).toHaveBeenCalledTimes(contains);
    expect(rectangle.mock.calls.length).toBe(mode === "long-panel" ? 8 : 10);
    const facts = projectNativeSharingDomFacts(value);
    expect(facts).toMatchObject({
      domViewportExact: want.viewportExact,
      domPanelBoundsInView: want.panelBoundsInView,
      domPanelCenterHit: want.panelCenterHit,
      domTargetInView: want.targetInView,
    });
    if (mode === "owned") expect(() => validateNativeSharingDom(value)).not.toThrow();
    else expect(() => validateNativeSharingDom(value)).toThrow();
  },
);

it.each(["getter", "proxy", "extra", "text"])(
  "keeps new visibility attribution closed without admitting a failed original: %s",
  (mode) => {
    const value: Record<string, unknown> = {
      routeMatched: true,
      themeMatched: true,
      shareSelected: true,
      controlsMatched: true,
      expectedState: true,
      credentialAbsent: true,
      targetInView: false,
      viewportExact: true,
      panelBoundsInView: false,
      panelCenterHit: null,
    };
    let reads = 0;
    if (mode === "getter")
      Object.defineProperty(value, "panelCenterHit", {
        enumerable: true,
        get: () => {
          reads++;
          throw new Error("Inert private getter.");
        },
      });
    if (mode === "extra") value.privateText = "inert private text";
    if (mode === "text") value.panelCenterHit = "inert private text";
    const input =
      mode === "proxy"
        ? new Proxy(value, {
            ownKeys: () => {
              reads++;
              throw new Error("Inert private proxy.");
            },
          })
        : value;
    expect(Object.values(projectNativeSharingDomFacts(input))).toEqual(Array(10).fill(null));
    expect(() => validateNativeSharingDom(input)).toThrow();
    expect(reads).toBe(0);
  },
);
