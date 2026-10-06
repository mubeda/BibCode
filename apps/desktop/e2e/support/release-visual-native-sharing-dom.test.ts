// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  readNativeSharingDom,
  validateNativeSharingDom,
} from "./release-visual-native-sharing-dom.ts";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  document.documentElement.className = "";
});
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
